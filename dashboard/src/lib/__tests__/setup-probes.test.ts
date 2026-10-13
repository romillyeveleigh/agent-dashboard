import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { probeField } from '../setup-probes'

const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe('DASHBOARD_URL probe', () => {
  it('accepts a valid URL with port', async () => {
    const r = await probeField('DASHBOARD_URL', 'http://host.docker.internal:3000')
    expect(r.ok).toBe(true)
  })
  it('rejects a non-URL', async () => {
    const r = await probeField('DASHBOARD_URL', 'not-a-url')
    expect(r.ok).toBe(false)
  })
})

describe('CLAUDE_CODE_OAUTH_TOKEN probe', () => {
  it('accepts the expected prefix', async () => {
    const r = await probeField('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-abc')
    expect(r.ok).toBe(true)
  })
  it('rejects bad prefix', async () => {
    const r = await probeField('CLAUDE_CODE_OAUTH_TOKEN', 'wrong-prefix')
    expect(r.ok).toBe(false)
  })
})

describe('GITHUB_TOKEN probe', () => {
  it('returns ok with login on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ login: 'octocat' }))
    const r = await probeField('GITHUB_TOKEN', 'ghp_abc')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('octocat')
    expect(r.detail?.suggestedFill).toEqual({ field: 'GITHUB_USERNAME', value: 'octocat' })
    expect(r.dependsOn).toContain('GITHUB_USERNAME')
    expect(r.dependsOn).toContain('REPO_URL')
  })
  it('returns auth error on 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401))
    const r = await probeField('GITHUB_TOKEN', 'ghp_bad')
    expect(r.ok).toBe(false)
    expect(r.warning).toBeFalsy()
  })
  it('returns warning on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    const r = await probeField('GITHUB_TOKEN', 'ghp_x')
    expect(r.ok).toBe(false)
    expect(r.warning).toBe(true)
  })
})

describe('ANTHROPIC_API_KEY probe', () => {
  it('returns ok with model count on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }))
    const r = await probeField('ANTHROPIC_API_KEY', 'sk-ant-api03-abc')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('2 models')
  })
  it('rejects bad prefix without making request', async () => {
    const r = await probeField('ANTHROPIC_API_KEY', 'wrong')
    expect(r.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('returns auth error on 403', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403))
    const r = await probeField('ANTHROPIC_API_KEY', 'sk-ant-api03-bad')
    expect(r.ok).toBe(false)
  })
})

describe('REPO_URL probe', () => {
  it('defers without GITHUB_TOKEN', async () => {
    const r = await probeField('REPO_URL', 'org/repo')
    expect(r.ok).toBe(true)
    expect(r.warning).toBe(true)
    expect(r.message).toContain('after GitHub token')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects bad format', async () => {
    const r = await probeField('REPO_URL', 'not-a-repo')
    expect(r.ok).toBe(false)
  })
  it('verifies with token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ full_name: 'org/repo', default_branch: 'main' }))
    const r = await probeField('REPO_URL', 'org/repo', { githubToken: 'ghp_x' })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('main')
  })
  it('returns 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404))
    const r = await probeField('REPO_URL', 'org/repo', { githubToken: 'ghp_x' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('not found')
  })
})

describe('LINEAR_API_KEY probe', () => {
  it('returns ok with the authenticated user', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { viewer: { name: 'Ada' } },
    }))
    const r = await probeField('LINEAR_API_KEY', 'lin_api_x')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('Ada')
  })
})
