'use client'

import { useCallback, useState } from 'react'
import { useCelebration } from '@/components/launch-celebration'

export type DispatchContext = {
  ticketId?: string
  prNumber?: number
}

export type DispatchInput = {
  prompt: string
  tags?: string[]
  context?: DispatchContext
}

export type DispatchResult =
  | { ok: true; id: string }
  | { ok: false; error: string }

/**
 * Single source of truth for the POST /api/tasks flow: request body shape,
 * success celebration, and error normalisation. Navigation and UI reactions
 * (router.push, per-chip error toast, etc.) stay with the caller, since they
 * vary across dispatch surfaces.
 */
export function useDispatchTask() {
  const { celebrate } = useCelebration()
  const [dispatching, setDispatching] = useState(false)

  const dispatch = useCallback(async (input: DispatchInput): Promise<DispatchResult> => {
    setDispatching(true)
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        let error = 'Failed to create task'
        try {
          const data = await res.json()
          if (typeof data?.error === 'string') error = data.error
        } catch {
          // non-JSON body (e.g. 5xx HTML) — keep default message
        }
        return { ok: false, error }
      }
      const { id } = await res.json()
      celebrate()
      return { ok: true, id }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
    } finally {
      setDispatching(false)
    }
  }, [celebrate])

  return { dispatch, dispatching }
}
