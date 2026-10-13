// Resilient fetch wrapper with retry and timeout.
// Used by github.ts and linear-data.ts for external API calls.

interface ResilientFetchOptions extends RequestInit {
  retries?: number      // default: 2
  backoffMs?: number    // initial backoff, doubles each retry. default: 1000
  timeoutMs?: number    // per-attempt timeout covering headers AND body. default: 10000
}

export async function resilientFetch(
  url: string,
  options: ResilientFetchOptions = {},
): Promise<Response> {
  const { retries = 2, backoffMs = 1000, timeoutMs = 10000, ...fetchOptions } = options
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      let response: Response
      try {
        response = await fetch(url, {
          ...fetchOptions,
          signal: controller.signal,
        })

        // Buffer the body while the abort timer is still armed. fetch()
        // resolves on headers; a response body whose stream stalls would
        // otherwise hang the caller's .json()/.text() with no timeout and can
        // permanently stall a reconciler loop.
        const body = await response.arrayBuffer()
        // Response() throws if a body is passed with a null-body status.
        const nullBody = response.status === 204 || response.status === 205 || response.status === 304
        response = new Response(nullBody ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } finally {
        clearTimeout(timeout)
      }

      // Don't retry on client errors (4xx) — only server errors (5xx)
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response
      }

      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Don't retry on abort (timeout) if this was the last attempt
      if (lastError.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${timeoutMs}ms`)
      }
    }

    // Wait before retrying (exponential backoff)
    if (attempt < retries) {
      const delay = backoffMs * Math.pow(2, attempt)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw lastError || new Error('Request failed after retries')
}
