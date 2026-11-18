// server/providers/native/mcp/shared-record.test.ts
//
// Real-process pins for one shared stdio connection's lifecycle. Nothing here
// mocks the MCP SDK: the stdio fixture is spawned for real, the child PID is
// captured from the transport, and teardown is proven by the fixture's `bye`
// marker plus a platform process-liveness check (koffi `processIdentity` on
// win32, `process.kill(pid, 0)` on POSIX).

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processIdentity } from '../../../win32-job.js'
import { disableLogRing, enableLogRing, getLogConfig, readLogRing, setLogConfig } from '../../../log.js'
import type { NativeMcpServerConfig } from './connections.js'
import { SharedRecord, childIdentity, sharingKey } from './shared-record.js'
import { SharedRegistry } from './shared-registry.js'

const fixturePath = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'native-mcp-shared-'))
  tempDirs.push(dir)
  return dir
}

// Every record a test opens is closed unconditionally in afterEach so a failed
// assertion never leaks a stdio child into the process table.
const openRecords: SharedRecord[] = []
function makeRecord(config: NativeMcpServerConfig, opts?: ConstructorParameters<typeof SharedRecord>[2]): SharedRecord {
  const rec = new SharedRecord(sharingKey(config), config, opts)
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

/** Prove the child is gone: win32 reads its creation-time identity (null once
 *  dead / unreadable), POSIX polls `kill(pid, 0)` until it throws. */
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
 *  exactly which spawns ran (and that no replacement spawned while the death
 *  gate refuses). */
function ignoreExitCount(byePath: string): number {
  return parseInt(readFileSync(`${byePath}.ignore-exit`, 'utf8'), 10)
}

/** --flaky: spawn 1 crashes on a `slow` call, spawns 2..(1+budget) fail before
 *  the handshake, later spawns are healthy. The budget is argv[4]. */
function flakyConfig(byePath: string, budget: number): NativeMcpServerConfig {
  return { type: 'stdio', command: 'node', args: [fixturePath, byePath, '--flaky', String(budget)] }
}

/** The --flaky spawn counter the fixture persists, so a test can prove exactly
 *  which attempts ran (and that none ran after give-up / close). */
function flakyCount(byePath: string): number {
  return parseInt(readFileSync(`${byePath}.flaky`, 'utf8'), 10)
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fast reconnect policy so real-process outage/retry tests stay well under the
 *  15s lane budget. The production default is 500ms / 30s / 10 attempts. */
const fastReconnect = { enabled: true, initialDelayMs: 20, maxDelayMs: 50, maxAttempts: 3 }

const freshSignal = () => new AbortController().signal

describe('sharingKey', () => {
  it('includes env and is order-stable', () => {
    const base: NativeMcpServerConfig = { type: 'stdio', command: 'node', args: ['server.mjs'] }
    // Insertion order of env keys must not change the identity.
    expect(sharingKey({ ...base, env: { A: '1', B: '2' } })).toBe(sharingKey({ ...base, env: { B: '2', A: '1' } }))
    // An env VALUE change is a different identity (a different child).
    expect(sharingKey({ ...base, env: { A: '1' } })).not.toBe(sharingKey({ ...base, env: { A: '2' } }))
    // Presence vs absence of env differs too.
    expect(sharingKey(base)).not.toBe(sharingKey({ ...base, env: { A: '1' } }))
    // command / args participate.
    expect(sharingKey(base)).not.toBe(sharingKey({ ...base, command: 'other' }))
    expect(sharingKey(base)).not.toBe(sharingKey({ ...base, args: ['different.mjs'] }))
  })
})

describe('SharedRecord', () => {
  it('connect discovers tools and captures the child pid', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const rec = makeRecord(stdioConfig(byePath))

    await rec.connect()

    expect(rec.status).toBe('connected')
    expect(rec.tools.length).toBeGreaterThan(0)
    expect(rec.cachedTools).toEqual(rec.tools)
    expect(rec.pid).toBeGreaterThan(0)
    expect(rec.serverInfo).toEqual({ name: 'fixture-echo', version: '1.0.0' })
    expect(rec.error).toBeUndefined()
    // The initial connect's settlement is exposed as `ready`.
    await expect(rec.ready).resolves.toBeUndefined()
  }, 15_000)

  it('callTool returns a result and is sibling-safe under per-call abort', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const rec = makeRecord(stdioConfig(byePath))
    await rec.connect()

    const result = await rec.callTool('echo', { text: 'hello' }, freshSignal())
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])

    // Two concurrent calls on the one record; abort caller A synchronously
    // (its request is in flight, the response has not arrived). B must still
    // resolve and the record itself must stay connected — A's abort is local
    // to A's combined signal, never the record's shared abort.
    const acA = new AbortController()
    const callA = rec.callTool('echo', { text: 'A' }, acA.signal)
    const callB = rec.callTool('echo', { text: 'B' }, freshSignal())
    acA.abort()

    await expect(callA).rejects.toThrow(/abort/i)
    const resultB = await callB
    expect(resultB.content).toEqual([{ type: 'text', text: 'B' }])
    expect(rec.status).toBe('connected')
    expect(rec.abort.signal.aborted).toBe(false)
  }, 15_000)

  it('callTool fails fast when the record is not connected', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const rec = makeRecord(stdioConfig(byePath))

    // Never connected: no child, fail fast rather than queue.
    await expect(rec.callTool('echo', { text: 'x' }, freshSignal())).rejects.toThrow('MCP_SERVER_UNAVAILABLE')

    await rec.connect()
    await rec.close()
    // Closed: still fail fast.
    await expect(rec.callTool('echo', { text: 'x' }, freshSignal())).rejects.toThrow('MCP_SERVER_UNAVAILABLE')
  }, 15_000)

  it('connect never rejects on a bad command and settles ready', async () => {
    const rec = makeRecord({ type: 'stdio', command: 'definitely-not-allowed' })

    await expect(rec.connect()).resolves.toBeUndefined()
    await expect(rec.ready).resolves.toBeUndefined()

    expect(rec.status).toBe('failed')
    expect(rec.error).toMatch(/allowlist/)
    expect(rec.tools).toEqual([])
    expect(rec.pid).toBeNull()
  }, 15_000)

  it('close kills the stdio child (bye marker) and is idempotent', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const rec = makeRecord(stdioConfig(byePath))
    await rec.connect()
    const pid = rec.pid!
    expect(pid).toBeGreaterThan(0)
    expect(existsSync(byePath)).toBe(false)

    await rec.close()
    await rec.close() // idempotent

    await waitFor(() => existsSync(byePath), 5000, 'the stdio child to write its bye marker')
    await expectChildGone(pid)
    expect(rec.tools).toEqual([])
    // A closed record is out of service — never left marked 'connected'
    // (a racing acquirer would otherwise see a zombie).
    expect(rec.status).toBe('disabled')
  }, 15_000)

  it('never logs secret env values in diagnostics', async () => {
    // The sharing key embeds env values, so the raw key must never reach a log.
    // Capture what the logger actually emits (its in-process ring) for both a
    // successful and a failed connect carrying a distinctive secret, and assert
    // neither the value nor the env key name appears — mirroring the env/header
    // secrecy pin in connections.test.ts.
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const secret = 'super-secret-env-value-12345'
    const prevConfig = getLogConfig()
    enableLogRing()
    setLogConfig({ level: 'trace' })
    try {
      const rec = makeRecord({ ...stdioConfig(byePath), env: { SECRET_TOKEN: secret } })
      await rec.connect()
      expect(rec.status).toBe('connected')
      await rec.close()

      const bad = makeRecord({ type: 'stdio', command: 'definitely-not-allowed', env: { SECRET_TOKEN: secret } })
      await bad.connect()
      expect(bad.status).toBe('failed')

      const { lines } = readLogRing({ scope: 'native-mcp-shared' })
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(line.msg).not.toContain(secret)
        expect(line.msg).not.toContain('SECRET_TOKEN')
      }
      // The diagnostic tag is the non-secret command + 8-hex key hash.
      expect(lines.some((l) => /\[node#[0-9a-f]{8}\] connected/.test(l.msg))).toBe(true)
    } finally {
      disableLogRing()
      setLogConfig(prevConfig)
    }
  }, 15_000)
})

describe('SharedRecord reconnect supervisor', () => {
  it('crash rejects in-flight calls, keeps cached tools registered, reconnects with a fresh child', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const rec = makeRecord(stdioConfig(byePath, '--crash'), { reconnect: fastReconnect })

    await rec.connect()
    expect(rec.status).toBe('connected')
    const oldPid = rec.pid!
    expect(oldPid).toBeGreaterThan(0)
    expect(rec.cachedTools.length).toBeGreaterThan(0)

    // A `slow` call never answers on its own; the fixture exits when it is
    // called, so the crash is guaranteed to land while this call is in flight.
    const inFlight = rec.callTool('slow', {}, freshSignal())
    await expect(inFlight).rejects.toThrow('MCP_CONNECTION_CLOSED')

    // Phase 1 (retry window): cached tools stay registered, status is pending
    // with the attempt budget in error, and NEW calls fail fast.
    expect(rec.status).toBe('pending')
    expect(rec.error).toMatch(/reconnecting \(attempt 1\/3\)/)
    expect(rec.tools).toEqual(rec.cachedTools)
    expect(rec.tools.length).toBeGreaterThan(0)
    await expect(rec.callTool('echo', { text: 'x' }, freshSignal())).rejects.toThrow('MCP_SERVER_UNAVAILABLE')

    // The crashed child is really gone, and backoff reconnects a fresh one.
    await expectChildGone(oldPid)
    await waitFor(() => rec.status === 'connected', 5000, 'the supervisor to reconnect')
    expect(rec.pid).toBeGreaterThan(0)
    expect(rec.pid).not.toBe(oldPid)
    expectChildAlive(rec.pid!)
    expect(rec.tools.length).toBeGreaterThan(0)
    expect(rec.error).toBeUndefined()
  }, 15_000)

  it('late acquirer during outage sees cached tools', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const config = flakyConfig(byePath, 3)
    const reg = new SharedRegistry({ reconnect: fastReconnect })
    const rec = reg.acquire(config)
    openRecords.push(rec)
    await rec.ready
    expect(rec.status).toBe('connected')
    expect(rec.cachedTools.length).toBeGreaterThan(0)

    // Crash the connected child; the record enters the retry window.
    const inFlight = rec.callTool('slow', {}, freshSignal())
    await expect(inFlight).rejects.toThrow('MCP_CONNECTION_CLOSED')
    expect(rec.status).toBe('pending')

    // A session acquiring the SAME config mid-outage gets the SAME record with
    // the cached last-good tools still registered — not zero — and its calls
    // fail fast rather than queueing on a dead connection.
    const late = reg.acquire(config)
    expect(late).toBe(rec)
    expect(late.users).toBe(2)
    expect(late.tools.length).toBeGreaterThan(0)
    expect(late.tools).toEqual(rec.cachedTools)
    await expect(late.callTool('echo', { text: 'x' }, freshSignal())).rejects.toThrow('MCP_SERVER_UNAVAILABLE')

    // Closing mid-outage cancels the supervisor: once close() settles, no
    // further reconnect attempt spawns a child (quiescent teardown).
    await rec.close()
    const countAfterClose = flakyCount(byePath)
    await delay(120) // > maxDelayMs: a stray timer would have fired by now
    expect(flakyCount(byePath)).toBe(countAfterClose)
  }, 15_000)

  it('give-up unregisters tools and stays failed until manual reconnect', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    // budget 3: spawns 2..4 fail before the handshake, spawn 5 is healthy.
    const rec = makeRecord(flakyConfig(byePath, 3), { reconnect: fastReconnect })

    await rec.connect()
    expect(rec.status).toBe('connected')
    const cached = rec.cachedTools
    expect(cached.length).toBeGreaterThan(0)

    const inFlight = rec.callTool('slow', {}, freshSignal())
    await expect(inFlight).rejects.toThrow('MCP_CONNECTION_CLOSED')

    // maxAttempts exhausted → give-up: tools unregistered, status failed,
    // cachedTools retained for a future manual reconnect.
    await waitFor(() => rec.status === 'failed', 5000, 'the supervisor to give up')
    expect(rec.tools).toEqual([])
    expect(rec.cachedTools).toEqual(cached)
    await expect(rec.callTool('echo', { text: 'x' }, freshSignal())).rejects.toThrow('MCP_SERVER_UNAVAILABLE')

    // Exactly spawn 1 (initial) + 3 failed attempts ran; after give-up the
    // supervisor is quiescent — no stray backoff timer spawns another child.
    expect(flakyCount(byePath)).toBe(4)
    await delay(120) // > maxDelayMs: any stray timer would have fired by now
    expect(flakyCount(byePath)).toBe(4)
    expect(rec.status).toBe('failed')

    // Manual reconnect (spawn 5 is healthy) restores the connection and tools,
    // spawning exactly one fresh child.
    await rec.reconnect()
    expect(rec.status).toBe('connected')
    expect(rec.tools.length).toBeGreaterThan(0)
    expect(rec.error).toBeUndefined()
    expectChildAlive(rec.pid!)
    expect(flakyCount(byePath)).toBe(5)
  }, 15_000)
})

describe('SharedRecord cleanup death gate', () => {
  it('hung close trips the deadline and sets cleanupFailed', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const rec = makeRecord(stdioConfig(byePath, '--ignore-exit'), { closeTimeoutMs: 200 })
    await rec.connect()
    expect(rec.status).toBe('connected')
    const pid = rec.pid!
    expect(pid).toBeGreaterThan(0)
    expect(rec.cleanupFailed).toBe(false)

    const started = Date.now()
    await rec.close()
    // Bounded by the close race plus the exit-confirmation window (200ms
    // each), never by the SDK transport's own multi-second kill escalation.
    expect(Date.now() - started).toBeLessThan(2000)
    expect(rec.cleanupFailed).toBe(true)
    expect(rec.status).toBe('failed')
    expect(rec.error).toMatch(/still alive/)
    expect(rec.tools).toEqual([])
    // No automatic force-kill: the child is provably still running, and the
    // flag is what blocks replacement.
    expectChildAlive(pid)

    // Idempotent: a second close stays bounded and keeps the flag.
    await rec.close()
    expect(rec.cleanupFailed).toBe(true)
    expectChildAlive(pid)
  }, 15_000)

  it('manual reconnect is refused while the child is alive, allowed after confirmed death', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const rec = makeRecord(stdioConfig(byePath, '--ignore-exit'), { closeTimeoutMs: 200 })
    await rec.connect()
    const pid = rec.pid!
    await rec.close()
    expect(rec.cleanupFailed).toBe(true)
    expectChildAlive(pid)

    // Refused while the child lives — and the refusal is a pure no-op: no
    // replacement child spawns (the exact overlap fail-closed prevents).
    await expect(rec.reconnect()).rejects.toThrow(/still alive/)
    expect(rec.cleanupFailed).toBe(true)
    expect(rec.pid).toBe(pid)
    expect(ignoreExitCount(byePath)).toBe(1)

    // Externally confirmed death unlocks recovery: spawn 2 of the fixture is
    // healthy, so the SAME config reconnects cleanly.
    process.kill(pid, 'SIGKILL')
    await expectChildGone(pid)
    await rec.reconnect()
    expect(rec.cleanupFailed).toBe(false)
    expect(rec.status).toBe('connected')
    expect(rec.error).toBeUndefined()
    expect(rec.tools.length).toBeGreaterThan(0)
    expect(rec.pid).not.toBe(pid)
    expectChildAlive(rec.pid!)
    expect(ignoreExitCount(byePath)).toBe(2)
  }, 15_000)

  it('death gate refuses a recycled PID (stale birth-time identity)', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    // The probe delegates to the real platform identity until `reused` flips,
    // then reports a DIFFERENT birth-time identity at the same pid — a
    // deterministic simulation of PID reuse (forcing real reuse is racy).
    let reused = false
    const probe = (pid: number): string | null => (reused ? '999999999999999' : childIdentity(pid))
    const rec = makeRecord(stdioConfig(byePath, '--ignore-exit'), { closeTimeoutMs: 200, identityProbe: probe })
    await rec.connect()
    const pid = rec.pid!
    expect(rec.birthTime).not.toBeNull()
    await rec.close()
    expect(rec.cleanupFailed).toBe(true)

    // The real child dies externally…
    process.kill(pid, 'SIGKILL')
    await expectChildGone(pid)
    // …but the pid now reads as a DIFFERENT process: a mismatched identity can
    // never pass the gate, so recovery stays refused and no replacement spawns.
    reused = true
    await expect(rec.reconnect()).rejects.toThrow(/identity|reuse/i)
    expect(rec.cleanupFailed).toBe(true)
    expect(rec.pid).toBe(pid)
    expect(ignoreExitCount(byePath)).toBe(1)
  }, 15_000)

  it('reconnect racing an in-flight hung close refuses after teardown settles (no overlapping child)', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const rec = makeRecord(stdioConfig(byePath, '--ignore-exit'), { closeTimeoutMs: 200 })
    await rec.connect()
    const pid = rec.pid!
    expect(ignoreExitCount(byePath)).toBe(1)

    // close() queues the teardown (close race + exit confirmation); reconnect()
    // lands while it is still in flight, BEFORE cleanupFailed is set. The gate
    // must evaluate AFTER the teardown settles — not on the stale synchronous
    // flag — or the queued connect spawns a replacement over the live child.
    const closing = rec.close()
    const reconnecting = rec.reconnect()
    await expect(reconnecting).rejects.toThrow(/still alive/)
    await closing
    expect(rec.cleanupFailed).toBe(true)
    expect(rec.pid).toBe(pid)
    expect(ignoreExitCount(byePath)).toBe(1)
    expectChildAlive(pid)
  }, 15_000)

  // R5 regression pin: with the koffi FFI available, dead-pid identity reads
  // must stay on the microsecond FFI path — a per-read PowerShell fallback
  // (~0.5-0.9s each, blocking spawnSync) would stall every healthy close.
  // 10 reads in <500ms tolerates heavy load but fails by an order of
  // magnitude if the PS leg comes back. Runs only where FFI is available
  // (the same clean self-PID probe the capability gate uses); on koffi-absent
  // hosts the PS leg IS the intended rescue, so there is nothing to pin.
  it.runIf(process.platform === 'win32' && processIdentity(process.pid) !== null)(
    'dead-pid identity reads stay FFI-fast (no per-close PowerShell stall)',
    () => {
      const started = Date.now()
      for (let i = 0; i < 10; i++) expect(childIdentity(0x7fffffff)).toBeNull()
      expect(Date.now() - started).toBeLessThan(500)
    },
    15_000,
  )
})
