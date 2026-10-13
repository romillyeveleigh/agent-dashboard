/**
 * Shared bot + self-login filtering used by the Phase 2 reaction pipeline.
 *
 * `countHumanComments` is the single source of truth for "which PR events
 * count as human input." Used by the poll cycle, the webhook route, and the
 * re-review baseline update.
 */

import type { PullRequest } from './github'

const DEFAULT_BOT_LOGINS = 'dependabot[bot],renovate[bot],linear-code,nx-cloud'

function loginBare(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/i, '')
}

let cachedBots: Set<string> | null = null
let cachedBotsSource: string | undefined

export function ignoredBotLogins(): Set<string> {
  const raw = process.env.IGNORED_BOT_LOGINS ?? DEFAULT_BOT_LOGINS
  if (cachedBots && cachedBotsSource === raw) return cachedBots
  cachedBotsSource = raw
  cachedBots = new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
  return cachedBots
}

export function isBotOrSelf(login: string | null | undefined, bots: Set<string> = ignoredBotLogins()): boolean {
  if (!login) return false
  if (login === (process.env.GITHUB_USERNAME ?? '')) return true
  // GitHub issue comments often omit the [bot] suffix (renovate vs renovate[bot]).
  if (login.endsWith('[bot]')) return true
  const bare = loginBare(login)
  if (bots.has(login) || bots.has(bare) || bots.has(`${bare}[bot]`)) return true
  for (const bot of bots) {
    if (loginBare(bot) === bare) return true
  }
  return false
}

// Review bots (AI review agents, configured via REVIEW_BOT_LOGINS) are a SUBSET
// of ignored bots: their comments never count as human input (keep them in
// IGNORED_BOT_LOGINS), but — unlike dependabot/renovate — their reviews feed the
// Phase 4 bot pre-review pass via countBotReviewComments.
const DEFAULT_REVIEW_BOT_LOGINS = ''

let cachedReviewBots: Set<string> | null = null
let cachedReviewBotsSource: string | undefined

export function reviewBotLogins(): Set<string> {
  const raw = process.env.REVIEW_BOT_LOGINS ?? DEFAULT_REVIEW_BOT_LOGINS
  if (cachedReviewBots && cachedReviewBotsSource === raw) return cachedReviewBots
  cachedReviewBotsSource = raw
  cachedReviewBots = new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
  return cachedReviewBots
}

export function isReviewBot(login: string | null | undefined): boolean {
  if (!login) return false
  return reviewBotLogins().has(login)
}

export function countBotReviewComments(pr: Pick<PullRequest, 'comments' | 'reviews'>): number {
  const bots = reviewBotLogins()
  let n = 0
  for (const c of pr.comments ?? []) {
    if (c.author && bots.has(c.author)) n++
  }
  for (const r of pr.reviews ?? []) {
    if (r.author && bots.has(r.author)) n++
  }
  return n
}

export function countHumanComments(pr: Pick<PullRequest, 'comments' | 'reviews'>): number {
  const bots = ignoredBotLogins()
  let n = 0
  for (const c of pr.comments ?? []) {
    if (!isBotOrSelf(c.author, bots)) n++
  }
  for (const r of pr.reviews ?? []) {
    if (!isBotOrSelf(r.author, bots)) n++
  }
  return n
}
