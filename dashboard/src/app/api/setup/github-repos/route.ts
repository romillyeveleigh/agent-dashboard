import { NextRequest, NextResponse } from 'next/server'
import { resilientFetch } from '@/lib/resilient-fetch'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let token = ''
  try {
    const body = await req.json()
    if (typeof body?.token === 'string') token = body.token
  } catch {
    // no body
  }
  if (!token) token = process.env.GITHUB_TOKEN ?? ''
  if (!token) return NextResponse.json({ ok: false, reason: 'no-token' })

  try {
    const res = await resilientFetch(
      'https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'do-some-work-setup',
        },
        timeoutMs: 8000,
      },
    )
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ ok: false, reason: 'unauthorized' })
    }
    if (!res.ok) return NextResponse.json({ ok: false, reason: 'error' })
    const json = await res.json() as Array<{ full_name?: string }>
    const repos = json
      .map(r => ({ fullName: r.full_name ?? '' }))
      .filter(r => r.fullName)
    return NextResponse.json({ ok: true, repos })
  } catch {
    return NextResponse.json({ ok: false, reason: 'error' })
  }
}
