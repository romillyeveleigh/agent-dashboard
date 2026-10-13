/**
 * Shared lookups for reaction-target tasks tracking a PR. Used by the poll
 * cycle and the webhook route. The "find reaction target" rule itself lives
 * in reaction-target.ts so the UI renders watch state from the same
 * predicate the reconciler dispatches on.
 */

import { and, eq, isNotNull, isNull, notInArray } from 'drizzle-orm'
import { db } from './db'
import { tasks } from './schema'
import type { Task } from './schema'
import { INACTIVE_STATUSES } from './constants'
import { isReactionTarget } from './reaction-target'

export async function findShipTaskForPR(prNumber: number): Promise<Task | null> {
  const candidates = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.prNumber, prNumber),
        isNotNull(tasks.prNumber),
        isNull(tasks.shippedAt),
        notInArray(tasks.status, INACTIVE_STATUSES),
      ),
    )
  return candidates.find(isReactionTarget) ?? null
}

export async function findActiveShipTasks(): Promise<Task[]> {
  const candidates = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.prNumber),
        isNull(tasks.shippedAt),
        notInArray(tasks.status, INACTIVE_STATUSES),
      ),
    )
  return candidates.filter(isReactionTarget)
}
