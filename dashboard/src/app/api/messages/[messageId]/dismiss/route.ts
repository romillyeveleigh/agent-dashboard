import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { messages, tasks } from '@/lib/schema'
import { emit } from '@/lib/events'
import { eq, and } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'
import { transition } from '@/lib/task-transitions'

// POST /api/messages/:messageId/dismiss — mark an unanswered agent question as
// resolved without sending a reply. Used when the agent has already moved on
// and the question is stale (e.g. reply tool timed out).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { messageId } = await params

  const [msg] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)

  if (!msg) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  }
  if (msg.direction !== 'agent_to_human') {
    return NextResponse.json(
      { error: 'Only agent-to-human messages can be dismissed' },
      { status: 400 },
    )
  }
  if (msg.answered) {
    return NextResponse.json({ ok: true, alreadyAnswered: true })
  }

  await db
    .update(messages)
    .set({ answered: true })
    .where(eq(messages.id, messageId))

  // If the task is still waiting and no other unanswered messages remain,
  // transition it to complete so the dashboard indicator clears.
  const [stillPending] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.taskId, msg.taskId),
        eq(messages.direction, 'agent_to_human'),
        eq(messages.answered, false),
      ),
    )
    .limit(1)

  let newStatus: string | null = null
  if (!stillPending) {
    const [task] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, msg.taskId))
      .limit(1)
    if (task?.status === 'waiting_for_feedback') {
      await transition(msg.taskId, 'complete', { actor: 'human', message: 'Question dismissed' })
      newStatus = 'complete'
    }
  }

  emit('message:dismiss', { id: messageId, taskId: msg.taskId })

  return NextResponse.json({ ok: true, taskStatus: newStatus })
}
