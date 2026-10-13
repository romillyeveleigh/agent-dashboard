import { z } from 'zod/v4'
import { createHash } from 'crypto'

// --- Zod schemas (used for validation after manual JSON parsing) ---

const dispatchModeSchema = z.enum(['code', 'review', 'plan', 'housekeeping', 'brainstorm', 'general'])

const prSubItemSchema = z.object({
  number: z.number(),
  url: z.string(),
  status: z.string(), // "Draft" | "Approved" | "Changes req." | "Pending"
  ci: z.string(), // "success" | "failure" | "pending"
  conflict: z.boolean().optional(),
})

export const workItemActionSchema = z.union([
  z.object({ presetId: z.string() }),
  z.object({ label: z.string(), mode: dispatchModeSchema, instruction: z.string() }),
])

const workItemSchema = z.object({
  type: z.enum(['ticket', 'orphan-pr']),
  id: z.string(), // "ENG-260" or "6701"
  url: z.string(),
  editorialTitle: z.string(),
  tldr: z.string(),
  // Ticket-specific
  state: z.string().optional(),
  priority: z.string().optional(), // "Urgent" | "High" | "Normal" | "Low"
  planStatus: z.string().nullable().optional(), // "Plan 3/5" or null
  manualSteps: z.enum(['pending', 'done']).nullable().optional(),
  noPr: z.boolean().optional(),
  ownWorkLanded: z.boolean().optional(),
  // PR-specific (orphan PRs)
  prStatus: z.string().optional(),
  ci: z.string().optional(),
  conflict: z.boolean().optional(),
  // Ticket this PR is linked to but that isn't in `tickets[]` (e.g. not
  // assigned to the current user) — shown on the card so the PR's origin is
  // still visible even though it can't be nested under a full ticket entry.
  linkedTicketId: z.string().nullable().optional(),
  linkedTicketUrl: z.string().nullable().optional(),
  // Linked PRs (for tickets)
  prs: z.array(prSubItemSchema).optional(),
  // Dispatch actions (LLM-curated from preset vocabulary + optional custom)
  actions: z.array(workItemActionSchema),
})

const reviewItemSchema = z.object({
  number: z.number(),
  url: z.string(),
  editorialTitle: z.string(),
  author: z.string(),
  daysWaiting: z.number(),
  size: z.number(),
  tldr: z.string(),
  // Dispatch fields (LLM-generated)
  instruction: z.string(),
  actionLabel: z.string(),
  mode: dispatchModeSchema,
})

export const dashboardDataSchema = z.object({
  workItems: z.array(workItemSchema),
  reviewRequests: z.array(reviewItemSchema),
})

// --- TypeScript types ---

export type DashboardData = z.infer<typeof dashboardDataSchema>
export type WorkItem = z.infer<typeof workItemSchema>
export type WorkItemAction = z.infer<typeof workItemActionSchema>
export type PrSubItem = z.infer<typeof prSubItemSchema>
export type ReviewItem = z.infer<typeof reviewItemSchema>

// --- Context hashing ---

/**
 * Hash context data for cache comparison.
 * Strips `fetchedAt` (changes every request) and SHA-256s the rest. Key order
 * is stable because the context object is always built by the same server
 * code path, so a plain stringify is deterministic.
 */
export function hashContext(contextJson: string): string {
  const parsed = JSON.parse(contextJson)
  delete parsed.fetchedAt
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
}
