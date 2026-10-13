export const REQUIRED_VARS = [
  'DASHBOARD_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_USERNAME',
  'ANTHROPIC_API_KEY',
  'REPO_URL',
] as const

export const SECRET_VARS = new Set<string>([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'LINEAR_API_KEY',
  'FIGMA_API_KEY',
  'GITHUB_WEBHOOK_SECRET',
])

// Non-public → public mirroring
export const MIRRORED_PAIRS: Record<string, string> = {
  REPO_URL: 'NEXT_PUBLIC_REPO_URL',
  LINEAR_ORG_SLUG: 'NEXT_PUBLIC_LINEAR_ORG_SLUG',
}

export type IntegrationGroup = {
  id: 'required' | 'linear' | 'local-repo' | 'figma'
  label: string
  required: boolean
  vars: readonly string[]
}

export const GROUPS: readonly IntegrationGroup[] = [
  {
    id: 'required',
    label: 'Required',
    required: true,
    vars: REQUIRED_VARS,
  },
  {
    id: 'linear',
    label: 'Linear',
    required: false,
    vars: ['LINEAR_API_KEY', 'LINEAR_ORG_SLUG'],
  },
  {
    id: 'local-repo',
    label: 'Local repo',
    required: false,
    vars: ['REPO_PATH'],
  },
  {
    id: 'figma',
    label: 'Figma',
    required: false,
    vars: ['FIGMA_API_KEY'],
  },
] as const

export function isSecret(name: string): boolean {
  return SECRET_VARS.has(name)
}

export function maskSecret(value: string): string {
  if (!value) return ''
  const tail = value.length >= 4 ? value.slice(-4) : value
  return `••••${tail}`
}

export function lastFour(value: string): string {
  return value.length >= 4 ? value.slice(-4) : value
}

export type SetupStatus = {
  complete: boolean
  missing: string[]
}

export function getSetupStatus(): SetupStatus {
  const missing = REQUIRED_VARS.filter(k => !process.env[k] || process.env[k]?.trim() === '')
  return { complete: missing.length === 0, missing }
}

// Returns a 503 response if required vars are missing. Used by API route
// handlers as a one-line guard. Layouts cover page routes via redirect().
export function setupIncompleteResponse(): Response | null {
  const status = getSetupStatus()
  if (status.complete) return null
  return new Response(
    JSON.stringify({ error: 'setup-incomplete', missing: status.missing }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  )
}

export type VarStatus = {
  configured: boolean
  visibleValue?: string
  lastFour?: string
  isSecret: boolean
  mirrorMismatch?: boolean
  lastProbe?: { ok: boolean; message: string; ts: number }
}

export type StatusResponse = {
  complete: boolean
  missingRequired: string[]
  vars: Record<string, VarStatus>
}
