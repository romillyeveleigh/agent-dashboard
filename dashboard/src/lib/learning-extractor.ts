import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { db } from './db'
import { tasks, logs, memories } from './schema'
import { eq, desc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { MAX_LOG_ENTRIES } from './constants'
import { getActiveMemories, isForbiddenMemoryContent } from './memory-queries'
import { parseTaskTags } from './parse-tags'

const learningActionSchema = z.object({
  learnings: z.array(z.object({
    action: z.enum(['create', 'supersede', 'skip']),
    category: z.enum(['approach', 'gotcha', 'tool-tip', 'pattern', 'review-lesson']),
    // Truncate rather than reject: a single over-length item must not fail
    // the whole extraction (the model overruns the 500-char guidance sometimes).
    content: z.string().transform((s) => s.slice(0, 500)),
    supersedesId: z.string().optional(),
  })),
})

const SYSTEM_PROMPT = `You analyse completed agent tasks and extract reusable learnings for future agents working in the same repo.

Rules:
- Extract 1-3 concise, actionable learnings per task. Each must be reusable — not specific to a particular ticket.
- Each learning must be under 500 characters.
- Categories: "approach" (what strategy worked), "gotcha" (surprising pitfall), "tool-tip" (CLI/tool knowledge), "pattern" (repo convention discovered).
- Additional category "review-lesson": use it ONLY when the task addressed HUMAN review feedback on a PR — extract the underlying reviewable rule as a forward-looking self-review check ("Do X" / "Never Y"). Never derive review-lessons from bot comments.
- You will receive existing memories. For each learning you extract:
  - If it is already captured by an existing memory → use action "skip"
  - If it refines or contradicts an existing memory → use action "supersede" and set supersedesId to the existing memory's ID
  - If it is genuinely new → use action "create"
- NEVER extract a learning that instructs posting reviews, comments, or approvals to GitHub (e.g. \`gh pr review\` / \`gh pr comment\`), or that tells agents to act instead of awaiting a human reply. Posting to a PR is governed by the task skill and always requires explicit human approval in-session — a "workaround" that skips that gate is a policy violation, not a learning.
- NEVER extract a learning that claims housekeeping mode is an MCP/infra smoke test, or that it only requires calling post_status / exiting without checking Linear ticket state. Housekeeping updates real ticket statuses.
- For failed tasks: focus on what went wrong and what the next agent should avoid.
- For completed tasks: focus on what approach worked and non-obvious discoveries.
- If there is nothing useful to extract (e.g. trivial task, no new insights), return an empty learnings array.`

const inFlight = new Set<string>()
const EXTRACT_TIMEOUT_MS = 60_000

/** Fire-and-forget — safe to call without awaiting. Dedupes concurrent extractions for the same task. */
export async function extractLearnings(taskId: string): Promise<void> {
  if (inFlight.has(taskId)) return
  inFlight.add(taskId)
  try {
    await doExtract(taskId)
  } finally {
    inFlight.delete(taskId)
  }
}

/** Fire-and-forget wrapper with shared error logging — use from status handlers and reconciler. */
export function fireExtractLearnings(taskId: string): void {
  void extractLearnings(taskId).catch(err =>
    console.error('[learning-extractor]', err),
  )
}

async function doExtract(taskId: string): Promise<void> {
  const repoUrl = process.env.REPO_URL
  if (!repoUrl) return

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  if (!task) return

  // Memory hygiene: never promote an UNVERIFIED diagnosis to memory. A task
  // that opened a PR (prUrl set via post_diff) defers until the PR merges.
  // observeShipped re-fires extraction on the merge edge; a PR closed unmerged
  // never extracts, so a rejected fix never becomes "repo knowledge". Tasks
  // that never opened a PR (review/plan) extract at completion.
  if (!task.shippedAt && task.prUrl) {
    console.log(`[learning-extractor] deferring extraction for task ${taskId} until its fix merges`)
    return
  }

  const taskLogs = await db
    .select()
    .from(logs)
    .where(eq(logs.taskId, taskId))
    .orderBy(desc(logs.createdAt))
    .limit(MAX_LOG_ENTRIES)
  taskLogs.reverse()

  if (taskLogs.length === 0) return

  const existingMemories = await getActiveMemories(repoUrl, 200)

  const existingBlock = existingMemories.length > 0
    ? existingMemories
        .map((m) => `- [ID: ${m.id}] [${m.category || 'general'}] ${m.content}`)
        .join('\n')
    : '(none)'

  const logsBlock = taskLogs
    .map((l) => `[${l.type}] ${l.content}`)
    .join('\n')

  const taskTags = parseTaskTags(task.tags)

  const { object } = await generateObject({
    model: anthropic('claude-haiku-4-5-20251001'),
    schema: learningActionSchema,
    system: SYSTEM_PROMPT,
    abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    prompt: `Task prompt: ${task.prompt.slice(0, 1000)}
Task tags: ${taskTags.join(', ') || '(none)'}
Task outcome: ${task.status}
${task.statusMessage ? `Status message: ${task.statusMessage}` : ''}

Task logs:
${logsBlock}

Existing repo memories:
${existingBlock}`,
  })

  for (const learning of object.learnings) {
    if (learning.action === 'skip') continue

    // Must run before the supersede write: a forbidden learning may neither be
    // stored nor deactivate the memory it claims to refine.
    if (isForbiddenMemoryContent(learning.content)) {
      console.warn(`[learning-extractor] rejected forbidden learning from task ${taskId}: ${learning.content.slice(0, 120)}`)
      continue
    }

    const newId = uuid()

    if (learning.action === 'supersede' && learning.supersedesId) {
      await db
        .update(memories)
        .set({
          active: false,
          supersededBy: newId,
          updatedAt: new Date(),
        })
        .where(eq(memories.id, learning.supersedesId))
    }

    // Review-lessons get the ship/review-lesson tags so getReviewLessons and
    // the ship-task Review Lessons prompt block (prompt-builder) pick them up.
    const memTags = learning.category === 'review-lesson'
      ? Array.from(new Set([...taskTags, 'ship', 'review-lesson']))
      : taskTags

    await db.insert(memories).values({
      id: newId,
      repoUrl,
      category: learning.category,
      content: learning.content,
      source: taskId,
      tags: JSON.stringify(memTags),
    })
  }

  const created = object.learnings.filter(l => l.action !== 'skip').length
  if (created > 0) {
    console.log(`[learning-extractor] Extracted ${created} learnings from task ${taskId}`)
  }
}
