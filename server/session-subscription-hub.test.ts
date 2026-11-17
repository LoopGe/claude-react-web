import { describe, it, expect } from 'vitest'
import { SessionSubscriptionHub, type HubConnection } from './session-subscription-hub.js'

function conn(id: string): HubConnection & { frames: unknown[] } {
  const frames: unknown[] = []
  return { id, frames, push: (f) => frames.push(f) }
}

describe('SessionSubscriptionHub (spec §8.1)', () => {
  it('subscribers survive a Session rebind and still receive frames', () => {
    const hub = new SessionSubscriptionHub()
    const c = conn('c1')
    hub.attach('s1', c)
    hub.rebind('s1', { pump: 'old' })
    hub.publish('s1', { kind: 'message', seq: 0 })
    hub.rebind('s1', { pump: 'new' }) // Session replacement
    hub.publish('s1', { kind: 'message', seq: 1 })
    expect(c.frames).toEqual([{ kind: 'message', seq: 0 }, { kind: 'message', seq: 1 }])
  })

  it('teardown detaches the binding WITHOUT closing subscriber queues', () => {
    const hub = new SessionSubscriptionHub()
    const c = conn('c1')
    hub.attach('s1', c)
    hub.rebind('s1', { pump: 'old' })
    hub.detachBinding('s1') // provider teardown
    expect(hub.subscriberCount('s1')).toBe(1)
    hub.rebind('s1', { pump: 'new' })
    hub.publish('s1', { kind: 'message', seq: 2 })
    expect(c.frames).toEqual([{ kind: 'message', seq: 2 }])
  })

  it('detach removes a connection; publish skips closed connections', () => {
    const hub = new SessionSubscriptionHub()
    const a = conn('a')
    const b = conn('b')
    hub.attach('s1', a)
    hub.attach('s1', b)
    hub.detach('s1', 'a')
    hub.publish('s1', { kind: 'x' })
    expect(a.frames).toEqual([])
    expect(b.frames).toEqual([{ kind: 'x' }])
    b.closed = true
    hub.publish('s1', { kind: 'y' })
    expect(b.frames).toEqual([{ kind: 'x' }])
  })

  it('publish to an unknown session is a no-op', () => {
    const hub = new SessionSubscriptionHub()
    expect(() => hub.publish('nope', { kind: 'x' })).not.toThrow()
    expect(hub.subscriberCount('nope')).toBe(0)
  })
})

describe('SessionSubscriptionHub capability gate (spec §8.3)', () => {
  it('no subscribers → rebuildable', () => {
    expect(new SessionSubscriptionHub().allSubscribersCapable('s1')).toBe(true)
  })
  it('an incapable (legacy/unknown) subscriber blocks rebuild', () => {
    const hub = new SessionSubscriptionHub()
    hub.attach('s1', { id: 'old', push: () => {} }) // orderedRebase undefined
    expect(hub.allSubscribersCapable('s1')).toBe(false)
  })
  it('all capable subscribers → rebuildable', () => {
    const hub = new SessionSubscriptionHub()
    hub.attach('s1', { id: 'a', push: () => {}, orderedRebase: true })
    hub.attach('s1', { id: 'b', push: () => {}, orderedRebase: true })
    expect(hub.allSubscribersCapable('s1')).toBe(true)
  })
  it('a mixed set blocks rebuild; a closed incapable subscriber is ignored', () => {
    const hub = new SessionSubscriptionHub()
    hub.attach('s1', { id: 'a', push: () => {}, orderedRebase: true })
    const old: HubConnection = { id: 'old', push: () => {}, orderedRebase: false }
    hub.attach('s1', old)
    expect(hub.allSubscribersCapable('s1')).toBe(false)
    old.closed = true
    expect(hub.allSubscribersCapable('s1')).toBe(true)
  })
})
