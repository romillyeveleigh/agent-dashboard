import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { messages } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'

// GET /api/tasks/:taskId/messages — list messages for a task
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { taskId } = await params
  const result = await db
    .select()
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .orderBy(messages.createdAt)

  return NextResponse.json(result)
}
