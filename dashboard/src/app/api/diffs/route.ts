import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { diffs, tasks } from '@/lib/schema'
import { emit } from '@/lib/events'
import { parsePrNumberFromUrl } from '@/lib/integrations'
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'
import { agentTokenValid, readAgentToken } from '@/lib/agent-auth'

// POST /api/diffs — agent posts completed diff
export async function POST(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const body = await req.json()
  const { task_id, patch, summary, pr_url } = body as {
    task_id: string
    patch: string
    summary: string
    pr_url?: string
  }

  if (!task_id || !patch || !summary) {
    return NextResponse.json(
      { error: 'task_id, patch, and summary are required' },
      { status: 400 },
    )
  }

  const diffId = uuid()

  const [prior] = await db
    .select({ agentToken: tasks.agentToken })
    .from(tasks)
    .where(eq(tasks.id, task_id))
    .limit(1)

  if (!prior) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }
  if (!agentTokenValid(prior.agentToken, readAgentToken(req))) {
    return NextResponse.json({ error: 'invalid agent token' }, { status: 401 })
  }

  await db.insert(diffs).values({
    id: diffId,
    taskId: task_id,
    patch,
    summary,
    prUrl: pr_url || null,
  })

  if (pr_url) {
    const prNumber = parsePrNumberFromUrl(pr_url)
    if (!prNumber) {
      console.warn(`[diffs] Could not parse PR number from pr_url: ${pr_url}`)
    }
    await db
      .update(tasks)
      .set({
        prUrl: pr_url,
        ...(prNumber ? { prNumber } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task_id))
  }

  emit('diff:new', { id: diffId, taskId: task_id, summary, prUrl: pr_url })

  return NextResponse.json({ id: diffId }, { status: 201 })
}
