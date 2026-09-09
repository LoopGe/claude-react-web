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
})
