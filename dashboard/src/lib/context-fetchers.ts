/**
 * Extracted per-source fetch functions with individual caching.
 * Each function checks its own cache key before making API calls.
 * Integration config is checked first — if disabled, returns fallback immediately.
 */

import { fetchGitHubData, EMPTY_PRS, type CategorisedPRs } from './github'
import {
  fetchLinearData,
  isInactiveLinearStateType,
  type CategorisedTickets,
  type LinearTicket,
  type LinearCycle,
} from './linear-data'
import { getIntegrationConfig } from './integrations'
import { db } from './db'
import { tasks } from './schema'
import { emit } from './events'
import { sql, and, inArray, isNotNull } from 'drizzle-orm'
import { createHash } from 'crypto'

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
// Page-load revalidation is skipped if a refresh finished this recently
const REVALIDATE_MIN_INTERVAL_MS = 30 * 1000

// Shared via globalThis so dev mode's per-route module copies see one set of
// in-flight fetches and one refresh guard.
const shared = globalThis as typeof globalThis & {
  __contextInflight?: Map<string, Promise<unknown>>
  __contextRefresh?: Promise<void> | null
  __contextRefreshedAt?: number
  __contextSignature?: string | null
}
const inflight = (shared.__contextInflight ??= new Map())

// --- Generic cache helpers ---

function getCacheEntry<T>(key: string): { value: T; ageMs: number } | null {
  try {
    const row = db.all<{ value_json: string; fetched_at: number }>(
      sql`SELECT value_json, fetched_at FROM context_cache WHERE key = ${key}`,
    )[0]
    if (!row) return null
    return { value: JSON.parse(row.value_json) as T, ageMs: Date.now() - row.fetched_at * 1000 }
  } catch {
    return null
  }
}

export function setCache<T>(key: string, data: T): void {
  try {
    db.run(
      sql`INSERT OR REPLACE INTO context_cache (key, value_json, fetched_at) VALUES (${key}, ${JSON.stringify(data)}, ${Math.floor(Date.now() / 1000)})`,
    )
  } catch (err) {
    console.error('Cache write error:', err)
  }
}

/**
 * Stale-while-revalidate read. Fresh entries return as-is; stale entries
 * return immediately and kick a background refresh; only a missing entry (or
 * `force`) waits on the network. Concurrent callers share one fetch per key,
 * and a failed fetch falls back to the previous entry rather than emptying it.
 */
async function readThrough<T>(
  key: string,
  fetcher: () => Promise<T>,
  fallback: T,
  label: string,
  force = false,
): Promise<T> {
  const entry = force ? null : getCacheEntry<T>(key)
  if (entry && entry.ageMs <= CACHE_TTL_MS) return entry.value
  if (entry) {
    void refreshContextCaches('stale-read')
    return entry.value
  }

  let pending = inflight.get(key) as Promise<T> | undefined
  if (!pending) {
    pending = fetcher()
      .then(data => { setCache(key, data); return data })
      .finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  try {
    return await pending
  } catch (err) {
    console.error(`${label} fetch error:`, err)
    return getCacheEntry<T>(key)?.value ?? fallback
  }
}

// --- Per-source fetch functions ---

export interface LinearData {
  tickets: CategorisedTickets
  cycles: LinearCycle[]
  allTickets: LinearTicket[]
  unassignedTickets: LinearTicket[]
  completedTickets: LinearTicket[]
  hiddenTicketIds: string[]
  hiddenPrNumbers: number[]
}

const EMPTY_LINEAR: LinearData = {
  tickets: {
    readyToImplement: [],
    needsPlanning: [],
    blocked: [],
    housekeeping: [],
    inProgress: [],
  },
  cycles: [],
  allTickets: [],
  unassignedTickets: [],
  completedTickets: [],
  hiddenTicketIds: [],
  hiddenPrNumbers: [],
}

/**
 * Drop canceled/duplicate tickets that a stale cache entry may still hold.
 * Fetch-time filtering is the main gate; this keeps old cache rows honest
 * until TTL expires or the cache is busted.
 */
export function scrubInactiveLinearTickets(data: LinearData): LinearData {
  const drop = (t: LinearTicket) => isInactiveLinearStateType(t.state?.type)
  const allTickets = data.allTickets.filter(t => !drop(t))
  const unassignedTickets = data.unassignedTickets.filter(t => !drop(t))
  const droppedIds = [
    ...data.allTickets.filter(drop),
    ...data.unassignedTickets.filter(drop),
  ].map(t => t.identifier)
  if (droppedIds.length === 0) return data

  const scrubCat = (tickets: LinearTicket[]) => tickets.filter(t => !drop(t))
  return {
    ...data,
    tickets: {
      readyToImplement: scrubCat(data.tickets.readyToImplement),
      needsPlanning: scrubCat(data.tickets.needsPlanning),
      blocked: scrubCat(data.tickets.blocked),
      housekeeping: scrubCat(data.tickets.housekeeping),
      inProgress: scrubCat(data.tickets.inProgress),
    },
    allTickets,
    unassignedTickets,
    hiddenTicketIds: [...new Set([...(data.hiddenTicketIds ?? []), ...droppedIds])],
  }
}

// Agent PRs aren't always branched with a team-key prefix (e.g. "123-fix-cache"),
// so the branch-name regex can miss a ticket the originating task row already
// knows. Backfill from our own tasks table wherever GitHub linking came back null.
async function backfillLinkedTicketIds(data: CategorisedPRs): Promise<void> {
  const allPrs = Object.values(data).flat()
  const unlinkedNumbers = [...new Set(
    allPrs.filter(pr => !pr.linkedTicketId).map(pr => pr.number)
  )]
  if (unlinkedNumbers.length === 0) return

  const rows = db.select({ prNumber: tasks.prNumber, ticketId: tasks.ticketId })
    .from(tasks)
    .where(and(inArray(tasks.prNumber, unlinkedNumbers), isNotNull(tasks.ticketId)))
    .all()
  if (rows.length === 0) return

  const ticketIdByPrNumber = new Map(rows.map(r => [r.prNumber, r.ticketId]))
  for (const pr of allPrs) {
    if (!pr.linkedTicketId) {
      const ticketId = ticketIdByPrNumber.get(pr.number)
      if (ticketId) pr.linkedTicketId = ticketId
    }
  }
}

interface FetchOptions { force?: boolean }

export async function fetchGitHubContext({ force }: FetchOptions = {}): Promise<CategorisedPRs> {
  const config = getIntegrationConfig()
  if (!config.github.enabled) return EMPTY_PRS

  return readThrough('context:github', async () => {
    const data = await fetchGitHubData()
    await backfillLinkedTicketIds(data)
    return data
  }, EMPTY_PRS, 'GitHub', force)
}

export async function fetchLinearContext({ force }: FetchOptions = {}): Promise<LinearData> {
  const config = getIntegrationConfig()
  if (!config.linear.enabled) return EMPTY_LINEAR

  const data = await readThrough('context:linear', fetchLinearData, EMPTY_LINEAR, 'Linear', force)
  return scrubInactiveLinearTickets(data)
}

// --- Background refresh ---

/**
 * Re-fetch both sources and overwrite their caches (readers keep getting
 * the previous data meanwhile), emitting `context:updated` over SSE only when
 * the fetched data actually changed. Concurrent calls share the in-flight
 * refresh. Never throws.
 */
export function refreshContextCaches(reason: string): Promise<void> {
  if (shared.__contextRefresh) return shared.__contextRefresh
  shared.__contextRefresh = (async () => {
    try {
      const [github, linear] = await Promise.all([
        fetchGitHubContext({ force: true }),
        fetchLinearContext({ force: true }),
      ])
      shared.__contextRefreshedAt = Date.now()
      const signature = createHash('sha256')
        .update(JSON.stringify([github, linear]))
        .digest('hex')
      if (signature !== shared.__contextSignature) {
        shared.__contextSignature = signature
        emit('context:updated', { reason })
      }
    } catch (err) {
      console.error(`[context-refresh] ${reason} failed:`, err)
    } finally {
      shared.__contextRefresh = null
    }
  })()
  return shared.__contextRefresh
}

/** Background refresh unless one finished in the last 30s. */
export function revalidateContextCaches(reason: string): void {
  if (Date.now() - (shared.__contextRefreshedAt ?? 0) < REVALIDATE_MIN_INTERVAL_MS) return
  void refreshContextCaches(reason)
}
