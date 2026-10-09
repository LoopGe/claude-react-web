// Unit tests for the replay-burst registry — the bookkeeping behind the
// write-queue "supersede" rule: when a NEW replay burst for session S is
// enqueued on a connection, the still-queued (unsent) frames of OLDER
// same-session bursts — including their replay-done — are dropped, so a
// burst of duplicate re-serves cannot pile up ~12 full-ring replays and trip
// WsWriteQueue.MAX_QUEUE_CHARS (the "Stream reconnecting…" force-close).
//
// The registry owns only bookkeeping: entries carry `data` (for char
// accounting) and flags; the owning sink subtracts freed chars from its
// own totalChars and skips `dropped` entries in its drain loop.

import { describe, expect, it } from 'vitest'
import {
  ReplayBurstRegistry,
  createReplayBurstToken,
  type BurstQueueEntry,
} from './replay-bursts.js'

function entry(data: string, kind?: string, burst?: ReturnType<typeof createReplayBurstToken>): BurstQueueEntry {
  return { data, kind, burst }
}

describe('ReplayBurstRegistry', () => {
  it('appends entries under one token; a second burst supersedes the older unconsumed remainder', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    const e1 = entry('a'.repeat(10), 'replay', t1)
    const e2 = entry('b'.repeat(20), 'replay-done', t1)
    expect(reg.register(t1, e1)).toEqual({ frames: 0, chars: 0 })
    expect(reg.register(t1, e2)).toEqual({ frames: 0, chars: 0 })

    const t2 = createReplayBurstToken('s1')
    const freed = reg.register(t2, entry('c'.repeat(5), 'replay', t2))
    expect(freed).toEqual({ frames: 2, chars: 30 })
    expect(e1.dropped).toBe(true)
    expect(e2.dropped).toBe(true)
  })

  it('consumed entries are not superseded', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    const e1 = entry('a'.repeat(10), 'replay', t1)
    const e2 = entry('b'.repeat(20), 'replay-done', t1)
    reg.register(t1, e1)
    reg.register(t1, e2)
    e1.consumed = true // drain already handed it to the socket

    const t2 = createReplayBurstToken('s1')
    const freed = reg.register(t2, entry('c', 'replay', t2))
    expect(freed).toEqual({ frames: 1, chars: 20 })
    expect(e1.dropped).toBeUndefined()
    expect(e2.dropped).toBe(true)
  })

  it('already-dropped entries are not double-counted', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    const e1 = entry('a'.repeat(10), 'replay', t1)
    const e2 = entry('b'.repeat(20), 'replay-done', t1)
    reg.register(t1, e1)
    reg.register(t1, e2)
    e1.dropped = true // dropped by an earlier pass

    const t2 = createReplayBurstToken('s1')
    const freed = reg.register(t2, entry('c', 'replay', t2))
    expect(freed).toEqual({ frames: 1, chars: 20 })
  })

  it('consuming the replay-done deactivates the burst, so a later register frees nothing', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    const e1 = entry('a'.repeat(10), 'replay', t1)
    const done1 = entry('b'.repeat(20), 'replay-done', t1)
    reg.register(t1, e1)
    reg.register(t1, done1)
    reg.onConsumed(e1)
    reg.onConsumed(done1) // burst complete — nothing left queued

    const t2 = createReplayBurstToken('s1')
    const freed = reg.register(t2, entry('c', 'replay', t2))
    expect(freed).toEqual({ frames: 0, chars: 0 })
    expect(e1.dropped).toBeUndefined()
    expect(done1.dropped).toBeUndefined()
  })

  it('non-final consumption keeps the burst active (remainder still supersedeable)', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    const e1 = entry('a'.repeat(10), 'replay', t1)
    const e2 = entry('b'.repeat(20), 'replay', t1)
    reg.register(t1, e1)
    reg.register(t1, e2)
    reg.onConsumed(e1) // first chunk hit the wire, second still queued

    const t2 = createReplayBurstToken('s1')
    const freed = reg.register(t2, entry('c', 'replay', t2))
    expect(freed).toEqual({ frames: 1, chars: 20 })
  })

  it('bursts of different sessions never supersede each other', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    const e1 = entry('a'.repeat(10), 'replay', t1)
    reg.register(t1, e1)

    const t2 = createReplayBurstToken('s2')
    const freed = reg.register(t2, entry('b', 'replay', t2))
    expect(freed).toEqual({ frames: 0, chars: 0 })
    expect(e1.dropped).toBeUndefined()
  })

  it('subsequent entries of the same burst never re-supersede', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    reg.register(t1, entry('a'.repeat(10), 'replay', t1))
    reg.register(t1, entry('b'.repeat(20), 'replay', t1))

    const t2 = createReplayBurstToken('s1')
    expect(reg.register(t2, entry('c', 'replay', t2))).toEqual({ frames: 2, chars: 30 })
    expect(reg.register(t2, entry('d', 'replay-done', t2))).toEqual({ frames: 0, chars: 0 })
  })

  it('dropSession drops the active burst and a later register frees nothing', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    const e1 = entry('a'.repeat(10), 'replay', t1)
    const done1 = entry('b'.repeat(20), 'replay-done', t1)
    reg.register(t1, e1)
    reg.register(t1, done1)

    expect(reg.dropSession('s1')).toEqual({ frames: 2, chars: 30 })
    expect(e1.dropped).toBe(true)
    expect(done1.dropped).toBe(true)

    const t2 = createReplayBurstToken('s1')
    expect(reg.register(t2, entry('c', 'replay', t2))).toEqual({ frames: 0, chars: 0 })
  })

  it('dropSession respects consumed entries and deactivates', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    const e1 = entry('a'.repeat(10), 'replay', t1)
    const done1 = entry('b'.repeat(20), 'replay-done', t1)
    reg.register(t1, e1)
    reg.register(t1, done1)
    reg.onConsumed(e1)

    expect(reg.dropSession('s1')).toEqual({ frames: 1, chars: 20 })
    expect(e1.dropped).toBeUndefined()

    const t2 = createReplayBurstToken('s1')
    expect(reg.register(t2, entry('c', 'replay', t2))).toEqual({ frames: 0, chars: 0 })
  })

  it('dropSession for a session with no active burst is a no-op', () => {
    const reg = new ReplayBurstRegistry()
    expect(reg.dropSession('ghost')).toEqual({ frames: 0, chars: 0 })
  })

  it('deactivateAll releases every burst so a later register reports zero freed', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    reg.register(t1, entry('a'.repeat(10), 'replay', t1))
    reg.register(t1, entry('b'.repeat(20), 'replay-done', t1))

    reg.deactivateAll()

    const t2 = createReplayBurstToken('s1')
    expect(reg.register(t2, entry('c', 'replay', t2))).toEqual({ frames: 0, chars: 0 })
  })

  it('onConsumed after deactivation is a safe no-op', () => {
    const reg = new ReplayBurstRegistry()
    const t1 = createReplayBurstToken('s1')
    const e1 = entry('a', 'replay', t1)
    const done1 = entry('b', 'replay-done', t1)
    reg.register(t1, e1)
    reg.register(t1, done1)
    reg.deactivateAll()
    expect(() => {
      e1.consumed = true
      reg.onConsumed(e1)
      reg.onConsumed(done1)
    }).not.toThrow()
  })

  it('onConsumed of an entry without a burst token is a safe no-op', () => {
    const reg = new ReplayBurstRegistry()
    const bare = entry('x', 'message')
    expect(() => reg.onConsumed(bare)).not.toThrow()
    expect(bare.consumed).toBe(true)
  })
})
