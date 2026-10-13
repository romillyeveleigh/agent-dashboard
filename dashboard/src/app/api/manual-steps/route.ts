import { streamText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import type { ContextData } from '@/lib/context-types'
import type { LinearTicket } from '@/lib/linear-data'
import type { PullRequest } from '@/lib/github'
import { setupIncompleteResponse } from '@/lib/setup'

type Stage = 'pre-review' | 'pre-merge' | 'post-deploy'

const SYSTEM_PROMPT = `You are a developer assistant that generates verification and manual action instructions for a software ticket or PR.

You will receive:
- The current workflow stage (pre-review, pre-merge, or post-deploy)
- Whether this is the developer's own work or a PR they are reviewing
- Ticket details (if available): description, work document, manual steps checklist
- PR details: review status, CI status, branch info

## Your job

Generate instructions organized into THREE stages. ALL stages are always shown. Mark the current stage prominently.

### Stage format

For the CURRENT stage, use:
> 👉 **PRE-REVIEW (you are here)**

For PAST stages (already completed), use:
> ✅ **PRE-REVIEW (done)**

For FUTURE stages (not yet reached), use:
> ⏳ **PRE-MERGE (upcoming)**

### Stage content

**PRE-REVIEW** — verify the code works locally before requesting review:
- Commands to check out the branch, install deps, run the dev server
- Specific features/pages to test based on the ticket description
- Any ticket-specific setup actions needed BEFORE review (e.g. create a content type in the CMS, add a feature flag, set env vars)
- What to look for: expected behavior, edge cases to check

**PRE-MERGE** — deploy to beta and verify before merging:
- Steps to deploy to the beta/staging environment
- What to verify on beta (specific URLs, features, user flows)
- Any ticket-specific actions needed BEFORE merge (e.g. ensure feature flag is enabled on beta, database migration applied)

**POST-DEPLOY** — verify on live after merge:
- What to check on production (specific URLs, features)
- Any ticket-specific actions needed AFTER deploy (e.g. enable feature flag on production, notify stakeholders, update documentation)
- Rollback plan if something is broken

**DO NOT include** anything that CI already handles: running tests, linting, type-checking, build verification. Those are automated gates — only include manual human actions.

### Ticket-specific manual actions

Scan the ticket description and work document for references to:
- External services: a CMS, feature-flag service, payment provider, etc.
- Infrastructure: environment variables, DNS, database migrations
- Configuration: feature flags, API keys, third-party settings
- Communication: stakeholder notifications, documentation updates

Slot each action into the appropriate stage. If timing is ambiguous, put it in the earliest relevant stage.

If there is an explicit "Manual Steps" checklist in the work document, incorporate those items into the appropriate stages.

### For reviewer mode

When the user is reviewing someone else's PR (not their own work), focus on:
- PRE-REVIEW: how to check out the branch, run the code, and test the feature
- PRE-MERGE and POST-DEPLOY: mark as "Author's responsibility" with brief notes on what to watch for

Be specific and actionable. Use the ticket description, work document, and PR details to make instructions concrete.`

function detectStage(prs: PullRequest[]): Stage {
  if (prs.some(pr => pr.state === 'MERGED')) return 'post-deploy'
  if (prs.some(pr => pr.reviewDecision === 'APPROVED' && pr.state === 'OPEN')) return 'pre-merge'
  return 'pre-review'
}

function findLinkedPrs(ticket: LinearTicket, contextData: ContextData): PullRequest[] {
  const allPrs = [...(contextData.myPRs || []), ...(contextData.recentlyMerged || [])]
  return allPrs.filter(pr => ticket.linkedPrNumbers.includes(pr.number))
}

function findPrByNumber(prNumber: number, contextData: ContextData): PullRequest | undefined {
  return contextData.myPRs?.find(pr => pr.number === prNumber)
    || contextData.recentlyMerged?.find(pr => pr.number === prNumber)
    || contextData.reviewRequests?.find(pr => pr.number === prNumber)
}

function buildContext(opts: {
  ticket?: LinearTicket
  prs: PullRequest[]
  stage: Stage
  isReview: boolean
}): string {
  const { ticket, prs, stage, isReview } = opts
  const parts: string[] = []

  parts.push(`## Current Stage: ${stage.toUpperCase()}`)
  parts.push(`## Mode: ${isReview ? 'REVIEWER (reviewing someone else\'s PR)' : 'AUTHOR (your own work)'}`)

  if (ticket) {
    parts.push(`\n## Ticket: ${ticket.identifier} — ${ticket.title}`)
    parts.push(`State: ${ticket.state.name} | Priority: ${ticket.priority}`)
    if (ticket.branchName) parts.push(`Branch: ${ticket.branchName}`)
    if (ticket.description) parts.push(`\n### Description\n${ticket.description}`)

    if (ticket.workDocParsed) {
      const wp = ticket.workDocParsed
      parts.push(`\n### Work Document Progress\n${wp.completedSteps}/${wp.totalSteps} steps completed`)
      if (wp.progressContent) parts.push(`\n### Progress Notes\n${wp.progressContent}`)
      if (wp.blockersContent) parts.push(`\n### Blockers\n${wp.blockersContent}`)

      if (wp.manualSteps.length > 0) {
        parts.push(`\n### Manual Steps Checklist`)
        for (const step of wp.manualSteps) {
          parts.push(`- [${step.checked ? 'x' : ' '}] ${step.description}`)
        }
      }
    }

    if (ticket.workDocumentContent) {
      parts.push(`\n### Full Work Document\n${ticket.workDocumentContent}`)
    }
  }

  if (prs.length > 0) {
    parts.push(`\n## Pull Requests`)
    for (const pr of prs) {
      parts.push(`\n### PR #${pr.number}: ${pr.title}`)
      parts.push(`Branch: ${pr.headRefName}`)
      parts.push(`State: ${pr.state} | Review: ${pr.reviewDecision || 'none'} | CI: ${pr.ciStatus || 'unknown'}${pr.hasMergeConflict ? ' | Merge conflict' : ''}`)
      parts.push(`Author: @${pr.author} | +${pr.additions}/-${pr.deletions} lines`)
      if (pr.mergedAt) parts.push(`Merged: ${pr.mergedAt}`)
      if (pr.reviews.length > 0) {
        parts.push(`Reviews:`)
        for (const r of pr.reviews) {
          parts.push(`  - @${r.author}: ${r.state}${r.body ? ` — "${r.body.slice(0, 200)}"` : ''}`)
        }
      }
    }
  }

  return parts.join('\n')
}

export async function POST(req: Request) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  let body: { workItemId?: string; prNumber?: number; isReview?: boolean; context?: string }
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid or empty request body', { status: 400 })
  }

  if (!body.context || (!body.workItemId && !body.prNumber)) {
    return new Response('Missing context and workItemId or prNumber', { status: 400 })
  }

  let contextData: ContextData
  try {
    contextData = JSON.parse(body.context)
  } catch {
    return new Response('Invalid context JSON', { status: 400 })
  }

  let ticket: LinearTicket | undefined
  let prs: PullRequest[] = []
  const isReview = body.isReview ?? false

  if (body.workItemId) {
    // Ticket lookup
    ticket = contextData.tickets?.find(t => t.identifier === body.workItemId)
    if (ticket) {
      prs = findLinkedPrs(ticket, contextData)
    } else {
      // Maybe it's an orphan PR (workItemId is the PR number as string)
      const prNum = Number(body.workItemId)
      if (!isNaN(prNum)) {
        const pr = findPrByNumber(prNum, contextData)
        if (pr) prs = [pr]
      }
    }
  } else if (body.prNumber) {
    // Direct PR lookup (review items, orphan PRs)
    const pr = findPrByNumber(body.prNumber, contextData)
    if (pr) prs = [pr]
  }

  if (prs.length === 0 && !ticket) {
    return new Response('No ticket or PR found for the given identifier', { status: 404 })
  }

  const stage = prs.length > 0 ? detectStage(prs) : 'pre-review'
  const contextStr = buildContext({ ticket, prs, stage, isReview })

  const result = streamText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Generate verification and manual action instructions for this ${isReview ? 'PR review' : 'ticket/PR'}.\n\n${contextStr}`,
    }],
  })

  return result.toTextStreamResponse()
}
