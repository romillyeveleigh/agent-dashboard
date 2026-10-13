import { describe, expect, it } from 'vitest'
import { countHumanComments, isBotOrSelf } from '../bot-filter'

describe('isBotOrSelf', () => {
  it('treats renovate and renovate[bot] as the same bot', () => {
    expect(isBotOrSelf('renovate')).toBe(true)
    expect(isBotOrSelf('renovate[bot]')).toBe(true)
  })

  it('drops Linear and Nx automation comments that GitHub does not suffix with [bot]', () => {
    expect(isBotOrSelf('linear-code')).toBe(true)
    expect(isBotOrSelf('nx-cloud')).toBe(true)
  })

  it('keeps a human reviewer', () => {
    expect(isBotOrSelf('alice')).toBe(false)
  })
})

describe('countHumanComments', () => {
  it('counts 0 on a PR that only has Linear, Renovate, Nx, and author comments', () => {
    const prevUser = process.env.GITHUB_USERNAME
    process.env.GITHUB_USERNAME = 'octocat'
    try {
      expect(countHumanComments({
        comments: [
          { author: 'linear-code', body: 'linkback', createdAt: '' },
          { author: 'octocat', body: 'note', createdAt: '' },
          { author: 'renovate', body: 'automation', createdAt: '' },
          { author: 'nx-cloud', body: 'fix-ci', createdAt: '' },
        ],
        reviews: [],
      })).toBe(0)
    } finally {
      if (prevUser === undefined) delete process.env.GITHUB_USERNAME
      else process.env.GITHUB_USERNAME = prevUser
    }
  })
})
