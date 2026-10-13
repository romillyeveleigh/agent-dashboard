'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DISPATCH_MODES, type DispatchMode } from '@/lib/quick-actions'
import { useDispatchTask } from '@/lib/use-dispatch-task'

export function DispatchForm() {
  const router = useRouter()
  const { dispatch, dispatching } = useDispatchTask()
  const [mode, setMode] = useState<DispatchMode | null>(null)
  const [prompt, setPrompt] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [prNumber, setPrNumber] = useState('')
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!prompt.trim()) {
      setError('Please enter a prompt')
      return
    }

    const tags = mode ? [mode] : []
    const context: { ticketId?: string; prNumber?: number } = {}
    if (ticketId) context.ticketId = ticketId
    if (prNumber) context.prNumber = parseInt(prNumber, 10)

    const result = await dispatch({ prompt: prompt.trim(), tags, context })
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.push(`/tasks/${result.id}`)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-lg">
      {/* Mode selector */}
      <div>
        <label className="block text-sm font-medium mb-2">Mode</label>
        <div className="flex gap-2 flex-wrap">
          {DISPATCH_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(mode === m.id ? null : m.id)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                mode === m.id
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-badge)] text-[var(--text-badge)] hover:bg-[var(--bg-card-hover)]'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Context fields */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-2">
            Ticket ID <span className="text-[var(--text-muted)] font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            placeholder="e.g. ENG-123"
            className="w-full px-3 py-2 rounded-md bg-[var(--bg-input)] border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">
            PR Number <span className="text-[var(--text-muted)] font-normal">(optional)</span>
          </label>
          <input
            type="number"
            value={prNumber}
            onChange={(e) => setPrNumber(e.target.value)}
            placeholder="e.g. 7340"
            className="w-full px-3 py-2 rounded-md bg-[var(--bg-input)] border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
      </div>

      {/* Prompt */}
      <div>
        <label className="block text-sm font-medium mb-2">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Tell the agent what to do..."
          rows={5}
          className="w-full px-3 py-2 rounded-md bg-[var(--bg-input)] border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--accent)] resize-none"
        />
      </div>

      {error && (
        <p className="text-sm text-[var(--error)]">{error}</p>
      )}

      <button
        type="submit"
        disabled={dispatching}
        className="px-6 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-md text-sm font-medium transition-colors"
      >
        {dispatching ? 'Starting...' : 'Dispatch'}
      </button>
    </form>
  )
}
