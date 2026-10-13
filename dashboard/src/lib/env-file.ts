import { promises as fs } from 'node:fs'
import path from 'node:path'
import { config as dotenvConfig } from 'dotenv'

// .env.local lives at the repo root; dashboard/ is one level down. Mirrors
// the path next.config.ts uses for its dotenv bootstrap.
export const ENV_FILE_PATH = path.resolve(process.cwd(), '..', '.env.local')
export const ENV_EXAMPLE_PATH = path.resolve(process.cwd(), '..', '.env.example')

const NEEDS_QUOTE = /[\s"'#=`$\\]|^\s|\s$|^$/

function quoteValue(v: string): string {
  if (v === '') return ''
  if (!NEEDS_QUOTE.test(v)) return v
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function unquoteValue(raw: string): string {
  let s = raw.trim()
  // Strip inline comment for unquoted values: "foo # comment" -> "foo"
  // (only when value isn't quoted)
  if (s.startsWith('"') || s.startsWith("'")) {
    const quote = s[0]
    let end = -1
    for (let i = 1; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue }
      if (s[i] === quote) { end = i; break }
    }
    if (end > 0) {
      const inner = s.slice(1, end)
      if (quote === '"') return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      return inner
    }
    return s.slice(1)
  }
  const hashIdx = s.indexOf(' #')
  if (hashIdx >= 0) s = s.slice(0, hashIdx).trim()
  return s
}

export type ParsedEntry = { key: string; value: string; lineIndex: number; rawLine: string }

export function parseEnvFile(text: string): Map<string, ParsedEntry> {
  const out = new Map<string, ParsedEntry>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue
    const rawValue = line.slice(eq + 1)
    out.set(key, { key, value: unquoteValue(rawValue), lineIndex: i, rawLine: line })
  }
  return out
}

export function serializeEnvFile(
  text: string,
  set: Record<string, string>,
  unset: string[],
): string {
  for (const v of Object.values(set)) {
    if (v.includes('\n') || v.includes('\r')) {
      throw new Error('Env value contains a newline; refusing to write')
    }
  }

  const lines = text.split('\n')
  const existing = parseEnvFile(text)
  const handled = new Set<string>()

  // Replace in place
  for (const [key, value] of Object.entries(set)) {
    const entry = existing.get(key)
    if (entry) {
      lines[entry.lineIndex] = `${key}=${quoteValue(value)}`
      handled.add(key)
    }
  }

  // Remove unset keys (mark as null, then filter)
  const removeIndices = new Set<number>()
  for (const key of unset) {
    const entry = existing.get(key)
    if (entry) removeIndices.add(entry.lineIndex)
  }

  // Append new keys not in file
  const newKeys = Object.keys(set).filter(k => !handled.has(k))
  let appended = ''
  if (newKeys.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') appended += '\n'
    for (const k of newKeys) appended += `${k}=${quoteValue(set[k])}\n`
  }

  const filtered = lines.filter((_, i) => !removeIndices.has(i))
  return filtered.join('\n') + (appended ? (filtered[filtered.length - 1] === '' ? appended : '\n' + appended) : '')
}

export async function readEnvFile(): Promise<string> {
  try {
    return await fs.readFile(ENV_FILE_PATH, 'utf8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  // Fall back to .env.example as template
  try {
    return await fs.readFile(ENV_EXAMPLE_PATH, 'utf8')
  } catch {
    // Both missing — generate a minimal template
    return `# ═════════════════════════════════════════════════════════════
# REQUIRED
# ═════════════════════════════════════════════════════════════

DASHBOARD_URL=
CLAUDE_CODE_OAUTH_TOKEN=
GITHUB_TOKEN=
GITHUB_USERNAME=
ANTHROPIC_API_KEY=
REPO_URL=

# ═════════════════════════════════════════════════════════════
# OPTIONAL
# ═════════════════════════════════════════════════════════════
`
  }
}

// Module-level mutex chain serializes writes within a single process.
let writeChain: Promise<unknown> = Promise.resolve()

export type WriteResult =
  | { ok: true }
  | { ok: false; reason: 'permission' | 'io'; message: string; renderedFile?: string }

export async function writeEnvFile(
  set: Record<string, string>,
  unset: string[] = [],
): Promise<WriteResult> {
  const op = async (): Promise<WriteResult> => {
    let text: string
    try {
      text = await readEnvFile()
    } catch (e: unknown) {
      return { ok: false, reason: 'io', message: (e as Error).message }
    }

    let next: string
    try {
      next = serializeEnvFile(text, set, unset)
    } catch (e: unknown) {
      return { ok: false, reason: 'io', message: (e as Error).message }
    }

    const tmp = ENV_FILE_PATH + '.tmp'
    try {
      await fs.writeFile(tmp, next, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(tmp, ENV_FILE_PATH)
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code
      try { await fs.unlink(tmp) } catch {}
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        return { ok: false, reason: 'permission', message: (e as Error).message, renderedFile: next }
      }
      return { ok: false, reason: 'io', message: (e as Error).message }
    }

    // Reload into process.env so subsequent reads see the new values
    // without requiring a server restart.
    dotenvConfig({ path: ENV_FILE_PATH, override: true })
    // Explicitly clear unset keys from process.env (dotenv only sets, never unsets)
    for (const k of unset) delete process.env[k]

    return { ok: true }
  }

  const result = writeChain.then(op, op)
  writeChain = result.catch(() => {})
  return result as Promise<WriteResult>
}
