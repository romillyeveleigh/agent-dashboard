/**
 * Supervisor v2 — replaces `claude -p | log-forwarder.sh` + channel-server.
 *
 * Runs Claude Code via the Agent SDK, hosts the dashboard channel tools
 * in-process, forwards typed messages to the dashboard, and implements
 * suspend-on-unanswered-question: reply polls for REPLY_GRACE_WINDOW_MS,
 * then the run is interrupted, the session id is already registered, and
 * the container exits 0 leaving <WorkingDir>/.suspended for the entrypoint's
 * cleanup trap. Resume: RESUME_SESSION_ID + RESUME_PROMPT env.
 */
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { writeFileSync } from 'node:fs'
import { z } from 'zod'

const WORKDIR = process.cwd() // container WorkingDir = /agent-work/tasks/<task-id>, set by the dashboard
const DASHBOARD_URL = required('DASHBOARD_URL')
const TASK_ID = required('TASK_ID')
const REPO_URL = required('REPO_URL')
const AGENT_TOKEN = process.env.AGENT_TOKEN || ''
const MODEL = process.env.AGENT_MODEL_RESOLVED || 'sonnet'
const RESUME_SESSION_ID = process.env.RESUME_SESSION_ID || ''
const RESUME_PROMPT = process.env.RESUME_PROMPT || ''
const GRACE_MS = Number(process.env.REPLY_GRACE_WINDOW_MS) || 10 * 60 * 1000
const POLL_MS = 5_000

function required(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} is required`); process.exit(1) }
  return v
}

// ---------- dashboard client (mirrors channel-server retry semantics) ----------
async function dash(path: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${DASHBOARD_URL}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(AGENT_TOKEN ? { 'x-agent-token': AGENT_TOKEN } : {}),
          ...init?.headers,
        },
      })
      if (res.status >= 500 && attempt < 3) { await sleep(2000); continue }
      return res
    } catch (err) {
      if (attempt < 3) { await sleep(2000); continue }
      throw err
    }
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------- log forwarding (batched like log-forwarder.sh) ----------
type LogRow = { type: string; content: string }
let batch: LogRow[] = []
let flushTimer: NodeJS.Timeout | null = null
const MAX_ASSISTANT_LEN = 20_000 // assistant text is human-facing, never clip to noise length
const MAX_NOISE_LEN = 500
const SKIP_TOOLS = new Set(['Read', 'Glob', 'Grep', 'ToolSearch'])

function log(type: string, content: string) {
  batch.push({ type, content })
  if (batch.length >= 5) void flushLogs()
  else if (!flushTimer) flushTimer = setTimeout(() => void flushLogs(), 3000)
}
async function flushLogs() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  if (batch.length === 0) return
  const payload = batch; batch = []
  try {
    await dash(`/api/tasks/${TASK_ID}/logs`, { method: 'POST', body: JSON.stringify(payload) })
  } catch (err) { console.error('[supervisor] log flush failed:', err) }
}
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + ' …[truncated]')

async function postStatus(status: string, message: string) {
  try {
    await dash('/api/status', { method: 'POST', body: JSON.stringify({ task_id: TASK_ID, status, message }) })
  } catch (err) { console.error('[supervisor] status post failed:', err) }
}

// ---------- suspend coordination ----------
let suspendRequested = false
let interruptFn: (() => Promise<unknown>) | null = null

// ---------- channel tools (port of channel-server/index.ts) ----------
const CHANNEL_TRAILER =
  '\n\n[channel] If you respond to this — even briefly — you MUST send that response via the channel tools; ' +
  'plain assistant text goes to the log stream only and the human will never see it. ' +
  'Use reply if you need another answer, say for acknowledgements. ' +
  'Do not post_status complete until the human signals the conversation is finished.'

const channelServer = createSdkMcpServer({
  name: 'dashboard',
  version: '2.0.0',
  tools: [
    tool('reply',
      'Ask the human a question via the dashboard. Waits for the answer (approvals, questions, blockers only). ' +
      'If the human does not answer promptly the task is safely suspended and resumed when they do — never use this for messages that need no answer; use say for those.',
      { text: z.string(), type: z.enum(['question', 'approval', 'blocker']).default('question') },
      async ({ text, type }) => {
        const post = await dash('/api/questions', { method: 'POST', body: JSON.stringify({ task_id: TASK_ID, text, type }) })
        if (!post.ok) return errText(`Failed to post question: ${post.status} ${await post.text()}`)
        const { id: questionId } = await post.json() as { id: string }
        const deadline = Date.now() + GRACE_MS
        while (Date.now() < deadline) {
          await sleep(POLL_MS)
          const answer = await checkAnswer(questionId)
          if (answer !== null) return okText(`Human answered: ${answer}${CHANNEL_TRAILER}`)
        }
        // Final check closes the answered-during-last-tick race, then suspend.
        const last = await checkAnswer(questionId)
        if (last !== null) return okText(`Human answered: ${last}${CHANNEL_TRAILER}`)
        suspendRequested = true
        // Rejection-safe: suspend must not depend on interrupt succeeding — an
        // unhandled rejection here would crash the process and bypass suspend.
        if (interruptFn) void interruptFn().catch(err => console.error('[supervisor] interrupt failed:', err))
        return okText('No answer yet — the task is being suspended and will resume when the human replies. Stop working now.')
      }),
    tool('say',
      'Post a message to the dashboard thread WITHOUT waiting for an answer. Acknowledgements, FYI reports, progress notes.',
      { text: z.string() },
      async ({ text }) => {
        const res = await dash('/api/questions', { method: 'POST', body: JSON.stringify({ task_id: TASK_ID, text, expects_answer: false }) })
        return res.ok ? okText('Message posted. Continue working.') : errText(`Failed: ${res.status} ${await res.text()}`)
      }),
    tool('post_diff', 'Post the completed diff/patch to the dashboard. Call when implementation is finished.',
      { patch: z.string(), summary: z.string(), pr_url: z.string().optional() },
      async ({ patch, summary, pr_url }) => {
        const res = await dash('/api/diffs', { method: 'POST', body: JSON.stringify({ task_id: TASK_ID, patch, summary, pr_url }) })
        return res.ok ? okText('Diff posted.') : errText(`Failed: ${res.status} ${await res.text()}`)
      }),
    tool('post_status', 'Update the task status on the dashboard.',
      { status: z.enum(['running', 'waiting_for_feedback', 'complete', 'failed', 'cancelled']), message: z.string().optional() },
      async ({ status, message }) => {
        const res = await dash('/api/status', { method: 'POST', body: JSON.stringify({ task_id: TASK_ID, status, message }) })
        return res.ok ? okText(`Status updated to ${status}.`) : errText(`Failed: ${res.status} ${await res.text()}`)
      }),
    tool('save_memory', 'Save a repo discovery for future tasks (1-3 sentences, include commands/paths).',
      { content: z.string(), category: z.string().optional() },
      async ({ content, category }) => {
        const res = await dash('/api/memories', { method: 'POST', body: JSON.stringify({ repo_url: REPO_URL, category: category ?? null, content, source: TASK_ID }) })
        return res.ok ? okText(`Memory saved: ${content}`) : errText(`Failed: ${res.status} ${await res.text()}`)
      }),
  ],
})
async function checkAnswer(questionId: string): Promise<string | null> {
  try {
    const res = await dash(`/api/answers/${questionId}`)
    if (!res.ok) return null
    const data = await res.json() as { answer?: string }
    return data.answer ?? null
  } catch { return null }
}
const okText = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const errText = okText

// ---------- main ----------
async function main() {
  const promptText = RESUME_SESSION_ID
    ? `The human answered your earlier question. Their answer:\n\n${RESUME_PROMPT}\n\nContinue the task from where you left off. Remember: responses to the human go via the channel tools.`
    : required('AGENT_PROMPT')

  // Streaming input (async iterable of SDKUserMessage) instead of a plain
  // string: control requests like interrupt() are only supported in
  // streaming input/output mode (sdk.d.ts, Query control-request docs).
  async function* promptStream() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: promptText },
      parent_tool_use_id: null,
    }
  }

  const q = query({
    prompt: promptStream(),
    options: {
      cwd: WORKDIR,
      model: MODEL,
      settings: { attribution: { commit: '', pr: '' } },
      ...(RESUME_SESSION_ID ? { resume: RESUME_SESSION_ID } : {}),
      mcpServers: {
        dashboard: channelServer,
        ...(process.env.LINEAR_API_KEY ? {
          linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: `Bearer ${process.env.LINEAR_API_KEY}` } },
        } : {}),
        ...(process.env.FIGMA_API_KEY ? {
          figma: { type: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'], env: { FIGMA_API_KEY: process.env.FIGMA_API_KEY } },
        } : {}),
      },
      allowedTools: [
        'Read', 'Edit', 'Bash', 'Write', 'Glob', 'Grep', 'Skill', 'Task',
        'mcp__dashboard__*', 'mcp__linear__*', 'mcp__claude_ai_Linear__*', 'mcp__figma__*',
      ],
    },
  })
  interruptFn = () => q.interrupt()

  let sawResult = false
  let fatalErr: unknown = null
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        log('system', `Model: ${msg.model} (requested: ${MODEL})`)
        await dash(`/api/tasks/${TASK_ID}/session`, { method: 'POST', body: JSON.stringify({ session_id: msg.session_id }) })
          .catch(err => console.error('[supervisor] session registration failed:', err))
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) log('assistant', clip(block.text, MAX_ASSISTANT_LEN))
          else if (block.type === 'thinking' && block.thinking) log('thinking', clip(block.thinking, MAX_NOISE_LEN))
          else if (block.type === 'tool_use' && !SKIP_TOOLS.has(block.name)) {
            const input = block.input as Record<string, unknown>
            let detail = ''
            if ((block.name === 'Edit' || block.name === 'Write') && typeof input.file_path === 'string') detail = ` → ${input.file_path.split('/').pop()}`
            else if (block.name === 'Bash' && typeof input.command === 'string') detail = ` → ${input.command.replace(/\n/g, ' ').slice(0, 80)}`
            else if (block.name === 'Skill' && typeof input.skill === 'string') detail = ` → ${input.skill}`
            log('tool_use', block.name + detail)
          }
        }
      } else if (msg.type === 'result') {
        sawResult = true
        const cost = 'total_cost_usd' in msg ? msg.total_cost_usd : 0
        log('system', `Done. Cost: $${cost.toFixed(4)}, duration: ${(msg.duration_ms / 1000).toFixed(1)}s, turns: ${msg.num_turns}`)
      }
    }
  } catch (err) {
    if (suspendRequested) {
      // Interrupt-triggered termination can surface as a stream error — expected.
      console.error('[supervisor] query ended with error during suspend (expected):', err)
    } else {
      fatalErr = err
    }
  } finally {
    await flushLogs()
  }

  if (suspendRequested) {
    writeFileSync(`${WORKDIR}/.suspended`, 'suspended awaiting human answer\n')
    await postStatus('waiting_for_feedback', 'Suspended — will resume when answered')
    process.exit(0)
  }
  if (fatalErr) throw fatalErr // handled by main().catch → failed
  await postStatus(sawResult ? 'complete' : 'failed', sawResult ? 'Task finished' : 'Claude Code ended without a result')
  process.exit(sawResult ? 0 : 1)
}

main().catch(async (err) => {
  // Belt and braces: if a suspend was requested but an error unwound past
  // main()'s own suspend handling, suspend semantics still win over 'failed'.
  if (suspendRequested) {
    console.error('[supervisor] error during suspend (suspending anyway):', err)
    await flushLogs()
    writeFileSync(`${WORKDIR}/.suspended`, 'suspended awaiting human answer\n')
    await postStatus('waiting_for_feedback', 'Suspended — will resume when answered')
    process.exit(0)
  }
  console.error('[supervisor] fatal:', err)
  log('error', String(err))
  await flushLogs()
  await postStatus('failed', `Supervisor error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
