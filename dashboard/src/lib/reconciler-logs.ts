/**
 * Append a reconciler/webhook activity entry to the `logs` table.
 * Shared by the poll cycle, the webhook route, and re-review.
 */

import { db } from './db'
import { logs } from './schema'

export async function appendReconcilerLog(taskId: string, content: string): Promise<void> {
  try {
    await db.insert(logs).values({ taskId, type: 'reconciler', content })
  } catch (err) {
    console.error('appendReconcilerLog failed:', err)
  }
}
