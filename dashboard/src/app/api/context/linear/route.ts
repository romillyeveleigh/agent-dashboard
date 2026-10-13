import { NextResponse } from 'next/server'
import { fetchLinearContext } from '@/lib/context-fetchers'
import { setupIncompleteResponse } from '@/lib/setup'

export async function GET() {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const data = await fetchLinearContext()
  return NextResponse.json(data)
}
