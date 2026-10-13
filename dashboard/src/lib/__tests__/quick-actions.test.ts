import { describe, expect, it } from 'vitest'
import {
  DRAWER_PRESETS,
  filterWorkItemActions,
  hasAddressableReviewFeedback,
  ticketOwnWorkLanded,
  type PresetContext,
  type PresetPr,
} from '../quick-actions'

function pr(overrides: Partial<PresetPr> = {}): PresetPr {
  return {
    state: 'OPEN',
    ciStatus: null,
    reviewDecision: null,
    author: 'me',
    reviews: [],
    comments: [],
    ...overrides,
  }
}

describe('hasAddressableReviewFeedback', () => {
  it('true when reviewDecision is CHANGES_REQUESTED', () => {
    expect(hasAddressableReviewFeedback(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe(true)
  })

  it('true for APPROVED review that left a body (LGTM + nits)', () => {
    expect(hasAddressableReviewFeedback(pr({
      reviewDecision: 'APPROVED',
      reviews: [{ author: 'reviewer', state: 'APPROVED', body: 'LGTM — please fix the nits above' }],
    }))).toBe(true)
  })

  it('true for COMMENTED review even with empty body', () => {
    expect(hasAddressableReviewFeedback(pr({
      reviews: [{ author: 'reviewer', state: 'COMMENTED', body: '' }],
    }))).toBe(true)
  })

  it('true for non-author issue comments', () => {
    expect(hasAddressableReviewFeedback(pr({
      comments: [{ author: 'reviewer' }],
    }))).toBe(true)
  })

  it('false for bare APPROVED with empty body and no other feedback', () => {
    expect(hasAddressableReviewFeedback(pr({
      reviewDecision: 'APPROVED',
      reviews: [{ author: 'reviewer', state: 'APPROVED', body: '   ' }],
    }))).toBe(false)
  })

  it('ignores author self-comments and bot logins', () => {
    expect(hasAddressableReviewFeedback(pr({
      comments: [{ author: 'me' }, { author: 'coderabbitai[bot]' }],
      reviews: [{ author: 'me', state: 'COMMENTED', body: 'ping' }],
    }))).toBe(false)
  })
})

describe('address-comments preset visibility', () => {
  const preset = DRAWER_PRESETS.find(p => p.id === 'address-comments')!

  it('shows for approved PR with nit body', () => {
    expect(preset.visible({
      prs: [pr({
        reviewDecision: 'APPROVED',
        reviews: [{ author: 'reviewer', state: 'APPROVED', body: 'left more comments' }],
      })],
    })).toBe(true)
  })

  it('hides when open PR has no human feedback', () => {
    expect(preset.visible({
      prs: [pr({ reviewDecision: 'APPROVED', reviews: [{ author: 'reviewer', state: 'APPROVED', body: '' }] })],
    })).toBe(false)
  })

  it('requires a reply on each addressed human thread without resolving', () => {
    const prompt = preset.prompt.toLowerCase()
    expect(prompt).toMatch(/reply/)
    expect(prompt).toMatch(/each addressed human (review )?thread/)
    expect(prompt).toMatch(/do not resolve|don't resolve|leave .* unresolved/)
    expect(prompt).toMatch(/comments\/<id>\/replies|comments\/<comment_id>\/replies/)
  })
})

describe('resolve-conflicts preset visibility', () => {
  const preset = DRAWER_PRESETS.find(p => p.id === 'resolve-conflicts')!

  it('shows when an open PR has a GitHub merge conflict', () => {
    expect(preset.visible({ prs: [pr({ hasMergeConflict: true })] })).toBe(true)
  })

  it('hides when open PRs have no merge conflict', () => {
    expect(preset.visible({ prs: [pr({ ciStatus: 'FAILURE' })] })).toBe(false)
    expect(preset.visible({ prs: [pr()] })).toBe(false)
  })
})

function ticketCtx(overrides: Partial<PresetContext> = {}): PresetContext {
  return {
    ticket: { hasWorkDocument: true, identifier: 'ENG-1133' },
    prs: [],
    ...overrides,
  }
}

function ownMergedPr(overrides: Partial<PresetPr> = {}): PresetPr {
  return pr({
    state: 'CLOSED',
    linkedTicketId: 'ENG-1133',
    displayStatus: 'Merged',
    ...overrides,
  })
}

describe('ticketOwnWorkLanded', () => {
  it('true when every own PR is merged', () => {
    expect(ticketOwnWorkLanded(ticketCtx({
      prs: [ownMergedPr(), ownMergedPr({ linkedTicketId: 'ENG-1133' })],
    }))).toBe(true)
  })

  it('false when an own PR is still open', () => {
    expect(ticketOwnWorkLanded(ticketCtx({
      prs: [ownMergedPr(), pr({ linkedTicketId: 'ENG-1133' })],
    }))).toBe(false)
  })

  it('false when only related/prerequisite PRs have landed', () => {
    expect(ticketOwnWorkLanded(ticketCtx({
      prs: [pr({ state: 'CLOSED', linkedTicketId: 'ENG-1131', displayStatus: 'Merged' })],
    }))).toBe(false)
  })

  it('false when the ticket has no PRs', () => {
    expect(ticketOwnWorkLanded(ticketCtx())).toBe(false)
  })
})

describe('housekeeping vs ship-it visibility', () => {
  const housekeeping = DRAWER_PRESETS.find(p => p.id === 'housekeeping')!
  const ship = DRAWER_PRESETS.find(p => p.id === 'ship-it')!
  const createPlan = DRAWER_PRESETS.find(p => p.id === 'create-plan')!
  const implement = DRAWER_PRESETS.find(p => p.id === 'implement')!
  const auditPr = DRAWER_PRESETS.find(p => p.id === 'audit-pr')!
  const reviewPr = DRAWER_PRESETS.find(p => p.id === 'review-pr')!

  const landed = ticketCtx({ prs: [ownMergedPr()] })
  const relatedOnly = ticketCtx({
    prs: [pr({ state: 'CLOSED', linkedTicketId: 'ENG-1131', displayStatus: 'Merged' })],
  })
  const noPrs = ticketCtx()

  it('mark-done prompt sets Done without asking', () => {
    expect(housekeeping.prompt).toMatch(/Set this Linear ticket to Done/i)
    expect(housekeeping.prompt).toMatch(/do not ask whether to cancel/i)
  })

  it('shows housekeeping when this ticket\'s own PRs have landed', () => {
    expect(housekeeping.visible(landed)).toBe(true)
    expect(ship.visible(landed)).toBe(false)
    expect(createPlan.visible(landed)).toBe(false)
    expect(implement.visible(landed)).toBe(false)
    expect(auditPr.visible(landed)).toBe(false)
    expect(reviewPr.visible(landed)).toBe(false)
  })

  it('shows ship-it when there are no PRs yet', () => {
    expect(housekeeping.visible(noPrs)).toBe(false)
    expect(ship.visible(noPrs)).toBe(true)
  })

  it('shows ship-it when only another ticket\'s PRs have landed', () => {
    expect(housekeeping.visible(relatedOnly)).toBe(false)
    expect(ship.visible(relatedOnly)).toBe(true)
    expect(implement.visible(relatedOnly)).toBe(true)
  })
})

describe('filterWorkItemActions', () => {
  it('replaces audit/review chips with housekeeping when own PRs have landed', () => {
    const ctx = ticketCtx({ prs: [ownMergedPr()] })
    expect(filterWorkItemActions(
      [{ presetId: 'audit-pr' }, { presetId: 'review-pr' }, { presetId: 'summarise' }],
      ctx,
    )).toEqual([{ presetId: 'housekeeping' }, { presetId: 'summarise' }])
  })

  it('drops ship-it and create-plan when own PRs have landed', () => {
    const ctx = ticketCtx({ ticket: { hasWorkDocument: false, identifier: 'ENG-1133' }, prs: [ownMergedPr()] })
    expect(filterWorkItemActions(
      [{ presetId: 'ship-it' }, { presetId: 'create-plan' }],
      ctx,
    )).toEqual([{ presetId: 'housekeeping' }])
  })

  it('drops custom review actions when own PRs have landed', () => {
    const ctx = ticketCtx({ prs: [ownMergedPr()] })
    expect(filterWorkItemActions(
      [{ label: 'Review PR', mode: 'review', instruction: 'Review this PR.' }],
      ctx,
    )).toEqual([{ presetId: 'housekeeping' }])
  })

  it('keeps ship-it for a ticket with no own PR', () => {
    expect(filterWorkItemActions(
      [{ presetId: 'ship-it' }, { presetId: 'summarise' }],
      ticketCtx(),
    )).toEqual([{ presetId: 'ship-it' }, { presetId: 'summarise' }])
  })

  it('fills implement and audit-plan when the LLM omits actions for a planned ticket', () => {
    expect(filterWorkItemActions([], ticketCtx())).toEqual([
      { presetId: 'implement' },
      { presetId: 'audit-plan' },
      { presetId: 'summarise' },
    ])
  })

  it('fills mark-done when the LLM omits actions for a landed ticket', () => {
    expect(filterWorkItemActions([], ticketCtx({ prs: [ownMergedPr()] }))).toEqual([
      { presetId: 'housekeeping' },
      { presetId: 'summarise' },
    ])
  })
})
