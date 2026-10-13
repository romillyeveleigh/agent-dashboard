import { NextResponse } from 'next/server'
import { setupIncompleteResponse } from '@/lib/setup'
import { harvestReviewLessons } from '@/lib/review-lesson-harvester'
import { getReviewLessons } from '@/lib/memory-queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// GET /api/review-lessons — list active review-lesson memories (cheap check
// of what the ship prompt block will contain).
export async function GET() {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const repoUrl = process.env.REPO_URL
  if (!repoUrl) {
    return NextResponse.json({ error: 'REPO_URL is not set' }, { status: 400 })
  }
  const lessons = await getReviewLessons(repoUrl)
  return NextResponse.json({
    count: lessons.length,
    lessons: lessons.map(m => ({ id: m.id, content: m.content, createdAt: m.createdAt })),
  })
}

// POST /api/review-lessons — run the harvester (re-runnable; idempotent via
// skip-action + exact-content dedup). Trigger manually:
//   curl -X POST http://localhost:3000/api/review-lessons
export async function POST() {
  const guard = setupIncompleteResponse(); if (guard) return guard
  try {
    const result = await harvestReviewLessons()
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[review-lessons] harvest failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
