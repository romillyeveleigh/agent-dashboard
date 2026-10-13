import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { tasks, logs } from '@/lib/schema'
import { stopContainer } from '@/lib/docker'
import { transition } from '@/lib/task-transitions'
import { eq, getTableColumns } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'

// The browser never needs the agent's bearer token
const { agentToken: _agentToken, ...taskColumns } = getTableColumns(tasks)

// GET /api/tasks/:taskId — get single task
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { taskId } = await params
  const task = await db.select(taskColumns).from(tasks).where(eq(tasks.id, taskId)).limit(1)

  if (!task.length) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  return NextResponse.json(task[0])
}

// DELETE /api/tasks/:taskId — cancel a task (stops the container)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { taskId } = await params
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)

  if (!task.length) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  let stopError: string | null = null
  if (task[0].containerId) {
    try {
      await stopContainer(task[0].containerId)
    } catch (err) {
      stopError = err instanceof Error ? err.message : String(err)
      console.error(`Cancel: failed to stop container for task ${taskId}:`, err)
      await db.insert(logs).values({
        taskId,
        type: 'error',
        content: `Cancel requested but container stop failed — container ${task[0].containerId} may still be running. ${stopError}`,
      })
    }
  }

  await transition(taskId, 'cancelled', {
    actor: 'human',
    message: stopError ? `Cancelled (container stop failed: ${stopError.slice(0, 150)})` : null,
  })

  return NextResponse.json({ ok: true })
}
