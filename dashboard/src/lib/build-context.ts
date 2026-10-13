import { fetchPRsByNumber, type CategorisedPRs, type PullRequest } from '@/lib/github'
import { isInactiveLinearStateType, type CategorisedTickets, type LinearTicket } from '@/lib/linear-data'
import type { ContextData, HousekeepingItem } from '@/lib/context-types'
import { fetchGitHubContext, fetchLinearContext } from '@/lib/context-fetchers'

// Linked PRs outside every search window, fetched by number. Cached in memory
// (stale-while-revalidate, like the per-source caches) so a context read
// doesn't pay a live GitHub round-trip each time.
const BACKFILL_TTL_MS = 5 * 60 * 1000
const shared = globalThis as typeof globalThis & {
  __prBackfill?: Map<number, { pr: PullRequest | null; at: number }>
  __prBackfillPending?: Map<number, Promise<void>>
}
const backfillCache = (shared.__prBackfill ??= new Map())
const backfillPending = (shared.__prBackfillPending ??= new Map())

// Resolves once every number has been fetched, joining fetches already in flight
async function refetchBackfill(prNumbers: number[]): Promise<void> {
  const todo = prNumbers.filter(n => !backfillPending.has(n))
  if (todo.length) {
    const fetching = (async () => {
      const prs = await fetchPRsByNumber(todo)
      // Empty means the request failed (or none exist) — don't cache a miss
      if (prs.length === 0) return
      const byNumber = new Map(prs.map(pr => [pr.number, pr]))
      for (const n of todo) backfillCache.set(n, { pr: byNumber.get(n) ?? null, at: Date.now() })
    })().finally(() => todo.forEach(n => backfillPending.delete(n)))
    todo.forEach(n => backfillPending.set(n, fetching))
  }
  await Promise.all(prNumbers.map(n => backfillPending.get(n)))
}

async function backfillPRs(prNumbers: number[]): Promise<PullRequest[]> {
  const now = Date.now()
  const unseen = prNumbers.filter(n => !backfillCache.has(n))
  const stale = prNumbers.filter(n => {
    const entry = backfillCache.get(n)
    return entry && now - entry.at > BACKFILL_TTL_MS
  })
  if (unseen.length) await refetchBackfill(unseen)
  if (stale.length) void refetchBackfill(stale).catch(() => {})
  return prNumbers.flatMap(n => {
    const pr = backfillCache.get(n)?.pr
    return pr ? [{ ...pr }] : []
  })
}

function crossReferenceData(
  prs: CategorisedPRs,
  tickets: CategorisedTickets,
  allTickets: LinearTicket[],
): { tickets: CategorisedTickets; allTickets: LinearTicket[]; housekeeping: HousekeepingItem[] } {
  // Open PRs (for stale document detection)
  const allOpenPRs: PullRequest[] = [
    ...prs.changesRequested,
    ...prs.draft,
    ...prs.approved,
    ...prs.commentsToAddress,
    ...prs.pending,
  ]

  // All PRs including merged/closed (for ticket linking)
  const allPRs: PullRequest[] = [
    ...allOpenPRs,
    ...prs.reviewRequested,
    ...prs.recentlyMerged,
    ...prs.recentlyClosed,
  ]

  const prsByTicketId = new Map<string, number[]>()
  for (const pr of allPRs) {
    if (pr.linkedTicketId) {
      const existing = prsByTicketId.get(pr.linkedTicketId) || []
      existing.push(pr.number)
      prsByTicketId.set(pr.linkedTicketId, existing)
    }
  }

  // Enrich tickets with reverse PR links (merge both sources)
  const enrichedTickets = allTickets.map((t) => {
    const branchPrs = prsByTicketId.get(t.identifier) || []
    const merged = [...new Set([...t.linkedPrNumbers, ...branchPrs])]
    return { ...t, linkedPrNumbers: merged }
  })

  // Detect housekeeping items: merged/closed PR but ticket not Done
  const mergedTicketIds = new Set<string>()
  for (const pr of prs.recentlyMerged) {
    if (pr.linkedTicketId) mergedTicketIds.add(pr.linkedTicketId)
  }
  for (const pr of prs.recentlyClosed) {
    if (pr.linkedTicketId) mergedTicketIds.add(pr.linkedTicketId)
  }

  // Build housekeeping items
  const housekeeping: HousekeepingItem[] = []

  // 1. Stale ticket statuses — PR merged/closed but ticket not Done
  for (const ticket of enrichedTickets) {
    if (
      mergedTicketIds.has(ticket.identifier) &&
      !isInactiveLinearStateType(ticket.state.type)
    ) {
      const mergedPr = [...prs.recentlyMerged, ...prs.recentlyClosed].find(
        (p) => p.linkedTicketId === ticket.identifier,
      )
      housekeeping.push({
        type: 'stale_status',
        description: `PR #${mergedPr?.number || '?'} ${mergedPr?.displayStatus === 'Merged' ? 'merged' : 'closed'} but ticket still "${ticket.state.name}"`,
        ticketId: ticket.identifier,
        ticketTitle: ticket.title,
        prNumber: mergedPr?.number,
      })
    }
  }

  // 2. Stale work documents — document shows stale progress vs actual PR state
  for (const ticket of enrichedTickets) {
    if (!ticket.workDocParsed) continue
    const linkedPr = allOpenPRs.find((p) => p.linkedTicketId === ticket.identifier)
    if (linkedPr && ticket.workDocParsed.progressContent) {
      const progress = ticket.workDocParsed.progressContent.toLowerCase()
      // Document says "Planning" or "Not started" but PR exists
      if ((progress.includes('planning') || progress.includes('not started')) && linkedPr) {
        housekeeping.push({
          type: 'stale_document',
          description: `Work doc says "${ticket.workDocParsed.progressContent}" but PR #${linkedPr.number} exists`,
          ticketId: ticket.identifier,
          ticketTitle: ticket.title,
          prNumber: linkedPr.number,
        })
      }
    }
  }

  return {
    tickets: {
      ...tickets,
      housekeeping: enrichedTickets.filter(
        (t) =>
          mergedTicketIds.has(t.identifier) &&
          !isInactiveLinearStateType(t.state.type),
      ),
    },
    allTickets: enrichedTickets,
    housekeeping,
  }
}

export async function buildContextData(): Promise<ContextData> {
  // Fetch both data sources in parallel — each checks its own cache
  const [prs, linearData] = await Promise.all([
    fetchGitHubContext(),
    fetchLinearContext(),
  ])

  // Cross-reference all data sources
  const { allTickets, housekeeping } = crossReferenceData(
    prs,
    linearData.tickets,
    linearData.allTickets,
  )

  // Collect all ticket-linked PR numbers so we can include them in the output
  const linkedPrNumbers = new Set(allTickets.flatMap(t => t.linkedPrNumbers))
  const hiddenTicketIds = new Set(linearData.hiddenTicketIds ?? [])
  const hiddenPrNumbers = new Set(linearData.hiddenPrNumbers ?? [])
  const isHiddenPr = (pr: PullRequest) =>
    hiddenPrNumbers.has(pr.number) ||
    (pr.linkedTicketId != null && hiddenTicketIds.has(pr.linkedTicketId))

  // Flatten my PRs: open PRs + closed/merged PRs that are linked to tickets.
  // Drop PRs belonging to paused tickets so they don't resurface as orphans.
  const openPRs: PullRequest[] = [
    ...prs.changesRequested,
    ...prs.draft,
    ...prs.approved,
    ...prs.commentsToAddress,
    ...prs.pending,
  ].filter(pr => !isHiddenPr(pr))
  const linkedClosedPRs = [
    ...prs.recentlyMerged,
    ...prs.recentlyClosed,
  ].filter(pr => linkedPrNumbers.has(pr.number) && !isHiddenPr(pr))

  const myPRs: PullRequest[] = [...openPRs, ...linkedClosedPRs]

  // Backfill: fetch any linked PRs not in our search results at all
  // (e.g. outside the 30-day window, or truncated by first:N limits)
  const knownPrNumbers = new Set([
    ...myPRs, ...prs.recentlyMerged, ...prs.recentlyClosed, ...prs.reviewRequested,
  ].map(p => p.number))
  const missingPrNumbers = [...new Set(
    [...linkedPrNumbers].filter(n => !knownPrNumbers.has(n))
  )]
  if (missingPrNumbers.length > 0) {
    const backfilled = await backfillPRs(missingPrNumbers)
    myPRs.push(...backfilled)
  }

  return {
    myPRs,
    recentlyMerged: prs.recentlyMerged,
    reviewRequests: prs.reviewRequested,
    tickets: allTickets,
    unassignedTickets: linearData.unassignedTickets,
    completedTickets: linearData.completedTickets,
    housekeeping,
    fetchedAt: Date.now(),
  }
}
