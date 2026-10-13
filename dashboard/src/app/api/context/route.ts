import { NextRequest, NextResponse } from 'next/server'
import { buildContextData } from '@/lib/build-context'
import { refreshContextCaches, revalidateContextCaches } from '@/lib/context-fetchers'
import { setupIncompleteResponse } from '@/lib/setup'

// GET /api/context — returns categorised PRs and tickets from cache.
// ?revalidate=1 also refreshes the sources in the background (page load);
// a context:updated SSE event follows if anything changed.
export async function GET(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  if (req.nextUrl.searchParams.get('revalidate')) revalidateContextCaches('page-load')
  const data = await buildContextData()
  return NextResponse.json(data)
}

// POST /api/context — re-fetch all sources, resolving once caches are fresh
export async function POST() {
  const guard = setupIncompleteResponse(); if (guard) return guard
  await refreshContextCaches('manual')
  return NextResponse.json({ ok: true })
}
