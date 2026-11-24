import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const autoUpdater = {
    logger: null as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    on(ev: string, fn: (...args: unknown[]) => void) {
      const l = listeners.get(ev) ?? []
      l.push(fn)
      listeners.set(ev, l)
      return autoUpdater
    },
    off(ev: string, fn: (...args: unknown[]) => void) {
      listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn))
      return autoUpdater
    },
    emit(ev: string, ...args: unknown[]) {
      for (const fn of listeners.get(ev) ?? []) fn(...args)
    },
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
  }
  return {
    listeners,
    autoUpdater,
    fakeApp: { isPackaged: true, userDataDir: '', getPath: (_: string) => h.fakeApp.userDataDir },
    showMessageBox: vi.fn(async () => ({ response: 1 })),
    fakeConfig: { updateCheckIntervalMs: 60_000 },
  }
})

vi.mock('electron-updater', () => ({ autoUpdater: h.autoUpdater }))
vi.mock('electron', () => ({ app: h.fakeApp, dialog: { showMessageBox: h.showMessageBox } }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(() => true),
}))
vi.mock('../server/config.js', () => ({ config: h.fakeConfig }))

import { setupAutoUpdate } from './updater.js'

let dir: string
let savedResourcesPath: string | undefined

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'crw-updater-'))
  h.fakeApp.userDataDir = dir
  h.fakeApp.isPackaged = true
  h.fakeConfig.updateCheckIntervalMs = 60_000
  h.listeners.clear()
  h.autoUpdater.checkForUpdates.mockReset()
  h.autoUpdater.checkForUpdates.mockResolvedValue(null)
  h.autoUpdater.downloadUpdate.mockReset()
  h.autoUpdater.downloadUpdate.mockResolvedValue(undefined)
  h.autoUpdater.quitAndInstall.mockReset()
  h.showMessageBox.mockReset()
  h.showMessageBox.mockResolvedValue({ response: 1 })
  savedResourcesPath = process.resourcesPath
  process.resourcesPath = '/fake/resources'
})
afterEach(() => {
  vi.useRealTimers()
  process.resourcesPath = savedResourcesPath
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

// The factory uses real Math.random: a 60_000 interval fires in [48k, 72k].
// Advance the upper bound; two ticks can't share one 72k window (min 96k).
const TICK = 72_000

describe('setupAutoUpdate — periodic feed checks', () => {
  it('checks once at launch, then once per interval', async () => {
    await setupAutoUpdate()
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TICK)
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('interval 0 disables periodic checking (launch check still runs)', async () => {
    h.fakeConfig.updateCheckIntervalMs = 0
    await setupAutoUpdate()
    await vi.advanceTimersByTimeAsync(200_000)
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('unpackaged builds are a no-op', async () => {
    h.fakeApp.isPackaged = false
    await setupAutoUpdate()
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('keeps autoDownload off and autoInstallOnAppQuit on', async () => {
    await setupAutoUpdate()
    expect(h.autoUpdater.autoDownload).toBe(false)
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('skips periodic checks while a dialog is pending, resumes after it settles', async () => {
    let resolveDialog!: (v: { response: number }) => void
    h.showMessageBox.mockImplementation(() => new Promise((r) => { resolveDialog = r }))
    await setupAutoUpdate()
    h.autoUpdater.emit('update-available', { version: '1.2.0' })
    await vi.advanceTimersByTimeAsync(TICK)
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1) // busy → skipped
    resolveDialog({ response: 1 }) // Remind me later
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(TICK)
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('a failed periodic check doubles the next delay', async () => {
    await setupAutoUpdate() // launch check resolves
    h.autoUpdater.checkForUpdates.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(TICK)
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2) // failed tick
    await vi.advanceTimersByTimeAsync(TICK)
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2) // backoff [96k,144k]
    await vi.advanceTimersByTimeAsync(TICK)
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('update-available shows the three-button dialog; Skip persists to the store', async () => {
    h.showMessageBox.mockResolvedValue({ response: 2 })
    await setupAutoUpdate()
    h.autoUpdater.emit('update-available', { version: '9.9.9' })
    await vi.waitFor(() => expect(h.showMessageBox).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(0)
    const opts = h.showMessageBox.mock.calls[0][0] as { buttons: string[] }
    expect(opts.buttons).toEqual(['Download', 'Remind me later', 'Skip this version'])
    const saved = JSON.parse(readFileSync(join(dir, 'update-skipped.json'), 'utf8')) as { skipped: string[] }
    expect(saved.skipped).toContain('9.9.9')
  })

  it('update-downloaded accept quits and installs', async () => {
    h.showMessageBox.mockResolvedValue({ response: 0 })
    await setupAutoUpdate()
    h.autoUpdater.emit('update-downloaded', { version: '9.9.9' })
    await vi.waitFor(() => expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1))
  })
})