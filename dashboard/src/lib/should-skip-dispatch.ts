/**
 * Skip-dispatch gate for the Phase 2 reaction pipeline.
 *
 * Called by the poll cycle and webhook route ONLY — the human dispatch path
 * (POST /api/tasks) bypasses this so a human can override a pause or on-hold
 * label by clicking a quick action.
 */

import type { Task } from './schema'

// Lightweight shape — accepts anything with a `labels` array. Keeps this module
// decoupled from the full PullRequest type.
interface PRLike {
  labels?: Array<{ name: string }>
}

export interface SkipDecision {
  skip: boolean
  reason?: string
}

let cachedHolds: string[] | null = null
let cachedHoldsSource: string | undefined

function onHoldLabels(): string[] {
  const raw = process.env.ON_HOLD_LABELS ?? 'on-hold,do-not-merge,blocked,ci-external'
  if (cachedHolds && cachedHoldsSource === raw) return cachedHolds
  cachedHoldsSource = raw
  cachedHolds = raw.split(',').map(s => s.trim()).filter(Boolean)
  return cachedHolds
}

export function shouldSkipDispatch(pr: PRLike, task: Pick<Task, 'pausedAt'>): SkipDecision {
  if (task.pausedAt != null) {
    return { skip: true, reason: 'paused' }
  }
  const holds = onHoldLabels()
  const hit = pr.labels?.find(l => holds.includes(l.name))
  if (hit) {
    return { skip: true, reason: `on-hold-label:${hit.name}` }
  }
  return { skip: false }
}
