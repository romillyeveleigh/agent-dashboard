'use client'

import type { LinearTicket } from './linear-data'

// The PR drawer's linked ticket comes from /api/tickets/:id, a live Linear call
// (0.1-1.4s). Cache per session, share in-flight requests, and let PR cards
// prefetch on hover so the drawer usually opens with the ticket ready.
const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; promise: Promise<LinearTicket | null>; value?: LinearTicket }>()

export function fetchTicketCached(identifier: string): Promise<LinearTicket | null> {
  const hit = cache.get(identifier)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise
  const entry: { at: number; promise: Promise<LinearTicket | null>; value?: LinearTicket } = {
    at: Date.now(),
    promise: fetch(`/api/tickets/${encodeURIComponent(identifier)}`)
      .then(res => (res.ok ? res.json() as Promise<LinearTicket> : null))
      .catch(() => null)
      .then(ticket => {
        // Don't cache a miss or a failed request
        if (ticket) entry.value = ticket
        else cache.delete(identifier)
        return ticket
      }),
  }
  cache.set(identifier, entry)
  return entry.promise
}

// Synchronous read so an already-fetched ticket renders without a skeleton frame
export function getCachedTicket(identifier: string): LinearTicket | undefined {
  const hit = cache.get(identifier)
  return hit && Date.now() - hit.at < TTL_MS ? hit.value : undefined
}
