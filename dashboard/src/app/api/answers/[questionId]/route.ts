import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { messages, tasks } from '@/lib/schema'
import { eq, and, gt } from 'drizzle-orm'
import { setupIncompleteResponse } from '@/lib/setup'
import { agentTokenValid, readAgentToken } from '@/lib/agent-auth'

// GET /api/answers/:questionId — agent polls for an answer to its question
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ questionId: string }> },
) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { questionId } = await params

  // Find the answer message that references this question
  // The answer is a human_to_agent message created after the question
  const question = await db
    .select()
    .from(messages)
    .where(eq(messages.id, questionId))
    .limit(1)

  if (!question.length) {
    return NextResponse.json({ error: 'Question not found' }, { status: 404 })
  }

  // Validate agent token against the task that owns this question
  const [task] = await db
    .select({ agentToken: tasks.agentToken })
    .from(tasks)
    .where(eq(tasks.id, question[0].taskId))
    .limit(1)
  if (!agentTokenValid(task?.agentToken ?? null, readAgentToken(req))) {
    return NextResponse.json({ error: 'invalid agent token' }, { status: 401 })
  }

  if (!question[0].answered) {
    // No answer yet — agent should keep polling
    return NextResponse.json({ answer: null })
  }

  // Find the answer message for this task that came after the question
  const answers = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.taskId, question[0].taskId),
        eq(messages.direction, 'human_to_agent'),
        gt(messages.createdAt, question[0].createdAt),
      ),
    )
    .orderBy(messages.createdAt)
    .limit(1)

  if (!answers.length) {
    return NextResponse.json({ answer: null })
  }

  return NextResponse.json({ answer: answers[0].content })
}
