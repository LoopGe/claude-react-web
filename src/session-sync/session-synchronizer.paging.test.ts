// Environment: repo default happy-dom (the real SessionStore uses
// window.clearTimeout in destroy()/purge(), so the registry clear between
// tests needs a DOM).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Framework-free synchronizer paging tests (Task 2). Uses a fake hub/REST
// plus a real SessionStore, exactly like the sibling seq-window tests but
// without renderHook — the synchronizer has no React dependency.

import { sessionStoreRegistry } from '../session-store/registry'
import { getSessionStore } from '../session-store/selectors'
import type { WsServerFrame } from '../ws-types'
import { SessionSynchronizer } from './session-synchronizer'
import type { SessionSyncHandlers, SessionSyncHub } from './session-synchronizer'

// ── Fake hub ───────────────────────────────────────────────────────

type WsHubListener = (frame: WsServerFrame) => void

let currentSessionListeners: Map<string, Set<WsHubListener>>
const mockSubscribe = vi.fn(
  (_sessionId: string, _opts?: { force?: boolean }) => vi.fn(),
)

const fakeHub: SessionSyncHub = {
  addSessionListener: (sessionId: string, fn: WsHubListener) => {
    let set = currentSessionListeners.get(sessionId)
    if (!set) {
      set = new Set()
      currentSessionListeners.set(sessionId, set)
    }
    set.add(fn)
    return () => { set!.delete(fn) }
  },
  subscribe: mockSubscribe,
}

// ── Fake REST ─────────────────────────────────────────────────────

interface FakeTranscript {
  generation: number
  headSeq: number
  msgs: Array<{ seq: number; msg: unknown }>
  evicted: Set<number>
}

const transcripts = new Map<string, FakeTranscript>()

function transcript(sid: string): FakeTranscript {
  let t = transcripts.get(sid)
  if (!t) {
    t = { generation: 0, headSeq: 0, msgs: [], evicted: new Set<number>() }
    transcripts.set(sid, t)
  }
  return t
}

function fakeMsg(sid: string, seq: number) {
  return {
    type: 'assistant',
    uuid: `${sid}-m${seq}`,
    message: { role: 'assistant', content: [{ type: 'text', text: `m${seq}` }] },
  }
}

/** GET /sessions/:id/messages semantics, faithfully: `before` is an
 *  exclusive upper bound, the page is the newest `limit` eligible messages
 *  (tombstoned rows filtered out), hasMore reports older eligible content
 *  past the page. */
function pageFor(sid: string, before: number | undefined, limit: number) {
  const t = transcript(sid)
  const eligible = t.msgs.filter(
    (m) => (before === undefined || m.seq < before) && !t.evicted.has(m.seq),
  )
  const page = eligible.slice(-limit)
  const bound = before ?? t.headSeq
  const spanStart = page.length > 0 ? page[0].seq : (before ?? t.headSeq)
  const tombstones = [...t.evicted].filter((s) => s >= spanStart && s < bound).sort((a, b) => a - b)
  return {
    generation: t.generation,
    headSeq: t.headSeq,
    totalCount: eligible.length,
    startIndex: page.length > 0 ? page[0].seq : (before ?? t.headSeq),
    hasMore: eligible.length > page.length,
    messages: page,
    tombstones,
  }
}

/** Deferred in-flight fetches: the FIRST matching request is held un-handled
 *  (a promise the test resolves later) — how the race tests park a fetch
 *  mid-flight. */
interface DeferredFetch {
  pattern: RegExp
  promise: Promise<unknown>
  resolve: (page: unknown) => void
}
let deferredFetches: DeferredFetch[] = []

interface DeferredHandle {
  promise: Promise<unknown>
  resolve: (page: unknown) => void
}
function queueDeferredFetch(pattern: RegExp): DeferredHandle {
  let resolve!: (page: unknown) => void
  const promise = new Promise<unknown>((r) => { resolve = r })
  deferredFetches.push({ pattern, promise, resolve })
  return { promise, resolve }
}

const mockApiGet = vi.fn(async (url: string) => {
  const m = /\/sessions\/([^/]+)\/messages\?(?:before=(\d+)&)?limit=(\d+)/.exec(url)
  if (!m) throw new Error(`unexpected api.get url: ${url}`)
  const sid = m[1]
  const before = m[2] !== undefined ? Number(m[2]) : undefined
  const limit = Number(m[3])
  const di = deferredFetches.findIndex((d) => d.pattern.test(url))
  if (di >= 0) {
    const [d] = deferredFetches.splice(di, 1)
    // Return the deferred promise — it stays pending until the test calls
    // d.resolve(page). This parks the fetch mid-flight.
    return d.promise
  }
  return pageFor(sid, before, limit)
})

const fakeGet = mockApiGet as unknown as <T>(path: string) => Promise<T>

// ── Helpers ────────────────────────────────────────────────────────

const noopHandlers: SessionSyncHandlers = {
  onRequest: vi.fn(),
  onResolved: vi.fn(),
}

/** All `?limit=200`-only (no `before`) fetches — the tail-page requests. */
function tailFetchUrls(): string[] {
  return mockApiGet.mock.calls.map((c) => c[0] as string).filter((u) => !u.includes('before='))
}

/** All fetches with a `before` cursor (gap-fill + loadOlder). */
function beforeFetchUrls(): string[] {
  return mockApiGet.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('before='))
}

async function waitForTail(sid: string): Promise<void> {
  const store = getSessionStore(sid)
  for (let i = 0; i < 200; i++) {
    if (store.getSnapshot().replayReady) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`tail page never landed for ${sid}`)
}

// ── Tests ──────────────────────────────────────────────────────────

describe('SessionSynchronizer paging core', () => {
  beforeEach(() => {
    currentSessionListeners = new Map()
    transcripts.clear()
    deferredFetches = []
    mockSubscribe.mockClear()
    mockApiGet.mockClear()
    void sessionStoreRegistry.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Step 1a: open path ──────────────────────────────────────────

  it('start subscribes with {force:true}, fetches the tail page, and dispatches it', async () => {
    const sid = 's1'
    const t = transcript(sid)
    for (let i = 0; i < 5; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 5

    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    // force subscribe was sent.
    expect(mockSubscribe).toHaveBeenCalledWith(sid, { force: true })

    // tail page fetched.
    await waitForTail(sid)
    expect(tailFetchUrls()).toEqual([`/sessions/${sid}/messages?limit=200`])

    // The page was dispatched into the store.
    const store = getSessionStore(sid)
    expect(store.getSnapshot().replayReady).toBe(true)
    expect(store.getSnapshot().messages).toHaveLength(5)
    expect(store.getSnapshot().oldestSeq).toBe(0)
    expect(store.getSnapshot().hasOlder).toBe(false)
  })

  // ── Step 1b: loadOlder gates ───────────────────────────────────

  it('loadOlder returns 0 without hasOlder/oldestSeq and does not fetch', async () => {
    const sid = 'empty'
    // Empty transcript — tail page comes back empty, oldestSeq is null.
    transcript(sid)

    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    await waitForTail(sid)
    expect(getSessionStore(sid).getSnapshot().oldestSeq).toBeNull()

    mockApiGet.mockClear()
    const prepended = await sync.loadOlder()
    expect(prepended).toBe(0)
    expect(mockApiGet).not.toHaveBeenCalled()
  })

  it('loadOlder allows only one in-flight request', async () => {
    const sid = 'inflight'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    await waitForTail(sid)
    expect(getSessionStore(sid).getSnapshot().oldestSeq).toBe(50)

    // Park the first loadOlder fetch mid-flight.
    const first = queueDeferredFetch(/before=50&limit=200/)
    let firstResult: number | null = null
    sync.loadOlder().then((n) => { firstResult = n })

    // A second call while the first is still in-flight returns 0 immediately
    // and does NOT issue a second fetch.
    let secondResult: number | null = null
    const second = await sync.loadOlder().then((n) => { secondResult = n; return n })
    expect(second).toBe(0)
    expect(secondResult).toBe(0)
    expect(beforeFetchUrls()).toHaveLength(1) // only one fetch

    // Resolve the first fetch.
    first.resolve(pageFor(sid, 50, 200))
    await first.promise
    for (let i = 0; i < 200 && firstResult == null; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(firstResult).toBe(50)
  })

  it('loadOlder dispatches a head page and returns its message count', async () => {
    const sid = 'head-page'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    await waitForTail(sid)
    expect(getSessionStore(sid).getSnapshot().messages).toHaveLength(200)

    const prepended = await sync.loadOlder()
    expect(prepended).toBe(50)
    expect(beforeFetchUrls()).toEqual([`/sessions/${sid}/messages?before=50&limit=200`])
    const store = getSessionStore(sid)
    expect(store.getSnapshot().messages).toHaveLength(250)
    expect(store.getSnapshot().oldestSeq).toBe(0)
    expect(store.getSnapshot().hasOlder).toBe(false)
  })

  it('loadOlder exposes retryable olderError on fetch failure', async () => {
    const sid = 'retry'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    await waitForTail(sid)

    // First attempt: the before= fetch throws.
    mockApiGet.mockImplementation(async (url: string) => {
      if (url.includes('before=')) throw new Error('network down')
      return pageFor(sid, undefined, 200)
    })
    let result = await sync.loadOlder()
    expect(result).toBe(0)
    expect(sync.getPagingSnapshot().olderError).toBe("Couldn't load earlier messages")

    // Second attempt: the before= fetch succeeds — olderError clears.
    mockApiGet.mockImplementation(async (url: string) => {
      if (url.includes('before=')) return pageFor(sid, 50, 200)
      return pageFor(sid, undefined, 200)
    })
    result = await sync.loadOlder()
    expect(result).toBe(50)
    expect(sync.getPagingSnapshot().olderError).toBeNull()
    expect(sync.getPagingSnapshot().loadingOlder).toBe(false)
  })

  // ── Step 1c: paging notification semantics ─────────────────────

  it('paging listeners fire only when loadingOlder/olderError changes', async () => {
    const sid = 'notify'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    await waitForTail(sid)

    let calls = 0
    let lastSnapshot = sync.getPagingSnapshot()
    const unsub = sync.subscribePaging(() => {
      calls++
      lastSnapshot = sync.getPagingSnapshot()
    })

    // A no-op loadOlder (while a real one is already in flight) returns 0
    // and does NOT fire the listener — but we need a real in-flight one
    // first. Park the first fetch.
    const deferred = queueDeferredFetch(/before=50&limit=200/)
    sync.loadOlder()
    // loadingOlder flipped false→true: one notification.
    for (let i = 0; i < 200 && calls === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(calls).toBe(1)
    expect(lastSnapshot.loadingOlder).toBe(true)

    // A second call while the first is in-flight returns 0 and fires nothing.
    const second = await sync.loadOlder()
    expect(second).toBe(0)
    expect(calls).toBe(1) // unchanged

    // Resolve the fetch: loadingOlder flips true→false (one notification).
    deferred.resolve(pageFor(sid, 50, 200))
    await deferred.promise
    for (let i = 0; i < 200 && calls === 1; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(calls).toBe(2)
    expect(lastSnapshot.loadingOlder).toBe(false)
    expect(lastSnapshot.olderError).toBeNull()

    // Calling loadOlder again with hasOlder=false (nothing older left)
    // returns 0 without firing the listener.
    mockApiGet.mockClear()
    const third = await sync.loadOlder()
    expect(third).toBe(0)
    expect(calls).toBe(2) // unchanged

    unsub()
  })

  // ── Step 1d: restart-during-deferred-loadOlder race ─────────────

  it('a deferred loadOlder invalidated by stop/start returns 0, does not dispatch, and cannot clear the new run loadingOlder:true', async () => {
    const sid = 'race'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    await waitForTail(sid)
    expect(getSessionStore(sid).getSnapshot().oldestSeq).toBe(50)

    // Park run A's loadOlder fetch mid-flight.
    const runAFetch = queueDeferredFetch(/before=50&limit=200/)
    let runAResult: number | null = null
    sync.loadOlder().then((n) => { runAResult = n })
    // loadingOlder is now true (run A).
    for (let i = 0; i < 200; i++) {
      if (sync.getPagingSnapshot().loadingOlder) break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(sync.getPagingSnapshot().loadingOlder).toBe(true)

    // stop() invalidates run A.
    sync.stop()
    // start() creates run B and resets paging to {false, null}.
    sync.start()
    await waitForTail(sid)
    expect(sync.getPagingSnapshot()).toEqual({ loadingOlder: false, olderError: null })

    // Run B starts its own loadOlder — park it too. This sets
    // loadingOlder:true on run B.
    const runBFetch = queueDeferredFetch(/before=50&limit=200/)
    let runBResult: number | null = null
    sync.loadOlder().then((n) => { runBResult = n })
    for (let i = 0; i < 200; i++) {
      if (sync.getPagingSnapshot().loadingOlder) break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(sync.getPagingSnapshot().loadingOlder).toBe(true)

    // NOW run A's deferred fetch resolves with a page. Run A's loadOlder
    // must return 0, NOT dispatch the page, and NOT clear run B's
    // loadingOlder:true.
    runAFetch.resolve(pageFor(sid, 50, 200))
    await runAFetch.promise
    for (let i = 0; i < 200 && runAResult == null; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(runAResult).toBe(0)
    // Run B's loadingOlder is STILL true — run A did not touch it.
    expect(sync.getPagingSnapshot().loadingOlder).toBe(true)
    // The store did not receive run A's head page (still only the tail 200).
    expect(getSessionStore(sid).getSnapshot().messages).toHaveLength(200)

    // Run B's fetch resolves normally — run B succeeds.
    runBFetch.resolve(pageFor(sid, 50, 200))
    await runBFetch.promise
    for (let i = 0; i < 200 && runBResult == null; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(runBResult).toBe(50)
    expect(getSessionStore(sid).getSnapshot().messages).toHaveLength(250)
    expect(sync.getPagingSnapshot().loadingOlder).toBe(false)
  })

  // ── Step 1e: start resets paging, stop is silent ────────────────

  it('start resets paging to {loadingOlder:false, olderError:null} and stop produces no late paging notification', async () => {
    const sid = 'reset'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    await waitForTail(sid)

    // Make a loadOlder fail so olderError is set.
    mockApiGet.mockImplementation(async (url: string) => {
      if (url.includes('before=')) throw new Error('network down')
      return pageFor(sid, undefined, 200)
    })
    await sync.loadOlder()
    expect(sync.getPagingSnapshot().olderError).toBe("Couldn't load earlier messages")

    // stop() — no paging notification fires from a late resolution.
    let calls = 0
    const unsub = sync.subscribePaging(() => { calls++ })
    sync.stop()
    // The stop itself does not fire a paging notification.
    expect(calls).toBe(0)

    // start() resets paging to {false, null} — the olderError clear fires
    // one notification (olderError changed).
    sync.start()
    await waitForTail(sid)
    expect(calls).toBe(1)
    expect(sync.getPagingSnapshot()).toEqual({ loadingOlder: false, olderError: null })

    unsub()
  })

  it('stop produces no late paging notification from a deferred loadOlder', async () => {
    const sid = 'late-stop'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    await waitForTail(sid)

    // Park a loadOlder fetch.
    const deferred = queueDeferredFetch(/before=50&limit=200/)
    sync.loadOlder()
    for (let i = 0; i < 200; i++) {
      if (sync.getPagingSnapshot().loadingOlder) break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(sync.getPagingSnapshot().loadingOlder).toBe(true)

    // Subscribe to paging and stop.
    let calls = 0
    const unsub = sync.subscribePaging(() => { calls++ })
    sync.stop()

    // Now resolve the deferred fetch — the late resolution must NOT fire.
    deferred.resolve(pageFor(sid, 50, 200))
    await deferred.promise
    // Give it a tick to settle.
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(0)

    unsub()
  })
})
