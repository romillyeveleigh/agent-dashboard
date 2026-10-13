/**
 * Simple SSE event emitter for live dashboard updates.
 * API routes call emit() when state changes; the /api/events route streams to clients.
 */

type Listener = (event: string, data: string) => void

// Persist across Next.js HMR — same pattern as reconciler.ts
const LISTENERS_KEY = '__agent_dashboard_sse_listeners__'
const g = globalThis as unknown as Record<string, Set<Listener> | undefined>
if (!g[LISTENERS_KEY]) g[LISTENERS_KEY] = new Set<Listener>()
const listeners = g[LISTENERS_KEY]!

export function addListener(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emit(event: string, data: unknown) {
  const json = JSON.stringify(data)
  for (const listener of listeners) {
    listener(event, json)
  }
}
