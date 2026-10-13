import { NextResponse } from 'next/server'
import { resilientFetch } from '@/lib/resilient-fetch'
import { setupIncompleteResponse } from '@/lib/setup'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''

let cached: { name: string | null; login: string | null; fetchedAt: number } | null = null
const CACHE_MS = 5 * 60 * 1000

export async function GET() {
  const guard = setupIncompleteResponse(); if (guard) return guard
  if (!GITHUB_TOKEN) {
    return NextResponse.json({ name: null, login: null })
  }

  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return NextResponse.json({ name: cached.name, login: cached.login })
  }

  try {
    const res = await resilientFetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
      },
      body: JSON.stringify({ query: '{ viewer { name login } }' }),
    })
    if (!res.ok) {
      return NextResponse.json({ name: null, login: null })
    }
    const json = await res.json()
    const viewer = json?.data?.viewer
    const name = viewer?.name ?? null
    const login = viewer?.login ?? null
    cached = { name, login, fetchedAt: Date.now() }
    return NextResponse.json({ name, login })
  } catch {
    return NextResponse.json({ name: null, login: null })
  }
}
