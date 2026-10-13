import { MemoryManager } from '@/components/memory-manager'

export default function MemoriesPage() {
  const repoUrl = process.env.REPO_URL || ''

  if (!repoUrl) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-6">Agent Memories</h1>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-6 text-center">
          <p className="text-[var(--text-muted)] text-sm">
            Set <code className="font-mono text-[var(--accent)]">REPO_URL</code> environment variable to enable agent memories.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Agent Memories</h1>
      <p className="text-sm text-[var(--text-muted)] mb-4">
        Knowledge persisted by agents across tasks for <code className="font-mono text-[var(--accent)]">{repoUrl}</code>
      </p>
      <MemoryManager repoUrl={repoUrl} />
    </div>
  )
}
