'use client'

import { useEffect, useState } from 'react'
import type { DashboardData } from './dashboard-types'

// The briefing's AI-written card titles, so the drawer names a ticket or PR the
// same way its Home card does. Keyed by ticket id ("ENG-260") or prKey(number).
// Home fills this as the briefing loads; other pages fall back to the cached briefing.
const titles = new Map<string, string>()
let inflight: Promise<void> | null = null

export const prKey = (number: number) => `pr:${number}`

export function rememberEditorialTitles(data: DashboardData) {
  for (const item of data.workItems) {
    titles.set(item.type === 'ticket' ? item.id : prKey(Number(item.id)), item.editorialTitle)
  }
  for (const item of data.reviewRequests) titles.set(prKey(item.number), item.editorialTitle)
}

function loadFromCache(): Promise<void> {
  inflight ??= fetch('/api/dashboard-cache')
    .then(res => (res.ok ? res.json() : null))
    .then((body: { data: DashboardData | null } | null) => { if (body?.data) rememberEditorialTitles(body.data) })
    .catch(() => {})
    .finally(() => { inflight = null })
  return inflight
}

export function useEditorialTitle(key?: string): string | undefined {
  const [title, setTitle] = useState(() => (key ? titles.get(key) : undefined))
  useEffect(() => {
    if (!key) return
    const known = titles.get(key)
    setTitle(known)
    if (known) return
    let cancelled = false
    loadFromCache().then(() => { if (!cancelled) setTitle(titles.get(key)) })
    return () => { cancelled = true }
  }, [key])
  return title
}
