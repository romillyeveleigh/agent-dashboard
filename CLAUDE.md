# Agent Dashboard

An orchestration dashboard for running autonomous Claude Code agents in Docker containers. Dispatches tasks, streams logs, handles human-in-the-loop feedback, and provides AI-powered briefings.

## Architecture

```
Dashboard (Next.js 15)          Docker Containers
┌─────────────────────┐         ┌──────────────────┐
│ UI (React 19)       │   SSE   │ Claude Code      │
│ API Routes          │◄────────│ (headless)       │
│ SQLite (Drizzle)    │  HTTP   │                  │
│ SSE Events          │────────►│ MCP Channel      │
└─────────────────────┘         │ Server (stdio)   │
                                └──────────────────┘
```

- **Tasks** are generic: a prompt + optional tags + optional context (ticketId, prNumber)
- **Quick actions** (Implement, Review, Plan, etc.) are UI shortcuts that pre-fill prompts — defined in `dashboard/src/lib/quick-actions.ts`
- **The backend never validates task types** — any prompt works
- **Skills** are mounted at runtime via Docker bind mount (no image rebuild needed)
- **Integrations** (Linear, GitHub) are optional — the dashboard works with any combination

## Project Structure

```
dashboard/              Next.js app
  src/
    app/                Pages and API routes
      api/tasks/              Task CRUD + container lifecycle
      api/dashboard-briefing/ AI briefing (streaming)
      api/dashboard-cache/    Cached aggregated dashboard data
      api/context/            Aggregated PR/ticket/housekeeping data
      api/questions/          Agent → human communication
      api/answers/            Human → agent communication
      api/status/             Agent status updates
      api/diffs/              Agent diff submissions
      api/events/             SSE event stream
      api/memories/           Task learnings / memory store
      api/review-lessons/     Review-lesson harvest + listing
      api/metrics/            Dashboard metrics
      api/manual-steps/       Human-in-the-loop manual steps
      api/tickets/            Linear ticket lookup
      api/user/               Current user info
      api/watch/              Watch tasks for PR/ticket signals
      api/webhooks/           GitHub webhooks
    components/         React components
    lib/
      quick-actions.ts       DISPATCH_MODES + DRAWER_PRESETS (add new shortcuts here)
      constants.ts           Shared constants (DEFAULT_SKILL, tags, statuses)
      schema.ts              Drizzle ORM table definitions
      db.ts                  SQLite init + lazy proxy + migrations
      docker.ts              Container lifecycle (start, stop, inspect)
      dispatch.ts            Dispatch orchestration (server)
      dispatch-task.ts       Task dispatch helpers
      use-dispatch-task.ts   Client-side dispatch hook
      prompt-builder.ts      Builds AGENT_PROMPT from mode + context
      integrations.ts        Integration config + URL helpers
      resilient-fetch.ts     Fetch wrapper with retry + timeout
      reconciler.ts          Background container health checker
      reconciler-logs.ts     Reconciler log helpers
      events.ts              SSE event emitter
      github.ts              GitHub GraphQL queries
      linear-data.ts         Linear GraphQL queries
      bot-filter.ts          Ignored-bot filtering
      poll-transitions.ts    PR-state poll transitions
      should-skip-dispatch.ts Skip logic (on-hold labels, etc.)
      ship-tasks.ts          Ship-mode task helpers
      task-locks.ts          Per-task dispatch locks
      parse-tags.ts          Tag parsing
      memory-queries.ts      Memory store queries
      learning-extractor.ts  Extract learnings from task output
      review-lesson-harvester.ts  Merged-PR review-comment harvester
      context-fetchers.ts    Context-aggregation helpers
      briefing-editorial.ts  Briefing slim view + per-item editorial cache (hash, diff, ordering)
      request-rereview.ts    Request re-review on PRs
      hooks.ts               Shared React hooks
  data/                 SQLite database (gitignored)

docker/
  Dockerfile            Agent worker image
  entrypoint.sh         Container entrypoint (reads AGENT_PROMPT)

.claude/skills/         Skills mounted into containers at runtime
```

## Dev Commands

### Start

```bash
pnpm start
```

Builds and runs the production server (`next build` + `next start`). Use this
for day-to-day running — `next dev` compiles routes on first hit and runs dev
React, which makes the UI noticeably sluggish. Rebuild (re-run `pnpm start`)
after pulling or editing dashboard code; skills are runtime-mounted and don't
need a rebuild.

```bash
pnpm dev
```

Dev mode with hot reload, for working on the dashboard itself.

Both serve the dashboard UI + API on port 3001.

### Stop

Press `Ctrl+C` in the terminal.

If port 3001 is stuck from a previous run:

```bash
lsof -ti:3001 | xargs kill
```

### Other commands

```bash
# Type-check
pnpm --dir dashboard exec tsc --noEmit

# Build Docker image (required after changing entrypoint.sh or docker/supervisor/)
docker build --no-cache -t agent-worker:local -f docker/Dockerfile .

# Apply schema changes (preserves existing task logs and memories)
# Option 1 — add an idempotent migration to the `migrations` array in dashboard/src/lib/db.ts
#   (runs automatically on next startup; safe to re-run)
# Option 2 — use Drizzle Kit directly:
pnpm --dir dashboard db:push
```

## Key Concepts

### Tasks are prompts, not modes
Every task is a `{ prompt, tags?, context? }`. There is no mode enum. Quick actions in `quick-actions.ts` are UI-only shortcuts that pre-fill prompts (current set: Implement, Review, Plan, Housekeeping, Brainstorm, General, Ship it). To add a new task type, add an entry to `DISPATCH_MODES` (and optionally `DRAWER_PRESETS` for contextual presets) — no other files need changing.

### Skills are runtime-mounted
Skills live in `.claude/skills/` and are bind-mounted into containers at `/opt/skills:ro`. Edit a skill file and the next task dispatch uses the updated version. No Docker image rebuild.

### Integrations are optional
Set env vars to enable/disable: `LINEAR_API_KEY` for Linear, `GITHUB_TOKEN` + `GITHUB_USERNAME` for GitHub. `REPO_PATH` (optional) points at a local clone used as a reference cache for faster container clones. The dashboard gracefully degrades when integrations are missing.

### Self-healing
- Background reconciler checks container health every 10s
- Failed tasks auto-retry once (configurable via `max_retries`)
- External API calls use resilient-fetch (2 retries, exponential backoff)
- The supervisor's `reply` tool polls for an answer up to `REPLY_GRACE_WINDOW_MS` (default 10min), then safely suspends the task — it resumes automatically once the human answers

## Environment Variables

See `.env.example` for full list with descriptions. Required vars:
- `DASHBOARD_URL` — how containers reach the dashboard
- `CLAUDE_CODE_OAUTH_TOKEN` — for headless Claude Code
- `GITHUB_TOKEN` + `GITHUB_USERNAME` — for PR/review data
- `ANTHROPIC_API_KEY` — for briefing/chat AI
- `REPO_URL` — GitHub repo (org/repo format)
