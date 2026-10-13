'use client'

import { useState } from 'react'
import { refreshTasks, useTaskSelector } from '@/lib/hooks'
import { parseTaskTags } from '@/lib/parse-tags'
import { SHIP_TAG } from '@/lib/constants'
import { isReactionTarget } from '@/lib/reaction-target'

export function WatchToggle({ prNumber }: { prNumber: number }) {
  const [pending, setPending] = useState(false)
  const watcher = useTaskSelector(tasks => tasks.find(t => t.prNumber === prNumber && isReactionTarget(t)))

  // Ship tasks can't be unwatched via DELETE /api/watch — their off-switch is
  // the pause flag, which the reconciler's dispatch gate checks.
  if (watcher && parseTaskTags(watcher.tags).includes(SHIP_TAG)) {
    const paused = watcher.pausedAt != null
    return (
      <button
        disabled={pending}
        onClick={async (e) => {
          e.stopPropagation()
          setPending(true)
          try {
            await fetch(`/api/tasks/${watcher.id}/pause`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pause: !paused }),
            })
            await refreshTasks()
          } finally {
            setPending(false)
          }
        }}
        className={`text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors disabled:opacity-50 group ${
          paused
            ? 'bg-amber-50 dark:bg-amber-500/10 text-[var(--warning)] hover:bg-[var(--accent-dim)] hover:text-[var(--accent)]'
            : 'bg-[var(--accent-dim)] text-[var(--accent)] hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-[var(--warning)]'
        }`}
        title={
          paused
            ? 'Auto-react paused for this PR — click to resume CI/review dispatches'
            : 'Watching for CI failures and review comments (via ship task) — click to pause auto-dispatch'
        }
      >
        {paused ? (
          <>
            <span className="group-hover:hidden">Paused</span>
            <span className="hidden group-hover:inline">Resume</span>
          </>
        ) : (
          <>
            <span className="group-hover:hidden">Watching</span>
            <span className="hidden group-hover:inline">Pause</span>
          </>
        )}
      </button>
    )
  }

  if (watcher) {
    return (
      <button
        disabled={pending}
        onClick={async (e) => {
          e.stopPropagation()
          if (!confirm(`Stop watching PR #${prNumber}?\n\nThe dashboard will no longer dispatch agents on CI failures or review comments for this PR.`)) return
          setPending(true)
          try {
            await fetch(`/api/watch?prNumber=${prNumber}`, { method: 'DELETE' })
          } finally {
            setPending(false)
          }
        }}
        className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-dim)] text-[var(--accent)] font-medium hover:bg-[var(--error)]/15 hover:text-[var(--error)] transition-colors disabled:opacity-50 group"
        title="Watching for CI failures and review comments — click to stop"
      >
        <span className="group-hover:hidden">Watching</span>
        <span className="hidden group-hover:inline">Unwatch</span>
      </button>
    )
  }

  return (
    <button
      disabled={pending}
      onClick={async (e) => {
        e.stopPropagation()
        setPending(true)
        try {
          await fetch('/api/watch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prNumber }),
          })
        } finally {
          setPending(false)
        }
      }}
      className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
      title="Make this PR a reaction target — agents will auto-dispatch on CI failures and review comments"
    >
      {pending ? 'Watching…' : 'Watch'}
    </button>
  )
}
