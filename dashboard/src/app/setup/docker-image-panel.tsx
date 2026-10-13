'use client'

import { useCallback, useRef, useState } from 'react'

// The agent-worker image build/pull controls. Shared between the setup wizard's
// Docker step and the Settings overview (so the image can be (re)built after
// initial setup is complete, not only during the first-run wizard).

export function DockerImagePanel({ onDone }: { onDone?: (success: boolean) => void }) {
  const [logs, setLogs] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState<{ success: boolean } | null>(null)
  const [errorBlock, setErrorBlock] = useState<{ code: string; message: string } | null>(null)
  const logBoxRef = useRef<HTMLPreElement>(null)

  const start = useCallback(async () => {
    setLogs('')
    setRunning(true)
    setDone(null)
    setErrorBlock(null)
    try {
      const res = await fetch('/api/setup/docker-build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'build' }),
      })
      if (!res.body) throw new Error('No response stream')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // SSE parser
      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const eventMatch = chunk.match(/^event: (\w+)/m)
          const dataMatch = chunk.match(/^data: (.+)$/m)
          if (!eventMatch || !dataMatch) continue
          const event = eventMatch[1]
          const data = JSON.parse(dataMatch[1])
          if (event === 'log') {
            setLogs(prev => prev + data.text)
            requestAnimationFrame(() => { if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight })
          } else if (event === 'done') {
            setDone({ success: data.success })
            onDone?.(data.success)
          } else if (event === 'error') {
            setErrorBlock({ code: data.code, message: data.message })
          }
        }
      }
    } catch (e) {
      setErrorBlock({ code: 'stream-error', message: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }, [onDone])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">Agent worker image</h2>
        <p className="text-[12px] text-[var(--text-muted)] mt-1">
          Containers need the <code className="font-mono bg-[var(--bg-badge)] px-1 rounded">agent-worker</code> Docker image. Build it locally from <code className="font-mono bg-[var(--bg-badge)] px-1 rounded">docker/Dockerfile</code> — no registry access needed. The first build takes a few minutes.
        </p>
      </div>
      <button
        onClick={start}
        disabled={running}
        className="px-3 py-1.5 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-[13px] font-medium"
      >
        {running ? 'Building…' : 'Build image'}
      </button>

      {errorBlock && (
        <div className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-[12px] text-red-400 space-y-1">
          <p className="font-semibold">{labelForCode(errorBlock.code)}</p>
          <p className="text-[11px]">{errorBlock.message}</p>
          {errorBlock.code === 'docker-not-installed' && (
            <p className="text-[11px]"><a className="underline" href="https://docs.docker.com/get-docker/" target="_blank" rel="noreferrer">Install Docker</a> and click below to retry.</p>
          )}
        </div>
      )}

      {(logs || running || done) && (
        <pre ref={logBoxRef} className="max-h-64 overflow-y-auto p-3 rounded-md bg-black text-emerald-300 text-[11px] font-mono whitespace-pre-wrap">{logs || (running ? 'Starting…' : '')}</pre>
      )}

      {done && (
        <p className={`text-[12px] ${done.success ? 'text-emerald-500' : 'text-red-400'}`}>
          {done.success ? '✓ Image ready.' : '✗ Failed. See log above.'}
        </p>
      )}
    </div>
  )
}

export function labelForCode(code: string): string {
  switch (code) {
    case 'docker-not-installed': return 'Docker is not installed'
    case 'spawn-failed':
    case 'spawn-error': return 'Could not start docker'
    case 'stream-error': return 'Connection error'
    default: return 'Error'
  }
}
