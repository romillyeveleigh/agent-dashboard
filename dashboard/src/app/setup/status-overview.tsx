'use client'

import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { SiGithub, SiLinear, SiFigma } from '@icons-pack/react-simple-icons'
import { SetupField } from './field'
import { DockerImagePanel } from './docker-image-panel'
import {
  REQUIRED_FIELDS,
  LINEAR_FIELDS,
  LOCAL_REPO_FIELDS,
  FIGMA_FIELDS,
} from './field-defs'
import type { FieldDef, StatusResponse, ValidationMap } from './types'

type Group = {
  id: string
  label: string
  blurb: string
  required: boolean
  fields: FieldDef[]
  icon: ReactNode
}

// ─── Iconography ─────────────────────────────────────────────
// Group marks carry a touch of brand colour (the page's one bold move).

const CoreMark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M8 1.5 9.7 6.3 14.5 8 9.7 9.7 8 14.5 6.3 9.7 1.5 8 6.3 6.3 8 1.5Z" fill="currentColor" />
  </svg>
)
const FolderMark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M1.5 4.2c0-.66.54-1.2 1.2-1.2h3.1c.4 0 .77.2.99.53l.42.62h5.09c.66 0 1.2.54 1.2 1.2v6.12c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V4.2Z" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)

const GROUPS: Group[] = [
  { id: 'required', label: 'Core', blurb: 'Credentials the dashboard runs on', required: true, fields: REQUIRED_FIELDS, icon: <CoreMark /> },
  { id: 'linear', label: 'Linear', blurb: 'Ticket lookup and the Tickets tab', required: false, fields: LINEAR_FIELDS, icon: <SiLinear size={15} color="#5E6AD2" /> },
  { id: 'figma', label: 'Figma', blurb: 'Figma MCP inside agent containers', required: false, fields: FIGMA_FIELDS, icon: <SiFigma size={14} color="#F24E1E" /> },
  { id: 'local-repo', label: 'Local repo', blurb: 'Faster clones via a local reference cache', required: false, fields: LOCAL_REPO_FIELDS, icon: <FolderMark /> },
]

type GroupStatus = 'connected' | 'attention' | 'empty'

function groupStatus(g: Group, status: StatusResponse): GroupStatus {
  const configured = g.fields.filter(f => status.vars[f.name]?.configured)
  if (configured.length === 0) return 'empty'
  // Credentials present → Connected; a failed Test downgrades to Needs attention.
  if (configured.some(f => { const p = status.vars[f.name]?.lastProbe; return p && !p.ok })) return 'attention'
  return 'connected'
}

const PILL: Record<GroupStatus, { label: string; cls: string; dot: string }> = {
  connected: { label: 'Ready', cls: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10', dot: 'bg-emerald-500' },
  attention: { label: 'Needs attention', cls: 'text-amber-600 dark:text-amber-400 bg-amber-500/10', dot: 'bg-amber-500' },
  empty: { label: 'Not set', cls: 'text-[var(--text-muted)] bg-[var(--bg-badge)]', dot: 'bg-[var(--border)]' },
}

function StatusPill({ status }: { status: GroupStatus }) {
  const p = PILL[status]
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${p.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${p.dot}`} />
      {p.label}
    </span>
  )
}

// Resting value shown in a field. Secrets are never sent to the client, so an
// already-set secret rests at its masked "••••i7Cf" string; editing it replaces
// the value (a still-masked field is unchanged, so it's never re-saved). An
// unset secret rests empty.
function baselineOf(status: StatusResponse, name: string): string {
  const sv = status.vars[name]
  if (!sv) return ''
  if (sv.isSecret) return sv.configured ? `••••${sv.lastFour ?? ''}` : ''
  return sv.visibleValue ?? ''
}

// ─── Agent worker image ──────────────────────────────────────
// The Docker image is independent of credential setup, so it gets its own
// card here (the first-run wizard's Docker step is unreachable once setup is
// complete). The amber "Build image" banner deep-links to #agent-worker-image.

function DockerImageCard() {
  const [state, setState] = useState<'loading' | 'present' | 'missing'>('loading')

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/image-status')
      if (res.ok) {
        const data = await res.json()
        setState(data.imageExists ? 'present' : 'missing')
      }
    } catch {
      // ignore — don't block the settings page
    }
  }, [])

  useEffect(() => { check() }, [check])

  if (state === 'loading') return null

  return (
    <section id="agent-worker-image" className="scroll-mt-6 card-elevated bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
      {state === 'present' ? (
        <div className="flex items-center gap-3 px-4 py-3.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--bg-badge)] text-[var(--text)] shrink-0">
            <CoreMark />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13.5px] font-semibold">Agent worker image</h2>
            <p className="text-[12px] text-[var(--text-muted)] truncate">The <code className="font-mono">agent-worker</code> Docker image is built and ready.</p>
          </div>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Ready
          </span>
        </div>
      ) : (
        <div className="p-4">
          <DockerImagePanel onDone={(ok) => { if (ok) check() }} />
        </div>
      )}
    </section>
  )
}

export function StatusOverview() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [validation, setValidation] = useState<ValidationMap>({})
  // draft only holds fields the user has actually edited; everything else
  // falls back to its baseline. A field is "dirty" iff it's in draft and
  // differs from baseline.
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [savingGroup, setSavingGroup] = useState<string | null>(null)
  const [testingGroup, setTestingGroup] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const s = await fetch('/api/setup/status').then(r => r.json() as Promise<StatusResponse>)
    setStatus(s)
    return s
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const buildContext = useCallback(() => {
    const ctx: { githubToken?: string; linearKey?: string } = {}
    if (draft['GITHUB_TOKEN']) ctx.githubToken = draft['GITHUB_TOKEN']
    if (draft['LINEAR_API_KEY']) ctx.linearKey = draft['LINEAR_API_KEY']
    return ctx
  }, [draft])

  const probeOne = useCallback(async (field: string, value: string, useEnv = false) => {
    if (!value && !useEnv) { setValidation(prev => ({ ...prev, [field]: { status: 'untouched' } })); return }
    setValidation(prev => ({ ...prev, [field]: { status: 'pending', message: 'Validating…' } }))
    try {
      const body = useEnv ? { field, useEnv: true } : { field, value, context: buildContext() }
      const res = await fetch('/api/setup/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await res.json()
      const st: 'ok' | 'warning' | 'error' = result.ok
        ? (result.warning ? 'warning' : 'ok')
        : (result.warning ? 'warning' : 'error')
      setValidation(prev => ({ ...prev, [field]: { status: st, message: result.message } }))

      // Auto-fill a sibling the validated value implies (e.g. validating the
      // GitHub token yields the username). Only fill when the target is empty so
      // we never clobber a value the user typed (e.g. a bot-token override).
      const sf = result.detail?.suggestedFill as { field: string; value: string } | undefined
      if (sf && status) {
        const s = status
        setDraft(prev => {
          const current = prev[sf.field] !== undefined ? prev[sf.field] : baselineOf(s, sf.field)
          return current ? prev : { ...prev, [sf.field]: sf.value }
        })
      }
    } catch (e) {
      setValidation(prev => ({ ...prev, [field]: { status: 'warning', message: (e as Error).message } }))
    }
  }, [buildContext, status])

  const testGroup = useCallback(async (g: Group) => {
    if (!status) return
    setTestingGroup(g.id)
    const fields = g.fields.filter(f => status.vars[f.name]?.configured)
    await Promise.all(fields.map(async f => {
      const sv = status.vars[f.name]
      // Non-secrets carry visibleValue; for secrets the server reads process.env.
      if (sv.visibleValue !== undefined) await probeOne(f.name, sv.visibleValue)
      else await probeOne(f.name, '', true)
    }))
    setTestingGroup(null)
    refresh()
  }, [status, probeOne, refresh])

  const testAll = useCallback(async () => {
    for (const g of GROUPS) {
      // eslint-disable-next-line no-await-in-loop
      await testGroup(g)
    }
  }, [testGroup])

  const isDirty = (name: string): boolean =>
    status != null && draft[name] !== undefined && draft[name] !== baselineOf(status, name)

  const saveGroup = async (g: Group) => {
    if (!status) return
    const changed = g.fields.filter(f => isDirty(f.name))
    if (changed.length === 0) return
    setSavingGroup(g.id)
    try {
      // Validate everything that changed, then persist in one write.
      await Promise.all(changed.map(f => probeOne(f.name, draft[f.name] ?? '')))
      const set: Record<string, string> = {}
      for (const f of changed) set[f.name] = draft[f.name] ?? ''
      const res = await fetch('/api/setup/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set }),
      })
      const result = await res.json()
      if (!result.ok) { alert(result.message || 'Save failed'); return }
      const s = await refresh()
      // Clear drafts for the saved fields so they re-show their new baseline.
      setDraft(prev => { const next = { ...prev }; for (const f of g.fields) delete next[f.name]; return next })
      // Re-probe non-secret saved fields against fresh values for the pill.
      void s
    } finally {
      setSavingGroup(null)
    }
  }

  const revertGroup = (g: Group) => {
    setDraft(prev => { const next = { ...prev }; for (const f of g.fields) delete next[f.name]; return next })
    setValidation(prev => { const next = { ...prev }; for (const f of g.fields) delete next[f.name]; return next })
  }

  if (!status) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-[12px] text-[var(--text-muted)]">Loading…</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <header className="mb-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight leading-none">Settings</h1>
            <p className="text-[13px] text-[var(--text-muted)] mt-1.5">Credentials and integrations the dashboard uses.</p>
          </div>
          <button
            onClick={testAll}
            disabled={testingGroup !== null}
            className="focus-ring shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-[var(--bg-card)] border border-[var(--border)] hover:bg-[var(--bg-card-hover)] hover:border-[var(--text-muted)] transition-colors disabled:opacity-50"
          >
            {testingGroup !== null ? 'Testing…' : 'Test all'}
          </button>
        </div>
      </header>

      {/* Connection cards — required credentials, then the worker image, then optional integrations */}
      <div className="space-y-3">
        {GROUPS.map(g => {
          const gs = groupStatus(g, status)
          const isConnecting = connecting === g.id
          const showForm = gs !== 'empty' || isConnecting
          const cardDirty = g.fields.some(f => isDirty(f.name))

          return (
            <Fragment key={g.id}>
            <section className="card-elevated bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
              {/* Card header */}
              <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--border-subtle)]">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--bg-badge)] text-[var(--text)] shrink-0">
                  {g.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[13.5px] font-semibold">{g.label}</h2>
                    {g.required && <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] border border-[var(--border)] rounded px-1 py-px">Required</span>}
                  </div>
                  <p className="text-[12px] text-[var(--text-muted)] truncate">{g.blurb}</p>
                </div>
                <StatusPill status={gs} />
                {gs === 'empty' && !g.required && (
                  <button
                    onClick={() => setConnecting(isConnecting ? null : g.id)}
                    className="focus-ring shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-md text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors"
                  >
                    {isConnecting ? 'Cancel' : 'Connect'}
                  </button>
                )}
              </div>

              {/* Card body */}
              {!showForm ? (
                <p className="px-4 py-3 text-[12px] text-[var(--text-muted)]">Not set — add credentials to enable.</p>
              ) : (
                <>
                  <div className="divide-y divide-[var(--border-subtle)]">
                    {g.fields.map(f => {
                      const sv = status.vars[f.name]
                      // Already-set secrets show their masked value as plain text;
                      // focusing selects it so typing replaces the whole thing.
                      const maskedSecret = !!sv?.isSecret && !!sv.configured
                      return (
                        <div key={f.name} className="px-4 py-3.5">
                          <SetupField
                            def={f}
                            value={draft[f.name] !== undefined ? draft[f.name] : baselineOf(status, f.name)}
                            onChange={(v) => setDraft(prev => ({ ...prev, [f.name]: v }))}
                            onBlur={() => probeOne(f.name, draft[f.name] ?? '')}
                            onPick={(v) => { setDraft(prev => ({ ...prev, [f.name]: v })); probeOne(f.name, v) }}
                            githubToken={draft['GITHUB_TOKEN'] || undefined}
                            plainInput={maskedSecret}
                            validation={validation[f.name]}
                            serverState={undefined}
                            editing={true}
                            setEditing={() => {}}
                          />
                        </div>
                      )
                    })}
                  </div>

                  {/* Save bar — only when something changed */}
                  {cardDirty && (
                    <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-card-hover)]">
                      <button
                        onClick={() => saveGroup(g)}
                        disabled={savingGroup === g.id}
                        className="focus-ring px-3 py-1.5 text-[12px] font-medium rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white disabled:opacity-50 transition-colors"
                      >
                        {savingGroup === g.id ? 'Saving…' : 'Save changes'}
                      </button>
                      <button
                        onClick={() => revertGroup(g)}
                        disabled={savingGroup === g.id}
                        className="focus-ring px-3 py-1.5 text-[12px] rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-card)] transition-colors"
                      >
                        Revert
                      </button>
                      <span className="text-[11px] text-[var(--text-muted)] ml-auto">Unsaved changes</span>
                    </div>
                  )}
                </>
              )}
            </section>
            {g.id === 'required' && <DockerImageCard />}
            </Fragment>
          )
        })}
      </div>

      <p className="text-[11px] text-[var(--text-muted)] mt-6 text-center">
        Values are written to <code className="font-mono">.env.local</code>. The dashboard reloads them without a restart.
      </p>
    </div>
  )
}
