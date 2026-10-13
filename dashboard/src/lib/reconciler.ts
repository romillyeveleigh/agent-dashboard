// Background reconciler — checks container status for active tasks
// and retries or marks as failed. Replaces the GET /api/tasks polling.

import { db } from './db'
import { tasks, logs, messages } from './schema'
import { captureContainerDiagnostics, countRunningAgentContainers, getContainerStatus, pruneOrphanedTaskWorkspaces, stopContainer } from './docker'
import { syncAwake } from './sleep-assertion'
import { replaceTaskContainerLocked } from './dispatch-task'
import { emit } from './events'
import { transition } from './task-transitions'
import { fireExtractLearnings } from './learning-extractor'
import { fetchPRsByNumber, fetchPRMergeStates, fetchMainCiStatus } from './github'
import { parseTaskTags } from './parse-tags'
import { SHIP_MODE_MAX_DURATION_MS, SHIP_TAG, ACTIVE_STATUSES, POLL_PR_STATE_INTERVAL_MS } from './constants'
import { reactToPRState } from './poll-transitions'
import { refreshContextCaches } from './context-fetchers'
import { withTaskLock } from './task-locks'
import { findActiveShipTasks } from './ship-tasks'
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

const RECONCILE_INTERVAL_MS = 10_000 // 10 seconds

// Log retention: delete logs of finished tasks older than the window, once a
// day. 0 disables. SQLite stores timestamps as unix epoch seconds.
const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 30)
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000 // once a day
// Backstop only (normal exits clean their own workspace), and each run spins up
// a throwaway container — so not every 10s tick
const WORKSPACE_PRUNE_INTERVAL_MS = 10 * 60 * 1000
let lastPruneAt = 0
let lastWorkspacePruneAt = 0

async function pruneOldLogs() {
  if (!LOG_RETENTION_DAYS || LOG_RETENTION_DAYS <= 0) return // disabled
  const cutoff = Math.floor(Date.now() / 1000) - LOG_RETENTION_DAYS * 86_400
  try {
    db.run(sql`
      DELETE FROM logs WHERE task_id IN (
        SELECT id FROM tasks
        WHERE status IN ('complete', 'failed', 'cancelled', 'resolved')
          AND updated_at < ${cutoff}
      )
    `)
  } catch (err) {
    console.error('[reconciler] log prune failed:', err)
  }
}

// Tasks that stay in 'starting' with no container for longer than this are
// assumed to have failed during dispatch (Docker unavailable, dashboard restart, etc.)
const STUCK_STARTING_TTL_MS = 2 * 60 * 1000 // 2 minutes

async function reapStuckStartingTasks() {
  try {
    const cutoffSecs = Math.floor((Date.now() - STUCK_STARTING_TTL_MS) / 1000)
    const stuck = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'starting'), isNull(tasks.containerId), sql`${tasks.updatedAt} < ${cutoffSecs}`))

    for (const task of stuck) {
      await transition(task.id, 'failed', { actor: 'reconciler', message: 'Container never launched' })
      fireExtractLearnings(task.id)
    }
  } catch (err) {
    console.error('[reconciler] reapStuckStartingTasks error:', err)
  }
}

// Backstop for entrypoint.sh's cleanup() trap, which doesn't run on
// SIGKILL/OOM. Grace period avoids racing a retry that just created its
// directory a moment before this query saw the task as active.
async function pruneOrphanedWorkspaces() {
  try {
    const active = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.status, ACTIVE_STATUSES))
    await pruneOrphanedTaskWorkspaces(active.map((t) => t.id), RECONCILE_INTERVAL_MS * 2)
  } catch (err) {
    console.error('[reconciler] pruneOrphanedWorkspaces error:', err)
  }
}

async function reconcile() {
  try {
    if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now()
      await pruneOldLogs()
    }
    await enforceShipDeadlines()
    await reapStuckStartingTasks()
    if (Date.now() - lastWorkspacePruneAt > WORKSPACE_PRUNE_INTERVAL_MS) {
      lastWorkspacePruneAt = Date.now()
      await pruneOrphanedWorkspaces()
    }

    // Hold the host awake while any container runs, release once none do.
    // Own try/catch: a Docker hiccup here must not abort the rest of the tick,
    // which is what actually retries and fails tasks.
    try {
      syncAwake(await countRunningAgentContainers())
    } catch (err) {
      console.error('[reconciler] sleep assertion sync failed:', err)
    }

    const tasksWithContainers = await db
      .select()
      .from(tasks)
      .where(and(inArray(tasks.status, ACTIVE_STATUSES), isNotNull(tasks.containerId)))

    await Promise.all(
      tasksWithContainers.map(async (task) => {
        const status = await getContainerStatus(task.containerId!)
        if (status === 'running') return

        // Everything below runs under the task's lock, which replaceTaskContainer
        // also takes: a retry landing between the snapshot above and these writes
        // would otherwise be condemned mid-flight, and pruneOrphanedWorkspaces
        // then deletes the live container's workspace out from under it.
        await withTaskLock(task.id, async () => {
          // Re-read under the lock. A retry that has already recorded its
          // replacement makes the container we just judged stale, and a task
          // that left the active set is no longer ours to condemn.
          const [current] = await db.select().from(tasks).where(eq(tasks.id, task.id))
          if (!current || current.containerId !== task.containerId) return
          if (!ACTIVE_STATUSES.includes(current.status)) return

          // v2 suspend: a waiting_for_feedback task whose supervisor registered
          // a resume session exits its container on purpose. Detach the dead
          // container id and leave the task parked; the answers route resumes it.
          // Compare-and-swap on the dead container id: if a resume already
          // recorded a NEWER container between our snapshot and this write, the
          // WHERE won't match and the new id survives (no orphaned container).
          if (current.status === 'waiting_for_feedback' && current.resumeSessionId) {
            await db.update(tasks)
              .set({ containerId: null, updatedAt: new Date() })
              .where(and(eq(tasks.id, task.id), eq(tasks.containerId, task.containerId!)))
            return
          }

          // Capture whatever post-mortem state is still available before
          // AutoRemove eats it (usually a losing race — the entrypoint ERR
          // trap is the reliable path for setup-phase failures).
          const diag = await captureContainerDiagnostics(task.containerId!)
          if (diag) {
            const summary =
              `Container exited: code=${diag.exitCode}` +
              (diag.oomKilled ? ' OOMKilled=true' : '') +
              (diag.error ? ` error=${diag.error}` : '')
            const rows = [{ taskId: task.id, type: 'error', content: summary }]
            const tail = diag.logsTail.trim()
            if (tail) {
              rows.push({
                taskId: task.id,
                type: 'system',
                content: `Container log tail:\n${tail.slice(-4000)}`,
              })
            }
            await db.insert(logs).values(rows)
            emit('log:new', { taskId: task.id })
          }

          // Container is gone — attempt retry or mark as failed
          if (current.retryCount < current.maxRetries) {
            // Auto-retry
            const newRetryCount = current.retryCount + 1
            await transition(task.id, 'starting', {
              actor: 'reconciler',
              message: `Retrying (attempt ${newRetryCount + 1})`,
              set: { retryCount: newRetryCount },
            })

            // Restart container from saved launch config. We already hold this
            // task's lock, so use the unlocked body — replaceTaskContainer would
            // deadlock re-acquiring the same key.
            if (current.launchConfigJson) {
              try {
                await replaceTaskContainerLocked(task.id)
              } catch (err) {
                console.error(`Retry failed for task ${task.id}:`, err)
                await transition(task.id, 'failed', {
                  actor: 'reconciler',
                  message: `Retry failed: ${err instanceof Error ? err.message : String(err)}`,
                })
                fireExtractLearnings(task.id)
              }
            }
          } else {
            // No retries left — mark as permanently failed
            const baseMsg = 'Container stopped unexpectedly'
            const statusMessage = diag
              ? `${baseMsg} (exit=${diag.exitCode}${diag.oomKilled ? ', OOM' : ''})`
              : baseMsg
            await transition(task.id, 'failed', { actor: 'reconciler', message: statusMessage })
            fireExtractLearnings(task.id)
          }
        })
      }),
    )
  } catch (err) {
    console.error('Reconciler error:', err)
  }
}

const OBSERVE_SHIPPED_INTERVAL_MS = 60_000 // 60 seconds
const SHIPPED_POLL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

async function observeShipped() {
  try {
    const unshipped = await db
      .select({ id: tasks.id, prNumber: tasks.prNumber })
      .from(tasks)
      // PRs still unmerged a month after their task started were abandoned or
      // closed; polling them every minute forever only grows the query
      .where(and(
        isNotNull(tasks.prNumber),
        isNull(tasks.shippedAt),
        gte(tasks.createdAt, new Date(Date.now() - SHIPPED_POLL_MAX_AGE_MS)),
      ))

    if (unshipped.length === 0) return

    const prs = await fetchPRMergeStates(unshipped.map((t) => t.prNumber!))

    for (const pr of prs) {
      if (pr.displayStatus !== 'Merged') continue
      const task = unshipped.find((t) => t.prNumber === pr.number)
      if (!task) continue
      const shippedAt = pr.mergedAt ? new Date(pr.mergedAt) : new Date()
      await db
        .update(tasks)
        .set({ shippedAt, updatedAt: new Date() })
        .where(eq(tasks.id, task.id))
      emit('task:shipped', { taskId: task.id })
      // PR merged → its diagnosis/fix is now verified; safe to extract learnings
      // that task-completion deferred (see learning-extractor merge-gate).
      fireExtractLearnings(task.id)
    }
  } catch (err) {
    console.error('observeShipped error:', err)
  }
}

async function pollPRState() {
  try {
    const shipTasks = await findActiveShipTasks()
    if (shipTasks.length === 0) return

    const prNumbers = Array.from(new Set(shipTasks.map(t => t.prNumber!)))
    const [prs, mainCiStatus] = await Promise.all([
      fetchPRsByNumber(prNumbers),
      fetchMainCiStatus(),
    ])

    // Map PR number and (for stack-below detection) branch name → CI status.
    const byNumber = new Map(prs.map(p => [p.number, p]))
    const ciByBranch = new Map<string, string | null>()
    for (const pr of prs) ciByBranch.set(pr.headRefName, pr.ciStatus)

    await Promise.all(shipTasks.map(async task => {
      const pr = byNumber.get(task.prNumber!)
      if (!pr) return

      const baseCiStatus =
        pr.baseRefName && pr.baseRefName !== 'main' && pr.baseRefName !== 'master'
          ? ciByBranch.get(pr.baseRefName) ?? null
          : null

      try {
        await withTaskLock(task.id, () =>
          reactToPRState({ task, pr, mainCiStatus, baseCiStatus, dispatchedBy: 'reconciler' }),
        )
      } catch (err) {
        console.error(`pollPRState: reactToPRState failed for task ${task.id}:`, err)
      }
    }))
  } catch (err) {
    console.error('pollPRState error:', err)
  }
}

// Reap tasks that have been waiting on a human reply that will never come:
// (a) PR-linked tasks whose PR has been approved/merged/closed since the question was posted,
// (b) any task that has been in waiting_for_feedback for longer than STALE_WAITING_TTL_MS.
// Containers in waiting_for_feedback poll /api/answers indefinitely (by design), so without
// reaping they accumulate forever.
const STALE_WAITING_TTL_MS = 48 * 60 * 60 * 1000

async function reapStaleWaitingTasks() {
  try {
    const waitingTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.status, 'waiting_for_feedback'))

    if (waitingTasks.length === 0) return

    const prNumbers = Array.from(new Set(waitingTasks.map(t => t.prNumber).filter((n): n is number => typeof n === 'number')))
    const prMap = new Map<number, Awaited<ReturnType<typeof fetchPRMergeStates>>[number]>()
    if (prNumbers.length > 0) {
      // Only state/displayStatus/reviewDecision are read — the light query has them
      const prs = await fetchPRMergeStates(prNumbers)
      for (const pr of prs) prMap.set(pr.number, pr)
    }

    const now = Date.now()
    for (const task of waitingTasks) {
      let reapReason: string | null = null
      // PR-state reaps are benign: the PR reached its own conclusion, so the
      // pending question is moot → `resolved`. The 48h timeout below is a real
      // abandonment → `cancelled`. See the StatusBadge config for the rationale.
      let reapStatus: 'cancelled' | 'resolved' = 'cancelled'

      if (task.prNumber) {
        const pr = prMap.get(task.prNumber)
        if (pr) {
          if (pr.displayStatus === 'Merged' || pr.state === 'MERGED') reapReason = 'PR merged — feedback no longer needed'
          else if (pr.state === 'CLOSED') reapReason = 'PR closed — feedback no longer needed'
          else if (pr.reviewDecision === 'APPROVED') {
            // Someone else approving doesn't make YOUR pending decision moot —
            // review requests are per-person on GitHub. Only reap on approval
            // when the still-open question isn't itself asking the human to
            // make that exact approve/reject call.
            const [pending] = await db
              .select({ type: messages.type })
              .from(messages)
              .where(and(eq(messages.taskId, task.id), eq(messages.direction, 'agent_to_human'), eq(messages.answered, false)))
              .orderBy(desc(messages.createdAt))
              .limit(1)
            if (pending?.type !== 'approval') reapReason = 'PR approved — feedback no longer needed'
          }
          if (reapReason) reapStatus = 'resolved'
        }
      }

      if (!reapReason) {
        const age = now - new Date(task.updatedAt).getTime()
        if (age > STALE_WAITING_TTL_MS) {
          reapReason = `Auto-cancelled after ${Math.floor(age / 3_600_000)}h waiting for feedback`
        }
      }

      if (!reapReason) continue

      if (task.containerId) {
        try { await stopContainer(task.containerId) } catch (err) {
          console.error('stopContainer failed during reap:', err)
        }
      }

      await transition(task.id, reapStatus, { actor: 'reconciler', message: reapReason })
      fireExtractLearnings(task.id)
    }
  } catch (err) {
    console.error('reapStaleWaitingTasks error:', err)
  }
}

async function enforceShipDeadlines() {
  try {
    const active = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ACTIVE_STATUSES))

    const now = Date.now()
    for (const task of active) {
      const tagList = parseTaskTags(task.tags)
      if (!tagList.includes(SHIP_TAG)) continue
      const age = now - new Date(task.createdAt).getTime()
      if (age <= SHIP_MODE_MAX_DURATION_MS) continue

      if (task.containerId) {
        try {
          await stopContainer(task.containerId)
        } catch (err) {
          console.error('stopContainer failed during ship deadline:', err)
        }
      }
      await transition(task.id, 'failed', { actor: 'reconciler', message: 'Ship deadline exceeded (45min)' })
      fireExtractLearnings(task.id)
    }
  } catch (err) {
    console.error('enforceShipDeadlines error:', err)
  }
}

const REAP_WAITING_INTERVAL_MS = 60_000 // 60 seconds

// Background context refresh cadence. 0 disables. Matches the
// POLL_PR_STATE_INTERVAL_MS precedent for external API cadence.
const CONTEXT_REFRESH_INTERVAL_MS = Number(process.env.CONTEXT_REFRESH_INTERVAL_MS ?? 120_000)

// Guard with globalThis singleton to prevent duplicate intervals
// across Next.js hot reloads in dev or multiple server instances
const RECONCILER_KEY = '__agent_dashboard_reconciler__'
const OBSERVER_KEY = '__agent_dashboard_observer__'
const PR_STATE_POLL_KEY = '__agent_dashboard_pr_state_poll__'
const REAP_WAITING_KEY = '__agent_dashboard_reap_waiting__'
const CONTEXT_REFRESH_KEY = '__agent_dashboard_context_refresh__'

// setInterval doesn't wait for the previous tick's promise — a tick whose
// Docker/GitHub awaits outlive the interval would otherwise overlap the next
// one, double-processing the same failure (duplicate retries, duplicate ops
// alerts, races against a just-retried task's status). Skip the tick instead;
// the loop catches up on the next interval. refreshContextCaches carries its
// own in-flight guard, so it doesn't need this wrapper.
//
// Trade-off: a tick that never settles (e.g. a dockerode call against a hung
// Docker daemon — those have no timeout) now stalls its loop permanently
// instead of piling up overlaps. Deliberately no forced reset — releasing the
// guard while the hung tick might still resume would reintroduce the overlap
// this exists to prevent. Log loudly instead so a wedged loop is visible.
const TICK_STALL_WARN_MS = 5 * 60 * 1000
function nonReentrant(name: string, fn: () => Promise<void>): () => Promise<void> {
  let inFlightSince: number | null = null
  return async () => {
    if (inFlightSince !== null) {
      const stalledMs = Date.now() - inFlightSince
      if (stalledMs > TICK_STALL_WARN_MS) {
        console.error(
          `[reconciler] ${name} tick still in flight after ${Math.round(stalledMs / 1000)}s — likely a hung Docker/GitHub call; loop is stalled`,
        )
      }
      return
    }
    inFlightSince = Date.now()
    try {
      await fn()
    } finally {
      inFlightSince = null
    }
  }
}

export function startReconciler() {
  const global = globalThis as unknown as Record<string, NodeJS.Timeout | undefined>
  if (!global[RECONCILER_KEY]) {
    const tick = nonReentrant('reconcile', reconcile)
    global[RECONCILER_KEY] = setInterval(tick, RECONCILE_INTERVAL_MS)
    tick()
  }
  if (!global[OBSERVER_KEY]) {
    const tick = nonReentrant('observeShipped', observeShipped)
    global[OBSERVER_KEY] = setInterval(tick, OBSERVE_SHIPPED_INTERVAL_MS)
    tick()
  }
  if (!global[PR_STATE_POLL_KEY]) {
    const tick = nonReentrant('pollPRState', pollPRState)
    global[PR_STATE_POLL_KEY] = setInterval(tick, POLL_PR_STATE_INTERVAL_MS)
    tick()
  }
  if (!global[REAP_WAITING_KEY]) {
    const tick = nonReentrant('reapStaleWaitingTasks', reapStaleWaitingTasks)
    global[REAP_WAITING_KEY] = setInterval(tick, REAP_WAITING_INTERVAL_MS)
    tick()
  }
  if (CONTEXT_REFRESH_INTERVAL_MS > 0 && !global[CONTEXT_REFRESH_KEY]) {
    global[CONTEXT_REFRESH_KEY] = setInterval(
      () => refreshContextCaches('interval'),
      CONTEXT_REFRESH_INTERVAL_MS,
    )
    refreshContextCaches('startup')
  }
}
