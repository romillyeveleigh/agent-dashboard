'use client'

import { useMessages } from '@/lib/hooks'
import { ExternalLink } from '@/components/external-link'
import { ChatInput } from '@/components/chat-input'
import { memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '@/lib/schema'

const MD_PLUGINS = [remarkGfm]
const MD_COMPONENTS: Components = {
  ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1 my-2">{children}</ol>,
  ul: ({ children }) => <ul className="list-disc pl-5 space-y-1 my-2">{children}</ul>,
  li: ({ children }) => <li className="text-[13px]">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-[var(--text)]">{children}</strong>,
  p: ({ children }) => <p className="my-1.5">{children}</p>,
  code: ({ children, className }) => className
    ? <code className={`${className} block bg-[var(--bg-code)] rounded-lg p-2.5 my-2 text-xs overflow-x-auto`}>{children}</code>
    : <code className="bg-[var(--bg-code)] rounded px-1 py-0.5 text-xs">{children}</code>,
  pre: ({ children }) => <>{children}</>,
  a: ({ href, children }) => (
    <ExternalLink href={href} className="text-[var(--accent)] hover:underline">
      {children}
    </ExternalLink>
  ),
}

// Memoized on content so message refetches and parent re-renders don't re-parse
const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
      {content}
    </ReactMarkdown>
  )
})

// Shaped like the messages so the first fetch doesn't flash the empty state
export function MessageThreadSkeleton() {
  return (
    <div className="space-y-5 animate-pulse">
      {['w-3/4', 'w-1/2'].map((w) => (
        <div key={w} className="space-y-2">
          <div className="h-3 w-12 rounded bg-[var(--border-subtle)] mb-3" />
          <div className="h-3 w-full rounded bg-[var(--border-subtle)]" />
          <div className={`h-3 ${w} rounded bg-[var(--border-subtle)]`} />
        </div>
      ))}
    </div>
  )
}

// The open one names what it needs from you; answered ones just say what they were
const PENDING_LABELS: Record<string, string> = {
  question: 'Question for you',
  approval: 'Approval needed',
  blocker: 'Blocked on you',
}
const ASKED_LABELS: Record<string, string> = {
  question: 'Question',
  approval: 'Approval request',
  blocker: 'Blocker',
}

// Messages are plain text on their tile, split by inset rules; no boxes. Anything
// the agent asked is set off by a purple rule down its left and a purple heading;
// the one still waiting on you has the reply box right under it, outside the rule
// since it's yours
function MessageCard({ msg, pending, dismissing, onDismiss, children }: { msg: Message; pending: boolean; dismissing: boolean; onDismiss: () => void; children?: React.ReactNode }) {
  const fromAgent = msg.direction === 'agent_to_human'
  const asked = fromAgent && !!msg.type && msg.type !== 'answer'
  return (
    <div className="py-4 first:pt-0 last:pb-0 text-sm">
      <div className={asked ? 'border-l-2 border-[var(--waiting)] pl-4' : ''}>
        <div className={`flex items-baseline gap-2 text-[12px] ${asked ? 'mb-2' : 'mb-1'}`}>
          {asked ? (
            <span className="text-[13px] font-semibold text-[var(--waiting)]">
              {(pending ? PENDING_LABELS : ASKED_LABELS)[msg.type ?? ''] ?? (pending ? 'Needs your reply' : msg.type)}
            </span>
          ) : (
            <span className="font-medium text-[var(--text)]">{fromAgent ? 'Agent' : 'You'}</span>
          )}
          {fromAgent && !msg.type && (
            <span className="text-[var(--text-muted)]">note</span>
          )}
          {fromAgent && !msg.answered && msg.type != null && (
            <button
              onClick={onDismiss}
              disabled={dismissing}
              className="ml-auto text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50 transition-colors"
              title="Mark this question as resolved without sending a reply"
            >
              {dismissing ? 'Dismissing…' : 'Dismiss'}
            </button>
          )}
        </div>
        {fromAgent ? (
          <div className="markdown-content text-[13px] leading-relaxed">
            <MessageMarkdown content={msg.content} />
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-[13px]">{msg.content}</p>
        )}
      </div>
      {children}
    </div>
  )
}

export function MessageThread({ taskId, autoFocusReply = false, collapseToLatest = false }: { taskId: string; autoFocusReply?: boolean; collapseToLatest?: boolean }) {
  const { messages, loaded, refresh } = useMessages(taskId)
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [showEarlier, setShowEarlier] = useState(false)

  // A message blocks the agent only when it expects an answer: non-null type
  // ('question' | 'approval' | 'blocker') and not yet answered. Fire-and-forget
  // notes (`say` tool, recovered replies) have type null and are answered from
  // birth — they must never summon the answer input.
  const pendingIndex = messages.findIndex(
    (m) => m.direction === 'agent_to_human' && !m.answered && m.type != null,
  )
  const pendingQuestion = pendingIndex === -1 ? undefined : messages[pendingIndex]
  // Fold everything before a pending question so it (and the answer box) sit
  // at the top of the thread instead of below the whole history. The drawer
  // (collapseToLatest) folds down to the latest message even with nothing pending
  const earlierCount = pendingQuestion ? pendingIndex : collapseToLatest ? Math.max(messages.length - 1, 0) : 0
  const visible = earlierCount && !showEarlier ? messages.slice(earlierCount) : messages

  async function handleDismiss(messageId: string) {
    if (dismissingId) return
    setDismissingId(messageId)
    try {
      const res = await fetch(`/api/messages/${messageId}/dismiss`, {
        method: 'POST',
      })
      if (res.ok) await refresh()
    } finally {
      setDismissingId(null)
    }
  }

  if (!messages.length) {
    if (!loaded) return <MessageThreadSkeleton />
    return (
      <p className="text-sm text-[var(--text-muted)]">
        No messages yet. The agent will post questions and progress notes here.
      </p>
    )
  }

  return (
    <div>
      {earlierCount > 0 && (
        <button
          onClick={() => setShowEarlier(s => !s)}
          aria-expanded={showEarlier}
          className="flex items-center gap-1.5 mb-4 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        >
          <span className={`text-[9px] transition-transform duration-150 ${showEarlier ? 'rotate-90' : ''}`}>&#9654;</span>
          {showEarlier ? 'Hide' : 'Show'} {earlierCount} earlier message{earlierCount === 1 ? '' : 's'}
        </button>
      )}
      <div className="divide-y divide-[var(--border-subtle)]">
        {visible.map((msg) => (
          <MessageCard
            key={msg.id}
            msg={msg}
            pending={msg.id === pendingQuestion?.id}
            dismissing={dismissingId === msg.id}
            onDismiss={() => handleDismiss(msg.id)}
          >
            {/* Right under the question, so it's unmistakably the reply to it */}
            {msg.id === pendingQuestion?.id && <AnswerForm taskId={taskId} onSent={refresh} autoFocus={autoFocusReply} />}
          </MessageCard>
        ))}
      </div>
    </div>
  )
}

// Own component so typing re-renders only the form, not every message
function AnswerForm({ taskId, onSent, autoFocus }: { taskId: string; onSent: () => Promise<void>; autoFocus: boolean }) {
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)

  async function handleSubmit() {
    if (!answer.trim() || sending) return

    setSending(true)
    try {
      const res = await fetch('/api/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, text: answer.trim() }),
      })
      if (res.ok) {
        setAnswer('')
        await onSent()
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <ChatInput
      value={answer}
      onChange={setAnswer}
      onSubmit={handleSubmit}
      placeholder="Reply to the agent"
      label="Reply to the agent"
      sendLabel="Send reply"
      busy={sending}
      autoFocus={autoFocus}
      className="mt-3"
    />
  )
}
