import { NextRequest, NextResponse } from 'next/server'
import { writeEnvFile } from '@/lib/env-file'
import { MIRRORED_PAIRS } from '@/lib/setup'
import { fetchLinearOrgSlug } from '@/lib/setup-probes'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: { set?: Record<string, string>; unset?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 })
  }

  const set = body.set ?? {}
  const unset = body.unset ?? []

  // Validate values
  for (const [k, v] of Object.entries(set)) {
    if (typeof v !== 'string') {
      return NextResponse.json({ error: `non-string-value: ${k}` }, { status: 400 })
    }
    if (v.includes('\n') || v.includes('\r')) {
      return NextResponse.json({ error: `value-contains-newline: ${k}` }, { status: 400 })
    }
  }
  for (const k of unset) {
    if (typeof k !== 'string') {
      return NextResponse.json({ error: 'unset-must-be-strings' }, { status: 400 })
    }
  }

  // Apply mirrored-pair propagation server-side as a safety net.
  // The wizard already queues both, but if the client sends only one, mirror it.
  const finalSet: Record<string, string> = { ...set }
  const finalUnset = new Set(unset)

  // The Linear org slug is derived, not user input: whenever a real Linear key
  // is written, capture the workspace slug from it. A masked value (resting
  // secret) carries no real key, so skip it. An explicit slug in `set` wins.
  const linearKey = set['LINEAR_API_KEY']
  if (linearKey && !linearKey.startsWith('••••') && !('LINEAR_ORG_SLUG' in finalSet)) {
    const slug = await fetchLinearOrgSlug(linearKey)
    if (slug) finalSet['LINEAR_ORG_SLUG'] = slug
  }
  // Removing the Linear key clears the derived slug with it.
  if (finalUnset.has('LINEAR_API_KEY')) finalUnset.add('LINEAR_ORG_SLUG')

  for (const [base, pub] of Object.entries(MIRRORED_PAIRS)) {
    if (base in finalSet && !(pub in finalSet)) finalSet[pub] = finalSet[base]
    if (pub in finalSet && !(base in finalSet)) finalSet[base] = finalSet[pub]
    if (finalUnset.has(base)) finalUnset.add(pub)
    if (finalUnset.has(pub)) finalUnset.add(base)
  }

  const result = await writeEnvFile(finalSet, [...finalUnset])
  if (!result.ok) {
    if (result.reason === 'permission') {
      return NextResponse.json(
        { ok: false, reason: 'permission', message: result.message, renderedFile: result.renderedFile },
        { status: 200 },
      )
    }
    return NextResponse.json({ ok: false, reason: result.reason, message: result.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
