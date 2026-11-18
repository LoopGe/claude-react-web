// server/providers/native/mcp/connections.test.ts
//
// Real transports throughout: an in-memory `McpServer` for the first-party
// (`type:'sdk'`) path and the stdio fixture for the external one. Nothing here
// mocks the MCP SDK — the point of the manager is the connect / discover /
// call / close lifecycle, so the tests exercise it end to end.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { NativeMcpConnections, type NativeMcpServerConfig } from './connections.js'
import { SharedRegistry } from './shared-registry.js'
import { childIdentity, sharingKey } from './shared-record.js'

const fixturePath = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))

// A healthy stdio child can outlive the default 5s close deadline under
// full-suite load: the exit-confirmation then marks cleanupFailed and the
// registry RETAINS the record, reddening the reg.size===0 pins. Give the
// healthy leg a generous close margin (a deliberately-hung pin keeps its own
// short closeTimeoutMs).
const HEALTHY_CLOSE_MS = 10_000

const abortSignal = () => new AbortController().signal

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'native-mcp-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
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

/** Prove a child is gone: win32 polls its birth-time identity until null,
 *  POSIX polls `kill(pid, 0)` until it throws (same probe the registry uses). */
async function expectChildGone(pid: number, ms = 5000): Promise<void> {
  await waitFor(() => childIdentity(pid) === null, ms, `child ${pid} to exit`)
}

/** A real in-memory MCP server with one `echo` tool. */
function echoServer(name = 'echo-server'): McpServer {
  const server = new McpServer({ name, version: '1.0.0' })
  server.registerTool(
    'echo',
    { description: 'Echo the given text back.', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )
  return server
}

describe('NativeMcpConnections', () => {
  it('connects an in-process server, discovers and calls its tools', async () => {
    const conns = new NativeMcpConnections()
    conns.load({ a: { type: 'sdk', instance: echoServer() } })
    await conns.whenReady()

    const [status] = conns.statuses()
    expect(status).toMatchObject({ name: 'a', status: 'connected', source: 'sdk', scope: 'session' })
    expect(status.serverInfo).toEqual({ name: 'echo-server', version: '1.0.0' })
    expect(status.config).toEqual({ type: 'sdk' })
    // Status carries the bare tool name; the model-facing name is the FQN.
    expect(status.tools).toEqual([{ name: 'echo', description: 'Echo the given text back.' }])

    const tools = conns.tools()
    expect(tools.map((t) => t.fqn)).toEqual(['mcp__a__echo'])
    expect(tools[0]).toMatchObject({ server: 'a', name: 'echo', rawName: 'echo' })
    // The `$schema` key is not part of the Anthropic tool schema.
    expect(tools[0].inputSchema).toEqual({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })

    const result = await conns.call('mcp__a__echo', { text: 'hi' }, abortSignal())
    expect(result.text).toContain('hi')
    expect(result.isError).toBeUndefined()

    await expect(conns.call('mcp__a__nope', {}, abortSignal())).rejects.toThrow('unknown MCP tool: mcp__a__nope')

    await conns.closeAll()
  }, 15_000)

  it('falls back to structured content when a tool returns no content blocks', async () => {
    const conns = new NativeMcpConnections()
    const structured = new McpServer({ name: 'structured-server', version: '1.0.0' })
    structured.registerTool(
      'structured',
      { description: 'Returns only structured content.' },
      async () => ({ content: [], structuredContent: { ok: 1 } }),
    )
    conns.load({ s: { type: 'sdk', instance: structured } })
    await conns.whenReady()

    const result = await conns.call('mcp__s__structured', {}, abortSignal())
    // An empty text block is rejected by the Messages API on the next round,
    // so the structured payload stands in for the missing text.
    expect(result.text).toContain('"ok":1')
    expect(result.text.length).toBeGreaterThan(0)

    await conns.closeAll()
  }, 15_000)

  it('never returns empty text for a tool with no output at all', async () => {
    const conns = new NativeMcpConnections()
    const silent = new McpServer({ name: 'silent-server', version: '1.0.0' })
    silent.registerTool(
      'silent',
      { description: 'Returns nothing.' },
      async () => ({ content: [] }),
    )
    conns.load({ s: { type: 'sdk', instance: silent } })
    await conns.whenReady()

    const result = await conns.call('mcp__s__silent', {}, abortSignal())
    expect(result.text).toBe('(no output)')

    await conns.closeAll()
  }, 15_000)

  it('connects a real stdio server, calls a tool and kills the child on closeAll', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const conns = new NativeMcpConnections()
    conns.load({ ext: { type: 'stdio', command: 'node', args: [fixturePath, byePath] } })
    await conns.whenReady()

    const [status] = conns.statuses()
    expect(status).toMatchObject({ name: 'ext', status: 'connected', scope: 'session' })
    expect(status.source).toBeUndefined()
    expect(status.config).toEqual({ type: 'stdio', command: 'node', args: [fixturePath, byePath] })
    expect(conns.tools().map((t) => t.fqn)).toEqual(['mcp__ext__echo'])

    const result = await conns.call('mcp__ext__echo', { text: 'hi over stdio' }, abortSignal())
    expect(result.text).toContain('hi over stdio')

    expect(existsSync(byePath)).toBe(false)
    await conns.closeAll()
    await waitFor(() => existsSync(byePath), 2000, 'the stdio child to be terminated')
    expect(conns.statuses()).toEqual([])
  }, 15_000)

  it('times out a hung connect without hanging whenReady and kills the child', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const conns = new NativeMcpConnections({ connectTimeoutMs: 100 })
    conns.load({ hung: { type: 'stdio', command: 'node', args: [fixturePath, byePath, '--hang'] } })

    // The load must settle on its own: a server that never answers the
    // handshake cannot block the session.
    await conns.whenReady()

    const [status] = conns.statuses()
    expect(status.status).toBe('failed')
    expect(status.error).toMatch(/timed out/)
    expect(status.tools).toEqual([])
    expect(conns.tools()).toEqual([])

    await waitFor(() => existsSync(byePath), 5000, 'the timed-out child to be terminated')
    await conns.closeAll()
  }, 15_000)

  it('closeAll aborts an in-flight connect instead of waiting out the timeout', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    // Default 10 s connect timeout: teardown must not wait for it.
    const conns = new NativeMcpConnections()
    conns.load({ hung: { type: 'stdio', command: 'node', args: [fixturePath, byePath, '--hang'] } })
    // Let the child spawn and the handshake get in flight.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const started = Date.now()
    await conns.closeAll()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(conns.statuses()).toEqual([])
    await waitFor(() => existsSync(byePath), 5000, 'the aborted child to be terminated')
  }, 15_000)

  it('closeAll aborts a stalled tool listing, not just a stalled handshake', async () => {
    // The handshake test above exercises the connect race; this one covers the
    // window AFTER `initialize` settles, where only the request's own signal
    // can end `listTools`. Regression guard for deleting the signal from
    // `discoverTools`: without it closeAll waits out the 10 s request timeout.
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const toolsRequested = `${byePath}.tools-requested`
    const conns = new NativeMcpConnections()
    conns.load({ stalled: { type: 'stdio', command: 'node', args: [fixturePath, byePath, '--hang-tools'] } })

    // The marker is written by the server's `tools/list` handler, so it proves
    // the handshake completed and discovery is the step in flight.
    await waitFor(() => existsSync(toolsRequested), 5000, 'the tools/list request to reach the server')
    const [pending] = conns.statuses()
    expect(pending.status).toBe('pending')
    expect(pending.tools).toEqual([])

    const started = Date.now()
    await conns.closeAll()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(conns.statuses()).toEqual([])
    await waitFor(() => existsSync(byePath), 5000, 'the stalled child to be terminated')
  }, 15_000)

  it('replace closes removed servers, keeps unchanged ones and reports bad configs', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const byePath2 = join(dir, 'bye2.txt')
    const conns = new NativeMcpConnections()
    const instance = echoServer()
    const closeSpy = vi.spyOn(instance, 'close')
    conns.load({ a: { type: 'sdk', instance } })
    await conns.whenReady()
    expect(conns.statuses().map((s) => s.name)).toEqual(['a'])

    const first = await conns.setServers({
      b: { type: 'stdio', command: 'node', args: [fixturePath, byePath] },
      bad: { type: 'stdio', command: 'definitely-not-allowed' },
    })
    expect(first.removed).toEqual(['a'])
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect([...first.added].sort()).toEqual(['b', 'bad'])
    expect(Object.keys(first.errors)).toEqual(['bad'])
    expect(first.errors.bad).toMatch(/allowlist/)
    expect(conns.statuses().map((s) => s.name)).toEqual(['b', 'bad'])
    expect(conns.statuses().find((s) => s.name === 'bad')?.status).toBe('failed')
    expect(conns.tools().map((t) => t.fqn)).toEqual(['mcp__b__echo'])
    expect(existsSync(byePath)).toBe(false)

    // A changed config reconnects and shows up in BOTH lists; unchanged
    // entries are kept as they are (the failed `bad` is not retried).
    const second = await conns.setServers({
      b: { type: 'stdio', command: 'node', args: [fixturePath, byePath2, '--other'] },
      bad: { type: 'stdio', command: 'definitely-not-allowed' },
    })
    expect(second.added).toEqual(['b'])
    expect(second.removed).toEqual(['b'])
    expect(second.errors).toEqual({})
    expect(conns.statuses().find((s) => s.name === 'b')?.status).toBe('connected')
    await waitFor(() => existsSync(byePath), 2000, 'the replaced stdio child to exit')

    const cleared = await conns.setServers(undefined)
    expect(cleared.added).toEqual([])
    expect([...cleared.removed].sort()).toEqual(['b', 'bad'])
    expect(conns.statuses()).toEqual([])
    expect(conns.tools()).toEqual([])
    await waitFor(() => existsSync(byePath2), 2000, 'the removed stdio child to exit')
    await conns.closeAll()
  }, 15_000)

  it('toggles a server off and back on', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const conns = new NativeMcpConnections()
    conns.load({ s: { type: 'stdio', command: 'node', args: [fixturePath, byePath] } })
    await conns.whenReady()
    expect(conns.statuses()[0].status).toBe('connected')

    await conns.toggle('s', false)
    expect(conns.statuses()[0]).toMatchObject({ name: 's', status: 'disabled' })
    expect(conns.statuses()[0].tools).toEqual([])
    expect(conns.tools()).toEqual([])

    await conns.toggle('s', true)
    expect(conns.statuses()[0].status).toBe('connected')
    expect(conns.tools().map((t) => t.fqn)).toEqual(['mcp__s__echo'])

    await expect(conns.toggle('nope', true)).rejects.toThrow('unknown MCP server: nope')
    await expect(conns.reconnect('nope')).rejects.toThrow('unknown MCP server: nope')

    await conns.closeAll()
  }, 15_000)

  it('reconnects an in-process server after toggling it off', async () => {
    // `McpServer.close()` clears its transport, so the SAME instance can be
    // connected again — not obvious from the SDK surface, and the toggle path
    // depends on it.
    const conns = new NativeMcpConnections()
    conns.load({ a: { type: 'sdk', instance: echoServer() } })
    await conns.whenReady()

    await conns.toggle('a', false)
    expect(conns.statuses()[0].status).toBe('disabled')
    await conns.toggle('a', true)
    expect(conns.statuses()[0].status).toBe('connected')
    expect(conns.tools().map((t) => t.fqn)).toEqual(['mcp__a__echo'])
    expect((await conns.call('mcp__a__echo', { text: 'again' }, abortSignal())).text).toContain('again')

    await conns.closeAll()
  }, 15_000)

  it('replaces a changed in-process entry (same name, new instance)', async () => {
    const conns = new NativeMcpConnections()
    const first = echoServer('first-server')
    const second = echoServer('second-server')
    const closeSpy = vi.spyOn(first, 'close')
    conns.load({ a: { type: 'sdk', instance: first } })
    await conns.whenReady()
    expect(conns.statuses()[0].serverInfo).toEqual({ name: 'first-server', version: '1.0.0' })

    const result = await conns.setServers({ a: { type: 'sdk', instance: second } })
    expect(result.added).toEqual(['a'])
    expect(result.removed).toEqual(['a'])
    expect(result.errors).toEqual({})
    expect(closeSpy).toHaveBeenCalledTimes(1)

    const [status] = conns.statuses()
    expect(status).toMatchObject({ name: 'a', status: 'connected', source: 'sdk' })
    expect(status.serverInfo).toEqual({ name: 'second-server', version: '1.0.0' })
    expect((await conns.call('mcp__a__echo', { text: 'new one' }, abortSignal())).text).toContain('new one')

    await conns.closeAll()
  }, 15_000)

  it('gives look-alike server names distinct FQNs while status keeps bare names', async () => {
    const conns = new NativeMcpConnections()
    conns.load({
      'a b': { type: 'sdk', instance: echoServer('space-server') },
      'a.b': { type: 'sdk', instance: echoServer('dot-server') },
    })
    await conns.whenReady()

    const tools = conns.tools()
    expect(tools).toHaveLength(2)
    const fqns = tools.map((t) => t.fqn)
    expect(new Set(fqns).size).toBe(2)
    for (const fqn of fqns) expect(fqn).toMatch(/^[A-Za-z0-9_-]{1,64}$/)

    // Both FQNs resolve to a live server: each name sanitizes to the same
    // prefix, so only the hash separates them.
    for (const fqn of fqns) {
      const echoed = await conns.call(fqn, { text: `via ${fqn}` }, abortSignal())
      expect(echoed.text).toContain(`via ${fqn}`)
    }

    // The status keeps the bare server-side tool name, not the FQN.
    expect(conns.statuses().map((s) => s.name).sort()).toEqual(['a b', 'a.b'])
    for (const status of conns.statuses()) expect(status.tools?.map((t) => t.name)).toEqual(['echo'])

    await conns.closeAll()
  }, 15_000)

  it('never exposes env or header values in status', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const conns = new NativeMcpConnections()
    conns.load({
      secret: {
        type: 'stdio',
        command: 'node',
        args: [fixturePath, byePath],
        env: { SECRET_TOKEN: 'super-secret-value' },
      },
      remote: {
        type: 'http',
        url: 'http://127.0.0.1:1/mcp',
        headers: { Authorization: 'Bearer header-secret-value' },
      },
    })
    await conns.whenReady()

    const json = JSON.stringify(conns.statuses())
    expect(json).not.toContain('super-secret-value')
    expect(json).not.toContain('header-secret-value')
    expect(json).not.toContain('SECRET_TOKEN')
    expect(json).not.toContain('Authorization')
    // `args` is included on purpose (the CLI's own status does the same).
    expect(conns.statuses().find((s) => s.name === 'secret')?.config).toEqual({
      type: 'stdio',
      command: 'node',
      args: [fixturePath, byePath],
    })

    await conns.closeAll()
  }, 15_000)

  it('closeAll is idempotent', async () => {
    const conns = new NativeMcpConnections()
    conns.load({ a: { type: 'sdk', instance: echoServer() } })
    await conns.whenReady()
    expect(conns.tools()).toHaveLength(1)

    await conns.closeAll()
    await expect(conns.closeAll()).resolves.toBeUndefined()
    expect(conns.statuses()).toEqual([])
    expect(conns.tools()).toEqual([])
    await expect(conns.call('mcp__a__echo', { text: 'x' }, abortSignal())).rejects.toThrow('unknown MCP tool')
  }, 15_000)
})

// The shared-registry view path: external stdio entries delegate to a
// host-global SharedRegistry (one child per sharing key, refcounted across
// views), while sdk/sse/http stay per-session. Real stdio children throughout;
// teardown is proven by the registry refcount AND a process-liveness probe.
describe('NativeMcpConnections over a shared registry', () => {
  function stdioCfg(byePath: string, env?: Record<string, string>): NativeMcpServerConfig {
    return { type: 'stdio', command: 'node', args: [fixturePath, byePath], ...(env ? { env } : {}) }
  }

  it('two views over one registry share a stdio child; toggle is view-level', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const cfg = stdioCfg(byePath)
    const reg = new SharedRegistry({ closeTimeoutMs: HEALTHY_CLOSE_MS })
    const v1 = new NativeMcpConnections({ registry: reg })
    const v2 = new NativeMcpConnections({ registry: reg })
    v1.load({ ext: cfg })
    v2.load({ ext: cfg })
    await v1.whenReady()
    await v2.whenReady()

    const rec = reg.get(sharingKey(cfg))!
    expect(rec).toBeDefined()
    expect(rec.users).toBe(2)
    expect(reg.size).toBe(1)
    const pid = rec.pid!
    expect(pid).toBeGreaterThan(0)
    expect(v1.tools().map((t) => t.fqn)).toEqual(['mcp__ext__echo'])
    expect(v2.tools().map((t) => t.fqn)).toEqual(['mcp__ext__echo'])
    expect((await v1.call('mcp__ext__echo', { text: 'one' }, abortSignal())).text).toContain('one')

    // View-level toggle: v1 hides its tools and drops its ref; v2 is untouched
    // and the shared child stays alive (users 1).
    await v1.toggle('ext', false)
    expect(v1.tools()).toEqual([])
    expect(v1.statuses()[0]).toMatchObject({ name: 'ext', status: 'disabled', scope: 'global' })
    expect(v2.tools().map((t) => t.fqn)).toEqual(['mcp__ext__echo'])
    expect(rec.users).toBe(1)
    expect(existsSync(byePath)).toBe(false)
    expect((await v2.call('mcp__ext__echo', { text: 'two' }, abortSignal())).text).toContain('two')

    // v1 already released its ref on toggle-off; closeAll must not release again.
    await v1.closeAll()
    expect(rec.users).toBe(1)
    expect(existsSync(byePath)).toBe(false)
    expect(v2.tools().map((t) => t.fqn)).toEqual(['mcp__ext__echo'])

    // The last view's closeAll tears the shared child down.
    await v2.closeAll()
    expect(rec.users).toBe(0)
    expect(reg.size).toBe(0)
    await expectChildGone(pid)
  }, 15_000)

  it('toggle(false) then closeAll does not double-release', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const cfg = stdioCfg(byePath)
    const reg = new SharedRegistry({ closeTimeoutMs: HEALTHY_CLOSE_MS })
    const v1 = new NativeMcpConnections({ registry: reg })
    const v2 = new NativeMcpConnections({ registry: reg })
    v1.load({ ext: cfg })
    v2.load({ ext: cfg })
    await v1.whenReady()
    await v2.whenReady()
    const rec = reg.get(sharingKey(cfg))!
    const pid = rec.pid!
    expect(rec.users).toBe(2)

    await v1.toggle('ext', false)
    expect(rec.users).toBe(1)
    await v1.closeAll()
    // The refcount must NOT underflow: v1's closeAll skips the already-released
    // entry, so v2's ref survives and the child stays alive.
    expect(rec.users).toBe(1)
    expect(reg.size).toBe(1)
    expect(existsSync(byePath)).toBe(false)
    expect(v2.tools().map((t) => t.fqn)).toEqual(['mcp__ext__echo'])

    await v2.closeAll()
    expect(rec.users).toBe(0)
    expect(reg.size).toBe(0)
    await expectChildGone(pid)
  }, 15_000)

  it('env-only change acquires a new shared child and releases the old', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const cfg1 = stdioCfg(byePath, { A: '1' })
    const cfg2 = stdioCfg(byePath, { A: '2' })
    const reg = new SharedRegistry({ closeTimeoutMs: HEALTHY_CLOSE_MS })
    const v1 = new NativeMcpConnections({ registry: reg })
    v1.load({ ext: cfg1 })
    await v1.whenReady()
    const rec1 = reg.get(sharingKey(cfg1))!
    const pid1 = rec1.pid!
    expect(rec1.users).toBe(1)

    // The env-excluded replace-diff identity is unchanged, but the env-INCLUDED
    // sharing key differs: a new child is acquired and the old one released.
    const result = await v1.setServers({ ext: cfg2 })
    expect(result.added).toEqual(['ext'])
    expect(result.removed).toEqual(['ext'])
    expect(result.errors).toEqual({})
    const rec2 = reg.get(sharingKey(cfg2))!
    expect(rec2).not.toBe(rec1)
    expect(rec2.pid).not.toBe(pid1)
    expect(reg.size).toBe(1)
    expect(reg.get(sharingKey(cfg1))).toBeUndefined()
    await expectChildGone(pid1)
    expect(v1.tools().map((t) => t.fqn)).toEqual(['mcp__ext__echo'])
    expect(v1.statuses()[0]).toMatchObject({ name: 'ext', status: 'connected', scope: 'global' })

    await v1.closeAll()
    expect(reg.size).toBe(0)
    await expectChildGone(rec2.pid!)
  }, 15_000)

  it('statuses label shared stdio global and sdk session', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const reg = new SharedRegistry({ closeTimeoutMs: HEALTHY_CLOSE_MS })
    const v1 = new NativeMcpConnections({ registry: reg })
    v1.load({ ext: stdioCfg(byePath), a: { type: 'sdk', instance: echoServer() } })
    await v1.whenReady()

    const statuses = v1.statuses()
    const ext = statuses.find((s) => s.name === 'ext')!
    expect(ext).toMatchObject({ status: 'connected', scope: 'global' })
    expect(ext.source).toBeUndefined()
    // The stdio-only gate: an sdk entry stays LOCAL even with a registry present.
    const a = statuses.find((s) => s.name === 'a')!
    expect(a).toMatchObject({ status: 'connected', scope: 'session', source: 'sdk' })
    expect(v1.tools().map((t) => t.fqn).sort()).toEqual(['mcp__a__echo', 'mcp__ext__echo'])
    expect(reg.size).toBe(1)

    await v1.closeAll()
    expect(reg.size).toBe(0)
    await waitFor(() => existsSync(byePath), 5000, 'the shared stdio child to exit')
  }, 15_000)

  it('re-projects shared tools under the session-local name and never leaks the sharing key', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const cfg = stdioCfg(byePath, { SECRET_TOKEN: 'super-secret-value' })
    const reg = new SharedRegistry({ closeTimeoutMs: HEALTHY_CLOSE_MS })
    const v1 = new NativeMcpConnections({ registry: reg })
    v1.load({ secret: cfg })
    await v1.whenReady()

    // The record stamps tools with the raw env-bearing sharing key; the view
    // MUST re-project server/fqn under the session-local name.
    const tools = v1.tools()
    expect(tools.map((t) => t.fqn)).toEqual(['mcp__secret__echo'])
    expect(tools[0]).toMatchObject({ server: 'secret', name: 'echo', rawName: 'echo' })
    const json = JSON.stringify({ statuses: v1.statuses(), tools })
    expect(json).not.toContain('super-secret-value')
    expect(json).not.toContain('SECRET_TOKEN')
    expect(json).not.toContain(sharingKey(cfg))
    expect(json).not.toContain('"env"')

    // call() resolves the session-local FQN to the record's rawName.
    expect((await v1.call('mcp__secret__echo', { text: 'hi' }, abortSignal())).text).toContain('hi')

    await v1.closeAll()
    expect(reg.size).toBe(0)
    await waitFor(() => existsSync(byePath), 5000, 'the shared stdio child to exit')
  }, 15_000)

  // The unowned-guard re-acquire paths: a DISABLED shared entry holds no ref,
  // so reconnect / toggle(true) must re-acquire ownership (users back to 1,
  // registry holds the record) — never revive the released record at users 0,
  // which would leave a connected child nobody owns or tears down.
  it('reconnect on a disabled shared entry re-acquires ownership', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const cfg = stdioCfg(byePath)
    const reg = new SharedRegistry({ closeTimeoutMs: HEALTHY_CLOSE_MS })
    const v1 = new NativeMcpConnections({ registry: reg })
    v1.load({ ext: cfg })
    await v1.whenReady()
    const rec = reg.get(sharingKey(cfg))!
    const pid = rec.pid!
    expect(rec.users).toBe(1)

    // Releasing the only ref reaps the child and removes the record.
    await v1.toggle('ext', false)
    expect(rec.users).toBe(0)
    expect(reg.size).toBe(0)
    await expectChildGone(pid)
    expect(v1.statuses()[0]).toMatchObject({ name: 'ext', status: 'disabled' })

    // reconnect re-acquires: a fresh OWNED record (users 1), not a revived
    // unowned one (which would leave reg.size 0 / users 0 with a live child).
    await v1.reconnect('ext')
    expect(reg.size).toBe(1)
    const rec2 = reg.get(sharingKey(cfg))!
    expect(rec2.users).toBe(1)
    expect(rec2.status).toBe('connected')
    expect(rec2.pid).toBeGreaterThan(0)
    expect(rec2.pid).not.toBe(pid)
    expect(v1.tools().map((t) => t.fqn)).toEqual(['mcp__ext__echo'])
    expect((await v1.call('mcp__ext__echo', { text: 'again' }, abortSignal())).text).toContain('again')

    // The re-acquired child is owned: closeAll releases the last ref, reaps it.
    await v1.closeAll()
    expect(rec2.users).toBe(0)
    expect(reg.size).toBe(0)
    await expectChildGone(rec2.pid!)
  }, 15_000)

  it('toggle(true) on a disabled shared entry re-acquires ownership', async () => {
    const dir = await tempDir()
    const byePath = join(dir, 'bye.txt')
    const cfg = stdioCfg(byePath)
    const reg = new SharedRegistry({ closeTimeoutMs: HEALTHY_CLOSE_MS })
    const v1 = new NativeMcpConnections({ registry: reg })
    v1.load({ ext: cfg })
    await v1.whenReady()
    const rec = reg.get(sharingKey(cfg))!
    const pid = rec.pid!
    expect(rec.users).toBe(1)

    await v1.toggle('ext', false)
    expect(rec.users).toBe(0)
    expect(reg.size).toBe(0)
    await expectChildGone(pid)

    // toggle(true) re-acquires ownership the same way reconnect does.
    await v1.toggle('ext', true)
    expect(reg.size).toBe(1)
    const rec2 = reg.get(sharingKey(cfg))!
    expect(rec2.users).toBe(1)
    expect(rec2.status).toBe('connected')
    expect(rec2.pid).toBeGreaterThan(0)
    expect(rec2.pid).not.toBe(pid)
    expect(v1.statuses()[0]).toMatchObject({ name: 'ext', status: 'connected', scope: 'global' })
    expect(v1.tools().map((t) => t.fqn)).toEqual(['mcp__ext__echo'])
    expect((await v1.call('mcp__ext__echo', { text: 'back' }, abortSignal())).text).toContain('back')

    await v1.closeAll()
    expect(rec2.users).toBe(0)
    expect(reg.size).toBe(0)
    await expectChildGone(rec2.pid!)
  }, 15_000)
})
