'use client'

import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useDrawer } from '@/components/drawer-context'
import { useDispatchTask } from '@/lib/use-dispatch-task'
import type { LinearTicket } from '@/lib/linear-data'
import type { PullRequest, CategorisedPRs } from '@/lib/github'
import type { TaskSummary } from '@/lib/schema'
import type { DashboardData, WorkItem, ReviewItem, PrSubItem } from '@/lib/dashboard-types'
import type { SourceState, GitHubResponse, LinearResponse } from '@/lib/context-types'
import { DRAWER_PRESETS } from '@/lib/quick-actions'
import { useTicketPrefs, applyTicketOrder, linearTicketSortKeys, workItemSortKeys, TICKET_SORT_OPTIONS, type TicketSort } from '@/lib/ticket-prefs'
import { ManualStepsModal } from '@/components/manual-steps-modal'
import { ServiceIcon } from '@/components/service-icon'
import { ThroughputTile } from '@/components/throughput-tile'
import { WatchToggle } from '@/components/watch-toggle'
import { ExternalLink } from '@/components/external-link'
import { ActionRow, ACTION_ROW_LIST } from '@/components/action-row'
import { fetchTicketCached } from '@/lib/ticket-cache'
import { rememberEditorialTitles } from '@/lib/editorial-titles'

function prUrlFor(number: number, url?: string | null): string {
  if (url) return url
  const repo = process.env.NEXT_PUBLIC_REPO_URL || 'unknown/repo'
  return `https://github.com/${repo}/pull/${number}`
}

function PrLink({ number, url, className, iconSize = 13 }: {
  number: number
  url?: string | null
  className?: string
  iconSize?: number
}) {
  const href = prUrlFor(number, url)
  return (
    <ExternalLink
      href={href}
      onClick={e => e.stopPropagation()}
      className={className}
    >
      <ServiceIcon service="github" size={iconSize} />{number}
    </ExternalLink>
  )
}

function VerifyButton({ context, onOpen }: { context: string | null; onOpen: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (context) onOpen() }}
      disabled={!context}
      className={context ? 'cursor-pointer hover:underline hover:text-[var(--text)]' : 'opacity-50'}
    >
      ☑ Manual steps
    </button>
  )
}

// Home cards are soft white tiles, one per row
const CARD = 'group/card relative flex flex-col rounded-2xl bg-[var(--bg-card)] cursor-pointer transition-shadow hover:ring-1 hover:ring-[var(--border)]'
const CARD_LIST = 'flex flex-col gap-3'

// Fallback when the client-side context hasn't loaded yet (page just
// mounted or mid-refresh): fetch it on demand so clicks are never dead.
// /api/context serves from the server's cache.
async function fetchContextForClick(): Promise<{ tickets: LinearTicket[]; prs: PullRequest[] } | null> {
  try {
    const res = await fetch('/api/context')
    if (!res.ok) return null
    const ctx = await res.json()
    return {
      tickets: [...(ctx.tickets ?? []), ...(ctx.unassignedTickets ?? []), ...(ctx.completedTickets ?? [])],
      prs: [...(ctx.myPRs ?? []), ...(ctx.reviewRequests ?? []), ...(ctx.recentlyMerged ?? [])],
    }
  } catch {
    return null
  }
}

// One request serves both the page's "is there a cached briefing?" check and
// the briefing's initial data (both ask on the same mount)
let dashboardCacheRequest: Promise<{ data: DashboardData | null; updatedAt?: string }> | null = null
export function fetchDashboardCache() {
  dashboardCacheRequest ??= fetch('/api/dashboard-cache')
    .then(res => res.json())
    .finally(() => setTimeout(() => { dashboardCacheRequest = null }, 0))
  return dashboardCacheRequest
}

// Survives client-side navigation, so returning to Home renders the last
// briefing immediately instead of an empty page
let lastBriefing: { data: DashboardData; updatedAt: number | null } | null = null

export function DashboardBriefing({ context, githubState, linearState, tickets, prs, activeTaskMap, onRefresh }: {
  context: string | null
  githubState: SourceState<GitHubResponse>
  linearState: SourceState<LinearResponse>
  tickets?: LinearTicket[]
  prs?: PullRequest[]
  activeTaskMap: Map<string, TaskSummary>
  onRefresh?: () => Promise<string | null>
}) {
  const { openTicket, openPr } = useDrawer()
  const { pinned, togglePin, sort, changeSort, hideUnlinked, toggleHideUnlinked } = useTicketPrefs()
  const [data, setData] = useState<DashboardData | null>(lastBriefing?.data ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(lastBriefing?.updatedAt ?? null)
  // Manual Refresh drives its own generate() and shows the stepper; background
  // regenerations (context:updated, page load) update the cards in place
  const [manualRefresh, setManualRefresh] = useState(false)
  const manualRefreshRef = useRef(false)

  useEffect(() => {
    if (data) lastBriefing = { data, updatedAt: lastUpdated }
  }, [data, lastUpdated])

  useEffect(() => {
    if (data) rememberEditorialTitles(data)
  }, [data])

  // Load cached data on mount
  useEffect(() => {
    fetchDashboardCache()
      .then(({ data: cached, updatedAt }) => {
        if (cached) setData(cached)
        if (updatedAt) setLastUpdated(new Date(updatedAt).getTime())
      })
      .catch(() => {})
  }, [])

  // Ask the server to (re)generate. The server assembles context itself; the
  // client only signals "context likely changed" / "force".
  const generate = useCallback(async (force?: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/dashboard-briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      })
      if (!res.ok) throw new Error('Failed to generate dashboard')
      const result = await res.json()
      if (result.data) {
        setData(result.data)
        setLastUpdated(Date.now())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (context && !manualRefreshRef.current) generate()
  }, [context, generate])

  // Stable handlers so the memoized cards below only re-render for their own changes
  const handleTicketClick = useCallback(async (id: string) => {
    let ticketList = tickets ?? []
    let prList = prs ?? []
    if (!ticketList.some(t => t.identifier === id)) {
      const fetched = await fetchContextForClick()
      if (!fetched) return
      ticketList = fetched.tickets
      prList = fetched.prs
    }
    const ticket = ticketList.find(t => t.identifier === id)
    if (!ticket) return
    const linkedPrs = prList.filter(p => ticket.linkedPrNumbers.includes(p.number))
    openTicket(ticket, linkedPrs)
  }, [tickets, prs, openTicket])

  const handleTicketStatusClick = useCallback(async (id: string) => {
    let ticketList = tickets ?? []
    let prList = prs ?? []
    if (!ticketList.some(t => t.identifier === id)) {
      const fetched = await fetchContextForClick()
      if (!fetched) return
      ticketList = fetched.tickets
      prList = fetched.prs
    }
    const ticket = ticketList.find(t => t.identifier === id)
    if (!ticket) return
    const linkedPrs = prList.filter(p => ticket.linkedPrNumbers.includes(p.number))
    openTicket(ticket, linkedPrs, undefined, undefined, 'tasks')
  }, [tickets, prs, openTicket])

  // Hands the drawer the PR's linked ticket from the loaded context, so it
  // doesn't wait on a Linear round-trip to show it
  const openPrWithTicket = useCallback(async (number: number, defaultTab?: 'tasks') => {
    let prList = prs ?? []
    let ticketList = tickets ?? []
    if (!prList.some(p => p.number === number)) {
      const fetched = await fetchContextForClick()
      if (!fetched) return
      prList = fetched.prs
      ticketList = fetched.tickets
    }
    const pr = prList.find(p => p.number === number)
    if (!pr) return
    const linkedTicket = pr.linkedTicketId ? ticketList.find(t => t.identifier === pr.linkedTicketId) : undefined
    openPr(pr, defaultTab, linkedTicket)
  }, [prs, tickets, openPr])

  const handlePrStatusClick = useCallback((number: number) => openPrWithTicket(number, 'tasks'), [openPrWithTicket])
  const handlePrClick = useCallback((number: number) => openPrWithTicket(number), [openPrWithTicket])

  // Phase tracking
  const anySourceLoading = githubState.status === 'loading' || linearState.status === 'loading'
  const sourcesSettled = !anySourceLoading && (githubState.status !== 'idle' || linearState.status !== 'idle')
  const awaitingEnrichment = !data && sourcesSettled && !loading && !context
  const enriching = !data && (loading || (!loading && sourcesSettled && !!context))
  const visibleLoading = loading && (!data || manualRefresh)
  const isRefreshing = anySourceLoading || awaitingEnrichment || enriching || visibleLoading

  // Phase states: 'idle' | 'active' | 'done'
  const sourcesPhase = anySourceLoading ? 'active' : sourcesSettled || data ? 'done' : 'idle'
  const briefingPhase = (awaitingEnrichment || visibleLoading || enriching) ? 'active' : data ? 'done' : 'idle'

  // No force: the server re-runs the LLM only for items whose editorial hash
  // changed. The context effect stands down meanwhile so this is the only generate.
  const handleRefresh = async () => {
    manualRefreshRef.current = true
    setManualRefresh(true)
    try {
      if (onRefresh) await onRefresh()
      await generate()
    } finally {
      manualRefreshRef.current = false
      setManualRefresh(false)
    }
  }

  return (
    <div className="px-4 pt-2 pb-8">
      <div className="flex items-start justify-between gap-4 mb-8 px-1">
        <div className="min-w-0">
          <Greeting />
          <ThroughputTile />
        </div>
        {!isRefreshing && (
          <div className="shrink-0 flex items-center gap-2.5">
            {lastUpdated && <LastUpdated at={lastUpdated} />}
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] bg-[var(--bg-card)] rounded-lg px-3 py-1.5 transition-colors"
            >
              <RefreshIcon spinning={false} />
              <span>Refresh</span>
            </button>
          </div>
        )}
      </div>
      {isRefreshing && (
        <PhaseStepper
          sourcesPhase={sourcesPhase}
          briefingPhase={briefingPhase}
        />
      )}
      {error && (
        <p className="text-[12px] text-[var(--error)] py-2">
          {error}
          <button
            onClick={() => generate(true)}
            className="ml-2 text-[var(--accent)] hover:underline"
          >
            Retry
          </button>
        </p>
      )}
      {data ? (
        <div className="space-y-10 text-[13px] leading-relaxed">
          <WorkSection items={data.workItems} tickets={tickets ?? []} pinned={pinned} onTogglePin={togglePin} sort={sort} onSortChange={changeSort} hideUnlinked={hideUnlinked} onToggleHideUnlinked={toggleHideUnlinked} activeTaskMap={activeTaskMap} onTicketClick={handleTicketClick} onPrClick={handlePrClick} onTicketStatusClick={handleTicketStatusClick} onPrStatusClick={handlePrStatusClick} context={context} />
          <ReviewSection items={data.reviewRequests} activeTaskMap={activeTaskMap} onPrClick={handlePrClick} onPrStatusClick={handlePrStatusClick} context={context} />
        </div>
      ) : (
        <div className="space-y-10 text-[13px] leading-relaxed">
          <RawWorkSection githubState={githubState} linearState={linearState} pinned={pinned} onTogglePin={togglePin} sort={sort} onSortChange={changeSort} hideUnlinked={hideUnlinked} onToggleHideUnlinked={toggleHideUnlinked} onTicketClick={handleTicketClick} onPrClick={handlePrClick} />
          <RawReviewSection githubState={githubState} onPrClick={handlePrClick} />
        </div>
      )}
    </div>
  )
}

// --- Greeting ---

function Greeting() {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    const h = new Date().getHours()
    const period = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
    let cancelled = false
    fetch('/api/user')
      .then(r => r.ok ? r.json() : { name: null, login: null })
      .catch(() => ({ name: null, login: null }))
      .then(({ name, login }: { name: string | null; login: string | null }) => {
        if (cancelled) return
        const first = (name || login || '').trim().split(/\s+/)[0] || ''
        setText(`Good ${period}${first ? `, ${first}` : ''}`)
      })
    return () => { cancelled = true }
  }, [])
  if (!text) return <h1 className="text-[22px] font-semibold tracking-tight min-h-[32px]">&nbsp;</h1>
  return <h1 className="text-[22px] font-semibold tracking-tight">{text}</h1>
}

// --- Phase stepper ---

type PhaseState = 'idle' | 'active' | 'done'

const PHASES: { key: string; label: string }[] = [
  { key: 'sources', label: 'Fetching PRs & tickets' },
  { key: 'briefing', label: 'Writing summaries' },
]

function formatRelativeTime(at: number): string {
  const diff = Math.max(0, Date.now() - at)
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function LastUpdated({ at }: { at: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000)
    return () => clearInterval(id)
  }, [])
  return (
    <span
      className="text-[12px] text-[var(--text-muted)] whitespace-nowrap"
      title={`Last refreshed ${new Date(at).toLocaleString()}`}
    >
      Updated {formatRelativeTime(at)}
    </span>
  )
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" fill="none"
      className={spinning ? 'phase-spin' : ''}
      style={{ display: 'block' }}
    >
      <path
        d="M13.65 2.35A7.96 7.96 0 0 0 8 0a8 8 0 1 0 7.75 6h-2.1A5.98 5.98 0 0 1 8 14 6 6 0 1 1 8 2c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35Z"
        fill="currentColor"
      />
    </svg>
  )
}

function PhaseDot({ state }: { state: PhaseState }) {
  if (state === 'done') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
        <circle cx="6" cy="6" r="5" fill="var(--success)" opacity="0.15" />
        <path d="M3.5 6.2L5.2 7.8L8.5 4.2" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    )
  }
  if (state === 'active') {
    return (
      <span
        className="phase-dot-active inline-block w-[8px] h-[8px] rounded-full bg-[var(--accent)] shrink-0"
      />
    )
  }
  return (
    <span className="inline-block w-[8px] h-[8px] rounded-full border border-[var(--border)] shrink-0" />
  )
}

function PhaseStepper({ sourcesPhase, briefingPhase }: {
  sourcesPhase: PhaseState
  briefingPhase: PhaseState
}) {
  const phases: PhaseState[] = [sourcesPhase, briefingPhase]
  const doneCount = phases.filter(p => p === 'done').length
  const activeIndex = phases.findIndex(p => p === 'active')
  const progressFraction = (doneCount + (activeIndex >= 0 ? 0.4 : 0)) / 2

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center gap-4 flex-1 min-w-0">
          {PHASES.map((phase, i) => {
            const state = phases[i]
            return (
              <div key={phase.key} className="flex items-center gap-1.5">
                <PhaseDot state={state} />
                <span
                  className={`text-[12px] font-mono whitespace-nowrap transition-colors ${
                    state === 'active'
                      ? 'text-[var(--accent)]'
                      : state === 'done'
                      ? 'text-[var(--text-muted)]'
                      : 'text-[var(--border)]'
                  }`}
                >
                  {phase.label}
                </span>
                {i < PHASES.length - 1 && (
                  <span className={`text-[10px] ml-1 ${
                    phases[i + 1] !== 'idle' ? 'text-[var(--text-muted)]' : 'text-[var(--border)]'
                  }`}>›</span>
                )}
              </div>
            )
          })}
        </div>
        <button
          disabled
          className="flex items-center gap-1.5 text-[12px] font-mono text-[var(--accent)] border border-[var(--accent)] rounded-md px-2.5 py-1 opacity-70 cursor-not-allowed"
        >
          <RefreshIcon spinning />
          <span>Refresh</span>
        </button>
      </div>
      <div className="h-[3px] bg-[var(--border-subtle)] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full phase-bar-shimmer transition-all duration-700 ease-out"
          style={{
            width: `${Math.round(progressFraction * 100)}%`,
            background: 'var(--accent)',
          }}
        />
      </div>
    </div>
  )
}

// --- Skeleton cards ---

function SkeletonCard() {
  return (
    <div className="rounded-2xl px-[18px] py-4 bg-[var(--bg-card)] animate-pulse">
      <div className="h-4 bg-[var(--border-subtle)] rounded w-3/4 mb-4" />
      <div className="h-3 bg-[var(--border-subtle)] rounded w-1/2 mb-2" />
      <div className="h-3 bg-[var(--border-subtle)] rounded w-1/3" />
    </div>
  )
}

function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className={CARD_LIST}>
      {Array.from({ length: count }, (_, i) => <SkeletonCard key={i} />)}
    </div>
  )
}

function SourceError({ error, label }: { error: string; label: string }) {
  return (
    <p className="text-[12px] text-[var(--error)] py-1">
      {label} failed: {error}
    </p>
  )
}

function SourceDisabled({ label }: { label: string }) {
  return (
    <p className="text-[12px] text-[var(--text-muted)] py-1">
      {label} not configured
    </p>
  )
}

// --- Collapsible section ---

function CollapsibleSection({ title, count, defaultOpen = true, controls, children }: {
  title: string
  count?: number
  defaultOpen?: boolean
  controls?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section>
      <div className="flex items-center gap-3 mb-3 px-1">
        <button
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="flex items-baseline gap-2 min-w-0 select-none cursor-pointer group"
        >
          <span className="text-[14px] font-medium text-[var(--text)]">{title}</span>
          {count !== undefined && <span className="text-[13px] text-[var(--text-muted)] tabular-nums">{count}</span>}
          {/* Only there while collapsed, or on hover, so an open list stays quiet */}
          <span
            className={`text-[10px] inline-block transition-[transform,opacity] text-[var(--text-muted)] ${open ? 'opacity-0 group-hover:opacity-100' : ''}`}
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >▸</span>
        </button>
        <div className="flex-1" />
        {controls && <div className="shrink-0">{controls}</div>}
      </div>
      {open && children}
    </section>
  )
}

// --- Ticket pin + sort controls ---

function TicketSortSelect({ sort, onChange }: { sort: TicketSort; onChange: (s: TicketSort) => void }) {
  return (
    <select
      value={sort}
      onChange={e => onChange(e.target.value as TicketSort)}
      className="text-[12px] text-[var(--text-muted)] bg-transparent cursor-pointer hover:text-[var(--text)] transition-colors focus:outline-none"
      title="Sort tickets"
    >
      {TICKET_SORT_OPTIONS.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

function HideUnlinkedToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="text-[12px] text-[var(--text-muted)] cursor-pointer hover:text-[var(--text)] transition-colors"
      title={hidden ? 'Unlinked PRs are hidden — click to show them' : 'Hide PRs that aren’t linked to a ticket'}
    >
      {hidden ? 'Show unlinked' : 'Hide unlinked'}
    </button>
  )
}

function PinButton({ id, pinned, onToggle }: { id: string; pinned: boolean; onToggle: (id: string) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(id) }}
      className={`w-5 h-5 flex items-center justify-center cursor-pointer transition-all ${
        pinned
          ? 'text-[var(--accent)]'
          : 'text-[var(--text-muted)] opacity-0 group-hover/card:opacity-60 focus-visible:opacity-100 hover:!opacity-100 hover:text-[var(--accent)]'
      }`}
      title={pinned ? 'Unpin from top' : 'Pin to top'}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="m11.294.984 3.722 3.722a1.75 1.75 0 0 1-.504 2.826l-1.327.613a3.089 3.089 0 0 0-1.707 2.084l-.584 2.454c-.317 1.332-1.972 1.8-2.94.832L5.75 11.311 1.78 15.28a.749.749 0 1 1-1.06-1.06l3.969-3.97-2.204-2.204c-.968-.968-.5-2.623.832-2.94l2.454-.584a3.08 3.08 0 0 0 2.084-1.707l.613-1.327a1.75 1.75 0 0 1 2.826-.504Z" />
      </svg>
    </button>
  )
}

// --- Card tile ---

// Title, an inset rule, the body, then a footer with the id bottom-right
function Tile({ onClick, onMouseEnter, title, corner, meta, id, children }: {
  onClick: () => void
  onMouseEnter?: () => void
  title: React.ReactNode
  corner?: React.ReactNode
  meta?: React.ReactNode
  id: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div onClick={onClick} onMouseEnter={onMouseEnter} className={CARD}>
      <div className="flex items-start gap-3 px-[18px] pt-4 pb-3">
        <h3 className="flex-1 min-w-0 text-[15px] font-medium leading-snug text-[var(--text)]">{title}</h3>
        {corner && <div className="shrink-0 flex items-center -mr-1.5 -my-0.5">{corner}</div>}
      </div>
      <div className="mx-2.5 border-t border-[var(--border-subtle)]" />
      <div className="px-[18px] pt-3">{children}</div>
      <div className="mt-auto flex items-center gap-3 px-[18px] pt-3 pb-3.5 text-[12px] text-[var(--text-muted)]">
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">{meta}</div>
        <div className="shrink-0">{id}</div>
      </div>
    </div>
  )
}

// A PR number in a card's footer
function FooterPrLink({ number, url }: { number: number; url?: string | null }) {
  return <PrLink number={number} url={url} iconSize={12} className="inline-flex items-center gap-1 hover:text-[var(--text)] hover:underline" />
}

// --- Raw card components (pre-LLM) ---

function EnrichmentSkeleton() {
  return (
    <div className="animate-pulse mt-1.5 space-y-1.5">
      <div className="h-3 bg-[var(--border-subtle)] rounded w-2/3" />
      <div className="h-3 bg-[var(--border-subtle)] rounded w-2/5" />
    </div>
  )
}

function RawTicketCard({ ticket, isPinned, onTogglePin, onTicketClick }: {
  ticket: LinearTicket
  isPinned: boolean
  onTogglePin: (id: string) => void
  onTicketClick: (id: string) => void
}) {
  return (
    <Tile
      onClick={() => onTicketClick(ticket.identifier)}
      title={ticket.title}
      corner={<PinButton id={ticket.identifier} pinned={isPinned} onToggle={onTogglePin} />}
      meta={<>
        <PriorityBadge priority={priorityLabel(ticket.priority)} />
        {ticket.workDocParsed?.progressContent && <span>{ticket.workDocParsed.progressContent}</span>}
      </>}
      id={ticket.identifier}
    >
      <EnrichmentSkeleton />
      {ticket.linkedPrNumbers.length > 0 && (
        <div className="mt-2 text-[12px] text-[var(--text-muted)]">
          {ticket.linkedPrNumbers.map(n => (
            <span key={n} className="mr-3"><PrLink number={n} iconSize={12} className="text-[var(--accent)] hover:underline" /></span>
          ))}
        </div>
      )}
    </Tile>
  )
}

function RawPrCard({ pr, onPrClick }: { pr: PullRequest; onPrClick: (n: number) => void }) {
  return (
    <Tile
      onClick={() => onPrClick(pr.number)}
      title={pr.title}
      meta={<span>+{pr.additions} −{pr.deletions}</span>}
      id={<FooterPrLink number={pr.number} url={pr.url} />}
    >
      <EnrichmentSkeleton />
      <div className="flex items-baseline gap-1.5 mt-2 flex-wrap">
        <ReviewStatusBadge status={pr.displayStatus} />
        {pr.displayStatus !== 'Merged' && pr.displayStatus !== 'Closed' && (
          <PrHealthBadges ci={ciBadgeValue(pr.ciStatus)} conflict={pr.hasMergeConflict} />
        )}
        <WatchToggle prNumber={pr.number} />
      </div>
    </Tile>
  )
}

function RawReviewCard({ pr, onPrClick }: { pr: PullRequest; onPrClick: (n: number) => void }) {
  const daysWaiting = Math.floor((Date.now() - new Date(pr.updatedAt).getTime()) / (1000 * 60 * 60 * 24))
  return (
    <Tile
      onClick={() => onPrClick(pr.number)}
      title={pr.title}
      meta={<>
        <span>@{pr.author}</span>
        <span>{daysWaiting}d</span>
        <span>{pr.additions + pr.deletions} lines</span>
      </>}
      id={<FooterPrLink number={pr.number} url={pr.url} />}
    >
      <EnrichmentSkeleton />
    </Tile>
  )
}

// --- Raw sections (progressive rendering, no LLM data) ---

function RawWorkSection({ githubState, linearState, pinned, onTogglePin, sort, onSortChange, hideUnlinked, onToggleHideUnlinked, onTicketClick, onPrClick }: {
  githubState: SourceState<GitHubResponse>
  linearState: SourceState<LinearResponse>
  pinned: string[]
  onTogglePin: (id: string) => void
  sort: TicketSort
  onSortChange: (s: TicketSort) => void
  hideUnlinked: boolean
  onToggleHideUnlinked: () => void
  onTicketClick: (id: string) => void
  onPrClick: (n: number) => void
}) {
  const linearTickets = applyTicketOrder(
    linearState.data?.allTickets?.filter(
      t => t.state.type === 'started' || t.state.type === 'unstarted'
    ) ?? [],
    linearTicketSortKeys,
    pinned,
    sort,
  )
  const hiddenTicketIds = new Set(linearState.data?.hiddenTicketIds ?? [])
  const hiddenPrNumbers = new Set(linearState.data?.hiddenPrNumbers ?? [])
  const myPrs = (githubState.data ? getOpenPrs(githubState.data) : []).filter(pr =>
    !hiddenPrNumbers.has(pr.number) &&
    !(pr.linkedTicketId != null && hiddenTicketIds.has(pr.linkedTicketId)),
  )
  // Same orphan semantics as the enriched section: a PR is "unlinked" when it
  // has no ticket, or its ticket isn't among the tickets shown above.
  const shownTicketIds = new Set(linearTickets.map(t => t.identifier))
  const visiblePrs = hideUnlinked
    ? myPrs.filter(pr => pr.linkedTicketId != null && shownTicketIds.has(pr.linkedTicketId))
    : myPrs

  return (
    <CollapsibleSection
      title="Your work"
      count={linearState.status === 'success' || githubState.status === 'success' ? linearTickets.length + visiblePrs.length : undefined}
      controls={
        <div className="flex items-center gap-4">
          <HideUnlinkedToggle hidden={hideUnlinked} onToggle={onToggleHideUnlinked} />
          <TicketSortSelect sort={sort} onChange={onSortChange} />
        </div>
      }
    >
      {/* Tickets from Linear */}
      {linearState.status === 'loading' && <SkeletonCards count={3} />}
      {linearState.status === 'error' && <SourceError error={linearState.error!} label="Linear" />}
      {linearState.status === 'disabled' && <SourceDisabled label="Linear" />}
      {linearState.status === 'success' && linearTickets.length === 0 && githubState.status === 'success' && visiblePrs.length === 0 && (
        <p className="text-[var(--text-muted)]">Nothing in flight.</p>
      )}
      {linearState.status === 'success' && (
        <div className={CARD_LIST}>
          {linearTickets.map(t => (
            <RawTicketCard key={t.identifier} ticket={t} isPinned={pinned.includes(t.identifier)} onTogglePin={onTogglePin} onTicketClick={onTicketClick} />
          ))}
        </div>
      )}
      {/* PRs from GitHub (unlinked / orphans) */}
      {githubState.status === 'loading' && linearState.status !== 'loading' && <SkeletonCards count={2} />}
      {githubState.status === 'error' && <SourceError error={githubState.error!} label="GitHub" />}
      {githubState.status === 'success' && visiblePrs.length > 0 && (
        <div className={`${CARD_LIST} mt-3.5`}>
          {visiblePrs.map(pr => (
            <RawPrCard key={pr.number} pr={pr} onPrClick={onPrClick} />
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}

function RawReviewSection({ githubState, onPrClick }: {
  githubState: SourceState<GitHubResponse>
  onPrClick: (n: number) => void
}) {
  const reviews = githubState.data?.reviewRequested ?? []

  return (
    <CollapsibleSection title="Waiting for your review" count={githubState.status === 'success' ? reviews.length : undefined}>
      {githubState.status === 'loading' && <SkeletonCards count={2} />}
      {githubState.status === 'error' && <SourceError error={githubState.error!} label="GitHub" />}
      {githubState.status === 'success' && reviews.length === 0 && (
        <p className="text-[var(--text-muted)]">None — you're clear.</p>
      )}
      {githubState.status === 'success' && reviews.length > 0 && (
        <div className={CARD_LIST}>
          {reviews.map(pr => (
            <RawReviewCard key={pr.number} pr={pr} onPrClick={onPrClick} />
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}

// --- Helper: extract open PRs from CategorisedPRs ---

function getOpenPrs(prs: CategorisedPRs): PullRequest[] {
  return [
    ...prs.changesRequested,
    ...prs.draft,
    ...prs.approved,
    ...prs.commentsToAddress,
    ...prs.pending,
  ]
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 1: return 'Urgent'
    case 2: return 'High'
    case 3: return 'Normal'
    case 4: return 'Low'
    default: return 'No priority'
  }
}

// --- Status dot + Work item chips ---

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-[var(--accent)]',
  waiting_for_feedback: 'bg-[var(--waiting)]',
  pending: 'bg-[var(--text-muted)]',
  starting: 'bg-[var(--text-muted)]',
}

function activeTaskKey(item: WorkItem): string {
  return item.type === 'orphan-pr' ? `pr:${item.id}` : `ticket:${item.id}`
}

function StatusDot({ activeTask, onStatusClick }: { activeTask?: TaskSummary; onStatusClick?: () => void }) {
  if (!activeTask) return null
  const color = STATUS_COLORS[activeTask.status] || STATUS_COLORS.pending
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onStatusClick?.() }}
      className="w-5 h-5 flex items-center justify-center cursor-pointer"
      title={`${activeTask.status} — click to view tasks`}
    >
      <span className={`w-2 h-2 rounded-full ${color} sonar-dot`} />
    </button>
  )
}

function WorkItemActions({ item, hasActiveTask }: { item: WorkItem; hasActiveTask: boolean }) {
  const [dispatchingId, setDispatchingId] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)
  const { dispatch } = useDispatchTask()

  const resolvedActions = item.actions.map(action => {
    if ('presetId' in action) {
      const preset = DRAWER_PRESETS.find(p => p.id === action.presetId)
      if (!preset) return null
      return { id: preset.id, label: preset.label, mode: preset.mode, prompt: preset.prompt, isCustom: false }
    }
    return { id: `custom:${action.label}`, label: action.label, mode: action.mode, prompt: action.instruction, isCustom: true }
  }).filter(Boolean) as Array<{ id: string; label: string; mode: string; prompt: string; isCustom: boolean }>

  const handleDispatch = async (action: typeof resolvedActions[number]) => {
    if (dispatchingId || hasActiveTask) return
    setDispatchingId(action.id)
    setErrorId(null)
    const context: { ticketId?: string; prNumber?: number } = {}
    if (item.type === 'orphan-pr') context.prNumber = Number(item.id)
    else context.ticketId = item.id
    if (item.prs?.length) context.prNumber = item.prs[0].number
    const result = await dispatch({ prompt: action.prompt, tags: [action.mode], context })
    if (!result.ok) {
      setErrorId(action.id)
      setTimeout(() => setErrorId(null), 3000)
    }
    setDispatchingId(null)
  }

  if (resolvedActions.length === 0) return null

  return (
    <div className={`${ACTION_ROW_LIST} mt-3`}>
      {resolvedActions.map((action, i) => (
        <ActionRow
          key={action.id}
          label={action.label}
          primary={i === 0}
          dispatching={dispatchingId === action.id}
          error={errorId === action.id}
          disabled={hasActiveTask || (!!dispatchingId && dispatchingId !== action.id)}
          // Custom actions are written for this item; show what they'll ask for
          title={action.isCustom ? action.prompt : undefined}
          onRun={() => handleDispatch(action)}
        />
      ))}
    </div>
  )
}

// --- Section: YOUR WORK (enriched) ---

function WorkSection({ items, tickets, pinned, onTogglePin, sort, onSortChange, hideUnlinked, onToggleHideUnlinked, activeTaskMap, onTicketClick, onPrClick, onTicketStatusClick, onPrStatusClick, context }: {
  items: WorkItem[]
  tickets: LinearTicket[]
  pinned: string[]
  onTogglePin: (id: string) => void
  sort: TicketSort
  onSortChange: (s: TicketSort) => void
  hideUnlinked: boolean
  onToggleHideUnlinked: () => void
  activeTaskMap: Map<string, TaskSummary>
  onTicketClick: (id: string) => void
  onPrClick: (number: number) => void
  onTicketStatusClick: (id: string) => void
  onPrStatusClick: (number: number) => void
  context: string | null
}) {
  const ticketsById = useMemo(() => new Map(tickets.map(t => [t.identifier, t])), [tickets])
  const ticketItems = applyTicketOrder(
    items.filter(i => i.type === 'ticket'),
    i => workItemSortKeys(i, ticketsById),
    pinned,
    sort,
  )
  const orphanPrs = items.filter(i => i.type === 'orphan-pr')
  const visibleOrphans = hideUnlinked ? [] : orphanPrs

  return (
    <CollapsibleSection
      title="Your work"
      count={ticketItems.length + visibleOrphans.length}
      controls={
        <div className="flex items-center gap-4">
          <HideUnlinkedToggle hidden={hideUnlinked} onToggle={onToggleHideUnlinked} />
          <TicketSortSelect sort={sort} onChange={onSortChange} />
        </div>
      }
    >
      {ticketItems.length === 0 && visibleOrphans.length === 0 && (
        <p className="text-[var(--text-muted)]">
          Nothing in flight.{hideUnlinked && orphanPrs.length > 0 ? ` (${orphanPrs.length} unlinked hidden)` : ''}
        </p>
      )}
      <div className={CARD_LIST}>
        {ticketItems.map(item => (
          <TicketEntry key={item.id} item={item} isPinned={pinned.includes(item.id)} onTogglePin={onTogglePin} activeTask={activeTaskMap.get(activeTaskKey(item))} onTicketClick={onTicketClick} onPrClick={onPrClick} onStatusClick={onTicketStatusClick} context={context} />
        ))}
        {visibleOrphans.length > 0 && (
          <>
            <p className="mt-4 px-1 text-[13px] font-medium text-[var(--text-muted)]">Unlinked</p>
            {visibleOrphans.map(item => (
              <OrphanPrEntry key={item.id} item={item} activeTask={activeTaskMap.get(activeTaskKey(item))} onPrClick={onPrClick} onStatusClick={onPrStatusClick} context={context} />
            ))}
          </>
        )}
      </div>
    </CollapsibleSection>
  )
}

const TicketEntry = memo(function TicketEntry({ item, isPinned, onTogglePin, activeTask, onTicketClick, onPrClick, onStatusClick, context }: {
  item: WorkItem
  isPinned: boolean
  onTogglePin: (id: string) => void
  activeTask?: TaskSummary
  onTicketClick: (id: string) => void
  onPrClick: (number: number) => void
  onStatusClick: (id: string) => void
  context: string | null
}) {
  const [showVerify, setShowVerify] = useState(false)
  return (
    <Tile
      onClick={() => onTicketClick(item.id)}
      title={item.editorialTitle}
      corner={<>
        <StatusDot activeTask={activeTask} onStatusClick={() => onStatusClick(item.id)} />
        <PinButton id={item.id} pinned={isPinned} onToggle={onTogglePin} />
      </>}
      meta={<>
        <PriorityBadge priority={item.priority} />
        {item.planStatus && <span>{item.planStatus}</span>}
        {item.noPr && <span>No PR</span>}
        {item.manualSteps === 'done' && <span className="text-[var(--success)]">✔ Manual done</span>}
        {item.prs && item.prs.length > 0 && <VerifyButton context={context} onOpen={() => setShowVerify(true)} />}
      </>}
      id={item.id}
    >
      <p className="text-[var(--text-muted)]">{item.tldr}</p>
      {item.prs?.map(pr => (
        <PrSubLine key={pr.number} pr={pr} />
      ))}
      <WorkItemActions item={item} hasActiveTask={!!activeTask} />
      {showVerify && context && (
        <ManualStepsModal item={{ id: item.id, title: item.editorialTitle }} context={context} onClose={() => setShowVerify(false)} />
      )}
    </Tile>
  )
})

const OrphanPrEntry = memo(function OrphanPrEntry({ item, activeTask, onPrClick, onStatusClick, context }: {
  item: WorkItem
  activeTask?: TaskSummary
  onPrClick: (number: number) => void
  onStatusClick: (number: number) => void
  context: string | null
}) {
  const [showVerify, setShowVerify] = useState(false)
  const isOpen = item.prStatus !== 'Merged' && item.prStatus !== 'Closed'
  return (
    <Tile
      onClick={() => onPrClick(Number(item.id))}
      onMouseEnter={() => { if (item.linkedTicketId) fetchTicketCached(item.linkedTicketId) }}
      title={item.editorialTitle}
      corner={<StatusDot activeTask={activeTask} onStatusClick={() => onStatusClick(Number(item.id))} />}
      meta={<>
        {item.linkedTicketId && (item.linkedTicketUrl ? (
          <ExternalLink href={item.linkedTicketUrl} onClick={(e) => e.stopPropagation()} className="hover:text-[var(--text)] hover:underline">
            {item.linkedTicketId}
          </ExternalLink>
        ) : (
          <span>{item.linkedTicketId}</span>
        ))}
        <VerifyButton context={context} onOpen={() => setShowVerify(true)} />
      </>}
      id={<FooterPrLink number={Number(item.id)} url={item.url} />}
    >
      <p className="text-[var(--text-muted)]">{item.tldr}</p>
      <div className="flex items-baseline gap-1.5 mt-1 flex-wrap">
        <ReviewStatusBadge status={item.prStatus} />
        {isOpen && <PrHealthBadges ci={item.ci} conflict={item.conflict} />}
        {isOpen && <WatchToggle prNumber={Number(item.id)} />}
      </div>
      <WorkItemActions item={item} hasActiveTask={!!activeTask} />
      {showVerify && context && (
        <ManualStepsModal item={{ id: `#${item.id}`, title: item.editorialTitle, prNumber: Number(item.id) }} context={context} onClose={() => setShowVerify(false)} />
      )}
    </Tile>
  )
})

function PrSubLine({ pr }: { pr: PrSubItem }) {
  const isOpen = pr.status !== 'Merged' && pr.status !== 'Closed'
  return (
    <div className="flex items-baseline gap-1.5 mt-1 flex-wrap">
      <PrLink number={pr.number} url={pr.url} iconSize={12} className="text-[var(--accent)] hover:underline text-[12px] shrink-0" />
      <ReviewStatusBadge status={pr.status} />
      {isOpen && <PrHealthBadges ci={pr.ci} conflict={pr.conflict} />}
      {isOpen && <WatchToggle prNumber={pr.number} />}
    </div>
  )
}

// --- Section: PRs WAITING FOR YOUR REVIEW (enriched) ---

function ReviewSection({ items, activeTaskMap, onPrClick, onPrStatusClick, context }: {
  items: ReviewItem[]
  activeTaskMap: Map<string, TaskSummary>
  onPrClick: (number: number) => void
  onPrStatusClick: (number: number) => void
  context: string | null
}) {
  return (
    <CollapsibleSection title="Waiting for your review" count={items.length}>
      {items.length === 0 && (
        <p className="text-[var(--text-muted)] px-1">None — you're clear.</p>
      )}
      <div className={CARD_LIST}>
        {items.map(item => (
          <ReviewEntry key={item.number} item={item} activeTask={activeTaskMap.get(`pr:${item.number}`)} onPrClick={onPrClick} onStatusClick={onPrStatusClick} context={context} />
        ))}
      </div>
    </CollapsibleSection>
  )
}

const ReviewEntry = memo(function ReviewEntry({ item, activeTask, onPrClick, onStatusClick, context }: {
  item: ReviewItem
  activeTask?: TaskSummary
  onPrClick: (number: number) => void
  onStatusClick: (number: number) => void
  context: string | null
}) {
  const [showVerify, setShowVerify] = useState(false)
  const { dispatch, dispatching } = useDispatchTask()
  const [chipError, setChipError] = useState(false)

  const hasActiveTask = !!activeTask

  const handleDispatch = async () => {
    if (dispatching || hasActiveTask) return
    setChipError(false)
    const result = await dispatch({
      prompt: item.instruction ?? '',
      tags: [item.mode ?? 'review'],
      context: { prNumber: item.number },
    })
    if (!result.ok) {
      setChipError(true)
      setTimeout(() => setChipError(false), 3000)
    }
  }

  return (
    <Tile
      onClick={() => onPrClick(item.number)}
      title={item.editorialTitle}
      corner={<StatusDot activeTask={activeTask} onStatusClick={() => onStatusClick(item.number)} />}
      meta={<>
        <span>@{item.author}</span>
        <span>{item.daysWaiting}d</span>
        <span>{item.size} lines</span>
        <VerifyButton context={context} onOpen={() => setShowVerify(true)} />
      </>}
      id={<FooterPrLink number={item.number} url={item.url} />}
    >
      <p className="text-[var(--text-muted)]">{item.tldr}</p>
      <div className={`${ACTION_ROW_LIST} mt-3`}>
        <ActionRow
          label={item.actionLabel ?? 'Review'}
          primary
          dispatching={dispatching}
          error={chipError}
          disabled={hasActiveTask}
          onRun={handleDispatch}
        />
      </div>
      {showVerify && context && (
        <ManualStepsModal item={{ id: `#${item.number}`, title: item.editorialTitle, prNumber: item.number, isReview: true }} context={context} onClose={() => setShowVerify(false)} />
      )}
    </Tile>
  )
})


// --- Badges ---

function PriorityBadge({ priority }: { priority?: string }) {
  // Normal is Linear's Medium, the default, so it isn't worth a label
  if (!priority || priority === 'No priority' || priority === 'Normal') return null
  const colors: Record<string, string> = {
    'Urgent': 'text-[var(--error)]',
    'High': 'text-orange-500',
    'Low': 'text-[var(--text-muted)]',
  }
  return <span className={`text-[11px] ${colors[priority] || 'text-[var(--text-muted)]'}`}>{priority}</span>
}

function ReviewStatusBadge({ status }: { status?: string }) {
  if (!status) return null
  const colors: Record<string, string> = {
    'Merged': 'text-[var(--waiting)]',
    'Closed': 'text-[var(--text-muted)]',
    'Approved': 'text-[var(--success)]',
    'Changes req.': 'text-orange-500',
    'Pending': 'text-[var(--text-muted)]',
    'Draft': 'text-[var(--text-muted)]',
  }
  return <span className={`text-[11px] ${colors[status] || 'text-[var(--text-muted)]'}`}>{status === 'Pending' ? 'Awaiting review' : status}</span>
}

function CiBadge({ ci }: { ci?: string }) {
  if (!ci) return null
  if (ci === 'success') return <span className="text-[11px] text-[var(--success)]">✔ CI</span>
  if (ci === 'failure') return <span className="text-[11px] text-[var(--error)]">✖ CI</span>
  if (ci === 'pending') return <span className="text-[11px] text-[var(--text-muted)]">⏳ CI</span>
  return null
}

function ciBadgeValue(ciStatus: string | null | undefined): string | undefined {
  if (ciStatus === 'SUCCESS') return 'success'
  if (ciStatus === 'FAILURE') return 'failure'
  if (ciStatus === 'PENDING') return 'pending'
  return undefined
}

function PrHealthBadges({ ci, conflict }: { ci?: string; conflict?: boolean }) {
  const hideGreenCi = Boolean(conflict && ci === 'success')
  return (
    <>
      {conflict && <span className="text-[11px] text-[var(--error)]">✖ Conflict</span>}
      {!hideGreenCi && <CiBadge ci={ci} />}
    </>
  )
}
