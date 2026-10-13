import { describe, expect, it } from 'vitest'
import {
  isInactiveLinearStateType,
  LINEAR_INACTIVE_STATE_TYPES,
  type LinearTicket,
} from '../linear-data'
import { scrubInactiveLinearTickets, type LinearData } from '../context-fetchers'

describe('LINEAR_INACTIVE_STATE_TYPES', () => {
  it('uses Linear API spelling and includes duplicate', () => {
    expect(LINEAR_INACTIVE_STATE_TYPES).toEqual(['completed', 'canceled', 'duplicate'])
  })
})

describe('isInactiveLinearStateType', () => {
  it('treats completed, canceled, and duplicate as inactive', () => {
    expect(isInactiveLinearStateType('completed')).toBe(true)
    expect(isInactiveLinearStateType('canceled')).toBe(true)
    expect(isInactiveLinearStateType('duplicate')).toBe(true)
  })

  it('keeps active work types', () => {
    expect(isInactiveLinearStateType('started')).toBe(false)
    expect(isInactiveLinearStateType('unstarted')).toBe(false)
    expect(isInactiveLinearStateType('backlog')).toBe(false)
    expect(isInactiveLinearStateType('triage')).toBe(false)
  })

  it('does not treat the British spelling as Linear API canceled', () => {
    // Linear's enum is "canceled". The British form must not silently match
    // and must not be what we send in GraphQL filters.
    expect(isInactiveLinearStateType('cancelled')).toBe(false)
  })

  it('handles missing types', () => {
    expect(isInactiveLinearStateType(null)).toBe(false)
    expect(isInactiveLinearStateType(undefined)).toBe(false)
    expect(isInactiveLinearStateType('')).toBe(false)
  })
})

function ticket(identifier: string, type: string): LinearTicket {
  return {
    id: identifier,
    identifier,
    title: identifier,
    description: null,
    tldr: null,
    state: { name: type, type },
    priority: 0,
    team: { key: 'ENG', name: 'Engineering' },
    assignee: null,
    labels: [],
    url: `https://linear.app/${identifier}`,
    cycleName: null,
    hasWorkDocument: false,
    workDocumentId: null,
    workDocumentUrl: null,
    workDocumentContent: null,
    workDocParsed: null,
    linkedPrNumbers: [],
    branchName: null,
    hasManualSteps: false,
    updatedAt: null,
  }
}

describe('scrubInactiveLinearTickets', () => {
  it('removes duplicate tickets from a stale cache payload', () => {
    const data: LinearData = {
      tickets: {
        readyToImplement: [ticket('ENG-1', 'unstarted')],
        needsPlanning: [],
        blocked: [],
        housekeeping: [],
        inProgress: [ticket('ENG-1061', 'duplicate')],
      },
      cycles: [],
      allTickets: [ticket('ENG-1', 'unstarted'), ticket('ENG-1061', 'duplicate')],
      unassignedTickets: [],
      completedTickets: [],
      hiddenTicketIds: ['ENG-859'],
      hiddenPrNumbers: [],
    }

    const scrubbed = scrubInactiveLinearTickets(data)
    expect(scrubbed.allTickets.map(t => t.identifier)).toEqual(['ENG-1'])
    expect(scrubbed.tickets.inProgress).toEqual([])
    expect(scrubbed.hiddenTicketIds).toEqual(['ENG-859', 'ENG-1061'])
  })
})
