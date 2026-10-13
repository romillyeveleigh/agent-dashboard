/**
 * Per-task async mutex.
 *
 * Drizzle's better-sqlite3 transactions are synchronous, which is fine for
 * read → write pairs but incompatible with the Phase 2 reaction pipeline —
 * `dispatchTask` must await Docker. Instead we serialise poll + webhook
 * reactions on the same ship task with an in-process mutex, which matches
 * the current single-Node-process deployment.
 */

const locks = new Map<string, Promise<unknown>>()

export async function withTaskLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve()
  // Swallow the prior run's errors so they don't poison the next waiter.
  const nextChain = prior.then(fn, fn)
  locks.set(key, nextChain)
  try {
    return (await nextChain) as T
  } finally {
    if (locks.get(key) === nextChain) locks.delete(key)
  }
}
