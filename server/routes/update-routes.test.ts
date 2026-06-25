// Tests for POST /api/update. We mock install-method (to drive each branch)
// and npm-install (so no real npm spawns). The GET /update-info path is
// covered by update-checker.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'

import { createErrorHandler } from '../errors.js'
import { __setConfigForTest } from '../config.js'
import {
  __resetUpdateCheckerForTests,
  checkForUpdates,
  checkForVersions,
  getCachedUpdateInfo,
} from '../update-checker.js'

// vi.mock factories are hoisted above module-scope consts, so the mock fns
// must be created inside vi.hoisted to avoid a TDZ ReferenceError.
const { detectInstallMethod, runNpmInstall, readInstalledVersion } = vi.hoisted(() => ({
  detectInstallMethod: vi.fn<() => 'global' | 'npx' | 'unknown'>(),
  runNpmInstall:
    vi.fn<(pkg: string, registry?: string, version?: string) => Promise<{ stdout: string; stderr: string }>>(),
  readInstalledVersion: vi.fn<(expectedName: string) => string | null>(),
}))

vi.mock('../install-method.js', () => ({ detectInstallMethod }))
vi.mock('../npm-install.js', () => ({ runNpmInstall }))
vi.mock('../installed-version.js', () => ({ readInstalledVersion }))

// Import the router AFTER the mocks are registered.
const { buildUpdateRouter } = await import('./update-routes.js')

function makeApp() {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildUpdateRouter())
  return app
}

const TEST_REGISTRY = 'https://registry.example.com'

/** A small fake packument: stable versions 0.5.7 / 0.5.8 / 0.5.9 plus a
 *  prerelease (which the switcher must filter out) and `0.6.0` as latest.
 *  Version 0.5.8 is deprecated (with a message); 0.5.7 is deprecated
 *  without a message (true). */
const PACKUMENT = {
  versions: {
    '0.5.7': { deprecated: true },
    '0.5.8': { deprecated: 'Critical bug — use 0.5.9 or later.' },
    '0.5.8-rc.1': {},
    '0.5.9': {},
    '0.6.0': {},
  },
  'dist-tags': { latest: '0.6.0' },
}

/** Stub `fetch` so the dist-tag endpoint (`/<pkg>/latest`) returns `version`
 *  and the packument endpoint (`/<pkg>`, no `/latest`) returns the full
 *  PACKUMENT. The version-switcher hits the packument; the existing update
 *  path hits the dist-tag. */
function stubRegistryFetch(latestVersion = '0.6.0') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const s = String(url)
      if (s.endsWith('/latest')) {
        return new Response(JSON.stringify({ version: latestVersion }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(PACKUMENT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

async function primeUpdateInfo() {
  // Seed the cached UpdateInfo with a real "update available" snapshot so
  // the route reads packageName/registry from it.
  __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
  detectInstallMethod.mockReturnValue('global')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ version: '99.99.99' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
  await checkForUpdates(true)
  vi.unstubAllGlobals()
}

describe('POST /api/update', () => {
  beforeEach(() => {
    __resetUpdateCheckerForTests()
    detectInstallMethod.mockReset()
    runNpmInstall.mockReset()
    runNpmInstall.mockResolvedValue({ stdout: 'ok', stderr: '' })
    readInstalledVersion.mockReset()
    // Default: on-disk version matches the running build (no-op install).
    readInstalledVersion.mockReturnValue(null)
  })

  it('runs the install for npx installs too', async () => {
    await primeUpdateInfo()
    detectInstallMethod.mockReturnValue('npx')
    readInstalledVersion.mockReturnValue('99.99.99')

    const res = await makeApp().request('/update', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      performed: true,
      installMethod: 'npx',
      restartRequired: true,
    })
    expect(runNpmInstall).toHaveBeenCalled()
  })

  it('runs the install for unknown (dev) installs too', async () => {
    await primeUpdateInfo()
    detectInstallMethod.mockReturnValue('unknown')
    readInstalledVersion.mockReturnValue('99.99.99')

    const res = await makeApp().request('/update', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      performed: true,
      installMethod: 'unknown',
      restartRequired: true,
    })
    expect(runNpmInstall).toHaveBeenCalled()
  })

  it('runs the install for a global install with server-trusted args', async () => {
    await primeUpdateInfo()
    detectInstallMethod.mockReturnValue('global')
    // After install, the on-disk package.json reports the new version — newer
    // than the running build — so the update verifiably landed.
    readInstalledVersion.mockReturnValue('99.99.99')

    const res = await makeApp().request('/update', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      performed: true,
      installMethod: 'global',
      restartRequired: true,
      latest: '99.99.99',
      installedVersion: '99.99.99',
      updateApplied: true,
    })
    // No-body POST → the dist-tag upgrade path → version arg is undefined.
    expect(runNpmInstall).toHaveBeenCalledWith('claude-react-web', TEST_REGISTRY, undefined)
  })

  it('reports a no-op install when the on-disk version did not advance', async () => {
    await primeUpdateInfo()
    detectInstallMethod.mockReturnValue('global')
    // npm reported "up to date" — on-disk version unchanged from the running
    // build (getCurrentVersion()). updateApplied must stay false and no
    // restart should be advertised.
    const { getCurrentVersion } = await import('../update-checker.js')
    readInstalledVersion.mockReturnValue(getCurrentVersion())

    const res = await makeApp().request('/update', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      performed: boolean
      updateApplied: boolean
      restartRequired?: boolean
      installedVersion: string
    }
    expect(body.performed).toBe(true)
    expect(body.updateApplied).toBe(false)
    expect(body.restartRequired).toBe(false)
    expect(body.installedVersion).toBe(getCurrentVersion())
  })

  it('returns 400 when update checks are disabled', async () => {
    __setConfigForTest({ updateCheckRegistry: '' })
    await checkForUpdates(true) // builds a disabled snapshot
    detectInstallMethod.mockReturnValue('global')

    const res = await makeApp().request('/update', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(runNpmInstall).not.toHaveBeenCalled()
  })

  it('surfaces install failures as the HttpError status', async () => {
    await primeUpdateInfo()
    detectInstallMethod.mockReturnValue('global')
    const { HttpError } = await import('../errors.js')
    runNpmInstall.mockRejectedValueOnce(new HttpError(500, 'npm exited 1: boom'))

    const res = await makeApp().request('/update', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/boom/)
  })

  it('pins a published version on POST /update { version } and signals versionChanged', async () => {
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
    detectInstallMethod.mockReturnValue('global')
    stubRegistryFetch('0.6.0')
    // Warm the versions cache so the route's validation can find 0.5.8.
    await checkForVersions(true)

    // On-disk version after install is the pinned 0.5.8 — older than the
    // running build — so updateApplied is false but versionChanged is true
    // (a restart applies the downgrade).
    readInstalledVersion.mockReturnValue('0.5.8')

    const res = await makeApp().request('/update', {
      method: 'POST',
      body: JSON.stringify({ version: '0.5.8' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      performed: boolean
      targetVersion: string
      installedVersion: string
      versionChanged: boolean
      updateApplied: boolean
      restartRequired: boolean
    }
    expect(body.performed).toBe(true)
    expect(body.targetVersion).toBe('0.5.8')
    expect(body.installedVersion).toBe('0.5.8')
    expect(body.versionChanged).toBe(true)
    expect(body.updateApplied).toBe(false)
    expect(body.restartRequired).toBe(true)
    // The argv must carry the pinned version, server-validated.
    expect(runNpmInstall).toHaveBeenCalledWith('claude-react-web', TEST_REGISTRY, '0.5.8')

    vi.unstubAllGlobals()
  })

  it('rejects a non-published version with 400 and does not spawn npm', async () => {
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
    detectInstallMethod.mockReturnValue('global')
    stubRegistryFetch('0.6.0')
    await checkForVersions(true)

    const res = await makeApp().request('/update', {
      method: 'POST',
      body: JSON.stringify({ version: '9.9.9' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(400)
    expect(runNpmInstall).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('treats version === "latest" as the no-body upgrade path', async () => {
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
    detectInstallMethod.mockReturnValue('global')
    stubRegistryFetch('0.6.0')
    await checkForUpdates(true) // warm the latest cache

    const res = await makeApp().request('/update', {
      method: 'POST',
      body: JSON.stringify({ version: 'latest' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { targetVersion?: string }
    // No targetVersion — 'latest' is the dist-tag path, not a pin. The
    // install gets the version arg as undefined (→ `@latest`), matching the
    // no-body upgrade path.
    expect(body.targetVersion).toBeUndefined()
    expect(runNpmInstall).toHaveBeenCalledWith('claude-react-web', TEST_REGISTRY, undefined)

    vi.unstubAllGlobals()
  })

  it('no-op when pinning the currently-running version', async () => {
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
    detectInstallMethod.mockReturnValue('global')
    stubRegistryFetch('0.6.0')
    await checkForVersions(true)
    const { getCurrentVersion } = await import('../update-checker.js')
    const current = getCurrentVersion()

    // The running version must be in the published list for the pin to
    // validate. Inject it by re-stubbing with a packument that includes it.
    const packumentWithCurrent = {
      versions: { ...PACKUMENT.versions, [current]: {} },
      'dist-tags': { latest: '0.6.0' },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const s = String(url)
        if (s.endsWith('/latest')) {
          return new Response(JSON.stringify({ version: '0.6.0' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify(packumentWithCurrent), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    await checkForVersions(true)

    readInstalledVersion.mockReturnValue(current)
    const res = await makeApp().request('/update', {
      method: 'POST',
      body: JSON.stringify({ version: current }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { versionChanged: boolean; restartRequired: boolean }
    expect(body.versionChanged).toBe(false)
    expect(body.restartRequired).toBe(false)

    vi.unstubAllGlobals()
  })
})

describe('GET /api/update-info/versions', () => {
  beforeEach(() => {
    __resetUpdateCheckerForTests()
    detectInstallMethod.mockReset()
    detectInstallMethod.mockReturnValue('global')
    readInstalledVersion.mockReset()
    readInstalledVersion.mockReturnValue(null)
  })

  it('returns stable versions, descending, with prereleases filtered out', async () => {
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
    stubRegistryFetch('0.6.0')
    // Warm the latest cache so the versions endpoint can overlay `latest`
    // (it reads the dist-tag from the separate latest probe, like the UI's
    // banner does on mount).
    await checkForUpdates(true)

    const res = await makeApp().request('/update-info/versions?force=1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { versions: string[]; latest?: string }
    expect(body.versions).toEqual(['0.6.0', '0.5.9', '0.5.8', '0.5.7'])
    expect(body.versions).not.toContain('0.5.8-rc.1')
    expect(body.latest).toBe('0.6.0')

    vi.unstubAllGlobals()
  })

  it('returns deprecatedVersions for versions marked deprecated in the packument', async () => {
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
    stubRegistryFetch('0.6.0')
    await checkForUpdates(true)

    const res = await makeApp().request('/update-info/versions?force=1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deprecatedVersions?: string[] }
    // 0.5.7 (deprecated: true) and 0.5.8 (deprecated: string) should both
    // appear. 0.5.8-rc.1 is a prerelease and filtered from the main list,
    // so it won't appear in deprecatedVersions either.
    expect(body.deprecatedVersions).toContain('0.5.7')
    expect(body.deprecatedVersions).toContain('0.5.8')
    expect(body.deprecatedVersions).not.toContain('0.5.9')
    expect(body.deprecatedVersions).not.toContain('0.6.0')

    vi.unstubAllGlobals()
  })

  it('returns a disabled snapshot when no registry is configured', async () => {
    __setConfigForTest({ updateCheckRegistry: '' })
    const res = await makeApp().request('/update-info/versions')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { disabled?: boolean; versions: string[] }
    expect(body.disabled).toBe(true)
    expect(body.versions).toEqual([])
  })
})

describe('GET /api/update-info?registry= override', () => {
  beforeEach(() => {
    __resetUpdateCheckerForTests()
    detectInstallMethod.mockReset()
    detectInstallMethod.mockReturnValue('global')
    readInstalledVersion.mockReset()
    readInstalledVersion.mockReturnValue(null)
  })

  it('probes the supplied registry instead of the saved config', async () => {
    // Saved config points at one registry; the override asks for another.
    __setConfigForTest({ updateCheckRegistry: 'https://saved.example.com' })
    // Type the mock's params (URL-like first arg) so `mock.calls[0][0]` is a
    // string rather than an empty-tuple element (TS2493) below.
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ version: '42.0.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await makeApp().request(
      `/update-info?registry=${encodeURIComponent(TEST_REGISTRY)}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { registry?: string; latest?: string }
    expect(body.registry).toBe(TEST_REGISTRY)
    expect(body.latest).toBe('42.0.0')
    // The fetched URL must be built from the OVERRIDE, not the saved value.
    expect(fetchMock.mock.calls[0]?.[0]).toContain(TEST_REGISTRY)
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('saved.example.com')

    vi.unstubAllGlobals()
  })

  it('does not mutate the shared cache', async () => {
    __setConfigForTest({ updateCheckRegistry: '' }) // saved = disabled
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ version: '42.0.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    await makeApp().request(`/update-info?registry=${encodeURIComponent(TEST_REGISTRY)}`)

    // The cache must still reflect the saved (disabled) state — the override
    // probe is one-off and must not leak into getCachedUpdateInfo().
    const cached = getCachedUpdateInfo()
    expect(cached.latest).toBeUndefined()

    vi.unstubAllGlobals()
  })

  it('returns a disabled snapshot for an empty registry override', async () => {
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await makeApp().request('/update-info?registry=')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { disabled?: boolean }
    expect(body.disabled).toBe(true)
    // Empty override means "test disabled" — no network probe at all.
    expect(fetchMock).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })
})
