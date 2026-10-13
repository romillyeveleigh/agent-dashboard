/**
 * Linear GraphQL data layer.
 * Fetches tickets, cycles, and work documents directly via the Linear API.
 */

import { resilientFetch } from './resilient-fetch'

const LINEAR_API_KEY = process.env.LINEAR_API_KEY || ''
const LINEAR_URL = 'https://api.linear.app/graphql'
const REPO_URL = process.env.REPO_URL || '' // e.g. "acme/webapp"

// Linear Issue state.type enum — US spelling "canceled", plus dedicated "duplicate".
// These are not active work and must stay out of the dashboard open-ticket views.
export const LINEAR_INACTIVE_STATE_TYPES = ['completed', 'canceled', 'duplicate'] as const

export function isInactiveLinearStateType(type: string | null | undefined): boolean {
  return (LINEAR_INACTIVE_STATE_TYPES as readonly string[]).includes(type ?? '')
}

/** GraphQL `nin` list for open-ticket queries (JSON-stringified values). */
const LINEAR_INACTIVE_STATE_NIN = LINEAR_INACTIVE_STATE_TYPES.map(t => `"${t}"`).join(', ')

export interface WorkDocParsed {
  totalSteps: number
  completedSteps: number
  uncheckedSteps: string[] // text of remaining steps
  hasBlockers: boolean
  blockersContent: string | null
  hasManualSteps: boolean
  manualSteps: Array<{ description: string; checked: boolean }>
  hasReviewNotes: boolean
  reviewNotesContent: string | null
  progressContent: string | null
}

export interface LinearTicket {
  id: string
  identifier: string // e.g. "ENG-123"
  title: string
  description: string | null
  tldr: string | null // first meaningful line, or synthesised
  state: { name: string; type: string } // type: started, unstarted, completed, etc.
  priority: number // 0=none, 1=urgent, 2=high, 3=normal, 4=low
  team: { key: string; name: string }
  assignee: { name: string; email: string } | null
  labels: string[]
  url: string
  cycleName: string | null // name of the current cycle this ticket is in
  hasWorkDocument: boolean
  workDocumentId: string | null
  workDocumentUrl: string | null
  workDocumentContent: string | null
  workDocParsed: WorkDocParsed | null
  linkedPrNumbers: number[]
  branchName: string | null
  hasManualSteps: boolean // keywords detected in description or work doc
  updatedAt: string | null // ISO timestamp from Linear
}

export interface CategorisedTickets {
  readyToImplement: LinearTicket[] // has work doc with plan
  needsPlanning: LinearTicket[] // no work doc or empty plan
  blocked: LinearTicket[]
  housekeeping: LinearTicket[] // status mismatch with PR state
  inProgress: LinearTicket[] // actively being worked on
}

export interface LinearCycle {
  id: string
  name: string | null
  number: number
  startsAt: string
  endsAt: string
  teamId: string
  completedPoints: number
  totalPoints: number
}

async function linearQuery(query: string, variables?: Record<string, unknown>) {
  if (!LINEAR_API_KEY) return null

  const res = await resilientFetch(LINEAR_URL, {
    method: 'POST',
    headers: {
      Authorization: LINEAR_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    console.error('Linear API error:', res.status, await res.text())
    return null
  }

  const json = await res.json()
  return json.data
}

/**
 * Resolve a STALE issue identifier to its Linear UUID via search. Tickets moved
 * between teams are renumbered (e.g. ENG-3828 → OPS-2086) and the exact
 * number+team filter used by the fetchers below then misses the old identifier
 * forever — but Linear's search indexes `previousIdentifiers`. Called only after
 * the exact filter has missed. Accepts a node only on an exact identifier /
 * previousIdentifiers match, guarding against fuzzy text hits. Returns null when
 * Linear is unconfigured, the call fails, or nothing matches exactly.
 */
async function searchIssueIdByIdentifier(identifier: string): Promise<string | null> {
  const wanted = identifier.toUpperCase()
  const data = await linearQuery(`
    query($term: String!) {
      searchIssues(term: $term, first: 5) {
        nodes { id identifier previousIdentifiers }
      }
    }
  `, { term: wanted })

  const nodes: Array<{ id: string; identifier: string; previousIdentifiers?: string[] | null }> =
    data?.searchIssues?.nodes ?? []
  const hit = nodes.find(
    (n) => n.identifier === wanted || (n.previousIdentifiers ?? []).includes(wanted),
  )
  return hit?.id ?? null
}

export async function fetchCurrentUser(): Promise<string | null> {
  const data = await linearQuery(`{ viewer { id } }`)
  return data?.viewer?.id || null
}

export async function fetchTicketsCompletedInWindow(
  userId: string,
  fromIso: string,
  toIso: string,
): Promise<Array<{ identifier: string; title: string; url: string; completedAt: string }>> {
  const data = await linearQuery(
    `query($userId: ID!, $from: DateTimeOrDuration!, $to: DateTimeOrDuration!) {
      issues(
        filter: {
          assignee: { id: { eq: $userId } }
          state: { type: { eq: "completed" } }
          completedAt: { gte: $from, lt: $to }
        }
        first: 100
        orderBy: updatedAt
      ) {
        nodes { identifier title url completedAt }
      }
    }`,
    { userId, from: fromIso, to: toIso },
  )
  return data?.issues?.nodes || []
}

async function fetchTeams(): Promise<Array<{ id: string; key: string; name: string }>> {
  const data = await linearQuery(`{
    teams { nodes { id key name } }
  }`)
  return data?.teams?.nodes || []
}

async function fetchCurrentCycles(
  teamIds: string[],
): Promise<LinearCycle[]> {
  // Fetch active cycles for all teams
  const data = await linearQuery(`{
    cycles(filter: { isActive: { eq: true } }) {
      nodes {
        id name number startsAt endsAt
        progress
        team { id }
      }
    }
  }`)

  return (data?.cycles?.nodes || []).map(
    (c: Record<string, unknown>) => ({
      id: c.id as string,
      name: c.name as string | null,
      number: c.number as number,
      startsAt: c.startsAt as string,
      endsAt: c.endsAt as string,
      teamId: (c.team as { id: string }).id,
      completedPoints: Math.round(((c.progress as number) || 0) * 100),
      totalPoints: 100,
    }),
  )
}

async function fetchMyTickets(
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const data = await linearQuery(
    `query($userId: ID!) {
    issues(
      filter: {
        assignee: { id: { eq: $userId } }
        state: { type: { nin: [${LINEAR_INACTIVE_STATE_NIN}] } }
      }
      first: 50
      orderBy: updatedAt
    ) {
      nodes {
        id identifier title description url updatedAt
        branchName
        priority
        state { name type }
        team { key name }
        assignee { name email }
        labels { nodes { name } }
        attachments { nodes { url title } }
        cycle { id }
      }
    }
  }`,
    { userId },
  )

  return data?.issues?.nodes || []
}

async function fetchUnassignedTickets(): Promise<Array<Record<string, unknown>>> {
  const data = await linearQuery(
    `{
    issues(
      filter: {
        assignee: { null: true }
        state: { type: { nin: [${LINEAR_INACTIVE_STATE_NIN}] } }
      }
      first: 50
      orderBy: updatedAt
    ) {
      nodes {
        id identifier title description url updatedAt
        branchName
        priority
        state { name type }
        team { key name }
        assignee { name email }
        labels { nodes { name } }
        attachments { nodes { url title } }
        cycle { id }
      }
    }
  }`,
  )
  return data?.issues?.nodes || []
}

async function fetchMyCompletedTickets(
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const data = await linearQuery(
    `query($userId: ID!) {
    issues(
      filter: {
        assignee: { id: { eq: $userId } }
        state: { type: { eq: "completed" } }
        updatedAt: { gte: "-P7D" }
      }
      first: 30
      orderBy: updatedAt
    ) {
      nodes {
        id identifier title description url updatedAt
        branchName
        priority
        state { name type }
        team { key name }
        assignee { name email }
        labels { nodes { name } }
        attachments { nodes { url title } }
      }
    }
  }`,
    { userId },
  )
  return data?.issues?.nodes || []
}

async function fetchDocumentsForTickets(
  ticketIdentifiers: string[],
): Promise<Map<string, { id: string; content: string; url: string | null }>> {
  const docMap = new Map<string, { id: string; content: string; url: string | null }>()

  // One title-prefix OR query per 25 tickets rather than one query per ticket
  const CHUNK_SIZE = 25
  const chunks: string[][] = []
  for (let i = 0; i < ticketIdentifiers.length; i += CHUNK_SIZE) {
    chunks.push(ticketIdentifiers.slice(i, i + CHUNK_SIZE))
  }
  const results = await Promise.all(chunks.map(chunk => linearQuery(
    `query($filter: DocumentFilter) {
      documents(filter: $filter, first: 250) {
        nodes { id title content url }
      }
    }`,
    { filter: { or: chunk.map(identifier => ({ title: { startsWithIgnoreCase: identifier } })) } },
  )))
  const docs: Array<{ id: string; title: string; content: string | null; url: string | null }> =
    results.flatMap(data => data?.documents?.nodes || [])

  for (const identifier of ticketIdentifiers) {
    // Not followed by a digit, so ENG-12 doesn't claim ENG-123's document
    const prefix = new RegExp(`^${identifier}(?!\\d)`, 'i')
    const match = docs.find(d => prefix.test(d.title))
    if (match) {
      docMap.set(identifier, { id: match.id, content: match.content || '', url: match.url || null })
    }
  }

  return docMap
}

const MANUAL_STEP_KEYWORDS = [
  'cms', 'aws', 'vercel dashboard', 'env var', 'environment variable',
  'secret', 'dns', 'migration', 'manual', 'dashboard', 'infrastructure',
  'permissions', 'credentials', 'third-party config',
  'deploy', 'third-party',
]

// Tickets can link PRs in sibling repos, and every consumer looks these numbers
// up against REPO_URL, so an unscoped match would surface whatever unrelated PR
// happens to share the number.
function extractPrNumbersFromAttachments(attachments: Array<{ url: string }> | null): number[] {
  if (!attachments) return []
  const prNumbers: number[] = []
  for (const a of attachments) {
    const match = a.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
    if (match && (!REPO_URL || match[1] === REPO_URL)) {
      prNumbers.push(parseInt(match[2], 10))
    }
  }
  return prNumbers
}

function hasImplementationPlan(content: string | null): boolean {
  if (!content) return false
  return /## Implementation Plan[\s\S]*?- \[[ x]\]/i.test(content)
}

function hasBlockersSection(content: string | null): boolean {
  if (!content) return false
  const blockerMatch = content.match(/## Blockers\s*\n([\s\S]*?)(?=\n##|$)/i)
  if (!blockerMatch) return false
  const blockerContent = blockerMatch[1].trim()
  return blockerContent !== '' && blockerContent !== '(none)'
}

function extractSection(content: string, heading: string): string | null {
  const regex = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i')
  const match = content.match(regex)
  return match ? match[1].trim() : null
}

function parseWorkDocument(content: string | null): WorkDocParsed | null {
  if (!content) return null

  // Parse implementation plan checkboxes
  const planSection = extractSection(content, 'Implementation Plan')
  const allChecks = planSection?.match(/- \[[ x]\] .*/g) || []
  const checkedCount = allChecks.filter((c) => c.startsWith('- [x]')).length
  const uncheckedSteps = allChecks
    .filter((c) => c.startsWith('- [ ]'))
    .map((c) => c.replace(/^- \[ \] /, ''))

  // Parse blockers
  const blockersContent = extractSection(content, 'Blockers')
  const hasBlockers = !!blockersContent && blockersContent !== '(none)'

  // Parse manual steps
  const manualSection = extractSection(content, 'Manual Steps')
  const manualSteps: Array<{ description: string; checked: boolean }> = []
  if (manualSection) {
    const manualChecks = manualSection.match(/- \[[ x]\] .*/g) || []
    for (const check of manualChecks) {
      manualSteps.push({
        description: check.replace(/^- \[[ x]\] /, ''),
        checked: check.startsWith('- [x]'),
      })
    }
  }

  // Parse review notes
  const reviewNotesContent = extractSection(content, 'Review Notes')
  const hasReviewNotes = !!reviewNotesContent && reviewNotesContent !== '(none yet)'

  // Parse progress
  const progressContent = extractSection(content, 'Progress')

  return {
    totalSteps: allChecks.length,
    completedSteps: checkedCount,
    uncheckedSteps,
    hasBlockers,
    blockersContent: hasBlockers ? blockersContent : null,
    hasManualSteps: manualSteps.length > 0,
    manualSteps,
    hasReviewNotes,
    reviewNotesContent: hasReviewNotes ? reviewNotesContent : null,
    progressContent: progressContent || null,
  }
}

function detectManualSteps(text: string | null): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return MANUAL_STEP_KEYWORDS.some((kw) => lower.includes(kw))
}

function extractTldr(ticket: { title: string; description: string | null }, workDocContent: string | null): string {
  // Try first line of description if it's meaningful
  if (ticket.description) {
    const firstLine = ticket.description.split('\n').find((l) => l.trim().length > 0)
    if (firstLine && firstLine.trim().length > 10 && firstLine.trim().length < 200) {
      return firstLine.trim()
    }
  }
  // Fall back to title
  return ticket.title
}

export async function fetchLinearData(): Promise<{
  tickets: CategorisedTickets
  cycles: LinearCycle[]
  allTickets: LinearTicket[]
  unassignedTickets: LinearTicket[]
  completedTickets: LinearTicket[]
  /** Ticket identifiers hidden from the dashboard (Paused / canceled / duplicate). */
  hiddenTicketIds: string[]
  /** PR numbers attached to hidden tickets — also hidden from the dashboard. */
  hiddenPrNumbers: number[]
}> {
  const emptyResult = {
    tickets: {
      readyToImplement: [] as LinearTicket[],
      needsPlanning: [] as LinearTicket[],
      blocked: [] as LinearTicket[],
      housekeeping: [] as LinearTicket[],
      inProgress: [] as LinearTicket[],
    },
    cycles: [] as LinearCycle[],
    allTickets: [] as LinearTicket[],
    unassignedTickets: [] as LinearTicket[],
    completedTickets: [] as LinearTicket[],
    hiddenTicketIds: [] as string[],
    hiddenPrNumbers: [] as number[],
  }

  if (!LINEAR_API_KEY) return emptyResult

  // Wave 1: fetch user, teams in parallel
  const [userId, teams] = await Promise.all([
    fetchCurrentUser(),
    fetchTeams(),
  ])

  if (!userId) return emptyResult

  // Wave 2: fetch tickets, cycles, unassigned, and completed in parallel
  const [rawTickets, cycles, rawUnassigned, rawCompleted] = await Promise.all([
    fetchMyTickets(userId),
    fetchCurrentCycles(teams.map((t) => t.id)),
    fetchUnassignedTickets(),
    fetchMyCompletedTickets(userId),
  ])

  // Filter raw tickets to current-cycle tickets using each issue's own cycle.id
  // (avoids a separate, paginated cycle-members fetch that missed tickets past page 1)
  const activeCycleIds = new Set(cycles.map((c) => c.id))
  const isPaused = (t: Record<string, unknown>) =>
    /^paused$/i.test((t.state as { name?: string } | null)?.name ?? '')
  const stateType = (t: Record<string, unknown>) =>
    (t.state as { type?: string } | null)?.type
  // Paused is a named status on an otherwise-active type. Canceled/duplicate
  // should already be excluded by the GraphQL nin filter; re-check client-side
  // so a filter miss (or old British "cancelled" spelling) can't resurface them.
  const isHiddenTicket = (t: Record<string, unknown>) =>
    isPaused(t) || isInactiveLinearStateType(stateType(t))
  const inCycleBeforeHide = activeCycleIds.size > 0
    ? rawTickets.filter((t) => activeCycleIds.has((t.cycle as { id: string } | null)?.id ?? ''))
    : rawTickets
  const unassignedBeforeHide = activeCycleIds.size > 0
    ? rawUnassigned.filter((t) => activeCycleIds.has((t.cycle as { id: string } | null)?.id ?? ''))
    : rawUnassigned

  // Drop hidden tickets from the dashboard, but keep their ids / linked PRs so
  // open GitHub PRs for those tickets don't resurface as orphans.
  const hiddenRaw = [...inCycleBeforeHide, ...unassignedBeforeHide].filter(isHiddenTicket)
  const hiddenTicketIds = [...new Set(hiddenRaw.map((t) => t.identifier as string))]
  const hiddenPrNumbers = [...new Set(hiddenRaw.flatMap((t) =>
    extractPrNumbersFromAttachments(
      (t.attachments as { nodes: Array<{ url: string }> } | null)?.nodes || null,
    ),
  ))]
  const inCycleRaw = inCycleBeforeHide.filter((t) => !isHiddenTicket(t))
  const inCycleRawUnassigned = unassignedBeforeHide.filter((t) => !isHiddenTicket(t))

  // Wave 3: fetch documents in parallel (only for cycle-filtered tickets)
  const ticketIdentifiers = inCycleRaw.map((t) => t.identifier as string)
  const unassignedIdentifiers = inCycleRawUnassigned.map((t) => t.identifier as string)
  const [docMap, unassignedDocMap] = await Promise.all([
    fetchDocumentsForTickets(ticketIdentifiers),
    fetchDocumentsForTickets(unassignedIdentifiers),
  ])

  // Build cycle name lookup by team ID (UUID)
  const cycleNameByTeamId = new Map<string, string>()
  for (const c of cycles) {
    cycleNameByTeamId.set(c.teamId, c.name || `Cycle ${c.number}`)
  }
  // Also build a teamKey→teamId map for lookup
  const teamIdByKey = new Map<string, string>()
  for (const t of teams) {
    teamIdByKey.set(t.key, t.id)
  }

  // Shared mapping helper — differences handled via docMap + overrides
  const shared = { docMap, cycleNameByTeamId, teamIdByKey }

  function mapRawTicket(
    t: Record<string, unknown>,
    docs: Map<string, { id: string; content: string; url: string | null }>,
    overrides?: Partial<LinearTicket>,
  ): LinearTicket {
    const identifier = t.identifier as string
    const doc = docs.get(identifier)
    const docContent = doc?.content || null
    const workDocParsed = parseWorkDocument(docContent)
    const description = (t.description as string) || null
    const teamData = t.team as { key: string; name: string }

    return {
      id: t.id as string,
      identifier,
      title: t.title as string,
      description,
      tldr: extractTldr({ title: t.title as string, description }, docContent),
      state: t.state as { name: string; type: string },
      priority: t.priority as number,
      team: { key: teamData.key, name: teamData.name },
      assignee: t.assignee as { name: string; email: string } | null,
      labels: ((t.labels as { nodes: Array<{ name: string }> })?.nodes || []).map(l => l.name),
      url: t.url as string,
      cycleName: cycleNameByTeamId.get(teamIdByKey.get(teamData.key) || '') || null,
      hasWorkDocument: !!doc,
      workDocumentId: doc?.id || null,
      workDocumentUrl: doc?.url || null,
      workDocumentContent: docContent,
      workDocParsed,
      linkedPrNumbers: extractPrNumbersFromAttachments((t.attachments as { nodes: Array<{ url: string }> })?.nodes || null),
      branchName: (t.branchName as string) || null,
      hasManualSteps: detectManualSteps(description) || detectManualSteps(docContent),
      updatedAt: (t.updatedAt as string) || null,
      ...overrides,
    }
  }

  // Map cycle-filtered raw tickets to our type
  const inCycle: LinearTicket[] = inCycleRaw.map((t) => mapRawTicket(t, shared.docMap))

  // Categorise
  const blocked = inCycle.filter((t) => hasBlockersSection(t.workDocumentContent))
  const blockedIds = new Set(blocked.map((t) => t.id))

  const readyToImplement = inCycle.filter(
    (t) =>
      !blockedIds.has(t.id) &&
      t.hasWorkDocument &&
      hasImplementationPlan(t.workDocumentContent) &&
      t.state.type !== 'started',
  )

  const inProgress = inCycle.filter((t) => t.state.type === 'started')

  const needsPlanning = inCycle.filter(
    (t) =>
      !blockedIds.has(t.id) &&
      !readyToImplement.includes(t) &&
      !inProgress.includes(t) &&
      (!t.hasWorkDocument || !hasImplementationPlan(t.workDocumentContent)),
  )

  // Map cycle-filtered unassigned tickets (with doc fetching for plan detection)
  const unassignedInCycle: LinearTicket[] = inCycleRawUnassigned.map((t) =>
    mapRawTicket(t, unassignedDocMap, { assignee: null }),
  )

  // Map completed tickets (minimal — no doc fetching, empty map yields null doc fields)
  const emptyDocMap = new Map<string, { id: string; content: string; url: string | null }>()
  const completedTickets: LinearTicket[] = rawCompleted.map((t) => mapRawTicket(t, emptyDocMap))

  return {
    tickets: {
      readyToImplement,
      needsPlanning,
      blocked,
      housekeeping: [], // populated after cross-referencing with GitHub data
      inProgress,
    },
    cycles,
    allTickets: inCycle,
    unassignedTickets: unassignedInCycle,
    completedTickets,
    hiddenTicketIds,
    hiddenPrNumbers,
  }
}

// Field selection shared by fetchTicketById's exact-filter fast path and its
// moved-ticket fallback re-query — the two must stay identical.
const TICKET_FIELDS = `
  id identifier title description url updatedAt branchName priority
  state { name type }
  team { key name }
  assignee { name email }
  labels { nodes { name } }
  attachments { nodes { url } }
`

/**
 * Fetch a single ticket by identifier (e.g. "ENG-260"). Returns description +
 * basic fields. Survives team moves: when the exact number+team filter misses
 * (moved tickets are renumbered), falls back to search by previous identifier.
 */
export async function fetchTicketById(identifier: string): Promise<LinearTicket | null> {
  const [data, docData] = await Promise.all([
    linearQuery(`
      query($filter: IssueFilter) {
        issues(filter: $filter, first: 1) {
          nodes { ${TICKET_FIELDS} }
        }
      }
    `, {
      filter: {
        number: { eq: parseInt(identifier.split('-')[1]) },
        team: { key: { eq: identifier.split('-')[0] } },
      },
    }),
    linearQuery(`
      query($query: String!) {
        documents(filter: { title: { containsIgnoreCase: $query } }, first: 5) {
          nodes { id title content url }
        }
      }
    `, { query: identifier }),
  ])
  let node = data?.issues?.nodes?.[0]
  if (!node && data !== null) {
    // Exact filter missed but Linear responded — likely a moved/renumbered
    // ticket. (data === null means outage/unconfigured; retrying via search
    // would fail the same way.)
    const movedId = await searchIssueIdByIdentifier(identifier)
    if (movedId) {
      const byId = await linearQuery(
        `query($id: String!) { issue(id: $id) { ${TICKET_FIELDS} } }`,
        { id: movedId },
      )
      node = byId?.issue
    }
  }
  if (!node) return null
  const docs = docData?.documents?.nodes || []
  const doc = docs.find((d: { title: string }) => d.title.toUpperCase().startsWith(identifier.toUpperCase()))
  const docContent = doc?.content || null
  const workDocParsed = parseWorkDocument(docContent)
  const description = node.description || null

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description,
    tldr: extractTldr({ title: node.title, description }, docContent),
    state: node.state,
    priority: node.priority,
    team: { key: node.team.key, name: node.team.name },
    assignee: node.assignee || null,
    labels: (node.labels?.nodes || []).map((l: { name: string }) => l.name),
    url: node.url,
    cycleName: null,
    hasWorkDocument: !!doc,
    workDocumentId: doc?.id || null,
    workDocumentUrl: doc?.url || null,
    workDocumentContent: docContent,
    workDocParsed,
    linkedPrNumbers: extractPrNumbersFromAttachments(node.attachments?.nodes || null),
    branchName: node.branchName || null,
    hasManualSteps: detectManualSteps(description) || detectManualSteps(docContent),
    updatedAt: node.updatedAt || null,
  }
}
