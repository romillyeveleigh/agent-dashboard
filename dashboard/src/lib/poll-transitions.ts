/**
 * Pure transition-decision logic for the Phase 2 reaction pipeline.
 *
 * Consumed by both the 2-min poll cycle (reconciler) and the GitHub webhook
 * route. Building against a test-green pure function is cheaper than extracting
 * it from a live reconciler after the fact.
 */

import { eq } from 'drizzle-orm'
import { db } from './db'
import { tasks } from './schema'
import type { Task } from './schema'
import { INACTIVE_STATUSES } from './constants'
import { shouldSkipDispatch } from './should-skip-dispatch'
import { dispatchTask, type DispatchedBy } from './dispatch-task'
import { DRAWER_PRESETS } from './quick-actions'
import { fetchMainCiStatus, fetchPRsByNumber, rerunFailedWorkflows, type PullRequest } from './github'
import { countBotReviewComments, countHumanComments } from './bot-filter'
import { appendReconcilerLog } from './reconciler-logs'

export interface PRStatePayload {
  ciStatus: string | null
  humanCommentCount: number
  reviewDecision: string | null
  headSha: string
  failedHeadShas: string[]
  // SHAs for which we've already attempted a `gh run rerun` via the poll
  // pipeline. Prevents re-rerunning CI for the same SHA on every poll cycle.
  // If CI still fails after a rerun, the next poll dispatches fix-ci instead.
  rerunAttemptedShas: string[]
  // null = never observed (state written before the Phase 4 bot pre-review
  // pass shipped). A null baseline records without dispatching, so historical
  // bot comments don't trigger a wave of triage tasks on upgrade.
  botCommentCount: number | null
  observedAt: string
  terminal?: string
  skipReason?: string
}

export interface DecisionInput {
  prev: PRStatePayload | null
  current: {
    ciStatus: string | null
    humanCommentCount: number
    botCommentCount?: number  // review-bot comments + reviews; default 0
    reviewDecision: string | null
    headSha: string
    state: string            // OPEN | MERGED | CLOSED
    displayStatus: string    // Merged | Closed | Draft | Approved | Changes req. | Pending
  }
  ciRounds: number
  mainCiStatus: string | null
  baseCiStatus: string | null   // null when PR is based on main
  pausedAt: Date | null
  labels: string[]
  ciBudget?: number            // default 3
  botTriageRounds?: number     // default 0
  botTriageBudget?: number     // default 2
}

export type DecisionItem =
  | { kind: 'terminal'; reason: string }
  | { kind: 'skip-all'; reason: string }
  | { kind: 'dispatch-ci' }
  | { kind: 'dispatch-comments' }
  | { kind: 'dispatch-bot-triage' }
  | { kind: 'skip-ci'; reason: string }
  | { kind: 'skip-comments'; reason: string }
  | { kind: 'skip-bot-triage'; reason: string }
  | { kind: 'ci-success-observed' }
  | { kind: 'ci-failure-observed'; sha: string }
  | { kind: 'rerun-ci' }
  | { kind: 'rerun-attempted'; sha: string }

export const DEFAULT_CI_BUDGET = 3
export const DEFAULT_BOT_TRIAGE_BUDGET = 2

export function computeDispatchDecision(input: DecisionInput): DecisionItem[] {
  const { prev, current, ciRounds, mainCiStatus, baseCiStatus, pausedAt, labels } = input
  const ciBudget = input.ciBudget ?? DEFAULT_CI_BUDGET
  const items: DecisionItem[] = []

  if (current.state === 'CLOSED' && current.displayStatus !== 'Merged') {
    return [{ kind: 'terminal', reason: 'closed-not-merged' }]
  }

  const skip = shouldSkipDispatch(
    { labels: labels.map(name => ({ name })) },
    { pausedAt },
  )
  if (skip.skip) {
    return [{ kind: 'skip-all', reason: skip.reason ?? 'skip' }]
  }

  if (current.ciStatus === 'SUCCESS' && prev?.ciStatus !== 'SUCCESS') {
    items.push({ kind: 'ci-success-observed' })
  }

  const ciTransitionedToFailure =
    current.ciStatus === 'FAILURE' && prev?.ciStatus !== 'FAILURE'

  if (ciTransitionedToFailure) {
    if (mainCiStatus === 'FAILURE') {
      items.push({ kind: 'skip-ci', reason: 'main-broken' })
    } else if (baseCiStatus === 'FAILURE') {
      items.push({ kind: 'skip-ci', reason: 'stack-below-broken' })
    } else if (prev?.failedHeadShas?.includes(current.headSha)) {
      items.push({ kind: 'skip-ci', reason: 'flake-suspected' })
    } else if (ciRounds >= ciBudget) {
      items.push({ kind: 'skip-ci', reason: 'budget-exhausted' })
    } else if (prev?.rerunAttemptedShas?.includes(current.headSha)) {
      // We already tried rerunning CI for this SHA and it failed again —
      // now dispatch a fix-ci task to investigate the real cause.
      items.push({ kind: 'dispatch-ci' })
      items.push({ kind: 'ci-failure-observed', sha: current.headSha })
    } else {
      // First failure for this SHA — try a cheap CI rerun before spawning
      // a container. If CI passes, it was an infra flake. If it fails again,
      // the next poll will hit the rerunAttemptedShas branch above and
      // dispatch fix-ci.
      items.push({ kind: 'rerun-ci' })
      items.push({ kind: 'rerun-attempted', sha: current.headSha })
    }
  }

  const prevCount = prev?.humanCommentCount ?? 0
  const commentBumped = current.humanCommentCount > prevCount
  const changesReqTransition =
    current.reviewDecision === 'CHANGES_REQUESTED' &&
    prev?.reviewDecision !== 'CHANGES_REQUESTED'

  if (commentBumped || changesReqTransition) {
    if (current.reviewDecision === 'APPROVED') {
      items.push({ kind: 'skip-comments', reason: 'approved' })
    } else {
      items.push({ kind: 'dispatch-comments' })
    }
  }

  // Phase 4 bot pre-review pass: a review-bot comment/review bump triggers a
  // validity-check triage dispatch. Approval suppresses it (same rule as
  // human comments); a per-task budget bounds the push→bot-re-review loop.
  const prevBotCount = prev?.botCommentCount ?? null
  const botBumped = prevBotCount !== null && (current.botCommentCount ?? 0) > prevBotCount
  if (botBumped) {
    if (current.reviewDecision === 'APPROVED') {
      items.push({ kind: 'skip-bot-triage', reason: 'approved' })
    } else if ((input.botTriageRounds ?? 0) >= (input.botTriageBudget ?? DEFAULT_BOT_TRIAGE_BUDGET)) {
      items.push({ kind: 'skip-bot-triage', reason: 'budget-exhausted' })
    } else {
      items.push({ kind: 'dispatch-bot-triage' })
    }
  }

  return items
}

// ─── Reaction wrapper ───────────────────────────────────────────────────────
//
// Both the poll cycle and the webhook route feed a ship task + fresh PR state
// through this function. It computes the decision, acts on it (dispatching
// follow-up tasks via `dispatchTask`), and writes `pr_state_json` per the
// "write-only-on-success-or-intentional-skip" policy.

function presetPrompt(id: string): string | null {
  const p = DRAWER_PRESETS.find(x => x.id === id)
  if (!p) {
    console.error(`[poll-transitions] unknown preset id: ${id}`)
    return null
  }
  return p.prompt
}

function parsePrevState(raw: string | null): PRStatePayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return {
        ciStatus: parsed.ciStatus ?? null,
        humanCommentCount: Number(parsed.humanCommentCount ?? 0),
        reviewDecision: parsed.reviewDecision ?? null,
        headSha: parsed.headSha ?? '',
        failedHeadShas: Array.isArray(parsed.failedHeadShas) ? parsed.failedHeadShas : [],
        rerunAttemptedShas: Array.isArray(parsed.rerunAttemptedShas) ? parsed.rerunAttemptedShas : [],
        botCommentCount: parsed.botCommentCount == null ? null : Number(parsed.botCommentCount),
        observedAt: parsed.observedAt ?? '',
        terminal: parsed.terminal,
        skipReason: parsed.skipReason,
      }
    }
  } catch { /* ignore */ }
  return null
}

function snapshotPR(
  pr: PullRequest,
  humanCommentCount: number,
  botCommentCount: number,
  failedHeadShas: string[],
  rerunAttemptedShas: string[],
  extra: Partial<PRStatePayload> = {},
): PRStatePayload {
  return {
    ciStatus: pr.ciStatus,
    humanCommentCount,
    botCommentCount,
    reviewDecision: pr.reviewDecision,
    headSha: pr.headRefOid,
    failedHeadShas,
    rerunAttemptedShas,
    observedAt: new Date().toISOString(),
    ...extra,
  }
}

// `observedAt` is always fresh, so direct byte-compare would always differ.
// Compare the meaningful fields and skip the write when nothing changed —
// avoids a DB update + `updatedAt` bump on every idle 2-min poll.
function stateMaterial(s: PRStatePayload | null): string {
  if (!s) return ''
  return JSON.stringify({
    c: s.ciStatus,
    n: s.humanCommentCount,
    b: s.botCommentCount ?? null,
    r: s.reviewDecision,
    h: s.headSha,
    f: s.failedHeadShas,
    rrs: s.rerunAttemptedShas,
    t: s.terminal ?? null,
    s: s.skipReason ?? null,
  })
}

// Table-driven dispatch config. Both branches differ only in preset id,
// tags, the counter field, and log prefixes.
//
// Tag order matters: `dispatchTask` dedups on tags[0], so the dispatch kinds
// MUST have distinct primary tags — a shared primary ('code') made a running
// fix-ci task swallow the address-comments dispatch (and vice versa), silently
// dropping reviewer feedback. request-rereview.ts also keys on the
// 'address-comments' tag. The 'code' tag stays second so prompt-builder still
// resolves the skill mode from it.
const DISPATCH_CONFIG: Record<'dispatch-ci' | 'dispatch-comments' | 'dispatch-bot-triage', {
  presetId: string
  tags: string[]
  counter: 'ciRounds' | 'reviewRounds' | 'botTriageRounds'
  transitionMsg: string
}> = {
  'dispatch-ci': {
    presetId: 'investigate-ci',
    tags: ['fix-ci', 'code'],
    counter: 'ciRounds',
    transitionMsg: 'ci FAILURE → dispatched fix-ci',
  },
  'dispatch-comments': {
    presetId: 'address-comments',
    tags: ['address-comments', 'code'],
    counter: 'reviewRounds',
    transitionMsg: 'human comment bump → dispatched address-comments',
  },
  'dispatch-bot-triage': {
    presetId: 'triage-bot-comments',
    tags: ['triage-bot-comments', 'code'],
    counter: 'botTriageRounds',
    transitionMsg: 'bot review bump → dispatched triage-bot-comments',
  },
}

export interface ReactContext {
  task: Task
  pr: PullRequest
  mainCiStatus: string | null
  baseCiStatus: string | null
  dispatchedBy: Extract<DispatchedBy, 'reconciler' | 'webhook'>
}

/**
 * Compute and act on the current PR state for one ship task. Used by both
 * the 2-min poll and the webhook route. Serialisation across races between
 * the two callers is the caller's responsibility (see `withTaskLock` wrapping
 * in reconciler.ts and webhooks/github/route.ts).
 */
export async function reactToPRState(ctx: ReactContext): Promise<void> {
  const { pr, mainCiStatus, baseCiStatus, dispatchedBy } = ctx
  // ctx.task was snapshotted before the caller acquired the task lock, so a
  // webhook/poll racing us may have already advanced pr_state_json or the
  // counters. Re-read the row now that the lock is held and decide from that.
  const [task] = await db.select().from(tasks).where(eq(tasks.id, ctx.task.id))
  if (!task) return
  if (task.shippedAt || INACTIVE_STATUSES.includes(task.status)) return
  const prev = parsePrevState(task.prStateJson)
  const prevMaterial = stateMaterial(prev)
  const humanCommentCount = countHumanComments(pr)
  const botCommentCount = countBotReviewComments(pr)
  const prevFailedShas = prev?.failedHeadShas ?? []
  const prevRerunShas = prev?.rerunAttemptedShas ?? []

  const writeState = async (state: PRStatePayload, counters?: { ciRounds?: number; reviewRounds?: number; botTriageRounds?: number }) => {
    const patch: Partial<typeof tasks.$inferInsert> = {
      prStateJson: JSON.stringify(state),
      updatedAt: new Date(),
    }
    if (counters?.ciRounds !== undefined) patch.ciRounds = counters.ciRounds
    if (counters?.reviewRounds !== undefined) patch.reviewRounds = counters.reviewRounds
    if (counters?.botTriageRounds !== undefined) patch.botTriageRounds = counters.botTriageRounds
    await db.update(tasks).set(patch).where(eq(tasks.id, task.id))
  }

  const gate = shouldSkipDispatch(pr, { pausedAt: task.pausedAt })
  if (gate.skip) {
    const next = snapshotPR(pr, humanCommentCount, botCommentCount, prevFailedShas, prevRerunShas, { skipReason: gate.reason })
    if (stateMaterial(next) !== prevMaterial) await writeState(next)
    await appendReconcilerLog(task.id, `skipped: ${gate.reason}`)
    return
  }

  if (pr.state === 'CLOSED' && pr.displayStatus !== 'Merged') {
    if (prev?.terminal) return
    const next = snapshotPR(pr, humanCommentCount, botCommentCount, prevFailedShas, prevRerunShas, { terminal: 'closed-not-merged' })
    await writeState(next)
    await appendReconcilerLog(task.id, 'pr-closed: closed-not-merged, no further dispatches')
    return
  }

  const items = computeDispatchDecision({
    prev,
    current: {
      ciStatus: pr.ciStatus,
      humanCommentCount,
      botCommentCount,
      reviewDecision: pr.reviewDecision,
      headSha: pr.headRefOid,
      state: pr.state,
      displayStatus: pr.displayStatus,
    },
    ciRounds: task.ciRounds,
    mainCiStatus,
    baseCiStatus,
    pausedAt: task.pausedAt,
    labels: pr.labels?.map(l => l.name) ?? [],
    botTriageRounds: task.botTriageRounds,
  })

  let nextCiRounds = task.ciRounds
  let nextReviewRounds = task.reviewRounds
  let nextBotTriageRounds = task.botTriageRounds
  let nextFailedShas = prevFailedShas
  let nextRerunShas = prevRerunShas
  let dispatchFailed = false

  // Accounting items (non-awaiting) — resolve sequentially, they mutate shared state.
  for (const item of items) {
    if (item.kind === 'terminal' || item.kind === 'skip-all') continue
    if (item.kind === 'ci-success-observed') {
      nextCiRounds = 0
      nextFailedShas = []
      nextRerunShas = []
    } else if (item.kind === 'ci-failure-observed') {
      if (!nextFailedShas.includes(item.sha)) {
        nextFailedShas = [...nextFailedShas, item.sha]
      }
    } else if (item.kind === 'rerun-attempted') {
      if (!nextRerunShas.includes(item.sha)) {
        nextRerunShas = [...nextRerunShas, item.sha]
      }
    }
  }

  // Skip-all log (single terminal gate log already covered above).
  for (const item of items) {
    if (item.kind === 'skip-all') {
      await appendReconcilerLog(task.id, `skipped: ${item.reason}`)
    } else if (item.kind === 'skip-ci' || item.kind === 'skip-comments' || item.kind === 'skip-bot-triage') {
      await appendReconcilerLog(task.id, `skipped-${item.kind}: ${item.reason}`)
    }
  }

  // CI rerun: try `gh run rerun` for failed workflows before spawning a
  // fix-ci container. This is a cheap API call that handles infra flakes
  // (ArgoCD 502s, runner setup errors) without a full container dispatch.
  const rerunItem = items.find(i => i.kind === 'rerun-ci')
  if (rerunItem) {
    try {
      const result = await rerunFailedWorkflows(pr.headRefOid)
      if (result.ok && result.rerunCount > 0) {
        await appendReconcilerLog(task.id, `ci-rerun: re-queued ${result.rerunCount} failed workflow run(s) for SHA ${pr.headRefOid.slice(0, 8)}`)
      } else if (result.ok && result.rerunCount === 0) {
        // No GitHub Actions runs to rerun — failure may be from an external CI
        // provider. Fall through to dispatch-ci on the next poll anyway (the
        // SHA is now in rerunAttemptedShas), but log that we couldn't rerun.
        await appendReconcilerLog(task.id, `ci-rerun: no failed Actions runs found for SHA ${pr.headRefOid.slice(0, 8)} (external CI?)`)
      } else {
        await appendReconcilerLog(task.id, `ci-rerun failed: ${result.error}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await appendReconcilerLog(task.id, `ci-rerun error: ${msg}`)
    }
  }

  // Parallelise the two dispatch kinds — they're independent (disjoint counters,
  // disjoint preset ids) so one Docker start doesn't need to block the other.
  const dispatches = items.filter(
    (i): i is Extract<DecisionItem, { kind: 'dispatch-ci' | 'dispatch-comments' | 'dispatch-bot-triage' }> =>
      i.kind === 'dispatch-ci' || i.kind === 'dispatch-comments' || i.kind === 'dispatch-bot-triage',
  )
  const dispatchResults = await Promise.all(
    dispatches.map(async item => {
      const cfg = DISPATCH_CONFIG[item.kind]
      const prompt = presetPrompt(cfg.presetId)
      if (!prompt) return { cfg, ok: false as const }
      try {
        const result = await dispatchTask({
          prompt,
          tags: cfg.tags,
          context: { prNumber: pr.number, ticketId: task.ticketId ?? undefined },
          dispatchedBy,
        })
        return { cfg, ok: true as const, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { cfg, ok: false as const, msg }
      }
    }),
  )

  // A dedup-skip means another active task holds the slot right now — the
  // trigger was NOT handled, so the baseline for that dimension must not
  // advance. Otherwise the bump is marked "observed" and the feedback is
  // dropped forever instead of dispatching once the blocking task finishes.
  let ciDispatchSkipped = false
  let commentsDispatchSkipped = false
  let botTriageDispatchSkipped = false

  for (const r of dispatchResults) {
    if (!r.ok) {
      dispatchFailed = true
      if (r.msg) await appendReconcilerLog(task.id, `dispatch-failed (${r.cfg.tags[0]}): ${r.msg}`)
      continue
    }
    if ('skipped' in r.result) {
      if (r.cfg.counter === 'ciRounds') ciDispatchSkipped = true
      else if (r.cfg.counter === 'reviewRounds') commentsDispatchSkipped = true
      else botTriageDispatchSkipped = true
      await appendReconcilerLog(task.id, `${r.cfg.tags[0]}: ${r.result.reason}`)
    } else {
      if (r.cfg.counter === 'ciRounds') nextCiRounds = task.ciRounds + 1
      else if (r.cfg.counter === 'reviewRounds') nextReviewRounds = task.reviewRounds + 1
      else nextBotTriageRounds = task.botTriageRounds + 1
      await appendReconcilerLog(task.id, `transition-detected: ${r.cfg.transitionMsg} task ${r.result.id}`)
    }
  }

  if (dispatchFailed) {
    await appendReconcilerLog(task.id, 'state-write skipped: dispatch error, next cycle retries')
    return
  }

  const nextState = snapshotPR(pr, humanCommentCount, botCommentCount, nextFailedShas, nextRerunShas)
  if (commentsDispatchSkipped) {
    nextState.humanCommentCount = prev?.humanCommentCount ?? 0
    nextState.reviewDecision = prev?.reviewDecision ?? null
  }
  if (ciDispatchSkipped) {
    nextState.ciStatus = prev?.ciStatus ?? null
    nextState.failedHeadShas = prevFailedShas
  }
  if (botTriageDispatchSkipped) {
    nextState.botCommentCount = prev?.botCommentCount ?? null
  }
  const counterChanged =
    nextCiRounds !== task.ciRounds ||
    nextReviewRounds !== task.reviewRounds ||
    nextBotTriageRounds !== task.botTriageRounds
  if (stateMaterial(nextState) === prevMaterial && !counterChanged) {
    await appendReconcilerLog(task.id, 'poll-no-change')
    return
  }
  await writeState(nextState, {
    ciRounds: nextCiRounds !== task.ciRounds ? nextCiRounds : undefined,
    reviewRounds: nextReviewRounds !== task.reviewRounds ? nextReviewRounds : undefined,
    botTriageRounds: nextBotTriageRounds !== task.botTriageRounds ? nextBotTriageRounds : undefined,
  })
}

/**
 * One-shot reaction for a single ship task (used by the webhook route).
 * Refetches the PR + main CI, then delegates to `reactToPRState`.
 *
 * Webhook path does NOT resolve base-branch CI — that's a known gap; the
 * 2-min poll covers stack-below-broken detection within two cycles.
 */
export async function reactForPR(
  task: Task,
  prNumber: number,
  dispatchedBy: 'webhook' | 'reconciler',
): Promise<void> {
  const [prs, mainCiStatus] = await Promise.all([
    fetchPRsByNumber([prNumber]),
    fetchMainCiStatus(),
  ])
  const pr = prs[0]
  if (!pr) {
    await appendReconcilerLog(task.id, `react-skipped: fetchPRsByNumber returned no PR for #${prNumber}`)
    return
  }
  await reactToPRState({ task, pr, mainCiStatus, baseCiStatus: null, dispatchedBy })
}
