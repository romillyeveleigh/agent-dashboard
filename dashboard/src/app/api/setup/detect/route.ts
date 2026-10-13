import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const dynamic = 'force-dynamic'

const execFileAsync = promisify(execFile)

type Detected = { value: string } | { reason: 'not-found' | 'unavailable' }

async function detectGithubToken(): Promise<Detected> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'])
    const value = stdout.trim()
    if (!value) return { reason: 'not-found' }
    return { value }
  } catch (e: unknown) {
    const err = e as { code?: string }
    if (err.code === 'ENOENT') return { reason: 'unavailable' } // gh not installed
    return { reason: 'not-found' } // gh present but not authenticated
  }
}

export async function POST(req: NextRequest) {
  let field = ''
  try {
    const body = await req.json()
    if (typeof body?.field === 'string') field = body.field
  } catch {
    // no body
  }

  let result: Detected
  let source = ''
  if (field === 'GITHUB_TOKEN') { result = await detectGithubToken(); source = 'gh CLI' }
  else return NextResponse.json({ ok: false, reason: 'unavailable' })

  if ('value' in result) return NextResponse.json({ ok: true, value: result.value, source })
  return NextResponse.json({ ok: false, reason: result.reason })
}
