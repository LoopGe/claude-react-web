// Environment: repo default happy-dom (matches the sibling hook tests —
// the real SessionStore uses window.clearTimeout in destroy()/purge()).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Framework-free synchronizer seq-window protocol tests (Task 3). Ported
// from useChatStream.seq.test.ts: direct `new SessionSynchronizer` +
// start/stop replaces renderHook. The fake hub/REST mirror the useChatStream
// fixtures faithfully: `before` is an exclusive upper bound, the page is the
// newest `limit` eligible messages (tombstoned rows filtered), hasMore
// reports older eligible content past the page.
//
// Deferred in-flight fetches park via `return d.promise` (the paging-test
// pattern) so a mid-flight fetch genuinely stays pending until the test
// resolves it — the race tests exercise the epoch/floor invalidation
// instead of crashing on an undefined page.

import { sessionStoreRegistry } from '../session-store/registry'
import { getSessionStore } from '../session-store/selectors'
import type { WsServerFrame } from '../ws-types'
import { SessionSynchronizer } from './session-synchronizer'
import type { SessionSyncHandlers, SessionSyncHub } from './session-synchronizer'

// ── Fake hub ───────────────────────────────────────────────────────

type WsHubListener = (frame: WsServerFrame) => void

let currentSessionListeners: Map<string, Set<WsHubListener>>

const mockSubscribe = vi.fn(() => vi.fn())

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
  return { type: 'assistant', uuid: `${sid}-m${seq}`, message: { role: 'assistant', content: [{ type: 'text', text: `m${seq}` }] } }
}

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

/** One-shot stale answer: the next `?limit=200` call returns this pre-reset
 *  page (a fetch that was in flight when the clear landed), then routing
 *  resumes. */
let staleNext: { gen: number; msgs: Array<{ seq: number; msg: unknown }> } | null = null

/** Deferred in-flight fetches: the FIRST matching request returns the
 *  pending promise (stays unhandled until the test resolves it) — how the
 *  race tests park a fetch mid-flight while the clear lands. */
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

const defaultApiGetImpl = async (url: string) => {
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
  if (before === undefined && staleNext) {
    const s = staleNext
    staleNext = null
    return {
      generation: s.gen,
      headSeq: s.msgs.length > 0 ? s.msgs[s.msgs.length - 1].seq + 1 : 0,
      totalCount: s.msgs.length,
      startIndex: s.msgs.length > 0 ? s.msgs[0].seq : 0,
      hasMore: false,
      messages: s.msgs,
      tombstones: [],
    }
  }
  return pageFor(sid, before, limit)
}

const mockApiGet = vi.fn(defaultApiGetImpl)

const fakeGet = mockApiGet as unknown as <T>(path: string) => Promise<T>

// ── Helpers ────────────────────────────────────────────────────────

const noopHandlers: SessionSyncHandlers = {
  onRequest: vi.fn(),
  onResolved: vi.fn(),
}

function dispatchToSession(sessionId: string, frame: WsServerFrame): void {
  const set = currentSessionListeners.get(sessionId)
  if (!set) throw new Error(`No listeners for session ${sessionId}`)
  for (const fn of set) fn(frame)
}

function makeSync(sid: string): SessionSynchronizer {
  return new SessionSynchronizer({
    sessionId: sid,
    store: getSessionStore(sid),
    hub: fakeHub,
    get: fakeGet,
    handlers: noopHandlers,
  })
}

/** All `?limit=200`-only (no `before`) fetches — the tail-page requests. */
function tailFetchUrls(): string[] {
  return mockApiGet.mock.calls.map((c) => c[0] as string).filter((u) => !u.includes('before='))
}

/** All fetches with a `before` cursor (gap-fill + loadOlder). */
function beforeFetchUrls(): string[] {
  return mockApiGet.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('before='))
}

/** All gap-fill fetches (synonym for beforeFetchUrls in this suite). */
function gapFetchUrls(): string[] {
  return beforeFetchUrls()
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

describe('SessionSynchronizer seq-window protocol', () => {
  beforeEach(() => {
    currentSessionListeners = new Map()
    transcripts.clear()
    staleNext = null
    deferredFetches = []
    mockSubscribe.mockClear()
    mockApiGet.mockReset()
    mockApiGet.mockImplementation(defaultApiGetImpl)
    void sessionStoreRegistry.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Open scenario ①: mount → tail page (newest 200) → attached reports the
   *  server allocated 10 more while the page was in flight → catch-up pages
   *  the REST gap [newestSeq+1, headSeq-1] closed. */
  it('opens with the tail page and catches up on attached headSeq growth', async () => {
    const sid = 'seq-open'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()

    // Tail page: the newest 200 (seq 50..249), older history still exists.
    await waitForTail(sid)
    expect(tailFetchUrls()).toEqual([`/sessions/${sid}/messages?limit=200`])
    expect(store.getSnapshot().messages).toHaveLength(200)
    expect(store.getSnapshot().oldestSeq).toBe(50)
    expect(store.getSnapshot().hasOlder).toBe(true)

    // The server allocated 10 more messages after the page was read.
    for (let i = 250; i < 260; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 260

    dispatchToSession(sid, { kind: 'attached', sessionId: sid, generation: 0, headSeq: 260 })

    // Gap-fill fetch anchored at headSeq (before=260), gap closed. The
    // ordered log holds only the WINDOWED seqs: 200 (tail) + 10 (gap).
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(210))
    expect(gapFetchUrls()).toEqual([`/sessions/${sid}/messages?before=260&limit=200`])
    expect(store.getSnapshot().oldestSeq).toBe(50)
    const snap = store.getSnapshot()
    expect(snap.newestSeq).toBe(259)
    expect(snap.hole).toBeNull()
    sync.stop()
  })

  /** Open scenario ②: a live frame whose seq jumped parks in the window and
   *  the REST gap [newestSeq+1, seq-1] fills from the endpoint. */
  it('fills a live seq jump from REST before appending the parked frame', async () => {
    const sid = 'seq-hole'
    const t = transcript(sid)
    for (let i = 0; i < 10; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 10

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await waitForTail(sid)
    expect(store.getSnapshot().messages).toHaveLength(10)

    // Live frames 10 and 11 are missed (disconnect); 12 arrives live.
    for (let i = 10; i < 13; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 13

    dispatchToSession(sid, {
      kind: 'message',
      sessionId: sid,
      seq: 12,
      generation: 0,
      message: fakeMsg(sid, 12),
    })

    // The frame parks (hole [10, 11]); fillGap anchors at the hole's top
    // edge + 1 = 12 — the endpoint's `before` is EXCLUSIVE, so before=12
    // returns exactly the missing range [10, 11].
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(13))
    expect(gapFetchUrls()).toEqual([`/sessions/${sid}/messages?before=12&limit=200`])
    const snap = store.getSnapshot()
    expect(snap.newestSeq).toBe(12)
    expect(snap.hole).toBeNull()
    // Seq order preserved: the parked frame's message renders at the tail.
    expect(store.getSnapshot().messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(
      Array.from({ length: 13 }, (_, i) => `${sid}-m${i}`),
    )
    sync.stop()
  })

  /** Compat lock: a frame carrying seq but NO generation (pre-generation
   *  server) must take the legacy MESSAGE append. */
  it('takes the legacy append path when a live frame has seq but no generation', async () => {
    const sid = 'seq-no-gen'
    const t = transcript(sid)
    for (let i = 0; i < 5; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 5

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await waitForTail(sid)
    expect(store.getSnapshot().messages).toHaveLength(5)
    expect(store.getSnapshot().newestSeq).toBe(4)

    dispatchToSession(sid, {
      kind: 'message',
      sessionId: sid,
      seq: 5,
      message: fakeMsg(sid, 5),
    } as WsServerFrame)

    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(6))
    const snap = store.getSnapshot()
    expect(snap.newestSeq).toBe(4)
    expect(snap.oldestSeq).toBe(0)
    expect(snap.hole).toBeNull()
    expect(gapFetchUrls()).toEqual([])
    sync.stop()
  })

  /** Open scenario ③: attached reveals a new generation (server-side /clear)
   *  → WINDOW_BUMP wipes the window, tail page refetched. */
  it('bumps the window and refetches the tail when attached reports a new generation', async () => {
    const sid = 'seq-bump'
    const t = transcript(sid)
    for (let i = 0; i < 5; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 5

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(5))

    // The server /clears: generation bumps, seq space resets.
    t.generation = 1
    t.msgs = []
    t.headSeq = 0

    dispatchToSession(sid, { kind: 'attached', sessionId: sid, generation: 1, headSeq: 0 })

    await vi.waitFor(() => {
      expect(store.getSnapshot().generation).toBe(1)
    })
    expect(store.getSnapshot().messages).toEqual([])
    expect(store.getSnapshot().replayReady).toBe(true)
    // Exactly one refetch after the bump (the tail page, no `before`).
    expect(tailFetchUrls()).toHaveLength(2)
    sync.stop()
  })

  /** Open scenario ④: messages-evicted tombstones converge the window and
   *  the ordered log. */
  it('converges on messages-evicted (seq tombstones)', async () => {
    const sid = 'seq-evict'
    const t = transcript(sid)
    for (let i = 0; i < 10; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 10

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(10))

    dispatchToSession(sid, { kind: 'messages-evicted', sessionId: sid, seqs: [3, 4], generation: 0 })

    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(8))
    const snap = store.getSnapshot()
    expect(snap.oldestSeq).toBe(0)
    expect(snap.newestSeq).toBe(9)
    expect(snap.hole).toBeNull()
    const uuids = store.getSnapshot().messages.map((m) => (m as { uuid?: string }).uuid)
    expect(uuids).not.toContain(`${sid}-m3`)
    expect(uuids).not.toContain(`${sid}-m4`)
    sync.stop()
  })

  // ── interrupt/withdraw tombstone race (the stuck WorkingBubble bug) ──

  it('withdrawal evict of the applied top seq lets the result frame append with zero fetches', async () => {
    const sid = 'seq-tombstone-race'
    const t = transcript(sid)
    for (let i = 0; i < 5; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 5

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await waitForTail(sid)
    expect(store.getSnapshot().messages).toHaveLength(5)

    // Steered message applied live at seq 5.
    dispatchToSession(sid, { kind: 'message', sessionId: sid, seq: 5, generation: 0, message: fakeMsg(sid, 5) })
    expect(store.getSnapshot().messages).toHaveLength(6)

    // interrupt(): tombstone 5 + messages-evicted; the result registers at 6.
    t.evicted.add(5)
    t.msgs.push({ seq: 6, msg: fakeMsg(sid, 6) })
    t.headSeq = 7
    dispatchToSession(sid, { kind: 'messages-evicted', sessionId: sid, seqs: [5], generation: 0 })
    dispatchToSession(sid, { kind: 'message', sessionId: sid, seq: 6, generation: 0, message: fakeMsg(sid, 6) })

    // The withdrawn steer's bubble is GONE: 5 seeded rows + the result = 6.
    expect(store.getSnapshot().messages).toHaveLength(6)
    expect(gapFetchUrls()).toEqual([])
    const snap = store.getSnapshot()
    expect(snap.newestSeq).toBe(6)
    expect(snap.hole).toBeNull()
    const uuids = store.getSnapshot().messages.map((m) => (m as { uuid?: string }).uuid)
    expect(uuids).not.toContain(`${sid}-m5`)
    expect(uuids.at(-1)).toBe(`${sid}-m6`)
    sync.stop()
  })

  /** Fresh open AFTER the race (panel reopened): the tail page spans the
   *  tombstone and must bootstrap without parking seq 6 behind the dead seq. */
  it('a fresh open whose tail page spans a tombstone bootstraps without parking', async () => {
    const sid = 'seq-tombstone-open'
    const t = transcript(sid)
    for (let i = 0; i < 7; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.evicted.add(5)
    t.headSeq = 7

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await waitForTail(sid)
    expect(store.getSnapshot().messages).toHaveLength(6)
    const snap = store.getSnapshot()
    expect(snap.newestSeq).toBe(6)
    expect(snap.hole).toBeNull()
    const uuids = store.getSnapshot().messages.map((m) => (m as { uuid?: string }).uuid)
    expect(uuids).not.toContain(`${sid}-m5`)
    expect(uuids.at(-1)).toBe(`${sid}-m6`)
    sync.stop()
  })

  /** Missed-evict reconnect: the live frame above the tombstone parks, and
   *  the gap-fill page's declared tombstones heal it. */
  it('gap-fill across a tombstone drains the parked frame when the page declares it', async () => {
    const sid = 'seq-tombstone-gap'
    const t = transcript(sid)
    for (let i = 0; i < 5; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 5

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(5))

    // seq 5 was withdrawn+tomstoned while this tab was disconnected; only
    // seq 6 arrives live. It must park (hole [5,5])…
    t.evicted.add(5)
    t.msgs.push({ seq: 6, msg: fakeMsg(sid, 6) })
    t.headSeq = 7
    dispatchToSession(sid, { kind: 'message', sessionId: sid, seq: 6, generation: 0, message: fakeMsg(sid, 6) })

    // …and the gap-fill page (before=6, tombstones [5]) drains it.
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(6))
    expect(gapFetchUrls()).toEqual([`/sessions/${sid}/messages?before=6&limit=200`])
    const snap = store.getSnapshot()
    expect(snap.hole).toBeNull()
    expect(snap.newestSeq).toBe(6)
    sync.stop()
  })

  // ── multi-page gap ────────────────────────────────────────────────

  it('fills a multi-page gap with multiple REST fetches', async () => {
    const sid = 'seq-multipage'
    const t = transcript(sid)
    for (let i = 0; i <= 400; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 401

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await waitForTail(sid)
    // Tail page: newest 200 = seqs 201..400.
    expect(store.getSnapshot().messages).toHaveLength(200)

    // Server allocates 202 more (401..602), headSeq=603.
    for (let i = 401; i <= 602; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 603

    // Live frame at seq 602 → parks (hole [401, 601], 201 missing seqs).
    dispatchToSession(sid, { kind: 'message', sessionId: sid, seq: 602, generation: 0, message: fakeMsg(sid, 602) })

    // fillGap: page 1 (before=602) returns newest 200 < 602 = 402..601.
    // After dispatch: hole [401, 401] (1 missing).
    // page 2 (before=402) returns newest 200 < 402 = 202..401 (includes 401).
    // After dispatch: hole cleared. pending 602 appends.
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(402))
    expect(gapFetchUrls()).toEqual([
      `/sessions/${sid}/messages?before=602&limit=200`,
      `/sessions/${sid}/messages?before=402&limit=200`,
    ])
    const snap = store.getSnapshot()
    expect(snap.hole).toBeNull()
    expect(snap.newestSeq).toBe(602)
    sync.stop()
  })

  // ── no-progress termination ───────────────────────────────────────

  it('stops the gap-fill loop when a page makes no progress (no infinite loop)', async () => {
    const sid = 'seq-noprogress'
    const t = transcript(sid)
    for (let i = 0; i < 10; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 10

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await waitForTail(sid)
    expect(store.getSnapshot().messages).toHaveLength(10)

    // Server allocates 10 more (10..19), headSeq=20.
    for (let i = 10; i < 20; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 20

    // Mock the gap-fill to return an EMPTY page — no messages, so the
    // page changes nothing (no progress). The fillGap loop must break.
    mockApiGet.mockImplementation(async (url: string) => {
      if (url.includes('before=')) {
        return { generation: 0, headSeq: 20, totalCount: 10, startIndex: 0, hasMore: false, messages: [], tombstones: [] }
      }
      return pageFor(sid, undefined, 200)
    })

    // Live frame at seq 19 → parks (hole [10, 18]).
    dispatchToSession(sid, { kind: 'message', sessionId: sid, seq: 19, generation: 0, message: fakeMsg(sid, 19) })

    // Give the gap-fill a tick to run and break.
    await new Promise((r) => setTimeout(r, 100))

    // Only ONE gap-fetch was made (the loop broke, no infinite loop).
    expect(gapFetchUrls()).toEqual([`/sessions/${sid}/messages?before=19&limit=200`])
    // The hole is still there (the page didn't fill it).
    expect(store.getSnapshot().hole).not.toBeNull()
    sync.stop()
  })

  // ── loadOlder (seq paging) ────────────────────────────────────────

  it('loadOlder pages before=oldestSeq and lets the window drive hasOlder', async () => {
    const sid = 'seq-older'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(200))
    expect(store.getSnapshot().hasOlder).toBe(true)

    const prepended = await sync.loadOlder()
    expect(prepended).toBe(50)
    expect(gapFetchUrls()).toEqual([`/sessions/${sid}/messages?before=50&limit=200`])
    expect(store.getSnapshot().messages).toHaveLength(250)
    expect(store.getSnapshot().oldestSeq).toBe(0)
    expect(store.getSnapshot().hasOlder).toBe(false)
    sync.stop()
  })

  it('loadOlder is a no-op (no fetch) while the window is empty', async () => {
    const sid = 'seq-empty-guard'
    transcript(sid) // empty transcript — the tail page comes back empty

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await waitForTail(sid)
    expect(store.getSnapshot().oldestSeq).toBeNull()
    mockApiGet.mockClear()

    const prepended = await sync.loadOlder()
    expect(prepended).toBe(0)
    expect(mockApiGet).not.toHaveBeenCalled()
    sync.stop()
  })

  // ── session-cleared: stale in-flight page retry ───────────────────

  it('retries a pre-clear tail page until the new generation answers', async () => {
    const sid = 'seq-stale'
    const t = transcript(sid)
    for (let i = 0; i < 3; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 3

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(3))

    // The clear lands on the server; a tail page that was ALREADY in flight
    // returns the pre-clear content at the OLD generation.
    t.generation = 1
    t.msgs = []
    t.headSeq = 0
    staleNext = {
      gen: 0,
      msgs: [
        { seq: 0, msg: fakeMsg(sid, 0) },
        { seq: 1, msg: fakeMsg(sid, 1) },
        { seq: 2, msg: fakeMsg(sid, 2) },
      ],
    }

    dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid })

    await vi.waitFor(() => {
      expect(store.getSnapshot().generation).toBe(1)
    })
    // The pre-clear content did NOT resurrect.
    expect(store.getSnapshot().messages).toEqual([])
    // Two tail fetches: the stale one (discarded) + the retry (adopted).
    expect(tailFetchUrls().length).toBeGreaterThanOrEqual(2)
    sync.stop()
  })

  // ── live frames before the tail page ──────────────────────────────

  it('drops seq-carrying live frames that arrive before the tail page, then heals', async () => {
    const sid = 'seq-race'
    const t = transcript(sid)
    for (let i = 0; i < 3; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 3

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    // Frames landing while the window is still empty (generation -1) are
    // dropped by liveAppend's generation guard.
    dispatchToSession(sid, {
      kind: 'message',
      sessionId: sid,
      seq: 3,
      generation: 0,
      message: fakeMsg(sid, 3),
    })
    expect(store.getSnapshot().messages).toEqual([])

    // The page lands (seqs 0..2), then the next live frame arrives: it
    // parks behind the hole [3, 3] and the REST gap-fill heals it.
    t.msgs.push({ seq: 3, msg: fakeMsg(sid, 3) })
    t.msgs.push({ seq: 4, msg: fakeMsg(sid, 4) })
    t.headSeq = 5
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(3))
    dispatchToSession(sid, {
      kind: 'message',
      sessionId: sid,
      seq: 4,
      generation: 0,
      message: fakeMsg(sid, 4),
    })

    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(5))
    expect(gapFetchUrls()).toContain(`/sessions/${sid}/messages?before=4&limit=200`)
    sync.stop()
  })

  // ── /clear races against in-flight pages ──────────────────────────

  it('discards a loadOlder head page that was in flight when session-cleared lands', async () => {
    const sid = 'fix-older-clear'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await vi.waitFor(() => {
      expect(store.getSnapshot().messages).toHaveLength(200)
      expect(store.getSnapshot().oldestSeq).toBe(50)
    })

    // Park the loadOlder fetch mid-flight, THEN clear.
    const inFlight = queueDeferredFetch(/before=50&limit=200/)
    let loadResult: number | null = null
    const loadPromise = sync.loadOlder().then((n) => { loadResult = n; return n })

    t.generation = 1
    t.msgs = []
    t.headSeq = 0
    dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid })
    // The handler's own post-clear refetch has landed: empty, generation 1.
    await vi.waitFor(() => {
      expect(store.getSnapshot().generation).toBe(1)
      expect(store.getSnapshot().messages).toEqual([])
    })

    // NOW the pre-clear head page resolves: epoch-invalidated, retried
    // into a post-clear (empty, gen 1) page.
    inFlight.resolve({
      generation: 0,
      headSeq: 50,
      totalCount: 50,
      startIndex: 0,
      hasMore: false,
      messages: Array.from({ length: 50 }, (_, i) => ({ seq: i, msg: fakeMsg(sid, i) })),
      tombstones: [],
    })
    await loadPromise

    // The pre-clear content did NOT resurrect; the retry adopted gen 1.
    expect(loadResult).toBe(0)
    expect(store.getSnapshot().messages).toEqual([])
    expect(store.getSnapshot().generation).toBe(1)

    // The new generation is live: seq-carrying frames at gen 1 are NOT
    // dropped by a stale window generation.
    t.msgs.push({ seq: 0, msg: fakeMsg(sid, 0) })
    t.headSeq = 1
    dispatchToSession(sid, {
      kind: 'message',
      sessionId: sid,
      seq: 0,
      generation: 1,
      message: fakeMsg(sid, 0),
    })
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(1))
    sync.stop()
  })

  it('discards the open tail page when session-cleared lands before any generation was adopted (multi-tab race)', async () => {
    const sid = 'fix-epoch-clear'
    const t = transcript(sid)
    for (let i = 0; i < 3; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 3

    const store = getSessionStore(sid)

    // Park the OPEN tail fetch mid-flight.
    const inFlight = queueDeferredFetch(/\/sessions\/[^/]+\/messages\?limit=200/)
    const sync = makeSync(sid)
    sync.start()
    expect(store.getSnapshot().messages).toEqual([])

    // Another tab's /clear broadcast arrives while the fetch is in flight.
    t.generation = 1
    t.msgs = []
    t.headSeq = 0
    dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid })
    // The handler's own refetch: post-clear, gen 1, adopted.
    await vi.waitFor(() => {
      expect(store.getSnapshot().generation).toBe(1)
      expect(store.getSnapshot().replayReady).toBe(true)
    })

    // The pre-clear gen-0 tail page resolves — epoch-invalidated, retried
    // into the post-clear empty page.
    inFlight.resolve({
      generation: 0,
      headSeq: 3,
      totalCount: 3,
      startIndex: 0,
      hasMore: false,
      messages: [
        { seq: 0, msg: fakeMsg(sid, 0) },
        { seq: 1, msg: fakeMsg(sid, 1) },
        { seq: 2, msg: fakeMsg(sid, 2) },
      ],
      tombstones: [],
    })

    await vi.waitFor(() => {
      expect(store.getSnapshot().generation).toBe(1)
      expect(store.getSnapshot().messages).toEqual([])
    })

    // Live frames of the new generation flow (not dropped).
    t.msgs.push({ seq: 0, msg: fakeMsg(sid, 0) })
    t.headSeq = 1
    dispatchToSession(sid, {
      kind: 'message',
      sessionId: sid,
      seq: 0,
      generation: 1,
      message: fakeMsg(sid, 0),
    })
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(1))
    sync.stop()
  })

  it('discards a gap-fill page that was in flight when session-cleared lands', async () => {
    // The gap-page clear race: a fillGap fetch is parked mid-flight when
    // session-cleared lands. The pre-clear page must be epoch-invalidated
    // and retried into a post-clear (empty) page.
    const sid = 'fix-gap-clear'
    const t = transcript(sid)
    for (let i = 0; i < 5; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 5

    const store = getSessionStore(sid)
    const sync = makeSync(sid)
    sync.start()
    await waitForTail(sid)
    expect(store.getSnapshot().messages).toHaveLength(5)

    // Server allocates 5 more (5..9), headSeq=10.
    for (let i = 5; i < 10; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 10

    // Queue the deferred BEFORE dispatching the live frame — the fillGap
    // starts synchronously inside the message handler, so the deferred
    // must already be in place when its fetch fires.
    const inFlight = queueDeferredFetch(/before=9&limit=200/)

    // Live frame at seq 9 → parks (hole [5, 8]). The fillGap calls
    // get(before=9) which matches the deferred → returns the pending
    // promise. The fillGap is parked mid-flight.
    dispatchToSession(sid, { kind: 'message', sessionId: sid, seq: 9, generation: 0, message: fakeMsg(sid, 9) })

    // Server /clears: generation bumps, seq space resets.
    t.generation = 1
    t.msgs = []
    t.headSeq = 0

    // Fire session-cleared — the gap-fill's in-flight page is
    // epoch-invalidated.
    dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid })

    // The handler's own refetchTail: post-clear, gen 1, adopted.
    await vi.waitFor(() => {
      expect(store.getSnapshot().generation).toBe(1)
      expect(store.getSnapshot().replayReady).toBe(true)
    })

    // NOW the pre-clear gap-fill page resolves — epoch-invalidated, retried
    // into a post-clear (empty, gen 1) page.
    inFlight.resolve({
      generation: 0,
      headSeq: 10,
      totalCount: 5,
      startIndex: 5,
      hasMore: false,
      messages: [
        { seq: 5, msg: fakeMsg(sid, 5) },
        { seq: 6, msg: fakeMsg(sid, 6) },
        { seq: 7, msg: fakeMsg(sid, 7) },
        { seq: 8, msg: fakeMsg(sid, 8) },
      ],
      tombstones: [],
    })

    // Give the retry chain a tick to settle.
    await vi.waitFor(() => {
      expect(store.getSnapshot().generation).toBe(1)
      expect(store.getSnapshot().messages).toEqual([])
    })
    sync.stop()
  })
})
