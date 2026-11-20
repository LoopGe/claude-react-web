import { describe, expect, it, vi } from 'vitest'
import { HttpError } from './errors.js'
import { createPushable } from './pushable.js'
import {
  ScheduledSendManager,
  MIN_DELAY_MS,
  MAX_PENDING_PER_SESSION,
  type ScheduledSendDeps,
} from './scheduled-send-manager.js'
import type { ScheduledSendBody } from '../shared/scheduled-send.js'
import { REBUILD_REQUIRED } from '../shared/ws-protocol.js'

/** Build a manager with a controllable clock + fake send. Does NOT start
 *  timers (tickMs keeps the interval inert at 24 h); tests drive tick()
 *  directly. */
function make(deps?: Partial<ScheduledSendDeps>) {
  let now = 1_000_000
  const send = vi.fn(async (_sessionId: string, _body: ScheduledSendBody) => ({ uuid: 'sent-uuid' }))
  const m = new ScheduledSendManager({
    send,
    now: () => now,
    tickMs: 86_400_000,
    ...deps,
  })
  return { m, send, setNow: (n: number) => { now = n } }
}

describe('ScheduledSendManager', () => {
  it('create rejects a fireAt in the past or too close', () => {
    const { m } = make() // initial now is fixed at 1_000_000
    expect(() => m.create('s1', { text: 'hi' }, 1_000_000 + MIN_DELAY_MS)).toThrow(HttpError)
    expect(() => m.create('s1', { text: 'hi' }, Number.NaN)).toThrow(HttpError)
  })

  it('create returns a pending record and list() shows it', () => {
    const { m } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    expect(rec).toMatchObject({ sessionId: 's1', body: { text: 'hi' }, status: 'pending' })
    expect(m.list('s1').map((r) => r.id)).toEqual([rec.id])
  })

  it('create enforces the per-session pending cap', () => {
    const { m } = make()
    const t = 2_000_000
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) m.create('s1', { text: `m${i}` }, t + i)
    expect(() => m.create('s1', { text: 'overflow' }, t + 1000)).toThrow(/too many/)
  })

  it('tick sends a due pending and marks it sent', async () => {
    const { m, send, setNow } = make()
    m.create('s1', { text: 'hi' }, 2_000_000)
    setNow(2_000_001)
    await m.tick()
    expect(send).toHaveBeenCalledWith('s1', { text: 'hi' })
    expect(m.list('s1')[0]?.status).toBe('sent')
  })

  it('tick leaves an undue pending alone', async () => {
    const { m, send } = make()
    m.create('s1', { text: 'hi' }, 2_000_000)
    await m.tick()
    expect(send).not.toHaveBeenCalled()
    expect(m.list('s1')[0]?.status).toBe('pending')
  })

  it('tick marks a send failure as failed with reason', async () => {
    const { m, setNow } = make({
      send: vi.fn(async () => { throw new HttpError(410, 'session s1 is terminated') }),
    })
    m.create('s1', { text: 'hi' }, 2_000_000)
    setNow(2_000_001)
    await m.tick()
    expect(m.list('s1')[0]?.status).toBe('failed')
    expect(m.list('s1')[0]?.error).toMatch(/terminated/)
  })

  it('remove on a pending record cancels it', () => {
    const { m } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    m.remove('s1', rec.id)
    expect(m.list('s1')[0]?.status).toBe('cancelled')
  })

  it('remove on a terminal record drops it (dismiss)', () => {
    const { m } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    m.remove('s1', rec.id) // pending → cancelled (terminal ring)
    m.remove('s1', rec.id) // terminal → removed
    expect(m.list('s1').some((r) => r.id === rec.id)).toBe(false)
  })

  it('remove on an unknown id throws 404', () => {
    const { m } = make()
    expect(() => m.remove('s1', 'nope')).toThrow(HttpError)
  })

  it('cancelAll drops the session entirely', () => {
    const { m } = make()
    m.create('s1', { text: 'hi' }, 2_000_000)
    m.cancelAll('s1')
    expect(m.list('s1')).toEqual([])
  })

  it('subscribes to global removal and cancels that session', async () => {
    const queue = createPushable<{ kind: string; id?: string }>('test-global')
    const { m } = make({ subscribeGlobal: () => ({ iterable: queue.iterable, unsubscribe: () => queue.end() }) })
    // Create BOTH sessions first, then push removal — otherwise the async
    // consumer could process `removed s1` before create(s1) registers it.
    m.create('s1', { text: 'hi' }, 2_000_000)
    m.create('s2', { text: 'keep' }, 2_000_000)
    queue.push({ kind: 'removed', id: 's1' })
    // Let the manager's background consumer drain the pushed event.
    await new Promise((r) => setTimeout(r, 0))
    expect(m.list('s1')).toEqual([])
    expect(m.list('s2')).toHaveLength(1)
    m.shutdown()
  })

  it('shutdown stops the interval', async () => {
    const { m } = make()
    m.shutdown()
    // No private-field peek: shutdown must leave tick() safe to call.
    await expect(m.tick()).resolves.toBeUndefined()
  })

  describe('REBUILD_REQUIRED deferral (spec §8.1)', () => {
    it('a due send refused with REBUILD_REQUIRED is deferred, not failed, and sends once admission restores', async () => {
      let blocked = true
      const { m, setNow } = make({
        send: vi.fn(async () => {
          if (blocked) throw new HttpError(409, REBUILD_REQUIRED)
          return { uuid: 'sent-uuid' }
        }),
      })
      const rec = m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      expect(m.list('s1').map((r) => r.status)).toEqual(['deferred'])
      blocked = false
      await m.tick()
      const after = m.list('s1')
      expect(after).toHaveLength(1) // not duplicated, not lost
      expect(after[0]).toMatchObject({ id: rec.id, status: 'sent', sentUuid: 'sent-uuid' })
    })

    it('deferred sends retry in original attempt order', async () => {
      let blocked = true
      const calls: string[] = []
      const { m, setNow } = make({
        send: vi.fn(async (_id: string, body: ScheduledSendBody) => {
          calls.push('text' in body ? body.text : '<content>')
          if (blocked) throw new HttpError(409, REBUILD_REQUIRED)
          return { uuid: 'u' }
        }),
      })
      m.create('s1', { text: 'first' }, 2_000_000)
      m.create('s1', { text: 'second' }, 2_000_001)
      setNow(2_000_002)
      await m.tick()
      expect(calls).toEqual(['first', 'second'])
      expect(m.list('s1').map((r) => r.status)).toEqual(['deferred', 'deferred'])
      blocked = false
      calls.length = 0
      await m.tick()
      expect(calls).toEqual(['first', 'second'])
      expect(m.list('s1').map((r) => r.status)).toEqual(['sent', 'sent'])
    })

    it('still-blocked deferred sends stay a single deferred record across ticks', async () => {
      const send = vi.fn(async () => { throw new HttpError(409, REBUILD_REQUIRED) })
      const { m, setNow } = make({ send })
      m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      await m.tick()
      await m.tick()
      expect(send).toHaveBeenCalledTimes(3) // retried each tick, never double-fired
      expect(m.list('s1').map((r) => r.status)).toEqual(['deferred'])
    })

    it('a deferred send that hits a different error fails terminally', async () => {
      let blocked = true
      const { m, setNow } = make({
        send: vi.fn(async () => {
          if (blocked) throw new HttpError(409, REBUILD_REQUIRED)
          throw new HttpError(410, 'session s1 is terminated')
        }),
      })
      m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      blocked = false
      await m.tick()
      expect(m.list('s1').map((r) => r.status)).toEqual(['failed'])
      expect(m.list('s1')[0]?.error).toMatch(/terminated/)
    })

    it('a non-REBUILD_REQUIRED 409 still fails terminally (not deferred)', async () => {
      const { m, setNow } = make({
        send: vi.fn(async () => { throw new HttpError(409, 'session s1 send was interrupted') }),
      })
      m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      expect(m.list('s1').map((r) => r.status)).toEqual(['failed'])
    })

    it('remove cancels a deferred record', async () => {
      const { m, setNow } = make({
        send: vi.fn(async () => { throw new HttpError(409, REBUILD_REQUIRED) }),
      })
      const rec = m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      m.remove('s1', rec.id)
      expect(m.list('s1').map((r) => r.status)).toEqual(['cancelled'])
      // A later tick must not resurrect the cancelled record.
      await m.tick()
      expect(m.list('s1').map((r) => r.status)).toEqual(['cancelled'])
    })

    it('deferred records count toward the per-session pending cap', async () => {
      const { m, setNow } = make({
        send: vi.fn(async () => { throw new HttpError(409, REBUILD_REQUIRED) }),
      })
      const t = 2_000_000
      m.create('s1', { text: 'deferred' }, t)
      setNow(t + 1)
      await m.tick() // active → deferred: the slot must stay occupied
      const future = t + 1 + MIN_DELAY_MS
      for (let i = 0; i < MAX_PENDING_PER_SESSION - 1; i++) m.create('s1', { text: `m${i}` }, future + 100 + i)
      expect(() => m.create('s1', { text: 'overflow' }, future + 2000)).toThrow(/too many/)
    })

    it('cancelAll drops deferred records too', async () => {
      const { m, setNow } = make({
        send: vi.fn(async () => { throw new HttpError(409, REBUILD_REQUIRED) }),
      })
      m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      m.cancelAll('s1')
      expect(m.list('s1')).toEqual([])
    })
  })

  describe('rebuild teardown deferral (final review Important #2)', () => {
    // During quiesceAndRebuild's teardown the session is terminated (410) then
    // removed from the map (404); a not-running session refuses 409 — all
    // BEFORE the REBUILD_REQUIRED admission fence is reached. While a rebuild
    // is pending/in flight these are transient refusals, not payload failures.
    it.each([410, 404, 409])('a due send refused %i while a rebuild is pending is deferred (payload retained), then sent', async (status) => {
      let pending = true
      const { m, setNow } = make({
        send: vi.fn(async () => {
          if (pending) throw new HttpError(status, `session s1 transient teardown refusal (${status})`)
          return { uuid: 'sent-uuid' }
        }),
        isRebuildPending: () => pending,
      })
      const rec = m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      expect(m.list('s1').map((r) => r.status)).toEqual(['deferred'])
      expect(m.list('s1')[0]?.body).toEqual({ text: 'hi' }) // payload retained, not lost
      pending = false
      await m.tick()
      const after = m.list('s1')
      expect(after).toHaveLength(1) // not duplicated, not lost
      expect(after[0]).toMatchObject({ id: rec.id, status: 'sent', sentUuid: 'sent-uuid' })
    })

    it('teardown-deferred sends retry in original attempt order', async () => {
      let pending = true
      const calls: string[] = []
      const { m, setNow } = make({
        send: vi.fn(async (_id: string, body: ScheduledSendBody) => {
          calls.push('text' in body ? body.text : '<content>')
          if (pending) throw new HttpError(410, 'session s1 is terminated')
          return { uuid: 'u' }
        }),
        isRebuildPending: () => pending,
      })
      m.create('s1', { text: 'first' }, 2_000_000)
      m.create('s1', { text: 'second' }, 2_000_001)
      setNow(2_000_002)
      await m.tick()
      expect(calls).toEqual(['first', 'second'])
      expect(m.list('s1').map((r) => r.status)).toEqual(['deferred', 'deferred'])
      pending = false
      calls.length = 0
      await m.tick()
      expect(calls).toEqual(['first', 'second'])
      expect(m.list('s1').map((r) => r.status)).toEqual(['sent', 'sent'])
    })

    it.each([400, 413])('a %i permanent payload failure stays terminal even while a rebuild is pending', async (status) => {
      const { m, setNow } = make({
        send: vi.fn(async () => { throw new HttpError(status, 'bad payload') }),
        isRebuildPending: () => true,
      })
      m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      expect(m.list('s1').map((r) => r.status)).toEqual(['failed'])
    })

    it('a non-HttpError failure stays terminal while a rebuild is pending', async () => {
      const { m, setNow } = make({
        send: vi.fn(async () => { throw new Error('boom') }),
        isRebuildPending: () => true,
      })
      m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      expect(m.list('s1').map((r) => r.status)).toEqual(['failed'])
    })

    it('a 410 with NO rebuild pending still fails terminally', async () => {
      const { m, setNow } = make({
        send: vi.fn(async () => { throw new HttpError(410, 'session s1 is terminated') }),
        isRebuildPending: () => false,
      })
      m.create('s1', { text: 'hi' }, 2_000_000)
      setNow(2_000_001)
      await m.tick()
      expect(m.list('s1').map((r) => r.status)).toEqual(['failed'])
    })
  })
})
