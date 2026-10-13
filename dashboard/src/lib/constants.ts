// Shared constants — imported by both client (quick-actions.ts) and server (docker.ts)
// to keep skill name validation and prompt templates in sync.

export const DEFAULT_SKILL = 'do-some-work-headless'

export const SHIP_TAG = 'ship'
export const WATCH_TAG = 'watch'
// Tags that make a task a reaction target for the Phase 2 pipeline (poll/webhook).
export const REACTION_TAGS: string[] = [SHIP_TAG, WATCH_TAG]

export const TERMINAL_STATUSES = ['complete', 'failed'] as const
// `watching` is an active-but-idle status for human-created watcher tasks
// that have no container — they exist purely as reaction targets.
export const ACTIVE_STATUSES: string[] = ['pending', 'starting', 'running', 'waiting_for_feedback', 'watching']
// Statuses ineligible for Phase 2 reactive dispatch (cannot produce more progress).
// `resolved` is the benign sibling of `cancelled`: the reconciler reaps a
// waiting task to it when the PR it was waiting on reached its own terminal
// state (merged/closed/approved), so the pending question is simply moot —
// distinct from `cancelled`, which means a human killed it or it timed out.
export const INACTIVE_STATUSES: string[] = ['failed', 'cancelled', 'resolved']

export function isTerminalStatus(s: string): s is typeof TERMINAL_STATUSES[number] {
  return (TERMINAL_STATUSES as readonly string[]).includes(s)
}

// Statuses an agent may report via POST /api/status. Anything outside this set
// would wedge the task: not active (reconciler ignores it) and not terminal
// (nothing reaps it). Must stay in sync with the post_status tool enum in
// docker/supervisor/src/index.ts; docker/entrypoint.sh posts running/complete/failed.
export const AGENT_REPORTABLE_STATUSES: string[] = [
  'running',
  'waiting_for_feedback',
  'complete',
  'failed',
  'cancelled',
]

// Phase 2 PR-state poll cadence. 2 min keeps the webhook/poll truth gap
// small without burning GraphQL quota.
export const POLL_PR_STATE_INTERVAL_MS = 120_000

// Injected Repo Memories are a curated kernel, not a dump: 12 high-signal
// entries ≈ 5k chars. History showed 50 uncurated entries ≈ 22k chars of
// mostly duplicate/skill-restating noise (see docs/memory-system-spec.md).
export const MAX_MEMORIES = 12
// Pool fetched for filtering/dedup before the top-MAX_MEMORIES cut. Must be
// much larger than MAX_MEMORIES: category filtering and dedup discard most of it.
export const MEMORY_FETCH_WINDOW = 150
export const MAX_LOG_ENTRIES = 200

// Ship-mode tasks get a hard 45-minute deadline. The reconciler force-stops
// the container and marks the task failed if this elapses (enforcement in
// reconciler.ts); the same value is stamped on the container as label
// agent.max_duration_ms for operator visibility only.
export const SHIP_MODE_MAX_DURATION_MS = 45 * 60 * 1000
