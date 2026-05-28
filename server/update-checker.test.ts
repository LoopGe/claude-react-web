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
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ version: '99.99.99' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const info = await checkForUpdates(true)
    expect(info.latest).toBe('99.99.99')
    expect(info.hasUpdate).toBe(true)
    expect(info.error).toBeUndefined()
    expect(info.checkedAt).toBeTypeOf('number')
    expect(info.current).toBe(getCurrentVersion())
  })

  it('records a stringified error when the registry rejects the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    )

    const info = await checkForUpdates(true)
    expect(info.error).toMatch(/503/)
    expect(info.hasUpdate).toBe(false)
    expect(getCachedUpdateInfo()).toBe(info)
  })

  it('dedupes concurrent in-flight probes', async () => {
    let resolved = 0
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          // Resolve on a microtask so both callers see the same in-flight
          // promise.
          queueMicrotask(() => {
            resolved += 1
            resolve(
              new Response(JSON.stringify({ version: '0.0.0' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            )
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([checkForUpdates(true), checkForUpdates(true)])
    expect(a).toBe(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(resolved).toBe(1)
  })
})
