'use client'

import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { useDrawer } from './drawer-context'
import { StatusBadge } from './status-badge'
import { taskTitle } from '@/lib/task-title'
import { MessageThread } from './message-thread'
import { DiffViewer } from './diff-viewer'
import { LogViewer } from './log-viewer'
import { useDebouncedRefresh, useSSE, useTaskSelector } from '@/lib/hooks'
import { ServiceIcon } from './service-icon'
import type { Task, TaskSummary } from '@/lib/schema'
import type { PRStatePayload } from '@/lib/poll-transitions'
import { isReactionTarget } from '@/lib/reaction-target'
import { ExternalLink } from './external-link'

type PRState = Partial<PRStatePayload>

const FINISHED_STATUSES = new Set(['complete', 'failed', 'cancelled', 'resolved'])
const LIVE_STATUSES = new Set(['running', 'starting'])

function formatRelativeTime(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatAbsoluteTime(value: Date | string | number): string {
  return (value instanceof Date ? value : new Date(value)).toLocaleString()
}

function truncateAtWord(text: string, max = 120): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut}…`
}

function SectionCard({
  title,
  open,
  onToggle,
  badge,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] card-elevated overflow-hidden">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text)] transition-colors focus-ring"
      >
        <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        {title}
        {badge}
      </button>
      {open && (
        <div className="border-t border-[var(--border-subtle)] px-4 py-4">
          {children}
        </div>
      )}
    </section>
  )
}

export function TaskDetail({ taskId }: { taskId: string }) {
  const [fullTask, setFullTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  // The task list already holds everything the header shows, so render from it
  // immediately; the full row (launch config) fills in when the fetch lands
  const storeTask = useTaskSelector(ts => ts.find(t => t.id === taskId))
  const task: TaskSummary | null = fullTask ?? storeTask ?? null
  const [retrying, setRetrying] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ activity: true, changes: true })
  const activityAutoExpanded = useRef(false)
  const { openTicket } = useDrawer()

  const handleTicketClick = useCallback(async () => {
    if (!task?.ticketId) return
    try {
      const res = await fetch('/api/context')
      if (!res.ok) return
      const ctx = await res.json()
      const allTickets = [...(ctx.tickets ?? []), ...(ctx.unassignedTickets ?? []), ...(ctx.completedTickets ?? [])]
      const ticket = allTickets.find((t: { identifier: string }) => t.identifier === task.ticketId)
      if (ticket) {
        const allPrs = [...(ctx.myPRs ?? []), ...(ctx.recentlyMerged ?? [])]
        const linkedPrs = allPrs.filter((p: { number: number }) => ticket.linkedPrNumbers.includes(p.number))
        openTicket(ticket, linkedPrs)
      }
    } catch { /* ignore */ }
  }, [task?.ticketId, openTicket])

  const load = useCallback(async () => {
    const res = await fetch(`/api/tasks/${taskId}`)
    if (res.ok) {
      setFullTask(await res.json())
    }
    setLoading(false)
  }, [taskId])

  useEffect(() => { load() }, [load])

  // Activity is the live heartbeat of a running task — open it once on load,
  // but never fight a manual collapse afterwards.
  useEffect(() => {
    if (!task || activityAutoExpanded.current) return
    if (LIVE_STATUSES.has(task.status)) {
      activityAutoExpanded.current = true
      setCollapsed(s => ({ ...s, activity: false }))
    }
  }, [task])

  const debouncedLoad = useDebouncedRefresh(load)
  useSSE({
    'task:status': (e) => {
      const data = JSON.parse(e.data)
      if (data.taskId === taskId) debouncedLoad()
    },
    'message:new': (e) => {
      const data = JSON.parse(e.data)
      if (data.taskId === taskId) debouncedLoad()
    },
  })

  // Only for auto-dispatched tasks: the watcher (ship/watch task) on the same
  // PR whose poll transition spawned this one
  const watcherTask = useTaskSelector(ts =>
    task && task.dispatchedBy !== 'human' && task.prNumber != null
      ? ts.find(t => t.id !== task.id && t.prNumber === task.prNumber && isReactionTarget(t))
      : undefined,
  )

  const prStateJson = task?.prStateJson
  const prState = useMemo<PRState | null>(
    () => (prStateJson ? JSON.parse(prStateJson as string) : null),
    [prStateJson],
  )

  async function handleCancel() {
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
  }

  async function handleRetry() {
    if (!task) return
    setRetrying(true)
    const res = await fetch(`/api/tasks/${task.id}/retry`, {
      method: 'POST',
    })
    if (res.ok) {
      load()
    }
    setRetrying(false)
  }

  async function handleTogglePause() {
    if (!task) return
    const res = await fetch(`/api/tasks/${task.id}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause: task.pausedAt == null }),
    })
    if (res.ok) load()
  }

  function toggleSection(key: string) {
    if (key === 'activity') activityAutoExpanded.current = true
    setCollapsed(s => ({ ...s, [key]: !s[key] }))
  }

  if (!loading && !task) {
    return <p className="text-[var(--error)]">Task not found</p>
  }

  const isPaused = task ? task.pausedAt != null : false
  const isLive = task ? LIVE_STATUSES.has(task.status) : false
  // Same predicate the reconciler polls on — a completed ship task is still
  // an armed reaction target until its PR ships or it's failed/cancelled.
  const watching = task ? isReactionTarget(task) : false
  const showPauseToggle = watching

  // One compact meta line: links · timings · dispatch provenance
  const metaItems: { key: string; node: ReactNode }[] = []
  if (task) {
    if (task.ticketId) {
      metaItems.push({
        key: 'ticket',
        node: (
          <button onClick={handleTicketClick} className="text-[var(--accent)] hover:underline">
            <ServiceIcon service="linear" />{task.ticketId}
          </button>
        ),
      })
    }
    if (task.prUrl) {
      metaItems.push({
        key: 'pr',
        node: (
          <ExternalLink href={task.prUrl} className="text-[var(--accent)] hover:underline">
            <ServiceIcon service="github" />#{task.prUrl.split('/').pop()}
          </ExternalLink>
        ),
      })
    }
    metaItems.push({
      key: 'started',
      node: (
        <span className="tabular-nums" title={formatAbsoluteTime(task.createdAt)}>
          Started {formatRelativeTime(task.createdAt)}
        </span>
      ),
    })
    if (FINISHED_STATUSES.has(task.status)) {
      metaItems.push({
        key: 'finished',
        node: (
          <span className="tabular-nums" title={formatAbsoluteTime(task.updatedAt)}>
            Finished {formatRelativeTime(task.updatedAt)}
          </span>
        ),
      })
    }
    if (task.dispatchedBy !== 'human') {
      metaItems.push({
        key: 'dispatched',
        node: (
          <span>
            Auto-dispatched by {task.dispatchedBy}
            {watcherTask && (
              <>
                {' '}— triggered by{' '}
                <Link href={`/tasks/${watcherTask.id}`} className="text-[var(--accent)] hover:underline">
                  {taskTitle(watcherTask.prompt)}
                  {watcherTask.ticketId ? ` (${watcherTask.ticketId})` : ` (${watcherTask.id.slice(0, 8)})`}
                </Link>
                {' '}watching PR #{task.prNumber}
              </>
            )}
          </span>
        ),
      })
    }
  }

  return (
    <div className="space-y-4">
      {/* Hero header */}
      {!task ? (
        <p className="text-[var(--text-muted)]">Loading...</p>
      ) : (
      <div className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] card-elevated">
        {isLive && (
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent phase-bar-shimmer"
          />
        )}
        <div className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3 flex-wrap min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">
                {task.ticketId || `Task ${task.id.slice(0, 8)}`}
              </h1>
              <StatusBadge status={task.status} />
              {watching && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    isPaused
                      ? 'bg-amber-50 dark:bg-amber-500/10 text-[var(--warning)]'
                      : 'bg-[var(--accent-dim)] text-[var(--accent)]'
                  }`}
                  title={
                    isPaused
                      ? 'Watching this PR but auto-react is paused — no agents will be dispatched until resumed'
                      : 'This PR is being watched — new review comments or CI failures auto-dispatch agents'
                  }
                >
                  {isPaused ? `watching PR #${task.prNumber} · paused` : `watching PR #${task.prNumber}`}
                </span>
              )}
            </div>

            <div className="flex gap-2 shrink-0">
              {showPauseToggle && (
                <button
                  onClick={handleTogglePause}
                  title={isPaused ? 'Resume auto-react (CI / review dispatches)' : 'Pause auto-react — no CI/review dispatches while paused'}
                  className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                    isPaused
                      ? 'border-amber-300 dark:border-amber-500/40 text-[var(--warning)] hover:bg-amber-50 dark:hover:bg-amber-500/10'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-badge)]'
                  }`}
                >
                  {isPaused ? 'Paused — resume' : 'Pause auto-react'}
                </button>
              )}
              {task.status === 'failed' && (
                <button
                  onClick={handleRetry}
                  disabled={retrying}
                  className="px-3 py-1.5 text-sm rounded-md border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors disabled:opacity-50"
                >
                  {retrying ? 'Retrying...' : 'Retry'}
                </button>
              )}
              {(task.status === 'running' ||
                task.status === 'waiting_for_feedback' ||
                task.status === 'starting') && (
                <button
                  onClick={handleCancel}
                  className="px-3 py-1.5 text-sm rounded-md border border-red-300 dark:border-red-500/40 text-[var(--error)] hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
            {metaItems.map((item, i) => (
              <Fragment key={item.key}>
                {i > 0 && <span className="text-[var(--border)]">·</span>}
                {item.node}
              </Fragment>
            ))}
          </div>

          <p className="mt-3 text-sm font-medium leading-relaxed" title={task.prompt.split('\n')[0]}>
            {truncateAtWord(taskTitle(task.prompt))}
          </p>

          {task.statusMessage && (
            <div className="mt-3 rounded-r-md border-l-2 border-[var(--accent)] bg-[var(--accent-dim)] px-3 py-2 text-sm">
              {task.statusMessage}
            </div>
          )}

          {/* PR State badges */}
          {prState && (
            <div className="flex items-center gap-2 mt-3">
              {prState.ciStatus && (
                <span
                  className={`text-xs px-2 py-0.5 rounded ${
                    prState.ciStatus === 'SUCCESS'
                      ? 'bg-green-50 dark:bg-green-500/10 text-[var(--success)]'
                      : prState.ciStatus === 'FAILURE'
                        ? 'bg-red-50 dark:bg-red-500/10 text-[var(--error)]'
                        : 'bg-amber-50 dark:bg-amber-500/10 text-[var(--warning)]'
                  }`}
                >
                  CI: {prState.ciStatus.toLowerCase()}
                </span>
              )}
              {prState.reviewDecision && (
                <span
                  className={`text-xs px-2 py-0.5 rounded ${
                    prState.reviewDecision === 'APPROVED'
                      ? 'bg-green-50 dark:bg-green-500/10 text-[var(--success)]'
                      : prState.reviewDecision === 'CHANGES_REQUESTED'
                        ? 'bg-red-50 dark:bg-red-500/10 text-[var(--error)]'
                        : 'bg-[var(--bg-badge)] text-[var(--text-badge)]'
                  }`}
                >
                  {prState.reviewDecision.toLowerCase().replace('_', ' ')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      )}

      <SectionCard
        title="Messages"
        open={!collapsed.messages}
        onToggle={() => toggleSection('messages')}
        badge={
          /* say/note messages never set waiting_for_feedback, so this only
             fires when the agent is genuinely blocked on a human answer */
          task?.status === 'waiting_for_feedback' ? (
            <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-[var(--waiting)]/10 text-[var(--waiting)]">
              Waiting on you
            </span>
          ) : null
        }
      >
        <MessageThread taskId={taskId} />
      </SectionCard>

      <SectionCard title="Activity" open={!collapsed.activity} onToggle={() => toggleSection('activity')}>
        <LogViewer taskId={taskId} />
      </SectionCard>

      <SectionCard title="Changes" open={!collapsed.changes} onToggle={() => toggleSection('changes')}>
        <DiffViewer taskId={taskId} />
      </SectionCard>

      {fullTask && <LaunchConfig task={fullTask} />}
    </div>
  )
}

function LaunchConfig({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  if (!task.launchConfigJson) return null
  return (
    <SectionCard title="Launch Config" open={open} onToggle={() => setOpen(o => !o)}>
      <LaunchConfigBody launchConfigJson={task.launchConfigJson} containerId={task.containerId} />
    </SectionCard>
  )
}

// Mounted only while the section is open — the config can be ~60KB of JSON
function LaunchConfigBody({ launchConfigJson, containerId }: { launchConfigJson: string; containerId: string | null }) {
  const config = useMemo(() => JSON.parse(launchConfigJson) as {
    instruction?: string
    prompt: string
    tags: string[]
    context?: { ticketId?: string; prNumber?: number }
  }, [launchConfigJson])
  const mode = config.tags[0] || '—'

  return (
    <div className="space-y-3 text-sm">
      <div className="flex gap-4">
        <div>
          <span className="text-[var(--text-muted)]">Mode:</span>{' '}
          <span className="font-medium">{mode}</span>
        </div>
        {containerId && (
          <div>
            <span className="text-[var(--text-muted)]">Container:</span>{' '}
            <span className="font-mono text-xs">{containerId.slice(0, 12)}</span>
          </div>
        )}
        {config.context?.ticketId && (
          <div>
            <span className="text-[var(--text-muted)]">Ticket:</span>{' '}
            <span>{config.context.ticketId}</span>
          </div>
        )}
        {config.context?.prNumber && (
          <div>
            <span className="text-[var(--text-muted)]">PR:</span>{' '}
            <span>#{config.context.prNumber}</span>
          </div>
        )}
      </div>
      {config.instruction && (
        <div>
          <p className="text-[var(--text-muted)] mb-1">Instruction:</p>
          <p className="text-[var(--text)]">{config.instruction}</p>
        </div>
      )}
      <div>
        <p className="text-[var(--text-muted)] mb-1">Full prompt:</p>
        <pre className="text-xs bg-[var(--bg-input)] border border-[var(--border)] rounded p-3 overflow-x-auto whitespace-pre-wrap">{config.prompt}</pre>
      </div>
    </div>
  )
}
