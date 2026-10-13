'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SetupField } from './field'
import { DockerImagePanel } from './docker-image-panel'
import {
  REQUIRED_FIELDS,
  LINEAR_FIELDS,
  LOCAL_REPO_FIELDS,
  FIGMA_FIELDS,
} from './field-defs'
import type {
  DefaultsResponse,
  FieldDef,
  StatusResponse,
  StatusVar,
  ValidationMap,
} from './types'

// ─── Wizard ──────────────────────────────────────────────────

type StepId = 'welcome' | 'required' | 'linear' | 'local-repo' | 'figma' | 'docker' | 'done'

const STEP_ORDER: StepId[] = ['welcome', 'required', 'linear', 'local-repo', 'figma', 'docker', 'done']
const STEP_LABELS: Record<StepId, string> = {
  welcome: 'Welcome',
  required: 'Required',
  linear: 'Linear',
  'local-repo': 'Local repo',
  figma: 'Figma',
  docker: 'Docker',
  done: 'Done',
}

export function SetupWizard() {
  const router = useRouter()
  const [stepId, setStepId] = useState<StepId>('welcome')
  const [formState, setFormState] = useState<Record<string, string>>({})
  const [validation, setValidation] = useState<ValidationMap>({})
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [defaults, setDefaults] = useState<DefaultsResponse | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [permissionFallback, setPermissionFallback] = useState<{ rendered: string } | null>(null)

  // Load status + defaults on mount
  useEffect(() => {
    (async () => {
      const [s, d] = await Promise.all([
        fetch('/api/setup/status').then(r => r.json() as Promise<StatusResponse>),
        fetch('/api/setup/defaults').then(r => r.json() as Promise<DefaultsResponse>),
      ])
      setStatus(s)
      setDefaults(d)
      // Pre-fill OS-aware defaults for unconfigured fields
      const init: Record<string, string> = {}
      if (!s.vars['DASHBOARD_URL']?.configured) init['DASHBOARD_URL'] = d.DASHBOARD_URL
      if (!s.vars['REPO_PATH']?.configured && d.REPO_PATH) init['REPO_PATH'] = d.REPO_PATH
      setFormState(prev => ({ ...init, ...prev }))
    })()
  }, [])

  const updateField = useCallback((name: string, value: string) => {
    setFormState(prev => ({ ...prev, [name]: value }))
  }, [])

  const buildContext = useCallback(() => {
    const ctx: { githubToken?: string; linearKey?: string } = {}
    const ghTok = formState['GITHUB_TOKEN'] ?? (status?.vars['GITHUB_TOKEN']?.configured ? '__server__' : '')
    if (ghTok && ghTok !== '__server__') ctx.githubToken = ghTok
    const linTok = formState['LINEAR_API_KEY']
    if (linTok) ctx.linearKey = linTok
    return ctx
  }, [formState, status])

  const validateField = useCallback(async (field: string, value: string, opts: { fromDependent?: boolean } = {}) => {
    if (!value && !opts.fromDependent) {
      setValidation(prev => ({ ...prev, [field]: { status: 'untouched' } }))
      return
    }
    setValidation(prev => ({ ...prev, [field]: { status: 'pending', message: 'Validating…' } }))
    try {
      const res = await fetch('/api/setup/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value, context: buildContext() }),
      })
      const result = await res.json()
      const status: 'ok' | 'warning' | 'error' = result.ok
        ? (result.warning ? 'warning' : 'ok')
        : (result.warning ? 'warning' : 'error')
      setValidation(prev => ({ ...prev, [field]: { status, message: result.message } }))

      // Auto-fill suggestions for empty siblings
      const sf = result.detail?.suggestedFill
      if (sf && !opts.fromDependent) {
        setFormState(prev => prev[sf.field] ? prev : { ...prev, [sf.field]: sf.value })
      }

      // Re-validate dependents
      if (Array.isArray(result.dependsOn)) {
        for (const dep of result.dependsOn) {
          const v = (sf && sf.field === dep) ? sf.value : formState[dep]
          if (v) validateField(dep, v, { fromDependent: true })
        }
      }
    } catch (e) {
      setValidation(prev => ({ ...prev, [field]: { status: 'warning', message: `Couldn't reach validator: ${(e as Error).message}` } }))
    }
  }, [buildContext, formState])

  const isFieldOk = (name: string): boolean => {
    if (!editing[name] && status?.vars[name]?.configured) return true
    const v = validation[name]
    return v?.status === 'ok' || v?.status === 'warning'
  }

  const requiredAllOk = REQUIRED_FIELDS.every(f => isFieldOk(f.name))

  const saveCurrent = useCallback(async (extra: { unset?: string[] } = {}) => {
    setSaving(true)
    setSaveError(null)
    try {
      const set: Record<string, string> = {}
      for (const [k, v] of Object.entries(formState)) {
        // Only send fields the user actually edited (touched state present in formState).
        // Empty strings are sent — server treats them as "clear without removing".
        if (editing[k] || !status?.vars[k]?.configured || v) set[k] = v
      }
      const res = await fetch('/api/setup/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set, unset: extra.unset ?? [] }),
      })
      const result = await res.json()
      if (!result.ok) {
        if (result.reason === 'permission') {
          setPermissionFallback({ rendered: result.renderedFile })
          setSaving(false)
          return false
        }
        setSaveError(result.message || 'Save failed')
        setSaving(false)
        return false
      }
      // Re-fetch status so "Already set" reflects new values
      const s = await fetch('/api/setup/status').then(r => r.json() as Promise<StatusResponse>)
      setStatus(s)
      // Clear editing flags
      setEditing({})
      setSaving(false)
      return true
    } catch (e) {
      setSaveError((e as Error).message)
      setSaving(false)
      return false
    }
  }, [formState, editing, status])

  const goNext = (after?: { unset?: string[] }) => async () => {
    const ok = await saveCurrent({ unset: after?.unset })
    if (!ok) return
    const idx = STEP_ORDER.indexOf(stepId)
    if (idx < STEP_ORDER.length - 1) setStepId(STEP_ORDER[idx + 1])
  }

  const goBack = () => {
    const idx = STEP_ORDER.indexOf(stepId)
    if (idx > 0) setStepId(STEP_ORDER[idx - 1])
  }

  const skip = () => {
    const idx = STEP_ORDER.indexOf(stepId)
    if (idx < STEP_ORDER.length - 1) setStepId(STEP_ORDER[idx + 1])
  }

  if (!status || !defaults) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-[12px] text-[var(--text-muted)]">Loading…</p>
      </div>
    )
  }

  const stepProps = {
    formState,
    updateField,
    validation,
    validateField,
    serverStatus: status,
    editing,
    setEditing: (name: string, v: boolean) => setEditing(prev => ({ ...prev, [name]: v })),
    saving,
    saveError,
    goNext,
    goBack,
    skip,
    canFinish: requiredAllOk,
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <Header
        currentStep={stepId}
        onSaveExit={async () => {
          const ok = await saveCurrent()
          if (ok) router.push('/')
        }}
        saving={saving}
      />

      {permissionFallback && (
        <PermissionFallback rendered={permissionFallback.rendered} onClose={() => setPermissionFallback(null)} />
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 space-y-5">
        {stepId === 'welcome' && <WelcomeStep {...stepProps} />}
        {stepId === 'required' && <RequiredStep {...stepProps} />}
        {stepId === 'linear' && <OptionalStep group="linear" fields={LINEAR_FIELDS} title="Linear (optional)" hint="Enables ticket lookup and the Tickets tab." {...stepProps} />}
        {stepId === 'local-repo' && <OptionalStep group="local-repo" fields={LOCAL_REPO_FIELDS} title="Local repo (optional)" hint="Enables faster git clone via a local reference cache." {...stepProps} />}
        {stepId === 'figma' && <OptionalStep group="figma" fields={FIGMA_FIELDS} title="Figma (optional)" hint="Enables Figma MCP in agent containers." {...stepProps} />}
        {stepId === 'docker' && <DockerStep {...stepProps} />}
        {stepId === 'done' && <DoneStep />}
      </div>

      {saveError && (
        <div className="mt-4 p-3 rounded-md bg-red-500/10 border border-red-500/30 text-[12px] text-red-400">
          {saveError}
        </div>
      )}
    </div>
  )
}

// ─── Header / progress ───────────────────────────────────────

function Header({ currentStep, onSaveExit, saving }: { currentStep: StepId; onSaveExit: () => void; saving: boolean }) {
  const idx = STEP_ORDER.indexOf(currentStep)
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-[18px] font-semibold tracking-tight">Set up the dashboard</h1>
        <button
          onClick={onSaveExit}
          disabled={saving}
          className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save & exit'}
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        {STEP_ORDER.map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i < idx ? 'bg-[var(--accent)]' : i === idx ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
            }`}
            title={STEP_LABELS[s]}
          />
        ))}
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mt-1.5">
        Step {idx + 1} of {STEP_ORDER.length}: {STEP_LABELS[currentStep]}
      </p>
    </div>
  )
}

// ─── Step props type ─────────────────────────────────────────

type StepProps = {
  formState: Record<string, string>
  updateField: (name: string, value: string) => void
  validation: ValidationMap
  validateField: (field: string, value: string) => Promise<void>
  serverStatus: StatusResponse
  editing: Record<string, boolean>
  setEditing: (name: string, v: boolean) => void
  saving: boolean
  saveError: string | null
  goNext: (after?: { unset?: string[] }) => () => Promise<void>
  goBack: () => void
  skip: () => void
  canFinish: boolean
}

// ─── Welcome ─────────────────────────────────────────────────

function WelcomeStep({ goNext }: StepProps) {
  return (
    <div className="space-y-4">
      <h2 className="text-[15px] font-semibold">Welcome</h2>
      <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">
        This wizard collects credentials for the integrations the dashboard uses, validates them as you enter them, and writes them to <code className="text-[12px] font-mono bg-[var(--bg-badge)] px-1 rounded">.env.local</code>. Optional integrations are explicit single-click skips — you can come back any time via the settings link in the sidebar.
      </p>
      <div className="flex justify-end">
        <button
          onClick={goNext()}
          className="px-4 py-1.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium"
        >
          Get started →
        </button>
      </div>
    </div>
  )
}

// ─── Required step ───────────────────────────────────────────

function RequiredStep(props: StepProps) {
  const { formState, updateField, validation, validateField, serverStatus, editing, setEditing, goNext, canFinish, saving } = props
  return (
    <div className="space-y-4">
      <h2 className="text-[15px] font-semibold">Required credentials</h2>
      <p className="text-[12px] text-[var(--text-muted)]">
        Six values to fill in. We auto-validate each as you tab away.
      </p>
      {REQUIRED_FIELDS.map(def => (
        <SetupField
          key={def.name}
          def={def}
          value={formState[def.name] ?? ''}
          onChange={(v) => updateField(def.name, v)}
          onBlur={() => validateField(def.name, formState[def.name] ?? '')}
          onPick={(v) => { updateField(def.name, v); validateField(def.name, v) }}
          githubToken={formState['GITHUB_TOKEN']}
          validation={validation[def.name]}
          serverState={serverStatus.vars[def.name]}
          editing={!!editing[def.name]}
          setEditing={(v) => setEditing(def.name, v)}
        />
      ))}
      <div className="flex justify-between pt-2">
        <button onClick={props.goBack} className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]">← Back</button>
        <button
          onClick={goNext()}
          disabled={!canFinish || saving}
          className="px-4 py-1.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-[13px] font-medium"
        >
          {saving ? 'Saving…' : 'Next →'}
        </button>
      </div>
    </div>
  )
}

// ─── Optional step (Linear/Local-repo/Figma share this) ───

function OptionalStep(props: StepProps & {
  group: string
  fields: FieldDef[]
  title: string
  hint: string
}) {
  const { fields, title, hint, formState, updateField, validation, validateField, serverStatus, editing, setEditing, goNext, skip, saving } = props
  const previouslyConfigured = fields.some(f => serverStatus.vars[f.name]?.configured)
  const anyEntered = fields.some(f => formState[f.name])

  return (
    <div className="space-y-4">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="text-[12px] text-[var(--text-muted)]">{hint}</p>
      {fields.map(def => (
        <SetupField
          key={def.name}
          def={def}
          value={formState[def.name] ?? ''}
          onChange={(v) => updateField(def.name, v)}
          onBlur={() => validateField(def.name, formState[def.name] ?? '')}
          onPick={(v) => { updateField(def.name, v); validateField(def.name, v) }}
          githubToken={formState['GITHUB_TOKEN']}
          validation={validation[def.name]}
          serverState={serverStatus.vars[def.name]}
          editing={!!editing[def.name]}
          setEditing={(v) => setEditing(def.name, v)}
        />
      ))}
      <div className="flex justify-between items-center pt-2 gap-2 flex-wrap">
        <button onClick={props.goBack} className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]">← Back</button>
        <div className="flex gap-2">
          {previouslyConfigured ? (
            <>
              <button
                onClick={skip}
                className="px-3 py-1.5 rounded-md text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-card-hover)]"
              >
                Leave as-is
              </button>
              <button
                onClick={goNext({ unset: fields.map(f => f.name) })}
                disabled={saving}
                className="px-3 py-1.5 rounded-md text-[12px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                Remove these settings
              </button>
            </>
          ) : (
            <button
              onClick={anyEntered ? goNext() : skip}
              disabled={saving}
              className="px-3 py-1.5 rounded-md text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
            >
              {anyEntered ? 'Skip' : 'Skip — not now'}
            </button>
          )}
          <button
            onClick={goNext()}
            disabled={saving}
            className="px-4 py-1.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-[13px] font-medium"
          >
            {anyEntered ? 'Save & continue →' : 'Continue →'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Docker step ─────────────────────────────────────────────

function DockerStep({ goNext, goBack }: StepProps) {
  return (
    <div className="space-y-4">
      <DockerImagePanel />

      <div className="flex justify-between pt-2">
        <button onClick={goBack} className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]">← Back</button>
        <div className="flex gap-2">
          <button
            onClick={goNext()}
            className="px-3 py-1.5 rounded-md text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-card-hover)]"
          >
            Skip — I&rsquo;ll do this myself
          </button>
          <button
            onClick={goNext()}
            className="px-4 py-1.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium"
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Done step ───────────────────────────────────────────────

function DoneStep() {
  const router = useRouter()
  return (
    <div className="space-y-4">
      <h2 className="text-[15px] font-semibold">All set</h2>
      <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">
        Your <code className="font-mono bg-[var(--bg-badge)] px-1 rounded">.env.local</code> is written. The dashboard reloads new values without a restart.
      </p>
      <p className="text-[11px] text-[var(--text-muted)]">
        Caveats: a valid Anthropic key with no credit balance will pass setup but fail on first briefing. If you built with <code>next build</code>, public env vars need a rebuild rather than just a restart.
      </p>
      <div className="flex justify-end pt-2">
        <button
          onClick={() => { router.refresh(); router.push('/') }}
          className="px-4 py-1.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium"
        >
          Open dashboard →
        </button>
      </div>
    </div>
  )
}

// ─── Permission fallback ─────────────────────────────────────

function PermissionFallback({ rendered, onClose }: { rendered: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  const download = () => {
    const blob = new Blob([rendered], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '.env.local'
    a.click()
    URL.revokeObjectURL(url)
  }

  const copy = async () => {
    await navigator.clipboard.writeText(rendered)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="mb-4 p-4 rounded-md bg-amber-500/10 border border-amber-500/30 space-y-2">
      <p className="text-[12px] font-semibold text-amber-300">Couldn&rsquo;t write .env.local automatically</p>
      <p className="text-[11px] text-amber-100/80">Permission denied on the file. Save it manually:</p>
      <div className="flex gap-2">
        <button onClick={download} className="px-3 py-1.5 rounded-md bg-amber-500/20 text-[11px] text-amber-100 hover:bg-amber-500/30">Download .env.local</button>
        <button onClick={copy} className="px-3 py-1.5 rounded-md bg-amber-500/20 text-[11px] text-amber-100 hover:bg-amber-500/30">{copied ? 'Copied!' : 'Copy to clipboard'}</button>
        <button onClick={onClose} className="ml-auto px-3 py-1.5 rounded-md text-[11px] text-amber-100 hover:bg-amber-500/10">I&rsquo;ve saved it — close</button>
      </div>
    </div>
  )
}
