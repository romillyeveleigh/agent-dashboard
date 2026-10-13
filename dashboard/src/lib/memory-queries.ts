import { db } from './db'
import { memories } from './schema'
import { and, desc, eq } from 'drizzle-orm'
import type { Memory } from './schema'

// Memories must never carry instructions to post reviews/comments/approvals to
// GitHub. Posting is governed by the skill's human-approval gate; a memory
// mentioning the posting commands is at best redundant and at worst poisonous —
// an extracted "workaround" can tell review agents to post instead of awaiting
// the human's reply. Deliberately blunt: no legitimate memory needs these phrases.
const FORBIDDEN_MEMORY_PATTERNS = [
  /gh pr (review|comment)\b/i,
  /pulls\/\S*\/reviews/i,
  /post(ing)?\s+(an?\s+)?(approval|review|comment)s?\s+(using|via)\s+(the\s+)?github/i,
  /instead of awaiting/i,
  /do(n't| not) retry reply/i,
  // Housekeeping is real Linear/status work. Memories that collapse it to an
  // "MCP smoke test" / immediate post_status-only exit poisoned Mode 4 runs
  // (agents skipped get_issue / save_issue and thrashed simulating MCP via Bash).
  /housekeeping mode requires immediate post_status/i,
  /infrastructure verification task that requires no (file|git|code)/i,
  /validates agent-dashboard MCP communication/i,
  /infra smoke test/i,
  /call post_status with status ['"]?complete['"]? and exit immediately/i,
]

export function isForbiddenMemoryContent(content: string): boolean {
  return FORBIDDEN_MEMORY_PATTERNS.some((p) => p.test(content))
}

export async function getActiveMemories(repoUrl: string, limit?: number): Promise<Memory[]> {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.repoUrl, repoUrl), eq(memories.active, true)))
    .orderBy(desc(memories.updatedAt))
    .limit(limit ?? 10_000)
}

export async function getReviewLessons(repoUrl: string, limit = 100): Promise<Memory[]> {
  return db
    .select()
    .from(memories)
    .where(and(
      eq(memories.repoUrl, repoUrl),
      eq(memories.active, true),
      eq(memories.category, 'review-lesson'),
    ))
    .orderBy(desc(memories.updatedAt))
    .limit(limit)
}
