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
// Same shape as session-manager.test.ts but scoped here so the files can run
// independently (vi.mock hoists and would conflict if shared).

interface MockQueryHandle {
  options: Record<string, unknown>
  emit: (msg: unknown) => void
  finish: () => void
}

const mockHandles: MockQueryHandle[] = []

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
    rmSync(dir, { recursive: true, force: true })
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
    sm.create({ title: 'alpha' })
    sm.create({ title: 'beta' })
    const client = await connect()
    const snap = await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    if (snap.kind !== 'sessions-snapshot') throw new Error('narrowing')
    expect(snap.sessions).toHaveLength(2)
    await client.close()
  })

  it('broadcasts session-created when a session is spawned after connect', async () => {
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    const info = sm.create({ title: 'fresh' })
    const ev = await waitForFrame(client.frames, (f) => f.kind === 'session-created')
    if (ev.kind !== 'session-created') throw new Error('narrowing')
    expect(ev.session.id).toBe(info.id)
    await client.close()
  })

  it('replays history + forwards live messages after subscribe', async () => {
    const info = sm.create({})
    // Seed some history through send + result.
    sm.send(info.id, 'hello')
    mockHandles[0].emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
    mockHandles[0].emit({ type: 'result' })
    await tick()

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })

    const replay = await waitForFrame(client.frames, (f) => f.kind === 'replay')
    if (replay.kind !== 'replay') throw new Error('narrowing')
    expect(replay.sessionId).toBe(info.id)
    expect(replay.messages.length).toBeGreaterThanOrEqual(3) // user + assistant + result
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done')

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

  it('unsubscribe stops the per-session stream', async () => {
    const info = sm.create({})
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done')

    client.send({ kind: 'unsubscribe', sessionId: info.id })
    // A tick is enough to propagate the unsubscribe through the
    // SessionManager — its subscriber map is synchronous.
    await tick()

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
    // Connection should still be open.
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
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
    const info = sm.create({})
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done')

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

  it('concurrent subscribes from two clients each get their own replay', async () => {
    const info = sm.create({})
    sm.send(info.id, 'x')
    mockHandles[0].emit({ type: 'result' })
    await tick()

    const a = await connect()
    const b = await connect()
    await waitForFrame(a.frames, (f) => f.kind === 'sessions-snapshot')
    await waitForFrame(b.frames, (f) => f.kind === 'sessions-snapshot')
    a.send({ kind: 'subscribe', sessionId: info.id })
    b.send({ kind: 'subscribe', sessionId: info.id })

    const replayA = await waitForFrame(a.frames, (f) => f.kind === 'replay')
    const replayB = await waitForFrame(b.frames, (f) => f.kind === 'replay')
    if (replayA.kind !== 'replay' || replayB.kind !== 'replay') throw new Error('narrowing')
    expect(replayA.messages.length).toBe(replayB.messages.length)

    await a.close()
    await b.close()
  })
})
