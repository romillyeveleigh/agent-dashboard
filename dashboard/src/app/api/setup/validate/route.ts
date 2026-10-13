import { NextRequest, NextResponse } from 'next/server'
import { probeField, type ProbeContext } from '@/lib/setup-probes'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: { field?: string; value?: string; useEnv?: boolean; context?: ProbeContext }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 })
  }
  if (!body.field) return NextResponse.json({ error: 'missing-field' }, { status: 400 })

  let value = body.value
  if (body.useEnv) {
    value = process.env[body.field] ?? ''
  }
  if (typeof value !== 'string') return NextResponse.json({ error: 'missing-value' }, { status: 400 })
  if (value.includes('\n') || value.includes('\r')) {
    return NextResponse.json({ error: 'value-contains-newline' }, { status: 400 })
  }

  // Auto-fill context from process.env when not explicitly provided
  // (status-overview re-tests use this path).
  const context: ProbeContext = { ...body.context }
  if (!context.githubToken && process.env.GITHUB_TOKEN) context.githubToken = process.env.GITHUB_TOKEN
  if (!context.linearKey && process.env.LINEAR_API_KEY) context.linearKey = process.env.LINEAR_API_KEY

  const result = await probeField(body.field, value, context)
  return NextResponse.json(result)
}
