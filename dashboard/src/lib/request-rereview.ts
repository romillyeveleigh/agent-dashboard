/**
 * Re-request review from humans after an `address-comments` task completes.
 *
 * User-specified rule: once ANY human has approved a PR, no reviewer may be
 * re-pinged for review on that PR — a single approval suppresses all
 * re-review requests, even for reviewers with pending comments. Bot logins
 * are always excluded.
 */

import { eq } from 'drizzle-orm'
import { db } from './db'
import { tasks, diffs } from './schema'
import { parseTaskTags } from './parse-tags'
import { fetchPRsByNumber, requestPRReviewer, type PullRequest } from './github'
import { isBotOrSelf } from './bot-filter'
import { appendReconcilerLog } from './reconciler-logs'

function reviewersNeedingRereview(pr: PullRequest): string[] {
  // Latest review state per login, sorted by submittedAt.
  const latest = new Map<string, string>()
  const sorted = [...pr.reviews].sort((a, b) => (a.submittedAt || '').localeCompare(b.submittedAt || ''))
  for (const r of sorted) {
    if (!r.author) continue
    latest.set(r.author, r.state)
  }

  // Hard rule: if any non-bot reviewer's latest state is APPROVED, the PR is
  // good to go — never re-ping anyone, regardless of other pending comments.
  for (const [login, state] of latest) {
    if (isBotOrSelf(login)) continue
    if (state === 'APPROVED') return []
  }

  const out: string[] = []
  for (const [login, state] of latest) {
    if (isBotOrSelf(login)) continue
    if (state === 'APPROVED') continue // user rule — never re-ping approvers
    if (state === 'CHANGES_REQUESTED' || state === 'COMMENTED') out.push(login)
  }
  return out
}

/**
 * Called when an `address-comments` task transitions to `complete`.
 * Skips cleanly if the task pushed no diff or if no non-approver reviewers
 * remain.
 */
export async function requestRereview(taskId: string): Promise<void> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const task = rows[0]
  if (!task) return
  if (task.status !== 'complete') return
  // Match the category tag by inclusion, not position — historical rows carry
  // ['code', 'address-comments'] while current dispatches use
  // ['address-comments', 'code']. This also excludes 'triage-bot-comments'
  // tasks: bot triage never pings humans for re-review.
  if (!parseTaskTags(task.tags).includes('address-comments')) return
  if (task.prNumber == null) return

  // No diff pushed → nothing to re-review.
  const diffRows = await db.select().from(diffs).where(eq(diffs.taskId, taskId)).limit(1)
  if (diffRows.length === 0) {
    await appendReconcilerLog(taskId, 'rereview-skipped: no diff posted on this task')
    return
  }

  const prs = await fetchPRsByNumber([task.prNumber])
  const pr = prs[0]
  if (!pr) {
    await appendReconcilerLog(taskId, `rereview-skipped: could not fetch PR #${task.prNumber}`)
    return
  }

  const reviewers = reviewersNeedingRereview(pr)
  if (reviewers.length === 0) {
    await appendReconcilerLog(taskId, 'rereview-skipped: no non-approver reviewers need re-review')
  } else {
    await Promise.all(
      reviewers.map(async login => {
        const result = await requestPRReviewer(pr.number, login)
        if (result.ok) {
          await appendReconcilerLog(taskId, `re-review requested from ${login}`)
        } else {
          await appendReconcilerLog(taskId, `re-review failed for ${login}: ${result.error}`)
        }
      }),
    )
  }

  // Deliberately NO baseline update here. An earlier version advanced the ship
  // task's humanCommentCount to the fresh count, but (a) the agent's own
  // follow-up comments never bump the count anyway — countHumanComments
  // excludes GITHUB_USERNAME — so the write's only observable effect was to
  // absorb genuine reviewer comments that arrived while the task ran, silently
  // dropping them; and (b) it was an unlocked read-modify-write racing
  // reactToPRState's locked state writes. The baseline advances only inside
  // reactToPRState, under the task lock, when a dispatch actually happens.
}
