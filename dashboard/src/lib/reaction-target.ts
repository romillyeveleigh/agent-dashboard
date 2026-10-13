import { parseTaskTags } from './parse-tags'
import { INACTIVE_STATUSES, REACTION_TAGS } from './constants'

// The single "is this PR being watched" rule, shared by the reconciler's
// poll-cycle lookups (ship-tasks.ts) and the UI (watch badges/toggles).
// Note `complete` does NOT disarm a watcher — a ship task keeps reacting
// after its container finishes, until the PR ships or the task is
// failed/cancelled. Keep this file client-safe (no db imports).
export interface ReactionTargetFields {
  tags: string
  prNumber: number | null
  shippedAt: Date | string | null
  status: string
}

export function isReactionTarget(task: ReactionTargetFields): boolean {
  return (
    task.prNumber != null &&
    task.shippedAt == null &&
    !INACTIVE_STATUSES.includes(task.status) &&
    parseTaskTags(task.tags).some(t => REACTION_TAGS.includes(t))
  )
}
