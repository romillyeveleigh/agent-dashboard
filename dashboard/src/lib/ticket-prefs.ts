'use client'

import { useCallback, useEffect, useState } from 'react'
import type { LinearTicket } from './linear-data'
import type { WorkItem } from './dashboard-types'

// Pinned tickets + sort choice are per-browser UI preferences, persisted in
// localStorage (same pattern as the theme toggle) — no server round-trip.

export type TicketSort = 'default' | 'priority' | 'status' | 'updated'

export const TICKET_SORT_OPTIONS: { value: TicketSort; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'priority', label: 'Priority' },
  { value: 'status', label: 'Status' },
  { value: 'updated', label: 'Recently updated' },
]

const PINNED_KEY = 'pinned-tickets'
const SORT_KEY = 'ticket-sort'
const HIDE_UNLINKED_KEY = 'hide-unlinked-prs'

export function useTicketPrefs() {
  const [pinned, setPinned] = useState<string[]>([])
  const [sort, setSort] = useState<TicketSort>('default')
  const [hideUnlinked, setHideUnlinked] = useState(false)

  // Loaded after mount — localStorage isn't available during SSR, and reading
  // it in the initial state would cause a hydration mismatch.
  useEffect(() => {
    try {
      const rawPins = localStorage.getItem(PINNED_KEY)
      if (rawPins) {
        const parsed = JSON.parse(rawPins)
        if (Array.isArray(parsed)) setPinned(parsed.filter(p => typeof p === 'string'))
      }
      const rawSort = localStorage.getItem(SORT_KEY)
      if (TICKET_SORT_OPTIONS.some(o => o.value === rawSort)) setSort(rawSort as TicketSort)
      if (localStorage.getItem(HIDE_UNLINKED_KEY) === 'true') setHideUnlinked(true)
    } catch {
      // corrupted storage — fall back to defaults
    }
  }, [])

  const togglePin = useCallback((id: string) => {
    setPinned(prev => {
      const next = prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
      try { localStorage.setItem(PINNED_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  const changeSort = useCallback((next: TicketSort) => {
    setSort(next)
    try { localStorage.setItem(SORT_KEY, next) } catch {}
  }, [])

  const toggleHideUnlinked = useCallback(() => {
    setHideUnlinked(prev => {
      try { localStorage.setItem(HIDE_UNLINKED_KEY, String(!prev)) } catch {}
      return !prev
    })
  }, [])

  return { pinned, togglePin, sort, changeSort, hideUnlinked, toggleHideUnlinked }
}

// --- Ordering ---

export interface TicketSortKeys {
  id: string
  priorityRank: number // 1=urgent … 4=low, 5=none
  stateRank: number // 0=started, 1=unstarted, 2=other
  updatedAtMs: number // 0 when unknown
}

export function linearTicketSortKeys(t: LinearTicket): TicketSortKeys {
  return {
    id: t.identifier,
    priorityRank: t.priority === 0 ? 5 : t.priority,
    stateRank: t.state.type === 'started' ? 0 : t.state.type === 'unstarted' ? 1 : 2,
    updatedAtMs: t.updatedAt ? Date.parse(t.updatedAt) || 0 : 0,
  }
}

const PRIORITY_LABEL_RANK: Record<string, number> = { Urgent: 1, High: 2, Normal: 3, Low: 4 }

// Enriched work items carry only display labels; join back to the raw ticket
// for exact fields and fall back to label parsing when the join misses.
export function workItemSortKeys(item: WorkItem, ticketsById: Map<string, LinearTicket>): TicketSortKeys {
  const ticket = ticketsById.get(item.id)
  if (ticket) return linearTicketSortKeys(ticket)
  return {
    id: item.id,
    priorityRank: PRIORITY_LABEL_RANK[item.priority ?? ''] ?? 5,
    stateRank: item.state === 'In Progress' ? 0 : item.state === 'Todo' ? 1 : 2,
    updatedAtMs: 0,
  }
}

/**
 * Pinned tickets first, then the selected sort. Ties keep source order
 * (editorial/Linear), so 'default' only floats pins.
 */
export function applyTicketOrder<T>(
  items: T[],
  keysOf: (item: T) => TicketSortKeys,
  pinned: string[],
  sort: TicketSort,
): T[] {
  const pinnedSet = new Set(pinned)
  const decorated = items.map((item, i) => ({ item, i, keys: keysOf(item) }))
  decorated.sort((a, b) => {
    const pa = pinnedSet.has(a.keys.id)
    const pb = pinnedSet.has(b.keys.id)
    if (pa !== pb) return pa ? -1 : 1
    let d = 0
    if (sort === 'priority') d = a.keys.priorityRank - b.keys.priorityRank
    else if (sort === 'status') d = a.keys.stateRank - b.keys.stateRank
    else if (sort === 'updated') d = b.keys.updatedAtMs - a.keys.updatedAtMs
    return d || a.i - b.i
  })
  return decorated.map(d => d.item)
}
