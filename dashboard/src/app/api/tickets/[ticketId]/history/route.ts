import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { tasks, messages } from '@/lib/schema'
import { eq, desc, getTableColumns, inArray, sql } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'

// Same trim as the task list: no launch config or agent token, prompt cut to
// 200 chars (the timeline shows its first line) — full rows ran to ~1MB
const { launchConfigJson: _lc, agentToken: _tok, ...historyColumns } = getTableColumns(tasks)

// GET /api/tickets/:ticketId/history — timeline of all tasks and messages for a ticket
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { ticketId } = await params

  const ticketTasks = await db
    .select({ ...historyColumns, prompt: sql<string>`substr(${tasks.prompt}, 1, 200)` })
    .from(tasks)
    .where(eq(tasks.ticketId, ticketId))
    .orderBy(desc(tasks.createdAt))

  const taskIds = ticketTasks.map(t => t.id)
  const allMessages = taskIds.length
    ? await db.select().from(messages).where(inArray(messages.taskId, taskIds))
    : []

  const messagesByTask = new Map<string, typeof allMessages>()
  for (const m of allMessages) {
    const list = messagesByTask.get(m.taskId) ?? []
    list.push(m)
    messagesByTask.set(m.taskId, list)
  }

  const history = ticketTasks.map(task => ({
    task,
    messages: messagesByTask.get(task.id) ?? [],
  }))

  return NextResponse.json(history)
}
