'use client'

import { useDiffs } from '@/lib/hooks'
import { ExternalLink } from './external-link'
import { ServiceIcon } from './service-icon'

export function DiffViewer({ taskId }: { taskId: string }) {
  const { diffs } = useDiffs(taskId)

  if (!diffs.length) {
    return null
  }

  return (
    <div className="space-y-4">
      {diffs.map((diff) => (
        <div
          key={diff.id}
          className="rounded-lg border border-[var(--border)] overflow-hidden"
        >
          <div className="px-4 py-3 bg-[var(--bg-card)] border-b border-[var(--border)] flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{diff.summary}</p>
              {diff.prUrl && (
                <ExternalLink
                  href={diff.prUrl}
                  className="text-xs text-[var(--accent)] hover:underline"
                >
                  <ServiceIcon service="github" />{diff.prUrl}
                </ExternalLink>
              )}
            </div>
          </div>
          <pre className="p-4 text-xs overflow-x-auto bg-[var(--bg-code)] max-h-[600px] overflow-y-auto">
            <code>{colorizeDiff(diff.patch)}</code>
          </pre>
        </div>
      ))}
    </div>
  )
}

/** Simple diff colorization — returns JSX with colored lines */
function colorizeDiff(patch: string) {
  return patch.split('\n').map((line, i) => {
    let className = ''
    if (line.startsWith('+') && !line.startsWith('+++')) {
      className = 'text-[var(--success)]'
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      className = 'text-[var(--error)]'
    } else if (line.startsWith('@@')) {
      className = 'text-[var(--accent)]'
    } else if (line.startsWith('diff ') || line.startsWith('index ')) {
      className = 'text-[var(--text-muted)]'
    }
    return (
      <span key={i} className={className}>
        {line}
        {'\n'}
      </span>
    )
  })
}
