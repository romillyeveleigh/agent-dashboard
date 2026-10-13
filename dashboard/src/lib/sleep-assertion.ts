/**
 * Host sleep assertion — keeps macOS awake while agent containers are running.
 *
 * A task dispatched while the host is about to sleep dies against the
 * suspended host (network calls fail with "unexpected EOF" / "Connection
 * closed mid-response") and burns its retry budget.
 *
 * A container holds no power assertion of its own — Docker Desktop's VM is
 * suspended along with the host — so the dashboard takes one on its behalf
 * while any agent container runs, and drops it as soon as none do. `-i` (idle
 * system sleep) and `-m` (disk idle sleep) are honoured on battery; `-s` is
 * AC-only and therefore not used. Display
 * sleep is deliberately left alone: a dark screen doesn't interrupt a task.
 */
import { spawn, type ChildProcess } from 'child_process'

type Holder = { child: ChildProcess | null; unavailable: boolean }

// globalThis singleton for the same reason the reconciler's intervals use one:
// a Next.js hot reload re-evaluates this module, and a module-local handle
// would be lost while the caffeinate process kept running — leaking an
// assertion nothing can release.
const HOLDER_KEY = '__agent_dashboard_sleep_assertion__'

function holder(): Holder {
  const g = globalThis as unknown as Record<string, Holder | undefined>
  if (!g[HOLDER_KEY]) g[HOLDER_KEY] = { child: null, unavailable: false }
  return g[HOLDER_KEY]!
}

/** Take the assertion if it isn't already held. Idempotent. */
export function ensureAwake(reason: string): void {
  if (process.platform !== 'darwin') return
  const h = holder()
  if (h.child || h.unavailable) return

  // -w <dashboard pid>: caffeinate exits when the dashboard does, so a crashed
  // or SIGKILL'd dashboard can't strand an assertion that pins the machine
  // awake indefinitely.
  const child = spawn('caffeinate', ['-i', '-m', '-w', String(process.pid)], {
    stdio: 'ignore',
  })
  h.child = child

  child.once('error', (err) => {
    if (h.child === child) h.child = null
    // No caffeinate on this host — don't retry every tick, just say so once.
    h.unavailable = true
    console.error(
      `[power] caffeinate unavailable, host may sleep mid-task: ${err.message}`,
    )
  })
  child.once('exit', () => {
    if (h.child === child) h.child = null
  })

  console.log(`[power] holding sleep assertion (${reason})`)
}

/** Drop the assertion if held. Idempotent. */
export function releaseAwake(): void {
  const h = holder()
  const child = h.child
  if (!child) return
  h.child = null
  child.kill()
  console.log('[power] released sleep assertion')
}

/**
 * Reconcile the assertion against the authoritative running-container count.
 * Called from the reconciler tick, so a container that dies without a clean
 * stopContainer (AutoRemove, crash, docker kill) still releases the host.
 */
export function syncAwake(runningContainers: number): void {
  if (runningContainers > 0) {
    ensureAwake(`${runningContainers} container${runningContainers === 1 ? '' : 's'} running`)
  } else {
    releaseAwake()
  }
}
