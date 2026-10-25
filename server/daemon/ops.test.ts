import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { daemonEnable, daemonDisable, daemonStatus, daemonRequestStart, daemonStopBySignal } from './ops.js'
import { writeStatusFile, readMarker } from './control.js'

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>()
  return {
    ...actual,
    isBundledDaemon: vi.fn(() => true),
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
    // The Windows adapter derives targetMissing from the registry stdout's
    // vbs path (must end in run-hidden.vbs AND exist on disk); macOS/Linux
    // derive it from existsSync(paths.daemonEntry) instead. Point the mocked
    // daemonEntry AT the real vbs file so both derivations agree: registered
    // AND present → targetMissing false on every platform.
    const existing = join(dir, 'daemon', 'run-hidden.vbs')
    mkdirSync(join(dir, 'daemon'), { recursive: true })
    writeFileSync(existing, '', 'utf8')
    const { resolveDaemonEntryPaths } = await import('./paths.js')
    const prev = vi.mocked(resolveDaemonEntryPaths).getMockImplementation()
    vi.mocked(resolveDaemonEntryPaths).mockImplementation(() => ({ nodePath: process.execPath, daemonEntry: existing, serverEntry: existing }))
    try {
      const runner = async () => ({ code: 0, stdout: `claude-react-web REG_SZ wscript.exe "${existing}"`, stderr: '' })
      await daemonEnable(dir, runner)
      const snap = await daemonStatus(dir, runner)
      expect(snap.configEnabled).toBe(true)
      expect(snap.osRegistered).toBe(true)
      expect(snap.osTargetMissing).toBe(false)
      expect(snap.daemonAlive).toBe(false) // no heartbeat on disk
      expect(snap.drift).toBe(false)
    } finally {
      // The module factory always installed an implementation, so prev is
      // defined — restore it explicitly (mockImplementation rejects undefined).
      vi.mocked(resolveDaemonEntryPaths).mockImplementation(prev!)
    }
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

describe('review fixes — ops', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-ops-fix') })
  afterEach(() => rmRf(dir))

  function seedStatus(over: Record<string, unknown>): Promise<void> {
    return writeStatusFile(dir, {
      daemonPid: process.pid, childPid: null, state: 'stopped', startedAt: Date.now(),
      childStartedAt: null, restartCount: 0, consecutiveFailures: 0,
      lastError: null, lastExitReason: null, updatedAt: Date.now(), ...over,
    })
  }

  it('daemonRequestStart writes the marker ONLY when the child is stopped (review fix #3)', async () => {
    await seedStatus({ state: 'stopped' })
    const r1 = await daemonRequestStart(dir)
    expect(r1.started).toBe('marker')
    expect(await readMarker(dir, 'start')).toBe(true)
  })

  it('daemonRequestStart does NOT write a marker while the child is running (review fix #3)', async () => {
    await seedStatus({ state: 'running', childPid: 1, childStartedAt: Date.now() })
    const r2 = await daemonRequestStart(dir)
    expect(r2.started).toBe('already-running')
    expect(await readMarker(dir, 'start')).toBe(false)
  })

  it('daemonStopBySignal leaves NO marker when there is no live child (review fix #2)', async () => {
    // no status file at all → nothing to stop, marker must not be orphaned
    await daemonStopBySignal(dir)
    expect(await readMarker(dir, 'stop')).toBe(false)
  })

  it('daemonStopBySignal marks + signals a LIVE child, and daemonStopAll also stops the daemon (review fix #2/#4)', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    await seedStatus({ state: 'running', childPid: 4242 })
    await daemonStopBySignal(dir)
    expect(await readMarker(dir, 'stop')).toBe(true)
    expect(killSpy.mock.calls.some((c) => c[0] === 4242 && c[1] === 'SIGTERM')).toBe(true)

    // uninstall semantics: the daemon itself is SIGTERMed too (review fix #4)
    killSpy.mockClear()
    const { daemonStopAll } = await import('./ops.js')
    await daemonStopAll(dir)
    expect(killSpy.mock.calls.some((c) => c[0] === 4242 && c[1] === 'SIGTERM')).toBe(true)
    expect(killSpy.mock.calls.some((c) => c[0] === process.pid && c[1] === 'SIGTERM')).toBe(true)
    killSpy.mockRestore()
  })
})

describe('dev mode (tsx, non-bundled) — the daemon is unsupported, not a 500', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-ops-dev') })
  afterEach(() => { vi.restoreAllMocks(); rmRf(dir) })

  async function goDev(): Promise<void> {
    const { isBundledDaemon } = await import('./paths.js')
    vi.mocked(isBundledDaemon).mockReturnValue(false)
  }

  it('status degrades to supported:false with the reason (LIVE: this was a 500)', async () => {
    await goDev()
    const snap = await daemonStatus(dir)
    expect(snap.supported).toBe(false)
    expect(snap.supportReason).toMatch(/production bundle/)
    expect(snap.osRegistered).toBe(false)
    expect(snap.drift).toBe(false)
  })

  it('status still reports a live production daemon sharing the state dir (honest facts)', async () => {
    await goDev()
    await writeStatusFile(dir, {
      daemonPid: process.pid, childPid: null, state: 'running', startedAt: Date.now(),
      childStartedAt: Date.now(), restartCount: 0, consecutiveFailures: 0,
      lastError: null, lastExitReason: null, updatedAt: Date.now(),
    })
    const snap = await daemonStatus(dir)
    expect(snap.supported).toBe(false)
    expect(snap.daemonAlive).toBe(true)
    expect(snap.child!.state).toBe('running')
  })

  it('enable refuses with HttpError 400 carrying the same reason', async () => {
    await goDev()
    await expect(daemonEnable(dir)).rejects.toMatchObject({ status: 400 })
  })

  it('disable refuses with HttpError 400 carrying the same reason', async () => {
    await goDev()
    await expect(daemonDisable(dir)).rejects.toMatchObject({ status: 400 })
  })

  it('requestStart refuses with HttpError 400 even when a fresh status file exists (review #3)', async () => {
    await goDev()
    await writeStatusFile(dir, {
      daemonPid: process.pid, childPid: null, state: 'stopped', startedAt: Date.now(),
      childStartedAt: null, restartCount: 0, consecutiveFailures: 0,
      lastError: null, lastExitReason: null, updatedAt: Date.now(),
    })
    const { readMarker } = await import('./control.js')
    await expect(daemonRequestStart(dir)).rejects.toMatchObject({ status: 400 })
    expect(await readMarker(dir, 'start')).toBe(false) // no orphan marker either
  })
})
