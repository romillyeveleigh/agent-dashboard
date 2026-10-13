/**
 * Shared dispatch helper. Used by POST /api/tasks (human), the PR-state poll
 * (reconciler), and the GitHub webhook route (webhook).
 *
 * Contract note — the skip-dispatch gate (`shouldSkipDispatch`) is NOT called
 * inside this helper. Human-initiated dispatches intentionally bypass the gate
 * so a human can override a pause or on-hold label by clicking a quick action.
 * The poll/webhook reaction paths must call the gate themselves before invoking
 * this helper. Do not "helpfully" push the check inside.
 */

import { v4 as uuid } from 'uuid'
import { and, inArray, eq } from 'drizzle-orm'
import { db } from './db'
import { tasks, messages } from './schema'
import { startContainer, stopContainer, getContainerStatus, resolvesToV2Image } from './docker'
import { emit } from './events'
import { buildAgentPrompt } from './prompt-builder'
import { SHIP_MODE_MAX_DURATION_MS, SHIP_TAG, ACTIVE_STATUSES } from './constants'
import { parseTaskTags } from './parse-tags'
import { withTaskLock } from './task-locks'
import { transition, recordTaskCreated } from './task-transitions'

export type DispatchedBy = 'human' | 'reconciler' | 'webhook'

export interface DispatchTaskInput {
  prompt: string
  tags?: string[]
  context?: { ticketId?: string; prNumber?: number }
  dispatchedBy: DispatchedBy
}

export type DispatchTaskResult =
  | { id: string; containerId: string }
  | { skipped: true; reason: string }

/**
 * Dispatch a new task: dedup against active tasks (when prNumber is set),
 * insert the row, start the container, emit task:created.
 *
 * Returns `{ skipped: true, reason }` when a duplicate-in-flight is detected.
 * Throws if the container fails to start; the row is marked failed before the
 * throw so callers don't leave orphan `starting` rows.
 */
export async function dispatchTask(input: DispatchTaskInput): Promise<DispatchTaskResult> {
  const { prompt, tags = [], context, dispatchedBy } = input

  const dashboardUrl = process.env.DASHBOARD_URL
  if (!dashboardUrl) {
    throw new Error('DASHBOARD_URL environment variable is not set')
  }

  // Dedup: if prNumber is set, skip when an active task with the same primary
  // tag already exists for this PR. Matches the existing reconciler pattern —
  // SELECT by prNumber + ACTIVE_STATUSES, then filter tags in JS.
  const primaryTag = tags[0]
  if (context?.prNumber && primaryTag) {
    const active = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.prNumber, context.prNumber),
          inArray(tasks.status, ACTIVE_STATUSES),
        ),
      )
    const dup = active.find(t => parseTaskTags(t.tags)[0] === primaryTag)
    if (dup) {
      return { skipped: true, reason: `dedup: active ${primaryTag} task ${dup.id} for PR #${context.prNumber}` }
    }
  }

  const taskId = uuid()
  const agentToken = uuid()
  const agentPrompt = await buildAgentPrompt({
    instruction: prompt,
    taskId,
    dashboardUrl,
    tags,
    context,
  })

  const maxDurationMs = tags.includes(SHIP_TAG) ? SHIP_MODE_MAX_DURATION_MS : undefined
  const launchConfig = { instruction: prompt, prompt: agentPrompt, tags, context, maxDurationMs }

  await db.insert(tasks).values({
    id: taskId,
    prompt: agentPrompt,
    tags: JSON.stringify(tags),
    ticketId: context?.ticketId || null,
    prNumber: context?.prNumber || null,
    status: 'starting',
    launchConfigJson: JSON.stringify(launchConfig),
    dispatchedBy,
    agentToken,
  })
  await recordTaskCreated(
    taskId,
    'starting',
    dispatchedBy === 'human' ? 'human' : dispatchedBy === 'reconciler' ? 'reconciler' : 'system',
  )

  let containerId: string
  try {
    containerId = await startContainer({
      taskId,
      agentToken,
      prompt: agentPrompt,
      dashboardUrl,
      context,
      tags,
      maxDurationMs,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[dispatchTask] Container start failed for task ${taskId}: ${msg}`)
    await transition(taskId, 'failed', {
      actor: 'system',
      message: `Container start failed: ${msg}`,
      emitStatus: false,
    })
    throw err
  }

  await db
    .update(tasks)
    .set({ containerId, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  emit('task:created', {
    id: taskId,
    tags,
    ticketId: context?.ticketId,
    prNumber: context?.prNumber,
    status: 'starting',
  })

  return { id: taskId, containerId }
}

/**
 * Restart a suspended task's container so it resumes its Claude session with
 * the human's answer. Suspended = waiting_for_feedback + resume_session_id
 * set + container exited (v2 supervisor grace-window timeout).
 * No-op (returns existing id) if a container is already running — the answer
 * was posted inside the grace window and the live reply poll will pick it up.
 */
export async function resumeSuspendedTask(taskId: string, answerText: string): Promise<string> {
  return withTaskLock(taskId, async () => {
    const dashboardUrl = process.env.DASHBOARD_URL
    if (!dashboardUrl) throw new Error('DASHBOARD_URL environment variable is not set')

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
    if (!task) throw new Error(`resumeSuspendedTask: task ${taskId} not found`)
    if (!task.resumeSessionId) throw new Error(`resumeSuspendedTask: task ${taskId} has no resume session`)
    if (!task.launchConfigJson) throw new Error(`resumeSuspendedTask: task ${taskId} has no launch config`)

    if (task.containerId && (await getContainerStatus(task.containerId)) === 'running') {
      return task.containerId
    }

    // A reaper (PR-terminal reap, ship deadline) may have concluded this task
    // between the answers route's check and us acquiring the lock. Never
    // resurrect a terminal task (final-review finding: reap/resume race).
    if (task.status !== 'waiting_for_feedback') {
      console.warn(`resumeSuspendedTask: task ${taskId} is ${task.status}, not resuming`)
      return task.containerId ?? ''
    }

    const config = JSON.parse(task.launchConfigJson)

    // Rollback safety: if the v2 canary is disabled (or this tag no longer
    // routes to v2), the old image would ignore RESUME_SESSION_ID and re-run
    // the ORIGINAL prompt — silently discarding the human's answer. Park the
    // task instead; re-enabling the canary and re-answering resumes it.
    if (!resolvesToV2Image(config.tags)) {
      await db.update(tasks)
        .set({
          statusMessage: 'Answer received but v2 canary is disabled — re-enable AGENT_IMAGE_V2/AGENT_V2_TAGS and answer again to resume',
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))
      console.warn(`resumeSuspendedTask: task ${taskId} tags do not resolve to the v2 image — parked instead of resuming`)
      return task.containerId ?? ''
    }

    // Enter 'starting' with no container recorded: if startContainer throws,
    // reapStuckStartingTasks (status='starting' + null containerId + 2min TTL)
    // marks the task failed — never stuck-invisible (review finding C1).
    await transition(taskId, 'starting', {
      actor: 'human',
      message: 'Resuming after answer',
      set: { containerId: null },
    })

    const containerId = await startContainer({
      taskId,
      agentToken: task.agentToken ?? undefined,
      prompt: config.prompt, // unused on resume path but keeps env contract
      dashboardUrl,
      context: config.context,
      tags: config.tags,
      maxDurationMs: config.maxDurationMs,
      resumeSessionId: task.resumeSessionId,
      resumePrompt: answerText,
    })
    await transition(taskId, 'running', {
      actor: 'human',
      message: 'Resumed after feedback',
      set: { containerId },
    })
    return containerId
  })
}

/**
 * Replace a task's container from its saved launch config (used by both the
 * reconciler auto-retry and the manual retry endpoint).
 *
 * Invariant: a task row has a single `container_id` column, so we must never
 * start a replacement container without first stopping the one currently
 * recorded — otherwise the old container keeps running untracked (an orphan
 * the dashboard can't see or stop). The whole stop → start → record sequence
 * runs under a per-task lock so concurrent retries (two reconciler ticks, or
 * a reconciler tick racing a manual retry) can't each spawn a container.
 *
 * Idempotent under the lock: if the recorded container is already running
 * (a concurrent caller just replaced it), this returns that id without churn.
 *
 * Throws if the task is missing, has no launch config, or the container fails
 * to start. Callers own the task's status/retryCount bookkeeping.
 */
export async function replaceTaskContainer(taskId: string): Promise<string> {
  return withTaskLock(taskId, () => replaceTaskContainerLocked(taskId))
}

/**
 * replaceTaskContainer's body for callers that already hold this task's lock.
 * withTaskLock chains on the pending promise, so re-acquiring the same key from
 * inside the lock deadlocks — those callers must use this instead.
 */
export async function replaceTaskContainerLocked(taskId: string): Promise<string> {
  const dashboardUrl = process.env.DASHBOARD_URL
  if (!dashboardUrl) {
    throw new Error('DASHBOARD_URL environment variable is not set')
  }

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  if (!task) throw new Error(`replaceTaskContainer: task ${taskId} not found`)
  if (!task.launchConfigJson) {
    throw new Error(`replaceTaskContainer: task ${taskId} has no saved launch config`)
  }

  // Stop the previously-recorded container before overwriting container_id.
  // If it's already running, a concurrent caller beat us to the replacement —
  // leave it and return, so we don't kill a healthy container or orphan one.
  if (task.containerId) {
    if ((await getContainerStatus(task.containerId)) === 'running') {
      return task.containerId
    }
    try {
      await stopContainer(task.containerId)
    } catch (err) {
      console.error(`replaceTaskContainer: stop ${task.containerId} failed:`, err)
    }
  }

  // Supersede any questions the dead agent left open. The container that asked
  // them is gone, so no live agent is listening for the answer. Leaving them
  // answered=false strands them: the dashboard shows a phantom "waiting on you"
  // indicator, and — worse — the /api/status `complete` guard treats ANY open
  // agent_to_human message on the task as reason to coerce a genuine completion
  // to `waiting_for_feedback`. A stale question from a prior attempt would then
  // block every future run from ever reaching `complete`, so the reconciler
  // later mislabels the normal container exit as "stopped unexpectedly".
  await db
    .update(messages)
    .set({ answered: true })
    .where(
      and(
        eq(messages.taskId, taskId),
        eq(messages.direction, 'agent_to_human'),
        eq(messages.answered, false),
      ),
    )

  const config = JSON.parse(task.launchConfigJson)
  const containerId = await startContainer({
    taskId,
    agentToken: task.agentToken ?? undefined,
    prompt: config.prompt,
    dashboardUrl,
    context: config.context,
    tags: config.tags,
    maxDurationMs: config.maxDurationMs,
  })
  await db
    .update(tasks)
    .set({ containerId, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  return containerId
}
