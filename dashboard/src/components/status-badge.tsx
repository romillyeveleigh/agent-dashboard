'use client'

const STATUS_CONFIG: Record<string, { label: string; dot: string }> = {
  pending: { label: 'Pending', dot: 'bg-zinc-500' },
  starting: { label: 'Starting', dot: 'bg-zinc-400' },
  running: { label: 'Running', dot: 'bg-blue-500 animate-pulse' },
  // Static: the only pulsing "needs you" dot is the one on the home dashboard
  waiting_for_feedback: { label: 'Waiting', dot: 'bg-purple-500' },
  complete: { label: 'Complete', dot: 'bg-green-500' },
  failed: { label: 'Failed', dot: 'bg-red-500' },
  cancelled: { label: 'Cancelled', dot: 'bg-zinc-500' },
  // Reaped because the PR it was waiting on concluded on its own — a benign,
  // expected end, not a failure or a kill. Teal keeps it visually distinct
  // from both complete (green) and cancelled (zinc).
  resolved: { label: 'Resolved', dot: 'bg-teal-500' },
}

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`w-2 h-2 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  )
}
