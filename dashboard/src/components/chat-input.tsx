'use client'

import { useEffect, useRef } from 'react'

// Styled after the Claude Code app's input: one line that grows, with a
// return-key send icon inside on the right. Enter submits, Shift+Enter adds a line.
// A white field with a hairline edge and a soft shadow, so it reads as somewhere
// to type even on a white tile
export function ChatInput({ value, onChange, onSubmit, placeholder, label, sendLabel, busy, autoFocus = false, className = '' }: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder: string
  label: string
  sendLabel: string
  busy?: boolean
  autoFocus?: boolean
  className?: string
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Focus on mount without scrolling, so a long question above stays in view;
  // typing brings the box into view
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true })
  }, [autoFocus])

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit() }}
      className={`flex items-end gap-2 pl-3.5 pr-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-[0_1px_3px_rgba(0,0,0,0.04)] focus-within:border-[var(--text-muted)] transition-colors ${className}`}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onSubmit()
          }
        }}
        rows={1}
        aria-label={label}
        placeholder={placeholder}
        className="block flex-1 min-w-0 resize-none [field-sizing:content] min-h-10 max-h-48 py-2.5 bg-transparent text-[13px] leading-5 placeholder:text-[var(--text-muted)] focus:outline-none"
      />
      <button
        type="submit"
        disabled={busy || !value.trim()}
        aria-label={sendLabel}
        title={`${sendLabel} (Enter)`}
        className="mb-2 w-6 h-6 shrink-0 flex items-center justify-center rounded-md text-[var(--text)] hover:bg-[var(--bg-badge)] disabled:text-[var(--text-muted)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
      >
        {busy ? (
          <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 10l-5 5 5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></svg>
        )}
      </button>
    </form>
  )
}
