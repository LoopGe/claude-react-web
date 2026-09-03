import { describe, it, expect, vi } from 'vitest'
import { SessionSubscriptionRegistry } from './session-plugin-subscription.js'

function fakePeer(notify = vi.fn()) {
  return { notify, closed: false, id: 'p1' } as any
}

function fakeSession(set: { push: (m: any) => void; end: () => void } | null) {
  return {
    id: 's1',
    pluginSubscribers: set ? new Map([['peerKey', { id: 'peerKey', ...set }]]) : new Map(),
  } as any
}

describe('SessionSubscriptionRegistry', () => {
  it('rejects unknown sessions', () => {
    const r = new SessionSubscriptionRegistry({ getSession: () => undefined })
    expect(r.subscribe('nope', fakePeer())).toMatchObject({ ok: false })
  })

  it('registers a plugin subscriber and notifies it via peer.notify', () => {
    const notify = vi.fn()
    const session = fakeSession(null)
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    const res = r.subscribe('s1', fakePeer(notify))
    expect(res.ok).toBe(true)
    // subscribe attaches a Subscriber into session.pluginSubscribers; push it manually
    const sub = session.pluginSubscribers.values().next().value
    sub.push({ type: 'assistant' })
    expect(notify).toHaveBeenCalledTimes(1)
    const [method, params] = notify.mock.calls[0]
    expect(method).toBe('sessions.event')
    expect(params.kind).toBe('message')
    expect(params.message.type).toBe('assistant')
  })

  it('dropPeer removes the peer’s subscriptions and ends their subscribers', () => {
    const session = fakeSession(null)
    const peer = fakePeer()
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    const res = r.subscribe('s1', peer)
    expect(res.ok).toBe(true)
    expect(session.pluginSubscribers.size).toBe(1)
    const sub = session.pluginSubscribers.values().next().value as any
    const endSpy = vi.spyOn(sub, 'end')
    r.dropPeer(peer)
    expect(session.pluginSubscribers.size).toBe(0)
    expect(endSpy).toHaveBeenCalled()
  })

  it('unsubscribe releases only the targeted peer+session subscription', () => {
    const session = fakeSession(null)
    const peer = fakePeer()
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    expect(r.subscribe('s1', peer).ok).toBe(true)
    expect(session.pluginSubscribers.size).toBe(1)

    r.unsubscribe(peer, 's1')
    expect(session.pluginSubscribers.size).toBe(0)

    // Idempotent: releasing an absent subscription must not throw.
    r.unsubscribe(peer, 's1')
    // dropPeer over an already-released registry must be safe too.
    expect(() => r.dropPeer(peer)).not.toThrow()
  })

  it('allows two plugin processes to subscribe to the same session without shadowing', () => {
    // One registry is created per plugin process, but they all share the same
    // session.pluginSubscribers map. Each must get its own keyed subscriber,
    // or the second subscriber is silently shadowed (its push never fires).
    const session = fakeSession(null)
    const peerA = fakePeer()
    const peerB = fakePeer()
    const rA = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    const rB = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    expect(rA.subscribe('s1', peerA).ok).toBe(true)
    expect(rA.subscribe('s1', fakePeer()).ok).toBe(true) // idempotent within A
    expect(rB.subscribe('s1', peerB).ok).toBe(true)
    expect(session.pluginSubscribers.size).toBe(2)

    // The pump iterates every map value and pushes a frame into each, and
    // each subscriber's push must reach ITS OWN peer — both get deliveries.
    for (const sub of session.pluginSubscribers.values()) {
      ;(sub as any).push({ type: 'assistant' })
    }
    expect(peerA.notify).toHaveBeenCalledWith('sessions.event', expect.objectContaining({ kind: 'message' }))
    expect(peerB.notify).toHaveBeenCalledWith('sessions.event', expect.objectContaining({ kind: 'message' }))

    // Releasing B's subscription must not disturb A's.
    rB.dropPeer(peerB)
    expect(session.pluginSubscribers.size).toBe(1)
  })
})
