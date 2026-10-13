import { NextResponse } from 'next/server'
import { fetchGitHubContext } from '@/lib/context-fetchers'
import { setupIncompleteResponse } from '@/lib/setup'

export async function GET() {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const data = await fetchGitHubContext()
  return NextResponse.json(data)
}
