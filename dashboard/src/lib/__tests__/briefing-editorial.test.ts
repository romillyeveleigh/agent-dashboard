import { describe, expect, it } from 'vitest'
import { isTerminalPrStatus, llmBriefingEditorialSchema, orderOrphanPrs, orderTickets, selectVisibleLinkedPrs, type BriefingPr, type BriefingTicket, type BriefingView } from '../briefing-editorial'

describe('isTerminalPrStatus', () => {
  it('treats Merged and Closed as terminal', () => {
    expect(isTerminalPrStatus('Merged')).toBe(true)
    expect(isTerminalPrStatus('Closed')).toBe(true)
  })

  it('treats open review states as non-terminal', () => {
    expect(isTerminalPrStatus('Draft')).toBe(false)
    expect(isTerminalPrStatus('Approved')).toBe(false)
    expect(isTerminalPrStatus('Changes req.')).toBe(false)
    expect(isTerminalPrStatus('Pending')).toBe(false)
  })
})

describe('selectVisibleLinkedPrs', () => {
  it('hides all-merged related PRs so a Ready ticket looks like no-PR work', () => {
    const linked = [
      { number: 10673, displayStatus: 'Merged' },
      { number: 10672, displayStatus: 'Merged' },
    ]
    expect(selectVisibleLinkedPrs(linked)).toEqual([])
  })

  it('keeps merged siblings when an open PR remains', () => {
    const linked = [
      { number: 1, displayStatus: 'Merged' },
      { number: 2, displayStatus: 'Pending' },
    ]
    expect(selectVisibleLinkedPrs(linked)).toEqual(linked)
  })

  it('returns open PRs as-is', () => {
    const linked = [
      { number: 1, displayStatus: 'Draft' },
      { number: 2, displayStatus: 'Approved' },
    ]
    expect(selectVisibleLinkedPrs(linked)).toEqual(linked)
  })
})

function briefingPr(overrides: Partial<BriefingPr> = {}): BriefingPr {
  return {
    number: 1,
    title: 't',
    url: 'http://x',
    headRefName: 'branch',
    additions: 1,
    deletions: 1,
    updatedAt: '2026-09-03T00:00:00Z',
    displayStatus: 'Pending',
    ciStatus: 'SUCCESS',
    commentCount: 0,
    linkedTicketId: null,
    labels: [],
    reviews: [],
    requestedReviewers: [],
    comments: [],
    hasMergeConflict: false,
    ...overrides,
  }
}

function emptyView(overrides: Partial<BriefingView> = {}): BriefingView {
  return {
    tickets: [],
    myPRs: [],
    recentlyMerged: [],
    reviewRequests: [],
    housekeeping: [],
    ...overrides,
  }
}

describe('orderOrphanPrs', () => {
  it('ranks a merge conflict above a CI failure', () => {
    const slim = emptyView({
      myPRs: [
        briefingPr({ number: 1, ciStatus: 'FAILURE' }),
        briefingPr({ number: 2, hasMergeConflict: true }),
      ],
    })
    expect(orderOrphanPrs(slim).map(p => p.number)).toEqual([2, 1])
  })
})

describe('orderTickets', () => {
  it('ranks a ticket with a merge-conflict PR first', () => {
    const ticket = (id: string, linked: number[]): BriefingTicket => ({
      identifier: id,
      url: 'http://x',
      title: id,
      description: null,
      tldr: null,
      state: { name: 'In Progress' },
      priority: 3,
      hasWorkDocument: false,
      workDocumentContent: null,
      workDocParsed: null,
      linkedPrNumbers: linked,
      hasManualSteps: false,
      manualStepsStatus: null,
    })
    const slim = emptyView({
      tickets: [ticket('ENG-1', [1]), ticket('ENG-2', [2])],
      myPRs: [
        briefingPr({ number: 1, ciStatus: 'FAILURE' }),
        briefingPr({ number: 2, hasMergeConflict: true }),
      ],
    })
    expect(orderTickets(slim).map(t => t.identifier)).toEqual(['ENG-2', 'ENG-1'])
  })
})

describe('llmBriefingEditorialSchema', () => {
  it('accepts workItems that omit actions and defaults them to []', () => {
    const parsed = llmBriefingEditorialSchema.parse({
      reviewRequests: [{
        number: 11454,
        editorialTitle: 'Serve latest results from live task rows',
        tldr: 'Serves latest results from live task rows.',
      }],
      workItems: [{
        id: 'ENG-1136',
        editorialTitle: 'Serve aiFrequency for expand workflow today',
        tldr: 'PR #11862 adds aiFrequency to the expand panel.',
      }],
    })
    expect(parsed.workItems[0].actions).toEqual([])
  })
})
