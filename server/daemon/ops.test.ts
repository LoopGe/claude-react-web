import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { daemonEnable, daemonDisable, daemonStatus } from './ops.js'
import { writeStatusFile } from './control.js'

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>()
  return {
    ...actual,
    resolveDaemonEntryPaths: vi.fn(() => ({ nodePath: '/node', daemonEntry: '/fake/dist/daemon.mjs', serverEntry: '/fake/dist/cli.mjs' })),
  }
})

const noopRunner = async () => ({ code: 0, stdout: '', stderr: '' })

function seedConfig(dir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
    ...extra,
  }), 'utf8')
}

describe('daemon ops', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-ops'); seedConfig(dir) })
  afterEach(() => { vi.restoreAllMocks(); rmRf(dir) })

  it('enable registers first, then writes config.autoStart=true', async () => {
    const snap = await daemonEnable(dir, noopRunner)
    expect(snap.configEnabled).toBe(true)
    const onDisk = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'config.json'), 'utf8')))
    expect(onDisk.autoStart).toBe(true)
  })

  it('disable unregisters and writes autoStart=false', async () => {
    await daemonEnable(dir, noopRunner)
    await daemonDisable(dir, noopRunner)
    const onDisk = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'config.json'), 'utf8')))
    expect(onDisk.autoStart).toBe(false)
  })

  it('status aggregates: registered but not running is NOT drift', async () => {
    // point the registration target at a file that EXISTS so targetMissing is
    // false — isolating "not running" from "target gone"
    const existing = join(dir, 'daemon.mjs')
    writeFileSync(existing, '', 'utf8')
    const { resolveDaemonEntryPaths } = await import('./paths.js')
    vi.mocked(resolveDaemonEntryPaths).mockReturnValue({ nodePath: '/node', daemonEntry: existing, serverEntry: '/fake/dist/cli.mjs' })
    await daemonEnable(dir, noopRunner)
    const snap = await daemonStatus(dir, noopRunner)
    expect(snap.configEnabled).toBe(true)
    expect(snap.osRegistered).toBe(true) // the fake runner answers code 0 for everything
    expect(snap.osTargetMissing).toBe(false)
    expect(snap.daemonAlive).toBe(false) // no heartbeat on disk
    expect(snap.drift).toBe(false)
  })

  it('status flags targetMissing as drift when config is enabled', async () => {
    await daemonEnable(dir, noopRunner)
    // daemonEntry points at /fake/dist/daemon.mjs which does not exist → targetMissing → drift
    const snap = await daemonStatus(dir, noopRunner)
    expect(snap.osTargetMissing).toBe(true)
    expect(snap.drift).toBe(true)
  })

  it('status reflects a fresh heartbeat (daemonAlive) and child fields', async () => {
    await daemonEnable(dir, noopRunner)
    await writeStatusFile(dir, {
      daemonPid: process.pid, childPid: 1, state: 'running', startedAt: Date.now(),
      childStartedAt: Date.now() - 65_000, restartCount: 2, consecutiveFailures: 0,
      lastError: null, lastExitReason: null, updatedAt: Date.now(),
    })
    const snap = await daemonStatus(dir, noopRunner)
    expect(snap.daemonAlive).toBe(true)
    expect(snap.child!.state).toBe('running')
    expect(snap.child!.uptimeSec).toBeGreaterThanOrEqual(60)
    expect(snap.child!.restartCount).toBe(2)
  })

  it('enable surfaces an unsupported platform as a 400-shaped error and does NOT touch config (Review Focus #5)', async () => {
    const { getPlatformRegister } = await import('./register/index.js')
    vi.spyOn(getPlatformRegister(), 'isSupported').mockResolvedValue({ supported: false, reason: 'no systemd' })
    const before = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'config.json'), 'utf8')))
    await expect(daemonEnable(dir, noopRunner)).rejects.toMatchObject({ status: 400 })
    const after = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'config.json'), 'utf8')))
    expect(after).toEqual(before)
  })
})
