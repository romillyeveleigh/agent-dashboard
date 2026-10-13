'use client'

// One dispatchable action: a quiet line of text led by a small triangle. Used
// for the quick actions on Home cards and in the drawer. The first in a row is
// the suggested one, so it's darker
export function ActionRow({ label, primary, dispatching, error, disabled, title, onRun }: {
  label: string
  primary: boolean
  dispatching: boolean
  error: boolean
  disabled: boolean
  title?: string
  onRun: () => void
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onRun() }}
      disabled={disabled || dispatching}
      title={title}
      className={`flex items-center gap-2.5 py-[3px] text-left text-[13px] transition-colors ${
        error ? 'text-[var(--error)]' : primary ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'
      } ${dispatching ? 'cursor-default' : disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:text-[var(--accent)]'}`}
    >
      {dispatching ? (
        <span className="w-2 h-2 shrink-0 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor" className="shrink-0 opacity-60">
          <path d="M2 1L8.5 5L2 9V1Z" />
        </svg>
      )}
      {error ? `${label} failed` : label}
    </button>
  )
}

// Wraps a card's or drawer's actions onto as many lines as they need
export const ACTION_ROW_LIST = 'flex flex-wrap items-center gap-x-5 gap-y-1'
