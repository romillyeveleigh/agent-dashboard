import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

const DB_PATH =
  process.env.DATABASE_PATH ||
  path.join(process.cwd(), 'data', 'dashboard.db')

// Persist the connection across Next.js HMR and per-route module re-evaluation,
// using the same globalThis-singleton pattern as events.ts and reconciler.ts.
// A module-local `let _db` resets to null on every re-evaluation, so each one
// opened a fresh better-sqlite3 connection (leaking the previous fd and re-running
// the ALTER TABLE migrations below). Under active use that exhausted the process
// file-descriptor limit (256) and wedged the event loop with EMFILE errors.
const DB_KEY = '__agent_dashboard_db__'
const g = globalThis as unknown as Record<string, BetterSQLite3Database<typeof schema> | undefined>

function getDb() {
  if (g[DB_KEY]) return g[DB_KEY]!

  mkdirSync(path.dirname(DB_PATH), { recursive: true })

  const sqlite = new Database(DB_PATH)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = OFF')

  sqlite.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        ticket_id TEXT,
        pr_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        status_message TEXT,
        container_id TEXT,
        pr_url TEXT,
        pr_state_json TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 1,
        launch_config_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'question',
        answered INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS diffs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        patch TEXT NOT NULL,
        summary TEXT NOT NULL,
        pr_url TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_messages_task_id ON messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_diffs_task_id ON diffs(task_id);
      CREATE INDEX IF NOT EXISTS idx_logs_task_id ON logs(task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_pr_number ON tasks(pr_number);
      CREATE INDEX IF NOT EXISTS idx_tasks_ticket_id ON tasks(ticket_id);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        repo_url TEXT NOT NULL,
        category TEXT,
        content TEXT NOT NULL,
        source TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repo_url);
      CREATE TABLE IF NOT EXISTS context_cache (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS dashboard_cache (
        id INTEGER PRIMARY KEY DEFAULT 1,
        context_hash TEXT NOT NULL,
        dashboard_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)

  const migrations = [
    `ALTER TABLE memories ADD COLUMN superseded_by TEXT`,
    `ALTER TABLE memories ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN shipped_at INTEGER`,
    `ALTER TABLE tasks ADD COLUMN ci_rounds INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN beta_deploys INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN dispatched_by TEXT NOT NULL DEFAULT 'human'`,
    `ALTER TABLE tasks ADD COLUMN paused_at INTEGER`,
    `ALTER TABLE tasks ADD COLUMN agent_token TEXT`,
    `ALTER TABLE dashboard_cache ADD COLUMN editorial_json TEXT`,
    `ALTER TABLE tasks ADD COLUMN bot_triage_rounds INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN resume_session_id TEXT`,
    `CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      message TEXT,
      violation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
  ]
  for (const sql of migrations) {
    try {
      sqlite.exec(sql)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('duplicate column name')) throw err
    }
  }

  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id)`)
  // GET /api/tasks orders by created_at; without this it scans every row's prompt
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)`)

  g[DB_KEY] = drizzle(sqlite, { schema })

  // Start background reconciler on first DB access
  import('./reconciler').then(({ startReconciler }) => startReconciler())

  return g[DB_KEY]!
}

/** Lazy-initialised database — only connects on first use, not at import time */
export const db = new Proxy({} as BetterSQLite3Database<typeof schema>, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop]
  },
})
