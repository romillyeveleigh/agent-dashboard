import { promises as fs } from 'node:fs'
import path from 'node:path'

export type ProbeResult = {
  ok: boolean
  message: string
  detail?: {
    suggestedFill?: { field: string; value: string }
    [k: string]: unknown
  }
  dependsOn?: string[]
  warning?: boolean
}

export type ProbeContext = {
  githubToken?: string
  linearKey?: string
}

const PROBE_TIMEOUT_MS = 3000

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ])
}

function fmtError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === 'timeout') return 'Request timed out'
  return msg
}

async function probeDashboardUrl(value: string): Promise<ProbeResult> {
  if (!value) return { ok: false, message: 'Required' }
  try {
    const u = new URL(value)
    if (!u.port && u.protocol === 'http:') {
      return { ok: false, message: 'URL should include a port (e.g. :3000)', warning: true }
    }
    return { ok: true, message: 'Looks valid' }
  } catch {
    return { ok: false, message: 'Not a valid URL' }
  }
}

async function probeClaudeOAuth(value: string): Promise<ProbeResult> {
  if (!value) return { ok: false, message: 'Required' }
  if (!value.startsWith('sk-ant-oat01-')) {
    return { ok: false, message: 'Token should start with sk-ant-oat01-' }
  }
  return { ok: true, message: 'Token format looks correct' }
}

async function probeGithubToken(value: string): Promise<ProbeResult> {
  if (!value) return { ok: false, message: 'Required' }
  try {
    const res = await withTimeout(
      fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${value}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'agent-dashboard-setup',
        },
      }),
      PROBE_TIMEOUT_MS,
    )
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'GitHub rejected the token (401/403)' }
    }
    if (!res.ok) {
      return { ok: false, message: `GitHub returned ${res.status}`, warning: true }
    }
    const json = await res.json() as { login?: string }
    const login = json.login || 'unknown'
    return {
      ok: true,
      message: `Authenticated as ${login}`,
      detail: { suggestedFill: { field: 'GITHUB_USERNAME', value: login }, login },
      dependsOn: ['GITHUB_USERNAME', 'REPO_URL'],
    }
  } catch (e) {
    return { ok: false, message: `Couldn't verify: ${fmtError(e)}`, warning: true }
  }
}

async function probeGithubUsername(value: string, ctx?: ProbeContext): Promise<ProbeResult> {
  if (!value) return { ok: false, message: 'Required' }
  if (!/^[a-zA-Z0-9-]+$/.test(value)) {
    return { ok: false, message: 'Invalid characters (use a-z, 0-9, -)' }
  }
  const token = ctx?.githubToken
  if (!token) return { ok: true, message: 'Format valid (will verify with GitHub token)' }
  try {
    const res = await withTimeout(
      fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'agent-dashboard-setup',
        },
      }),
      PROBE_TIMEOUT_MS,
    )
    if (!res.ok) return { ok: true, message: 'Format valid', warning: true }
    const json = await res.json() as { login?: string }
    if (json.login && json.login.toLowerCase() === value.toLowerCase()) {
      return { ok: true, message: 'Matches authenticated user' }
    }
    return { ok: false, message: `Doesn't match authenticated user (${json.login})` }
  } catch {
    return { ok: true, message: 'Format valid', warning: true }
  }
}

async function probeAnthropic(value: string): Promise<ProbeResult> {
  if (!value) return { ok: false, message: 'Required' }
  if (!value.startsWith('sk-ant-api')) {
    return { ok: false, message: 'Key should start with sk-ant-api' }
  }
  try {
    const res = await withTimeout(
      fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': value,
          'anthropic-version': '2023-06-01',
        },
      }),
      PROBE_TIMEOUT_MS,
    )
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Anthropic rejected the key (401/403)' }
    }
    if (!res.ok) {
      return { ok: false, message: `Anthropic returned ${res.status}`, warning: true }
    }
    const json = await res.json() as { data?: unknown[] }
    const n = Array.isArray(json.data) ? json.data.length : 0
    return { ok: true, message: `Key valid (${n} models accessible)` }
  } catch (e) {
    return { ok: false, message: `Couldn't verify: ${fmtError(e)}`, warning: true }
  }
}

async function probeRepoUrl(value: string, ctx?: ProbeContext): Promise<ProbeResult> {
  if (!value) return { ok: false, message: 'Required' }
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return { ok: false, message: 'Should be in org/repo format' }
  }
  const token = ctx?.githubToken
  if (!token) return { ok: true, message: 'Will verify after GitHub token is provided', warning: true }
  try {
    const res = await withTimeout(
      fetch(`https://api.github.com/repos/${value}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'agent-dashboard-setup',
        },
      }),
      PROBE_TIMEOUT_MS,
    )
    if (res.status === 404) return { ok: false, message: 'Repository not found' }
    if (!res.ok) return { ok: false, message: `GitHub returned ${res.status}`, warning: true }
    const json = await res.json() as { full_name?: string; default_branch?: string }
    return {
      ok: true,
      message: `Found ${json.full_name}, default branch ${json.default_branch}`,
      detail: { fullName: json.full_name, defaultBranch: json.default_branch },
    }
  } catch (e) {
    return { ok: false, message: `Couldn't verify: ${fmtError(e)}`, warning: true }
  }
}

async function probeLinearKey(value: string): Promise<ProbeResult> {
  if (!value) return { ok: false, message: 'Required' }
  try {
    const res = await withTimeout(
      fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: value },
        body: JSON.stringify({ query: '{ viewer { name } }' }),
      }),
      PROBE_TIMEOUT_MS,
    )
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Linear rejected the key (401/403)' }
    }
    if (!res.ok) return { ok: false, message: `Linear returned ${res.status}`, warning: true }
    const json = await res.json() as { data?: { viewer?: { name?: string } } }
    const name = json.data?.viewer?.name || 'unknown'
    return { ok: true, message: `Authenticated as ${name}` }
  } catch (e) {
    return { ok: false, message: `Couldn't verify: ${fmtError(e)}`, warning: true }
  }
}

// The Linear org slug (urlKey) is only used to build workspace deep-links and is
// fully derivable from the API key, so it's never user input: the save route
// captures it automatically whenever the key is written. Returns null on any
// failure — callers just skip persisting the slug and links degrade to none.
export async function fetchLinearOrgSlug(key: string): Promise<string | null> {
  try {
    const res = await withTimeout(
      fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: key },
        body: JSON.stringify({ query: '{ organization { urlKey } }' }),
      }),
      PROBE_TIMEOUT_MS,
    )
    if (!res.ok) return null
    const json = await res.json() as { data?: { organization?: { urlKey?: string } } }
    return json.data?.organization?.urlKey ?? null
  } catch {
    return null
  }
}

async function probeRepoPath(value: string): Promise<ProbeResult> {
  if (!value) return { ok: false, message: 'Required' }
  try {
    const stat = await fs.stat(value)
    if (!stat.isDirectory()) return { ok: false, message: 'Not a directory' }
    const gitStat = await fs.stat(path.join(value, '.git'))
    if (!gitStat.isDirectory() && !gitStat.isFile()) {
      return { ok: false, message: 'No .git directory found' }
    }
    return { ok: true, message: `Found git repo at ${value}` }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, message: 'Path does not exist' }
    }
    return { ok: false, message: `Couldn't verify: ${fmtError(e)}`, warning: true }
  }
}

async function probeFigma(value: string): Promise<ProbeResult> {
  if (!value) return { ok: false, message: 'Required' }
  try {
    const res = await withTimeout(
      fetch('https://api.figma.com/v1/me', {
        headers: { 'X-Figma-Token': value },
      }),
      PROBE_TIMEOUT_MS,
    )
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Figma rejected the key (401/403)' }
    }
    if (!res.ok) return { ok: false, message: `Figma returned ${res.status}`, warning: true }
    const json = await res.json() as { email?: string; handle?: string }
    return { ok: true, message: `Authenticated as ${json.email || json.handle || 'unknown'}` }
  } catch (e) {
    return { ok: false, message: `Couldn't verify: ${fmtError(e)}`, warning: true }
  }
}

const PROBES: Record<string, (v: string, ctx?: ProbeContext) => Promise<ProbeResult>> = {
  DASHBOARD_URL: probeDashboardUrl,
  CLAUDE_CODE_OAUTH_TOKEN: probeClaudeOAuth,
  GITHUB_TOKEN: probeGithubToken,
  GITHUB_USERNAME: probeGithubUsername,
  ANTHROPIC_API_KEY: probeAnthropic,
  REPO_URL: probeRepoUrl,
  LINEAR_API_KEY: probeLinearKey,
  REPO_PATH: probeRepoPath,
  FIGMA_API_KEY: probeFigma,
}

export async function probeField(field: string, value: string, context?: ProbeContext): Promise<ProbeResult> {
  const fn = PROBES[field]
  if (!fn) return { ok: false, message: `Unknown field: ${field}` }
  const result = await fn(value, context)
  PROBE_CACHE.set(field, { ok: result.ok, message: result.message, ts: Date.now() })
  return result
}

// In-process cache of last probe result per field. Used by /api/setup/status
// to render "last good: 12 minutes ago" without re-probing on every render.
type CachedProbe = { ok: boolean; message: string; ts: number }
export const PROBE_CACHE = new Map<string, CachedProbe>()

export const PROBE_CACHE_STALE_MS = 24 * 60 * 60 * 1000

export function getCachedProbe(field: string): CachedProbe | undefined {
  return PROBE_CACHE.get(field)
}
