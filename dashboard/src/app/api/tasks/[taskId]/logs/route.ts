import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logs, tasks } from '@/lib/schema'
import { emit } from '@/lib/events'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'
import { agentTokenValid, readAgentToken } from '@/lib/agent-auth'

// GET /api/tasks/:taskId/logs — latest 200 logs for a task, or with
// ?after=<id> only the entries newer than that id (live-tail appends)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { taskId } = await params

  const after = Number(req.nextUrl.searchParams.get('after'))
  if (Number.isInteger(after) && after > 0) {
    const newer = await db
      .select()
      .from(logs)
      .where(and(eq(logs.taskId, taskId), gt(logs.id, after)))
      .orderBy(asc(logs.id))
      .limit(200)
    return NextResponse.json(newer)
  }

  const rows = await db
    .select()
    .from(logs)
    .where(eq(logs.taskId, taskId))
    .orderBy(desc(logs.id))
    .limit(200)

  return NextResponse.json(rows.reverse())
}

// POST /api/tasks/:taskId/logs — append log entries (called by the supervisor's log forwarding in container)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { taskId } = await params

  // Validate agent token before processing log entries
  const [task] = await db
    .select({ agentToken: tasks.agentToken })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!agentTokenValid(task?.agentToken ?? null, readAgentToken(req))) {
    return NextResponse.json({ error: 'invalid agent token' }, { status: 401 })
  }

  const body = await req.json()
  const entries = Array.isArray(body) ? body : [body]

  const values = entries
    .filter((e: { type?: string; content?: string }) => e.type && e.content)
    .map((e: { type: string; content: string }) => ({ taskId, type: e.type, content: e.content }))

  if (values.length) {
    await db.insert(logs).values(values)
  }

  emit('log:new', { taskId })

  return NextResponse.json({ ok: true }, { status: 201 })
}
