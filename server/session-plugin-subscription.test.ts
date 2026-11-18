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

  it('Task 8: a capable plugin receives a typed transcript-rebased envelope', () => {
    const notify = vi.fn()
    const session = fakeSession(null)
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    expect(r.subscribe('s1', fakePeer(notify), { orderedRebase: true }).ok).toBe(true)
    const sub = session.pluginSubscribers.values().next().value as any
    sub.push({ kind: 'transcript-rebased', sessionId: 's1', reason: 'ordered-rebuild', generation: 5, headSeq: 10, rebaseEpoch: 1, clearEpoch: 0 })
    expect(notify).toHaveBeenCalledWith('sessions.event', expect.objectContaining({
      kind: 'transcript-rebased', sessionId: 's1', generation: 5, headSeq: 10, rebaseEpoch: 1,
    }))
    // subscription stays active (capable plugins keep receiving frames)
    expect(session.pluginSubscribers.size).toBe(1)
  })

  it('Task 8: an incapable plugin gets reset-required and is released (must re-subscribe)', () => {
    const notify = vi.fn()
    const session = fakeSession(null)
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    expect(r.subscribe('s1', fakePeer(notify)).ok).toBe(true)
    const sub = session.pluginSubscribers.values().next().value as any
    sub.push({ kind: 'transcript-rebased', sessionId: 's1', reason: 'ordered-rebuild', generation: 5, headSeq: 10 })
    expect(notify).toHaveBeenCalledWith('sessions.event', expect.objectContaining({ kind: 'reset-required', sessionId: 's1' }))
    expect(session.pluginSubscribers.size).toBe(0)
  })

  it('Task 8: a capable plugin still receives ordinary messages', () => {
    const notify = vi.fn()
    const session = fakeSession(null)
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    r.subscribe('s1', fakePeer(notify), { orderedRebase: true })
    const sub = session.pluginSubscribers.values().next().value as any
    sub.push({ type: 'assistant', uuid: 'a' })
    expect(notify).toHaveBeenCalledWith('sessions.event', expect.objectContaining({ kind: 'message' }))
  })


  it('Task 8 I2: idempotent re-subscribe honors a capability upgrade', () => {
    const notify = vi.fn()
    const session = fakeSession(null)
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    const peer = fakePeer(notify)
    r.subscribe('s1', peer) // incapable first
    r.subscribe('s1', peer, { orderedRebase: true }) // upgrade while subscribed
    const sub = session.pluginSubscribers.values().next().value as any
    sub.push({ kind: 'transcript-rebased', sessionId: 's1', reason: 'ordered-rebuild', generation: 5, headSeq: 10 })
    expect(notify).toHaveBeenCalledWith('sessions.event', expect.objectContaining({ kind: 'transcript-rebased' }))
    expect(session.pluginSubscribers.size).toBe(1) // not released
  })

  it('Task 8 M4: mixed-capability registries each get exactly one correct frame; releasing incapable leaves capable', () => {
    const session = fakeSession(null)
    const capableNotify = vi.fn()
    const incapableNotify = vi.fn()
    const rCap = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    const rInc = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    rCap.subscribe('s1', fakePeer(capableNotify), { orderedRebase: true })
    rInc.subscribe('s1', fakePeer(incapableNotify))
    for (const sub of session.pluginSubscribers.values()) {
      ;(sub as any).push({ kind: 'transcript-rebased', sessionId: 's1', reason: 'ordered-rebuild', generation: 5, headSeq: 10 })
    }
    expect(capableNotify).toHaveBeenCalledTimes(1)
    expect(capableNotify).toHaveBeenCalledWith('sessions.event', expect.objectContaining({ kind: 'transcript-rebased' }))
    expect(incapableNotify).toHaveBeenCalledTimes(1)
    expect(incapableNotify).toHaveBeenCalledWith('sessions.event', expect.objectContaining({ kind: 'reset-required' }))
    expect(session.pluginSubscribers.size).toBe(1) // incapable released, capable remains
  })

  it('Task 8 M4: an incapable plugin can re-subscribe with capability after reset-required', () => {
    const notify = vi.fn()
    const session = fakeSession(null)
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    const peer = fakePeer(notify)
    r.subscribe('s1', peer)
    let sub = session.pluginSubscribers.values().next().value as any
    sub.push({ kind: 'transcript-rebased', sessionId: 's1', reason: 'ordered-rebuild', generation: 5, headSeq: 10 })
    expect(session.pluginSubscribers.size).toBe(0) // released
    // Re-subscribe with the capability, then a new rebuild reaches it typed.
    r.subscribe('s1', peer, { orderedRebase: true })
    sub = session.pluginSubscribers.values().next().value as any
    sub.push({ kind: 'transcript-rebased', sessionId: 's1', reason: 'ordered-rebuild', generation: 6, headSeq: 12 })
    expect(notify).toHaveBeenLastCalledWith('sessions.event', expect.objectContaining({ kind: 'transcript-rebased', generation: 6 }))
  })

})
