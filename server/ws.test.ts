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

  it('excludes stream_event deltas from the replay (durable transcript only)', async () => {
    // Regression: a heavy streaming turn emits many `stream_event` deltas
    // before the final assistant message. They are live-streamed to
    // subscribers but must NEVER enter the history ring — otherwise a
    // 500-cap ring fills with deltas and evicts durable content (a just-sent
    // user message, assistant messages, tool results) from the WS full-replay
    // surface, so a reload during/after the flood loses recent messages.
    const info = sm.create({})
    sm.send(info.id, 'hello')
    mockHandles[0].emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } },
    })
    mockHandles[0].emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tial' } },
    })
    mockHandles[0].emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
    mockHandles[0].emit({ type: 'result' })
    await tick()

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })

    const replay = await waitForFrame(client.frames, (f) => f.kind === 'replay')
    if (replay.kind !== 'replay') throw new Error('narrowing')
    const replayTypes = replay.messages.map((m) => (m as { type?: string }).type)
    expect(replayTypes.filter((t) => t === 'stream_event')).toHaveLength(0)
    // The durable content is all still there.
    expect(replay.messages.length).toBeGreaterThanOrEqual(3) // user + assistant + result
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done')
    await client.close()
  })

  /** Emit `count` assistant messages tagged m0..m{count-1} into the session's
   *  history ring and let the pump drain them. Replay chunks are exact slices
   *  of this ring, so tests can assert ordering by uuid. */
  async function seedHistory(count: number) {
    for (let i = 0; i < count; i++) {
      mockHandles[0].emit({
        type: 'assistant',
        uuid: `m${i}`,
        message: { role: 'assistant', content: [{ type: 'text', text: `m${i}` }] },
      })
    }
    await tick()
    await tick()
  }

  it('serves a no-cache cold start tail-first, newest→oldest backfill chunks', async () => {
    // Tail-first replay: a cold client (no sinceUuid) opts in and gets the
    // NEWEST chunk on the first frame so it can paint immediately, then the
    // older chunks newest→oldest for the client to prepend.
    const info = sm.create({})
    const TOTAL = 120
    await seedHistory(TOTAL)

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id, replayMode: 'tail-backfill' })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)

    const replays = client.frames.filter(
      (f): f is Extract<WsServerFrame, { kind: 'replay' }> =>
        f.kind === 'replay' && f.sessionId === info.id,
    )
    const uuidOf = (m: unknown) => (m as { uuid?: string }).uuid

    // Frame 0 is the tail: the newest 50, marked `tail`.
    expect(replays).toHaveLength(3) // tail + 2 backfill chunks
    expect(replays[0].tail).toBe(true)
    expect(replays[0].backfill).toBeUndefined()
    expect(replays[0].messages).toHaveLength(50)
    expect(uuidOf(replays[0].messages[0])).toBe('m70')
    expect(uuidOf(replays[0].messages[49])).toBe('m119')

    // The remaining chunks are backfill, ordered newest→oldest, each
    // internally chronological.
    const backfill = replays.slice(1)
    expect(backfill.every((f) => f.backfill === true && f.tail === undefined)).toBe(true)
    expect(backfill[0].messages).toHaveLength(50)
    expect(uuidOf(backfill[0].messages[0])).toBe('m20')
    expect(uuidOf(backfill[0].messages[49])).toBe('m69')
    expect(backfill[1].messages).toHaveLength(20)
    expect(uuidOf(backfill[1].messages[0])).toBe('m0')
    expect(uuidOf(backfill[1].messages[19])).toBe('m19')

    // The split is lossless: backfill reversed + tail reproduces the ring.
    const reassembled = [
      ...[...backfill].reverse().flatMap((f) => f.messages),
      ...replays[0].messages,
    ].map(uuidOf)
    expect(reassembled).toEqual(Array.from({ length: TOTAL }, (_, i) => `m${i}`))
    await client.close()
  })

  it('ignores replayMode when a sinceUuid is supplied (cached client)', async () => {
    // A sinceUuid implies a cached transcript on the client, and backfill
    // chunks are NEWER than a stale cache — prepending them would corrupt the
    // ordering. So tail mode is honored only with an absent sinceUuid.
    const info = sm.create({})
    await seedHistory(120)

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id, sinceUuid: 'm59', replayMode: 'tail-backfill' })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)

    const replays = client.frames.filter(
      (f): f is Extract<WsServerFrame, { kind: 'replay' }> =>
        f.kind === 'replay' && f.sessionId === info.id,
    )
    // Ordinary incremental chunks — no tail/backfill markers.
    expect(replays.every((f) => f.tail === undefined && f.backfill === undefined)).toBe(true)
    // Everything strictly after the anchor (m60..m119), in arrival order.
    const uuids = replays.flatMap((f) => f.messages).map((m) => (m as { uuid?: string }).uuid)
    expect(uuids).toEqual(Array.from({ length: 60 }, (_, i) => `m${i + 60}`))
    await client.close()
  })

  it('ignores replayMode when the client declares a cached transcript', async () => {
    // The protocol precondition for tail-first is "the client has NO
    // transcript on screen", which an absent sinceUuid only APPROXIMATES:
    // a client can hold cached rows with no cursor (an IDB cold-load
    // prepends rows without setting one). Backfill chunks are NEWER than
    // such a cache and are prepended to the FRONT, so the server must not
    // infer the precondition — it requires the client to state it.
    const info = sm.create({})
    await seedHistory(120)

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({
      kind: 'subscribe',
      sessionId: info.id,
      replayMode: 'tail-backfill',
      hasCachedTranscript: true,
    })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)

    const replays = client.frames.filter(
      (f): f is Extract<WsServerFrame, { kind: 'replay' }> =>
        f.kind === 'replay' && f.sessionId === info.id,
    )
    // Ordinary oldest-first chunks — no tail/backfill markers anywhere.
    expect(replays.every((f) => f.tail === undefined && f.backfill === undefined)).toBe(true)
    const uuids = replays.flatMap((f) => f.messages).map((m) => (m as { uuid?: string }).uuid)
    expect(uuids).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`))
    await client.close()
  })

  it('re-serves an already-live channel in the shape it was established with', async () => {
    // A second consumer (useGitStatus mounts beside useChatStream) subscribes
    // without opts. Re-serving it the ORDINARY full ring would send every
    // chunk the tail-first burst exists to avoid, and the client would buffer
    // and merge all of it for nothing.
    const info = sm.create({})
    await seedHistory(120)

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id, replayMode: 'tail-backfill' })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)

    // The bare second subscribe hits the already-live path.
    const before = client.frames.length
    client.send({ kind: 'subscribe', sessionId: info.id })
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.reason === 'already-live',
    )

    const reServed = client.frames
      .slice(before)
      .filter((f): f is Extract<WsServerFrame, { kind: 'replay' }> => f.kind === 'replay')
    expect(reServed[0].tail).toBe(true)
    expect(reServed.slice(1).every((f) => f.backfill === true)).toBe(true)
    await client.close()
  })

  it('carries pending snapshots on a re-served tail frame', async () => {
    // In tail mode the TAIL frame is the only carrier of the pending-request
    // snapshots (the terminator is payload-free by contract), so a re-serve
    // that omits them leaves a listener attaching to an already-live channel
    // with no permission card on its first paint.
    const info = sm.create({})
    await seedHistory(120)

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id, replayMode: 'tail-backfill' })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)

    const before = client.frames.length
    client.send({ kind: 'subscribe', sessionId: info.id, replayMode: 'tail-backfill' })
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'subscribe-result' && f.sessionId === info.id && f.reason === 'already-live',
    )

    const tail = client.frames
      .slice(before)
      .find((f): f is Extract<WsServerFrame, { kind: 'replay' }> => f.kind === 'replay' && f.tail === true)
    // The snapshot is present as a field (empty here — no pending requests in
    // this fixture) rather than omitted/null.
    expect(Array.isArray(tail?.permissions)).toBe(true)
    expect(Array.isArray(tail?.elicitations)).toBe(true)
    expect(Array.isArray(tail?.dialogs)).toBe(true)
    await client.close()
  })

  it('falls back to one ordinary replay frame when the history matches the tail chunk size', async () => {
    // The planner returns null (no backfill) and the caller must use the
    // ordinary path unchanged — the pre-tail behavior for short histories.
    const info = sm.create({})
    await seedHistory(50)

    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id, replayMode: 'tail-backfill' })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)

    const replays = client.frames.filter(
      (f): f is Extract<WsServerFrame, { kind: 'replay' }> =>
        f.kind === 'replay' && f.sessionId === info.id,
    )
    expect(replays).toHaveLength(1)
    expect(replays[0].tail).toBeUndefined()
    expect(replays[0].backfill).toBeUndefined()
    expect(replays[0].messages).toHaveLength(50)
    await client.close()
  })

  it('replays completed hook runs with completed kind and refreshes activity', async () => {
    const info = sm.create({})
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

  it('answers a served subscribe, and re-serves the replay on a duplicate', async () => {
    // A subscribe is per-connection and the caller's listener may have attached
    // AFTER the first burst (a panel remount, StrictMode's double mount, a
    // resume whose replay landed before <Chat> existed). Only the server can
    // know, so a duplicate must both answer and re-serve rather than being
    // swallowed — that silence is what left resumed panels blank.
    const info = sm.create({})
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
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)

    // Discard the first burst so the re-serve is unambiguous.
    client.frames.length = 0
    client.send({ kind: 'subscribe', sessionId: info.id })
    const again = await waitForFrame(client.frames, (f) => f.kind === 'subscribe-result' && f.sessionId === info.id)
    if (again.kind !== 'subscribe-result') throw new Error('narrowing')
    expect(again).toMatchObject({ ok: true, reason: 'already-live' })
    const replay = await waitForFrame(client.frames, (f) => f.kind === 'replay' && f.sessionId === info.id)
    if (replay.kind !== 'replay') throw new Error('narrowing')
    expect(replay.messages.length).toBeGreaterThanOrEqual(3)
    await client.close()
  })

  it('subscribing to a known-but-dormant session auto-resumes it and serves a replay (no error)', async () => {
    // The reported bug: opening a dormant session mounts the Chat panel,
    // which subscribes immediately, while POST /resume is still in flight.
    // The server used to answer that subscribe with `error` + empty
    // `replay-done`, and the client never re-subscribed (its hub only
    // re-subscribes on reconnect) — leaving a white screen. Now the
    // subscribe should ensure the session is loaded first.
    const info = sm.create({})
    await sm.unload(info.id) // → known-but-dormant (persisted, not in memory)
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    // Subscribe WITHOUT any explicit /resume — the server must revive it.
    client.send({ kind: 'subscribe', sessionId: info.id })
    // The auto-resume broadcast + the replay terminating, in either order.
    await waitForFrame(
      client.frames,
      (f) => f.kind === 'session-created' && f.session?.id === info.id,
    )
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)
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
    // (re)served a replay on this connection.
    const info = sm.create({})
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)
    // Discard the first subscribe's frames so the second replay is unambiguous.
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
    // Must be served a fresh replay, not swallowed by the subs.has() guard —
    // arriving at replay-done without an error proves the subscribe ran.
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)
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
    const info = sm.create({})
    const client = await connect()
    await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
    client.send({ kind: 'subscribe', sessionId: info.id })
    await waitForFrame(client.frames, (f) => f.kind === 'replay-done' && f.sessionId === info.id)
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
