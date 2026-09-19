import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebTransport } from './web'
import { getTransport, setTransport } from './index'

// The web transport is the only Transport that opens a network socket; its
// request framing and WebSocket wiring are otherwise exercised end-to-end by
// useApi.test.ts and useWsHub.test.tsx. These tests lock the seam itself.

describe('createWebTransport: request', () => {
  const transport = createWebTransport()

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('prefixes /api and returns a parsed JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
      text: () => Promise.resolve('{}'),
    }))
    const body = await transport.request('/sessions')
    expect(body).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('/api/sessions', expect.anything())
  })

  it('throws a shaped ApiError on non-ok JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ error: 'nope' }),
      text: () => Promise.resolve(''),
    }))
    await expect(transport.request('/missing')).rejects.toMatchObject({ message: 'nope', status: 404 })
  })
})

describe('createWebTransport: connect', () => {
  class FakeWebSocket {
    static readonly OPEN = 1
    static readonly CLOSED = 3
    static instances: FakeWebSocket[] = []
    readyState = FakeWebSocket.OPEN
    sent: string[] = []
    closeCalls: Array<{ code?: number; reason?: string }> = []
    private listeners = new Map<string, Set<(ev: { data?: string }) => void>>()
    constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
    addEventListener(type: string, fn: (ev: { data?: string }) => void) {
      let set = this.listeners.get(type)
      if (!set) { set = new Set(); this.listeners.set(type, set) }
      set.add(fn)
    }
    send(data: string) { this.sent.push(data) }
    close(code?: number, reason?: string) {
      this.closeCalls.push({ code, reason })
      this.readyState = FakeWebSocket.CLOSED
    }
    emit(type: string, ev: { data?: string } = {}) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev)
    }
  }

  let real: typeof globalThis.WebSocket
  beforeEach(() => {
    FakeWebSocket.instances = []
    real = globalThis.WebSocket
    ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  })
  afterEach(() => {
    ;(globalThis as { WebSocket: unknown }).WebSocket = real
  })

  const transport = createWebTransport()

  it('delivers parsed frames, and open/close/error callbacks', () => {
    const onFrame = vi.fn()
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const onError = vi.fn()
    transport.connect({ onFrame, onOpen, onClose, onError }, { url: 'ws://test/api/ws' })
    const ws = FakeWebSocket.instances[0]!

    ws.emit('open')
    ws.emit('message', { data: JSON.stringify({ kind: 'pong', nonce: 1 }) })
    ws.emit('error')
    ws.emit('close')

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onFrame).toHaveBeenCalledWith({ kind: 'pong', nonce: 1 })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('drops malformed payloads without calling onFrame', () => {
    const onFrame = vi.fn()
    transport.connect({ onFrame, onOpen: vi.fn(), onClose: vi.fn() })
    FakeWebSocket.instances[0]!.emit('message', { data: 'not json' })
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('sends frames as JSON only while open', () => {
    const conn = transport.connect({ onFrame: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() })
    const ws = FakeWebSocket.instances[0]!
    conn.send({ kind: 'ping', nonce: 3 })
    expect(ws.sent).toEqual([JSON.stringify({ kind: 'ping', nonce: 3 })])

    ws.readyState = FakeWebSocket.CLOSED
    conn.send({ kind: 'ping', nonce: 4 })
    expect(ws.sent).toHaveLength(1)
  })

  it('close() is a no-op when already closed', () => {
    const conn = transport.connect({ onFrame: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() })
    const ws = FakeWebSocket.instances[0]!
    conn.close(1000, 'bye')
    conn.close(1000, 'bye')
    expect(ws.closeCalls).toHaveLength(1)
  })
})

describe('getTransport: desktop bridge injection', () => {
  afterEach(() => {
    setTransport(null)
    delete (window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__
  })

  it('uses the injected realtime connect but keeps the web request path', () => {
    // The desktop bridge only overrides the realtime channel; REST stays on
    // fetch because the host proxies /api under the crw:// scheme.
    const fakeConnect = vi.fn()
    ;(window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__ = { connect: fakeConnect }
    setTransport(null)
    const t = getTransport()
    t.connect({ onFrame: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() })
    expect(fakeConnect).toHaveBeenCalledTimes(1)
  })

  it('falls back to a web transport when nothing is injected', () => {
    setTransport(null)
    const t = getTransport()
    expect(typeof t.request).toBe('function')
    expect(typeof t.connect).toBe('function')
  })
})
