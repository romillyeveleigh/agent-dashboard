import Dockerode from 'dockerode'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { statfs } from 'fs/promises'
import path from 'path'
import { DEFAULT_SKILL } from './constants'
import { ensureAwake } from './sleep-assertion'

const docker = new Dockerode()

// Built locally with `docker build -t agent-worker:local -f docker/Dockerfile .`
const IMAGE_NAME = process.env.AGENT_IMAGE || 'agent-worker:local'
// Override to run a second dashboard on the same host without sharing workspaces.
const WORK_VOLUME = process.env.AGENT_WORK_VOLUME || 'agent-work'
// v2 canary: tasks whose primary tag is listed in AGENT_V2_TAGS run on the
// AGENT_IMAGE_V2 image. Both unset = everything stays on IMAGE_NAME.
const IMAGE_V2 = process.env.AGENT_IMAGE_V2 || ''
const V2_TAGS = (process.env.AGENT_V2_TAGS || '').split(',').map(s => s.trim()).filter(Boolean)
const REPO_PATH = process.env.REPO_PATH || ''
const REPO_URL = process.env.REPO_URL || ''
const SKILLS_PATH = process.env.SKILLS_PATH || path.resolve(process.cwd(), '../.claude/skills')
// Dispatch preflight: a full host disk wedges the Docker daemon rather than
// erroring. 0 disables.
const MIN_FREE_DISK_GB = Number(process.env.AGENT_MIN_FREE_DISK_GB ?? 10)
const DISK_CHECK_PATH = process.env.AGENT_DISK_CHECK_PATH || '/'
// Per-container memory limit. Large monorepo installs/test runs can OOM at 4GB.
const MEMORY_GB = Number(process.env.AGENT_MEMORY_GB) || 8

/**
 * True when this tag set routes to the v2 (suspend/resume-capable) image.
 * Post-flip (AGENT_IMAGE itself set to the v2 image, AGENT_IMAGE_V2 kept in
 * the env to mark it as v2-capable), everything is v2 regardless of tags —
 * without this, resumeSuspendedTask's rollback guard would park every
 * suspended task the moment the canary tag list is removed.
 */
export function resolvesToV2Image(tags?: string[]): boolean {
  if (IMAGE_V2 && IMAGE_NAME === IMAGE_V2) return true
  const primaryTag = tags?.[0]
  return Boolean(IMAGE_V2 && primaryTag && V2_TAGS.includes(primaryTag))
}

// Runs `cmd` in a throwaway container with the agent-work volume mounted,
// waits for it to exit, and returns its combined stdout+stderr plus its exit
// code. Used for filesystem operations against the named volume, which the
// dashboard host process has no direct filesystem access to. Entrypoint is
// overridden (empty) so `cmd` runs directly instead of being passed to the
// agent's /entrypoint.sh, which requires env vars (TASK_ID, etc.) we don't
// want to satisfy here.
//
// Note: container.wait() only rejects on a Docker-API-level failure to
// create/start the container — it does NOT reject on a nonzero exit code
// from `cmd` itself. Callers MUST check the returned exitCode to detect a
// failed command.
async function runOneShot(cmd: string[]): Promise<{ output: string; exitCode: number }> {
  const container = await docker.createContainer({
    Image: IMAGE_NAME,
    Cmd: cmd,
    Entrypoint: [],
    HostConfig: { Binds: [`${WORK_VOLUME}:/agent-work`] },
  })
  try {
    await container.start()
    const waitResult = await container.wait()
    const buf = (await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    })) as unknown as Buffer
    return { output: demuxDockerLogs(buf), exitCode: waitResult.StatusCode }
  } finally {
    // Explicit removal (not AutoRemove) so logs() above can never race a
    // container that already vanished.
    await container.remove().catch(() => {})
  }
}

interface StartContainerOptions {
  taskId: string
  agentToken?: string
  prompt: string
  dashboardUrl: string
  context?: {
    ticketId?: string
    prNumber?: number
  }
  tags?: string[]
  maxDurationMs?: number
  resumeSessionId?: string
  resumePrompt?: string
}

// Unmeasurable disk (statfs throws) never blocks a dispatch — the guard is a
// safety net, not a gate.
async function assertFreeDisk(): Promise<void> {
  if (!MIN_FREE_DISK_GB || MIN_FREE_DISK_GB <= 0) return
  let freeGb: number
  try {
    const { bavail, bsize } = await statfs(DISK_CHECK_PATH)
    freeGb = (Number(bavail) * Number(bsize)) / 1024 ** 3
  } catch {
    return
  }
  if (freeGb < MIN_FREE_DISK_GB) {
    throw new Error(
      `Refusing to dispatch: only ${freeGb.toFixed(1)}GB free on ${DISK_CHECK_PATH}, ` +
        `need ${MIN_FREE_DISK_GB}GB. Reclaim space (docker builder prune -af) or lower ` +
        `AGENT_MIN_FREE_DISK_GB.`,
    )
  }
}

export async function startContainer(
  options: StartContainerOptions,
): Promise<string> {
  const { taskId, agentToken, prompt, dashboardUrl, context, tags, maxDurationMs, resumeSessionId, resumePrompt } = options

  // v2 canary image selection — reused below for both Image and the MODE env var.
  const primaryTag = tags?.[0]
  const image = resolvesToV2Image(tags) ? IMAGE_V2 : IMAGE_NAME

  // Validate default skill exists before launching container
  const skillPath = path.join(SKILLS_PATH, DEFAULT_SKILL, 'SKILL.md')
  if (!existsSync(skillPath)) {
    throw new Error(`Skill '${DEFAULT_SKILL}' not found at ${skillPath}. Set SKILLS_PATH env var if skills are in a different location.`)
  }

  await assertFreeDisk()

  // Take the host sleep assertion before any Docker work: waiting for the
  // reconciler's next tick (≤10s) can be too late if the host is about to
  // sleep. If the launch throws below, the reconciler's count-based sync
  // releases it.
  ensureAwake(`launching container for task ${taskId}`)

  const workspaceDir = `/agent-work/tasks/${taskId}`
  // Pre-create (and chown to the container's non-root agent user) before the
  // real container exists: (1) Docker refuses to start a container whose
  // WorkingDir doesn't already exist inside a mounted volume, and (2) even
  // once created, a non-agent-owned directory can't be written into by the
  // non-root agent user. rm -rf first guards a retry against stale content
  // from a prior crashed attempt on the same task_id.
  //
  // Resume path (resumeSessionId set): the workspace holds the clone,
  // uncommitted work, and claude-sessions/ transcript the suspended task
  // needs to pick back up — never wipe it. Only ensure it exists with correct
  // ownership. Fresh dispatches and reconciler retries (no resumeSessionId)
  // keep the destructive rm -rf: that wipe is deliberate retry hygiene.
  const prepCmd = resumeSessionId
    ? `mkdir -p "${workspaceDir}" && chown agent:agent "${workspaceDir}"`
    : `rm -rf "${workspaceDir}" && mkdir -p "${workspaceDir}" && chown agent:agent "${workspaceDir}"`
  const prep = await runOneShot(['sh', '-c', prepCmd])
  if (prep.exitCode !== 0) {
    throw new Error(
      `Failed to prepare workspace dir ${workspaceDir} (exit code ${prep.exitCode}): ${prep.output}`,
    )
  }

  const env = [
    `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN || ''}`,
    `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
    `LINEAR_API_KEY=${process.env.LINEAR_API_KEY || ''}`,
    `FIGMA_API_KEY=${process.env.FIGMA_API_KEY || ''}`,
    `TASK_ID=${taskId}`,
    `DASHBOARD_URL=${dashboardUrl}`,
    `REPO_URL=${REPO_URL}`,
    `AGENT_PROMPT=${prompt}`,
    // Comma-separated "marketplace:plugin" pairs installed at container startup
    `AGENT_PLUGINS=${process.env.AGENT_PLUGINS || ''}`,
    `AGENT_TOKEN=${agentToken || ''}`,
  ]

  // Pass primary tag as MODE for entrypoint logging (optional)
  if (primaryTag) env.push(`MODE=${primaryTag}`)

  // Pass context fields as individual env vars
  if (context?.ticketId) env.push(`TICKET_ID=${context.ticketId}`)
  if (context?.prNumber) env.push(`PR_NUMBER=${String(context.prNumber)}`)

  // v2 supervisor suspend/resume (optional; absent for all v1 dispatches)
  if (resumeSessionId) env.push(`RESUME_SESSION_ID=${resumeSessionId}`)
  if (resumePrompt) env.push(`RESUME_PROMPT=${resumePrompt}`)

  // Tunable without image rebuild; empty string when unset (entrypoint/supervisor default).
  env.push(`REPLY_GRACE_WINDOW_MS=${process.env.REPLY_GRACE_WINDOW_MS || ''}`)

  const container = await docker.createContainer({
    Image: image,
    Env: env,
    WorkingDir: workspaceDir,
    HostConfig: {
      // On macOS, containers reach the host via host.docker.internal
      ExtraHosts: ['host.docker.internal:host-gateway'],
      // Auto-remove when done
      AutoRemove: true,
      Memory: MEMORY_GB * 1024 * 1024 * 1024,
      // Mount ~/.claude/.claude.json for cloud MCP auth (Linear, etc.)
      // Mounted into the non-root `agent` user's home dir (see Dockerfile).
      Binds: [
        ...(REPO_PATH ? [`${REPO_PATH}:/repo-cache:ro`] : []),
        // Shared agent-work volume (named volume, auto-created on first use):
        // agent-work/store is the pnpm store (content-addressable, safe for
        // concurrent writers — first container pays the download, later ones
        // copy/hardlink from disk); agent-work/tasks/<task-id> is this
        // container's workspace — set directly as the container's WorkingDir
        // below. Both live on one volume so pnpm can hardlink instead of copy.
        // Ownership comes from the image's /agent-work mountpoint (see
        // docker/Dockerfile).
        `${WORK_VOLUME}:/agent-work`,
        ...(existsSync(`${homedir()}/.claude/.claude.json`)
          ? [`${homedir()}/.claude/.claude.json:/home/agent/.claude/.claude.json:ro`]
          : []),
        // Mount skills at runtime — updates take effect without Docker image rebuild
        `${SKILLS_PATH}:/opt/skills:ro`,
        // Mount CLAUDE.md for universal container rules
        ...(existsSync(path.resolve(process.cwd(), '..', 'docker', '.claude', 'CLAUDE.md'))
          ? [`${path.resolve(process.cwd(), '..', 'docker', '.claude', 'CLAUDE.md')}:/opt/claude-md/CLAUDE.md:ro`]
          : []),
      ],
    },
    Labels: {
      'agent-dashboard': 'true',
      'task-id': taskId,
      ...(maxDurationMs ? { 'agent.max_duration_ms': String(maxDurationMs) } : {}),
    },
  })

  await container.start()
  return container.id
}

export async function stopContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId)
  try {
    await container.stop({ t: 10 })
  } catch (err) {
    // Container may already be stopped
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes('is not running') && !message.includes('No such container')) {
      throw err
    }
  }
}

export async function getContainerStatus(
  containerId: string,
): Promise<'running' | 'exited' | 'not_found'> {
  try {
    const container = docker.getContainer(containerId)
    const info = await container.inspect()
    return info.State.Running ? 'running' : 'exited'
  } catch {
    return 'not_found'
  }
}

export interface ContainerDiagnostics {
  exitCode: number | null
  oomKilled: boolean
  error: string
  logsTail: string
}

// Best-effort capture of a stopped container's exit state and log tail.
// Returns null if the container has already been auto-removed (common under
// HostConfig.AutoRemove — the entrypoint's ERR trap is the primary fallback).
export async function captureContainerDiagnostics(
  containerId: string,
): Promise<ContainerDiagnostics | null> {
  try {
    const container = docker.getContainer(containerId)
    const info = await container.inspect()
    let logsTail = ''
    try {
      const buf = (await container.logs({
        stdout: true,
        stderr: true,
        tail: 200,
        follow: false,
      })) as unknown as Buffer
      logsTail = demuxDockerLogs(buf)
    } catch {
      // logs may be unavailable mid-remove
    }
    return {
      exitCode: info.State.ExitCode ?? null,
      oomKilled: !!info.State.OOMKilled,
      error: info.State.Error ?? '',
      logsTail,
    }
  } catch {
    return null
  }
}

// Non-TTY docker logs are multiplexed: each frame is an 8-byte header
// [stream(1), 0, 0, 0, size_be(4)] followed by `size` bytes of payload.
function demuxDockerLogs(buf: Buffer): string {
  let out = ''
  let i = 0
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4)
    i += 8
    const end = Math.min(i + size, buf.length)
    out += buf.subarray(i, end).toString('utf8')
    i = end
  }
  return out
}

export async function listAgentContainers(): Promise<Dockerode.ContainerInfo[]> {
  return docker.listContainers({
    all: true,
    filters: { label: ['agent-dashboard=true'] },
  })
}

/**
 * Running agent containers only — the signal the host sleep assertion is held
 * against (see sleep-assertion.ts). Deliberately asks Docker rather than
 * counting task rows: a container that died without updating its task still
 * has to release the host.
 */
export async function countRunningAgentContainers(): Promise<number> {
  const running = await docker.listContainers({
    filters: { label: ['agent-dashboard=true'], status: ['running'] },
  })
  return running.length
}

/**
 * Check whether the configured agent worker Docker image exists locally.
 * Uses a 30-second cache to avoid hitting the Docker daemon on every call.
 */
let _imageCheckCache: { ts: number; exists: boolean } | null = null
const IMAGE_CACHE_MS = 30_000

export async function checkImageExists(): Promise<boolean> {
  const now = Date.now()
  if (_imageCheckCache && now - _imageCheckCache.ts < IMAGE_CACHE_MS) {
    return _imageCheckCache.exists
  }
  let exists = false
  try {
    // Match against the image list rather than inspect-by-name: when Docker
    // Desktop's Resource Saver has the VM asleep, inspect-by-name 404s while
    // the image list is still served correctly from the backend's cache.
    const lastSlash = IMAGE_NAME.lastIndexOf('/')
    const wanted = IMAGE_NAME.indexOf(':', lastSlash + 1) === -1 ? `${IMAGE_NAME}:latest` : IMAGE_NAME
    const images = await docker.listImages()
    exists = images.some(img => (img.RepoTags ?? []).includes(wanted))
  } catch {
    // Docker unavailable
  }
  _imageCheckCache = { ts: now, exists }
  return exists
}

export function getImageName(): string {
  return IMAGE_NAME
}

// Removes stale /agent-work/tasks/<task-id> directories left behind by
// containers that were killed before their own cleanup() trap could run
// (SIGKILL, OOM, forced removal). `activeTaskIds` should be every task_id
// currently in an ACTIVE_STATUSES state (caller's responsibility — this
// function has no DB access). `graceMs` skips directories younger than that,
// to avoid a race against a retry that just created its directory a moment
// before this function's caller queried task state.
export async function pruneOrphanedTaskWorkspaces(
  activeTaskIds: string[],
  graceMs: number,
): Promise<void> {
  let listing: string
  try {
    const result = await runOneShot([
      'find', '/agent-work/tasks',
      '-mindepth', '1', '-maxdepth', '1', '-type', 'd',
      '-printf', '%f %T@\n',
    ])
    if (result.exitCode !== 0) {
      console.error(
        `[docker] pruneOrphanedTaskWorkspaces: list command exited ${result.exitCode}:`,
        result.output,
      )
      return
    }
    listing = result.output
  } catch (err) {
    console.error('[docker] pruneOrphanedTaskWorkspaces: list failed:', err)
    return
  }

  const activeSet = new Set(activeTaskIds)
  const now = Date.now()
  const staleDirs: string[] = []
  for (const line of listing.trim().split('\n')) {
    if (!line) continue
    const [name, mtimeStr] = line.split(' ')
    if (!name || !mtimeStr) continue
    if (activeSet.has(name)) continue
    const ageMs = now - Number(mtimeStr) * 1000
    if (Number.isFinite(ageMs) && ageMs > graceMs) staleDirs.push(name)
  }

  if (staleDirs.length === 0) return

  try {
    // Directory names here are task_ids (uuid v4, generated internally —
    // never user input), so straight interpolation into the shell command
    // is safe: no shell metacharacters are possible in a uuid. Quoted anyway
    // for consistency with the pre-creation step's quoted "${workspaceDir}".
    const result = await runOneShot([
      'sh', '-c',
      `rm -rf ${staleDirs.map((name) => `"/agent-work/tasks/${name}"`).join(' ')}`,
    ])
    if (result.exitCode !== 0) {
      console.error(
        `[docker] pruneOrphanedTaskWorkspaces: delete command exited ${result.exitCode} for dirs [${staleDirs.join(', ')}]:`,
        result.output,
      )
    }
  } catch (err) {
    console.error('[docker] pruneOrphanedTaskWorkspaces: delete failed:', err)
  }
}
