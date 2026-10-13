import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { messages, tasks } from '@/lib/schema'
import { emit } from '@/lib/events'
import { transition } from '@/lib/task-transitions'
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'
import { agentTokenValid, readAgentToken } from '@/lib/agent-auth'

// POST /api/questions — agent posts a message from inside the container.
// expects_answer: true (default) is the blocking `reply` path — the message is a
// pending question and the task goes to waiting_for_feedback. expects_answer:
// false is the fire-and-forget `say` path — the message appears in the thread
// but is answered from birth, so nothing anywhere treats it as pending.
export async function POST(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const body = await req.json()
  const { task_id, text, type, expects_answer = true } = body as {
    task_id: string
    text: string
    type?: string
    expects_answer?: boolean
  }

  if (!task_id || !text) {
    return NextResponse.json(
      { error: 'task_id and text are required' },
      { status: 400 },
    )
  }

  // Look up the task row to validate the agent token. Also gives us an early
  // 404 for unknown task IDs (previously an unknown task_id would fail later on
  // the FK constraint — the explicit 404 is an improvement).
  const [task] = await db
    .select({ agentToken: tasks.agentToken })
    .from(tasks)
    .where(eq(tasks.id, task_id))
    .limit(1)
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }
  if (!agentTokenValid(task.agentToken, readAgentToken(req))) {
    return NextResponse.json({ error: 'invalid agent token' }, { status: 401 })
  }

  const messageId = uuid()

  // Non-blocking notes carry no badge type (null renders as a plain agent
  // message in the thread, same as recovered replies).
  const messageType = type ?? (expects_answer ? 'question' : null)

  await db.insert(messages).values({
    id: messageId,
    taskId: task_id,
    direction: 'agent_to_human',
    content: text,
    type: messageType,
    answered: !expects_answer,
  })

  if (expects_answer) {
    // Update task status to waiting
    await transition(task_id, 'waiting_for_feedback', {
      actor: 'agent',
      message: text.slice(0, 200),
      emitStatus: false,
    })
  }

  emit('message:new', {
    id: messageId,
    taskId: task_id,
    text,
    type: messageType,
    answered: !expects_answer,
  })

  return NextResponse.json({ id: messageId }, { status: 201 })
}
