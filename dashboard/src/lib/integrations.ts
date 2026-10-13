// Integration configuration — determines which external services are active
// and provides URL helpers that return null when disabled.

export function getIntegrationConfig() {
  return {
    github: {
      enabled: !!process.env.GITHUB_TOKEN && !!process.env.GITHUB_USERNAME,
    },
    linear: {
      enabled: !!process.env.LINEAR_API_KEY,
      orgSlug: process.env.LINEAR_ORG_SLUG || '',
    },
  }
}

// URL helpers — return null when the integration is disabled so callers can hide links.

export function linearTicketUrl(id: string): string | null {
  const slug = process.env.LINEAR_ORG_SLUG
  return slug ? `https://linear.app/${slug}/issue/${id}` : null
}

export function linearMyIssuesUrl(): string | null {
  const slug = process.env.LINEAR_ORG_SLUG
  return slug ? `https://linear.app/${slug}/my-issues/completed` : null
}

export function githubPrUrl(number: number): string | null {
  const repo = process.env.REPO_URL
  return repo ? `https://github.com/${repo}/pull/${number}` : null
}

/** Parse a PR number out of a github.com (`/pull/N`) URL. */
export function parsePrNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:\b|$)/)
  return m ? Number(m[1]) : null
}

/**
 * Derive a stable browser tab target from a URL so repeated clicks on the
 * same resource reuse the same tab. Different resources (different tickets,
 * different PRs) get distinct targets so they don't clobber each other.
 * Falls back to `_blank` for unknown URLs.
 */
export function linkTarget(url: string | null | undefined): string {
  if (!url) return '_blank'
  try {
    const u = new URL(url)
    const host = u.hostname
    const path = u.pathname

    if (host === 'linear.app') {
      const issue = path.match(/^\/[^/]+\/issue\/([^/]+)/)
      if (issue) return `linear-issue-${issue[1]}`
      const doc = path.match(/^\/[^/]+\/document\/([^/]+)/)
      if (doc) return `linear-doc-${doc[1]}`
      const project = path.match(/^\/[^/]+\/project\/([^/]+)/)
      if (project) return `linear-project-${project[1]}`
      const myIssues = path.match(/^\/[^/]+\/my-issues(?:\/|$)/)
      if (myIssues) return 'linear-my-issues'
      return 'linear-app'
    }

    if (host === 'github.com') {
      const pr = path.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
      if (pr) return `github-pr-${pr[1]}-${pr[2]}-${pr[3]}`
      const issue = path.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/)
      if (issue) return `github-issue-${issue[1]}-${issue[2]}-${issue[3]}`
      const repo = path.match(/^\/([^/]+)\/([^/]+)/)
      if (repo) return `github-repo-${repo[1]}-${repo[2]}`
    }
  } catch {
    // fall through
  }
  return '_blank'
}

// Build link templates for LLM system prompts
export function buildLinkTemplates(): string {
  const repo = process.env.REPO_URL || '{org}/{repo}'
  const orgSlug = process.env.LINEAR_ORG_SLUG || '{org}'
  return `- PRs: [#NUMBER](https://github.com/${repo}/pull/NUMBER)
- Tickets: [ID](https://linear.app/${orgSlug}/issue/ID)`
}
