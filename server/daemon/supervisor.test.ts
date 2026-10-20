import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { startSupervisor } from './supervisor.js'
import { readStatusFile, writeMarker, readMarker } from './control.js'

function makeHarness() {
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = []
  let nextPid = 100
  const spawned: number[] = []
  const timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = []
  let clock = 0
  const child = { pid: 0, on: (_e: 'exit', cb: (c: number | null, s: string | null) => void) => { exitCbs.push(cb) } }
  const deps = {
    stateDir: '',
    spawnChild: () => {
      // a REAL child emits 'exit' exactly once — drop listeners from the
      // previous fake child so repeated exits don't multiply onChildExit calls
      exitCbs.length = 0
      child.pid = ++nextPid
      spawned.push(child.pid)
      return child
    },
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, at: clock + ms, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
  }
  function advance(ms: number) {
    clock += ms
    const results: Array<unknown> = []
    for (const t of [...timers]) {
      if (!t.cancelled && t.at <= clock) { t.cancelled = true; results.push(t.fn()) }
    }
    // timers may schedule async work (poll writes, backoff spawns) — await it
    // so tests read a settled status file.
    return Promise.all(results).then(() => undefined)
  }
  function exit(code: number | null = 1, signal: string | null = null) {
    return Promise.all(exitCbs.map((cb) => cb(code, signal))).then(() => undefined)
  }
  return { deps, advance, exit, spawned }
}

describe('supervisor', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-sup') })
  afterEach(() => rmRf(dir))

  it('spawns a child, writes a fresh heartbeat and reports running', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    expect(h.spawned).toHaveLength(1)
    await h.advance(2_000) // first heartbeat
    const s = await readStatusFile(dir)
    expect(s!.state).toBe('running')
    expect(s!.childPid).toBe(101)
    expect(s!.daemonPid).toBe(process.pid)
    sup.stop()
  })

  it('backoff-restarts an unexpected exit (2s, 4s, …) and counts restarts', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    await h.exit(1) // unexpected exit
    await h.advance(1_999)
    expect(h.spawned).toHaveLength(1) // backoff not elapsed yet
    await h.advance(1) // 2s reached
    expect(h.spawned).toHaveLength(2)
    await h.advance(2_000) // let the poll record the restart
    const s = await readStatusFile(dir)
    expect(s!.restartCount).toBe(1)
    sup.stop()
  })

  it('gives up after 5 consecutive failures and marks failed', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    for (let i = 0; i < 5; i++) { await h.exit(1); await h.advance(60_000) }
    const s = await readStatusFile(dir)
    expect(s!.state).toBe('failed')
    expect(s!.consecutiveFailures).toBe(5)
    h.advance(60_000)
    expect(h.spawned).toHaveLength(5) // no more restarts
    sup.stop()
  })

  it('honors the stop marker: clears it and does NOT restart', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    await writeMarker(dir, 'stop')
    await h.exit(0)
    await h.advance(60_000)
    expect(h.spawned).toHaveLength(1)
    expect(await readMarker(dir, 'stop')).toBe(false) // consumed
    const s = await readStatusFile(dir)
    expect(s!.state).toBe('stopped')
    sup.stop()
  })

  it('restart-requested exits restart immediately', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    await writeMarker(dir, 'restart')
    await h.exit(0)
    expect(h.spawned).toHaveLength(2) // no backoff delay
    expect(await readMarker(dir, 'restart')).toBe(false)
    sup.stop()
  })

  it('start-requested revives a stopped child on the next poll', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    await writeMarker(dir, 'stop')
    await h.exit(0)
    expect(h.spawned).toHaveLength(1)
    await writeMarker(dir, 'start')
    await h.advance(2_000)
    expect(h.spawned).toHaveLength(2)
    expect(await readMarker(dir, 'start')).toBe(false)
    sup.stop()
  })

  it('keeps writing heartbeats while backing off (daemon stays alive)', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    // Desync the poll from the backoff delay (both default to 2s): with a
    // 500ms poll the heartbeat lands on disk BEFORE the +2s restart flips the
    // state back to 'running', making the backoff observation deterministic.
    const sup = startSupervisor({ ...h.deps, timings: { pollMs: 500 } })
    await h.advance(2_000) // heartbeats on record
    await h.exit(1)
    const before = (await readStatusFile(dir))!.updatedAt
    await h.advance(500) // poll fires while state is 'backoff' (restart only at +2s)
    const s = await readStatusFile(dir)
    expect(s!.state).toBe('backoff')
    expect(s!.updatedAt).toBeGreaterThanOrEqual(before)
    sup.stop()
  })
})
