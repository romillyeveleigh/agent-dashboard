'use client'

import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { linkTarget } from '@/lib/integrations'

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'target' | 'rel'>

/**
 * Opens a known resource (ticket, PR, doc) in its own named tab; a repeat
 * click switches to that tab without reloading it. Named links skip
 * rel=noopener because the browser only finds named tabs this page opened.
 */
export function ExternalLink({ href, onClick, ...rest }: Props) {
  const target = linkTarget(href)
  if (target === '_blank') {
    return <a {...rest} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick} />
  }
  return (
    <a
      {...rest}
      href={href}
      target={target}
      onClick={e => {
        onClick?.(e)
        if (href) focusOrOpen(e, href, target)
      }}
    />
  )
}

function focusOrOpen(e: MouseEvent<HTMLAnchorElement>, href: string, target: string) {
  // Modified/middle clicks mean "new tab/window": leave those to the browser.
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  // An empty URL returns the existing named tab untouched, or a blank new one.
  const tab = window.open('', target)
  if (!tab) return
  e.preventDefault()
  let isNew = false
  try {
    isNew = tab.location.href === 'about:blank'
  } catch {
    // Cross-origin: the tab already shows the resource.
  }
  if (isNew) tab.location.replace(href)
  else tab.focus()
}
