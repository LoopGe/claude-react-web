import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __setConfigForTest } from './config.js'
import {
  __resetUpdateCheckerForTests,
  checkForUpdates,
  getCachedUpdateInfo,
  getCurrentVersion,
  isVersionNewer,
} from './update-checker.js'

const TEST_REGISTRY = 'https://registry.example.com'

describe('isVersionNewer', () => {
  it('returns true when patch / minor / major bumps', () => {
    expect(isVersionNewer('0.3.8', '0.3.9')).toBe(true)
    expect(isVersionNewer('0.3.99', '0.4.0')).toBe(true)
    expect(isVersionNewer('1.2.3', '2.0.0')).toBe(true)
  })

  it('returns false when current and latest are equal', () => {
    expect(isVersionNewer('0.3.8', '0.3.8')).toBe(false)
  })

  it('returns false when latest is older', () => {
    expect(isVersionNewer('0.4.0', '0.3.99')).toBe(false)
    expect(isVersionNewer('1.0.0', '0.99.99')).toBe(false)
  })

  it('treats pre-release versions as not-newer', () => {
    // We never prompt users to install a pre-release, even if its
    // numeric segments are higher.
    expect(isVersionNewer('1.0.0', '1.1.0-rc.1')).toBe(false)
    expect(isVersionNewer('1.0.0-rc.1', '1.0.1')).toBe(false)
  })

  it('ignores build metadata (`+build`) per semver', () => {
    // `+build…` is metadata, not a prerelease — it must NOT block the
    // upgrade prompt. Only `-pre…` makes a version count as prerelease.
    expect(isVersionNewer('1.2.3', '1.2.4+build42')).toBe(true)
    expect(isVersionNewer('1.2.3+sha.abc', '1.2.4')).toBe(true)
    expect(isVersionNewer('1.2.3+a', '1.2.3+b')).toBe(false) // same numeric → not newer
    // Combined: prerelease with build metadata still counts as prerelease.
    expect(isVersionNewer('1.0.0', '2.0.0-rc.1+build')).toBe(false)
  })

  it('returns false on unparseable input rather than throwing', () => {
    expect(isVersionNewer('not-a-version', '1.0.0')).toBe(false)
    expect(isVersionNewer('1.0.0', '')).toBe(false)
  })
})

describe('checkForUpdates', () => {
  beforeEach(() => {
    __resetUpdateCheckerForTests()
    // Default: registry is configured so the fetch path runs. Individual
    // tests override (e.g. the disabled-feature test sets it to '').
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
  })

  afterEach(() => {
    __setConfigForTest({ updateCheckRegistry: '' })
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('returns a disabled snapshot and does not fetch when registry is empty', async () => {
    __setConfigForTest({ updateCheckRegistry: '' })
    const fetchMock = vi.fn(async () => new Response('should not be called', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const info = await checkForUpdates(true)
    expect(info.disabled).toBe(true)
    expect(info.hasUpdate).toBe(false)
    expect(info.checkedAt).toBeUndefined()
    expect(info.latest).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records the registry response and computes hasUpdate', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({ version: '99.99.99' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // Packument for deprecation check — current version not deprecated.
      return new Response(
        JSON.stringify({ versions: { [getCurrentVersion()]: { version: getCurrentVersion() } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const info = await checkForUpdates(true)
    expect(info.latest).toBe('99.99.99')
    expect(info.hasUpdate).toBe(true)
    expect(info.error).toBeUndefined()
    expect(info.deprecated).toBeUndefined()
    expect(info.checkedAt).toBeTypeOf('number')
    expect(info.current).toBe(getCurrentVersion())
    // installMethod must be populated on every snapshot so the client can
    // decide whether to offer the in-app update button.
    expect(['global', 'npx', 'unknown']).toContain(info.installMethod)
  })

  it('populates installMethod on the disabled snapshot too', async () => {
    __setConfigForTest({ updateCheckRegistry: '' })
    const info = await checkForUpdates(true)
    expect(info.disabled).toBe(true)
    expect(['global', 'npx', 'unknown']).toContain(info.installMethod)
  })

  it('records a stringified error when the registry rejects the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    )

    const info = await checkForUpdates(true)
    expect(info.error).toMatch(/503/)
    expect(info.hasUpdate).toBe(false)
    // getCachedUpdateInfo() returns the cached snapshot with a fresh on-disk
    // `installed` overlaid (so the value reflects an in-app update without
    // waiting out the probe TTL). It's the same data, not necessarily the
    // same object reference.
    expect(getCachedUpdateInfo()).toMatchObject(info)
  })

  it('uses a literal slash in scope names so Artifactory accepts the URL', async () => {
    // Regression: encoding `/` to `%2F` makes Artifactory's npm endpoint
    // return 404 on the dist-tag path (`…/<scope>%2F<name>/latest`).
    // Every registry we care about accepts the literal-slash form, so we
    // send that instead. See update-checker.ts for the full story.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({ version: '0.0.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({ versions: { [getCurrentVersion()]: { version: getCurrentVersion() } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    await checkForUpdates(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Both fetch calls should use literal slashes — check the first (latest).
    const args = fetchMock.mock.calls[0] as unknown as unknown[]
    const url = args[0] as string
    expect(url).not.toContain('%2F')
    expect(url).toContain('/claude-react-web/latest')
    // And the second (packument for deprecation).
    const args2 = fetchMock.mock.calls[1] as unknown as unknown[]
    const url2 = args2[0] as string
    expect(url2).not.toContain('%2F')
    expect(url2).toContain('/claude-react-web')
    expect(url2).not.toContain('/latest')
  })

  it('includes deprecation message when the current version is deprecated', async () => {
    const deprecationMsg = 'Critical security vulnerability — upgrade immediately.'
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({ version: '99.99.99' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // Current version is deprecated.
      return new Response(
        JSON.stringify({
          versions: {
            [getCurrentVersion()]: { version: getCurrentVersion(), deprecated: deprecationMsg },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const info = await checkForUpdates(true)
    expect(info.deprecated).toBe(deprecationMsg)
    expect(info.latest).toBe('99.99.99')
    expect(info.hasUpdate).toBe(true)
  })

  it('includes deprecated=true when the version is deprecated without a message', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({ version: '99.99.99' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          versions: {
            [getCurrentVersion()]: { version: getCurrentVersion(), deprecated: true },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const info = await checkForUpdates(true)
    expect(info.deprecated).toBe(true)
  })

  it('sets deprecated to undefined when the version is not deprecated', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({ version: '99.99.99' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          versions: {
            [getCurrentVersion()]: { version: getCurrentVersion() },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const info = await checkForUpdates(true)
    expect(info.deprecated).toBeUndefined()
  })

  it('still reports latest when the deprecation probe fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({ version: '99.99.99' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // Packument fetch fails — e.g. network hiccup.
      return new Response('boom', { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const info = await checkForUpdates(true)
    // The latest probe succeeded, so hasUpdate is still computed.
    expect(info.latest).toBe('99.99.99')
    expect(info.hasUpdate).toBe(true)
    // Deprecation is best-effort — a failure means we don't know, not that
    // it's deprecated.
    expect(info.deprecated).toBeUndefined()
    // No overall error — the primary probe succeeded.
    expect(info.error).toBeUndefined()
  })

  it('dedupes concurrent in-flight probes', async () => {
    let resolved = 0
    const fetchMock = vi.fn(
      async (url: string) =>
        new Promise<Response>((resolve) => {
          // Resolve on a microtask so both callers see the same in-flight
          // promise.
          queueMicrotask(() => {
            resolved += 1
            if (url.endsWith('/latest')) {
              resolve(
                new Response(JSON.stringify({ version: '0.0.0' }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              )
            } else {
              resolve(
                new Response(
                  JSON.stringify({ versions: { [getCurrentVersion()]: { version: getCurrentVersion() } } }),
                  { status: 200, headers: { 'content-type': 'application/json' } },
                ),
              )
            }
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([checkForUpdates(true), checkForUpdates(true)])
    expect(a).toBe(b)
    // Two fetch calls (latest + packument) per probe, but only one probe
    // runs due to dedup — so 2 total, not 4.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(resolved).toBe(2)
  })
})
