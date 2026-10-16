// SessionStore tests for the seq-window store (transcript-seq refactor,
// Task 7). The client persistence layers (localStorage transcript cache +
// IndexedDB) are deleted; what remains to test here is the store shell:
// snapshot publication, the WINDOW_* path end-to-end (window + ordered
// log + derived snapshot fields), the wipe flows, and the ready-state
// constants the subscribe gate still reads.
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'
import type { SdkMessage } from '../types'

function userMsg(uuid: string, text: string): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as SdkMessage
}

function asstMsg(uuid: string, text: string): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as SdkMessage
}

const pageMsgs = (seqs: number[], make: (u: string) => SdkMessage) =>
  seqs.map((s) => ({ seq: s, msg: make(`u${s}`) }))

describe('SessionStore construction (no persistence)', () => {
  it('starts synchronously ready with an empty transcript', () => {
    const store = new SessionStore('s-ready')
    const snap = store.getSnapshot()
    expect(snap.idbReady).toBe(true)
    expect(snap.hydrateReady).toBe(true)
    expect(snap.replayReady).toBe(false)
    expect(snap.items).toEqual([])
    expect(snap.messages).toEqual([])
    expect(snap.oldestSeq).toBeNull()
    expect(snap.newestSeq).toBeNull()
    expect(snap.hasOlder).toBe(false)
    expect(snap.generation).toBe(-1) // no server generation adopted yet
    expect(snap.hole).toBeNull()
  })

  it('no longer touches localStorage transcript keys', () => {
    localStorage.setItem('claude-web-session:s-ls', 'stale')
    const store = new SessionStore('s-ls')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 1, messages: pageMsgs([0], (u) => userMsg(u, 'hi')), hasMore: false })
    expect(localStorage.getItem('claude-web-session:s-ls')).toBe('stale') // never rewritten
    localStorage.removeItem('claude-web-session:s-ls')
  })
})

describe('SessionStore: WINDOW_PAGE (tail) opens the transcript', () => {
  it('adopts the page generation, applies messages in order, flips replayReady', () => {
    const store = new SessionStore('s-tail')
    store.dispatch({
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 5,
      messages: pageMsgs([2, 3, 4], (u) => (u === 'u3' ? asstMsg(u, 'hello') : userMsg(u, 'hi'))),
      hasMore: true,
    })
    const snap = store.getSnapshot()
    expect(snap.replayReady).toBe(true)
    expect(snap.oldestSeq).toBe(2)
    expect(snap.newestSeq).toBe(4)
    expect(snap.generation).toBe(0)
    expect(snap.headSeq).toBe(5)
    expect(snap.hasOlder).toBe(true)
    expect(snap.messages.map((m) => m.uuid)).toEqual(['u2', 'u3', 'u4'])
    expect(snap.items.map((it) => it.id)).toEqual(['u2', 'u3', 'u4'])
  })

  it('ignores a stale-generation page on a non-empty window', () => {
    const store = new SessionStore('s-stale')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 1, messages: pageMsgs([0], (u) => userMsg(u, 'a')), hasMore: false })
    const before = store.getSnapshot()
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 7, headSeq: 2, messages: pageMsgs([1], (u) => userMsg(u, 'b')), hasMore: false })
    expect(store.getSnapshot().messages.length).toBe(before.messages.length)
    expect(store.getSnapshot().generation).toBe(0)
  })
})

describe('SessionStore: WINDOW_LIVE live appends + hole buffer', () => {
  it('appends a contiguous live frame and exposes snapshot boundaries', () => {
    const store = new SessionStore('s-live')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 2, messages: pageMsgs([0, 1], (u) => userMsg(u, 'hi')), hasMore: false })
    store.dispatch({ type: 'WINDOW_LIVE', seq: 2, generation: 0, message: asstMsg('a-live', 'reply') })
    const snap = store.getSnapshot()
    expect(snap.newestSeq).toBe(2)
    expect(snap.messages.at(-1)?.uuid).toBe('a-live')
    expect(snap.hole).toBeNull()
  })

  it('parks a gapped live frame (snapshot hole) and fills it from a page', () => {
    const store = new SessionStore('s-hole')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 3, messages: pageMsgs([0, 1], (u) => userMsg(u, 'hi')), hasMore: false })
    store.dispatch({ type: 'WINDOW_LIVE', seq: 4, generation: 0, message: asstMsg('a-far', 'later') })
    let snap = store.getSnapshot()
    // Parked: not applied to the ordered log, hole exposed for the hook.
    expect(snap.messages.some((m) => m.uuid === 'a-far')).toBe(false)
    expect(snap.hole).toEqual([2, 3])
    expect(snap.hasNewer).toBe(true)
    // The hole-filling page drains the parked frame in seq order.
    store.dispatch({
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 5,
      messages: pageMsgs([2, 3], (u) => userMsg(u, 'fill')),
      hasMore: false,
    })
    snap = store.getSnapshot()
    expect(snap.hole).toBeNull()
    expect(snap.newestSeq).toBe(4)
    expect(snap.messages.map((m) => m.uuid)).toEqual(['u0', 'u1', 'u2', 'u3', 'a-far'])
  })

  it('drains parked frames when live appends fill the gap themselves', () => {
    const store = new SessionStore('s-drain')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 1, messages: pageMsgs([0], (u) => userMsg(u, 'hi')), hasMore: false })
    store.dispatch({ type: 'WINDOW_LIVE', seq: 2, generation: 0, message: asstMsg('a2', 'two') })
    store.dispatch({ type: 'WINDOW_LIVE', seq: 1, generation: 0, message: asstMsg('a1', 'one') })
    const snap = store.getSnapshot()
    expect(snap.hole).toBeNull()
    expect(snap.messages.map((m) => m.uuid)).toEqual(['u0', 'a1', 'a2'])
  })

  it('drops an old duplicate live frame idempotently', () => {
    const store = new SessionStore('s-dup')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 1, messages: pageMsgs([0], (u) => userMsg(u, 'hi')), hasMore: false })
    const before = store.getSnapshot()
    store.dispatch({ type: 'WINDOW_LIVE', seq: 0, generation: 0, message: userMsg('u0', 'hi') })
    expect(store.getSnapshot()).toBe(before)
  })
})

describe('SessionStore: eviction + generation reset', () => {
  it('WINDOW_EVICT removes the seqs from log and window', () => {
    const store = new SessionStore('s-evict')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 3, messages: pageMsgs([0, 1, 2], (u) => userMsg(u, 'hi')), hasMore: false })
    store.dispatch({ type: 'WINDOW_EVICT', seqs: [0, 2] })
    const snap = store.getSnapshot()
    expect(snap.messages.map((m) => m.uuid)).toEqual(['u1'])
    expect(snap.oldestSeq).toBe(1)
    expect(snap.newestSeq).toBe(1)
  })

  it('WINDOW_BUMP resets the transcript with the new generation', () => {
    const store = new SessionStore('s-bump')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 2, messages: pageMsgs([0, 1], (u) => userMsg(u, 'hi')), hasMore: true })
    store.dispatch({ type: 'WINDOW_BUMP', generation: 1, headSeq: 0 })
    const snap = store.getSnapshot()
    expect(snap.replayReady).toBe(true)
    expect(snap.messages).toEqual([])
    expect(snap.items).toEqual([])
    expect(snap.oldestSeq).toBeNull()
    expect(snap.generation).toBe(1)
    expect(snap.headSeq).toBe(0)
    expect(snap.hasOlder).toBe(false)
  })

  it('CLEAR_TRANSCRIPT empties the window but preserves the generation cursor', () => {
    const store = new SessionStore('s-clear')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 2, messages: pageMsgs([0, 1], (u) => userMsg(u, 'hi')), hasMore: true })
    store.dispatch({ type: 'CLEAR_TRANSCRIPT' })
    const snap = store.getSnapshot()
    expect(snap.replayReady).toBe(true)
    expect(snap.messages).toEqual([])
    expect(snap.oldestSeq).toBeNull()
    expect(snap.generation).toBe(0) // unchanged until WINDOW_BUMP arrives
    expect(snap.headSeq).toBe(2)
    expect(snap.hasOlder).toBe(false)
  })

  it('clearPersisted wipes the in-memory transcript', () => {
    const store = new SessionStore('s-purge')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 1, messages: pageMsgs([0], (u) => userMsg(u, 'hi')), hasMore: false })
    store.clearPersisted()
    const snap = store.getSnapshot()
    expect(snap.messages).toEqual([])
    expect(snap.replayReady).toBe(true)
  })
})

describe('SessionStore: head pages (scroll-up prepend)', () => {
  it('prepends an older page below oldestSeq and updates hasOlder', () => {
    const store = new SessionStore('s-head')
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', generation: 0, headSeq: 12, messages: pageMsgs([10, 11], (u) => userMsg(u, 'hi')), hasMore: true })
    store.dispatch({ type: 'WINDOW_PAGE', at: 'head', generation: 0, headSeq: 12, messages: pageMsgs([8, 9], (u) => asstMsg(u, 'old')), hasMore: true })
    const snap = store.getSnapshot()
    expect(snap.oldestSeq).toBe(8)
    expect(snap.newestSeq).toBe(11)
    expect(snap.messages.map((m) => m.uuid)).toEqual(['u8', 'u9', 'u10', 'u11'])
    expect(snap.items.map((it) => it.id)).toEqual(['u8', 'u9', 'u10', 'u11'])
    expect(snap.hasOlder).toBe(true)
  })
})
