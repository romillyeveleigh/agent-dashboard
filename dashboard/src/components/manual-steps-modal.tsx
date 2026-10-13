'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Md } from '@/components/markdown'

export interface VerifyModalItem {
  id: string        // ticket identifier ("ENG-260") or PR number as string ("#6701")
  title: string     // editorial title
  prNumber?: number // for direct PR lookup (orphan PRs, review PRs)
  isReview?: boolean // true if reviewing someone else's PR
}

export function ManualStepsModal({ item, context, onClose }: {
  item: VerifyModalItem
  context: string
  onClose: () => void
}) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Hold the latest context without making it a fetch dependency. Otherwise a
  // background `context:updated` SSE event recreates `fetchInstructions` and
  // re-triggers generation, wiping the modal content while the user is reading.
  const contextRef = useRef(context)
  contextRef.current = context

  const fetchInstructions = useCallback(async () => {
    setLoading(true)
    setError(null)
    setContent('')

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const payload: Record<string, unknown> = { context: contextRef.current }
      if (item.prNumber) {
        payload.prNumber = item.prNumber
      } else {
        payload.workItemId = item.id
      }
      if (item.isReview) payload.isReview = true

      const res = await fetch('/api/manual-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Request failed (${res.status})`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        accumulated += decoder.decode(value, { stream: true })
        setContent(accumulated)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Failed to generate instructions')
    } finally {
      setLoading(false)
    }
  }, [item.id, item.prNumber, item.isReview])

  useEffect(() => {
    fetchInstructions()
    return () => { abortRef.current?.abort() }
  }, [fetchInstructions])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-[71] w-full max-w-2xl max-h-[80vh] overflow-y-auto bg-[var(--bg)] border border-[var(--border)] rounded-xl p-6 shadow-2xl mx-4">
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="text-[var(--accent)] font-medium">{item.id}</span>
            <span className="text-[var(--text-muted)] mx-1.5">·</span>
            <span className="text-[var(--text)]">{item.title}</span>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text)] text-sm px-2 py-0.5 rounded transition-colors shrink-0 ml-4"
          >
            ✕
          </button>
        </div>

        {loading && !content && (
          <div className="flex items-center gap-2 text-[var(--text-muted)] text-[13px] py-4">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
            Generating verification steps...
          </div>
        )}

        {error && (
          <div className="text-[13px] text-[var(--error)] py-2">
            {error}
            <button
              onClick={fetchInstructions}
              className="ml-2 text-[var(--accent)] hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {content && <Md>{content}</Md>}
      </div>
    </div>
  )
}
