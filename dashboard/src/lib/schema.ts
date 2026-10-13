import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(), // UUID
  prompt: text('prompt').notNull(), // The instruction for the agent
  tags: text('tags').notNull().default('[]'), // JSON array of freeform tags
  ticketId: text('ticket_id'), // Linear ticket ID (e.g. ENG-123)
  prNumber: integer('pr_number'), // PR number (for review-type tasks)
  status: text('status').notNull().default('pending'),
  // pending | starting | running | waiting_for_feedback | complete | failed | cancelled
  statusMessage: text('status_message'),
  containerId: text('container_id'), // Docker container ID
  prUrl: text('pr_url'), // URL of submitted PR
  // JSON shape (written by Phase 2 reaction pipeline):
  // { ciStatus, humanCommentCount, reviewDecision, headSha,
  //   failedHeadShas: string[], observedAt, terminal?: string, skipReason?: string }
  prStateJson: text('pr_state_json'),
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(1),
  launchConfigJson: text('launch_config_json'), // Serialized start options for retry
  shippedAt: integer('shipped_at', { mode: 'timestamp' }),
  ciRounds: integer('ci_rounds').notNull().default(0),
  reviewRounds: integer('review_rounds').notNull().default(0),
  botTriageRounds: integer('bot_triage_rounds').notNull().default(0),
  betaDeploys: integer('beta_deploys').notNull().default(0),
  dispatchedBy: text('dispatched_by').notNull().default('human'), // 'human' | 'reconciler' | 'webhook'
  pausedAt: integer('paused_at', { mode: 'timestamp' }), // non-null = Phase 2 reactive dispatch skips this task
  agentToken: text('agent_token'), // per-task bearer token injected into container env
  // Claude Code session id for suspend/resume (v2 supervisor). Non-null +
  // status waiting_for_feedback + no running container = suspended task.
  resumeSessionId: text('resume_session_id'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(), // UUID
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  direction: text('direction').notNull(), // 'agent_to_human' | 'human_to_agent'
  content: text('content').notNull(),
  type: text('type').default('question'), // 'question' | 'approval' | 'blocker' | 'answer' | null (plain note, no badge)
  answered: integer('answered', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const diffs = sqliteTable('diffs', {
  id: text('id').primaryKey(), // UUID
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  patch: text('patch').notNull(),
  summary: text('summary').notNull(),
  prUrl: text('pr_url'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const logs = sqliteTable('logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  type: text('type').notNull(), // 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'error'
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export type Task = typeof tasks.$inferSelect
// Row shape returned by GET /api/tasks (prompt truncated to 200 chars)
export type TaskSummary = Omit<Task, 'launchConfigJson' | 'agentToken'>
export type NewTask = typeof tasks.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type Diff = typeof diffs.$inferSelect
export type NewDiff = typeof diffs.$inferInsert
export type Log = typeof logs.$inferSelect

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(), // UUID
  repoUrl: text('repo_url').notNull(), // e.g. "acme/webapp"
  category: text('category'), // optional free-text label (e.g. build, pattern, gotcha)
  content: text('content').notNull(),
  source: text('source'), // task ID that created it
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  supersededBy: text('superseded_by'), // ID of memory that replaced this one
  tags: text('tags').notNull().default('[]'), // JSON array of tags from source task
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export type Memory = typeof memories.$inferSelect

export const dashboardCache = sqliteTable('dashboard_cache', {
  id: integer('id').primaryKey().default(1), // singleton row
  contextHash: text('context_hash').notNull(),
  dashboardJson: text('dashboard_json').notNull(), // JSON string of DashboardData
  editorialJson: text('editorial_json'), // per-item editorial store, hashed by content (see briefing-editorial.ts; nullable)
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

// Append-only transition log — one row per status change (and one 'created'
// row per task). Never updated or deleted; postmortems reconstruct a task's
// life from this table alone. `violation` marks transitions the ALLOWED map
// (task-transitions.ts) did not permit — always applied while unenforced,
// logged here for the observation period.
export const taskEvents = sqliteTable('task_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id').notNull(),
  fromStatus: text('from_status'), // null = task creation
  toStatus: text('to_status').notNull(),
  actor: text('actor').notNull(), // 'human' | 'agent' | 'reconciler' | 'system'
  message: text('message'),
  violation: integer('violation', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export type TaskEvent = typeof taskEvents.$inferSelect
