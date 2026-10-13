import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const dynamic = 'force-dynamic'

const execFileAsync = promisify(execFile)

export async function POST(req: NextRequest) {
  let prompt = 'Select a folder'
  try {
    const body = await req.json()
    if (typeof body?.prompt === 'string' && body.prompt) prompt = body.prompt
  } catch {
    // no body — use default prompt
  }

  const platform = process.platform
  try {
    if (platform === 'darwin') {
      // Escape backslashes and double quotes for the AppleScript string literal.
      const safe = prompt.replace(/["\\]/g, '\\$&')
      const script = `POSIX path of (choose folder with prompt "${safe}")`
      const { stdout } = await execFileAsync('osascript', ['-e', script])
      const path = stdout.trim()
      if (!path) return NextResponse.json({ ok: false, reason: 'cancelled' })
      return NextResponse.json({ ok: true, path })
    }
    if (platform === 'linux') {
      const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', `--title=${prompt}`])
      const path = stdout.trim()
      if (!path) return NextResponse.json({ ok: false, reason: 'cancelled' })
      return NextResponse.json({ ok: true, path })
    }
    return NextResponse.json({ ok: false, reason: 'unavailable' })
  } catch (e: unknown) {
    // osascript and zenity both exit 1 when the user cancels the dialog.
    const err = e as { code?: number | string; stderr?: string }
    if (err.code === 1) return NextResponse.json({ ok: false, reason: 'cancelled' })
    // ENOENT (tool missing) or anything else → unavailable
    return NextResponse.json({ ok: false, reason: 'unavailable' })
  }
}
