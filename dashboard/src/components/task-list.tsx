'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { isReactionTarget } from '@/lib/reaction-target'
import { useTasks } from '@/lib/hooks'
import { useDispatchTask } from '@/lib/use-dispatch-task'
import { taskSummary, taskTitle } from '@/lib/task-title'
import type { TaskSummary } from '@/lib/schema'
import { useDrawer } from './drawer-context'
import { StatusBadge } from './status-badge'
import { ChatInput } from './chat-input'

const FINISHED_STATUSES = new Set(['complete', 'failed', 'cancelled', 'resolved'])
const ACTIVE_STATUSES = new Set(['pending', 'starting', 'running', 'waiting_for_feedback', 'watching'])
const RECENT_FINISHED_MS = 24 * 60 * 60 * 1000

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

function isCurrentTask(task: TaskSummary): boolean {
  return ACTIVE_STATUSES.has(task.status) || isReactionTarget(task)
}

function isRecentlyFinished(task: TaskSummary): boolean {
  if (!FINISHED_STATUSES.has(task.status)) return false
  const finishedAt = task.updatedAt instanceof Date ? task.updatedAt : new Date(task.updatedAt)
  return Date.now() - finishedAt.getTime() < RECENT_FINISHED_MS
}

function QuickDispatch() {
  const router = useRouter()
  const { dispatch, dispatching } = useDispatchTask()
  const [prompt, setPrompt] = useState('')

  async function handleSubmit() {
    if (!prompt.trim() || dispatching) return
    const result = await dispatch({ prompt: prompt.trim() })
    if (result.ok) {
      setPrompt('')
      router.push(`/tasks/${result.id}`)
    }
  }

  return (
    <ChatInput
      value={prompt}
      onChange={setPrompt}
      onSubmit={handleSubmit}
      placeholder="Tell the agent what to do"
      label="New task"
      sendLabel="Dispatch task"
      busy={dispatching}
      className="mb-4"
    />
  )
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 pt-2 first:pt-0">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </h2>
      <span className="text-[11px] text-[var(--text-muted)] tabular-nums">{count}</span>
    </div>
  )
}

function TaskRow({
  task,
  finished,
  onCancel,
  onTicketClick,
}: {
  task: TaskSummary
  finished?: boolean
  onCancel: (id: string) => void
  onTicketClick: (e: React.MouseEvent, ticketId: string) => void
}) {
  const router = useRouter()

  return (
    <div
      onClick={() => router.push(`/tasks/${task.id}`)}
      onMouseEnter={() => router.prefetch(`/tasks/${task.id}`)}
      className={`cursor-pointer flex items-center gap-4 p-4 rounded-lg border transition-colors ${
        finished
          ? 'border-[var(--border)]/60 bg-[var(--bg-card)]/50 opacity-70 hover:opacity-100 hover:bg-[var(--bg-card-hover)]'
          : 'border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)]'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate" title={taskSummary(task.prompt)}>{taskTitle(task.prompt)}</p>
        <div className="flex items-center gap-2 mt-1 empty:hidden">
          {task.ticketId && (
            <button
              onClick={(e) => onTicketClick(e, task.ticketId!)}
              className="text-xs text-[var(--accent)] hover:underline"
            >
              {task.ticketId}
            </button>
          )}
          {task.prUrl && (
            <span className="text-xs text-[var(--accent)]">PR</span>
          )}
          {isReactionTarget(task) && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                task.pausedAt != null
                  ? 'bg-amber-50 dark:bg-amber-500/10 text-[var(--warning)]'
                  : 'bg-[var(--accent-dim)] text-[var(--accent)]'
              }`}
              title={
                task.pausedAt != null
                  ? `Watching PR #${task.prNumber} but auto-react is paused`
                  : `Watching PR #${task.prNumber} — review comments and CI failures auto-dispatch agents`
              }
            >
              {task.pausedAt != null ? 'watching · paused' : 'watching'}
            </span>
          )}
          {task.dispatchedBy !== 'human' && (
            <span
              className="text-xs px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]"
              title={`Auto-dispatched by ${task.dispatchedBy}`}
            >
              auto
            </span>
          )}
        </div>
        {task.statusMessage && (
          <p className="text-xs text-[var(--text-muted)] mt-1 break-words">
            {task.statusMessage}
          </p>
        )}
      </div>
      <div className="shrink-0 text-right text-[11px] text-[var(--text-muted)] leading-relaxed tabular-nums">
        <div title={formatAbsoluteTime(task.createdAt)}>
          Started {formatRelativeTime(task.createdAt)}
        </div>
        {FINISHED_STATUSES.has(task.status) && (
          <div title={formatAbsoluteTime(task.updatedAt)}>
            Finished {formatRelativeTime(task.updatedAt)}
          </div>
        )}
      </div>
      <StatusBadge status={task.status} />
      {!finished && (
        <button
          onClick={(e) => { e.stopPropagation(); onCancel(task.id) }}
          className="text-[11px] text-[var(--text-muted)] hover:text-[var(--error)] transition-colors px-2 py-1 rounded shrink-0"
          title="Cancel task"
        >
          ✕
        </button>
      )}
    </div>
  )
}

export function TaskList() {
  const { tasks, loading } = useTasks()
  const { openTicket } = useDrawer()
  const [showAll, setShowAll] = useState(false)

  const currentTasks = tasks.filter(isCurrentTask)
  const finishedTasks = tasks.filter(t => {
    if (isCurrentTask(t) || !FINISHED_STATUSES.has(t.status)) return false
    return showAll || isRecentlyFinished(t)
  })
  const hasVisible = currentTasks.length > 0 || finishedTasks.length > 0

  const handleCancel = useCallback(async (id: string) => {
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' })
  }, [])

  const handleTicketClick = useCallback(async (e: React.MouseEvent, ticketId: string) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      const res = await fetch('/api/context')
      if (!res.ok) return
      const ctx = await res.json()
      const allTickets = [...(ctx.tickets ?? []), ...(ctx.unassignedTickets ?? []), ...(ctx.completedTickets ?? [])]
      const ticket = allTickets.find((t: { identifier: string }) => t.identifier === ticketId)
      if (ticket) {
        const allPrs = [...(ctx.myPRs ?? []), ...(ctx.recentlyMerged ?? [])]
        const linkedPrs = allPrs.filter((p: { number: number }) => ticket.linkedPrNumbers.includes(p.number))
        openTicket(ticket, linkedPrs)
      }
    } catch { /* ignore */ }
  }, [openTicket])

  if (loading) {
    return <p className="text-[var(--text-muted)]">Loading tasks...</p>
  }

  return (
    <div className="space-y-3">
      <QuickDispatch />
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-[var(--text-muted)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Show all tasks
        </label>
      </div>

      {!hasVisible ? (
        <div className="text-center py-16">
          <p className="text-[var(--text-muted)] mb-4">{showAll ? 'No tasks yet' : 'No recent tasks'}</p>
          <Link
            href="/dispatch"
            className="inline-block px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-md text-sm font-medium transition-colors"
          >
            Dispatch a structured task
          </Link>
        </div>
      ) : (
        <>
          {currentTasks.length > 0 && (
            <section className="space-y-2">
              <SectionHeader label="Current" count={currentTasks.length} />
              {currentTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onCancel={handleCancel}
                  onTicketClick={handleTicketClick}
                />
              ))}
            </section>
          )}

          {finishedTasks.length > 0 && (
            <section className="space-y-2">
              <SectionHeader
                label={showAll ? 'Finished' : 'Recently finished'}
                count={finishedTasks.length}
              />
              {finishedTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  finished
                  onCancel={handleCancel}
                  onTicketClick={handleTicketClick}
                />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  )
}
