import type { WorkItem, ReviewItem } from './dashboard-types'
import type { TaskSummary } from './schema'
import { ACTIVE_STATUSES } from './constants'

export type DispatchItem =
  | { kind: 'work'; item: WorkItem }
  | { kind: 'review'; item: ReviewItem }

/** Build the task context (ticketId / prNumber) for a dispatch item */
export function buildContext(d: DispatchItem): { ticketId?: string; prNumber?: number } {
  switch (d.kind) {
    case 'review':
      return { prNumber: d.item.number }
    case 'work':
      return d.item.type === 'orphan-pr'
        ? { prNumber: Number(d.item.id) }
        : { ticketId: d.item.id }
  }
}

/** Get the active task map key for a dispatch item */
export function activeTaskKey(d: DispatchItem): string {
  switch (d.kind) {
    case 'review':
      return `pr:${d.item.number}`
    case 'work':
      return d.item.type === 'orphan-pr' ? `pr:${d.item.id}` : `ticket:${d.item.id}`
  }
}

/** Whether an item can be dispatched (no active task running) */
export function canDispatch(d: DispatchItem, activeTaskMap: Map<string, TaskSummary>): boolean {
  return !activeTaskMap.has(activeTaskKey(d))
}

/** Build a map of active tasks keyed by ticket:/pr: for cross-referencing */
export function buildActiveTaskMap(tasks: TaskSummary[]): Map<string, TaskSummary> {
  const active = tasks
    .filter(t => ACTIVE_STATUSES.includes(t.status))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  const map = new Map<string, TaskSummary>()
  for (const task of active) {
    if (task.ticketId && !map.has(`ticket:${task.ticketId}`))
      map.set(`ticket:${task.ticketId}`, task)
    if (task.prNumber && !map.has(`pr:${task.prNumber}`))
      map.set(`pr:${task.prNumber}`, task)
  }
  return map
}
