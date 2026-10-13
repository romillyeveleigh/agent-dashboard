import { DEFAULT_SKILL, MAX_MEMORIES, MEMORY_FETCH_WINDOW, SHIP_TAG } from './constants'
import { DISPATCH_MODES } from './quick-actions'
import { getActiveMemories, getReviewLessons } from './memory-queries'
import { parseTaskTags } from './parse-tags'

const KNOWN_MODES: string[] = DISPATCH_MODES.map(m => m.id)

interface BuildPromptOptions {
  instruction: string
  taskId: string
  dashboardUrl: string
  tags: string[]
  context?: { ticketId?: string; prNumber?: number }
}

/**
 * Build the full agent prompt from a raw instruction.
 * Single source of truth for prompt construction — used by initial dispatch,
 * manual retries, and reconciler auto-retries.
 */
export async function buildAgentPrompt(opts: BuildPromptOptions): Promise<string> {
  const { instruction, taskId, dashboardUrl, tags, context } = opts

  // The mode is the first tag that names a known skill mode — not necessarily
  // tags[0]: reactive dispatches (poll-transitions.ts) put a kind-specific
  // dedup tag first (e.g. ['fix-ci', 'code']).
  const mode = tags.find(t => KNOWN_MODES.includes(t))
  const skillPrefix = mode ? `Run the ${DEFAULT_SKILL} skill in ${mode} mode. ` : ''

  const contextParts: string[] = []
  if (context?.ticketId) contextParts.push(`Ticket ID: ${context.ticketId}`)
  if (context?.prNumber) contextParts.push(`PR Number: #${context.prNumber}`)
  const contextStr = contextParts.length > 0 ? contextParts.join('. ') + '. ' : ''

  let prompt = instruction.includes('Task ID:')
    ? instruction
    : `${skillPrefix}${instruction} ${contextStr}Task ID: ${taskId}. Dashboard URL: ${dashboardUrl}. Use the agent-dashboard MCP tools to communicate progress: reply (blocks until the human answers — questions/approvals only), say (non-blocking acknowledgements and FYI notes), post_status, post_diff.`

  const repoUrl = process.env.REPO_URL
  if (repoUrl) {
    // 'review-lesson' entries get their own block below; 'approach' entries
    // are excluded because they overwhelmingly restate the skill's own
    // workflow back at it — the injected block is for gotchas/patterns/tips
    // the agent could not derive from the skill file.
    const allMemories = (await getActiveMemories(repoUrl, MEMORY_FETCH_WINDOW))
      .filter(m => m.category !== 'review-lesson' && m.category !== 'approach')

    // Collapse near-duplicates: the extractor's skip/supersede check only sees
    // a recency window of the store, so the same lesson gets re-saved by every
    // agent that hits the same wall. Rows arrive newest-first, so keeping the
    // first occurrence keeps the most recent wording.
    const seenPrefixes = new Set<string>()
    const memoriesPool = allMemories.filter((m) => {
      const key = m.content.toLowerCase().replace(/\s+/g, ' ').slice(0, 60)
      if (seenPrefixes.has(key)) return false
      seenPrefixes.add(key)
      return true
    })

    if (memoriesPool.length > 0) {
      const scored = memoriesPool.map((m) => {
        let tagScore = 0
        if (tags.length > 0) {
          const memTags = parseTaskTags(m.tags)
          for (const t of tags) {
            if (memTags.includes(t)) tagScore += 2
          }
        }
        return { memory: m, tagScore }
      })

      scored.sort((a, b) => b.tagScore - a.tagScore)

      const top = scored.slice(0, MAX_MEMORIES)
      const memoryBlock = top
        .map(({ memory: m }) => `- ${m.category ? `[${m.category}] ` : ''}${m.content}`)
        .join('\n')
      prompt += `\n\n## Repo Memories\nPrevious agents *believed* these things about this repo. Treat them as unverified hypotheses, not established facts — they may be wrong or based on changes that were never merged. Confirm against the current code before relying on any of them:\n${memoryBlock}`
    }

    // Phase 4: ship and review tasks get the review-lesson corpus as a
    // dedicated block. The general Repo Memories window is the 150 most-recent
    // of 1000+ memories — lessons would age out of it. Ship's Step 2 (plan
    // audit) and Step 4 (diff self-review) gates depend on them; review mode
    // checks the PR against them (Mode 2 Sub-mode A step 5).
    const lessonUse = tags.includes(SHIP_TAG)
      ? 'Audit your plan (Step 2) and your diff (Step 4 self-review) against each of these before submitting'
      : mode === 'review'
        ? 'Check the PR or plan you are reviewing against each of these and report any violation as a finding'
        : null
    if (lessonUse) {
      const lessons = await getReviewLessons(repoUrl, 30)
      if (lessons.length > 0) {
        const lessonBlock = lessons.map(m => `- ${m.content}`).join('\n')
        prompt += `\n\n## Review Lessons\nDistilled from real human review comments on this repo's past PRs. ${lessonUse}:\n${lessonBlock}`
      }
    }
  }

  return prompt
}
