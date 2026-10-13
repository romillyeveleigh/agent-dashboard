'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Memory } from '@/lib/schema'

export function MemoryManager({ repoUrl }: { repoUrl: string }) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [content, setContent] = useState('')
  const [category, setCategory] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchMemories = useCallback(async () => {
    const res = await fetch(`/api/memories?repo_url=${encodeURIComponent(repoUrl)}`)
    if (res.ok) {
      setMemories(await res.json())
    }
    setLoading(false)
  }, [repoUrl])

  useEffect(() => {
    fetchMemories()
  }, [fetchMemories])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim()) return
    setSubmitting(true)
    const res = await fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo_url: repoUrl,
        content: content.trim(),
        category: category.trim() || null,
      }),
    })
    if (res.ok) {
      setContent('')
      setCategory('')
      fetchMemories()
    }
    setSubmitting(false)
  }

  async function handleDelete(id: string) {
    await fetch(`/api/memories?id=${id}`, { method: 'DELETE' })
    setMemories((prev) => prev.filter((m) => m.id !== id))
  }

  if (loading) {
    return <p className="text-sm text-[var(--text-muted)]">Loading...</p>
  }

  return (
    <div className="space-y-4">
      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category (optional)"
          className="w-32 px-3 py-2 rounded-md bg-[var(--bg-input)] border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--accent)]"
        />
        <input
          type="text"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Memory content (1-3 sentences, max 500 chars)"
          maxLength={500}
          className="flex-1 px-3 py-2 rounded-md bg-[var(--bg-input)] border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={submitting || !content.trim()}
          className="px-4 py-2 rounded-md bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          Add
        </button>
      </form>

      {/* Memory list */}
      {memories.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-6 text-center">
          <p className="text-[var(--text-muted)] text-sm">
            No memories yet. Agents will save discoveries here as they work.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {memories.map((m) => (
            <div
              key={m.id}
              className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--text)]">{m.content}</p>
                <div className="flex gap-2 mt-1.5 text-[11px] text-[var(--text-muted)]">
                  {m.category && (
                    <span className="px-1.5 py-0.5 rounded bg-[var(--bg-input)] font-mono">
                      {m.category}
                    </span>
                  )}
                  {m.source && <span>task {m.source.slice(0, 8)}</span>}
                  <span>{new Date(m.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
              <button
                onClick={() => handleDelete(m.id)}
                className="text-[var(--text-muted)] hover:text-[var(--error)] text-sm transition-colors shrink-0"
                title="Delete memory"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
