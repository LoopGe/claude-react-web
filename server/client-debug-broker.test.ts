import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { WsClientDebugRequest } from './ws-protocol.js'
import { ClientDebugBroker } from './client-debug-broker.js'

/** Capture broadcast frames; return a configurable "tabs reached" count. */
function makeTransport(tabs = 1) {
  const frames: WsClientDebugRequest[] = []
  const broadcast = (frame: WsClientDebugRequest) => {
    frames.push(frame)
    return tabs
  }
  return { frames, broadcast }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ClientDebugBroker', () => {
  it('broadcasts a request frame with a server-minted id and resolves with the client result', async () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast)

    const promise = broker.request('dom_query', { selector: '.foo' })
    await vi.waitFor(() => expect(t.frames).toHaveLength(1))

    const frame = t.frames[0]
    expect(frame.kind).toBe('client-debug-request')
    expect(frame.op).toBe('dom_query')
    expect(frame.params).toEqual({ selector: '.foo' })
    expect(typeof frame.id).toBe('string')

    const resolved = broker.resolve(frame.id, { ok: true, result: { nodes: ['x'] } })
    expect(resolved).toBe(true)
    await expect(promise).resolves.toEqual({ nodes: ['x'] })
  })

  it('rejects with the client error when the answer is ok:false', async () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast, { failureGraceMs: 10 })

    const promise = broker.request('dom_eval', { code: '1+1' })
    await vi.waitFor(() => expect(t.frames).toHaveLength(1))
    broker.resolve(t.frames[0].id, { ok: false, error: 'boom' })
    await vi.advanceTimersByTimeAsync(20)

    await expect(promise).rejects.toThrow('boom')
  })

  it('lets a success answer beat an earlier failure answer within the grace window', async () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast, { failureGraceMs: 1000 })

    const promise = broker.request('dom_computed_styles', { selector: '.x' })
    await vi.waitFor(() => expect(t.frames).toHaveLength(1))
    // A stale tab answers failure first…
    broker.resolve(t.frames[0].id, { ok: false, error: 'no element matches' })
    // …and a healthy tab's success lands inside the grace window.
    await vi.advanceTimersByTimeAsync(500)
    expect(broker.resolve(t.frames[0].id, { ok: true, result: { styles: {} } })).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toEqual({ styles: {} })
  })

  it('rejects with the first failure error after the grace window when no success arrives', async () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast, { failureGraceMs: 100 })

    const promise = broker.request('dom_query', { selector: '.x' })
    await vi.waitFor(() => expect(t.frames).toHaveLength(1))
    broker.resolve(t.frames[0].id, { ok: false, error: 'no element matches ".x"' })
    // Still pending during the grace window (the main timeout is far away).
    await vi.advanceTimersByTimeAsync(50)
    expect(broker.pendingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).rejects.toThrow('no element matches ".x"')
  })

  it('rejects immediately when no browser tab is connected', async () => {
    const t = makeTransport(0)
    const broker = new ClientDebugBroker(t.broadcast)

    await expect(broker.request('dom_query', { selector: 'body' })).rejects.toThrow(/no connected browser tab/i)
  })

  it('times out when no tab answers', async () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast, { timeoutMs: 100 })

    const promise = broker.request('dom_query', {})
    const assertion = expect(promise).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(150)
    await assertion
  })

  it('gives dom_screenshot a longer default timeout than the 10s read ops', async () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast)

    const query = broker.request('dom_query', { selector: 'body' })
    const shot = broker.request('dom_screenshot', {})
    await vi.waitFor(() => expect(t.frames).toHaveLength(2))
    const queryAssertion = expect(query).rejects.toThrow(/timed out/)
    const shotAssertion = expect(shot).rejects.toThrow(/timed out/)

    // At 10s the query op expires but the screenshot must still be pending.
    await vi.advanceTimersByTimeAsync(10_000)
    await queryAssertion
    expect(broker.pendingCount).toBe(1)

    // The screenshot expires at its own (longer) deadline.
    await vi.advanceTimersByTimeAsync(50_000)
    await shotAssertion
    expect(broker.pendingCount).toBe(0)
  })

  it('resolves an unknown id as false (already answered or never existed)', () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast)
    expect(broker.resolve(randomUUID(), { ok: true, result: null })).toBe(false)
  })

  it('keeps concurrent requests isolated by id', async () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast)

    const p1 = broker.request('dom_query', { selector: '#a' })
    const p2 = broker.request('dom_query', { selector: '#b' })
    await vi.waitFor(() => expect(t.frames).toHaveLength(2))

    broker.resolve(t.frames[1].id, { ok: true, result: 'second' })
    broker.resolve(t.frames[0].id, { ok: true, result: 'first' })
    await expect(p1).resolves.toBe('first')
    await expect(p2).resolves.toBe('second')
  })

  it('disposeAll rejects every pending request', async () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast)

    const p1 = broker.request('dom_query', { selector: '#a' })
    const p2 = broker.request('dom_eval', { code: '1' })
    await vi.waitFor(() => expect(t.frames).toHaveLength(2))

    broker.disposeAll('shutting down')
    await expect(p1).rejects.toThrow(/shutting down/)
    await expect(p2).rejects.toThrow(/shutting down/)
    expect(broker.pendingCount).toBe(0)
  })

  it('clears the timeout timer once resolved (no dangling timer)', async () => {
    const t = makeTransport()
    const broker = new ClientDebugBroker(t.broadcast, { timeoutMs: 100 })

    const promise = broker.request('dom_query', { selector: 'body' })
    await vi.waitFor(() => expect(t.frames).toHaveLength(1))
    broker.resolve(t.frames[0].id, { ok: true, result: 42 })
    await expect(promise).resolves.toBe(42)

    // Advancing past the original timeout must not reject a settled promise
    // or throw an unhandled rejection.
    await vi.advanceTimersByTimeAsync(200)
    expect(broker.pendingCount).toBe(0)
  })
})
