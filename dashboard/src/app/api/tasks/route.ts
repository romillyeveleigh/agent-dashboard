import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { tasks } from '@/lib/schema'
import { dispatchTask } from '@/lib/dispatch-task'
import { desc, getTableColumns, sql } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'

// List view omits launchConfigJson (a second full copy of the prompt) and
// agentToken, and trims prompt — the full rows made this response ~6MB.
const { launchConfigJson: _lc, agentToken: _tok, ...listColumns } = getTableColumns(tasks)

// GET /api/tasks — pure DB read (reconciliation handled by background reconciler)
export async function GET(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const limitParam = Number(req.nextUrl.searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 300
  const allTasks = await db
    .select({ ...listColumns, prompt: sql<string>`substr(${tasks.prompt}, 1, 200)` })
    .from(tasks).orderBy(desc(tasks.createdAt)).limit(limit)
  return NextResponse.json(allTasks)
}

// POST /api/tasks — create a new task and start a container
export async function POST(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const body = await req.json()
  const { prompt, tags, context } = body as {
    prompt: string
    tags?: string[]
    context?: { ticketId?: string; prNumber?: number }
  }

  if (!prompt) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
  }
  if (!process.env.DASHBOARD_URL) {
    return NextResponse.json(
      { error: 'DASHBOARD_URL environment variable is not set' },
      { status: 500 },
    )
  }

  try {
    const result = await dispatchTask({
      prompt,
      tags,
      context,
      dispatchedBy: 'human',
    })
    if ('skipped' in result) {
      return NextResponse.json({ error: result.reason }, { status: 409 })
    }
    return NextResponse.json({ id: result.id, containerId: result.containerId }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tasks] dispatch failed:', msg)
    // Detect missing Docker image — the most common infra failure
    if (msg.includes('No such image') || msg.includes('no such container')) {
      return NextResponse.json(
        {
          error: `Docker image not found. Build or pull the agent-worker image first. Visit /setup for guidance.`,
        },
        { status: 500 },
      )
    }
    return NextResponse.json({ error: 'Failed to start container' }, { status: 500 })
  }
}
