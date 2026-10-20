import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { createErrorHandler } from '../errors.js'
import { writeStatusFile, readMarker } from '../daemon/control.js'

vi.mock('../daemon/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/paths.js')>()
  return {
    ...actual,
    isBundledDaemon: vi.fn(() => true),
    resolveDaemonEntryPaths: vi.fn(() => ({ nodePath: '/node', daemonEntry: '/fake/dist/daemon.mjs', serverEntry: '/fake/dist/cli.mjs' })),
  }
})
vi.mock('../daemon/register/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/register/runner.js')>()
  return { ...actual, execRunner: async () => ({ code: 0, stdout: '', stderr: '' }) }
})

const { buildDaemonRouter } = await import('./daemon-routes.js')

function makeApp(stateDir: string) {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildDaemonRouter(stateDir))
  return app
}

function seedConfig(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
  }), 'utf8')
}

describe('/api/daemon', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-routes'); seedConfig(dir); delete process.env.CRW_DAEMON_CHILD })
  afterEach(() => { delete process.env.CRW_DAEMON_CHILD; vi.restoreAllMocks(); rmRf(dir) })

  it('GET /status returns the aggregated snapshot', async () => {
    const res = await makeApp(dir).request('/daemon/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ supported: true, configEnabled: false, daemonAlive: false, drift: false, mechanism: expect.any(String) })
  })

  it('POST /enable writes config.autoStart (registration stubbed green)', async () => {
    const res = await makeApp(dir).request('/daemon/enable', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { configEnabled: boolean }).configEnabled).toBe(true)
  })

  it('POST /disable clears config.autoStart', async () => {
    await makeApp(dir).request('/daemon/enable', { method: 'POST' })
    const res = await makeApp(dir).request('/daemon/disable', { method: 'POST' })
    expect(((await res.json()) as { configEnabled: boolean }).configEnabled).toBe(false)
  })

  it('POST /start with a live-but-childless daemon writes the start marker (no spawn)', async () => {
    await writeStatusFile(dir, {
      daemonPid: process.pid, childPid: null, state: 'stopped', startedAt: Date.now(),
      childStartedAt: null, restartCount: 0, consecutiveFailures: 0,
      lastError: null, lastExitReason: null, updatedAt: Date.now(),
    })
    const res = await makeApp(dir).request('/daemon/start', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await readMarker(dir, 'start')).toBe(true)
  })

  it('POST /stop writes the marker only for a daemon child and reuses the shutdown seam', async () => {
    process.env.CRW_DAEMON_CHILD = '1'
    const { registerShutdownRequest } = await import('../daemon/shutdown-request.js')
    const shutdownSpy = vi.fn(async () => {})
    registerShutdownRequest(shutdownSpy)
    const res = await makeApp(dir).request('/daemon/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { stopping: boolean }).stopping).toBe(true)
    expect(await readMarker(dir, 'stop')).toBe(true)
    // the shutdown seam fires ~100ms after the response flushes
    await new Promise((r) => setTimeout(r, 200))
    expect(shutdownSpy).toHaveBeenCalledTimes(1)
  })

  it('POST /stop on a manually-started server does NOT leave a marker (Review Focus #1)', async () => {
    const res = await makeApp(dir).request('/daemon/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await readMarker(dir, 'stop')).toBe(false)
  })
})
