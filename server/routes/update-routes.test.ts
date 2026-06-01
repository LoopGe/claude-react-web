// Tests for POST /api/update. We mock install-method (to drive each branch)
// and npm-install (so no real npm spawns). The GET /update-info path is
// covered by update-checker.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'

import { createErrorHandler } from '../errors.js'
import { __setConfigForTest } from '../config.js'
import { __resetUpdateCheckerForTests, checkForUpdates } from '../update-checker.js'

// vi.mock factories are hoisted above module-scope consts, so the mock fns
// must be created inside vi.hoisted to avoid a TDZ ReferenceError.
const { detectInstallMethod, runNpmInstall } = vi.hoisted(() => ({
  detectInstallMethod: vi.fn<() => 'global' | 'npx' | 'unknown'>(),
  runNpmInstall:
    vi.fn<(pkg: string, registry?: string) => Promise<{ stdout: string; stderr: string }>>(),
}))

vi.mock('../install-method.js', () => ({ detectInstallMethod }))
vi.mock('../npm-install.js', () => ({ runNpmInstall }))

// Import the router AFTER the mocks are registered.
const { buildUpdateRouter } = await import('./update-routes.js')

function makeApp() {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildUpdateRouter())
  return app
}

const TEST_REGISTRY = 'https://registry.example.com'

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
  })

  it('short-circuits for npx without spawning an install', async () => {
    detectInstallMethod.mockReturnValue('npx')
    const res = await makeApp().request('/update', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      performed: false,
      installMethod: 'npx',
      fallbackToCopyCommand: true,
    })
    expect(runNpmInstall).not.toHaveBeenCalled()
  })

  it('short-circuits for unknown installs', async () => {
    detectInstallMethod.mockReturnValue('unknown')
    const res = await makeApp().request('/update', { method: 'POST' })
    const body = (await res.json()) as { performed: boolean; fallbackToCopyCommand: boolean }
    expect(body.performed).toBe(false)
    expect(body.fallbackToCopyCommand).toBe(true)
    expect(runNpmInstall).not.toHaveBeenCalled()
  })

  it('runs the install for a global install with server-trusted args', async () => {
    await primeUpdateInfo()
    detectInstallMethod.mockReturnValue('global')

    const res = await makeApp().request('/update', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      performed: true,
      installMethod: 'global',
      restartRequired: true,
      latest: '99.99.99',
    })
    expect(runNpmInstall).toHaveBeenCalledWith('@mi/claude-react-web', TEST_REGISTRY)
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
})
