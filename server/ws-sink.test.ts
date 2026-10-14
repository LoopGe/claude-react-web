// Unit tests for WsWriteQueue's queueing/backpressure/overflow semantics.
//
// The drain is made deterministic with a fake WebSocket whose
// `bufferedAmount` sits above BACKPRESSURE_HIGH: the first enqueued frame is
// handed to `send` (recorded) but its completion callback is withheld, so
// the drain parks inside the backpressure await and everything enqueued
// afterwards stays queued until the test releases it.

import { describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { WsWriteQueue } from './ws-sink.js'

const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

/** Fake ws whose socket buffer is permanently full until `unblock()`.
 *  `send` records the wire and withholds completion callbacks so the drain
 *  stalls deterministically after the first frame. */
function makeBlockedWs() {
  const sent: string[] = []
  const closeCalls: Array<{ code?: number; reason?: string }> = []
  const heldCbs: Array<() => void> = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 2_000_000,
    sent,
    closeCalls,
    send(data: string, cb?: () => void) {
      sent.push(data)
      if (cb) heldCbs.push(cb)
    },
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason })
    },
    on() {},
    off() {},
    unblock() {
      ws.bufferedAmount = 0
    },
    async releaseAll() {
      ws.bufferedAmount = 0
      const cbs = heldCbs.splice(0)
      for (const cb of cbs) cb()
      // Let the drain continuation run to quiescence.
      for (let i = 0; i < 20; i++) await tick()
    },
  }
  return ws
}

function makeQueue(ws = makeBlockedWs()) {
  return { ws, queue: new WsWriteQueue(ws as unknown as WebSocket) }
}

describe('WsWriteQueue', () => {
  it('delivers frames in FIFO order while blocked on backpressure, then drains the remainder', async () => {
    const { ws, queue } = makeQueue()
    queue.enqueueRaw('F1', 'message') // escapes: handed to send, cb withheld
    queue.enqueueRaw('F2', 'message') // queued
    queue.enqueueRaw('F3', 'message') // queued
    expect(ws.sent).toEqual(['F1'])

    await ws.releaseAll()
    expect(ws.sent).toEqual(['F1', 'F2', 'F3'])
    expect(ws.closeCalls).toHaveLength(0)
  })

  it('exceeding MAX_QUEUE_CHARS force-closes the socket (slow-client overflow path)', () => {
    const { ws, queue } = makeQueue()
    const big = 'x'.repeat(8_000_001)
    queue.enqueueRaw(big, 'message')
    expect(ws.closeCalls).toHaveLength(1)
    expect(ws.closeCalls[0]!.code).toBe(1011)
    // Enqueue after the overflow-triggered stop is silently dropped.
    queue.enqueueRaw('never', 'message')
    expect(ws.sent).toHaveLength(0)
  })

  it('frames just under the cap do not close', () => {
    const { ws, queue } = makeQueue()
    queue.enqueueRaw('y'.repeat(7_999_999), 'message')
    expect(ws.closeCalls).toHaveLength(0)
  })

  it('stop() drops the queued backlog and rejects later enqueues', async () => {
    const { ws, queue } = makeQueue()
    queue.enqueueRaw('F1', 'message')
    queue.enqueueRaw('F2', 'message')
    queue.stop()
    await ws.releaseAll()
    expect(ws.sent).toEqual(['F1'])
    queue.enqueueRaw('F3', 'message')
    await tick()
    expect(ws.sent).toEqual(['F1'])
  })

  it('enqueue is dropped when the socket is not OPEN (existing semantics)', () => {
    const { ws, queue } = makeQueue()
    ws.readyState = 3 // CLOSED
    queue.enqueueRaw('never', 'message')
    expect(ws.sent).toHaveLength(0)
  })
})
