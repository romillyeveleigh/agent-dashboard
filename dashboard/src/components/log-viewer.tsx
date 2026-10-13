'use client'

import { useLogs } from '@/lib/hooks'
import { memo, useEffect, useRef, useState } from 'react'
import type { Log } from '@/lib/schema'

// Claude's own words and errors stand out; tool calls, results and system
// lines recede to grey
const TYPE_STYLES: Record<string, string> = {
  assistant: 'text-[var(--text)]',
  thinking: 'text-[var(--text-muted)] italic',
  error: 'text-[var(--error)]',
}

const TYPE_LABELS: Record<string, string> = {
  assistant: 'Claude',
  thinking: 'Thought',
  tool_use: 'Tool',
  tool_result: 'Result',
  system: 'System',
  error: 'Error',
}

const LogRow = memo(function LogRow({ log }: { log: Log }) {
  return (
    <div className="flex gap-2">
      <span className={`shrink-0 w-14 text-right ${log.type === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-muted)] opacity-70'}`}>
        {TYPE_LABELS[log.type] || log.type}
      </span>
      <span className={`whitespace-pre-wrap break-all ${TYPE_STYLES[log.type] || 'text-[var(--text-muted)]'}`}>
        {log.content}
      </span>
    </div>
  )
})

export function LogViewer({ taskId, maxHeight = '500px' }: { taskId: string; maxHeight?: string }) {
  const { logs, loaded } = useLogs(taskId)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow new output only while the user is at the bottom, and scroll this
  // box directly — scrollIntoView also dragged the page and drawer along.
  const pinnedRef = useRef(true)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    const el = scrollRef.current
    if (el && autoScroll && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [logs, autoScroll])

  const handleScroll = () => {
    const el = scrollRef.current
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  if (!logs.length) {
    // Shaped like log rows (label column + content) until the first fetch lands
    if (!loaded) {
      return (
        <div className="space-y-2 animate-pulse pr-2">
          {['w-2/3', 'w-5/6', 'w-1/2', 'w-3/4'].map((w) => (
            <div key={w} className="flex gap-2">
              <div className="shrink-0 w-14 flex justify-end">
                <div className="h-3 w-10 rounded bg-[var(--border-subtle)]" />
              </div>
              <div className={`h-3 ${w} rounded bg-[var(--border-subtle)]`} />
            </div>
          ))}
        </div>
      )
    }
    return (
      <p className="text-sm text-[var(--text-muted)]">
        No activity yet. Logs appear here as the agent works.
      </p>
    )
  }

  // A warm inset well, so the scrolling region reads as one block on its tile
  return (
    <div className="relative rounded-xl bg-[var(--bg)]">
      <button
        onClick={() => { pinnedRef.current = true; setAutoScroll(a => !a) }}
        aria-pressed={autoScroll}
        className="absolute top-2 right-3 z-10 px-1.5 rounded bg-[var(--bg)] text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        title={autoScroll ? 'Stop following new activity' : 'Follow new activity as it arrives'}
      >
        Auto-scroll {autoScroll ? 'on' : 'off'}
      </button>
      <div ref={scrollRef} onScroll={handleScroll} className="overflow-y-auto space-y-1 font-mono text-xs px-3 py-2.5" style={{ maxHeight }}>
        {logs.map((log) => <LogRow key={log.id} log={log} />)}
      </div>
    </div>
  )
}
