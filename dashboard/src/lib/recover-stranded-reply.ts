import { db } from './db'
import { messages, logs } from './schema'
import { emit } from './events'
import { v4 as uuid } from 'uuid'
import { eq, and, gt, asc, desc } from 'drizzle-orm'

/**
 * Safety net for the conversation thread.
 *
 * The `reply` tool is the ONLY channel that writes an agent message into the
 * thread. If an agent answers a human's follow-up in its plain assistant output
 * — which only lands in the `logs` table, not `messages` — and then completes,
 * that answer is stranded: the thread shows the human's question with no reply
 * and (because nothing is pending) no input box.
 *
 * Call this before letting a task go terminal. When the last thread turn is a
 * `human_to_agent` message the agent never replied to, pull the assistant-type
 * log lines emitted after it and surface them as an `agent_to_human` message so
 * the human sees the answer. Marked `answered: true` so it does not re-open a
 * "waiting for feedback" state.
 *
 * Returns the recovered message id, or null if there was nothing to recover.
 */
export function recoverStrandedReply(taskId: string): string | null {
  // Most recent thread message for this task.
  const [last] = db
    .select()
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .all()

  // Only act when the human spoke last — i.e. the agent never posted a reply
  // after the human's message. If the agent's last turn was its own message
  // (answered or not), there is nothing stranded.
  if (!last || last.direction !== 'human_to_agent') return null

  // Gather the agent's assistant output produced after the human's message.
  const after = db
    .select()
    .from(logs)
    .where(
      and(
        eq(logs.taskId, taskId),
        eq(logs.type, 'assistant'),
        gt(logs.createdAt, last.createdAt),
      ),
    )
    .orderBy(asc(logs.createdAt))
    .all()

  const recovered = after
    .map((l) => l.content.trim())
    .filter(Boolean)
    .join('\n\n')
  if (!recovered) return null

  const id = uuid()
  db.insert(messages)
    .values({
      id,
      taskId,
      direction: 'agent_to_human',
      content: recovered,
      // No badge type — this reads as a plain agent reply in the thread.
      type: null,
      answered: true,
    })
    .run()

  emit('message:new', { id, taskId, text: recovered, type: null, answered: true })
  return id
}
