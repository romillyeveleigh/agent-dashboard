'use client'

import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react'
import type { TaskSummary, Message, Diff, Log } from './schema'

// Shared EventSource singleton — avoids hitting browser connection limits
// Never closed while the page is open; reconnects automatically on error
let sharedEventSource: EventSource | null = null

function getSharedEventSource(): EventSource {
  if (!sharedEventSource || sharedEventSource.readyState === EventSource.CLOSED) {
    sharedEventSource = new EventSource('/api/events')
  }
  return sharedEventSource
}

export function useSSE(
  eventHandlers: Record<string, (e: MessageEvent) => void>,
) {
  const handlersRef = useRef(eventHandlers)
  handlersRef.current = eventHandlers

  const eventKey = Object.keys(eventHandlers).sort().join(',')

  useEffect(() => {
    const es = getSharedEventSource()
    const wrappers: Record<string, (e: MessageEvent) => void> = {}

    for (const event of Object.keys(handlersRef.current)) {
      const wrapper = (e: MessageEvent) => handlersRef.current[event]?.(e)
      wrappers[event] = wrapper
      es.addEventListener(event, wrapper as EventListener)
    }

    return () => {
      for (const [event, wrapper] of Object.entries(wrappers)) {
        es.removeEventListener(event, wrapper as EventListener)
      }
    }
  }, [eventKey])
}

// Shared task store — one fetch serves every mounted useTasks(), and event
// bursts coalesce into a single refetch.
let taskStore: TaskSummary[] = []
let taskStoreLoaded = false
let taskFetchInFlight: Promise<void> | null = null
let taskRefreshTimer: ReturnType<typeof setTimeout> | null = null
const taskSubscribers = new Set<() => void>()

function notifyTaskSubscribers() {
  for (const fn of taskSubscribers) fn()
}

// Keep unchanged tasks (and the array, if nothing changed) identical across
// refetches, so memoized consumers skip re-rendering on unrelated events
function reuseUnchanged(prev: TaskSummary[], next: TaskSummary[]): TaskSummary[] {
  const prevById = new Map(prev.map(t => [t.id, t]))
  const merged = next.map(t => {
    const old = prevById.get(t.id)
    return old && JSON.stringify(old) === JSON.stringify(t) ? old : t
  })
  return merged.length === prev.length && merged.every((t, i) => t === prev[i]) ? prev : merged
}

async function fetchTasksNow(): Promise<void> {
  if (taskFetchInFlight) return taskFetchInFlight
  taskFetchInFlight = (async () => {
    try {
      const res = await fetch('/api/tasks')
      if (res.ok) {
        taskStore = reuseUnchanged(taskStore, await res.json())
        taskStoreLoaded = true
        notifyTaskSubscribers()
      }
    } finally {
      taskFetchInFlight = null
    }
  })()
  return taskFetchInFlight
}

// Coalesce bursts of SSE events into one fetch per 300ms window
function scheduleTaskRefresh() {
  if (taskRefreshTimer) return
  taskRefreshTimer = setTimeout(() => {
    taskRefreshTimer = null
    fetchTasksNow()
  }, 300)
}

const TASK_REFRESH_EVENTS = {
  'task:created': () => scheduleTaskRefresh(),
  'task:status': () => scheduleTaskRefresh(),
  'message:new': () => scheduleTaskRefresh(),
  'message:answer': () => scheduleTaskRefresh(),
  'diff:new': () => scheduleTaskRefresh(),
}

// Fetch tasks and keep them updated via SSE
export function useTasks() {
  const [tasks, setTasks] = useState<TaskSummary[]>(taskStore)
  const [loading, setLoading] = useState(!taskStoreLoaded)

  useEffect(() => {
    const update = () => { setTasks(taskStore); setLoading(false) }
    taskSubscribers.add(update)
    if (!taskStoreLoaded) fetchTasksNow()
    else update()
    return () => { taskSubscribers.delete(update) }
  }, [])

  useSSE(TASK_REFRESH_EVENTS)

  return { tasks, loading, refresh: fetchTasksNow }
}

export const refreshTasks = fetchTasksNow

function subscribeTasks(onChange: () => void) {
  taskSubscribers.add(onChange)
  if (!taskStoreLoaded) fetchTasksNow()
  return () => { taskSubscribers.delete(onChange) }
}

// Subscribe to one value derived from the task store — re-renders only when
// that value's identity changes, not on every task-list refetch
export function useTaskSelector<T>(select: (tasks: TaskSummary[]) => T): T {
  const value = useSyncExternalStore(subscribeTasks, () => select(taskStore), () => select([]))
  useSSE(TASK_REFRESH_EVENTS)
  return value
}

// Debounce a refresh callback so SSE event bursts trigger one fetch
export function useDebouncedRefresh(refresh: () => void, delayMs = 300) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  return useCallback(() => {
    if (timerRef.current) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      refresh()
    }, delayMs)
  }, [refresh, delayMs])
}

// Last-seen thread per task, kept across unmounts so reopening a drawer or task
// page renders it at once while the refetch runs
const messageCache = new Map<string, Message[]>()

// Fetch messages for a specific task
export function useMessages(taskId: string) {
  const [messages, setMessagesState] = useState<Message[]>(() => messageCache.get(taskId) ?? [])
  const [loaded, setLoaded] = useState(() => messageCache.has(taskId))

  const setMessages = useCallback((update: Message[] | ((prev: Message[]) => Message[])) => {
    setMessagesState(prev => {
      const next = typeof update === 'function' ? update(prev) : update
      messageCache.set(taskId, next)
      return next
    })
  }, [taskId])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`)
      if (res.ok) {
        setMessages(await res.json())
      }
    } finally {
      setLoaded(true)
    }
  }, [taskId, setMessages])

  const debouncedRefresh = useDebouncedRefresh(refresh)

  useEffect(() => {
    setMessagesState(messageCache.get(taskId) ?? [])
    setLoaded(messageCache.has(taskId))
    refresh()
  }, [taskId, refresh])

  useSSE({
    'message:new': (e) => {
      const data = JSON.parse(e.data) as { id: string; taskId: string; text: string; type?: string | null; answered?: boolean }
      if (data.taskId !== taskId) return
      // The event carries the full message — render it immediately,
      // then reconcile with the server copy. `answered` distinguishes
      // fire-and-forget notes (already answered) from pending questions —
      // a note must never flash an answer input while the refresh is in flight.
      setMessages(prev =>
        prev.some(m => m.id === data.id)
          ? prev
          : [...prev, {
              id: data.id,
              taskId: data.taskId,
              direction: 'agent_to_human',
              content: data.text,
              type: data.type ?? null,
              answered: data.answered ?? false,
              createdAt: new Date(),
            } as Message],
      )
      debouncedRefresh()
    },
    'message:answer': (e) => {
      const data = JSON.parse(e.data)
      if (data.taskId === taskId) debouncedRefresh()
    },
  })

  return { messages, loaded, refresh }
}

// Fetch diffs for a specific task
export function useDiffs(taskId: string) {
  const [diffs, setDiffs] = useState<Diff[]>([])

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/tasks/${taskId}/diffs`)
    if (res.ok) {
      setDiffs(await res.json())
    }
  }, [taskId])

  const debouncedRefresh = useDebouncedRefresh(refresh)

  useEffect(() => { refresh() }, [taskId, refresh])

  useSSE({
    'diff:new': (e) => {
      const data = JSON.parse(e.data)
      if (data.taskId === taskId) debouncedRefresh()
    },
  })

  return { diffs }
}

const LOG_WINDOW = 200

// Fetch logs for a specific task; SSE events append only the new entries
export function useLogs(taskId: string) {
  const [logs, setLogs] = useState<Log[]>([])
  const [loaded, setLoaded] = useState(false)
  const lastIdRef = useRef(0)
  const taskIdRef = useRef(taskId)
  taskIdRef.current = taskId

  const applyLogs = useCallback((update: (prev: Log[]) => Log[]) => {
    setLogs(prev => {
      const next = update(prev)
      lastIdRef.current = next.at(-1)?.id ?? 0
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/logs`)
      if (res.ok && taskIdRef.current === taskId) {
        const rows: Log[] = await res.json()
        applyLogs(() => rows)
      }
    } finally {
      setLoaded(true)
    }
  }, [taskId, applyLogs])

  const fetchNew = useCallback(async () => {
    if (!lastIdRef.current) return refresh()
    const res = await fetch(`/api/tasks/${taskId}/logs?after=${lastIdRef.current}`)
    if (!res.ok || taskIdRef.current !== taskId) return
    const rows: Log[] = await res.json()
    if (!rows.length) return
    applyLogs(prev => {
      const lastId = prev.at(-1)?.id ?? 0
      return [...prev, ...rows.filter(r => r.id > lastId)].slice(-LOG_WINDOW)
    })
  }, [taskId, refresh, applyLogs])

  const debouncedFetchNew = useDebouncedRefresh(fetchNew)

  useEffect(() => { refresh() }, [taskId, refresh])

  useSSE({
    'log:new': (e) => {
      const data = JSON.parse(e.data)
      if (data.taskId === taskId) debouncedFetchNew()
    },
  })

  return { logs, loaded, refresh }
}
