import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { tasks, messages } from '@/lib/schema'
import { and, count, eq, inArray } from 'drizzle-orm'
import { fetchCurrentUser, fetchTicketsCompletedInWindow } from '@/lib/linear-data'
import { setupIncompleteResponse } from '@/lib/setup'

type ShippedTicket = { identifier: string; title: string; url: string; completedAt: string }
type WeekMetrics = { shipped: number; touchpointsPerTicket: number; tickets: ShippedTicket[] }

async function metricsForWindow(
  userId: string,
  fromMs: number,
  toMs: number,
): Promise<WeekMetrics> {
  const tickets = await fetchTicketsCompletedInWindow(
    userId,
    new Date(fromMs).toISOString(),
    new Date(toMs).toISOString(),
  )
  if (tickets.length === 0) {
    return { shipped: 0, touchpointsPerTicket: 0, tickets: [] }
  }

  // Touchpoints are lifetime-scoped: all human-dispatched tasks on this ticket
  // and all human replies on those tasks, not just the ones inside the window.
  // A ticket that took a month to ship correctly reports a month of attention.
  const ticketIds = tickets.map((t) => t.identifier)
  const humanTicketTask = and(inArray(tasks.ticketId, ticketIds), eq(tasks.dispatchedBy, 'human'))
  const [{ taskCount }] = await db
    .select({ taskCount: count() })
    .from(tasks)
    .where(humanTicketTask)
  const [{ replyCount }] = await db
    .select({ replyCount: count() })
    .from(messages)
    .innerJoin(tasks, eq(messages.taskId, tasks.id))
    .where(and(eq(messages.direction, 'human_to_agent'), humanTicketTask))
  const totalTouchpoints = taskCount + replyCount

  return {
    shipped: tickets.length,
    touchpointsPerTicket: Number((totalTouchpoints / tickets.length).toFixed(2)),
    tickets,
  }
}

export async function GET() {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const userId = await fetchCurrentUser()
  if (!userId) {
    return NextResponse.json({
      thisWeek: { shipped: 0, touchpointsPerTicket: 0, tickets: [] },
      lastWeek: { shipped: 0, touchpointsPerTicket: 0, tickets: [] },
    })
  }

  const { thisWeekStart, nextWeekStart, lastWeekStart } = currentCalendarWeekBounds()

  const [thisWeek, lastWeek] = await Promise.all([
    metricsForWindow(userId, thisWeekStart, nextWeekStart),
    metricsForWindow(userId, lastWeekStart, thisWeekStart),
  ])

  return NextResponse.json({ thisWeek, lastWeek })
}

// Calendar week starts Monday in the server's local timezone.
function currentCalendarWeekBounds() {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayOfWeek = startOfToday.getDay() // Sun=0, Mon=1, ..., Sat=6
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const dayMs = 24 * 60 * 60 * 1000
  const thisWeekStart = startOfToday.getTime() - daysSinceMonday * dayMs
  return {
    thisWeekStart,
    nextWeekStart: thisWeekStart + 7 * dayMs,
    lastWeekStart: thisWeekStart - 7 * dayMs,
  }
}
