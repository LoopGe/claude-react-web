// Integration test for the WebSocket multiplexer. Spins up a real Node
// HTTP server + attaches the multiplexer + connects a `ws` client;
// drives the SessionManager through its canUseTool callback the same
// way the live SDK would. No real subprocess — the mocked SDK module
// from session-manager.test.ts would work here but this file keeps its
// own minimal mock so the two suites stay independent (otherwise
// vi.mock() ordering gets fragile).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { WebSocket } from 'ws'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// --- SDK mock ---------------------------------------------------------------
// Same shape as session-manager.test.ts but scope here so the files can run
// independently (vi.mock hoists and would conflict if shared).

interface MockQueryHandle {
  options: Record<string, unknown>
  emit: (msg: unknown) => void
  finish: () => void
}

const mockHandles: MockQueryHandle[] = []

// First-party in-process servers are injected at spawn; mock the registry so
// no real McpServer is constructed (the SDK mock above has no
// createSdkMcpServer) and spawn stays cheap.
const { mockInjectAll } = vi.hoisted(() => ({ mockInjectAll: vi.fn() }))
mockInjectAll.mockImplementation((cwd: string | null, enabled: (name: string) => boolean) => {
  if (enabled('git-tools') && cwd) return { 'git-tools': { type: 'sdk', name: 'git-tools' } }
  return undefined
})
vi.mock('./sdk-tools/registry.js', () => ({
  firstPartyRegistry: {
    injectAll: mockInjectAll,
    readOnlyToolFqns: () => new Set(),
    mutatingToolFqns: () => new Set(),
    list: () => [],
  },
}))
vi.mock('./sdk-tools/app-tools.js', () => ({
  APP_TOOLS_SERVER_NAME: 'git-tools',
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query({ options }: { prompt: unknown; options: Record<string, unknown> }) {
    const queue: unknown[] = []
    let waiter: ((v: IteratorResult<unknown>) => void) | null = null
    let done = false
    const pushResolved = (r: IteratorResult<unknown>) => {
      if (waiter) {
        const w = waiter
        waiter = null
        w(r)
      }
    }
    const handle: MockQueryHandle = {
      options,
      emit: (msg) => {
        if (done) return
        if (waiter) pushResolved({ value: msg, done: false })
        else queue.push(msg)
      },
      finish: () => {
        done = true
        pushResolved({ value: undefined, done: true })
      },
    }
    mockHandles.push(handle)
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
            if (done) return Promise.resolve({ value: undefined, done: true })
            return new Promise((r) => { waiter = r })
          },
          return(): Promise<IteratorResult<unknown>> {
            done = true
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      supportedAgents: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({})),
      getContextUsage: vi.fn(async () => ({})),
    }
  },
}))

// Imports AFTER vi.mock so they pick up the mocked SDK.
import { SessionManager } from './session-manager.js'
import { SessionStore } from './persistence.js'
import { attachWebSocket } from './ws.js'
import type { WsClientFrame, WsServerFrame } from './ws-protocol.js'

const tick = () => new Promise((r) => setImmediate(r))

/** Wait for `predicate` to return true on incoming frames. Resolves with
 *  the first matching frame; rejects on timeout. */
function waitForFrame(
  frames: WsServerFrame[],
  predicate: (f: WsServerFrame) => boolean,
  timeoutMs = 500,
): Promise<WsServerFrame> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const idx = frames.findIndex(predicate)
      if (idx >= 0) {
        resolve(frames[idx])
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for frame; got ${JSON.stringify(frames)}`))
        return
      }
      setTimeout(check, 5)
    }
    check()
  })
}

describe('WebSocket multiplexer', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let server: Server
  let port: number
  let shutdownWs: () => Promise<void>

  beforeEach(async () => {
    mockHandles.length = 0
    dir = mkdtempSync(join(tmpdir(), 'claude-rw-ws-'))
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
    server = createServer()
    shutdownWs = attachWebSocket(server, sm)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  })

  afterEach(async () => {
    await shutdownWs()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await sm.shutdown()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  /** Open a WS client and collect all frames into an array. Returns a
   *  small control handle for the test. */
  async function connect(): Promise<{
    ws: WebSocket
    frames: WsServerFrame[]
    send: (f: WsClientFrame) => void
    close: () => Promise<void>
  }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`)
    const frames: WsServerFrame[] = []
    ws.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8')
      try {
        frames.push(JSON.parse(text) as WsServerFrame)
      } catch {
        /* ignore */
      }
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return {
      ws,
      frames,
      send: (f) => ws.send(JSON.stringify(f)),
      close: () =>
        new Promise<void>((resolve) => {
          ws.once('close', () => resolve())
          ws.close()
        }),
    }
  }

  it('emits sessions-snapshot on connect', async () => {
    await sm.create({ title: 'alpha' })
    await sm.create({ title: 'beta' })
    const client = await connect()
    const snap = await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    if (snap.kind !== 'sessions-snapshot') throw new Error('narrowing')
    expect(snap.sessions).toHaveLength(2)
    await client.close()
  })

  it('broadcasts session-created when a session is spawned after connect', async () => {
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    const info = await sm.create({ title: 'fresh' })
    const ev = await waitForFrame(client.frames, (f) => f.kind === 'session-created')
    if (ev.kind !== 'session-created') throw new Error('narrowing')
    expect(ev.session.id).toBe(info.id)
    await client.close()
  })

  it('subscribe acks served and forwards live messages (no replay — history pages over REST)', async () => {
    const info = await sm.create({})
    // Seed some history through send + result.
    sm.send(info.id, 'hello')
    mockHandles[0].emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
    mockHandles[0].emit({ type: 'result' })
    await tick()

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })

    const ack = await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id,
    )
    if (ack.kind !== 'subscribe-result') throw new Error('narrowing')
    expect(ack).toMatchObject({ ok: true, reason: 'served' })
    // No transcript history is served on the wire anymore.
    expect(
      client.frames.some((f) => {
        const kind = (f as { kind: string }).kind
        return kind === 'replay' || kind === 'replay-done'
      }),
    ).toBe(false)

    // Emit a new live message; should arrive as a `message` frame.
    mockHandles[0].emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'follow-up' }] } })
    const live = await waitForFrame(
      client.frames,
      (f) => f.kind === 'message' && f.sessionId === info.id,
    )
    if (live.kind !== 'message') throw new Error('narrowing')
    const m = live.message as { type: string; message?: { content: Array<{ text?: string }> } }
    expect(m.type).toBe('assistant')

    await client.close()
  })

  it('replays completed hook runs with completed kind and refreshes activity', async () => {
    const info = await sm.create({})
    const before = sm.get(info.id).lastActivityAt
    await new Promise((r) => setTimeout(r, 5))
    mockHandles[0].emit({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'hook-1',
      hook_name: 'audit',
      hook_event: 'Stop',
    })
    mockHandles[0].emit({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'hook-1',
      hook_name: 'audit',
      hook_event: 'Stop',
      outcome: 'success',
      output: 'ok',
      stdout: 'ok',
      stderr: '',
    })
    await tick()
    expect(sm.get(info.id).lastActivityAt).toBeGreaterThan(before)

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    const frame = await waitForFrame(client.frames, (f) => f.kind === 'hook-run' && f.sessionId === info.id)
    if (frame.kind !== 'hook-run') throw new Error('narrowing')
    expect(frame.event).toMatchObject({ kind: 'completed', run: { id: 'hook-1', status: 'success', output: 'ok' } })
    await client.close()
  })

  it('unsubscribe stops the per-session stream', async () => {
    const info = await sm.create({})
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id,
    )

    client.send({ kind: 'unsubscribe', sessionId: info.id })
    // Wait for a real I/O turn so the unsubscribe frame has been READ and
    // processed server-side before we snapshot. A single tick() is NOT
    // enough: it resumes in the check phase, BEFORE the poll phase that
    // delivers the socket data — and the emit below then reaches the pump
    // via a microtask, so the broadcast can race ahead of the unsubscribe
    // and legitimately stream one message (observed as a ~80% flake).
    await new Promise((r) => setTimeout(r, 20))

    const before = client.frames.length
    mockHandles[0].emit({ type: 'assistant', message: { role: 'assistant', content: [] } })
    await new Promise((r) => setTimeout(r, 30))
    // No new `message` frame for this session.
    const newMessageFrames = client.frames
      .slice(before)
      .filter((f) => f.kind === 'message' && f.sessionId === info.id)
    expect(newMessageFrames).toHaveLength(0)
    await client.close()
  })

  it('ping is answered with pong echoing the nonce', async () => {
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'ping', nonce: 42 })
    const pong = await waitForFrame(client.frames, (f) => f.kind === 'pong')
    if (pong.kind !== 'pong') throw new Error('narrowing')
    expect(pong.nonce).toBe(42)
    await client.close()
  })

  it('subscribing to an unknown session sends an error frame (not a disconnect)', async () => {
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: 'definitely-not-a-real-id' })
    const err = await waitForFrame(client.frames, (f) => f.kind === 'error')
    if (err.kind !== 'error') throw new Error('narrowing')
    expect(err.message).toMatch(/not found/i)
    // The machine-readable half of the same answer: the client keys its channel
    // state on this, not on the English prose above.
    const ack = await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === 'definitely-not-a-real-id',
    )
    if (ack.kind !== 'subscribe-result') throw new Error('narrowing')
    expect(ack).toMatchObject({ ok: false, reason: 'refused' })
    // Connection should still be open.
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    await client.close()
  })

  it('answers a served subscribe, and re-attaches (already-live) on a duplicate', async () => {
    // A subscribe is per-connection and the caller's listener may have attached
    // AFTER the first subscribe (a panel remount, StrictMode's double mount, a
    // resume whose ack landed before <Chat> existed). Only the server can
    // know, so a duplicate must be answered with the already-live ack + the
    // pending-request re-broadcast rather than being swallowed — that silence
    // is what left resumed panels blank.
    const info = await sm.create({})
    sm.send(info.id, 'hello')
    mockHandles[0].emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
    mockHandles[0].emit({ type: 'result' })
    await tick()

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    const served = await waitForFrame(client.frames, (f) => f.kind === 'subscribe-result' && f.sessionId === info.id)
    if (served.kind !== 'subscribe-result') throw new Error('narrowing')
    expect(served).toMatchObject({ ok: true, reason: 'served' })

    client.frames.length = 0
    client.send({ kind: 'subscribe', sessionId: info.id })
    const again = await waitForFrame(client.frames, (f) => f.kind === 'subscribe-result' && f.sessionId === info.id)
    if (again.kind !== 'subscribe-result') throw new Error('narrowing')
    expect(again).toMatchObject({ ok: true, reason: 'already-live' })
    // The duplicate still delivers the attached handshake (the reconnect
    // catch-up trigger) and never re-serves transcript history.
    await waitForFrame(client.frames, (f) => f.kind === 'attached' && f.sessionId === info.id)
    expect(
      client.frames.some((f) => {
        const kind = (f as { kind: string }).kind
        return kind === 'replay' || kind === 'replay-done'
      }),
    ).toBe(false)
    await client.close()
  })

  it('subscribing to a known-but-dormant session auto-resumes it and acks served (no error)', async () => {
    // The reported bug: opening a dormant session mounts the Chat panel,
    // which subscribes immediately, while POST /resume is still in flight.
    // The server used to answer that subscribe with an `error` frame, and
    // the client never re-subscribed (its hub only re-subscribes on
    // reconnect) — leaving a white screen. Now the subscribe ensures the
    // session is loaded first.
    const info = await sm.create({})
    await sm.unload(info.id) // → known-but-dormant (persisted, not in memory)
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    // Subscribe WITHOUT any explicit /resume — the server must revive it.
    client.send({ kind: 'subscribe', sessionId: info.id })
    // The auto-resume broadcast + the subscribe ack, in either order.
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'session-created' && f.session?.id === info.id,
    )
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.ok === true,
    )
    // No error frame for this session — the hard 404 that dead-ended the UI.
    expect(client.frames.filter((f) => f.kind === 'error' && f.sessionId === info.id)).toHaveLength(0)
    // And the session really is live again (respawned, not errored out).
    expect(sm.get(info.id).running).toBe(true)
    await client.close()
  })

  it('re-subscribing on the same connection after the session was unloaded re-wires a fresh channel', async () => {
    // Regression for the warm-tab leg: a session opens in a panel, goes
    // dormant (server unloads it → its subscriber queues end → the channel
    // pump exits), then the user resumes it. The `subs` entry must be
    // removed on natural teardown — a stale entry would make the next
    // subscribe a subs.has() no-op and the resumed session would never get
    // (re)wired on this connection.
    const info = await sm.create({})
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.ok === true,
    )
    client.frames.length = 0

    await sm.unload(info.id)
    // Give the pump's natural teardown (queue end → loop exit → subs entry
    // removal) time to complete before re-subscribing.
    await new Promise((r) => setTimeout(r, 50))

    // The teardown is announced per-connection: nothing else on this wire says
    // the channel died (the global session-update feed is broadcast to every
    // tab, and some teardowns send nothing at all).
    const closed = client.frames.find((f) => f.kind === 'subscribe-result' && f.sessionId === info.id)
    expect(closed).toMatchObject({ ok: false, reason: 'closed' })

    // Re-subscribe (e.g. the client's resume recovery sends a fresh frame).
    client.send({ kind: 'subscribe', sessionId: info.id })
    // Must be served (ok:true), not swallowed by the subs.has() guard.
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.ok === true,
    )
    expect(client.frames.filter((f) => f.kind === 'error' && f.sessionId === info.id)).toHaveLength(0)

    // And live frames now flow through the re-wired channel: emit on the
    // resumed spawn's mock query handle → a `message` frame arrives.
    const handle = mockHandles.at(-1)!
    handle.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'after-resume' }] } })
    const live = await waitForFrame(
      client.frames,
      (f) => f.kind === 'message' && f.sessionId === info.id,
    )
    if (live.kind !== 'message') throw new Error('narrowing')
    await client.close()
  })

  it('does not answer a client-initiated unsubscribe with a closed result', async () => {
    // The client closed this channel itself; telling it the channel closed
    // would be noise on a path that runs on every panel unmount.
    const info = await sm.create({})
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.ok === true,
    )
    client.frames.length = 0

    client.send({ kind: 'unsubscribe', sessionId: info.id })
    await tick()
    await new Promise((r) => setTimeout(r, 30))
    expect(
      client.frames.filter(
        (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.reason === 'closed',
      ),
    ).toHaveLength(0)
    await client.close()
  })

  it('malformed JSON frame yields an error without disconnecting', async () => {
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.ws.send('{not json')
    const err = await waitForFrame(client.frames, (f) => f.kind === 'error')
    if (err.kind !== 'error') throw new Error('narrowing')
    expect(err.message).toMatch(/invalid json/i)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    await client.close()
  })

  it('closing the WS releases all subscribers on the SessionManager side', async () => {
    const info = await sm.create({})
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.ok === true,
    )

    // Probe the internal subscriber count via the manager's info(). One
    // subscriber right now.
    expect(sm.get(info.id).subscribers).toBe(1)
    await client.close()
    // Close propagation is async across the socket handshake; wait for
    // the server-side cleanup rather than assuming it lands in one tick.
    const start = Date.now()
    while (sm.get(info.id).subscribers !== 0) {
      if (Date.now() - start > 500) {
        throw new Error(`timed out waiting for subscriber cleanup; got ${sm.get(info.id).subscribers}`)
      }
      await tick()
    }
    expect(sm.get(info.id).subscribers).toBe(0)
  })

  it('concurrent subscribes from two clients each get their own served ack', async () => {
    const info = await sm.create({})
    sm.send(info.id, 'x')
    mockHandles[0].emit({ type: 'result' })
    await tick()

    const a = await connect()
    const b = await connect()
    await waitForFrame(a.frames, (f) => f.kind === 'sessions-snapshot')
    await waitForFrame(b.frames, (f) => f.kind === 'sessions-snapshot')
    a.send({ kind: 'subscribe', sessionId: info.id })
    b.send({ kind: 'subscribe', sessionId: info.id })

    const ackA = await waitForFrame(
      a.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.ok === true,
    )
    const ackB = await waitForFrame(
      b.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.ok === true,
    )
    if (ackA.kind !== 'subscribe-result' || ackB.kind !== 'subscribe-result') throw new Error('narrowing')
    expect(ackA.reason).toBe('served')
    expect(ackB.reason).toBe('served')
    // Each connection holds its own subscriber on the manager.
    expect(sm.get(info.id).subscribers).toBe(2)

    await a.close()
    await b.close()
  })
})

// --- Upgrade guard (Host / Origin) + inbound frame cap ---------------------

describe('WebSocket upgrade guard', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let server: Server
  let port: number
  let shutdownWs: () => Promise<void>

  beforeEach(async () => {
    mockHandles.length = 0
    dir = mkdtempSync(join(tmpdir(), 'claude-rw-ws-guard-'))
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
    server = createServer()
    // Listen FIRST: the guard needs the real bound port.
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
    shutdownWs = attachWebSocket(server, sm, undefined, { bind: { host: '127.0.0.1', port }, trustDevOrigins: true })
  })

  afterEach(async () => {
    await shutdownWs()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await sm.shutdown()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  /** Resolve 'open' (with the first frame) or the HTTP status of a refused upgrade. */
  function attempt(origin?: string): Promise<{ status: 'open'; ws: WebSocket; first: Promise<WsServerFrame> } | { status: number }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, origin ? { origin } : {})
    const first = new Promise<WsServerFrame>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as WsServerFrame))
    })
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve({ status: 'open', ws, first }))
      ws.once('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode ?? 0 })
        ws.terminate()
      })
      // `on`, not `once`: terminate() during CONNECTING emits a second error.
      ws.on('error', (err) => reject(err))
    })
  }

  it('accepts a client with no Origin and with the bound origin', async () => {
    for (const origin of [undefined, `http://127.0.0.1:${port}`]) {
      const r = await attempt(origin)
      if (r.status !== 'open') throw new Error(`expected open, got ${r.status}`)
      expect((await r.first).kind).toBe('sessions-snapshot')
      r.ws.close()
    }
  })

  it('accepts the Vite dev origin (proxied WS keeps the page Origin)', async () => {
    const r = await attempt('http://localhost:5174')
    if (r.status !== 'open') throw new Error(`expected open, got ${r.status}`)
    r.ws.close()
  })

  it('403s an evil Origin before the handshake', async () => {
    const r = await attempt('https://evil.example')
    expect(r.status).toBe(403)
  })

  it('403s a bad Host header (DNS rebinding)', async () => {
    const { request } = await import('node:http')
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/api/ws',
        headers: {
          Host: `evil.example:${port}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        },
      })
      req.on('upgrade', () => reject(new Error('upgrade should have been refused')))
      req.on('response', (res) => { resolve(res.statusCode ?? 0); res.resume() })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })

  it('closes an oversized inbound frame with 1009 while normal frames work', async () => {
    const r = await attempt()
    if (r.status !== 'open') throw new Error(`expected open, got ${r.status}`)
    const frames: WsServerFrame[] = []
    r.ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsServerFrame))
    await r.first
    r.ws.send(JSON.stringify({ kind: 'ping' }))
    await waitForFrame(frames, (f) => f.kind === 'pong')
    const code = await new Promise<number>((resolve) => {
      r.ws.once('close', (c) => resolve(c))
      r.ws.send('x'.repeat(70 * 1024))
    })
    expect(code).toBe(1009)
  })
})

describe('WebSocket upgrade guard (production)', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  let server: Server
  let port: number
  let shutdownWs: () => Promise<void>

  beforeEach(async () => {
    mockHandles.length = 0
    dir = mkdtempSync(join(tmpdir(), 'claude-rw-ws-guard-prod-'))
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
    server = createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
    shutdownWs = attachWebSocket(server, sm, undefined, { bind: { host: '127.0.0.1', port }, trustDevOrigins: false })
  })

  afterEach(async () => {
    await shutdownWs()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await sm.shutdown()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  function attempt(origin?: string): Promise<{ status: 'open'; ws: WebSocket } | { status: number }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, origin ? { origin } : {})
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve({ status: 'open', ws }))
      ws.once('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode ?? 0 })
        ws.terminate()
      })
      // `on`, not `once`: terminate() during CONNECTING emits a second error.
      ws.on('error', (err) => reject(err))
    })
  }

  it('403s the Vite dev origin when dev origins are not trusted', async () => {
    const r = await attempt('http://localhost:5174')
    expect(r.status).toBe(403)
  })

  it('still accepts the bound origin', async () => {
    const r = await attempt(`http://127.0.0.1:${port}`)
    if (r.status !== 'open') throw new Error(`expected open, got ${r.status}`)
    r.ws.close()
  })
})