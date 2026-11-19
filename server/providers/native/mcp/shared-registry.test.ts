// server/providers/native/mcp/shared-registry.test.ts
//
// Real-process pins for the host-global refcounted registry. Nothing here mocks
// the MCP SDK: the stdio fixture is spawned for real, children are counted by
// the PID each record captures from its transport, and teardown is proven by a
// platform process-liveness check (koffi `processIdentity` on win32,
// `process.kill(pid, 0)` on POSIX).

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processIdentity } from '../../../win32-job.js'
import { metrics } from '../../../metrics.js'
import type { NativeMcpServerConfig } from './connections.js'
import { childIdentity, type SharedRecord } from './shared-record.js'
import { SharedRegistry } from './shared-registry.js'
import { makeNativePorts } from '../../native-host-adapters.js'

const fixturePath = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))

// The real host transport adapter: the port is the seam, and these tests drive
// real stdio children over it (the adapter, not a stub).
const transportPort = makeNativePorts().mcpTransport

// A healthy stdio child can outlive the default 5s close deadline under
// full-suite load: the exit-confirmation then marks cleanupFailed and the
// registry RETAINS the record, reddening the reg.size===0 pins. Give the
// healthy leg a generous close margin (the deliberately-hung retention pin
// keeps its own short closeTimeoutMs).
const HEALTHY_CLOSE_MS = 10_000

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'native-mcp-registry-'))
  tempDirs.push(dir)
  return dir
}

// Every record a test acquires is closed unconditionally in afterEach so a
// failed assertion never leaks a stdio child into the process table. Closing
// the record directly (rather than through the registry) is enough: the
// registry itself is test-local and discarded with the test.
const openRecords: SharedRecord[] = []
function acquire(reg: SharedRegistry, config: NativeMcpServerConfig): SharedRecord {
  const rec = reg.acquire(config)
  openRecords.push(rec)
  return rec
}

afterEach(async () => {
  for (const rec of openRecords.splice(0)) {
    await rec.close()
    // A hung close leaves the child alive BY DESIGN (no automatic force-kill).
    // cleanupFailed is the ONLY post-close state where that can be so (the
    // exit confirmation read null/mismatch otherwise), so the reap backstop
    // probes just that state — no identity reads for already-dead children.
    // The identity guard keeps a recycled PID from being killed by mistake.
    if (rec.cleanupFailed && rec.pid !== null) {
      const identity = childIdentity(rec.pid)
      if (identity !== null && (rec.birthTime === null || identity === rec.birthTime)) {
        try {
          process.kill(rec.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** Poll `check` until it holds; fail the test (never just time out silently)
 *  once `ms` has passed. */
async function waitFor(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`)
}

/** Prove a child is still running: win32 reads its creation-time identity
 *  (null once dead / unreadable), POSIX probes `kill(pid, 0)`. */
function expectChildAlive(pid: number): void {
  if (process.platform === 'win32') {
    expect(processIdentity(pid)).not.toBeNull()
    return
  }
  expect(() => process.kill(pid, 0)).not.toThrow()
}

/** Prove the child is gone: win32 polls until the identity reads null, POSIX
 *  polls `kill(pid, 0)` until it throws. */
async function expectChildGone(pid: number, ms = 5000): Promise<void> {
  if (process.platform === 'win32') {
    await waitFor(() => processIdentity(pid) === null, ms, `child ${pid} to exit`)
    return
  }
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 25))
    } catch {
      return
    }
  }
  throw new Error(`pid ${pid} still alive after ${ms}ms`)
}

function stdioConfig(byePath: string, mode?: string): NativeMcpServerConfig {
  return { type: 'stdio', command: 'node', args: mode ? [fixturePath, byePath, mode] : [fixturePath, byePath] }
}

/** The --ignore-exit spawn counter the fixture persists, so a test can prove
 *  a blocked acquire spawned no fresh child. */
function ignoreExitCount(byePath: string): number {
  return parseInt(readFileSync(`${byePath}.ignore-exit`, 'utf8'), 10)
}

const freshSignal = () => new AbortController().signal

describe('SharedRegistry', () => {
  it('two acquires of the same config share one child; release semantics', async () => {
    const dir = await tempDir()
    const cfg = stdioConfig(join(dir, 'bye.txt'))
    const reg = new SharedRegistry({ transportPort, closeTimeoutMs: HEALTHY_CLOSE_MS })

    const a = acquire(reg, cfg)
    const b = acquire(reg, cfg)
    expect(a).toBe(b)
    expect(a.users).toBe(2)
    expect(reg.size).toBe(1)
    expect(reg.get(a.key)).toBe(a)

    await a.ready
    expect(a.status).toBe('connected')
    const pid = a.pid!
    expect(pid).toBeGreaterThan(0)

    await reg.release(a) // users 1: the shared child stays alive
    expect(a.users).toBe(1)
    expect(reg.size).toBe(1)
    expectChildAlive(pid)

    await reg.release(b) // users 0: immediate teardown, no idle grace
    expect(reg.size).toBe(0)
    expect(reg.get(a.key)).toBeUndefined()
    await expectChildGone(pid)

    // After teardown the next acquire is a fresh record with a fresh child.
    const c = acquire(reg, cfg)
    expect(c).not.toBe(a)
    await c.ready
    expect(c.status).toBe('connected')
    expect(reg.size).toBe(1)
    await reg.release(c)
    expect(reg.size).toBe(0)
    await expectChildGone(c.pid!)
  }, 15_000)

  it('different env yields separate children', async () => {
    const dir = await tempDir()
    const cfg = stdioConfig(join(dir, 'bye.txt'))
    const reg = new SharedRegistry({ transportPort, closeTimeoutMs: HEALTHY_CLOSE_MS })

    const a = acquire(reg, { ...cfg, env: { A: '1' } })
    const b = acquire(reg, { ...cfg, env: { A: '2' } })
    expect(a).not.toBe(b)
    expect(reg.size).toBe(2)

    await Promise.all([a.ready, b.ready])
    expect(a.status).toBe('connected')
    expect(b.status).toBe('connected')
    // Both children are alive at once, so distinct PIDs are guaranteed.
    expect(a.pid).toBeGreaterThan(0)
    expect(b.pid).toBeGreaterThan(0)
    expect(a.pid).not.toBe(b.pid)

    await reg.release(a)
    await reg.release(b)
    expect(reg.size).toBe(0)
    await expectChildGone(a.pid!)
    await expectChildGone(b.pid!)
  }, 15_000)

  it("a hung close on one key does not block another key's release", async () => {
    const dir = await tempDir()
    // A refuses every graceful exit (--ignore-exit spawn 1), so its release
    // hangs for the close race + the exit-confirmation window (~2 × 1500ms).
    // B is a healthy child on a DIFFERENT key (distinct args).
    const cfgA = stdioConfig(join(dir, 'a.txt'), '--ignore-exit')
    const cfgB = stdioConfig(join(dir, 'b.txt'))
    const reg = new SharedRegistry({ transportPort, closeTimeoutMs: 1500 })

    const a = acquire(reg, cfgA)
    const b = acquire(reg, cfgB)
    expect(a.key).not.toBe(b.key)
    await Promise.all([a.ready, b.ready])
    expect(a.status).toBe('connected')
    expect(b.status).toBe('connected')

    // Start A's release and wait until its teardown is actually in flight.
    let aSettled = false
    const releasingA = reg.release(a).then(() => {
      aSettled = true
    })
    await waitFor(() => a.users === 0, 5000, "A's release teardown to start")

    // B's release rides its OWN key's queue, so it resolves while A's close is
    // still hanging. Under one global queue B would chain behind A's teardown
    // (≥ the 1500ms close race alone), failing both pins below.
    const t0 = Date.now()
    await reg.release(b)
    const bElapsed = Date.now() - t0
    expect(aSettled).toBe(false)
    expect(bElapsed).toBeLessThan(1200)
    expect(b.users).toBe(0)
    expect(b.cleanupFailed).toBe(false)
    expect(reg.get(b.key)).toBeUndefined()

    // Let A's hung teardown settle (retained or reaped depending on whether
    // the SDK's close escalation killed the child before the deadline).
    await releasingA
  }, 15_000)

  it('a release-at-0 cannot race a concurrent acquire of the same key', async () => {
    const dir = await tempDir()
    const cfg = stdioConfig(join(dir, 'bye.txt'))
    const reg = new SharedRegistry({ transportPort, closeTimeoutMs: HEALTHY_CLOSE_MS })

    const a = acquire(reg, cfg)
    await a.ready
    expect(a.status).toBe('connected')
    const pid = a.pid!

    // release queues its decrement; the synchronous acquire lands BEFORE the
    // queued task runs, so the task must observe the bumped refcount and stand
    // down — never close a record a new user just acquired.
    const releasing = reg.release(a)
    const b = acquire(reg, cfg)
    await releasing

    expect(b).toBe(a)
    expect(b.users).toBe(1)
    expect(reg.get(a.key)).toBe(a)
    expectChildAlive(pid)

    await reg.release(b)
    expect(reg.size).toBe(0)
    await expectChildGone(pid)
  }, 15_000)

  it('an acquire during HEALTHY teardown gets a reviving record, not a zombie marked connected', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    // --slow-exit holds the graceful exit ~300ms after stdin EOF, so the
    // acquire below lands DURING the healthy teardown deterministically.
    const cfg = stdioConfig(byePath, '--slow-exit')
    const reg = new SharedRegistry({ transportPort, closeTimeoutMs: HEALTHY_CLOSE_MS })

    const a = acquire(reg, cfg)
    await a.ready
    expect(a.status).toBe('connected')
    const oldPid = a.pid!

    // Release starts the teardown (users → 0); the record is still mapped
    // while the close awaits, so the racing acquire joins it (users → 1).
    const releasing = reg.release(a)
    await waitFor(() => a.users === 0, 5000, 'the release teardown to start')
    const b = acquire(reg, cfg)
    expect(b).toBe(a)
    expect(b.users).toBe(1)
    await releasing

    // The racing acquirer must get a REVIVING record: release fired a
    // reconnect after the healthy close, so it connects fresh instead of
    // staying a closed zombie (client gone, supervisor suppressed) that every
    // future acquire of the key would join.
    await waitFor(() => a.status === 'connected', 5000, 'the racing acquirer record to revive')
    expect(a.cleanupFailed).toBe(false)
    expect(a.pid).not.toBe(oldPid)
    expectChildAlive(a.pid!)
    expect(a.tools.length).toBeGreaterThan(0)
    const result = await a.callTool('echo', { text: 'revived' }, freshSignal())
    expect(result.content).toEqual([{ type: 'text', text: 'revived' }])
    expect(reg.get(a.key)).toBe(a)
    expect(reg.size).toBe(1)

    await reg.release(b)
    expect(reg.size).toBe(0)
    await expectChildGone(a.pid!)
  }, 15_000)

  it('acquire/release counters and the records gauge track activity', async () => {
    metrics.reset()
    const dir = await tempDir()
    const cfg = stdioConfig(join(dir, 'bye.txt'))
    const reg = new SharedRegistry({ transportPort, closeTimeoutMs: HEALTHY_CLOSE_MS })

    const a = acquire(reg, cfg)
    const b = acquire(reg, cfg)
    expect(metrics.snapshot().gauges['shared_mcp_records']).toBe(1)
    await a.ready

    await reg.release(a)
    await reg.release(b)

    const snap = metrics.snapshot()
    expect(snap.counters['mcp_shared_acquire']).toBe(2)
    expect(snap.counters['mcp_shared_release']).toBe(2)
    expect(snap.gauges['shared_mcp_records']).toBe(0)
  }, 15_000)

  it('retains a cleanupFailed record at users==0 and blocks automatic re-acquire', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const cfg = stdioConfig(byePath, '--ignore-exit')
    const reg = new SharedRegistry({ transportPort, closeTimeoutMs: 200 })

    const a = acquire(reg, cfg)
    await a.ready
    expect(a.status).toBe('connected')
    const pid = a.pid!

    // Last user releases: the hung close trips the deadline, and the record is
    // RETAINED (users 0) instead of removed — fail-closed against replacement.
    await reg.release(a)
    expect(a.users).toBe(0)
    expect(a.cleanupFailed).toBe(true)
    expect(reg.get(a.key)).toBe(a)
    expect(reg.size).toBe(1)
    expectChildAlive(pid)

    // A new session acquiring the same config gets the SAME blocked record —
    // no fresh child, no fresh connect — and its calls fail fast.
    const b = acquire(reg, cfg)
    expect(b).toBe(a)
    expect(b.users).toBe(1)
    expect(b.status).toBe('failed')
    expect(ignoreExitCount(byePath)).toBe(1)
    await expect(b.callTool('echo', { text: 'x' }, freshSignal())).rejects.toThrow('MCP_SERVER_UNAVAILABLE')

    // Releasing again keeps the block (the child is still alive).
    await reg.release(b)
    expect(reg.get(a.key)).toBe(a)
    expect(reg.size).toBe(1)
    expect(a.cleanupFailed).toBe(true)

    // Only a death-gated manual reconnect clears the flag (fixture spawn 2 is
    // healthy, so the same config recovers onto a fresh child).
    process.kill(pid, 'SIGKILL')
    await expectChildGone(pid)
    await a.reconnect()
    expect(a.cleanupFailed).toBe(false)
    expect(a.status).toBe('connected')
    expect(ignoreExitCount(byePath)).toBe(2)

    // After recovery the record is a normal shared connection again: acquire
    // joins it, and the last release closes it cleanly and removes it.
    const d = acquire(reg, cfg)
    expect(d).toBe(a)
    await reg.release(d)
    expect(reg.size).toBe(0)
    expect(reg.get(a.key)).toBeUndefined()
    await expectChildGone(a.pid!)

    // And the next acquire connects fresh.
    const c = acquire(reg, cfg)
    expect(c).not.toBe(a)
    await c.ready
    expect(c.status).toBe('connected')
    expect(ignoreExitCount(byePath)).toBe(3)
    await reg.release(c)
    expect(reg.size).toBe(0)
    await expectChildGone(c.pid!)
  }, 15_000)

  it('drains its per-key release queues once every release settles', async () => {
    const dir = await tempDir()
    const reg = new SharedRegistry({ transportPort, closeTimeoutMs: HEALTHY_CLOSE_MS })

    const a = acquire(reg, stdioConfig(join(dir, 'a.txt')))
    const b = acquire(reg, stdioConfig(join(dir, 'b.txt')))
    await Promise.all([a.ready, b.ready])

    // A release in flight holds its key's queue tail...
    const releasingA = reg.release(a)
    expect(reg.pendingQueueCount).toBeGreaterThan(0)
    await releasingA
    await reg.release(b)
    expect(reg.size).toBe(0)

    // ...and a settled tail with no newer task chained is removed, so the
    // queues map does not grow with every distinct key ever released.
    await waitFor(() => reg.pendingQueueCount === 0, 5000, 'the release queues to drain')
    await expectChildGone(a.pid!)
    await expectChildGone(b.pid!)
  }, 15_000)
})
