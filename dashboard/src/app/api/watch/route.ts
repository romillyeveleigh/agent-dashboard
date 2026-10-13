import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuid } from 'uuid'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { tasks } from '@/lib/schema'
import { emit } from '@/lib/events'
import { parseTaskTags } from '@/lib/parse-tags'
import { ACTIVE_STATUSES, REACTION_TAGS, SHIP_TAG, WATCH_TAG } from '@/lib/constants'
import { setupIncompleteResponse } from '@/lib/setup'
import { transition, recordTaskCreated } from '@/lib/task-transitions'

// POST /api/watch — create a container-less reaction target for an existing PR.
// Lets a human bind any PR (including ones they didn't open via "Ship it") to
// the Phase 2 reactive dispatch pipeline. Dedups against existing active
// ship/watch tasks for the same PR.
export async function POST(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const body = await req.json().catch(() => null)
  const prNumber = body?.prNumber
  if (typeof prNumber !== 'number' || !Number.isFinite(prNumber)) {
    return NextResponse.json({ error: 'prNumber (number) is required' }, { status: 400 })
  }

  const existing = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.prNumber, prNumber), inArray(tasks.status, ACTIVE_STATUSES)))
  const alreadyWatching = existing.find(t =>
    parseTaskTags(t.tags).some(tag => REACTION_TAGS.includes(tag)),
  )
  if (alreadyWatching) {
    return NextResponse.json(
      { id: alreadyWatching.id, alreadyWatching: true },
      { status: 200 },
    )
  }

  const id = uuid()
  await db.insert(tasks).values({
    id,
    prompt: `Watching PR #${prNumber} for external events (CI, review comments).`,
    tags: JSON.stringify([WATCH_TAG]),
    prNumber,
    status: 'watching',
    dispatchedBy: 'human',
  })
  await recordTaskCreated(id, 'watching', 'human')

  emit('task:created', { id, tags: [WATCH_TAG], prNumber, status: 'watching' })

  return NextResponse.json({ id }, { status: 201 })
}

// DELETE /api/watch?prNumber=N — cancel the active watcher for a PR.
// Only acts on `watch`-tagged tasks. Ship tasks are left alone — users must
// stop shipping via the ship task's own controls, not via this endpoint.
export async function DELETE(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const prNumberRaw = req.nextUrl.searchParams.get('prNumber')
  const prNumber = prNumberRaw ? Number(prNumberRaw) : NaN
  if (!Number.isFinite(prNumber)) {
    return NextResponse.json({ error: 'prNumber query param is required' }, { status: 400 })
  }

  const active = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.prNumber, prNumber), inArray(tasks.status, ACTIVE_STATUSES)))
  const watcher = active.find(t => {
    const tags = parseTaskTags(t.tags)
    return tags.includes(WATCH_TAG) && !tags.includes(SHIP_TAG)
  })
  if (!watcher) {
    return NextResponse.json({ error: `no watcher found for PR #${prNumber}` }, { status: 404 })
  }

  await transition(watcher.id, 'cancelled', { actor: 'human', message: 'Unwatched' })

  return NextResponse.json({ id: watcher.id, status: 'cancelled' })
}
