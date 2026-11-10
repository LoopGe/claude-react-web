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
import { NativeMcpConnections } from './connections.js'

const fixturePath = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))

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