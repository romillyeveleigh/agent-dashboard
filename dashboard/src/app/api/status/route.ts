import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { tasks, messages, logs } from '@/lib/schema'
import { emit } from '@/lib/events'
import { transition } from '@/lib/task-transitions'
import { fireExtractLearnings } from '@/lib/learning-extractor'
import { refreshContextCaches } from '@/lib/context-fetchers'
import { AGENT_REPORTABLE_STATUSES, isTerminalStatus } from '@/lib/constants'
import { requestRereview } from '@/lib/request-rereview'
import { recoverStrandedReply } from '@/lib/recover-stranded-reply'
import { eq, and } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { setupIncompleteResponse } from '@/lib/setup'
import { agentTokenValid, readAgentToken } from '@/lib/agent-auth'

// POST /api/status — agent updates its task status
export async function POST(req: NextRequest) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const body = await req.json()
  const { task_id, status: incoming, message } = body as {
    task_id: string
    status: string
    message?: string
  }

  if (!task_id || !incoming) {
    return NextResponse.json(
      { error: 'task_id and status are required' },
      { status: 400 },
    )
  }

  // Reject out-of-enum statuses: written verbatim they'd leave the task in a
  // state the reconciler neither monitors nor reaps — stuck forever.
  if (!AGENT_REPORTABLE_STATUSES.includes(incoming)) {
    return NextResponse.json(
      { error: `invalid status "${incoming}" — must be one of: ${AGENT_REPORTABLE_STATUSES.join(', ')}` },
      { status: 400 },
    )
  }

  // Read the old status so re-review fires only on the non-terminal→complete edge,
  // not on duplicate POSTs.
  const existing = await db
    .select({
      status: tasks.status,
      statusMessage: tasks.statusMessage,
      agentToken: tasks.agentToken,
      retryCount: tasks.retryCount,
      maxRetries: tasks.maxRetries,
      launchConfigJson: tasks.launchConfigJson,
    })
    .from(tasks)
    .where(eq(tasks.id, task_id))
    .limit(1)
  const prevStatus = existing[0]?.status

  // The supervisor posts a generic terminal status ("Task finished" / "Claude
  // Code ended without a result" / "Supervisor error: ...") AFTER the agent's
  // own post_status verdict, which would otherwise clobber the agent's message
  // in status_message.
  //
  // Preserve the agent's message ONLY when the agent had already reached a terminal
  // verdict of its own (prevStatus is terminal) — that message is the real outcome
  // and the supervisor's signal is just confirmation. But when the agent was still
  // mid-run (prevStatus non-terminal) and the process died, its last status_message
  // is a stale progress note ("Reading ticket…"), not a verdict. In that case the
  // supervisor's own message is the more informative one and must win, otherwise
  // a crashed task shows a "still working" message and the real failure reason —
  // the only forensic data — is lost.
  //
  // The supervisor's no-verdict paths ("Claude Code ended without a result",
  // "Supervisor error: ...") must also count as generic, otherwise a pure
  // transport failure is misclassified as a real verdict and skips the retry path.
  const isGenericFinalMessage =
    message === 'Task finished' ||
    message === 'Claude Code ended without a result' ||
    (message?.startsWith('Claude Code exited with code') ?? false) ||
    (message?.startsWith('Supervisor error: ') ?? false)
  // waiting_for_feedback counts as a verdict here: the agent deliberately
  // parked the task (reply-suspend or a repaired questionless park — see the
  // synthesis block below); the supervisor's generic exit that follows is the
  // expected end of stream, not a crash.
  const agentHadVerdict = prevStatus
    ? isTerminalStatus(prevStatus) || prevStatus === 'waiting_for_feedback'
    : false
  // A generic entrypoint exit with no preceding agent verdict means the process
  // died (crashed, ran out of runway, got killed) mid-run with no real outcome —
  // "exit code 0" here is not the same as "the agent finished its work". Treat it
  // as a failure even when the entrypoint itself reports "complete", otherwise a
  // task that never implemented/verified/replied shows as a silent, misleading
  // success with no retry.
  const isBareCrash = isGenericFinalMessage && !agentHadVerdict
  const effectiveMessage =
    isGenericFinalMessage && agentHadVerdict && existing[0]?.statusMessage
      ? existing[0].statusMessage
      : message || null

  // Forensic record: a bare-crash exit (whether the entrypoint reported it as
  // "failed" or, misleadingly, "complete") means the process died mid-run. The
  // reconciler's diagnostics path is skipped for already-terminal tasks, so
  // capture the exit message as an error log here — it's otherwise discarded
  // when the container is AutoRemove'd.
  if (isBareCrash && message) {
    await db.insert(logs).values({ taskId: task_id, type: 'error', content: message })
    emit('log:new', { taskId: task_id })
  }

  if (!agentTokenValid(existing[0]?.agentToken ?? null, readAgentToken(req))) {
    return NextResponse.json({ error: 'invalid agent token' }, { status: 401 })
  }

  // Bare-crash auto-retry. The reconciler's retry only covers containers that die
  // silently while the task is still ACTIVE — but most real crashes arrive HERE:
  // the entrypoint outlives a dead/stalled Claude process and self-reports, which
  // used to land the task on 'failed' directly, so the reconciler never saw it and
  // the max_retries budget went unspent.
  //
  // When retry budget remains, decline to record the terminal status: leave the
  // task ACTIVE so the reconciler's container-gone sweep (≤10s) performs its
  // normal auto-retry with its own bookkeeping. Retrying directly from this
  // handler would race replaceTaskContainer's still-running guard — the reporting
  // container is alive until this response is sent, so the replace would no-op and
  // strand the task in 'starting'. The reconciler only acts once the container has
  // genuinely exited, which is exactly the ordering the retry needs.
  const crashed = existing[0]
  if (isBareCrash && crashed && crashed.retryCount < crashed.maxRetries && crashed.launchConfigJson) {
    await db
      .update(tasks)
      .set({
        statusMessage: `${message} — auto-retry queued`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task_id))
    emit('task:status', { taskId: task_id, status: prevStatus, message: `${message} — auto-retry queued` })
    return NextResponse.json({ ok: true, status: prevStatus, retryQueued: true })
  }

  // Guard: don't let an agent claim 'complete' while a question is still unanswered.
  // The agent's reply tool gets killed by the harness ~30 min in; without this the
  // task goes complete and the dashboard loses its waiting indicator.
  //
  // Bare-crash completions are reclassified to 'failed' up front — they never had
  // a real verdict, so the pending-question coercion below (which only makes sense
  // for a genuine completion) doesn't apply to them.
  let status = incoming === 'complete' && isBareCrash ? 'failed' : incoming
  let coerced = false
  // A generic `failed` over a parked task gets the same pending-question
  // coercion as `complete`: the supervisor dying after a park must not close
  // a question the human can still answer (the answers route rejects
  // non-waiting tasks). A non-generic `failed` is the agent's own explicit
  // verdict and still fails the task normally.
  const shouldCheckPending =
    status === 'complete' ||
    (status === 'failed' && isGenericFinalMessage && prevStatus === 'waiting_for_feedback')
  if (shouldCheckPending) {
    const [pending] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.taskId, task_id),
          eq(messages.direction, 'agent_to_human'),
          eq(messages.answered, false),
        ),
      )
      .limit(1)
    if (pending) {
      status = 'waiting_for_feedback'
      coerced = true
    } else if (status === 'complete') {
      // No open question, but the human may have spoken last and had their
      // follow-up answered only in the agent's log stream (the `reply` tool is
      // the sole channel that posts into the thread). Surface any such stranded
      // answer so the conversation doesn't dead-end before the task completes.
      recoverStrandedReply(task_id)
    }
  }

  // waiting_for_feedback may only ever exist alongside an unanswered question —
  // the reply input renders exclusively off a pending question, so a
  // questionless park is unanswerable from the UI. Repair by synthesizing the missing question from
  // the agent's own message; erring toward waiting-with-a-question, never
  // toward force-completing a possibly-stuck task. Keyed on the FINAL status:
  // the coerced-from-complete case above finds its pending question and no-ops.
  if (status === 'waiting_for_feedback') {
    const [pending] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.taskId, task_id),
          eq(messages.direction, 'agent_to_human'),
          eq(messages.answered, false),
        ),
      )
      .limit(1)
    if (!pending) {
      const messageId = uuid()
      // `||` not `??`: an empty-string message needs the fallback too. The
      // same resolved content feeds both the insert and the emit — mirroring
      // questions/route.ts, whose message:new payload always carries the
      // text it inserted.
      const content = message || 'Agent paused this task awaiting input but did not ask a question.'
      await db.insert(messages).values({
        id: messageId,
        taskId: task_id,
        direction: 'agent_to_human',
        content,
        type: 'question',
        answered: false,
      })
      emit('message:new', { id: messageId, taskId: task_id, text: content, type: 'question', answered: false })
      console.warn(`[status] questionless waiting_for_feedback from task ${task_id} — synthesized question`)
    }
  }

  await transition(task_id, status, { actor: 'agent', message: effectiveMessage })

  if (isTerminalStatus(status)) {
    fireExtractLearnings(task_id)
  }

  if (isTerminalStatus(status) && prevStatus && !isTerminalStatus(prevStatus)) {
    // The agent may have just closed a ticket or merged a PR — refresh the
    // dashboard's external context. Fire-and-forget: never block the
    // container's status POST on GitHub/Linear round-trips.
    refreshContextCaches('task-terminal').catch(err =>
      console.error('[context-refresh] task-terminal trigger failed:', err),
    )
  }

  if (status === 'complete' && prevStatus && !isTerminalStatus(prevStatus)) {
    requestRereview(task_id).catch(err => console.error('requestRereview failed:', err))
  }

  return NextResponse.json({ ok: true, status, coerced })
}
