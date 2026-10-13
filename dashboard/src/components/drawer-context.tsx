'use client'

import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import type { LinearTicket } from '@/lib/linear-data'
import type { PullRequest } from '@/lib/github'
import type { TaskSummary } from '@/lib/schema'

type DrawerTab = 'ticket' | 'plan' | 'prs' | 'tasks' | 'history'

type DrawerContent =
  | { type: 'ticket'; ticket: LinearTicket; linkedPrs: PullRequest[]; onImplement?: (ticket: LinearTicket) => void; task?: TaskSummary; defaultTab?: DrawerTab }
  | { type: 'pr'; pr: PullRequest; defaultTab?: DrawerTab; linkedTicket?: LinearTicket }
  | null

interface DrawerActions {
  openTicket: (ticket: LinearTicket, linkedPrs?: PullRequest[], onImplement?: (ticket: LinearTicket) => void, task?: TaskSummary, defaultTab?: DrawerTab) => void
  openPr: (pr: PullRequest, defaultTab?: DrawerTab, linkedTicket?: LinearTicket) => void
  close: () => void
}

// Actions and content live in separate contexts: the actions never change, so
// components that only open/close the drawer don't re-render when it opens.
const DrawerActionsContext = createContext<DrawerActions>({
  openTicket: () => {},
  openPr: () => {},
  close: () => {},
})
const DrawerContentContext = createContext<DrawerContent>(null)

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [content, setContent] = useState<DrawerContent>(null)
  const openTicket = useCallback((ticket: LinearTicket, linkedPrs: PullRequest[] = [], onImplement?: (ticket: LinearTicket) => void, task?: TaskSummary, defaultTab?: DrawerTab) => setContent({ type: 'ticket', ticket, linkedPrs, onImplement, task, defaultTab }), [])
  const openPr = useCallback((pr: PullRequest, defaultTab?: DrawerTab, linkedTicket?: LinearTicket) => setContent({ type: 'pr', pr, defaultTab, linkedTicket }), [])
  const close = useCallback(() => setContent(null), [])
  const actions = useMemo(() => ({ openTicket, openPr, close }), [openTicket, openPr, close])
  return (
    <DrawerActionsContext.Provider value={actions}>
      <DrawerContentContext.Provider value={content}>
        {children}
      </DrawerContentContext.Provider>
    </DrawerActionsContext.Provider>
  )
}

export function useDrawer() {
  return useContext(DrawerActionsContext)
}

export function useDrawerContent() {
  return useContext(DrawerContentContext)
}
