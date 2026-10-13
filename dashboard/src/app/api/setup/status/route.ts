import { NextResponse } from 'next/server'
import {
  REQUIRED_VARS,
  GROUPS,
  MIRRORED_PAIRS,
  isSecret,
  lastFour,
  type StatusResponse,
} from '@/lib/setup'
import { getCachedProbe } from '@/lib/setup-probes'

export const dynamic = 'force-dynamic'

export async function GET() {
  const allVars = new Set<string>(REQUIRED_VARS)
  for (const g of GROUPS) for (const v of g.vars) allVars.add(v)
  for (const [k, v] of Object.entries(MIRRORED_PAIRS)) {
    allVars.add(k)
    allVars.add(v)
  }

  const vars: StatusResponse['vars'] = {}
  for (const name of allVars) {
    const value = process.env[name] ?? ''
    const configured = value.trim() !== ''
    const secret = isSecret(name)
    const entry: StatusResponse['vars'][string] = {
      configured,
      isSecret: secret,
    }
    if (configured) {
      if (secret) entry.lastFour = lastFour(value)
      else entry.visibleValue = value
    }
    const cached = getCachedProbe(name)
    if (cached) entry.lastProbe = cached
    vars[name] = entry
  }

  // Mirror-mismatch detection
  for (const [base, pub] of Object.entries(MIRRORED_PAIRS)) {
    const a = process.env[base] ?? ''
    const b = process.env[pub] ?? ''
    if (a && b && a !== b) {
      vars[base].mirrorMismatch = true
      vars[pub].mirrorMismatch = true
    }
  }

  const missingRequired = REQUIRED_VARS.filter(k => !vars[k]?.configured)
  const body: StatusResponse = {
    complete: missingRequired.length === 0,
    missingRequired,
    vars,
  }
  return NextResponse.json(body)
}
