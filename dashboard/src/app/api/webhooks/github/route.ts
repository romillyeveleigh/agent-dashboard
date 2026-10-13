/**
 * GitHub webhook endpoint.
 *
 * Primary (seconds-level) trigger for the Phase 2 reaction pipeline. Every
 * event re-fetches the PR via `fetchPRsByNumber` — we never trust payload
 * state — so this path is latency-optimisation, not truth. The 2-min poll
 * in reconciler.ts is the truth fallback and keeps running.
 *
 * Signature verification is the only non-200 response. Handler errors are
 * caught and logged; GitHub retries on 5xx, which would duplicate dispatches
 * (dedup catches it, but noisy logs aren't worth it).
 */

import { NextRequest, NextResponse } from 'next/server'
import { Webhooks } from '@octokit/webhooks'
import { reactForPR } from '@/lib/poll-transitions'
import { withTaskLock } from '@/lib/task-locks'
import { isBotOrSelf, isReviewBot } from '@/lib/bot-filter'
import { findShipTaskForPR } from '@/lib/ship-tasks'
import { setupIncompleteResponse } from '@/lib/setup'
import { refreshContextCaches } from '@/lib/context-fetchers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function extractPrNumber(event: string, payload: Record<string, unknown>): number | null {
  if (event === 'check_run') {
    const prs = (payload.check_run as { pull_requests?: Array<{ number: number }> } | undefined)?.pull_requests
    return prs?.[0]?.number ?? null
  }
  const pr = payload.pull_request as { number?: number } | undefined
  if (pr?.number) return pr.number
  const issue = payload.issue as { number?: number; pull_request?: unknown } | undefined
  if (issue?.pull_request && issue.number) return issue.number
  return null
}

// Webhook bursts (e.g. a review with many comments) collapse into one
// context refresh per window.
const WEBHOOK_REFRESH_DEBOUNCE_MS = 15_000
let lastWebhookRefreshAt = 0

function extractActorLogin(payload: Record<string, unknown>): string | null {
  const sender = payload.sender as { login?: string } | undefined
  return sender?.login ?? null
}

export async function POST(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    // Refuse to process without a configured secret — prevents running in a
    // state where any POST would be accepted.
    return NextResponse.json({ error: 'GITHUB_WEBHOOK_SECRET not set' }, { status: 500 })
  }

  const signature = req.headers.get('x-hub-signature-256') || ''
  const event = req.headers.get('x-github-event') || ''
  const rawBody = await req.text()

  const webhooks = new Webhooks({ secret })
  const valid = await webhooks.verify(rawBody, signature)
  if (!valid) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  try {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ ok: true, warning: 'non-json body' })
    }

    // Cheap pre-filter: skip events from our own agent or known bots —
    // EXCEPT review bots (AI review agents), whose reviews feed the Phase 4
    // bot pre-review pass. Self events always skip (self is never a review bot).
    const actor = extractActorLogin(payload)
    if (isBotOrSelf(actor) && !isReviewBot(actor)) {
      return NextResponse.json({ ok: true, skipped: 'bot-or-self actor' })
    }

    // Narrow set of interesting events; anything else is a 200 no-op.
    // `status` (classic commit-status API) is deliberately excluded — its
    // payload has no PR number and SHA→PR lookup isn't implemented yet.
    // The 2-min poll catches CI transitions posted via `status` within two
    // polls regardless.
    const handled = ['check_run', 'pull_request_review', 'pull_request_review_comment', 'issue_comment']
    if (!handled.includes(event)) {
      return NextResponse.json({ ok: true, skipped: `unhandled event: ${event}` })
    }

    // Dashboard freshness: any interesting PR activity refreshes the context
    // caches, including for PRs with no ship task (the early return below).
    if (Date.now() - lastWebhookRefreshAt > WEBHOOK_REFRESH_DEBOUNCE_MS) {
      lastWebhookRefreshAt = Date.now()
      refreshContextCaches('webhook').catch(err =>
        console.error('[context-refresh] webhook trigger failed:', err),
      )
    }

    const prNumber = extractPrNumber(event, payload)
    if (!prNumber) {
      return NextResponse.json({ ok: true, skipped: `no PR number in ${event} payload` })
    }

    const ship = await findShipTaskForPR(prNumber)
    if (!ship) {
      return NextResponse.json({ ok: true, skipped: `no ship task for PR #${prNumber}` })
    }

    await withTaskLock(ship.id, () => reactForPR(ship, prNumber, 'webhook'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[webhooks/github] handler error:', err)
    // Return 200 so GitHub doesn't retry — dedup and the poll fallback make
    // retries redundant and noisy.
    return NextResponse.json({ ok: true, error: 'logged' })
  }
}
