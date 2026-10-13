import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { tasks } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { agentTokenValid, readAgentToken } from '@/lib/agent-auth'
import { setupIncompleteResponse } from '@/lib/setup'

// POST /api/tasks/:taskId/session — v2 supervisor registers its Claude session id
// as soon as the SDK init message arrives, so a later suspend can be resumed.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { taskId } = await params
  const { session_id } = await req.json() as { session_id?: string }
  if (!session_id) {
    return NextResponse.json({ error: 'session_id is required' }, { status: 400 })
  }
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  if (!agentTokenValid(task.agentToken, readAgentToken(req))) {
    return NextResponse.json({ error: 'Invalid agent token' }, { status: 403 })
  }
  await db.update(tasks)
    .set({ resumeSessionId: session_id, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
  return NextResponse.json({ ok: true })
}
