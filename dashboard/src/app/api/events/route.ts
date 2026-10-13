import { addListener } from '@/lib/events'
import { setupIncompleteResponse } from '@/lib/setup'

// GET /api/events — SSE stream for live dashboard updates
export async function GET(request: Request) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      // Send initial keepalive
      controller.enqueue(encoder.encode(': connected\n\n'))

      const remove = addListener((event, data) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
          )
        } catch {
          // Stream already closed — cleanup handled by abort signal
        }
      })

      // Keepalive every 30s to prevent connection timeout
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch {
          // Stream already closed — cleanup handled by abort signal
        }
      }, 30_000)

      // Clean up when client disconnects
      request.signal.addEventListener('abort', () => {
        remove()
        clearInterval(keepalive)
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
