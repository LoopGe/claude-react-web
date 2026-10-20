import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { isDaemonChild, requestStop, requestRestart } from './server-bridge.js'
import { registerShutdownRequest, requestShutdown } from './shutdown-request.js'
import { readMarker } from './control.js'

describe('server bridge', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-bridge'); delete process.env.CRW_DAEMON_CHILD })
  afterEach(() => { delete process.env.CRW_DAEMON_CHILD; rmRf(dir) })

  it('isDaemonChild reads the env marker', () => {
    expect(isDaemonChild()).toBe(false)
    process.env.CRW_DAEMON_CHILD = '1'
    expect(isDaemonChild()).toBe(true)
  })

  it('does NOT write the stop marker outside a daemon (Review Focus #1)', async () => {
    await requestStop(dir)
    expect(await readMarker(dir, 'stop')).toBe(false)
    process.env.CRW_DAEMON_CHILD = '1'
    await requestStop(dir)
    expect(await readMarker(dir, 'stop')).toBe(true)
  })

  it('requestRestart follows the same guard', async () => {
    await requestRestart(dir)
    expect(await readMarker(dir, 'restart')).toBe(false)
    process.env.CRW_DAEMON_CHILD = '1'
    await requestRestart(dir)
    expect(await readMarker(dir, 'restart')).toBe(true)
  })
})

describe('shutdown request seam', () => {
  afterEach(() => { registerShutdownRequest(null as never) })

  it('invokes the registered handler and reports handled', async () => {
    const handler = vi.fn(async () => {})
    registerShutdownRequest(handler)
    await expect(requestShutdown()).resolves.toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('reports unhandled when nothing is registered', async () => {
    await expect(requestShutdown()).resolves.toBe(false)
  })
})
