// server/providers/native/mcp/shared-record.test.ts
//
// Real-process pins for one shared stdio connection's lifecycle. Nothing here
// mocks the MCP SDK: the stdio fixture is spawned for real, the child PID is
// captured from the transport, and teardown is proven by the fixture's `bye`
// marker plus a platform process-liveness check (koffi `processIdentity` on
// win32, `process.kill(pid, 0)` on POSIX).

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processIdentity } from '../../../win32-job.js'
import { disableLogRing, enableLogRing, getLogConfig, readLogRing, setLogConfig } from '../../../log.js'
import type { NativeMcpServerConfig } from './connections.js'
import { SharedRecord, sharingKey } from './shared-record.js'

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
  for (const rec of openRecords.splice(0)) await rec.close()
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
