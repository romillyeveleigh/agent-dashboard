import { NextRequest } from 'next/server'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { getImageName } from '@/lib/docker'

export const dynamic = 'force-dynamic'

type Mode = 'pull' | 'build' | 'check'

export async function POST(req: NextRequest) {
  let body: { mode?: Mode; image?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const mode: Mode = body.mode || 'pull'
  const image = body.image || getImageName()

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      const repoRoot = path.resolve(process.cwd(), '..')

      let args: string[]
      if (mode === 'check') {
        args = ['image', 'inspect', image]
      } else if (mode === 'build') {
        // Tag the local build with the same name the dashboard inspects and runs
        // (IMAGE_NAME / AGENT_IMAGE). Tagging it 'agent-worker:local' instead would
        // leave checkImageExists() and container start looking for an image that
        // doesn't exist, so the banner would persist after a successful build.
        args = ['build', '--no-cache', '-t', image, '-f', 'docker/Dockerfile', '.']
      } else {
        args = ['pull', image]
      }

      let child
      try {
        child = spawn('docker', args, { cwd: repoRoot })
      } catch (e: unknown) {
        send('error', { code: 'spawn-failed', message: (e as Error).message })
        controller.close()
        return
      }

      child.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') {
          send('error', { code: 'docker-not-installed', message: 'docker not in PATH' })
        } else {
          send('error', { code: 'spawn-error', message: e.message })
        }
        try { controller.close() } catch {}
      })

      child.stdout.on('data', (chunk: Buffer) => {
        send('log', { stream: 'stdout', text: chunk.toString('utf8') })
      })
      child.stderr.on('data', (chunk: Buffer) => {
        send('log', { stream: 'stderr', text: chunk.toString('utf8') })
      })
      child.on('close', (code) => {
        send('done', { exitCode: code, success: code === 0 })
        try { controller.close() } catch {}
      })

      req.signal.addEventListener('abort', () => {
        try { child.kill('SIGTERM') } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
