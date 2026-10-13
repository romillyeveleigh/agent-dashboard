import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { messages, tasks } from '@/lib/schema'
import { emit } from '@/lib/events'
import { v4 as uuid } from 'uuid'
import { eq, and, desc } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'
import { resumeSuspendedTask } from '@/lib/dispatch-task'
import { getContainerStatus } from '@/lib/docker'
import { transition } from '@/lib/task-transitions'

// POST /api/answers — dashboard UI posts a human answer
export async function POST(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const body = await req.json()
  const { task_id, text } = body as { task_id: string; text: string }

  if (!task_id || !text) {
    return NextResponse.json(
      { error: 'task_id and text are required' },
      { status: 400 },
    )
  }

  // Validate task exists and is waiting for feedback before any writes
  const [task] = await db.select().from(tasks).where(eq(tasks.id, task_id)).limit(1)
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }
  if (task.status !== 'waiting_for_feedback') {
    return NextResponse.json(
      { error: `Task is ${task.status}, not waiting for feedback` },
      { status: 409 },
    )
  }

  // v2 suspend/resume: a suspended task (resume session registered, container
  // exited or already detached) must NOT be flipped to 'running' here — if the
  // resume container failed to start, a running+null-container row is matched
  // by no reaper query and sticks forever while rendering healthy.
  // resumeSuspendedTask owns the status transitions (starting → running)
  // through reaper-visible states instead.
  const isSuspendedResume =
    !!task.resumeSessionId &&
    (!task.containerId || (await getContainerStatus(task.containerId)) !== 'running')

  // All writes in one transaction — no orphan rows or half-applied state
  const answerId = uuid()
  db.transaction((tx) => {
    tx.insert(messages).values({
      id: answerId,
      taskId: task_id,
      direction: 'human_to_agent',
      content: text,
      type: 'answer',
    }).run()

    // Mark the most recent unanswered question as answered
    const unanswered = tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.taskId, task_id),
          eq(messages.direction, 'agent_to_human'),
          eq(messages.answered, false),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .all()

    if (unanswered.length) {
      tx.update(messages)
        .set({ answered: true })
        .where(eq(messages.id, unanswered[0].id))
        .run()
    }

    // Suspended tasks stay waiting_for_feedback here — resumeSuspendedTask
    // owns their status transitions (starting → running, or reaper-visible
    // failure). Everything else transitions to 'running' below, outside the
    // sync transaction (transition() is async and can't run inside
    // better-sqlite3's sync transaction).
  })

  // Emit only after transaction commits successfully
  emit('message:answer', { id: answerId, taskId: task_id })

  if (isSuspendedResume) {
    // v2 suspend/resume: the task's container suspended waiting for this
    // answer — start a resume container. Fire-and-forget — the emits must
    // not wait on Docker; failures surface via reapStuckStartingTasks.
    resumeSuspendedTask(task_id, text).catch(err => {
      console.error(`[answers] resume failed for task ${task_id}:`, err)
    })
  } else {
    // Accepted semantic change: a crash between the transaction above and
    // this transition leaves an answered question with the task still
    // 'waiting_for_feedback' — recoverable by re-answering, and strictly
    // better than the pre-existing reverse window (status flipped inside
    // the transaction before the answer was durably recorded).
    await transition(task_id, 'running', { actor: 'human', message: 'Resumed after feedback' })
  }

  return NextResponse.json({ id: answerId }, { status: 201 })
}
