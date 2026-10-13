'use client'

import { useState } from 'react'
import { SiGithub, SiClaude, SiAnthropic } from '@icons-pack/react-simple-icons'
import type { FieldDef, FieldStatus, StatusVar, ValidationResult } from './types'

// Small muted brand mark shown before a field's label.
function BrandMark({ brand }: { brand: NonNullable<FieldDef['brand']> }) {
  const props = { size: 13, className: 'text-[var(--text-muted)] shrink-0' as string }
  if (brand === 'github') return <SiGithub {...props} color="currentColor" />
  if (brand === 'claude') return <SiClaude {...props} color="currentColor" />
  return <SiAnthropic {...props} color="currentColor" />
}

type Props = {
  def: FieldDef
  value: string
  onChange: (v: string) => void
  onBlur: () => void
  // Called by an affordance (folder/repo/detect) to fill the field with a
  // value and validate it in one step (avoids stale formState on onBlur).
  onPick?: (v: string) => void
  validation?: ValidationResult
  serverState?: StatusVar
  // when true and serverState is configured, render "Already set / Edit" affordance
  // when false (user clicked Edit), expose input
  editing: boolean
  setEditing: (v: boolean) => void
  // GitHub token (for the repo dropdown); only passed to the REPO_URL field.
  githubToken?: string
  // Overrides def.placeholder on the input.
  inputPlaceholder?: string
  // Render the value as plain text (no password dots, no reveal toggle) and
  // select-all on focus. Used to show the masked "••••i7Cf" of an already-set
  // secret as the field value, so typing replaces it cleanly.
  plainInput?: boolean
}

const STATUS_ICON: Record<FieldStatus, string> = {
  untouched: '',
  pending: '⋯',
  ok: '✓',
  warning: '⚠',
  error: '✗',
}

const STATUS_COLOR: Record<FieldStatus, string> = {
  untouched: 'text-[var(--text-muted)]',
  pending: 'text-[var(--text-muted)]',
  ok: 'text-emerald-500',
  warning: 'text-amber-500',
  error: 'text-red-500',
}

export function SetupField({ def, value, onChange, onBlur, onPick, validation, serverState, editing, setEditing, githubToken, inputPlaceholder, plainInput }: Props) {
  const [revealed, setRevealed] = useState(false)
  const [pickerBusy, setPickerBusy] = useState(false)
  const [pickerNote, setPickerNote] = useState<string | null>(null)
  const [detectBusy, setDetectBusy] = useState(false)
  const [detectNote, setDetectNote] = useState<string | null>(null)
  const status = validation?.status ?? 'untouched'
  const showAlreadySet = !editing && serverState?.configured

  const pickFolder = async () => {
    setPickerBusy(true)
    setPickerNote(null)
    try {
      const res = await fetch('/api/setup/pick-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `Select ${def.label}` }),
      })
      const data = await res.json()
      if (data.ok) {
        onPick?.(data.path)
      } else if (data.reason === 'unavailable') {
        setPickerNote('Native picker unavailable — type the path below.')
      }
      // cancelled → silent no-op
    } catch {
      setPickerNote('Native picker unavailable — type the path below.')
    } finally {
      setPickerBusy(false)
    }
  }

  const detect = async () => {
    setDetectBusy(true)
    setDetectNote(null)
    try {
      const res = await fetch('/api/setup/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: def.name }),
      })
      const data = await res.json()
      if (data.ok) {
        onPick?.(data.value)
        setDetectNote(`Detected from ${data.source}.`)
      } else if (data.reason === 'unavailable') {
        setDetectNote('Local tool not found — paste it manually.')
      } else {
        setDetectNote('Nothing detected — paste it manually.')
      }
    } catch {
      setDetectNote('Couldn’t detect — paste it manually.')
    } finally {
      setDetectBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        {def.brand && <BrandMark brand={def.brand} />}
        <label className="text-[13px] font-medium text-[var(--text)]">{def.label}</label>
        {def.affordance === 'detect' && (
          <button
            type="button"
            onClick={detect}
            disabled={detectBusy}
            className="text-[11px] text-[var(--accent)] hover:underline disabled:opacity-50"
          >
            {detectBusy ? 'Detecting…' : 'Detect from local install →'}
          </button>
        )}
        {def.helpUrl && (
          <a
            href={def.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-[var(--accent)] hover:underline"
          >
            How to get this →
          </a>
        )}
      </div>
      {def.helpText && <p className="text-[11px] text-[var(--text-muted)]">{def.helpText}</p>}
      {serverState?.mirrorMismatch && (
        <p className="text-[11px] text-amber-500">
          Your <code>.env.local</code> has a different value for the public mirror. Saving will overwrite it.
        </p>
      )}
      {showAlreadySet ? (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-[var(--bg-input)] border border-[var(--border)]">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-emerald-500 text-[12px]">✓</span>
            <span className="text-[12px] font-mono truncate">
              {serverState.isSecret
                ? `••••${serverState.lastFour ?? ''}`
                : serverState.visibleValue}
            </span>
          </div>
          <button
            type="button"
            onClick={() => { setEditing(true); onChange('') }}
            className="text-[11px] text-[var(--accent)] hover:underline shrink-0"
          >
            Edit
          </button>
        </div>
      ) : def.affordance === 'repo' ? (
        <RepoCombobox
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          onPick={onPick}
          githubToken={githubToken}
          placeholder={inputPlaceholder ?? def.placeholder}
        />
      ) : (
        <div className="space-y-1.5">
          <div className="relative">
            <input
              type={plainInput || def.format === 'url' || !defIsSecret(def.name) ? 'text' : (revealed ? 'text' : 'password')}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onBlur={onBlur}
              onFocus={plainInput ? (e) => e.currentTarget.select() : undefined}
              placeholder={inputPlaceholder ?? def.placeholder}
              spellCheck={false}
              autoComplete="off"
              className="w-full px-2.5 py-1.5 pr-9 rounded-md bg-[var(--bg-input)] border border-[var(--border)] text-[12px] font-mono focus:outline-none focus:border-[var(--accent)]"
            />
            {defIsSecret(def.name) && value && !plainInput && (
              <button
                type="button"
                onClick={() => setRevealed(!revealed)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                {revealed ? 'hide' : 'show'}
              </button>
            )}
          </div>
          {def.affordance === 'folder' && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={pickFolder}
                disabled={pickerBusy}
                className="px-2.5 py-1 rounded-md bg-[var(--bg-card-hover)] border border-[var(--border)] text-[11px] hover:border-[var(--accent)] disabled:opacity-50"
              >
                {pickerBusy ? 'Opening…' : 'Browse…'}
              </button>
              {pickerNote && <span className="text-[11px] text-amber-500">{pickerNote}</span>}
            </div>
          )}
        </div>
      )}
      {!showAlreadySet && validation && status !== 'untouched' && (
        <p className={`text-[11px] flex items-center gap-1.5 ${STATUS_COLOR[status]}`}>
          <span>{STATUS_ICON[status]}</span>
          <span>{validation.message ?? (status === 'pending' ? 'Validating…' : '')}</span>
        </p>
      )}
      {!showAlreadySet && detectNote && <p className="text-[11px] text-[var(--text-muted)]">{detectNote}</p>}
    </div>
  )
}

// ─── Repo combobox ───────────────────────────────────────────

function RepoCombobox({
  value, onChange, onBlur, onPick, githubToken, placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onBlur: () => void
  onPick?: (v: string) => void
  githubToken?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [repos, setRepos] = useState<{ fullName: string }[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    if (repos || loading) return
    setLoading(true)
    setNote(null)
    try {
      const res = await fetch('/api/setup/github-repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: githubToken || undefined }),
      })
      const data = await res.json()
      if (data.ok) setRepos(data.repos)
      else if (data.reason === 'no-token') setNote('Enter your GitHub token first.')
      else if (data.reason === 'unauthorized') setNote('GitHub rejected the token.')
      else setNote('Couldn’t load repos — type org/repo.')
    } catch {
      setNote('Couldn’t load repos — type org/repo.')
    } finally {
      setLoading(false)
    }
  }

  // When the value exactly matches a repo, it's the pre-filled selection (not a
  // typed query) — show the whole list so the field reads as a real picker.
  // Once the user edits the text, fall back to substring filtering.
  const q = value.toLowerCase()
  const all = repos ?? []
  const isExactSelection = all.some(r => r.fullName.toLowerCase() === q)
  const filtered = (isExactSelection
    ? all
    : all.filter(r => r.fullName.toLowerCase().includes(q))
  ).slice(0, 50)

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={(e) => { setOpen(true); load(); e.currentTarget.select() }}
        onBlur={() => { setTimeout(() => setOpen(false), 150); onBlur() }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="w-full px-2.5 py-1.5 rounded-md bg-[var(--bg-input)] border border-[var(--border)] text-[12px] font-mono focus:outline-none focus:border-[var(--accent)]"
      />
      {open && (filtered.length > 0 || loading || note) && (
        <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-md bg-[var(--bg-card)] border border-[var(--border)] shadow-lg">
          {loading && <div className="px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">Loading…</div>}
          {note && <div className="px-2.5 py-1.5 text-[11px] text-amber-500">{note}</div>}
          {filtered.map(r => (
            <button
              key={r.fullName}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onPick?.(r.fullName); setOpen(false) }}
              className="block w-full text-left px-2.5 py-1.5 text-[12px] font-mono hover:bg-[var(--bg-card-hover)]"
            >
              {r.fullName}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const SECRET_NAMES = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'LINEAR_API_KEY',
  'FIGMA_API_KEY',
])
function defIsSecret(name: string): boolean {
  return SECRET_NAMES.has(name)
}
