import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { memories, tasks } from '@/lib/schema'
import { getActiveMemories, isForbiddenMemoryContent } from '@/lib/memory-queries'
import { v4 as uuid } from 'uuid'
import { eq, and } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'

// GET /api/memories?repo_url=<url> — list active memories for a repo
export async function GET(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const repoUrl = req.nextUrl.searchParams.get('repo_url')
  if (!repoUrl) {
    return NextResponse.json(
      { error: 'repo_url query parameter is required' },
      { status: 400 },
    )
  }

  const rows = await getActiveMemories(repoUrl)
  return NextResponse.json(rows)
}

// POST /api/memories — create a memory (with dedup)
export async function POST(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const body = await req.json()
  const { repo_url, category, content, source } = body as {
    repo_url: string
    category?: string
    content: string
    source?: string
  }

  if (!repo_url || !content) {
    return NextResponse.json(
      { error: 'repo_url and content are required' },
      { status: 400 },
    )
  }

  if (content.length > 500) {
    return NextResponse.json(
      { error: 'content must be 500 characters or fewer' },
      { status: 400 },
    )
  }

  if (isForbiddenMemoryContent(content)) {
    return NextResponse.json(
      { error: 'memory rejected: it instructs posting reviews/comments/approvals to GitHub. Posting to a PR is governed by the task skill and always requires explicit human approval in-session — do not store workflow memories about it.' },
      { status: 400 },
    )
  }

  // Dedup: check for exact match on repo_url + content
  const existing = await db
    .select()
    .from(memories)
    .where(and(eq(memories.repoUrl, repo_url), eq(memories.content, content)))
    .limit(1)

  if (existing.length > 0) {
    await db
      .update(memories)
      .set({ updatedAt: new Date() })
      .where(eq(memories.id, existing[0].id))
    return NextResponse.json(existing[0], { status: 200 })
  }

  // Memory hygiene (manual save_memory path): mirror the learning-extractor
  // merge-gate. A memory saved by a task with an unmerged PR is an unverified
  // claim that must NOT become recallable "repo knowledge" and prime future
  // runs. Store it inactive.
  // (The auto-extractor already captures verified learnings on merge, so these
  // quarantined manual saves don't need re-activation.)
  let active = true
  if (source) {
    const [task] = await db
      .select({ shippedAt: tasks.shippedAt, prUrl: tasks.prUrl })
      .from(tasks)
      .where(eq(tasks.id, source))
      .limit(1)
    if (task && !task.shippedAt && task.prUrl) {
      active = false
    }
  }

  const id = uuid()
  await db.insert(memories).values({
    id,
    repoUrl: repo_url,
    category: category || null,
    content,
    source: source || null,
    active,
  })

  const [created] = await db
    .select()
    .from(memories)
    .where(eq(memories.id, id))

  return NextResponse.json(created, { status: 201 })
}

// DELETE /api/memories?id=<memoryId> — hard delete a memory
export async function DELETE(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json(
      { error: 'id query parameter is required' },
      { status: 400 },
    )
  }

  await db.delete(memories).where(eq(memories.id, id))
  return NextResponse.json({ ok: true })
}
