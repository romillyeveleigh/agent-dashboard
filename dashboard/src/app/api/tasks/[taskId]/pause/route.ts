import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { tasks } from '@/lib/schema'
import { emit } from '@/lib/events'
import { eq } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'

// POST /api/tasks/:taskId/pause — toggle pause on auto-react for a ship task.
// Body: { pause: boolean } — true pauses, false resumes.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { taskId } = await params
  const { pause } = (await req.json()) as { pause: boolean }

  const existing = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!existing.length) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  const pausedAt = pause ? new Date() : null
  await db
    .update(tasks)
    .set({ pausedAt, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  emit('task:status', { taskId, status: existing[0].status, paused: pause })

  return NextResponse.json({ ok: true, pausedAt })
}
