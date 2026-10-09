// Unit tests for WsWriteQueue's replay-burst supersede: a NEW replay burst
// for a session drops the still-queued (unsent) frames of the OLDER
// same-session burst — including its replay-done — so a storm of duplicate
// re-serves cannot pile ~12 full-ring replays into one connection's queue
// and trip MAX_QUEUE_CHARS (1011 force-close → "Stream reconnecting…").
//
// The drain is made deterministic with a fake WebSocket whose
// `bufferedAmount` sits above BACKPRESSURE_HIGH: the first enqueued frame is
// handed to `send` (recorded) but its completion callback is withheld, so
// the drain parks inside the backpressure await and everything enqueued
// afterwards stays queued until the test releases it.

import { describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { WsWriteQueue } from './ws-sink.js'
import { createReplayBurstToken } from './replay-bursts.js'

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

const REPLAY_DONE_JSON = JSON.stringify({ kind: 'replay-done', sessionId: 's1' })

describe('WsWriteQueue replay-burst supersede', () => {
  it('delivers untagged frames unchanged (broadcast hot-path regression guard)', async () => {
    const { ws, queue } = makeQueue()
    ws.unblock()
    queue.enqueueRaw(JSON.stringify({ kind: 'message', sessionId: 's1' }), 'message')
    queue.enqueueRaw(JSON.stringify({ kind: 'message', sessionId: 's2' }), 'message')
    await tick()
    expect(ws.sent).toHaveLength(2)
    expect(ws.closeCalls).toHaveLength(0)
  })

  it('a new burst drops the queued remainder of the older same-session burst — exactly one replay-done reaches the wire', async () => {
    const { ws, queue } = makeQueue()
    const t1 = createReplayBurstToken('s1')
    queue.enqueueRaw('B1-CHUNK-1', 'replay', t1) // escapes: handed to send, cb withheld
    queue.enqueueRaw('B1-CHUNK-2', 'replay', t1) // queued
    queue.enqueueRaw(REPLAY_DONE_JSON, 'replay-done', t1) // queued
    const t2 = createReplayBurstToken('s1')
    queue.enqueueRaw('B2-CHUNK-1', 'replay', t2) // supersedes B1 remainder
    queue.enqueueRaw(REPLAY_DONE_JSON, 'replay-done', t2)

    await ws.releaseAll()

    expect(ws.sent).toEqual(['B1-CHUNK-1', 'B2-CHUNK-1', REPLAY_DONE_JSON])
    expect(ws.sent.filter((d) => d.includes('replay-done'))).toHaveLength(1)
    expect(ws.closeCalls).toHaveLength(0)
  })

  it('a 12-burst storm of ~1MB frames never trips MAX_QUEUE_CHARS', async () => {
    const { ws, queue } = makeQueue()
    const big = 'x'.repeat(1_000_000)
    for (let i = 0; i < 12; i++) {
      const t = createReplayBurstToken('s1')
      queue.enqueueRaw(big, 'replay', t)
      queue.enqueueRaw(REPLAY_DONE_JSON, 'replay-done', t)
    }
    // Nothing released yet — the queue must already be under the cap because
    // every burst but the newest was superseded while queued.
    expect(ws.closeCalls).toHaveLength(0)

    await ws.releaseAll()
    // The drain is blocked the whole time, so every burst except the
    // newest is superseded while FULLY queued (its ~1MB never reaches the
    // wire): only burst 0's first frame escaped at enqueue time, then the
    // final burst's frame + replay-done. Wire bytes collapse from ~12MB
    // to ~2MB.
    expect(ws.sent).toEqual([big, big, REPLAY_DONE_JSON])
    expect(ws.sent.filter((d) => d.includes('replay-done'))).toHaveLength(1)
    const wireChars = ws.sent.reduce((n, d) => n + d.length, 0)
    expect(wireChars).toBeLessThan(3_000_000)
    expect(ws.closeCalls).toHaveLength(0)
  })

  it('dropSessionReplays removes the session\'s queued burst remainder (unsubscribe path)', async () => {
    const { ws, queue } = makeQueue()
    const t1 = createReplayBurstToken('s1')
    queue.enqueueRaw('B1-CHUNK-1', 'replay', t1) // escapes
    queue.enqueueRaw(REPLAY_DONE_JSON, 'replay-done', t1) // queued

    const freed = queue.dropSessionReplays('s1')
    expect(freed).toEqual({ frames: 1, chars: REPLAY_DONE_JSON.length })

    await ws.releaseAll()
    expect(ws.sent).toEqual(['B1-CHUNK-1'])
    expect(ws.sent.some((d) => d.includes('replay-done'))).toBe(false)
  })

  it('freed chars keep the cap honest: 1MB sent + 0.5MB superseded + 7.9MB live does not close', async () => {
    const { ws, queue } = makeQueue()
    const t1 = createReplayBurstToken('s1')
    queue.enqueueRaw('y'.repeat(1_000_000), 'replay', t1) // escapes (consumed)
    queue.enqueueRaw('z'.repeat(500_000), 'replay-done', t1) // queued

    const t2 = createReplayBurstToken('s1')
    // Pre-supersede this enqueue would push total to 8.4MB > 8M and close.
    queue.enqueueRaw('w'.repeat(7_900_000), 'replay', t2)
    expect(ws.closeCalls).toHaveLength(0)

    await ws.releaseAll()
    expect(ws.closeCalls).toHaveLength(0)
    expect(ws.sent).toContain('w'.repeat(7_900_000))
    expect(ws.sent.some((d) => d === 'z'.repeat(500_000))).toBe(false)
  })

  it('stop() releases burst state so later accounting cannot go negative', () => {
    const { queue } = makeQueue()
    const t1 = createReplayBurstToken('s1')
    queue.enqueueRaw('B1', 'replay', t1)
    queue.stop()
    expect(queue.dropSessionReplays('s1')).toEqual({ frames: 0, chars: 0 })
    // Enqueue after stop is silently dropped (existing semantics).
    expect(() => queue.enqueueRaw('B2', 'replay', createReplayBurstToken('s1'))).not.toThrow()
  })

  it('enqueue is dropped when the socket is not OPEN (existing semantics)', () => {
    const { ws, queue } = makeQueue()
    ws.readyState = 3 // CLOSED
    queue.enqueueRaw('never', 'replay')
    expect(ws.sent).toHaveLength(0)
  })
})
