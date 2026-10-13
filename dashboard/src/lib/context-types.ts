import type { PullRequest, CategorisedPRs } from './github'
import type { LinearTicket } from './linear-data'
import type { LinearData } from './context-fetchers'

// Per-source loading state for progressive rendering
export type SourceStatus = 'idle' | 'loading' | 'success' | 'error' | 'disabled'

export interface SourceState<T> {
  data: T | null
  status: SourceStatus
  error: string | null
}

// Granular endpoint response types
export type GitHubResponse = CategorisedPRs
export type LinearResponse = LinearData

export interface HousekeepingItem {
  type: 'stale_status' | 'stale_document'
  description: string
  ticketId?: string
  ticketTitle?: string
  prNumber?: number
}

// Aggregated dashboard context shared across UI, briefing, and manual-steps consumers.
// The briefing route sends a slim projection (see buildBriefingView in briefing-editorial.ts).
export interface ContextData {
  myPRs: PullRequest[]
  recentlyMerged: PullRequest[]
  reviewRequests: PullRequest[]
  tickets: LinearTicket[]
  unassignedTickets: LinearTicket[]
  completedTickets: LinearTicket[]
  housekeeping: HousekeepingItem[]
  fetchedAt: number
}
