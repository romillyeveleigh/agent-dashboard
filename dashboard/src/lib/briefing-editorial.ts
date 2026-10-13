import { createHash } from 'crypto'
import { z } from 'zod/v4'
import { workItemActionSchema } from './dashboard-types'
import type { ContextData, HousekeepingItem } from './context-types'
import type { LinearTicket } from './linear-data'
import type { PullRequest } from './github'
import { ignoredBotLogins, isBotOrSelf } from './bot-filter'

// --- Slim briefing view (what we send to the LLM) ---

export type BriefingTicket = {
  identifier: string
  url: string
  title: string
  description: string | null
  tldr: string | null
  state: { name: string }
  priority: number
  hasWorkDocument: boolean
  workDocumentContent: string | null
  workDocParsed: {
    totalSteps: number
    completedSteps: number
    progressContent: string | null
    blockersContent: string | null
  } | null
  linkedPrNumbers: number[]
  hasManualSteps: boolean
  manualStepsStatus: 'pending' | 'done' | null
}

export type BriefingReview = { state: string; author: string; body: string }
export type BriefingComment = { author: string; body: string }

export type BriefingPr = {
  number: number
  title: string
  url: string
  headRefName: string
  additions: number
  deletions: number
  updatedAt: string
  displayStatus: string
  ciStatus: string | null
  commentCount: number
  linkedTicketId: string | null
  labels: string[]
  reviews: BriefingReview[]
  // Reviewers requested but not yet responded. Empty `reviews` + non-empty here
  // means "review pending from X", not "no reviewers" — the LLM must not conflate them.
  requestedReviewers: string[]
  comments: BriefingComment[]
  hasMergeConflict: boolean
}

export type BriefingReviewRequest = {
  number: number
  title: string
  url: string
  author: string
  additions: number
  deletions: number
  updatedAt: string
  labels: string[]
  reviews: BriefingReview[]
  comments: BriefingComment[]
  commentCount: number
}

export type BriefingView = {
  tickets: BriefingTicket[]
  myPRs: BriefingPr[]
  recentlyMerged: BriefingPr[]
  reviewRequests: BriefingReviewRequest[]
  housekeeping: HousekeepingItem[]
}

const MAX_DESCRIPTION_CHARS = 500
const MAX_WORK_DOC_CHARS = 2000
const MAX_REVIEWS = 5
const MAX_COMMENTS = 3
const MAX_BODY_CHARS = 240

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1).trimEnd() + '…'
}

function slimTicket(t: LinearTicket): BriefingTicket {
  const steps = t.workDocParsed?.manualSteps ?? []
  const manualStepsStatus: 'pending' | 'done' | null = t.hasManualSteps
    ? (steps.length > 0 && steps.every(s => s.checked) ? 'done' : 'pending')
    : null
  return {
    identifier: t.identifier,
    url: t.url,
    title: t.title,
    description: t.description ? truncate(t.description, MAX_DESCRIPTION_CHARS) : null,
    tldr: t.tldr,
    state: { name: t.state.name },
    priority: t.priority,
    hasWorkDocument: t.hasWorkDocument,
    workDocumentContent: t.workDocumentContent ? truncate(t.workDocumentContent, MAX_WORK_DOC_CHARS) : null,
    workDocParsed: t.workDocParsed
      ? {
          totalSteps: t.workDocParsed.totalSteps,
          completedSteps: t.workDocParsed.completedSteps,
          progressContent: t.workDocParsed.progressContent,
          blockersContent: t.workDocParsed.blockersContent,
        }
      : null,
    linkedPrNumbers: t.linkedPrNumbers,
    hasManualSteps: t.hasManualSteps,
    manualStepsStatus,
  }
}

function isHumanOnPr(login: string, bots: Set<string>, prAuthor?: string): boolean {
  if (isBotOrSelf(login, bots)) return false
  if (prAuthor && login === prAuthor) return false
  return true
}

function slimReviews(reviews: PullRequest['reviews'], bots: Set<string>, prAuthor?: string): BriefingReview[] {
  return reviews
    .filter(r => isHumanOnPr(r.author, bots, prAuthor))
    .slice(-MAX_REVIEWS)
    .map(r => ({ state: r.state, author: r.author, body: truncate(r.body || '', MAX_BODY_CHARS) }))
}

function slimComments(comments: PullRequest['comments'], bots: Set<string>, prAuthor?: string): BriefingComment[] {
  return comments
    .filter(c => isHumanOnPr(c.author, bots, prAuthor))
    .slice(-MAX_COMMENTS)
    .map(c => ({ author: c.author, body: truncate(c.body || '', MAX_BODY_CHARS) }))
}

function humanCommentCount(p: PullRequest, bots: Set<string>): number {
  return p.comments.filter(c => isHumanOnPr(c.author, bots, p.author)).length
}

function slimPr(p: PullRequest, bots: Set<string>): BriefingPr {
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    headRefName: p.headRefName,
    additions: p.additions,
    deletions: p.deletions,
    updatedAt: p.updatedAt,
    displayStatus: p.displayStatus,
    ciStatus: p.ciStatus,
    commentCount: humanCommentCount(p, bots),
    linkedTicketId: p.linkedTicketId,
    labels: p.labels.map(l => l.name),
    reviews: slimReviews(p.reviews, bots, p.author),
    requestedReviewers: p.requestedReviewers.filter(r => !isBotOrSelf(r, bots)),
    comments: slimComments(p.comments, bots, p.author),
    hasMergeConflict: p.hasMergeConflict,
  }
}

function slimReviewRequest(p: PullRequest, bots: Set<string>): BriefingReviewRequest {
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    author: p.author,
    additions: p.additions,
    deletions: p.deletions,
    updatedAt: p.updatedAt,
    labels: p.labels.map(l => l.name),
    reviews: slimReviews(p.reviews, bots, p.author),
    comments: slimComments(p.comments, bots, p.author),
    commentCount: humanCommentCount(p, bots),
  }
}

export function buildBriefingView(full: ContextData): BriefingView {
  const bots = ignoredBotLogins()
  return {
    tickets: full.tickets.map(slimTicket),
    myPRs: full.myPRs.map(p => slimPr(p, bots)),
    recentlyMerged: full.recentlyMerged.map(p => slimPr(p, bots)),
    reviewRequests: full.reviewRequests.map(p => slimReviewRequest(p, bots)),
    housekeeping: full.housekeeping,
  }
}

export function isOrphanPr(p: BriefingPr, ticketIds: Set<string>): boolean {
  return !p.linkedTicketId || !ticketIds.has(p.linkedTicketId)
}

export function isTerminalPrStatus(status: string): boolean {
  return status === 'Merged' || status === 'Closed'
}

/**
 * PRs shown under a ticket work-item card.
 *
 * Open PRs always appear. Merged/closed siblings appear only when at least one
 * open PR remains (multi-PR context). When every linked PR is already
 * terminal — common for related/prerequisite attachments on a still-Ready
 * ticket — return none so the card reads as no-PR work, not "done".
 */
export function selectVisibleLinkedPrs<T extends { displayStatus: string }>(linked: T[]): T[] {
  const open = linked.filter(p => !isTerminalPrStatus(p.displayStatus))
  if (open.length === 0) return []
  return linked
}

// --- Per-item editorial store ---
//
// Editorial is cached per item, keyed by a hash of only the fields that should
// change the prose (title, bodies, review/comment text, plan progress). This
// makes LLM cost scale with content churn instead of portfolio size: a refresh
// re-editorializes only the items whose editorial-relevant content changed,
// in one small call, and everything else is reused verbatim.

const itemEditorialSchema = z.object({
  hash: z.string(),
  editorialTitle: z.string(),
  tldr: z.string(),
  actions: z.array(workItemActionSchema),
})

/** What generateObject accepts from the LLM. Actions are optional because a
 *  large target set often drops them; mergeBriefing fills chips mechanically. */
export const llmBriefingEditorialSchema = z.object({
  workItems: z.array(z.object({
    id: z.string(),
    editorialTitle: z.string(),
    tldr: z.string(),
    actions: z.array(workItemActionSchema).optional().default([]),
  })),
  reviewRequests: z.array(z.object({
    number: z.number(),
    editorialTitle: z.string(),
    tldr: z.string(),
  })).optional().default([]),
})

const reviewEditorialSchema = z.object({
  hash: z.string(),
  editorialTitle: z.string(),
  tldr: z.string(),
})

// Keys: ticket identifier or orphan-PR number as string (workItems),
// review-request PR number as string (reviewRequests).
const editorialStoreSchema = z.object({
  v: z.literal(2),
  workItems: z.record(z.string(), itemEditorialSchema),
  reviewRequests: z.record(z.string(), reviewEditorialSchema),
})

export type ItemEditorial = z.infer<typeof itemEditorialSchema>
export type ReviewEditorial = z.infer<typeof reviewEditorialSchema>
export type EditorialStore = z.infer<typeof editorialStoreSchema>

// Pre-store format: a single editorial blob for the whole portfolio.
const legacyEditorialSchema = z.object({
  workItems: z.array(z.object({
    id: z.string(),
    editorialTitle: z.string(),
    tldr: z.string(),
    actions: z.array(workItemActionSchema),
  })),
  reviewRequests: z.array(z.object({
    number: z.number(),
    editorialTitle: z.string(),
    tldr: z.string(),
  })),
})

export function emptyStore(): EditorialStore {
  return { v: 2, workItems: {}, reviewRequests: {} }
}

/**
 * Parse the persisted editorial store. A legacy single-blob editorial is
 * migrated in place by adopting the current hashes, so the format change
 * doesn't trigger a full regeneration; unparseable content starts empty.
 */
export function parseEditorialStore(json: string | null | undefined, hashes: EditorialHashes): EditorialStore {
  if (!json) return emptyStore()
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return emptyStore()
  }
  const v2 = editorialStoreSchema.safeParse(raw)
  if (v2.success) return v2.data
  const legacy = legacyEditorialSchema.safeParse(raw)
  if (legacy.success) {
    const store = emptyStore()
    for (const w of legacy.data.workItems) {
      const hash = hashes.workItems.get(w.id)
      if (hash) store.workItems[w.id] = { hash, editorialTitle: w.editorialTitle, tldr: w.tldr, actions: w.actions }
    }
    for (const r of legacy.data.reviewRequests) {
      const hash = hashes.reviewRequests.get(r.number)
      if (hash) store.reviewRequests[String(r.number)] = { hash, editorialTitle: r.editorialTitle, tldr: r.tldr }
    }
    return store
  }
  return emptyStore()
}

// --- Editorial-relevant hashing ---

export type EditorialHashes = {
  workItems: Map<string, string> // ticket identifier or orphan-PR number as string
  reviewRequests: Map<number, string>
}

function sha(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

// Coarse size so routine pushes don't churn the hash; the exact count is
// merged mechanically and stays fresh regardless.
function sizeBucket(p: { additions: number; deletions: number }): string {
  const total = p.additions + p.deletions
  if (total <= 150) return 'small'
  if (total <= 600) return 'medium'
  return 'large'
}

// What a PR contributes to a work item's prose and action choice. Deliberately
// excludes updatedAt and the success/pending CI states: those are mechanical,
// and hashing them would regenerate editorial on every push and poll. A CI
// *failure* (and its clearing) is editorially meaningful, so that survives as
// a boolean, as does displayStatus (Draft/Approved/Changes req. shifts are
// rare and drive action selection).
function prEditorialFacts(p: BriefingPr) {
  return {
    number: p.number,
    title: p.title,
    displayStatus: p.displayStatus,
    ciFailing: p.ciStatus === 'FAILURE',
    hasMergeConflict: p.hasMergeConflict,
    labels: p.labels,
    reviews: p.reviews,
    requestedReviewers: p.requestedReviewers,
    comments: p.comments,
    commentCount: p.commentCount,
    size: sizeBucket(p),
  }
}

export function computeEditorialHashes(slim: BriefingView): EditorialHashes {
  const prsByNumber = new Map(slim.myPRs.map(p => [p.number, p]))
  const mergedNumbers = new Set(slim.recentlyMerged.map(p => p.number))
  const ticketIds = new Set(slim.tickets.map(t => t.identifier))

  const workItems = new Map<string, string>()
  for (const t of slim.tickets) {
    const linked = t.linkedPrNumbers
      .map(n => prsByNumber.get(n))
      .filter((p): p is BriefingPr => p !== undefined)
      .map(p => prEditorialFacts(p))
    workItems.set(t.identifier, sha({
      title: t.title,
      description: t.description,
      tldr: t.tldr,
      state: t.state.name,
      hasWorkDocument: t.hasWorkDocument,
      workDocumentContent: t.workDocumentContent,
      workDocParsed: t.workDocParsed,
      hasManualSteps: t.hasManualSteps,
      manualStepsStatus: t.manualStepsStatus,
      linked,
      merged: t.linkedPrNumbers.filter(n => mergedNumbers.has(n)),
    }))
  }
  for (const p of slim.myPRs) {
    if (!isOrphanPr(p, ticketIds)) continue
    workItems.set(String(p.number), sha({
      ...prEditorialFacts(p),
      linkedTicketId: p.linkedTicketId,
    }))
  }

  const reviewRequests = new Map<number, string>()
  for (const p of slim.reviewRequests) {
    reviewRequests.set(p.number, sha({
      title: p.title,
      author: p.author,
      labels: p.labels,
      reviews: p.reviews,
      comments: p.comments,
      commentCount: p.commentCount,
      size: sizeBucket(p),
    }))
  }

  return { workItems, reviewRequests }
}

// --- Mechanical ordering (was previously the LLM's job) ---
// Merge conflicts, failing CI, changes requested, and blockers outrank quiet items; priority
// breaks ties. Sort is stable, so equal scores keep source order.

export function orderTickets(slim: BriefingView): BriefingTicket[] {
  const prsByNumber = new Map(slim.myPRs.map(p => [p.number, p]))
  const score = (t: BriefingTicket): number => {
    const linked = t.linkedPrNumbers
      .map(n => prsByNumber.get(n))
      .filter((p): p is BriefingPr => p !== undefined)
    let s = 0
    if (linked.some(p => p.hasMergeConflict)) s += 900
    if (linked.some(p => p.ciStatus === 'FAILURE')) s += 800
    if (linked.some(p => p.displayStatus === 'Changes req.')) s += 600
    if (t.workDocParsed?.blockersContent) s += 400
    if (t.manualStepsStatus === 'pending') s += 200
    if (t.priority > 0) s += 5 - t.priority
    return s
  }
  return [...slim.tickets].sort((a, b) => score(b) - score(a))
}

export function orderOrphanPrs(slim: BriefingView): BriefingPr[] {
  const ticketIds = new Set(slim.tickets.map(t => t.identifier))
  const score = (p: BriefingPr): number =>
    (p.hasMergeConflict ? 900 : 0) + (p.ciStatus === 'FAILURE' ? 800 : 0) + (p.displayStatus === 'Changes req.' ? 600 : 0)
  return slim.myPRs.filter(p => isOrphanPr(p, ticketIds)).sort((a, b) => score(b) - score(a))
}

// --- Fallback editorial ---
// Used when the LLM response omits a target item: the item still renders
// (mechanical title, no tldr) instead of breaking the merge.

function stripTitlePrefix(title: string): string {
  return title
    .replace(/^[A-Z]+-\d+:?\s*/, '')
    .replace(/^\w+(\([^)]*\))?!?:\s*/, '')
    .trim() || title
}

export function fallbackWorkItemEditorial(title: string): Omit<ItemEditorial, 'hash'> {
  return { editorialTitle: stripTitlePrefix(title), tldr: '', actions: [{ presetId: 'summarise' }] }
}

export function fallbackReviewEditorial(title: string): Omit<ReviewEditorial, 'hash'> {
  return { editorialTitle: stripTitlePrefix(title), tldr: '' }
}
