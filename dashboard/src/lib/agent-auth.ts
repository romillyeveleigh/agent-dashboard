import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * Verify a container-issued request against the task's stored token.
 * Legacy tasks (no stored token) are accepted so containers dispatched
 * before this feature keep working; remove the null-allowance once no
 * pre-token tasks can still be running.
 */
export function agentTokenValid(storedToken: string | null, header: string | null): boolean {
  if (storedToken == null) return true            // legacy task — allow
  if (!header) return false
  const a = createHash('sha256').update(storedToken).digest()
  const b = createHash('sha256').update(header).digest()
  return timingSafeEqual(a, b)
}

export function readAgentToken(req: NextRequest): string | null {
  return req.headers.get('x-agent-token')
}
