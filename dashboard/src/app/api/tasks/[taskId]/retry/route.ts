import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { tasks } from '@/lib/schema'
import { replaceTaskContainerLocked } from '@/lib/dispatch-task'
import { transition } from '@/lib/task-transitions'
import { withTaskLock } from '@/lib/task-locks'
import { eq } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'

// POST /api/tasks/:taskId/retry — retry a failed task from its saved launch config
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { taskId } = await params

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }
  if (task.status !== 'failed') {
    return NextResponse.json({ error: 'Only failed tasks can be retried' }, { status: 409 })
  }
  if (!task.launchConfigJson) {
    return NextResponse.json({ error: 'No launch config saved for this task' }, { status: 400 })
  }

  if (!process.env.DASHBOARD_URL) {
    return NextResponse.json({ error: 'DASHBOARD_URL not set' }, { status: 500 })
  }

  try {
    // Status flip and container swap share one lock hold: the reconciler takes
    // the same lock before condemning a task, so it can't see the intermediate
    // 'starting' + dead-container state and fail the retry out from under us.
    const containerId = await withTaskLock(taskId, async () => {
      await transition(taskId, 'starting', {
        actor: 'human',
        message: `Manual retry (attempt ${task.retryCount + 2})`,
        set: { retryCount: task.retryCount + 1 },
      })
      // Stops any container still recorded for this task before starting the
      // replacement, so retries never orphan a container.
      return replaceTaskContainerLocked(taskId)
    })

    return NextResponse.json({ taskId, containerId }, { status: 200 })
  } catch (err) {
    await transition(taskId, 'failed', {
      actor: 'human',
      message: `Retry failed: ${err instanceof Error ? err.message : String(err)}`,
      emitStatus: false,
    })

    return NextResponse.json({ error: 'Retry failed' }, { status: 500 })
  }
}
