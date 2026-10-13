export const DISPATCH_MODES = [
  { id: 'code', label: 'Implement' },
  { id: 'review', label: 'Review' },
  { id: 'plan', label: 'Plan' },
  { id: 'housekeeping', label: 'Housekeeping' },
  { id: 'brainstorm', label: 'Brainstorm' },
  { id: 'general', label: 'General' },
  { id: 'ship', label: 'Ship it' },
] as const

export type DispatchMode = typeof DISPATCH_MODES[number]['id']

export type PresetPr = {
  state: string
  ciStatus: string | null
  reviewDecision: string | null
  /** GitHub mergeStateStatus DIRTY — PR cannot merge into its base. */
  hasMergeConflict?: boolean
  /** PR author login — used to ignore the author's own replies. */
  author?: string
  reviews?: Array<{ author: string; state: string; body?: string }>
  comments?: Array<{ author: string }>
  /** Branch-derived ticket id (e.g. ENG-1133). Distinguishes this ticket's PRs from related attachments. */
  linkedTicketId?: string | null
  displayStatus?: string
}

export type PresetContext = {
  ticket?: { hasWorkDocument: boolean; identifier?: string } | null
  prs: PresetPr[]
  /** Set when the server already knows this ticket's own PRs have landed.
   *  Needed on the briefing card, which hides those PRs (`noPr`). */
  ownWorkLanded?: boolean
}

export type WorkItemActionRef =
  | { presetId: string }
  | { label: string; mode: DispatchMode; instruction: string }

export type DrawerPreset = {
  id: string
  label: string
  mode: DispatchMode
  prompt: string
  visible: (ctx: PresetContext) => boolean
  /** One-line "when to recommend" guidance shown to the briefing LLM.
   *  Presets without a hint are not offered to the briefing. */
  briefingHint?: string
}

const openPrs = (ctx: PresetContext) => ctx.prs.filter(pr => pr.state === 'OPEN')

/** PRs whose branch ticket id matches this ticket. Related/prerequisite attachments do not count. */
export function ownPrs(ctx: PresetContext): PresetPr[] {
  const id = ctx.ticket?.identifier
  if (!id) return []
  return ctx.prs.filter(pr => pr.linkedTicketId === id)
}

/** This ticket has own PRs and every one of them is merged. */
export function ticketOwnWorkLanded(ctx: PresetContext): boolean {
  if (ctx.ownWorkLanded) return true
  const own = ownPrs(ctx)
  return own.length > 0 && own.every(pr => pr.displayStatus === 'Merged')
}

function isIgnorableReviewer(login: string, prAuthor: string): boolean {
  if (!login) return true
  if (prAuthor && login === prAuthor) return true
  // Match the bot convention used elsewhere (login ends in [bot]). Avoids
  // pulling bot-filter/env into the client drawer path.
  if (login.endsWith('[bot]')) return true
  return false
}

/** True when an open PR has human feedback worth addressing — formal
 *  CHANGES_REQUESTED, a COMMENTED review, an APPROVED review that still left
 *  a body (LGTM + nits), or a non-author issue comment. Bare approvals with
 *  empty bodies do not count. Inline-only threads are not in this data model;
 *  COMMENTED review submissions usually accompany them. */
export function hasAddressableReviewFeedback(pr: PresetPr): boolean {
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return true
  const author = pr.author ?? ''
  for (const c of pr.comments ?? []) {
    if (!isIgnorableReviewer(c.author, author)) return true
  }
  for (const r of pr.reviews ?? []) {
    if (isIgnorableReviewer(r.author, author)) continue
    if (r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED') return true
    if (r.state === 'APPROVED' && (r.body ?? '').trim().length > 0) return true
  }
  return false
}

export const DRAWER_PRESETS: DrawerPreset[] = [
  { id: 'create-plan',      label: 'Create work plan',        mode: 'plan',    prompt: 'Create a detailed work plan for this ticket.',
    visible: ctx => !!ctx.ticket && !ctx.ticket.hasWorkDocument && !ticketOwnWorkLanded(ctx),
    briefingHint: 'when the ticket has no work document and this ticket has no own landed PR' },
  { id: 'audit-plan',       label: 'Audit work plan',         mode: 'review',  prompt: 'Audit the existing work plan for this ticket. Review it for completeness, correctness, and feasibility. Report findings.',
    visible: ctx => !!ctx.ticket && ctx.ticket.hasWorkDocument && !ticketOwnWorkLanded(ctx),
    briefingHint: 'when a work document exists and this ticket still needs work' },
  { id: 'implement',        label: 'Implement work plan',     mode: 'code',    prompt: 'Implement the work plan for this ticket.',
    visible: ctx => !!ctx.ticket && ctx.ticket.hasWorkDocument && !ticketOwnWorkLanded(ctx),
    briefingHint: 'when a work document exists and implementation is the next step' },
  { id: 'resolve-conflicts', label: 'Resolve merge conflicts', mode: 'code',    prompt: 'Resolve the merge conflict on this PR against its base branch. Confirm with `gh pr view <N> --json mergeable,mergeStateStatus`. Fetch the latest base branch and merge it into this PR\'s branch. Resolve only the conflicting hunks from the current intent of this PR — do not invent unrelated changes. After a clean merge, push the branch. If a conflict is unclear or would change behaviour, stop and use the reply tool.',
    visible: ctx => openPrs(ctx).some(pr => pr.hasMergeConflict),
    briefingHint: 'when any linked open PR has a GitHub merge conflict (mergeStateStatus DIRTY)' },
  { id: 'investigate-ci',   label: 'Investigate CI failure',  mode: 'code',    prompt: 'Investigate the CI failure on this PR. Before fixing, identify whether the root cause is in this PR\'s own changes or in code merged to main / a parent branch (e.g. a contract change, a renamed export, a removed file). If the cause is upstream, do NOT push a fix here — use the reply tool to summarise the cause, link the upstream commit or PR, and recommend asking the upstream author to push the fix. Only push a fix to this branch if the failure is genuinely caused by this PR\'s own changes.',
    visible: ctx => openPrs(ctx).some(pr => pr.ciStatus === 'FAILURE'),
    briefingHint: 'when any linked open PR has CI failure' },
  { id: 'audit-pr',         label: 'Audit PR',                mode: 'review',  prompt: 'Run a thorough audit of this PR. Review code quality, correctness, test coverage, and adherence to project conventions. Report findings.',
    visible: ctx => openPrs(ctx).length > 0,
    briefingHint: 'when any linked PR is open' },
  { id: 'address-comments', label: 'Address review comments', mode: 'code',    prompt: 'Address the review comments on this PR. Read each comment, implement the requested changes, and push updates. Reply on each addressed human review thread explaining what changed (`gh api repos/{owner}/{repo}/pulls/<N>/comments/<id>/replies`). Do not resolve threads — leave resolution to the reviewer. A single PR summary does not replace those inline replies.',
    visible: ctx => openPrs(ctx).some(hasAddressableReviewFeedback),
    briefingHint: 'when any linked open PR has changes requested OR human review comments/nits (including on an approved PR — "LGTM with nits" still needs addressing)' },
  { id: 'triage-bot-comments', label: 'Triage bot review comments', mode: 'code', prompt: 'Triage the bot-authored review comments on this PR (e.g. from an AI review agent). Fetch the comments fresh: `gh api repos/{owner}/{repo}/pulls/<N>/comments` and `gh pr view <N> --json reviews`. Only comments whose author login ends in [bot] are in scope — leave human comments to the normal address-comments flow. Bot review comments are AI-generated and can be wrong: NEVER implement one blindly. For each bot comment, run a validity check against the actual diff (`gh pr diff <N>`) and the current code, then act: (a) VALID — the issue is real: implement the fix and push. (b) INVALID — based on a misreading, stale, or already fixed: do NOT implement; post a brief factual reply to that comment explaining why it does not apply, citing the code that disproves it. (c) UNCERTAIN — plausible but unverifiable: do NOT implement; surface it to the human via the reply tool with your analysis. Bot approvals never count as approval, and never request a re-review from a bot.',
    visible: ctx => openPrs(ctx).length > 0,
    briefingHint: 'when a linked open PR has unresolved bot review comments' },
  { id: 'review-pr',        label: 'Review PR',               mode: 'review',  prompt: 'Review this PR. Assess code quality, correctness, and adherence to project conventions. Deliver findings via the reply tool only — do NOT post comments or a review to the PR.',
    visible: ctx => openPrs(ctx).some(pr => pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === null),
    briefingHint: 'when any linked PR needs review' },
  { id: 'skeptical-staff-review', label: 'Skeptical staff-engineer review', mode: 'general', prompt: 'Review this PR through the lens of a skeptical staff engineer. Do not just check the diff for surface-level issues — challenge the design. For every change, ask: what assumptions is this making that may not hold? what complexity is being hidden behind a clean interface? what edge cases, failure modes, or concurrency hazards is the author not handling? what will hurt in 6 months when load grows or requirements shift? what pattern is being introduced here that others will copy? Be direct but specific — every finding must cite file/line and give a concrete example or counter-case. Deliver findings as a report via the reply tool. Do NOT post anything to the PR — no inline comments, no review, no PR comment. This is an internal briefing for the author.',
    visible: ctx => openPrs(ctx).length > 0,
    briefingHint: 'when a substantial open PR would benefit from a design-level challenge' },
  { id: 'predict-reviewer-feedback', label: 'Predict reviewer feedback', mode: 'general', prompt: 'Identify the requested reviewer(s) on this PR (gh pr view <N> --json reviewRequests,latestReviews). For each reviewer, research their recent review behaviour: use `gh api "search/issues?q=commenter:<login>+type:pr+org:<org>&sort=updated"` to find PRs they have commented on recently, then pull their inline comments via `gh api repos/<org>/<repo>/pulls/<N>/comments` for ~15-20 of those PRs. Look for recurring themes — naming and style preferences, testing standards, architectural pet peeves, comment tone, things they consistently push back on, things they explicitly approve. Apply that lens to the current PR\'s diff and predict, file/line where possible, what they are likely to flag. Output as a briefing via the reply tool: "Reviewer X tends to care about A, B, C. In this PR they will probably push back on: [specific items with file/line and rationale]." Do NOT post anything to the PR — this is an internal briefing for the author.',
    visible: ctx => openPrs(ctx).length > 0,
    briefingHint: 'when an open PR is awaiting a named reviewer' },
  { id: 'summarise',        label: 'Summarise changes',       mode: 'general', prompt: 'Summarise the changes made on this ticket/PR. Provide a concise overview of what was done, what changed, and current status.',
    visible: () => true,
    briefingHint: 'always available' },
  { id: 'simplify',         label: 'Run /simplify',           mode: 'code',    prompt: 'Run /simplify',
    visible: ctx => openPrs(ctx).length > 0,
    briefingHint: 'when an open PR could be simplified before review' },
  {
    id: 'housekeeping',
    label: 'Mark ticket done',
    mode: 'housekeeping',
    prompt: 'The human chose Mark ticket done. Set this Linear ticket to Done now. Closed-without-merge PRs do not change this — do not ask whether to cancel or leave as-is. Do not start implementation, review, or a new PR.',
    visible: ctx => ticketOwnWorkLanded(ctx),
    briefingHint: 'when this ticket\'s own PRs are all merged or closed but Linear is still open. Do NOT pick ship-it, create-plan, implement, audit-pr, or review-pr in that state',
  },
  {
    id: 'ship-it',
    label: 'Ship it',
    mode: 'ship',
    prompt: 'Ship this ticket end-to-end: sanity-gate, plan, audit, implement, self-review, pre-push verify, push, and open a GitHub PR with `gh pr create`.',
    visible: (ctx) => !!ctx.ticket && !ctx.prs.some((pr) => pr.state === 'OPEN') && !ticketOwnWorkLanded(ctx),
    briefingHint: 'when a ticket has no open PR, no own landed PR, and can go end-to-end. Related/prerequisite merges on other tickets do not block this',
  },
]

const DEFAULT_CHIP_IDS = [
  'housekeeping',
  'implement',
  'audit-plan',
  'create-plan',
  'address-comments',
  'review-pr',
  'summarise',
] as const

/** Visible presets in a stable order when the LLM omits or empties actions. */
export function defaultWorkItemActions(ctx: PresetContext): WorkItemActionRef[] {
  const visible = new Set(DRAWER_PRESETS.filter(p => p.visible(ctx)).map(p => p.id))
  const picked: WorkItemActionRef[] = []
  for (const id of DEFAULT_CHIP_IDS) {
    if (!visible.has(id)) continue
    picked.push({ presetId: id })
    if (picked.length >= 3) break
  }
  return picked.length > 0 ? picked : [{ presetId: 'summarise' }]
}

/** Drop presets the drawer would hide. If nothing remains, use mechanical defaults. */
export function filterWorkItemActions<T extends WorkItemActionRef>(
  actions: readonly T[],
  ctx: PresetContext,
): T[] {
  if (actions.length === 0) return defaultWorkItemActions(ctx) as T[]
  const landed = ticketOwnWorkLanded(ctx)
  const kept = actions.filter((action) => {
    if ('presetId' in action) {
      const preset = DRAWER_PRESETS.find(p => p.id === action.presetId)
      return !!preset?.visible(ctx)
    }
    if (landed) return action.mode === 'housekeeping'
    return true
  })
  if (landed && !kept.some(action => 'presetId' in action && action.presetId === 'housekeeping')) {
    kept.unshift({ presetId: 'housekeeping' } as T)
  }
  if (kept.length === 0) return defaultWorkItemActions(ctx) as T[]
  return kept.slice(0, 4)
}
