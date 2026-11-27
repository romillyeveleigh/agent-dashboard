'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { parseTaskTags } from '@/lib/parse-tags'
import { ExternalLink } from '@/components/external-link'
import { DRAWER_PRESETS } from '@/lib/quick-actions'
import { DrawerProvider, useDrawer, useDrawerContent } from '@/components/drawer-context'
import { CelebrationProvider } from '@/components/launch-celebration'
import { Md } from '@/components/markdown'
import { useTasks, useTaskSelector } from '@/lib/hooks'
import { fetchTicketCached, getCachedTicket } from '@/lib/ticket-cache'
import { useEditorialTitle, prKey } from '@/lib/editorial-titles'
import { ActionRow, ACTION_ROW_LIST } from '@/components/action-row'
import { useDispatchTask, type DispatchContext } from '@/lib/use-dispatch-task'
import { taskSummary, taskTitle } from '@/lib/task-title'
import { MessageThread, MessageThreadSkeleton } from '@/components/message-thread'
import { ChatInput } from '@/components/chat-input'
import { StatusBadge } from '@/components/status-badge'
import { LogViewer } from '@/components/log-viewer'
import { ServiceIcon } from '@/components/service-icon'
import { ThemeToggle } from '@/components/theme-toggle'
import type { TaskSummary } from '@/lib/schema'
import type { LinearTicket } from '@/lib/linear-data'
import type { PullRequest } from '@/lib/github'

type DrawerTab = 'ticket' | 'plan' | 'prs' | 'tasks' | 'history'

const ACTIVE_STATUSES = ['pending', 'starting', 'running', 'waiting_for_feedback']
// The drawer uses the Home card language: soft white tiles on the warm page
// colour, sentence-case headings, inset rules
const TILE = 'rounded-2xl bg-[var(--bg-card)]'
const SECTION_HEADING = 'text-[14px] font-medium text-[var(--text)] mb-3 px-1'

function formatWhen(d: Date) {
  const diff = Date.now() - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function githubPrUrl(n: number) {
  return `https://github.com/${process.env.NEXT_PUBLIC_REPO_URL || 'unknown/repo'}/pull/${n}`
}

function SideDrawer() {
  const { close } = useDrawer()
  const content = useDrawerContent()
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (content) {
      setMounted(true)
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
    } else {
      setVisible(false)
      const timer = setTimeout(() => setMounted(false), 200)
      return () => clearTimeout(timer)
    }
  }, [content])

  const handleClose = useCallback(() => {
    setVisible(false)
    setTimeout(close, 200)
  }, [close])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // First Esc only leaves a text field, so a half-written reply isn't lost with the drawer
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
        e.target.blur()
        return
      }
      handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, handleClose])

  if (!mounted) return null

  return (
    <>
      <div
        // Hidden (fading out or not yet in): let clicks through to the page
        className={`fixed inset-0 z-[60] bg-black/50 transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={handleClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={content?.type === 'ticket' ? content.ticket.identifier : content?.type === 'pr' ? `PR #${content.pr.number}` : undefined}
        className={`fixed top-0 right-0 bottom-0 z-[60] w-full sm:w-[min(640px,max(50vw,480px))] bg-[var(--bg)] flex flex-col transition-transform duration-200 ease-out ${visible ? 'translate-x-0' : 'translate-x-full pointer-events-none'}`}
      >
        {/* Outside the scroll area so it stays put over the sticky header */}
        <button
          onClick={handleClose}
          aria-label="Close"
          title="Close (Esc)"
          className="absolute top-3.5 right-3.5 z-20 w-8 h-8 flex items-center justify-center rounded-lg text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-card)] transition-colors"
        >
          ✕
        </button>
        <div data-drawer-scroll className="flex-1 overflow-y-auto">
          {content?.type === 'ticket' ? <TicketDetail ticket={content.ticket} linkedPrs={content.linkedPrs} task={content.task} defaultTab={content.defaultTab} /> : content?.type === 'pr' ? <PrDetail pr={content.pr} knownTicket={content.linkedTicket} defaultTab={content.defaultTab} /> : null}
        </div>
      </div>
    </>
  )
}

const PR_STATUS_STYLES: Record<string, string> = {
  Merged: 'text-[var(--waiting)]',
  Approved: 'text-[var(--success)]',
  'Changes req.': 'text-orange-500',
}
const PR_STATUS_LABELS: Record<string, string> = {
  'Changes req.': 'Changes requested',
  Pending: 'Awaiting review',
}

// displayStatus, not state: it folds merged/closed and draft/review state
// into one label
function PrStatusBadge({ status }: { status: string }) {
  return (
    <span className={PR_STATUS_STYLES[status] ?? 'text-[var(--text-muted)]'}>
      {PR_STATUS_LABELS[status] ?? status}
    </span>
  )
}

function PrChecks({ pr }: { pr: PullRequest }) {
  if (pr.state !== 'OPEN') return null
  return (
    <>
      {pr.hasMergeConflict && <span className="text-[var(--error)]">✖ Conflict</span>}
      {pr.ciStatus && !(pr.hasMergeConflict && pr.ciStatus === 'SUCCESS') && (
        <span className={pr.ciStatus === 'SUCCESS' ? 'text-[var(--success)]' : pr.ciStatus === 'FAILURE' ? 'text-[var(--error)]' : 'text-[var(--text-muted)]'}>
          {pr.ciStatus === 'SUCCESS' ? '✔ CI' : pr.ciStatus === 'FAILURE' ? '✖ CI' : `CI ${pr.ciStatus.toLowerCase()}`}
        </span>
      )}
    </>
  )
}

function PrLink({ number, href }: { number: number; href: string }) {
  return (
    <ExternalLink href={href} className="font-mono font-medium text-[var(--accent)] hover:underline">
      <ServiceIcon service="github" />{number}
    </ExternalLink>
  )
}

// What the drawer is showing, on every tab: what you clicked, named as on its
// Home card, with its id beside it. Status and links are in the tabs
function DrawerHeader({ ticket, linkedPrs, scope }: { ticket?: LinearTicket | null; linkedPrs: PullRequest[]; scope: 'ticket' | 'pr' }) {
  const pr = scope === 'pr' || !ticket ? linkedPrs[0] : undefined
  const editorialTitle = useEditorialTitle(pr ? prKey(pr.number) : ticket?.identifier)
  const title = editorialTitle ?? pr?.title ?? ticket?.title
  if (!title) return null
  return (
    <h2 className="pr-10 text-[15px] font-medium leading-snug text-[var(--text)]">
      {title}
      <span className="ml-2 text-[12px] font-normal text-[var(--text-muted)] whitespace-nowrap">
        {pr ? <><ServiceIcon service="github" size={12} />{pr.number}</> : ticket?.identifier}
      </span>
    </h2>
  )
}

// Same anatomy as a Home card: heading, an inset rule, the body, then a footer
function Panel({ heading, footer, children }: { heading?: React.ReactNode; footer?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className={TILE}>
      {heading && <div className="px-[18px] pt-4 pb-3">{heading}</div>}
      {heading && children && <div className="mx-2.5 border-t border-[var(--border-subtle)]" />}
      {children && <div className="px-[18px] py-4">{children}</div>}
      {footer && (
        <div className="flex items-center gap-3 px-[18px] pb-3.5 text-[12px] text-[var(--text-muted)]">
          {footer}
        </div>
      )}
    </div>
  )
}

function TaskComposer({ ticketId, prNumber }: { ticketId?: string; prNumber?: number }) {
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { dispatch, dispatching } = useDispatchTask()

  const label = ticketId ?? (prNumber ? `#${prNumber}` : 'this item')

  async function submit() {
    const text = prompt.trim()
    if (!text || dispatching) return
    setError(null)
    const context: DispatchContext = {}
    if (ticketId) context.ticketId = ticketId
    if (prNumber) context.prNumber = prNumber
    const result = await dispatch({ prompt: text, tags: ['general'], context })
    if (result.ok) setPrompt('')
    else setError(result.error)
  }

  return (
    <div>
      <ChatInput
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        placeholder={`Describe a task for ${label}`}
        label="New task"
        sendLabel="Start task"
        busy={dispatching}
      />
      {error && <p className="mt-2 text-[12px] text-[var(--error)]">{error}</p>}
    </div>
  )
}

function PresetChips({ ticket, linkedPrs, activeTasks }: {
  ticket?: LinearTicket | null
  linkedPrs: PullRequest[]
  activeTasks: TaskSummary[]
}) {
  const [dispatchingId, setDispatchingId] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)
  const { dispatch } = useDispatchTask()

  const ctx = { ticket, prs: linkedPrs }
  const visible = DRAWER_PRESETS.filter(p => p.visible(ctx))

  const handleDispatch = async (preset: typeof DRAWER_PRESETS[number]) => {
    // Match on any tag, not tags[0]: reactive tasks carry a kind-specific
    // primary tag (e.g. ['fix-ci', 'code']) with the mode second.
    const hasActiveInCategory = activeTasks.some(
      (t) => parseTaskTags(t.tags).includes(preset.mode),
    )
    if (dispatchingId || hasActiveInCategory) return
    setDispatchingId(preset.id)
    setErrorId(null)
    const context: DispatchContext = {}
    if (ticket) context.ticketId = ticket.identifier
    if (linkedPrs.length > 0) context.prNumber = linkedPrs[0].number
    const result = await dispatch({ prompt: preset.prompt, tags: [preset.mode], context })
    if (!result.ok) {
      setErrorId(preset.id)
      setTimeout(() => setErrorId(null), 3000)
    }
    setDispatchingId(null)
  }

  if (visible.length === 0) return null

  return (
    <div className={`${ACTION_ROW_LIST} mt-3 px-1`}>
      {visible.map((p, i) => {
        const isDispatching = dispatchingId === p.id
        const blockingTask = activeTasks.find(
          (t) => parseTaskTags(t.tags).includes(p.mode),
        )
        return (
          <ActionRow
            key={p.id}
            label={p.label}
            primary={i === 0}
            dispatching={isDispatching}
            error={errorId === p.id}
            disabled={!!blockingTask || (!!dispatchingId && !isDispatching)}
            title={blockingTask ? `Unavailable while “${taskTitle(blockingTask.prompt)}” is running` : p.prompt}
            onRun={() => handleDispatch(p)}
          />
        )
      })}
    </div>
  )
}

function ActiveTaskCard({ task: t, onOpen, autoFocusReply }: { task: TaskSummary; onOpen: () => void; autoFocusReply: boolean }) {
  const waiting = t.status === 'waiting_for_feedback'
  // A waiting task is suspended, so its log is history; a running task's log is its progress
  const [showLogs, setShowLogs] = useState(!waiting)
  const [cancelling, setCancelling] = useState(false)

  async function handleCancel() {
    setCancelling(true)
    await fetch(`/api/tasks/${t.id}`, { method: 'DELETE' })
    setCancelling(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-[13px] font-medium truncate" title={taskSummary(t.prompt)}>{taskTitle(t.prompt)}</p>
          {waiting ? (
            <span className="block text-xs font-medium text-[var(--text)]">Waiting on you</span>
          ) : <StatusBadge status={t.status} />}
        </div>
        <div className="ml-auto shrink-0 flex items-center gap-3 text-[12px]">
          <button onClick={onOpen} className="text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors">Open task</button>
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="inline-flex items-center gap-1.5 text-[var(--text-muted)] hover:text-[var(--error)] disabled:opacity-60 transition-colors"
          >
            {cancelling && <span className="w-2.5 h-2.5 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />}
            {cancelling ? 'Cancelling…' : 'Cancel task'}
          </button>
        </div>
      </div>
      {/* A waiting task's status is always "suspended until answered" — the question says more */}
      {!waiting && t.statusMessage && (
        <p className="text-[12px] text-[var(--text-muted)]">{t.statusMessage}</p>
      )}
      <MessageThread taskId={t.id} autoFocusReply={autoFocusReply} collapseToLatest />
      <div>
        <button
          onClick={() => setShowLogs(!showLogs)}
          aria-expanded={showLogs}
          className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        >
          <span className={`text-[9px] transition-transform duration-150 ${showLogs ? 'rotate-90' : ''}`}>&#9654;</span>
          Activity
        </button>
        {showLogs && <div className="mt-2"><LogViewer taskId={t.id} maxHeight="40vh" /></div>}
      </div>
    </div>
  )
}

const PAST_TASKS_SHOWN = 5

function PastTasks({ tasks, onOpen }: { tasks: TaskSummary[]; onOpen: (id: string) => void }) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? tasks : tasks.slice(0, PAST_TASKS_SHOWN)
  return (
    <section>
      <h3 className={SECTION_HEADING}>Earlier tasks</h3>
      <ul className={`${TILE} overflow-hidden py-1.5`}>
        {shown.map(t => (
          <li key={t.id}>
            <button
              onClick={() => onOpen(t.id)}
              className="w-full text-left px-[18px] py-2.5 hover:bg-[var(--bg-card-hover)] transition-colors"
            >
              <p className="text-[13px] truncate" title={taskSummary(t.prompt)}>{taskTitle(t.prompt)}</p>
              <div className="flex items-center gap-2 mt-1 text-[12px] text-[var(--text-muted)]">
                <span className="shrink-0"><StatusBadge status={t.status} /></span>
                {t.statusMessage && <span className="truncate">{t.statusMessage}</span>}
                <span className="ml-auto shrink-0 text-[11px]">{formatWhen(new Date(t.updatedAt))}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {tasks.length > shown.length && (
        <button onClick={() => setShowAll(true)} className="mt-2 px-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
          Show {tasks.length - shown.length} more
        </button>
      )}
    </section>
  )
}

function CopyBranchButton({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(branch)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }
  return (
    <span className="flex items-center gap-2 min-w-0">
      <code className="text-[11px] font-mono text-[var(--text-muted)] truncate" title={branch}>{branch}</code>
      <button
        onClick={copy}
        title="Copy branch name"
        className="shrink-0 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </span>
  )
}

function TicketPanel({ ticket }: { ticket: LinearTicket }) {
  const priority = ticket.priority === 1 ? 'Urgent' : ticket.priority === 2 ? 'High' : null
  return (
    <Panel
      heading={<>
        <h3 className="text-[15px] font-medium leading-snug">{ticket.title}</h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[12px] text-[var(--text-muted)]">
          <span>{ticket.state.name}</span>
          {priority && <span className={priority === 'Urgent' ? 'text-[var(--error)]' : 'text-orange-500'}>{priority}</span>}
          {ticket.assignee && <span>Assigned to {ticket.assignee.name}</span>}
          {ticket.team && <span>{ticket.team.name}</span>}
          {ticket.labels.map(l => <span key={l}>{l}</span>)}
        </div>
      </>}
      footer={<>
        <div className="flex-1 min-w-0">{ticket.branchName && <CopyBranchButton branch={ticket.branchName} />}</div>
        <ExternalLink href={ticket.url} title="Open in Linear" className="shrink-0 hover:text-[var(--text)] hover:underline">
          {ticket.identifier}
        </ExternalLink>
      </>}
    >
      <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {ticket.description
          ? <Md>{ticket.description}</Md>
          : <p className="text-[13px] text-[var(--text-muted)]">This ticket has no description.</p>}
      </div>
    </Panel>
  )
}

function PlanPanel({ ticket }: { ticket: LinearTicket }) {
  return (
    <Panel
      footer={ticket.workDocumentUrl && <>
        <span className="flex-1" />
        <ExternalLink href={ticket.workDocumentUrl} className="shrink-0 hover:text-[var(--text)] hover:underline">Open in Linear</ExternalLink>
      </>}
    >
      {ticket.workDocumentContent
        ? <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"><Md>{ticket.workDocumentContent}</Md></div>
        : <p className="text-[13px] text-[var(--text-muted)]">The plan’s content couldn’t be loaded. Open it in Linear to read it.</p>}
    </Panel>
  )
}

function PrCard({ pr }: { pr: PullRequest }) {
  const waitingOn = pr.state === 'OPEN' && pr.requestedReviewers?.length > 0
  return (
    <Panel
      heading={<>
        <h3 className="text-[15px] font-medium leading-snug">
          {pr.title}
          <ExternalLink href={pr.url} className="ml-2 text-[12px] font-normal text-[var(--text-muted)] whitespace-nowrap hover:text-[var(--text)] hover:underline">
            <ServiceIcon service="github" size={12} />{pr.number}
          </ExternalLink>
        </h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[12px] text-[var(--text-muted)]">
          <PrStatusBadge status={pr.displayStatus} />
          <PrChecks pr={pr} />
          <span><span className="text-[var(--success)]">+{pr.additions}</span> <span className="text-[var(--error)]">−{pr.deletions}</span></span>
          <span>by {pr.author}</span>
        </div>
      </>}
      footer={pr.headRefName && <CopyBranchButton branch={pr.headRefName} />}
    >
      {(waitingOn || pr.reviews.length > 0) && (
        <div className="space-y-3">
          {waitingOn && <p className="text-[12px] text-[var(--text-muted)]">Waiting on review from {pr.requestedReviewers.join(', ')}</p>}
          {pr.reviews.map((review, i) => (
            <div key={i} className="border-l-2 border-[var(--border-subtle)] pl-3">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[12px] font-medium">{review.author}</span>
                <span className={`text-[11px] ${
                  review.state === 'APPROVED' ? 'text-[var(--success)]' :
                  review.state === 'CHANGES_REQUESTED' ? 'text-[var(--error)]' :
                  'text-[var(--text-muted)]'
                }`}>
                  {review.state.toLowerCase().replace('_', ' ')}
                </span>
              </div>
              {review.body && (
                <div className="text-[var(--text-muted)]"><Md>{review.body}</Md></div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function TicketDetail({ ticket, linkedPrs, task: initialTask, defaultTab, scope = 'ticket' }: { ticket?: LinearTicket | null; linkedPrs: PullRequest[]; task?: TaskSummary; defaultTab?: DrawerTab; scope?: 'ticket' | 'pr' }) {
  const router = useRouter()
  const { close } = useDrawer()
  const { tasks: allTasks } = useTasks()
  // In 'pr' scope (PR drawer), only show tasks for the specific PR. In 'ticket' scope, show all tasks
  // for the ticket (ticketId match OR any linked-PR match). Mixing scopes caused PR drawers to surface
  // unrelated sibling-task threads.
  const ticketTasks = allTasks.filter(t =>
    scope === 'pr'
      ? linkedPrs.some(pr => t.prNumber === pr.number)
      : (ticket && t.ticketId === ticket.identifier) || linkedPrs.some(pr => t.prNumber === pr.number),
  )
  const activeTasks = ticketTasks.filter(t => ACTIVE_STATUSES.includes(t.status))
  const pastTasks = ticketTasks
    .filter(t => !ACTIVE_STATUSES.includes(t.status))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const hasWaiting = activeTasks.some(t => t.status === 'waiting_for_feedback')
  const prCount = linkedPrs.length || ticket?.linkedPrNumbers?.length || 0

  // Only tabs with something behind them
  const tabs: Array<{ id: DrawerTab; label: string; count?: number; waiting?: boolean }> = []
  if (ticket) tabs.push({ id: 'ticket', label: 'Ticket' })
  if (ticket?.hasWorkDocument) tabs.push({ id: 'plan', label: 'Plan' })
  if (prCount > 0) tabs.push({ id: 'prs', label: 'PRs', count: prCount })
  tabs.push({ id: 'tasks', label: 'Tasks', count: activeTasks.length, waiting: hasWaiting })
  if (ticket) tabs.push({ id: 'history', label: 'History' })

  const [tab, setTab] = useState<DrawerTab>(() =>
    defaultTab
      || (activeTasks.length > 0 || initialTask?.status === 'waiting_for_feedback' ? 'tasks' : scope === 'pr' ? 'prs' : 'ticket'),
  )
  const current = tabs.some(t => t.id === tab) ? tab : tabs[0].id

  const openTask = (id: string) => { close(); router.push(`/tasks/${id}`) }

  return (
    <div>
      <div className="sticky top-0 z-10 bg-[var(--bg)] border-b border-[var(--border-subtle)] px-6 pt-5">
        <DrawerHeader ticket={ticket} linkedPrs={linkedPrs} scope={scope} />
        <div role="tablist" className="flex items-center gap-4 mt-3">
          {tabs.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={current === t.id}
              onClick={(e) => {
                setTab(t.id)
                e.currentTarget.closest('[data-drawer-scroll]')?.scrollTo({ top: 0 })
              }}
              title={t.waiting ? 'Waiting on you' : undefined}
              className={`-mb-px inline-flex items-baseline gap-1.5 py-2 text-[13px] border-b-2 transition-colors ${
                current === t.id
                  ? 'border-[var(--text)] text-[var(--text)] font-medium'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {t.label}
              {/* Plain count, like the Home headings; darker when one of them is waiting on you */}
              {!!t.count && (
                <span className={`text-[12px] tabular-nums ${t.waiting ? 'text-[var(--text)] font-semibold' : 'text-[var(--text-muted)] font-normal'}`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-5">
        {current === 'ticket' && ticket && <TicketPanel ticket={ticket} />}

        {current === 'plan' && ticket && <PlanPanel ticket={ticket} />}

        {current === 'prs' && (
          linkedPrs.length > 0 ? (
            <div className="space-y-3">
              {linkedPrs.map(pr => <PrCard key={pr.number} pr={pr} />)}
            </div>
          ) : (
            <div className={`${TILE} px-[18px] py-4 space-y-2 text-[13px]`}>
              {ticket?.linkedPrNumbers.map(n => (
                <div key={n}><PrLink number={n} href={githubPrUrl(n)} /></div>
              ))}
            </div>
          )
        )}

        {/* Needs you, then in progress, then start something new, then what's done */}
        {current === 'tasks' && (
          <div className="space-y-8">
            {activeTasks.length > 0 && (
              <div className="space-y-3">
                {[...activeTasks]
                  .sort((a, b) => Number(b.status === 'waiting_for_feedback') - Number(a.status === 'waiting_for_feedback'))
                  .map((t, i) => (
                    <div key={t.id} className={`${TILE} px-[18px] py-4`}>
                      {/* Waiting tasks sort first, so only the top one takes focus */}
                      <ActiveTaskCard task={t} onOpen={() => openTask(t.id)} autoFocusReply={i === 0} />
                    </div>
                  ))}
              </div>
            )}
            <section>
              <h3 className={SECTION_HEADING}>{activeTasks.length > 0 ? 'Start another task' : 'Start a task'}</h3>
              <TaskComposer ticketId={ticket?.identifier} prNumber={!ticket && linkedPrs.length > 0 ? linkedPrs[0].number : undefined} />
              <PresetChips ticket={ticket} linkedPrs={linkedPrs} activeTasks={activeTasks} />
            </section>
            {pastTasks.length > 0 && <PastTasks tasks={pastTasks} onOpen={openTask} />}
          </div>
        )}

        {current === 'history' && ticket && <TicketHistory ticketId={ticket.identifier} />}
      </div>
    </div>
  )
}

const MESSAGE_LABELS: Record<string, string> = {
  question: 'Agent asked a question',
  approval: 'Agent asked for approval',
  blocker: 'Agent hit a blocker',
}

const STATUS_LABELS: Record<string, string> = {
  complete: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  resolved: 'Resolved',
}

function TicketHistory({ ticketId }: { ticketId: string }) {
  const router = useRouter()
  const { close } = useDrawer()
  const [history, setHistory] = useState<Array<{
    task: TaskSummary
    messages: Array<{ id: string; direction: string; content: string; type: string | null; createdAt: string }>
  }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/tickets/${ticketId}/history`)
      .then(r => r.ok ? r.json() : [])
      .then(setHistory)
      .finally(() => setLoading(false))
  }, [ticketId])

  if (loading) {
    return (
      <div className={`${TILE} px-[18px] py-4 relative animate-pulse`}>
        <div className="absolute left-[23px] top-6 bottom-6 w-px bg-[var(--border)]" />
        <div className="space-y-4">
          {['w-2/3', 'w-1/2', 'w-3/4'].map(w => (
            <div key={w} className="flex gap-3 relative py-1">
              <div className="w-[11px] h-[11px] rounded-full shrink-0 mt-1.5 bg-[var(--border-subtle)] ring-2 ring-[var(--bg-card)]" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3 w-1/3 rounded bg-[var(--border-subtle)]" />
                <div className={`h-3 ${w} rounded bg-[var(--border-subtle)]`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (!history.length) return <p className={`${TILE} text-[13px] text-[var(--text-muted)] py-8 text-center`}>No agent has worked on this ticket yet.</p>

  // Build a flat timeline from tasks and messages
  type TimelineEvent = {
    time: Date
    type: 'task_created' | 'task_status' | 'agent_message' | 'human_reply' | 'pr_submitted'
    label: string
    detail?: string
    failed?: boolean
    // Fire-and-forget agent notes, as opposed to messages that asked something of you
    note?: boolean
    taskId: string
  }

  const events: TimelineEvent[] = []

  for (const { task, messages } of history) {
    events.push({
      time: new Date(task.createdAt),
      type: 'task_created',
      label: `Started: ${taskTitle(task.prompt)}`,
      taskId: task.id,
    })

    if (STATUS_LABELS[task.status]) {
      events.push({
        time: new Date(task.updatedAt),
        type: 'task_status',
        label: `${STATUS_LABELS[task.status]}: ${taskTitle(task.prompt)}`,
        detail: task.statusMessage || undefined,
        failed: task.status === 'failed',
        taskId: task.id,
      })
    }

    if (task.prUrl) {
      events.push({
        time: new Date(task.updatedAt),
        type: 'pr_submitted',
        label: 'PR submitted',
        detail: task.prUrl,
        taskId: task.id,
      })
    }

    for (const msg of messages) {
      events.push(msg.direction === 'agent_to_human'
        ? { time: new Date(msg.createdAt), type: 'agent_message', label: MESSAGE_LABELS[msg.type ?? ''] ?? 'Agent posted an update', detail: msg.content, note: !MESSAGE_LABELS[msg.type ?? ''], taskId: task.id }
        : { time: new Date(msg.createdAt), type: 'human_reply', label: 'You replied', detail: msg.content, taskId: task.id })
    }
  }

  // Newest first — the latest state of the ticket is what you open this for
  events.sort((a, b) => b.time.getTime() - a.time.getTime())

  const dotColor: Record<TimelineEvent['type'], string> = {
    task_created: 'bg-[var(--accent)]',
    task_status: 'bg-[var(--text-muted)]',
    agent_message: 'bg-amber-500',
    human_reply: 'bg-emerald-500',
    pr_submitted: 'bg-[var(--text)]',
  }

  return (
    <div className={`${TILE} px-[18px] py-4`}>
    <div className="relative">
      <div className="absolute left-[5px] top-2 bottom-2 w-px bg-[var(--border)]" />
      <div className="space-y-4">
        {events.map((ev, i) => (
          <div
            key={i}
            onClick={() => { close(); router.push(`/tasks/${ev.taskId}`) }}
            className="flex gap-3 relative cursor-pointer rounded-md -mx-2 px-2 py-1 hover:bg-[var(--bg-card-hover)] transition-colors"
          >
            <div className={`w-[11px] h-[11px] rounded-full shrink-0 mt-1.5 ${ev.failed ? 'bg-[var(--error)]' : ev.note ? 'bg-[var(--text-muted)]' : dotColor[ev.type]} ring-2 ring-[var(--bg-card)]`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium truncate">{ev.label}</span>
                <span className="text-[10px] text-[var(--text-muted)] ml-auto shrink-0">{formatWhen(ev.time)}</span>
              </div>
              {ev.detail && (
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5 line-clamp-2">
                  {ev.type === 'pr_submitted' ? (
                    <ExternalLink href={ev.detail} onClick={e => e.stopPropagation()} className="hover:text-[var(--accent)] transition-colors">
                      <ServiceIcon service="github" />{ev.detail.replace('https://github.com/', '')}
                    </ExternalLink>
                  ) : ev.detail}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
    </div>
  )
}

// Same frame as TicketDetail (header, tab bar, first content) so the drawer
// doesn't reflow when the PR's linked ticket arrives
function DrawerSkeleton({ tasks }: { tasks: boolean }) {
  const bar = 'rounded bg-[var(--border-subtle)]'
  return (
    <div className="animate-pulse">
      <div className="border-b border-[var(--border-subtle)] px-6 pt-5">
        <div className="pr-10">
          <div className={`h-4 w-3/4 ${bar}`} />
        </div>
        <div className="flex items-center gap-4 mt-3">
          {[38, 26, 36, 46].map((w, i) => (
            <div key={i} className="py-2 border-b-2 border-transparent">
              <div className={`h-3 my-1 ${bar}`} style={{ width: w }} />
            </div>
          ))}
        </div>
      </div>
      <div className="px-4 py-5">
        {tasks ? (
          <div className={`${TILE} px-[18px] py-4 space-y-3`}>
            <div className={`h-3 w-32 ${bar}`} />
            <MessageThreadSkeleton />
          </div>
        ) : (
          <div className={`${TILE} px-[18px] py-4 space-y-2.5`}>
            <div className={`h-4 w-3/4 ${bar}`} />
            <div className={`h-3 w-1/2 ${bar}`} />
            <div className={`h-3 w-1/4 ${bar}`} />
          </div>
        )}
      </div>
    </div>
  )
}

function PrDetail({ pr, knownTicket, defaultTab }: { pr: PullRequest; knownTicket?: LinearTicket; defaultTab?: DrawerTab }) {
  // From the loaded context, or already fetched (e.g. prefetched on card hover)
  const ready = knownTicket ?? (pr.linkedTicketId ? getCachedTicket(pr.linkedTicketId) : undefined)
  const [linkedTicket, setLinkedTicket] = useState<LinearTicket | null>(ready ?? null)
  const [ticketLoading, setTicketLoading] = useState(!ready && !!pr.linkedTicketId)

  useEffect(() => {
    if (ready) {
      setLinkedTicket(ready)
      setTicketLoading(false)
      return
    }
    if (!pr.linkedTicketId) return
    let cancelled = false
    setTicketLoading(true)
    fetchTicketCached(pr.linkedTicketId)
      .then(data => { if (!cancelled && data) setLinkedTicket(data) })
      .finally(() => { if (!cancelled) setTicketLoading(false) })
    return () => { cancelled = true }
  }, [pr.linkedTicketId, ready])

  if (ticketLoading) return <DrawerSkeleton tasks={defaultTab === 'tasks'} />

  // Orphan PR (no linked ticket) reuses TicketDetail with ticket=null
  return <TicketDetail ticket={linkedTicket} linkedPrs={[pr]} defaultTab={defaultTab} scope="pr" />
}


function SidebarLink({ href, label, badge, children }: { href: string; label: string; badge?: number; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      title={badge ? `${label} (${badge} running)` : label}
      className="relative flex items-center justify-center w-10 h-10 rounded-lg text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-card-hover)] transition-all"
    >
      {children}
      {badge != null && badge > 0 && (
        <span className="absolute top-0.5 right-0.5 min-w-[16px] h-[16px] px-1 flex items-center justify-center rounded-full bg-blue-500 text-white text-[10px] font-semibold leading-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  )
}

function DockerImageWarning() {
  const [missing, setMissing] = useState(false)

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/image-status')
      if (res.ok) {
        const data = await res.json()
        setMissing(!data.imageExists)
      }
    } catch {
      // ignore — don't block the dashboard
    }
  }, [])

  useEffect(() => {
    check()
    const onFocus = () => check()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [check])

  if (!missing) return null

  return (
    <div className="px-8 py-3 bg-amber-50 border-b border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30 flex items-center gap-3">
      <span className="text-amber-600 dark:text-amber-500 text-[14px]">&#9888;</span>
      <p className="text-[12px] text-amber-800 dark:text-amber-200 flex-1">
        The <code className="font-mono bg-amber-100 dark:bg-amber-500/20 px-1 rounded">agent-worker</code> Docker image was not found. Build or pull it before dispatching tasks.
      </p>
      <Link
        href="/settings#agent-worker-image"
        className="text-[11px] font-medium text-amber-800 hover:text-amber-900 dark:text-amber-200 dark:hover:text-white border border-amber-300 dark:border-amber-500/40 hover:bg-amber-100 dark:hover:bg-amber-500/20 px-2.5 py-1 rounded-md transition-colors shrink-0"
      >
        Build image
      </Link>
    </div>
  )
}

function ShellInner({ children }: { children: React.ReactNode }) {
  // A count, not the list — the shell (and the open drawer) only re-render when it changes
  const runningCount = useTaskSelector(tasks => tasks.filter(t => ['starting', 'running', 'waiting_for_feedback'].includes(t.status)).length)

  return (
    <>
      <div className="flex h-screen">
        <aside className="w-14 shrink-0 bg-[var(--bg-card)]/80 backdrop-blur-md border-r border-[var(--border)] flex flex-col items-center" style={{ boxShadow: 'var(--shadow-nav)' }}>
          <Link href="/" title="Do Some Work" className="flex items-center justify-center w-8 h-8 mt-3 mb-2 rounded-lg bg-[var(--accent)] text-white text-[14px] font-bold tracking-tight shadow-sm hover:shadow-md transition-shadow">
            D
          </Link>
          <nav className="flex flex-col gap-1 py-2 flex-1">
            <SidebarLink href="/tasks" label="Tasks" badge={runningCount}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l11 0"/><path d="M9 12l11 0"/><path d="M9 18l11 0"/><path d="M3 6l1 1 2-2"/><path d="M3 12l1 1 2-2"/><path d="M3 18l1 1 2-2"/></svg>
            </SidebarLink>
            <SidebarLink href="/dispatch" label="Dispatch">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            </SidebarLink>
            <SidebarLink href="/memories" label="Memories">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
            </SidebarLink>
            <SidebarLink href="/settings" label="Settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </SidebarLink>
          </nav>
          <ThemeToggle />
        </aside>

        <main className="flex-1 min-w-0 overflow-auto">
          <DockerImageWarning />
          <div className="px-8 py-6">{children}</div>
        </main>
      </div>

      <SideDrawer />
    </>
  )
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <CelebrationProvider>
      <DrawerProvider>
        <ShellInner>{children}</ShellInner>
      </DrawerProvider>
    </CelebrationProvider>
  )
}
