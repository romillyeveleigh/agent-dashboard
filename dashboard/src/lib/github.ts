/**
 * GitHub GraphQL data layer.
 * Fetches user's open PRs and PRs where review is requested.
 */

import { resilientFetch } from './resilient-fetch'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || ''
const REPO_URL = process.env.REPO_URL || '' // e.g. "acme/webapp"

const GRAPHQL_URL = 'https://api.github.com/graphql'

export interface PullRequest {
  number: number
  title: string
  url: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  headRefOid: string
  additions: number
  deletions: number
  updatedAt: string
  reviewDecision: string | null // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, null
  ciStatus: string | null // SUCCESS, FAILURE, PENDING, null
  // GitHub mergeStateStatus === DIRTY: the PR cannot merge into its base.
  // Distinct from ciStatus — checks can be green while the branch still conflicts.
  hasMergeConflict: boolean
  reviews: Array<{
    state: string
    author: string
    body: string
    submittedAt: string
  }>
  // Reviewers requested but who have not submitted a review yet. Distinct from
  // `reviews` (submitted) — an empty `reviews` with a non-empty list here means
  // "review pending from X", NOT "no reviewers assigned".
  requestedReviewers: string[]
  comments: Array<{
    author: string
    body: string
    createdAt: string
  }>
  commentCount: number
  labels: Array<{ name: string }>
  author: string
  linkedTicketId: string | null // extracted from branch name
  state: string // OPEN, MERGED, CLOSED
  mergedAt: string | null
  closedAt: string | null
  displayStatus: string // Merged, Closed, Draft, Approved, Changes req., Pending
}

export interface CategorisedPRs {
  changesRequested: PullRequest[]
  reviewRequested: PullRequest[] // others' PRs where user is reviewer
  draft: PullRequest[]
  approved: PullRequest[]
  commentsToAddress: PullRequest[]
  pending: PullRequest[] // awaiting review, not draft
  recentlyMerged: PullRequest[] // merged in last 30 days
  recentlyClosed: PullRequest[] // closed (not merged) in last 30 days
}

// Fetches comment and review bodies so bot-filter can compute humanCommentCount.
// contexts(last: 50), not 100: on repos with a large CI fan-out, 100 contexts
// across a 30-PR search can exceed GitHub's ~10s GraphQL execution budget and
// 504. A failure outside the fetched window is still caught — computeCiStatus
// trusts rollup.state.
const PR_FRAGMENT_FULL = `
  number title isDraft url additions deletions
  headRefName baseRefName updatedAt reviewDecision state mergeStateStatus
  mergedAt closedAt
  headRef { name target { oid } }
  author { login }
  labels(first: 20) { nodes { name } }
  reviews(last: 10) {
    nodes { state author { login } body submittedAt }
  }
  reviewRequests(first: 10) {
    nodes { requestedReviewer { ... on User { login } ... on Team { name } } }
  }
  comments(last: 50) {
    totalCount
    nodes { author { login } body createdAt }
  }
  commits(last: 1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          state
          contexts(last: 50) {
            nodes {
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }
      }
    }
  }
`

// Used for the closed-unmerged search and merge-state polls. The full
// fragment's sub-resolvers (50 comment bodies, 10 reviews, 50 CI contexts per
// PR) across a 30-PR window can push GitHub's GraphQL execution past its ~10s
// budget, so these PRs carry no comments/reviews/CI data — mapPR defaults every
// omitted field (empty arrays / null) and consumers treat that as absent.
const PR_FRAGMENT_LIGHT = `
  number title isDraft url additions deletions
  headRefName baseRefName updatedAt reviewDecision state
  mergedAt closedAt
  headRef { name target { oid } }
  author { login }
  labels(first: 20) { nodes { name } }
`

// Each top-level search runs as its own HTTP request: GitHub enforces a ~10s
// execution budget per GraphQL request, and the four searches combined in one
// request can blow it when many PRs are open. Separate requests give each search its
// own budget, and one failing search degrades only its own section instead of
// zeroing all GitHub data. Returns null on failure so callers can tell a
// failed search from a genuinely empty one. Search values are interpolated
// into the query string because GitHub GraphQL search needs them inline.
async function searchPRs(
  label: string,
  search: string,
  first: number,
  fragment: string,
): Promise<Array<Record<string, unknown>> | null> {
  try {
    const res = await resilientFetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      // 15s, above GitHub's ~10s server budget: an over-budget search surfaces
      // as its real 504 instead of a client abort masquerading as a timeout.
      timeoutMs: 15000,
      body: JSON.stringify({
        query: `{ search(query: "${search}", type: ISSUE, first: ${first}) { nodes { ... on PullRequest { ${fragment} } } } }`,
      }),
    })
    if (!res.ok) {
      console.error(`GitHub search '${label}' error:`, res.status, await res.text())
      return null
    }
    const json = await res.json()
    return (json.data?.search?.nodes as Array<Record<string, unknown>>) ?? null
  } catch (err) {
    console.error(`GitHub search '${label}' failed:`, err)
    return null
  }
}

function extractTicketId(branchName: string): string | null {
  // Match patterns like "eng-123-...", "user/eng-123-...", etc.
  const match = branchName.match(/(?:^|\/)([a-zA-Z]+-\d+)/i)
  return match ? match[1].toUpperCase() : null
}

/** Conclusions that are settled and non-blocking (cancelled deploys, skipped paths, etc.). */
const SETTLED_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'CANCELLED'])

/** GitHub mergeStateStatus DIRTY means the merge commit cannot be created. */
export function isMergeConflict(mergeStateStatus?: string | null): boolean {
  return mergeStateStatus === 'DIRTY'
}

// --- Required-check resolution ---------------------------------------------
// `statusCheckRollup.state` aggregates EVERY check on the commit, but only the
// contexts named by the branch ruleset gate merge. Cancelled or flaky
// non-required jobs drag the rollup to FAILURE while merge stays unblocked.
// mergeStateStatus can't rescue it either: with strict required checks, a PR
// that isn't up to date reports BEHIND, which outranks UNSTABLE and appears
// both with and without a real required failure. So resolve the required
// contexts and judge CI on those alone; computeCiStatus below is only the fallback for when that lookup finds
// nothing (e.g. no ruleset, or a required legacy status rather than a check run).

const REQUIRED_CHECKS_TTL_MS = 10 * 60 * 1000

let requiredChecksCache: { names: string[]; at: number } | null = null

interface RequiredRun {
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
}

const REQUIRED_FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'])
const REQUIRED_PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

/**
 * Read the contexts the default branch's ruleset requires. Uses
 * `rules/branches/{branch}`, the read-only effective-rules view, which needs no
 * admin scope (unlike `/rulesets`). An empty result is cached too, so a repo
 * with no ruleset doesn't re-request every refresh; callers then fall back to
 * the rollup heuristic.
 */
async function fetchRequiredCheckNames(): Promise<string[]> {
  if (requiredChecksCache && Date.now() - requiredChecksCache.at < REQUIRED_CHECKS_TTL_MS) {
    return requiredChecksCache.names
  }
  const names = await loadRequiredCheckNames()
  requiredChecksCache = { names, at: Date.now() }
  return names
}

async function loadRequiredCheckNames(): Promise<string[]> {
  const [owner, repo] = REPO_URL.split('/')
  if (!GITHUB_TOKEN || !owner || !repo) return []

  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  try {
    const repoRes = await resilientFetch(`https://api.github.com/repos/${owner}/${repo}`, { headers })
    if (!repoRes.ok) return []
    const { default_branch: defaultBranch } = await repoRes.json() as { default_branch?: string }
    if (!defaultBranch) return []

    const rulesRes = await resilientFetch(
      `https://api.github.com/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(defaultBranch)}`,
      { headers },
    )
    if (!rulesRes.ok) return []
    const rules = await rulesRes.json() as Array<{
      type?: string
      parameters?: { required_status_checks?: Array<{ context?: string }> }
    }>

    const names = new Set<string>()
    for (const rule of Array.isArray(rules) ? rules : []) {
      if (rule.type !== 'required_status_checks') continue
      for (const check of rule.parameters?.required_status_checks ?? []) {
        if (check.context) names.add(check.context)
      }
    }
    // Bounded: the batched query below costs one sub-selection per name per commit.
    return [...names].slice(0, 5)
  } catch (err) {
    console.error('GitHub required-check lookup failed:', err)
    return []
  }
}

// 3 commits per request, chunks in parallel: many commits in one request trips
// RESOURCE_LIMITS_EXCEEDED, and cost grows faster than linearly with chunk
// size. The run filter has to sit on checkRuns and the suites have to stay
// unfiltered — the suite-level checkName filter silently matches nothing, and
// the required run can live in any of a commit's suites.
const REQUIRED_RUN_CHUNK = 3

async function fetchRequiredCheckRuns(
  oids: string[],
  names: string[],
): Promise<Map<string, RequiredRun[]>> {
  const out = new Map<string, RequiredRun[]>()
  const unique = [...new Set(oids.filter(Boolean))]
  const [owner, repo] = REPO_URL.split('/')
  if (!unique.length || !names.length || !owner || !repo) return out

  const runSelections = names
    .map((name, j) => `r${j}: checkRuns(first: 2, filterBy: {checkName: ${JSON.stringify(name)}, checkType: LATEST}) { nodes { name status conclusion startedAt } }`)
    .join(' ')

  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += REQUIRED_RUN_CHUNK) {
    chunks.push(unique.slice(i, i + REQUIRED_RUN_CHUNK))
  }

  await Promise.all(chunks.map(async (chunk) => {
    const selections = chunk
      .map((oid, i) => `c${i}: object(oid: ${JSON.stringify(oid)}) { ... on Commit { checkSuites(first: 20) { nodes { ${runSelections} } } } }`)
      .join(' ')
    const query = `{ repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${selections} } }`

    try {
      const res = await resilientFetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        timeoutMs: 15000,
        body: JSON.stringify({ query }),
      })
      if (!res.ok) {
        console.error('GitHub required-check runs error:', res.status, await res.text())
        return
      }
      const json = await res.json()
      const data = json.data?.repository as Record<string, unknown> | undefined
      if (!data) {
        console.error('GitHub required-check runs returned no data:', JSON.stringify(json.errors)?.slice(0, 200))
        return
      }
      chunk.forEach((oid, i) => {
        const node = data[`c${i}`] as {
          checkSuites?: { nodes?: Array<Record<string, { nodes?: RequiredRun[] } | undefined>> }
        } | null | undefined
        const runs: RequiredRun[] = []
        for (const suite of node?.checkSuites?.nodes ?? []) {
          for (const key of Object.keys(suite ?? {})) {
            for (const run of suite?.[key]?.nodes ?? []) {
              if (run?.name) runs.push(run)
            }
          }
        }
        if (runs.length) out.set(oid, runs)
      })
    } catch (err) {
      console.error('GitHub required-check runs failed:', err)
    }
  }))

  return out
}

/**
 * CI verdict from the required checks alone. Returns null when no required run
 * was found, meaning the caller should keep its rollup-derived fallback.
 */
export function ciStatusFromRequiredRuns(runs: RequiredRun[]): string | null {
  // A re-dispatched workflow leaves same-named runs in several suites — only
  // the newest one reflects reality.
  const latest = new Map<string, RequiredRun>()
  for (const run of runs) {
    const prev = latest.get(run.name)
    if (!prev || (run.startedAt ?? '') > (prev.startedAt ?? '')) latest.set(run.name, run)
  }
  const current = [...latest.values()]
  if (!current.length) return null

  if (current.some(r => REQUIRED_FAILED.has((r.conclusion ?? '').toUpperCase()))) return 'FAILURE'
  if (current.some(r => r.status !== 'COMPLETED')) return 'PENDING'
  if (current.every(r => REQUIRED_PASSED.has((r.conclusion ?? '').toUpperCase()))) return 'SUCCESS'
  // CANCELLED / STALE: superseded by a newer run, not a failure to act on.
  return 'PENDING'
}

/**
 * Replace `ciStatus` with a required-checks-only verdict, in place. Only open
 * PRs are worth the lookup (a merged PR's CI is history), and any PR the lookup
 * can't resolve keeps the rollup-derived value mapPR already set.
 */
async function applyRequiredCheckStatus(prs: PullRequest[]): Promise<void> {
  const open = prs.filter(pr => pr.state === 'OPEN' && pr.headRefOid)
  if (!open.length) return
  const names = await fetchRequiredCheckNames()
  if (!names.length) return

  const runsByOid = await fetchRequiredCheckRuns(open.map(pr => pr.headRefOid), names)
  for (const pr of open) {
    const status = ciStatusFromRequiredRuns(runsByOid.get(pr.headRefOid) ?? [])
    if (status) pr.ciStatus = status
  }
}

/**
 * Compute CI status from individual checks, ignoring checks that are
 * pending and have never run (status=QUEUED with no conclusion).
 * These are typically manual-trigger checks that stay pending by design.
 */
export function computeCiStatus(rollup: {
  state: string
  contexts?: { nodes: Array<Record<string, unknown>> }
} | null, mergeStateStatus?: string | null): string | null {
  if (!rollup) return null

  // GitHub marks a PR UNSTABLE when it is mergeable but some NON-REQUIRED checks are
  // failing or still pending. `mergeable: MERGEABLE` + UNSTABLE means every
  // *required* check passed, so these failures must NOT surface as a CI failure.
  // Only UNSTABLE earns this: BEHIND/BLOCKED/DIRTY/UNKNOWN all occur both with and
  // without a genuinely failing required check, so treating them as non-blocking
  // hides real breakage. The required-check path above makes those cases accurate.
  const onlyNonRequiredFailures = mergeStateStatus === 'UNSTABLE'

  const contexts = rollup.contexts?.nodes

  // GitHub's rollup.state is authoritative across ALL checks. A FAILURE/ERROR
  // here means a check genuinely failed, even when it falls outside the contexts
  // page we fetch (large repos can have 80+ checks). Trust it instead of
  // recomputing from a truncated set — otherwise a failure sorted out of the page
  // is invisible and we wrongly report SUCCESS. Skip this when:
  //   - only non-required checks are failing (UNSTABLE), or
  //   - the fetched page shows no hard FAILURE/ERROR but does show CANCELLED —
  //     GitHub counts cancelled jobs (e.g. superseded deploys) toward rollup
  //     FAILURE, though they don't block merge.
  if (!onlyNonRequiredFailures && (rollup.state === 'FAILURE' || rollup.state === 'ERROR')) {
    if (!contexts || contexts.length === 0) return 'FAILURE'
    let sawHardFailure = false
    let sawCancelled = false
    for (const ctx of contexts) {
      const conclusion = ('conclusion' in ctx)
        ? (ctx.conclusion as string | null)
        : ('state' in ctx ? (ctx.state as string) : null)
      if (conclusion === 'FAILURE' || conclusion === 'ERROR') sawHardFailure = true
      if (conclusion === 'CANCELLED') sawCancelled = true
    }
    if (sawHardFailure || !sawCancelled) return 'FAILURE'
    // Cancelled-only explanation for the rollup — fall through and recompute.
  }

  if (!contexts || contexts.length === 0) {
    // Under UNSTABLE the failure is non-required; without contexts to recompute
    // from, don't propagate a FAILURE/ERROR rollup state.
    if (onlyNonRequiredFailures && (rollup.state === 'FAILURE' || rollup.state === 'ERROR')) return 'PENDING'
    return rollup.state
  }

  // Separate checks into check runs and status contexts
  const checks: Array<{ label: string; status: string; conclusion: string | null }> = []
  for (const ctx of contexts) {
    if ('conclusion' in ctx && 'status' in ctx) {
      // CheckRun: status is QUEUED/IN_PROGRESS/COMPLETED, conclusion is SUCCESS/FAILURE/etc or null
      checks.push({
        label: (ctx.name as string) || '',
        status: (ctx.status as string) || 'QUEUED',
        conclusion: (ctx.conclusion as string) || null,
      })
    } else if ('state' in ctx && 'context' in ctx) {
      // StatusContext: state is PENDING/SUCCESS/FAILURE/ERROR
      const state = ctx.state as string
      checks.push({
        label: (ctx.context as string) || '',
        status: state === 'PENDING' ? 'QUEUED' : 'COMPLETED',
        conclusion: state === 'PENDING' ? null : state,
      })
    }
  }

  // Filter out checks that are queued/waiting with no conclusion (manual trigger / deployment approval gates)
  let activeChecks = checks.filter(c =>
    !((c.status === 'QUEUED' || c.status === 'WAITING') && !c.conclusion)
  )

  // Under UNSTABLE, failing checks are non-required and non-blocking — drop them so
  // the status reflects only the checks that gate merge (PENDING while others run,
  // SUCCESS once they settle).
  if (onlyNonRequiredFailures) {
    activeChecks = activeChecks.filter(c => c.conclusion !== 'FAILURE' && c.conclusion !== 'ERROR')
  }

  if (activeChecks.length === 0) return 'SUCCESS' // all checks are manual/optional
  if (activeChecks.some(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR')) return 'FAILURE'
  if (activeChecks.some(c => c.status === 'IN_PROGRESS')) return 'PENDING'
  if (activeChecks.every(c => c.conclusion != null && SETTLED_OK.has(c.conclusion))) return 'SUCCESS'
  return 'PENDING'
}

export function mapPR(node: Record<string, unknown>): PullRequest {
  const reviews = (
    (node.reviews as { nodes: Array<Record<string, unknown>> })?.nodes || []
  ).map((r) => ({
    state: r.state as string,
    author: (r.author as { login: string })?.login || 'unknown',
    body: (r.body as string) || '',
    submittedAt: (r.submittedAt as string) || '',
  }))

  // Requested reviewers can be a User (has `login`) or a Team (has `name`).
  const requestedReviewers = (
    (node.reviewRequests as { nodes: Array<Record<string, unknown>> })?.nodes || []
  ).map((rr) => {
    const reviewer = rr.requestedReviewer as { login?: string; name?: string } | null
    return reviewer?.login || reviewer?.name || ''
  }).filter(Boolean)

  const commits = (node.commits as { nodes: Array<Record<string, unknown>> })
    ?.nodes
  const lastCommit = commits?.[0]?.commit as Record<string, unknown> | undefined
  const rollup = lastCommit?.statusCheckRollup as {
    state: string
    contexts?: { nodes: Array<Record<string, unknown>> }
  } | null
  const headRefOid =
    ((node.headRef as { target?: { oid?: string } } | null)?.target?.oid as string | undefined)
    ?? (lastCommit?.oid as string | undefined)
    ?? ''

  const commentsPayload = node.comments as {
    totalCount?: number
    nodes?: Array<Record<string, unknown>>
  } | undefined
  const comments = (commentsPayload?.nodes || []).map(c => ({
    author: (c.author as { login: string })?.login || 'unknown',
    body: (c.body as string) || '',
    createdAt: (c.createdAt as string) || '',
  }))

  const labels = (
    (node.labels as { nodes?: Array<{ name: string }> } | undefined)?.nodes || []
  ).map(l => ({ name: l.name }))

  const prNumber = node.number as number
  const state = (node.state as string) || 'OPEN'
  const isDraft = node.isDraft as boolean
  const reviewDecision = (node.reviewDecision as string) || null
  const displayStatus =
    state === 'MERGED' ? 'Merged' :
    state === 'CLOSED' ? 'Closed' :
    isDraft ? 'Draft' :
    reviewDecision === 'APPROVED' ? 'Approved' :
    reviewDecision === 'CHANGES_REQUESTED' ? 'Changes req.' :
    'Pending'

  return {
    number: prNumber,
    title: node.title as string,
    url: node.url as string,
    isDraft,
    headRefName: node.headRefName as string,
    baseRefName: (node.baseRefName as string) || '',
    headRefOid,
    additions: node.additions as number,
    deletions: node.deletions as number,
    updatedAt: node.updatedAt as string,
    reviewDecision,
    ciStatus: computeCiStatus(rollup, node.mergeStateStatus as string | null),
    hasMergeConflict: isMergeConflict(node.mergeStateStatus as string | null),
    reviews,
    requestedReviewers,
    comments,
    commentCount: commentsPayload?.totalCount || 0,
    labels,
    author: (node.author as { login: string })?.login || 'unknown',
    linkedTicketId: extractTicketId(node.headRefName as string),
    state,
    mergedAt: (node.mergedAt as string) || null,
    closedAt: (node.closedAt as string) || null,
    displayStatus,
  }
}

/**
 * Request re-review from a single GitHub user for a PR. Wrapped in
 * resilientFetch so transient network failures don't bubble up. Callers
 * loop per-reviewer and handle 422s (self-review, already-requested, etc.)
 * via the returned error string.
 */
export async function requestPRReviewer(
  prNumber: number,
  login: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!GITHUB_TOKEN || !REPO_URL) return { ok: false, error: 'missing GITHUB_TOKEN or REPO_URL' }
  const [owner, repo] = REPO_URL.split('/')
  if (!owner || !repo) return { ok: false, error: 'invalid REPO_URL' }

  try {
    const res = await resilientFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ reviewers: [login] }),
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `${res.status} ${text.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Fetch a PR's lifecycle state. Distinguishes merged from plain closed so
 * callers can refuse to touch merged PRs. Returns null on any failure —
 * callers must treat null as "unknown, do nothing".
 */
export async function fetchPrState(
  prNumber: number,
): Promise<'open' | 'closed' | 'merged' | null> {
  if (!GITHUB_TOKEN || !REPO_URL) return null
  const [owner, repo] = REPO_URL.split('/')
  if (!owner || !repo) return null

  try {
    const res = await resilientFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    if (!res.ok) return null
    const pr = (await res.json()) as { state?: string; merged?: boolean }
    if (pr.merged) return 'merged'
    return pr.state === 'open' ? 'open' : pr.state === 'closed' ? 'closed' : null
  } catch {
    return null
  }
}

/**
 * Fetch the current CI status for the repository's default branch. Used by the
 * poll cycle to pre-check "main broken" before dispatching `fix-ci` against a PR
 * whose failure is actually upstream.
 *
 * Judged on the required contexts, like PR status. Returns null ("unknown") when
 * those contexts don't run on the trunk at all (e.g. a PR-only required check):
 * reading the rollup instead can pin this to FAILURE forever on non-required
 * jobs, so no PR CI fix would ever get dispatched.
 */
export async function fetchMainCiStatus(): Promise<string | null> {
  if (!GITHUB_TOKEN || !REPO_URL) return null
  const [owner, name] = REPO_URL.split('/')
  if (!owner || !name) return null

  const query = `{
    repository(owner: "${owner}", name: "${name}") {
      defaultBranchRef {
        target {
          ... on Commit {
            oid
            statusCheckRollup {
              state
              contexts(last: 100) {
                nodes {
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }`

  try {
    const res = await resilientFetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) return null
    const json = await res.json()
    const target = json.data?.repository?.defaultBranchRef?.target
    const rollup = target?.statusCheckRollup as {
      state: string
      contexts?: { nodes: Array<Record<string, unknown>> }
    } | null

    const oid = target?.oid as string | undefined
    const requiredNames = await fetchRequiredCheckNames()
    if (requiredNames.length && oid) {
      const runs = await fetchRequiredCheckRuns([oid], requiredNames)
      // null = the required contexts never ran on the trunk, so the trunk cannot
      // be called broken. Deliberately not falling back to the rollup here.
      return ciStatusFromRequiredRuns(runs.get(oid) ?? [])
    }
    return computeCiStatus(rollup)
  } catch {
    return null
  }
}

/**
 * Rerun failed GitHub Actions workflow runs for a specific commit SHA.
 * Used by the Phase 2 poll pipeline to auto-retry CI failures that may be
 * infrastructure flakes (e.g. ArgoCD 502s, runner setup errors) before
 * dispatching an expensive fix-ci container.
 *
 * Returns the number of runs that were successfully queued for rerun.
 * If zero failed runs are found, returns ok=true with rerunCount=0 (the
 * failure may be from an external CI provider we can't rerun via Actions API).
 */
export async function rerunFailedWorkflows(headSha: string): Promise<{ ok: boolean; rerunCount: number; error?: string }> {
  if (!GITHUB_TOKEN || !REPO_URL) return { ok: false, rerunCount: 0, error: 'missing GITHUB_TOKEN or REPO_URL' }
  const [owner, repo] = REPO_URL.split('/')
  if (!owner || !repo) return { ok: false, rerunCount: 0, error: 'invalid REPO_URL' }

  try {
    const listRes = await resilientFetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&status=failure&per_page=30`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    if (!listRes.ok) {
      const text = await listRes.text().catch(() => '')
      return { ok: false, rerunCount: 0, error: `list runs ${listRes.status} ${text.slice(0, 200)}` }
    }
    const data = await listRes.json() as { workflow_runs?: Array<{ id: number; conclusion: string | null }> }
    const failedRuns = (data.workflow_runs || []).filter(r => r.conclusion === 'failure')
    if (failedRuns.length === 0) return { ok: true, rerunCount: 0 }

    let rerunCount = 0
    for (const run of failedRuns) {
      try {
        const rerunRes = await resilientFetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/rerun-failed-jobs`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${GITHUB_TOKEN}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        )
        if (rerunRes.ok) rerunCount++
      } catch { /* continue with next run */ }
    }
    return { ok: true, rerunCount }
  } catch (err) {
    return { ok: false, rerunCount: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Fetch specific PRs by number (for backfilling linked PRs not in search results).
 * Uses aliased GraphQL queries to fetch multiple PRs in a single request.
 */
export async function fetchPRsByNumber(prNumbers: number[]): Promise<PullRequest[]> {
  if (!GITHUB_TOKEN || !REPO_URL || prNumbers.length === 0) return []
  const [owner, name] = REPO_URL.split('/')
  if (!owner || !name) return []

  const prQueries = prNumbers.map((n, i) =>
    `pr${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${n}) { ${PR_FRAGMENT_FULL} } }`
  ).join('\n')

  try {
    const res = await resilientFetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: `{ ${prQueries} }` }),
    })
    if (!res.ok) return []
    const json = await res.json()
    const results: PullRequest[] = []
    for (let i = 0; i < prNumbers.length; i++) {
      const node = json.data?.[`pr${i}`]?.pullRequest
      if (node?.number) results.push(mapPR(node))
    }
    // The poll pipeline reads ciStatus from here to decide rerun-ci / dispatch-ci,
    // so it needs the required-check verdict too, not the rollup approximation.
    await applyRequiredCheckStatus(results)
    return results
  } catch {
    return []
  }
}

// Merge-state polls only need displayStatus + mergedAt: the light fragment in
// parallel chunks, and no required-check lookup. The full fragment for ~50 PRs
// in one request exceeded GitHub's budget and returned nothing.
const MERGE_STATE_CHUNK = 20

export async function fetchPRMergeStates(prNumbers: number[]): Promise<PullRequest[]> {
  if (!GITHUB_TOKEN || !REPO_URL || prNumbers.length === 0) return []
  const [owner, name] = REPO_URL.split('/')
  if (!owner || !name) return []

  const unique = [...new Set(prNumbers)]
  const chunks: number[][] = []
  for (let i = 0; i < unique.length; i += MERGE_STATE_CHUNK) {
    chunks.push(unique.slice(i, i + MERGE_STATE_CHUNK))
  }

  const results = await Promise.all(chunks.map(async (chunk) => {
    const prQueries = chunk.map((n, i) =>
      `pr${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${n}) { ${PR_FRAGMENT_LIGHT} } }`
    ).join('\n')
    try {
      const res = await resilientFetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: `{ ${prQueries} }` }),
      })
      if (!res.ok) return []
      const json = await res.json()
      return chunk.flatMap((_, i) => {
        const node = json.data?.[`pr${i}`]?.pullRequest
        return node?.number ? [mapPR(node)] : []
      })
    } catch {
      return []
    }
  }))
  return results.flat()
}

/**
 * For PRs already showing reviewDecision === APPROVED, determine whether
 * GITHUB_USERNAME's outstanding review request was created AFTER the most
 * recent approval — i.e. someone deliberately re-requested review post-approval,
 * as distinct from a stale request that predates the approval and was simply
 * never cleared. Returns the set of PR numbers whose request is a genuine
 * re-ask (should stay visible).
 */
async function fetchPostApprovalReReviewRequests(
  candidates: Array<{ number: number; latestApprovalAt: string }>
): Promise<Set<number>> {
  const fresh = new Set<number>()
  if (!GITHUB_TOKEN || !REPO_URL || candidates.length === 0) return fresh
  const [owner, name] = REPO_URL.split('/')
  if (!owner || !name) return fresh

  const timelineQueries = candidates.map(({ number }, i) =>
    `pr${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) {
      number
      timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) {
        nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
      }
    } }`
  ).join('\n')

  try {
    const res = await resilientFetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: `{ ${timelineQueries} }` }),
    })
    if (!res.ok) return fresh
    const json = await res.json()
    for (let i = 0; i < candidates.length; i++) {
      const { number, latestApprovalAt } = candidates[i]
      const nodes = json.data?.[`pr${i}`]?.pullRequest?.timelineItems?.nodes || []
      const requestTimestamps: string[] = nodes
        .filter((n: Record<string, unknown>) =>
          (n.requestedReviewer as { login?: string } | null)?.login === GITHUB_USERNAME
        )
        .map((n: Record<string, unknown>) => n.createdAt as string)
      const latestRequestAt = requestTimestamps.sort().at(-1)
      // Fail open: if we can't determine timing, keep the PR visible rather
      // than silently drop a review request.
      if (!latestRequestAt || latestRequestAt > latestApprovalAt) fresh.add(number)
    }
  } catch {
    // Fail open: on error, treat all candidates as fresh so nothing is silently dropped.
    for (const { number } of candidates) fresh.add(number)
  }
  return fresh
}

export const EMPTY_PRS: CategorisedPRs = {
  changesRequested: [],
  reviewRequested: [],
  draft: [],
  approved: [],
  commentsToAddress: [],
  pending: [],
  recentlyMerged: [],
  recentlyClosed: [],
}

export async function fetchGitHubData(): Promise<CategorisedPRs> {
  if (!GITHUB_TOKEN || !GITHUB_USERNAME) {
    return EMPTY_PRS
  }

  const repo = REPO_URL // e.g. "acme/webapp"
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const [myPRsNodes, reviewRequestedNodes, recentlyMergedNodes, recentlyClosedNodes] =
    await Promise.all([
      searchPRs('myPRs', `is:pr is:open author:${GITHUB_USERNAME} repo:${repo}`, 30, PR_FRAGMENT_FULL),
      searchPRs('reviewRequested', `is:pr is:open review-requested:${GITHUB_USERNAME} repo:${repo}`, 20, PR_FRAGMENT_FULL),
      searchPRs('recentlyMerged', `is:pr is:merged author:${GITHUB_USERNAME} repo:${repo} merged:>=${thirtyDaysAgo}`, 20, PR_FRAGMENT_FULL),
      searchPRs('recentlyClosed', `is:pr is:closed is:unmerged author:${GITHUB_USERNAME} repo:${repo} closed:>=${thirtyDaysAgo}`, 30, PR_FRAGMENT_LIGHT),
    ])

  // All four down means GitHub itself is unreachable — throw so the caller
  // doesn't cache an all-empty result. A single failed search degrades to an
  // empty section for one cache TTL instead.
  if (!myPRsNodes && !reviewRequestedNodes && !recentlyMergedNodes && !recentlyClosedNodes) {
    throw new Error('all GitHub PR searches failed')
  }

  const myPRs: PullRequest[] = (myPRsNodes || [])
    .filter((n: Record<string, unknown>) => n.number)
    .map(mapPR)

  const reviewRequestedAll: PullRequest[] = (reviewRequestedNodes || [])
    .filter((n: Record<string, unknown>) => n.number)
    .map(mapPR)

  // A PR already showing reviewDecision === APPROVED is usually a stale,
  // never-cleared request — GitHub keeps you on `review-requested:me` until
  // *you personally* submit a review, even once someone else has approved and
  // the merge gate (required_approving_review_count) is satisfied. Drop those.
  // But if the author deliberately re-requested your review AFTER that
  // approval, that's a genuine fresh ask — keep those visible.
  const alreadyApproved = reviewRequestedAll.filter(pr => pr.reviewDecision === 'APPROVED')
  const approvalCandidates: Array<{ number: number; latestApprovalAt: string }> = []
  // Fail open: if the fetched (last: 10) reviews window doesn't contain the
  // approval, we can't safely conclude "stale" — keep the PR visible.
  const reReviewedNumbers = new Set<number>()
  for (const pr of alreadyApproved) {
    const latestApprovalAt = pr.reviews
      .filter(r => r.state === 'APPROVED')
      .map(r => r.submittedAt)
      .filter(Boolean)
      .sort()
      .at(-1)
    if (latestApprovalAt) {
      approvalCandidates.push({ number: pr.number, latestApprovalAt })
    } else {
      reReviewedNumbers.add(pr.number)
    }
  }
  // Both lists feed the CI badge, so both get the required-check verdict. One
  // extra batched request per 3 open PRs, run alongside the re-review lookup.
  const [, postApprovalReReviews] = await Promise.all([
    applyRequiredCheckStatus([...myPRs, ...reviewRequestedAll]),
    fetchPostApprovalReReviewRequests(approvalCandidates),
  ])
  for (const n of postApprovalReReviews) {
    reReviewedNumbers.add(n)
  }

  const reviewRequestedPRs: PullRequest[] = reviewRequestedAll.filter(pr =>
    pr.reviewDecision !== 'APPROVED' || reReviewedNumbers.has(pr.number)
  )

  const recentlyMerged: PullRequest[] = (recentlyMergedNodes || [])
    .filter((n: Record<string, unknown>) => n.number)
    .map(mapPR)

  const recentlyClosed: PullRequest[] = (recentlyClosedNodes || [])
    .filter((n: Record<string, unknown>) => n.number)
    .map(mapPR)

  // Categorise my open PRs
  const changesRequested = myPRs.filter(
    (pr) => pr.reviewDecision === 'CHANGES_REQUESTED',
  )
  const approved = myPRs.filter(
    (pr) => pr.reviewDecision === 'APPROVED' && !pr.isDraft,
  )
  const draft = myPRs.filter(
    (pr) =>
      pr.isDraft &&
      pr.reviewDecision !== 'CHANGES_REQUESTED',
  )
  const commentsToAddress = myPRs.filter(
    (pr) =>
      pr.commentCount > 0 &&
      pr.reviewDecision !== 'CHANGES_REQUESTED' &&
      pr.reviewDecision !== 'APPROVED' &&
      !pr.isDraft,
  )
  const pending = myPRs.filter(
    (pr) =>
      !pr.isDraft &&
      pr.reviewDecision !== 'CHANGES_REQUESTED' &&
      pr.reviewDecision !== 'APPROVED' &&
      pr.commentCount === 0,
  )

  return {
    changesRequested,
    reviewRequested: reviewRequestedPRs,
    draft,
    approved,
    commentsToAddress,
    pending,
    recentlyMerged,
    recentlyClosed,
  }
}
