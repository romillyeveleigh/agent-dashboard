import { describe, it, expect } from 'vitest'
import { ciStatusFromRequiredRuns, computeCiStatus, mapPR } from '../github'

describe('computeCiStatus', () => {
  it('reports FAILURE when GitHub rollup state is FAILURE but the failing check is truncated out of the fetched contexts', () => {
    // 83 total checks, GitHub's authoritative rollup.state
    // is FAILURE, but the failing checks sort outside the contexts page we fetch.
    // The contexts we DO have are all green/skipped/waiting.
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { name: 'deploy / beta (l1)', status: 'WAITING', conclusion: null },
          { name: 'security-scan / Cosign', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'build / tag', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { context: 'security/snyk', state: 'SUCCESS' },
        ],
      },
    }
    expect(computeCiStatus(rollup)).toBe('FAILURE')
  })

  it('reports FAILURE when rollup.state is ERROR', () => {
    const rollup = {
      state: 'ERROR',
      contexts: { nodes: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    }
    expect(computeCiStatus(rollup)).toBe('FAILURE')
  })

  it('still upgrades a stuck-PENDING rollup to SUCCESS when only manual/waiting gates remain', () => {
    // The recompute path exists to ignore manual-trigger / deployment gates that
    // keep the rollup PENDING by design. That behaviour must be preserved.
    const rollup = {
      state: 'PENDING',
      contexts: {
        nodes: [
          { name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'deploy / beta (l1)', status: 'WAITING', conclusion: null },
        ],
      },
    }
    expect(computeCiStatus(rollup)).toBe('SUCCESS')
  })

  it('reports FAILURE when a failing check is visible in the fetched contexts', () => {
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { name: 'check web / checks', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      },
    }
    expect(computeCiStatus(rollup)).toBe('FAILURE')
  })

  it('does NOT report FAILURE when the only failing checks are non-required (mergeStateStatus UNSTABLE)', () => {
    // A frontend-only PR where trigger/detection jobs flake at the runner-setup
    // level. GitHub's rollup.state is FAILURE, but the PR is
    // MERGEABLE / UNSTABLE because every *required* check passed — those failures
    // don't block merge, so the dashboard must not surface a CI failure.
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { name: 'modified-services', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'modified-kubernetes-resources', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'modified-frontend', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'status-check', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'wait-for-betas', status: 'IN_PROGRESS', conclusion: null },
          { context: 'code/snyk', state: 'SUCCESS' },
        ],
      },
    }
    expect(computeCiStatus(rollup, 'UNSTABLE')).not.toBe('FAILURE')
    // Non-required jobs are still in progress → PENDING, never FAILURE.
    expect(computeCiStatus(rollup, 'UNSTABLE')).toBe('PENDING')
  })

  it('reports SUCCESS under UNSTABLE once all non-required failing checks have settled', () => {
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { name: 'modified-services', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'status-check', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'modified-frontend', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      },
    }
    expect(computeCiStatus(rollup, 'UNSTABLE')).toBe('SUCCESS')
  })

  it('still reports FAILURE for a required-check failure (BLOCKED, not UNSTABLE)', () => {
    // A genuinely failing REQUIRED check leaves the PR BLOCKED, never UNSTABLE.
    // DIRTY is merge conflicts, not a check failure.
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { name: 'check web / checks', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      },
    }
    expect(computeCiStatus(rollup, 'BLOCKED')).toBe('FAILURE')
    // And with the merge state unknown, fall back to honouring the rollup.
    expect(computeCiStatus(rollup, 'UNKNOWN')).toBe('FAILURE')
    expect(computeCiStatus(rollup)).toBe('FAILURE')
  })

  it('keeps reporting FAILURE for hard failures under BEHIND — BEHIND proves nothing', () => {
    // Optional trigger jobs failed while the required check passed. BEHIND cannot
    // be trusted to mean "non-required only" — the same shape also occurs with a
    // genuinely FAILED required check. So the rollup fallback stays red here, and
    // ciStatusFromRequiredRuns is what makes the first case green (see below).
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { name: 'pack-services-chart / commit', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'wait-for-rcs', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'dispatch-frontend-v2 / modified-services-ui', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'check services / checks', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'betas-deploy (l1)', status: 'WAITING', conclusion: null },
        ],
      },
    }
    expect(computeCiStatus(rollup, 'BEHIND')).toBe('FAILURE')
  })

  it('does NOT report FAILURE when rollup FAILURE is only from CANCELLED deploy jobs', () => {
    // Superseded beta deploys are CANCELLED, which
    // GitHub counts toward rollup.state=FAILURE even though every real check passed.
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { name: 'nx affected', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'deploy / beta (l1)', status: 'COMPLETED', conclusion: 'CANCELLED' },
          { name: 'deploy / beta (l2)', status: 'COMPLETED', conclusion: 'CANCELLED' },
          { name: 'betas-notify (n1)', status: 'COMPLETED', conclusion: 'CANCELLED' },
          { name: 'Self-Healing', status: 'COMPLETED', conclusion: 'NEUTRAL' },
        ],
      },
    }
    expect(computeCiStatus(rollup, 'BEHIND')).toBe('SUCCESS')
    // Same cancelled-only noise under BLOCKED (e.g. waiting on review) must not
    // surface as CI failure either — cancelled jobs don't block merge.
    expect(computeCiStatus(rollup, 'BLOCKED')).toBe('SUCCESS')
  })

  it('still reports FAILURE under BLOCKED when a hard failure is visible alongside CANCELLED jobs', () => {
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { name: 'dispatch-azure / plan', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'deploy / beta (l1)', status: 'COMPLETED', conclusion: 'CANCELLED' },
          { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      },
    }
    expect(computeCiStatus(rollup, 'BLOCKED')).toBe('FAILURE')
  })

  it('returns null when there is no rollup', () => {
    expect(computeCiStatus(null)).toBe(null)
  })

  it('does not treat DIRTY merge conflicts as a CI failure', () => {
    const rollup = {
      state: 'SUCCESS',
      contexts: {
        nodes: [
          { name: 'status-check', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      },
    }
    expect(computeCiStatus(rollup, 'DIRTY')).toBe('SUCCESS')
  })
})

describe('ciStatusFromRequiredRuns', () => {
  // The repo's ruleset requires one context (`status-check`); judging on it alone
  // is accurate where the rollup mis-flags non-required failures.
  it('reports SUCCESS when the required check is green despite a FAILURE rollup', () => {
    expect(ciStatusFromRequiredRuns([
      { name: 'status-check', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-07-28T16:25:30Z' },
    ])).toBe('SUCCESS')
  })

  it('reports FAILURE under BEHIND when the required check genuinely failed', () => {
    expect(ciStatusFromRequiredRuns([
      { name: 'status-check', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-07-28T09:14:02Z' },
    ])).toBe('FAILURE')
  })

  it('honours only the newest run when a re-dispatch leaves duplicates', () => {
    // 17 of 60 head commits returned the same required check from several suites.
    const runs = [
      { name: 'status-check', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-07-28T10:00:00Z' },
      { name: 'status-check', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-07-28T11:00:00Z' },
    ]
    expect(ciStatusFromRequiredRuns(runs)).toBe('SUCCESS')
    expect(ciStatusFromRequiredRuns([...runs].reverse())).toBe('SUCCESS')
  })

  it('treats a still-running or superseded required check as PENDING, not FAILURE', () => {
    expect(ciStatusFromRequiredRuns([
      { name: 'status-check', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-07-28T12:00:00Z' },
    ])).toBe('PENDING')
    // CANCELLED means a newer run superseded it — nothing for the human to fix.
    expect(ciStatusFromRequiredRuns([
      { name: 'status-check', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-07-28T12:00:00Z' },
    ])).toBe('PENDING')
  })

  it('returns null when no required run was found, so the caller keeps its fallback', () => {
    expect(ciStatusFromRequiredRuns([])).toBe(null)
  })

  it('fails when any one of several required checks fails', () => {
    expect(ciStatusFromRequiredRuns([
      { name: 'status-check', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-07-28T12:00:00Z' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-07-28T12:00:00Z' },
    ])).toBe('FAILURE')
  })
})

describe('mapPR requestedReviewers', () => {
  // A reviewer who has been ASKED but hasn't submitted a review must surface as a
  // requested reviewer — NOT be conflated with "no reviewers" by an empty reviews[]
  // (which would read as "awaiting first review (no reviewers yet)" while a
  // reviewer is assigned). Reviewers can be a User (login) or a Team (name).
  const baseNode = {
    number: 9131, title: 'Responsive folder tabs on mobile', url: 'http://x', isDraft: false,
    headRefName: 'eng-764-tabs', baseRefName: 'main', additions: 1, deletions: 1,
    updatedAt: '2026-06-05T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED', state: 'OPEN',
    author: { login: 'octocat' }, reviews: { nodes: [] }, comments: { totalCount: 0, nodes: [] },
  }

  it('captures a requested user reviewer even when no reviews have been submitted', () => {
    const pr = mapPR({
      ...baseNode,
      reviewRequests: { nodes: [{ requestedReviewer: { login: 'alice' } }] },
    })
    expect(pr.reviews).toEqual([])
    expect(pr.requestedReviewers).toEqual(['alice'])
  })

  it('uses team name for a requested team reviewer', () => {
    const pr = mapPR({
      ...baseNode,
      reviewRequests: { nodes: [{ requestedReviewer: { name: 'frontend-team' } }] },
    })
    expect(pr.requestedReviewers).toEqual(['frontend-team'])
  })

  it('drops empty/null reviewer entries and defaults to [] when absent', () => {
    const withNull = mapPR({
      ...baseNode,
      reviewRequests: { nodes: [{ requestedReviewer: null }, { requestedReviewer: { login: 'alice' } }] },
    })
    expect(withNull.requestedReviewers).toEqual(['alice'])
    expect(mapPR(baseNode).requestedReviewers).toEqual([])
  })
})

describe('mapPR displayStatus for closed PRs', () => {
  const closedNode = {
    number: 10651, title: 'feat(api): session-scoped tracks', url: 'http://x',
    isDraft: false, headRefName: 'session-scoped-tracks-store', baseRefName: 'main',
    additions: 1, deletions: 1, updatedAt: '2026-07-24T00:00:00Z', reviewDecision: null,
    state: 'CLOSED', headRef: null, author: { login: 'octocat' },
    reviews: { nodes: [] }, comments: { totalCount: 0, nodes: [] },
  }

  it('treats a closed-unmerged PR as Closed even though the branch was deleted', () => {
    expect(mapPR(closedNode).displayStatus).toBe('Closed')
  })

  it('treats a GitHub-merged PR as Merged', () => {
    expect(mapPR({ ...closedNode, state: 'MERGED' }).displayStatus).toBe('Merged')
  })
})

describe('mapPR hasMergeConflict', () => {
  const baseNode = {
    number: 11430, title: 'feat(web): recommended starting point', url: 'http://x',
    isDraft: false, headRefName: 'eng-1130-card', baseRefName: 'main',
    additions: 1, deletions: 1, updatedAt: '2026-08-25T00:00:00Z', reviewDecision: null,
    state: 'OPEN', author: { login: 'octocat' },
    reviews: { nodes: [] }, comments: { totalCount: 0, nodes: [] },
  }

  it('is true only when mergeStateStatus is DIRTY', () => {
    expect(mapPR({ ...baseNode, mergeStateStatus: 'DIRTY' }).hasMergeConflict).toBe(true)
    expect(mapPR({ ...baseNode, mergeStateStatus: 'CLEAN' }).hasMergeConflict).toBe(false)
    expect(mapPR({ ...baseNode, mergeStateStatus: 'BLOCKED' }).hasMergeConflict).toBe(false)
    expect(mapPR({ ...baseNode, mergeStateStatus: 'BEHIND' }).hasMergeConflict).toBe(false)
    expect(mapPR({ ...baseNode, mergeStateStatus: 'UNSTABLE' }).hasMergeConflict).toBe(false)
    expect(mapPR(baseNode).hasMergeConflict).toBe(false)
  })
})
