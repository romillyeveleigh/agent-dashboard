// Shown instantly on navigation while the task page loads
export default function Loading() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 sm:p-6 space-y-3">
        <div className="h-7 w-48 rounded bg-[var(--border-subtle)]" />
        <div className="h-3 w-2/3 rounded bg-[var(--border-subtle)]" />
        <div className="h-3 w-1/3 rounded bg-[var(--border-subtle)]" />
      </div>
      {['w-24', 'w-20', 'w-24'].map((w, i) => (
        <div key={i} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
          <div className={`h-4 ${w} rounded bg-[var(--border-subtle)]`} />
        </div>
      ))}
    </div>
  )
}
