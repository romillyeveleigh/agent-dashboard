import { NextResponse } from 'next/server'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

export const dynamic = 'force-dynamic'

const execAsync = promisify(exec)

export async function GET() {
  const platform = process.platform
  const dashboardUrl = platform === 'linux'
    ? 'http://172.17.0.1:3001'
    : 'http://host.docker.internal:3001'

  let repoPath = ''
  try {
    // Resolve from the repo root (one level above `dashboard/` cwd)
    const root = path.resolve(process.cwd(), '..')
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: root })
    repoPath = stdout.trim()
  } catch {
    // not a git repo or git missing; leave blank
  }

  return NextResponse.json({
    DASHBOARD_URL: dashboardUrl,
    REPO_PATH: repoPath,
    platform,
  })
}
