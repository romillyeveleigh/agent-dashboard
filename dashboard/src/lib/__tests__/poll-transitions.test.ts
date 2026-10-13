import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  computeDispatchDecision,
  type DecisionInput,
  type PRStatePayload,
} from '../poll-transitions'

// `shouldSkipDispatch` reads ON_HOLD_LABELS lazily. Keep env clean across tests
// so the ci-external / on-hold label expectations are independent of host env.
const ORIGINAL_ENV = process.env.ON_HOLD_LABELS
beforeEach(() => { delete process.env.ON_HOLD_LABELS })
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ON_HOLD_LABELS
  else process.env.ON_HOLD_LABELS = ORIGINAL_ENV
})

const baseInput = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  prev: null,
  current: {
    ciStatus: 'PENDING',
    humanCommentCount: 0,
    reviewDecision: null,
    headSha: 'sha0',
    state: 'OPEN',
    displayStatus: 'Draft',
  },
  ciRounds: 0,
  mainCiStatus: 'SUCCESS',
  baseCiStatus: null,
  pausedAt: null,
  labels: [],
  ...over,
})

const prev = (over: Partial<PRStatePayload> = {}): PRStatePayload => ({
  ciStatus: null,
  humanCommentCount: 0,
  reviewDecision: null,
  headSha: 'sha0',
  failedHeadShas: [],
  rerunAttemptedShas: [],
  botCommentCount: null,
  observedAt: '2026-04-18T00:00:00Z',
  ...over,
})

describe('computeDispatchDecision', () => {
  describe('CI transitions', () => {
    it('first poll (prev=null) with FAILURE emits rerun-ci (try cheap rerun before container)', () => {
      const items = computeDispatchDecision(baseInput({
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([
        { kind: 'rerun-ci' },
        { kind: 'rerun-attempted', sha: 'sha1' },
      ])
    })

    it('FAILURE → FAILURE does not re-dispatch', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'FAILURE', headSha: 'sha1' }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([])
    })

    it('FAILURE → SUCCESS emits ci-success-observed (reset trigger)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'FAILURE', headSha: 'sha1' }),
        current: { ciStatus: 'SUCCESS', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([{ kind: 'ci-success-observed' }])
    })

    it('SUCCESS → FAILURE emits rerun-ci (fresh SHA, no prior rerun attempt)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'SUCCESS', headSha: 'sha1', failedHeadShas: [] }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha2', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([
        { kind: 'rerun-ci' },
        { kind: 'rerun-attempted', sha: 'sha2' },
      ])
    })

    it('second failure for same SHA after rerun attempted dispatches fix-ci', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'PENDING', headSha: 'sha2', rerunAttemptedShas: ['sha2'] }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha2', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([
        { kind: 'dispatch-ci' },
        { kind: 'ci-failure-observed', sha: 'sha2' },
      ])
    })

    it('failedHeadShas takes precedence over rerunAttemptedShas (flake-suspected wins)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'PENDING', headSha: 'sha2', failedHeadShas: ['sha2'], rerunAttemptedShas: ['sha2'] }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha2', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([{ kind: 'skip-ci', reason: 'flake-suspected' }])
    })

    it('ciRounds at budget with no intervening SUCCESS skips with reason=budget-exhausted', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'SUCCESS', headSha: 'sha1' }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha2', state: 'OPEN', displayStatus: 'Draft' },
        ciRounds: 3,
      }))
      expect(items).toEqual([{ kind: 'skip-ci', reason: 'budget-exhausted' }])
    })

    it('main CI failure → skip-ci (main-broken)', () => {
      const items = computeDispatchDecision(baseInput({
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
        mainCiStatus: 'FAILURE',
      }))
      expect(items).toEqual([{ kind: 'skip-ci', reason: 'main-broken' }])
    })

    it('stack-below CI failure → skip-ci (stack-below-broken)', () => {
      const items = computeDispatchDecision(baseInput({
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
        baseCiStatus: 'FAILURE',
      }))
      expect(items).toEqual([{ kind: 'skip-ci', reason: 'stack-below-broken' }])
    })

    it('same headSha already in failedHeadShas → skip-ci (flake-suspected)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'SUCCESS', headSha: 'sha1', failedHeadShas: ['sha2'] }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha2', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([{ kind: 'skip-ci', reason: 'flake-suspected' }])
    })
  })

  describe('comment / review transitions', () => {
    it('humanCommentCount increase dispatches address-comments', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ humanCommentCount: 0 }),
        current: { ciStatus: 'PENDING', humanCommentCount: 1, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Pending' },
      }))
      expect(items).toEqual([{ kind: 'dispatch-comments' }])
    })

    it('humanCommentCount stays flat → no dispatch (bot-only comments filtered upstream)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ humanCommentCount: 2 }),
        current: { ciStatus: 'PENDING', humanCommentCount: 2, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Pending' },
      }))
      expect(items).toEqual([])
    })

    it('reviewDecision transition to CHANGES_REQUESTED dispatches', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ reviewDecision: null }),
        current: { ciStatus: 'PENDING', humanCommentCount: 0, reviewDecision: 'CHANGES_REQUESTED', headSha: 'sha1', state: 'OPEN', displayStatus: 'Changes req.' },
      }))
      expect(items).toEqual([{ kind: 'dispatch-comments' }])
    })

    it('APPROVED + comment bump → skip-comments (approval rule)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ humanCommentCount: 0, reviewDecision: 'APPROVED' }),
        current: { ciStatus: 'PENDING', humanCommentCount: 1, reviewDecision: 'APPROVED', headSha: 'sha1', state: 'OPEN', displayStatus: 'Approved' },
      }))
      expect(items).toEqual([{ kind: 'skip-comments', reason: 'approved' }])
    })

    it('APPROVED + CI failure still emits rerun-ci (merge blocked until green)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'SUCCESS', reviewDecision: 'APPROVED', headSha: 'sha1' }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: 'APPROVED', headSha: 'sha2', state: 'OPEN', displayStatus: 'Approved' },
      }))
      expect(items).toEqual([
        { kind: 'rerun-ci' },
        { kind: 'rerun-attempted', sha: 'sha2' },
      ])
    })
  })

  describe('bot pre-review transitions (Phase 4)', () => {
    it('bot comment bump dispatches bot-triage', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ botCommentCount: 0 }),
        current: { ciStatus: 'PENDING', humanCommentCount: 0, botCommentCount: 1, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Pending' },
      }))
      expect(items).toEqual([{ kind: 'dispatch-bot-triage' }])
    })

    it('bot count flat → no dispatch', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ botCommentCount: 2 }),
        current: { ciStatus: 'PENDING', humanCommentCount: 0, botCommentCount: 2, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Pending' },
      }))
      expect(items).toEqual([])
    })

    it('bot bump on APPROVED PR → skip-bot-triage (approval rule)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ botCommentCount: 0, reviewDecision: 'APPROVED' }),
        current: { ciStatus: 'PENDING', humanCommentCount: 0, botCommentCount: 1, reviewDecision: 'APPROVED', headSha: 'sha1', state: 'OPEN', displayStatus: 'Approved' },
      }))
      expect(items).toEqual([{ kind: 'skip-bot-triage', reason: 'approved' }])
    })

    it('bot bump with budget exhausted → skip-bot-triage (budget-exhausted)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ botCommentCount: 0 }),
        current: { ciStatus: 'PENDING', humanCommentCount: 0, botCommentCount: 1, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Pending' },
        botTriageRounds: 2,
      }))
      expect(items).toEqual([{ kind: 'skip-bot-triage', reason: 'budget-exhausted' }])
    })

    it('prev botCommentCount null (pre-upgrade state row) → baseline only, no dispatch', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev(), // botCommentCount: null from helper default
        current: { ciStatus: 'PENDING', humanCommentCount: 0, botCommentCount: 3, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Pending' },
      }))
      expect(items).toEqual([])
    })

    it('prev=null (first ever poll) → baseline only, no dispatch on historical bot comments', () => {
      const items = computeDispatchDecision(baseInput({
        prev: null,
        current: { ciStatus: 'PENDING', humanCommentCount: 0, botCommentCount: 3, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Pending' },
      }))
      expect(items).toEqual([])
    })

    it('human bump + bot bump in same poll dispatch both kinds', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ humanCommentCount: 0, botCommentCount: 0 }),
        current: { ciStatus: 'PENDING', humanCommentCount: 1, botCommentCount: 1, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Pending' },
      }))
      expect(items).toContainEqual({ kind: 'dispatch-comments' })
      expect(items).toContainEqual({ kind: 'dispatch-bot-triage' })
    })
  })

  describe('global gates', () => {
    it('PR state=CLOSED not-merged → terminal, nothing else', () => {
      const items = computeDispatchDecision(baseInput({
        current: { ciStatus: 'FAILURE', humanCommentCount: 5, reviewDecision: 'CHANGES_REQUESTED', headSha: 'sha1', state: 'CLOSED', displayStatus: 'Closed' },
      }))
      expect(items).toEqual([{ kind: 'terminal', reason: 'closed-not-merged' }])
    })

    it('pausedAt set → skip-all', () => {
      const items = computeDispatchDecision(baseInput({
        current: { ciStatus: 'FAILURE', humanCommentCount: 1, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
        pausedAt: new Date(),
      }))
      expect(items).toEqual([{ kind: 'skip-all', reason: 'paused' }])
    })

    it('on-hold label present → skip-all', () => {
      const items = computeDispatchDecision(baseInput({
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
        labels: ['on-hold'],
      }))
      expect(items[0]).toEqual({ kind: 'skip-all', reason: 'on-hold-label:on-hold' })
    })

    it('ci-external label (default on-hold list) → skip-all', () => {
      const items = computeDispatchDecision(baseInput({
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
        labels: ['ci-external'],
      }))
      expect(items[0]).toEqual({ kind: 'skip-all', reason: 'on-hold-label:ci-external' })
    })
  })

  describe('combined signals', () => {
    it('CI failure + comment bump in same poll emits rerun-ci and dispatch-comments', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'SUCCESS', humanCommentCount: 0, headSha: 'sha1' }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 2, reviewDecision: 'CHANGES_REQUESTED', headSha: 'sha2', state: 'OPEN', displayStatus: 'Changes req.' },
      }))
      expect(items).toContainEqual({ kind: 'rerun-ci' })
      expect(items).toContainEqual({ kind: 'rerun-attempted', sha: 'sha2' })
      expect(items).toContainEqual({ kind: 'dispatch-comments' })
    })
  })

  describe('CI rerun lifecycle (rerun → retry fails → fix-ci → success resets)', () => {
    // Simulates the full poll-cycle sequence for an infra flake that persists:
    //   Poll 1: CI FAILURE (first time)         → rerun-ci + rerun-attempted
    //   Poll 2: CI PENDING (rerun in progress)  → no action
    //   Poll 3: CI FAILURE (rerun didn't help)  → dispatch-ci + ci-failure-observed
    //   Poll 4: CI SUCCESS (agent fixed it)     → ci-success-observed (resets everything)
    //   Poll 5: CI FAILURE on new SHA           → rerun-ci again (fresh SHA, rerunAttemptedShas was reset)

    it('poll 1: first FAILURE → rerun-ci + rerun-attempted', () => {
      const items = computeDispatchDecision(baseInput({
        prev: null,
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([
        { kind: 'rerun-ci' },
        { kind: 'rerun-attempted', sha: 'sha1' },
      ])
    })

    it('poll 2: PENDING after rerun → no action', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'FAILURE', headSha: 'sha1', rerunAttemptedShas: ['sha1'] }),
        current: { ciStatus: 'PENDING', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([])
    })

    it('poll 3: FAILURE again after rerun → dispatch-ci (rerun already attempted)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'PENDING', headSha: 'sha1', rerunAttemptedShas: ['sha1'] }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([
        { kind: 'dispatch-ci' },
        { kind: 'ci-failure-observed', sha: 'sha1' },
      ])
    })

    it('poll 4: SUCCESS after fix → ci-success-observed (resets rerunAttemptedShas)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'FAILURE', headSha: 'sha1', rerunAttemptedShas: ['sha1'], failedHeadShas: ['sha1'] }),
        current: { ciStatus: 'SUCCESS', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([{ kind: 'ci-success-observed' }])
    })

    it('poll 5: FAILURE on new SHA after reset → rerun-ci again (fresh start)', () => {
      const items = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'SUCCESS', headSha: 'sha1', rerunAttemptedShas: [], failedHeadShas: [] }),
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha2', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(items).toEqual([
        { kind: 'rerun-ci' },
        { kind: 'rerun-attempted', sha: 'sha2' },
      ])
    })

    it('rerun succeeds (FAILURE → PENDING → SUCCESS): no fix-ci ever dispatched', () => {
      // Poll 1: FAILURE → rerun
      const poll1 = computeDispatchDecision(baseInput({
        prev: null,
        current: { ciStatus: 'FAILURE', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(poll1).toEqual([
        { kind: 'rerun-ci' },
        { kind: 'rerun-attempted', sha: 'sha1' },
      ])

      // Poll 2: PENDING (rerun running) → nothing
      const poll2 = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'FAILURE', headSha: 'sha1', rerunAttemptedShas: ['sha1'] }),
        current: { ciStatus: 'PENDING', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(poll2).toEqual([])

      // Poll 3: SUCCESS (rerun fixed it) → success observed, no dispatch-ci
      const poll3 = computeDispatchDecision(baseInput({
        prev: prev({ ciStatus: 'PENDING', headSha: 'sha1', rerunAttemptedShas: ['sha1'] }),
        current: { ciStatus: 'SUCCESS', humanCommentCount: 0, reviewDecision: null, headSha: 'sha1', state: 'OPEN', displayStatus: 'Draft' },
      }))
      expect(poll3).toEqual([{ kind: 'ci-success-observed' }])
      expect(poll3).not.toContainEqual({ kind: 'dispatch-ci' })
    })
  })
})

