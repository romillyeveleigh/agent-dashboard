/**
 * Phase 4 review-lesson harvester.
 *
 * Re-runnable job (POST /api/review-lessons) that pulls human review comments
 * from the user's merged PRs and distils them into reusable `review-lesson`
 * memories. Ship-mode tasks receive these via the dedicated `## Review Lessons`
 * prompt block (prompt-builder.ts) and audit their plan (Step 2) and diff
 * (Step 4) against them.
 *
 * Idempotent: existing review-lesson memories are passed to the model with a
 * "skip" action, and exact-content dedup guards each insert.
 */

import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { v4 as uuid } from 'uuid'
import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { memories } from './schema'
import { resilientFetch } from './resilient-fetch'
import { isBotOrSelf } from './bot-filter'
import { getReviewLessons } from './memory-queries'

const GRAPHQL_URL = 'https://api.github.com/graphql'
const MERGED_PR_LIMIT = 50
// Full comment sub-resolvers across many PRs push GitHub's GraphQL execution
// past its ~10s budget (see PR_FRAGMENT_LIGHT rationale in github.ts) — batch small.
const PR_BATCH_SIZE = 5
const MAX_COMMENT_CHARS = 1500
const HARVEST_TIMEOUT_MS = 120_000

export const REVIEW_LESSON_CATEGORY = 'review-lesson'
export const REVIEW_LESSON_TAGS = ['ship', 'review-lesson']

interface HarvestedComment {
  pr: number
  author: string
  path?: string
  body: string
}

const lessonSchema = z.object({
  lessons: z.array(z.object({
    action: z.enum(['create', 'skip']),
    // Truncate rather than reject (same rationale as learning-extractor).
    content: z.string().transform(s => s.slice(0, 500)),
  })),
})

const SYSTEM_PROMPT = `You distil human PR-review comments into reusable review lessons for an AI agent that self-reviews its own PRs before requesting human review.

Rules:
- Each lesson must be a forward-looking, checkable rule ("Do X" / "Never Y"), under 500 characters, that a future self-review could apply to a diff.
- Generalise: strip ticket-specific nouns; keep concrete repo conventions (naming, patterns, testing, error handling, style).
- Merge comments expressing the same underlying rule into ONE lesson.
- Skip pleasantries, bare approvals, questions that were answered in-thread, and one-off nits that don't generalise.
- You will receive existing review-lesson memories. If a candidate lesson is already captured by one, return it with action "skip".
- 5-20 lessons is the expected output for a typical corpus. Quality over quantity.`

async function githubGraphQL(query: string): Promise<Record<string, unknown> | null> {
  const token = process.env.GITHUB_TOKEN
  if (!token) return null
  const res = await resilientFetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) {
    console.error('[review-lesson-harvester] GraphQL error:', res.status, await res.text().catch(() => ''))
    return null
  }
  const json = await res.json()
  return json.data ?? null
}

async function fetchLandedPRNumbers(): Promise<number[]> {
  const username = process.env.GITHUB_USERNAME
  const repo = process.env.REPO_URL
  if (!username || !repo) return []
  const data = await githubGraphQL(`{
    search(query: "is:pr is:merged author:${username} repo:${repo} sort:updated-desc", type: ISSUE, first: ${MERGED_PR_LIMIT}) {
      nodes { ... on PullRequest { number } }
    }
  }`)
  const nodes = (data?.search as { nodes?: Array<{ number?: number }> } | undefined)?.nodes ?? []
  return nodes.map(n => n.number).filter((n): n is number => typeof n === 'number')
}

async function fetchHumanComments(prNumbers: number[]): Promise<HarvestedComment[]> {
  const repo = process.env.REPO_URL || ''
  const [owner, name] = repo.split('/')
  if (!owner || !name) return []

  const out: HarvestedComment[] = []
  for (let i = 0; i < prNumbers.length; i += PR_BATCH_SIZE) {
    const batch = prNumbers.slice(i, i + PR_BATCH_SIZE)
    const aliased = batch.map((n, j) => `
      pr${j}: repository(owner: "${owner}", name: "${name}") {
        pullRequest(number: ${n}) {
          number
          reviews(first: 30) { nodes { author { login } body state } }
          reviewThreads(first: 50) {
            nodes { comments(first: 10) { nodes { author { login } body path } } }
          }
        }
      }`).join('\n')
    const data = await githubGraphQL(`{ ${aliased} }`)
    if (!data) continue

    for (let j = 0; j < batch.length; j++) {
      const pr = (data[`pr${j}`] as { pullRequest?: Record<string, unknown> } | undefined)?.pullRequest
      if (!pr) continue
      const prNumber = pr.number as number
      const reviews = (pr.reviews as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes ?? []
      for (const r of reviews) {
        const author = (r.author as { login?: string } | null)?.login
        const body = ((r.body as string) || '').trim()
        if (!author || !body || isBotOrSelf(author)) continue
        out.push({ pr: prNumber, author, body: body.slice(0, MAX_COMMENT_CHARS) })
      }
      const threads = (pr.reviewThreads as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes ?? []
      for (const t of threads) {
        const comments = (t.comments as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes ?? []
        for (const c of comments) {
          const author = (c.author as { login?: string } | null)?.login
          const body = ((c.body as string) || '').trim()
          if (!author || !body || isBotOrSelf(author)) continue
          out.push({ pr: prNumber, author, path: (c.path as string) || undefined, body: body.slice(0, MAX_COMMENT_CHARS) })
        }
      }
    }
  }
  return out
}

export async function harvestReviewLessons(): Promise<{
  prsScanned: number
  commentsHarvested: number
  created: number
  skipped: number
}> {
  const repoUrl = process.env.REPO_URL
  if (!repoUrl) throw new Error('REPO_URL is not set')
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set')

  const prNumbers = await fetchLandedPRNumbers()
  const comments = await fetchHumanComments(prNumbers)
  if (comments.length === 0) {
    return { prsScanned: prNumbers.length, commentsHarvested: 0, created: 0, skipped: 0 }
  }

  const existing = await getReviewLessons(repoUrl)
  const existingBlock = existing.length > 0
    ? existing.map(m => `- ${m.content}`).join('\n')
    : '(none)'
  // Cap the corpus so a comment-heavy repo can't blow the context window
  // (~85k tokens). Comments are ordered most-recent-PR-first by the search.
  const commentsBlock = comments
    .map(c => `[PR #${c.pr}${c.path ? ` ${c.path}` : ''}] ${c.author}: ${c.body}`)
    .join('\n---\n')
    .slice(0, 300_000)

  const { object } = await generateObject({
    model: anthropic('claude-sonnet-5'),
    schema: lessonSchema,
    system: SYSTEM_PROMPT,
    // Default output budget truncates mid-JSON once the model emits 15+
    // lessons, which surfaces as "response did not match schema".
    maxOutputTokens: 16_000,
    abortSignal: AbortSignal.timeout(HARVEST_TIMEOUT_MS),
    prompt: `Human review comments harvested from ${prNumbers.length} merged PRs:

${commentsBlock}

Existing review-lesson memories:
${existingBlock}`,
  })

  let created = 0
  let skipped = 0
  for (const lesson of object.lessons) {
    if (lesson.action === 'skip') { skipped++; continue }
    // Exact-content dedup (same guard as POST /api/memories).
    const [dup] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(eq(memories.repoUrl, repoUrl), eq(memories.content, lesson.content)))
      .limit(1)
    if (dup) { skipped++; continue }
    await db.insert(memories).values({
      id: uuid(),
      repoUrl,
      category: REVIEW_LESSON_CATEGORY,
      content: lesson.content,
      source: 'review-lesson-harvester',
      tags: JSON.stringify(REVIEW_LESSON_TAGS),
    })
    created++
  }

  console.log(`[review-lesson-harvester] ${prNumbers.length} PRs, ${comments.length} comments → ${created} created, ${skipped} skipped`)
  return { prsScanned: prNumbers.length, commentsHarvested: comments.length, created, skipped }
}
