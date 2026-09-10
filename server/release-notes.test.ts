// Tests for server/release-notes.ts — GitHub Releases fetch, range
// filtering, caching, and failure degradation. No route tests here (those
// live in update-routes.test.ts once the route is mounted).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { __resetReleaseNotesForTests, getReleaseNotes } from './release-notes.js'

/** Fake GitHub release objects covering the filter matrix: stable in-range
 *  (0.7.3, 0.8.0), stable below range (0.7.1), prerelease tag (0.9.0-rc.1),
 *  API-prerelease flag, draft, unparseable tag (`nightly`), and above `to`. */
function ghRelease(over: Record<string, unknown> = {}) {
  return {
    tag_name: 'v0.8.0',
    name: '0.8.0',
    body: 'body text',
    published_at: '2026-09-10T00:00:00Z',
    html_url: 'https://github.com/LoopGe/claude-react-web/releases/tag/v0.8.0',
    draft: false,
    prerelease: false,
    ...over,
  }
}

const FULL_LIST = [
  ghRelease({ tag_name: 'v0.9.0-rc.1' }),          // prerelease tag — skip
  ghRelease({ tag_name: 'v0.8.5', name: 'above to' }), // > to — skip
  ghRelease({ tag_name: 'v0.8.0' }),
  ghRelease({ tag_name: '0.7.3', name: 'no v prefix', body: 'older notes' }),
  ghRelease({ tag_name: 'v0.7.2', name: 'equal to from' }), // from excluded
  ghRelease({ tag_name: 'nightly' }),               // unparseable — skip
  ghRelease({ tag_name: 'v0.8.1', draft: true }),   // draft — skip
  ghRelease({ tag_name: 'v0.8.2', prerelease: true }), // API prerelease — skip
]

function stubGitHub(body: unknown = FULL_LIST, status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('getReleaseNotes', () => {
  beforeEach(() => {
    __resetReleaseNotesForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('filters to (from, to], strips v-prefix, sorts DESC', async () => {
    stubGitHub()
    const res = await getReleaseNotes('0.7.2', '0.8.0')
    expect(res.error).toBeUndefined()
    expect(res.releases.map((r) => r.version)).toEqual(['0.8.0', '0.7.3'])
    expect(res.releases[0]).toMatchObject({
      name: '0.8.0',
      body: 'body text',
      publishedAt: '2026-09-10T00:00:00Z',
      url: 'https://github.com/LoopGe/claude-react-web/releases/tag/v0.8.0',
    })
    expect(res.from).toBe('0.7.2')
    expect(res.to).toBe('0.8.0')
    expect(typeof res.checkedAt).toBe('number')
  })

  it('returns empty releases + error on a 403 (rate limit)', async () => {
    stubGitHub({ message: 'API rate limit exceeded' }, 403)
    const res = await getReleaseNotes('0.7.0', '0.8.0')
    expect(res.releases).toEqual([])
    expect(res.error).toMatch(/rate limit|403/i)
  })

  it('returns empty releases + error on a network throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const res = await getReleaseNotes('0.7.0', '0.8.0')
    expect(res.releases).toEqual([])
    expect(res.error).toBeTruthy()
  })

  it('serves the cached result within the TTL (one fetch for two calls)', async () => {
    const fetchMock = stubGitHub()
    await getReleaseNotes('0.7.2', '0.8.0')
    await getReleaseNotes('0.7.2', '0.8.0')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent calls into one fetch', async () => {
    let resolveFetch!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { resolveFetch = res })))
    const p1 = getReleaseNotes('0.7.2', '0.8.0')
    const p2 = getReleaseNotes('0.7.2', '0.8.0')
    resolveFetch(new Response(JSON.stringify([]), { status: 200 }))
    await Promise.all([p1, p2])
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('cache is keyed by the (from, to) pair', async () => {
    const fetchMock = stubGitHub()
    await getReleaseNotes('0.7.2', '0.8.0')
    await getReleaseNotes('0.7.0', '0.8.0') // different pair → new fetch
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('short-circuits to an error result when the registry is disabled', async () => {
    const { __setConfigForTest } = await import('./config.js')
    __setConfigForTest({ updateCheckRegistry: '' })
    const fetchMock = stubGitHub()
    const res = await getReleaseNotes('0.7.2', '0.8.0')
    expect(res.releases).toEqual([])
    expect(res.error).toMatch(/not configured/i)
    expect(fetchMock).not.toHaveBeenCalled()
    __setConfigForTest({ updateCheckRegistry: 'https://registry.npmjs.org' })
  })
})
