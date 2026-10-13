/**
 * Single writer for tasks.status. Every status change goes through
 * transition(): it records an append-only task_events row, applies the
 * update, and emits the standard SSE event. Business logic (what to
 * transition to, and when) stays in the callers — this module owns only
 * legality-checking and the write itself.
 *
 * Rollout: while TASK_TRANSITIONS_ENFORCE is unset, illegal transitions are
 * logged (console + violation=1 event row) but ALWAYS applied — behavior is
 * byte-identical to the pre-state-machine code. After the observation period
 * confirms the ALLOWED map, enforcement turns
 * violations into thrown TaskTransitionError.
 */
import { db } from './db'
import { tasks, taskEvents } from './schema'
import { emit } from './events'
import { eq } from 'drizzle-orm'

export type TaskActor = 'human' | 'agent' | 'reconciler' | 'system'

export class TaskTransitionError extends Error {}

// Notable entries: running→starting is the reconciler auto-retry; failed→starting is
// the manual retry route; waiting_for_feedback→starting is the v2 resume;
// same-status entries are legal because progress updates re-post the current
// status with a new message.
const ALLOWED: Record<string, readonly string[]> = {
  pending: ['starting', 'cancelled'],
  starting: ['starting', 'running', 'waiting_for_feedback', 'complete', 'failed', 'cancelled'],
  running: ['running', 'starting', 'waiting_for_feedback', 'complete', 'failed', 'cancelled'],
  waiting_for_feedback: ['waiting_for_feedback', 'running', 'starting', 'complete', 'failed', 'cancelled', 'resolved'],
  watching: ['watching', 'complete', 'cancelled', 'resolved'],
  // Terminal self-loops are legal: the container entrypoint routinely reposts
  // the terminal status after the agent's own verdict (see status/route.ts's
  // generic-final-message handling). Self-loops produce no event row
  // (from === to, no violation) — they refresh statusMessage only.
  failed: ['failed', 'starting'], // starting = manual retry
  complete: ['complete'],
  cancelled: ['cancelled'],
  resolved: ['resolved'],
}

const ENFORCE = process.env.TASK_TRANSITIONS_ENFORCE === '1'

export interface TransitionOptions {
  actor: TaskActor
  /** statusMessage semantics: undefined = leave the existing message
   *  untouched; null = clear it; string = set it. Matches what each
   *  converted call site did before. */
  message?: string | null
  /** Extra columns the old call site set atomically with status. */
  set?: Partial<{ containerId: string | null; retryCount: number }>
  /** Emit the task:status SSE event (default true). Set false only where the
   *  old call site deliberately did not emit. */
  emitStatus?: boolean
}

export async function transition(
  taskId: string,
  to: string,
  opts: TransitionOptions,
): Promise<{ from: string | null; to: string; violation: boolean }> {
  const { actor, message, set, emitStatus = true } = opts

  const [row] = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const from = row?.status ?? null

  const legal = from !== null && (ALLOWED[from] ?? []).includes(to)
  const violation = !legal
  if (violation) {
    const desc = `illegal transition ${from ?? '<missing row>'} -> ${to} (actor=${actor}, task=${taskId})`
    if (ENFORCE) throw new TaskTransitionError(desc)
    console.warn(`[task-transitions] ${desc} — applied anyway (log-only mode)`)
  }

  // Record only real changes plus violations; same-status message refreshes
  // stay out of the event log so it reads as a life history, not a heartbeat.
  if (from !== to || violation) {
    await db.insert(taskEvents).values({
      taskId,
      fromStatus: from,
      toStatus: to,
      actor,
      message: message ?? null,
      violation,
    })
  }

  await db
    .update(tasks)
    .set({
      status: to,
      ...(message !== undefined ? { statusMessage: message } : {}),
      ...(set ?? {}),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))

  if (emitStatus) {
    emit('task:status', { taskId, status: to, ...(typeof message === 'string' ? { message } : {}) })
  }
  return { from, to, violation }
}

/** Log the birth event for rows created via db.insert(tasks) — the insert
 *  itself stays where it is (dispatchTask, watch route); this only records it. */
export async function recordTaskCreated(taskId: string, initialStatus: string, actor: TaskActor): Promise<void> {
  await db.insert(taskEvents).values({
    taskId,
    fromStatus: null,
    toStatus: initialStatus,
    actor,
    violation: false,
  })
}
