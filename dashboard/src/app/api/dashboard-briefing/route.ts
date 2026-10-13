import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'
import { db } from '@/lib/db'
import { dashboardCache } from '@/lib/schema'
import { hashContext } from '@/lib/dashboard-types'
import type { DashboardData, WorkItem, PrSubItem, ReviewItem } from '@/lib/dashboard-types'
import type { ContextData } from '@/lib/context-types'
import { setupIncompleteResponse } from '@/lib/setup'
import { linearTicketUrl } from '@/lib/integrations'
import { buildContextData } from '@/lib/build-context'
import { DISPATCH_MODES, DRAWER_PRESETS, filterWorkItemActions, type PresetPr } from '@/lib/quick-actions'
import {
  buildBriefingView,
  computeEditorialHashes,
  parseEditorialStore,
  emptyStore,
  isOrphanPr,
  isTerminalPrStatus,
  selectVisibleLinkedPrs,
  orderTickets,
  orderOrphanPrs,
  fallbackWorkItemEditorial,
  fallbackReviewEditorial,
  llmBriefingEditorialSchema,
} from '@/lib/briefing-editorial'
import type { BriefingView, BriefingPr, EditorialStore, EditorialHashes } from '@/lib/briefing-editorial'

// Modes the briefing may use for custom actions. ship is excluded on purpose:
// it is gated behind its own preset.
const BRIEFING_ACTION_MODES = DISPATCH_MODES
  .map(m => m.id)
  .filter(id => id !== 'ship')

const PRESET_LINES = DRAWER_PRESETS
  .filter(p => p.briefingHint)
  .map(p => `- \`${p.id}\` — ${p.briefingHint}`)
  .join('\n')

type BriefingEditorial = z.infer<typeof llmBriefingEditorialSchema>

// --- Merge: assemble DashboardData from the per-item editorial store + slim inputs ---

function priorityLabel(p: number): string {
  if (p === 1) return 'Urgent'
  if (p === 2) return 'High'
  if (p === 3) return 'Normal'
  if (p === 4) return 'Low'
  return 'No priority'
}

function mapCi(ciStatus: string | null): string {
  if (ciStatus === 'SUCCESS') return 'success'
  if (ciStatus === 'FAILURE') return 'failure'
  return 'pending'
}

function briefingPrToPreset(p: BriefingPr): PresetPr {
  return {
    state: isTerminalPrStatus(p.displayStatus) ? 'CLOSED' : 'OPEN',
    ciStatus: p.ciStatus,
    reviewDecision:
      p.displayStatus === 'Changes req.' ? 'CHANGES_REQUESTED' :
      p.displayStatus === 'Approved' ? 'APPROVED' :
      p.displayStatus === 'Pending' ? 'REVIEW_REQUIRED' :
      null,
    hasMergeConflict: p.hasMergeConflict,
    linkedTicketId: p.linkedTicketId,
    displayStatus: p.displayStatus,
    reviews: p.reviews,
    comments: p.comments,
  }
}

function mergeBriefing(store: EditorialStore, slim: BriefingView): DashboardData {
  const prsByNumber = new Map<number, BriefingPr>()
  for (const p of slim.myPRs) prsByNumber.set(p.number, p)
  for (const p of slim.recentlyMerged) prsByNumber.set(p.number, p)

  const workItems: WorkItem[] = []
  for (const ticket of orderTickets(slim)) {
    const ed = store.workItems[ticket.identifier] ?? fallbackWorkItemEditorial(ticket.title)
    const linked = ticket.linkedPrNumbers
      .map(n => prsByNumber.get(n))
      .filter((p): p is BriefingPr => p !== undefined)
    const visible = selectVisibleLinkedPrs(linked)
    const prs: PrSubItem[] = visible.map(p => ({
      number: p.number,
      url: p.url,
      status: p.displayStatus,
      ci: mapCi(p.ciStatus),
      conflict: p.hasMergeConflict,
    }))
    const planStatus = ticket.hasWorkDocument && ticket.workDocParsed && ticket.workDocParsed.totalSteps > 0
      ? `Plan ${ticket.workDocParsed.completedSteps}/${ticket.workDocParsed.totalSteps}`
      : null
    const hasOpenPr = linked.some(p => !isTerminalPrStatus(p.displayStatus))
    const presetPrs = linked.map(briefingPrToPreset)
    if (
      presetPrs.length === 0 &&
      slim.housekeeping.some(h => h.type === 'stale_status' && h.ticketId === ticket.identifier)
    ) {
      presetPrs.push({
        state: 'CLOSED',
        ciStatus: null,
        reviewDecision: null,
        linkedTicketId: ticket.identifier,
      })
    }
    workItems.push({
      type: 'ticket',
      id: ticket.identifier,
      url: ticket.url,
      editorialTitle: ed.editorialTitle,
      tldr: ed.tldr,
      state: ticket.state.name,
      priority: priorityLabel(ticket.priority),
      planStatus,
      manualSteps: ticket.manualStepsStatus,
      // Related/prerequisite merges don't count as this ticket's PR.
      noPr: !hasOpenPr,
      prs,
      actions: filterWorkItemActions(ed.actions, {
        ticket: { hasWorkDocument: ticket.hasWorkDocument, identifier: ticket.identifier },
        prs: presetPrs,
      }),
    })
  }

  for (const pr of orderOrphanPrs(slim)) {
    const ed = store.workItems[String(pr.number)] ?? fallbackWorkItemEditorial(pr.title)
    workItems.push({
      type: 'orphan-pr',
      id: String(pr.number),
      url: pr.url,
      editorialTitle: ed.editorialTitle,
      tldr: ed.tldr,
      prStatus: pr.displayStatus,
      ci: mapCi(pr.ciStatus),
      conflict: pr.hasMergeConflict,
      linkedTicketId: pr.linkedTicketId,
      linkedTicketUrl: pr.linkedTicketId ? linearTicketUrl(pr.linkedTicketId) : null,
      actions: filterWorkItemActions(ed.actions, {
        prs: [briefingPrToPreset(pr)],
      }),
    })
  }

  const now = Date.now()
  const reviewRequests: ReviewItem[] = slim.reviewRequests.map(pr => {
    const ed = store.reviewRequests[String(pr.number)] ?? fallbackReviewEditorial(pr.title)
    const daysWaiting = Math.max(0, Math.floor((now - new Date(pr.updatedAt).getTime()) / (1000 * 60 * 60 * 24)))
    const size = pr.additions + pr.deletions
    return {
      number: pr.number,
      url: pr.url,
      editorialTitle: ed.editorialTitle,
      author: pr.author,
      daysWaiting,
      size,
      tldr: ed.tldr,
      instruction: `Review PR #${pr.number} by @${pr.author} (${size} lines). Context: ${ed.tldr}`,
      actionLabel: 'Review',
      mode: 'review',
    }
  })

  return { workItems, reviewRequests }
}

// --- Delta payload: full data for target items only, one-liners for the rest ---

type DeltaTargets = {
  workItemIds: Set<string>
  reviewRequestNumbers: Set<number>
}

function buildDeltaPayload(slim: BriefingView, targets: DeltaTargets) {
  const ticketIds = new Set(slim.tickets.map(t => t.identifier))
  const orphans = slim.myPRs.filter(p => isOrphanPr(p, ticketIds))

  const targetTickets = slim.tickets.filter(t => targets.workItemIds.has(t.identifier))
  const targetOrphans = orphans.filter(p => targets.workItemIds.has(String(p.number)))
  const targetReviews = slim.reviewRequests.filter(p => targets.reviewRequestNumbers.has(p.number))

  const neededPrNumbers = new Set<number>([
    ...targetTickets.flatMap(t => t.linkedPrNumbers),
    ...targetOrphans.map(p => p.number),
  ])
  const myPRs = slim.myPRs.filter(p => neededPrNumbers.has(p.number))
  // Merged linked PRs matter to a ticket's tldr as a fact ("backend merged"),
  // not for their review threads, so only number/title travel.
  const recentlyMerged = slim.recentlyMerged
    .filter(p => neededPrNumbers.has(p.number))
    .map(p => ({ number: p.number, title: p.title, headRefName: p.headRefName }))

  const portfolioDigest = [
    ...slim.tickets
      .filter(t => !targets.workItemIds.has(t.identifier))
      .map(t => ({ kind: 'ticket', id: t.identifier, title: t.title, state: t.state.name })),
    ...orphans
      .filter(p => !targets.workItemIds.has(String(p.number)))
      .map(p => ({ kind: 'orphan-pr', id: String(p.number), title: p.title, state: p.displayStatus })),
    ...slim.reviewRequests
      .filter(p => !targets.reviewRequestNumbers.has(p.number))
      .map(p => ({ kind: 'review-request', id: String(p.number), title: p.title, state: `by @${p.author}` })),
    ...slim.recentlyMerged
      .filter(p => !neededPrNumbers.has(p.number))
      .map(p => ({ kind: 'merged-pr', id: String(p.number), title: p.title, state: 'Merged' })),
  ]

  return {
    targets: {
      workItemIds: [...targetTickets.map(t => t.identifier), ...targetOrphans.map(p => String(p.number))],
      reviewRequestNumbers: targetReviews.map(p => p.number),
    },
    tickets: targetTickets,
    myPRs,
    recentlyMerged,
    reviewRequests: targetReviews,
    portfolioDigest,
  }
}

// --- LLM prompt (editorial only, targets only) ---

const SYSTEM_PROMPT = `You are a developer dashboard editorial processor. Given structured JSON context, return editorial metadata (titles, summaries, action selections) for a specific set of target items. The server merges this with mechanical fields — you don't need to produce state strings, priority labels, PR sub-items, CI status, daysWaiting, size, or any other derivable values, and the server orders items itself.

## Input

- \`targets.workItemIds\`: ticket identifiers (e.g. "ENG-260") and orphan-PR numbers as strings (e.g. "6701") that need workItem editorial.
- \`targets.reviewRequestNumbers\`: PR numbers (as numbers) that need reviewRequest editorial.
- \`tickets[]\`, \`myPRs[]\`, \`recentlyMerged[]\`, \`reviewRequests[]\`: full data for the target items. \`myPRs[]\` contains the open PRs linked to target tickets plus the target orphan PRs themselves.
- \`portfolioDigest[]\`: one line (id, title, state) for every OTHER item in the portfolio. Use it to reference dependency relationships in tldrs. NEVER produce editorial for digest items.

Return editorial for EVERY id in \`targets\` and ONLY those ids.

## workItems

For each id in \`targets.workItemIds\`:
- \`id\`: the target id exactly as given — ticket \`identifier\` (e.g. "ENG-260") or orphan PR \`number\` as a string (e.g. "6701")

- \`editorialTitle\`: shorten the original title to be scannable. Strip ticket prefixes ("ENG-260:", "feat(foo):") and verbose clauses. Aim for 3–8 words. Keep concrete nouns and action verbs.

- \`tldr\`: combine multiple data points into ONE natural sentence. This is the most important field. Use semicolons, em-dashes, and parentheticals to pack in substance — but it's still one sentence, not a paragraph. Target 15–30 words; go up to ~40 only when multiple distinct signals genuinely need surfacing (progress + blocker + gate).
  - **Never restate what the UI already shows as a visible label.** State ("In Review", "In Progress"), priority ("High"), and CI status all have their own labels/icons next to the item — don't repeat them in prose. You can reference "pending review" / "approved" / "changes requested" / "CI failing" / "merge conflict" **only when they are the notable signal** (e.g. "CI failing on both PRs; blocked on schema review"). If CI is green and review is pending, that's the default state — don't mention it. A merge conflict is always notable — name it.
  - Focus on what a reader wouldn't see from the icons alone: specific plan progress, named features/fields, blockers, what reviewers actually flagged, PR relationships, notable counts.
  - **Reviewers: \`reviews[]\` is reviews SUBMITTED; \`requestedReviewers[]\` is reviewers ASSIGNED but yet to respond. These are different.** Never claim "no reviewers" / "no reviewers yet" / "awaiting first review with no reviewers" when \`requestedReviewers\` is non-empty — that's a reviewer who simply hasn't reviewed yet. Say "awaiting review from \<name\>" instead. Only "no reviewers assigned" is accurate when BOTH \`reviews\` and \`requestedReviewers\` are empty.
  - **Never invent reviewer comments.** Only mention comments or a comment count when that person's login appears in \`reviews[]\` or \`comments[]\`. \`commentCount\` is human-only and matches \`comments[]\`. If both arrays are empty, say nothing about comments — bot and automation noise is already stripped. Bad: "awaiting review from alice with 3 comments" when \`reviews\` is empty and \`comments\` has no alice.
  - Draw from:
    - For tickets: ticket \`description\`, full \`workDocumentContent\` (plan steps, implementation notes, decisions — name specific features/fields it mentions), \`workDocParsed.progressContent\`, \`workDocParsed.blockersContent\` (always surface blockers), linked PR signals (review body text for what reviewers actually flagged; commentCount for human activity; labels for priority/status cues; \`hasMergeConflict\` when GitHub reports DIRTY — a real merge conflict). Weave the ticket's own \`tldr\` in only if it adds substance.
    - For orphan PRs: PR title, review body text, commentCount, labels, \`hasMergeConflict\`.
  - **Own landed PRs vs related merges.** If linked PRs have \`linkedTicketId\` equal to this ticket and they are Merged/Closed, this ticket's work already shipped — say Linear is still open, not that implementation remains. If \`recentlyMerged\` PRs belong to a *different* ticket (branch id ≠ this ticket) and \`myPRs\` has no open PR for this ticket, those merges are prerequisite context, not completion. Mention them as setup ("flag PRs already merged; this ticket still needs the backfill").
  - Good: "All frontend plan steps complete; PR #7965 (draft) awaiting review with 4 comments, builds on ENG-465 implementation."
  - Good: "Backend complete; both PRs in review with 6+ comments each; notifiedAt dedup, threshold exposure, and PDF generation all implemented and tested."
  - Good: "Frontend PR #7963 approved; blocked on backend PR (pending) — both must merge together."
  - Good: "Flag PRs already merged; still needs a sessionId backfill for legacy tracks before rollout."
  - Bad: "All backend PRs pushed, CI green. In Review. Manual gate still open." (repeats state + CI; multiple sentences)
  - Bad: "Add feature X" (just restates the title)
  - Bad: "PR is open and has reviews" (no specifics)

- \`actions\`: 2–4 dispatchable actions. Put the single most relevant action FIRST based on actual state:
  - Merge conflict on a linked PR (\`hasMergeConflict\`) → \`resolve-conflicts\` first
  - CI failure on a linked PR → \`investigate-ci\` first
  - Changes requested OR human review comments/nits on a linked PR → \`address-comments\` first (even if the PR is already approved — "LGTM with nits" still needs addressing; look at \`reviews[]\` bodies and \`commentCount\`)
  - Ticket in-progress, no work doc, and no own landed PR → \`create-plan\` first
  - Work doc exists, no open PR yet, and this ticket has no own merged/closed PR → \`implement\` first (merged related/prerequisite PRs on other tickets do not count as this ticket's PR)
  - This ticket's own PRs (branch ticket id matches) are all merged/closed and Linear is still open → \`housekeeping\` first. Do NOT pick \`ship-it\`, \`create-plan\`, \`implement\`, \`audit-pr\`, or \`review-pr\`
  - Related/prerequisite merges only (branch ticket id ≠ this ticket) and no own PR → \`create-plan\` or \`ship-it\` first, same as no-PR work
  - Fresh PR awaiting review → \`review-pr\` first
  - Prefer presets. Use custom actions only when no preset fits.

Available presets (use \`{ "presetId": "<id>" }\`):
${PRESET_LINES}

Custom actions (use \`{ "label": "<short label>", "mode": "<mode>", "instruction": "<agent prompt>" }\`):
- \`mode\` MUST be exactly one of: ${BRIEFING_ACTION_MODES.map(m => `"${m}"`).join(' | ')}. No other values.
- Keep label under 4 words. Keep instruction specific and contextual.

## reviewRequests

For each number in \`targets.reviewRequestNumbers\`:
- \`number\`: PR number (as a number, not a string)
- \`editorialTitle\`: shorten the title the same way as workItems
- \`tldr\`: ONE natural sentence. Cover what the PR does (from title), size hint ("small change", "large refactor"), and what reviewers specifically flagged — if anything notable. Don't repeat review state or CI status unless they're the notable signal. Target 12–25 words.
  - Good: "Large refactor (661 additions); changes requested + 1 comment — needs rework."
  - Good: "Adds payment-method deletion flow; small change (340 lines), no reviews yet."
  - Bad: "Review this PR" / "PR from @user" (no specifics)

## Rules

- Use ONLY the data provided. Never invent tickets, PRs, or statuses.
- **No markdown in editorial text.** Titles and tldrs are plain text — do NOT wrap PR numbers or ticket IDs in \`[text](url)\` links, and do not use any other markdown formatting. The UI renders PRs and tickets as their own clickable rows next to the tldr; a link inside the tldr is redundant and visually noisy.
- Editorial content: direct, scannable, specific.
- If a targets list is empty, return an empty array for that section.`

// --- Store rebuild: fresh editorial for targets, carry-over for the rest ---

function rebuildStore(
  oldStore: EditorialStore,
  editorial: BriefingEditorial | null,
  hashes: EditorialHashes,
  slim: BriefingView,
): EditorialStore {
  const freshWork = new Map((editorial?.workItems ?? []).map(w => [w.id, w]))
  const freshReviews = new Map((editorial?.reviewRequests ?? []).map(r => [r.number, r]))

  const titlesById = new Map<string, string>()
  for (const t of slim.tickets) titlesById.set(t.identifier, t.title)
  for (const p of slim.myPRs) titlesById.set(String(p.number), p.title)

  for (const id of freshWork.keys()) {
    if (!hashes.workItems.has(id)) console.warn(`[dashboard-briefing] unknown workItem id from LLM: ${id}`)
  }
  for (const n of freshReviews.keys()) {
    if (!hashes.reviewRequests.has(n)) console.warn(`[dashboard-briefing] unknown reviewRequest number from LLM: ${n}`)
  }

  // Rebuilding keyed on the current hashes also prunes entries for items that
  // left the portfolio, so the store can't grow unboundedly. Omitted targets
  // are pinned at the current hash (reusing stale prose, or a fallback for
  // brand-new items) so a persistent omission can't re-trigger an LLM call on
  // every poll.
  const store = emptyStore()
  for (const [id, hash] of hashes.workItems) {
    const fresh = freshWork.get(id)
    if (fresh) {
      store.workItems[id] = { hash, editorialTitle: fresh.editorialTitle, tldr: fresh.tldr, actions: fresh.actions }
      continue
    }
    const prev = oldStore.workItems[id]
    if (prev) {
      if (prev.hash !== hash) console.warn(`[dashboard-briefing] LLM omitted target workItem ${id} — reusing previous editorial`)
      store.workItems[id] = { ...prev, hash }
      continue
    }
    console.warn(`[dashboard-briefing] LLM omitted new workItem ${id} — storing fallback editorial`)
    store.workItems[id] = { hash, ...fallbackWorkItemEditorial(titlesById.get(id) ?? id) }
  }
  for (const [number, hash] of hashes.reviewRequests) {
    const key = String(number)
    const fresh = freshReviews.get(number)
    if (fresh) {
      store.reviewRequests[key] = { hash, editorialTitle: fresh.editorialTitle, tldr: fresh.tldr }
      continue
    }
    const prev = oldStore.reviewRequests[key]
    if (prev) {
      if (prev.hash !== hash) console.warn(`[dashboard-briefing] LLM omitted target reviewRequest #${number} — reusing previous editorial`)
      store.reviewRequests[key] = { ...prev, hash }
      continue
    }
    console.warn(`[dashboard-briefing] LLM omitted new reviewRequest #${number} — storing fallback editorial`)
    const title = slim.reviewRequests.find(p => p.number === number)?.title ?? key
    store.reviewRequests[key] = { hash, ...fallbackReviewEditorial(title) }
  }
  return store
}

// Generations run one at a time. A request arriving mid-generation waits, then
// diffs against the editorial store that generation just wrote, so overlapping
// requests (mount + context:updated, a second tab) don't pay for the same
// items twice — the per-item hashes leave nothing (or only real changes) to do.
const briefingQueue = globalThis as typeof globalThis & { __briefingQueue?: Promise<unknown> }

export async function POST(req: Request) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  // Server owns the context. Legacy clients may still send a `context` blob —
  // it is ignored (the server's own assembly is fresher and canonical).
  const { force } = await req.json() as { force?: boolean }

  const run = (briefingQueue.__briefingQueue ?? Promise.resolve()).then(() => handleBriefing(force))
  briefingQueue.__briefingQueue = run.catch(() => {})
  const { status, body } = await run
  return NextResponse.json(body, { status })
}

type BriefingResult = { status: number; body: Record<string, unknown> }
type DashboardCacheRow = typeof dashboardCache.$inferSelect

async function handleBriefing(force: boolean | undefined): Promise<BriefingResult> {
  let full: ContextData
  let contextJson: string
  try {
    full = await buildContextData()
    contextJson = JSON.stringify(full)
  } catch (err) {
    console.error('[dashboard-briefing] context assembly failed:', err)
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } }
  }
  const contextHash = hashContext(contextJson)

  const cached = db.select().from(dashboardCache).where(eq(dashboardCache.id, 1)).get()
  if (!force && cached && cached.contextHash === contextHash) {
    return { status: 200, body: { stale: false } }
  }

  return generateBriefing(full, contextJson, contextHash, cached, force)
}

async function generateBriefing(
  full: ContextData,
  contextJson: string,
  contextHash: string,
  cached: DashboardCacheRow | undefined,
  force: boolean | undefined,
): Promise<BriefingResult> {
  const t0 = Date.now()
  const slim = buildBriefingView(full)
  const hashes = computeEditorialHashes(slim)
  const store = parseEditorialStore(cached?.editorialJson, hashes)

  // Diff: an item needs editorial when it's new or its editorial-relevant
  // content changed. Force regenerates everything.
  const targets: DeltaTargets = {
    workItemIds: new Set(
      [...hashes.workItems].filter(([id, h]) => force || store.workItems[id]?.hash !== h).map(([id]) => id),
    ),
    reviewRequestNumbers: new Set(
      [...hashes.reviewRequests].filter(([n, h]) => force || store.reviewRequests[String(n)]?.hash !== h).map(([n]) => n),
    ),
  }

  let editorial: BriefingEditorial | null = null
  if (targets.workItemIds.size > 0 || targets.reviewRequestNumbers.size > 0) {
    try {
      const payload = buildDeltaPayload(slim, targets)
      const payloadJson = JSON.stringify(payload)
      console.log(`[dashboard-briefing] context ${contextJson.length}B → delta payload ${payloadJson.length}B`)
      console.log(`[dashboard-briefing] targets: workItems=${targets.workItemIds.size}/${hashes.workItems.size} reviewRequests=${targets.reviewRequestNumbers.size}/${hashes.reviewRequests.size}${force ? ' (force)' : ''}`)
      for (const p of payload.myPRs) {
        console.log(`[dashboard-briefing]   myPR #${p.number} status=${p.displayStatus} ci=${p.ciStatus} conflict=${p.hasMergeConflict} commentCount=${p.commentCount} reviews=[${p.reviews.map(r => r.state).join(',')}]`)
      }

      const t1 = Date.now()
      const result = await generateObject({
        model: anthropic('claude-sonnet-5'),
        system: SYSTEM_PROMPT,
        prompt: `Here is my current developer context as JSON. Produce the editorial JSON described above for the target items.\n\n${payloadJson}`,
        schema: llmBriefingEditorialSchema,
      })
      editorial = result.object
      console.log(`[dashboard-briefing] LLM ${Date.now() - t1}ms — input=${result.usage?.inputTokens ?? '?'} output=${result.usage?.outputTokens ?? '?'} total=${result.usage?.totalTokens ?? '?'} tokens`)
    } catch (err) {
      console.error('[dashboard-briefing] LLM generation failed:', err)
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } }
    }
  } else {
    console.log('[dashboard-briefing] no editorial targets — facts re-merged without LLM')
  }

  const newStore = rebuildStore(store, editorial, hashes, slim)
  const data = mergeBriefing(newStore, slim)
  console.log(`[dashboard-briefing] result workItems=${data.workItems.length} reviewRequests=${data.reviewRequests.length} — total ${Date.now() - t0}ms`)

  const editorialJson = JSON.stringify(newStore)
  if (cached) {
    db.update(dashboardCache)
      .set({
        contextHash,
        dashboardJson: JSON.stringify(data),
        editorialJson,
        updatedAt: new Date(),
      })
      .where(eq(dashboardCache.id, 1))
      .run()
  } else {
    db.insert(dashboardCache)
      .values({
        id: 1,
        contextHash,
        dashboardJson: JSON.stringify(data),
        editorialJson,
      })
      .run()
  }

  return { status: 200, body: { stale: false, data } }
}
