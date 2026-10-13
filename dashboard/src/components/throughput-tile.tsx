'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink } from '@/components/external-link'

type ShippedTicket = { identifier: string; title: string; url: string; completedAt: string }
type WeekMetrics = { shipped: number; touchpointsPerTicket: number; tickets: ShippedTicket[] }
type MetricsResponse = { thisWeek: WeekMetrics; lastWeek: WeekMetrics }

const REFRESH_INTERVAL_MS = 90_000

const dayHeaderFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function groupByDay(tickets: ShippedTicket[]): Array<{ dayKey: string; label: string; items: ShippedTicket[] }> {
  const buckets = new Map<string, { label: string; items: ShippedTicket[] }>()
  for (const t of tickets) {
    const d = new Date(t.completedAt)
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    let bucket = buckets.get(dayKey)
    if (!bucket) {
      bucket = { label: dayHeaderFmt.format(d), items: [] }
      buckets.set(dayKey, bucket)
    }
    bucket.items.push(t)
  }
  return Array.from(buckets.entries())
    .map(([dayKey, b]) => ({ dayKey, label: b.label, items: b.items.sort((a, z) => a.completedAt.localeCompare(z.completedAt)) }))
    .sort((a, z) => a.dayKey.localeCompare(z.dayKey))
}

function ShippedHover({ count, tickets, children }: { count: number; tickets: ShippedTicket[]; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const days = useMemo(() => groupByDay(tickets), [tickets])
  const interactive = count > 0 && tickets.length > 0

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => interactive && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span className={interactive ? 'cursor-default' : ''}>{children}</span>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-lg">
          <div className="space-y-3">
            {days.map((day) => (
              <div key={day.dayKey}>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-1">{day.label}</div>
                <ul className="space-y-1">
                  {day.items.map((t) => (
                    <li key={t.identifier} className="text-[12px] leading-snug">
                      <ExternalLink
                        href={t.url}
                        className="text-[var(--text)] hover:text-[var(--accent)] transition-colors"
                      >
                        <span className="font-mono text-[var(--text-muted)]">{t.identifier}</span>{' '}
                        <span>{t.title}</span>
                      </ExternalLink>
                      <span className="ml-1 text-[var(--text-muted)]">· {timeFmt.format(new Date(t.completedAt))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}

// Kept across client-side navigation so the tile renders at once on revisit
let lastMetrics: MetricsResponse | null = null

export function ThroughputTile() {
  const [data, setData] = useState<MetricsResponse | null>(lastMetrics)

  const refresh = useCallback(() => {
    fetch('/api/metrics')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: MetricsResponse | null) => { if (json) { lastMetrics = json; setData(json) } })
      .catch(() => {})
  }, [])

  // Polls skip while the tab is hidden; coming back into view catches up at once
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (!document.hidden) refresh() }, REFRESH_INTERVAL_MS)
    const onVisible = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // Hold the line's height until the first fetch lands, so the cards below don't shift
  if (!data) return <p className="mt-1 text-[14px] min-h-[21px]" />

  const { thisWeek, lastWeek } = data
  const shippedDelta = thisWeek.shipped - lastWeek.shipped
  const versusLast =
    shippedDelta > 0 ? `${shippedDelta} more than last` :
    shippedDelta < 0 ? `${-shippedDelta} fewer than last` :
    'same as last'
  const touches =
    thisWeek.touchpointsPerTicket > lastWeek.touchpointsPerTicket ? `up from ${lastWeek.touchpointsPerTicket}` :
    thisWeek.touchpointsPerTicket < lastWeek.touchpointsPerTicket ? `down from ${lastWeek.touchpointsPerTicket}` :
    'same as last week'
  // Dotted underline marks the parts that list their tickets on hover
  const hoverable = 'underline decoration-dotted decoration-[var(--border)] underline-offset-[3px]'

  return (
    <p className="mt-1 text-[14px] text-[var(--text-muted)]">
      <ShippedHover count={thisWeek.shipped} tickets={thisWeek.tickets}>
        <span className={thisWeek.shipped > 0 ? hoverable : ''}>{thisWeek.shipped} shipped this week</span>
      </ShippedHover>
      {', '}
      <ShippedHover count={lastWeek.shipped} tickets={lastWeek.tickets}>
        <span className={lastWeek.shipped > 0 ? hoverable : ''}>{versusLast}</span>
      </ShippedHover>
      {'.'}
      {thisWeek.shipped > 0 && ` ${thisWeek.touchpointsPerTicket} touches per ticket, ${touches}.`}
    </p>
  )
}
