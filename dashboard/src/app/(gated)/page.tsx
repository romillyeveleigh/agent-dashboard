'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ContextData, SourceState, GitHubResponse, LinearResponse } from '@/lib/context-types'
import { DashboardBriefing, fetchDashboardCache } from '@/components/dashboard-briefing'
import { useTasks, useSSE } from '@/lib/hooks'
import { buildActiveTaskMap } from '@/lib/dispatch'

const IDLE: SourceState<never> = { data: null, status: 'idle', error: null }
const LOADING: SourceState<never> = { data: null, status: 'loading', error: null }

function fetchSource<T>(
  url: string,
  label: string,
  setState: (s: SourceState<T>) => void,
  signal: AbortSignal,
  version: number,
  versionRef: React.RefObject<number>,
): Promise<void> {
  return fetch(url, { signal })
    .then(async res => {
      if (signal.aborted || version !== versionRef.current) return
      if (res.ok) {
        setState({ data: await res.json(), status: 'success', error: null })
      } else {
        setState({ data: null, status: 'error', error: `${label}: ${res.status}` })
      }
    })
    .catch(err => {
      if (signal.aborted || version !== versionRef.current) return
      setState({ data: null, status: 'error', error: err.message })
    })
}

// Survive client-side navigation: returning to Home renders the last context
// immediately and skips re-checking the briefing cache
let lastContext: ContextData | null = null
let knownCachedBriefing: boolean | null = null

export default function HomePage() {
  const [github, setGithub] = useState<SourceState<GitHubResponse>>(IDLE)
  const [linear, setLinear] = useState<SourceState<LinearResponse>>(IDLE)
  const [context, setContextState] = useState<ContextData | null>(lastContext)
  const [hasCachedBriefing, setHasCachedBriefing] = useState<boolean | null>(knownCachedBriefing)
  const setContext = useCallback((next: ContextData) => {
    lastContext = next
    setContextState(next)
  }, [])
  const { tasks } = useTasks()
  const activeTaskMap = useMemo(() => buildActiveTaskMap(tasks), [tasks])

  const versionRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // Check if dashboard cache has enriched data on mount (once per session)
  useEffect(() => {
    if (knownCachedBriefing !== null) return
    fetchDashboardCache()
      .then(({ data }) => { knownCachedBriefing = !!data; setHasCachedBriefing(!!data) })
      .catch(() => setHasCachedBriefing(false))
  }, [])

  const fetchGranularAndAssemble = useCallback(async (version: number, signal: AbortSignal): Promise<string | null> => {
    await Promise.allSettled([
      fetchSource('/api/context/github', 'GitHub', setGithub, signal, version, versionRef),
      fetchSource('/api/context/linear', 'Linear', setLinear, signal, version, versionRef),
    ])

    if (signal.aborted || version !== versionRef.current) return null

    // Fire full context (assembly + cross-reference) for LLM
    try {
      const res = await fetch('/api/context', { signal })
      if (signal.aborted || version !== versionRef.current) return null
      if (res.ok) {
        const json = await res.json()
        setContext(json)
        return JSON.stringify(json)
      }
    } catch {
      // full context fetch failed — raw cards are already displayed
    }
    return null
  }, [])

  // Mount flow
  useEffect(() => {
    if (hasCachedBriefing === null) return // still checking cache

    const version = ++versionRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    if (hasCachedBriefing) {
      // Has cached enriched data — skip progressive rendering. The cached
      // context comes back immediately; ?revalidate=1 refreshes the sources
      // server-side in the background, and context:updated (handled below)
      // swaps in anything newer.
      fetch('/api/context?revalidate=1', { signal: controller.signal })
        .then(async res => {
          if (controller.signal.aborted || version !== versionRef.current) return
          if (res.ok) setContext(await res.json())
        })
        .catch(() => {})
    } else {
      // No cache — progressive rendering
      setGithub(LOADING)
      setLinear(LOADING)
      fetchGranularAndAssemble(version, controller.signal)
    }

    return () => controller.abort()
  }, [hasCachedBriefing, fetchGranularAndAssemble])

  // Refresh flow
  const refreshData = useCallback(async (): Promise<string | null> => {
    const version = ++versionRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // Source skeletons drive the phase stepper; the old context stays on
    // screen so drawer clicks keep working during the refresh
    setGithub(LOADING)
    setLinear(LOADING)

    // Re-fetch all sources server-side; resolves once the caches are fresh
    await fetch('/api/context', { method: 'POST', signal: controller.signal }).catch(() => {})

    // Progressive fetch — populates context via setContext
    return await fetchGranularAndAssemble(version, controller.signal)
  }, [fetchGranularAndAssemble])

  // Silent refetch — used by SSE-driven updates. Caches are warm
  // server-side (the emitter just refreshed them), so this is fast.
  const silentRefetch = useCallback(async () => {
    const version = ++versionRef.current
    try {
      const res = await fetch('/api/context')
      if (version !== versionRef.current) return
      if (res.ok) setContext(await res.json())
    } catch {
      // next event or manual refresh will retry
    }
  }, [])

  useSSE({
    'context:updated': () => { silentRefetch() },
  })

  // fetchedAt changes on every fetch; leaving it out keeps the string stable
  // when nothing changed, so the briefing doesn't re-run generate()
  const contextJson = useMemo(() => {
    if (!context) return null
    const { fetchedAt: _fetchedAt, ...rest } = context
    return JSON.stringify(rest)
  }, [context])
  const allPrs = useMemo(() => [
    ...(context?.myPRs ?? []),
    ...(context?.reviewRequests ?? []),
    ...(context?.recentlyMerged ?? []),
  ], [context])
  const allTickets = useMemo(() => [
    ...(context?.tickets ?? []),
    ...(context?.unassignedTickets ?? []),
    ...(context?.completedTickets ?? []),
  ], [context])

  return (
    <div className="h-full max-w-5xl mx-auto">
      <DashboardBriefing
        context={contextJson}
        githubState={github}
        linearState={linear}
        tickets={allTickets}
        prs={allPrs}
        activeTaskMap={activeTaskMap}
        onRefresh={refreshData}
      />
    </div>
  )
}
