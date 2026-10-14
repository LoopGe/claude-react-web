// Environment: repo default happy-dom (matches the sibling hook tests —
// renderHook + the localStorage-backed store registry need a DOM).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// Fake-hub tests for the seq-window protocol wiring (transcript-seq
// refactor, Task 8): open = REST tail page + subscribe; live hole → REST
// gap-fill; attached = generation bump / reconnect catch-up; eviction by
// seq; replay payloads dropped. The api.get router serves an in-memory
// transcript exactly the way GET /sessions/:id/messages does (before =
// exclusive upper seq bound, newest-first page, hasMore past the page).

type WsHubListener = (frame: Record<string, unknown>) => void

let currentSessionListeners: Map<string, Set<WsHubListener>>

const mockSubscribe = vi.fn(() => vi.fn())
const mockHub = {
  addListener: () => () => {},
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
  setLastMessageUuid: vi.fn(),
}

interface FakeTranscript {
  generation: number
  headSeq: number
  msgs: Array<{ seq: number; msg: unknown }>
}

/** In-memory server transcripts, keyed by session id. Tests mutate these to
 *  simulate the server allocating / clearing seqs between frames. */
const transcripts = new Map<string, FakeTranscript>()

function transcript(sid: string): FakeTranscript {
  let t = transcripts.get(sid)
  if (!t) {
    t = { generation: 0, headSeq: 0, msgs: [] }
    transcripts.set(sid, t)
  }
  return t
}

function fakeMsg(sid: string, seq: number) {
  return { type: 'assistant', uuid: `${sid}-m${seq}`, message: { role: 'assistant', content: [{ type: 'text', text: `m${seq}` }] } }
}

/** The GET /sessions/:id/messages semantics, faithfully: `before` is an
 *  exclusive upper bound, the page is the newest `limit` eligible messages,
 *  hasMore reports older eligible content past the page. */
function pageFor(sid: string, before: number | undefined, limit: number) {
  const t = transcript(sid)
  const eligible = t.msgs.filter((m) => before === undefined || m.seq < before)
  const page = eligible.slice(-limit)
  return {
    generation: t.generation,
    headSeq: t.headSeq,
    totalCount: t.msgs.length,
    startIndex: page.length > 0 ? page[0].seq : (before ?? t.headSeq),
    hasMore: eligible.length > page.length,
    messages: page,
  }
}

/** One-shot stale answer: the next `?limit=200` call returns this pre-reset
 *  page (a fetch that was in flight when the clear landed), then routing
 *  resumes. */
let staleNext: { gen: number; msgs: Array<{ seq: number; msg: unknown }> } | null = null

/** Deferred in-flight fetches: the FIRST matching request is held un-handled
 *  (a promise the test resolves later with a hand-built page) — how the
 *  race tests park a fetch mid-flight while the clear lands. */
interface DeferredFetch {
  pattern: RegExp
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
  deferredFetches.push({ pattern, resolve })
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
    return d.resolve(pageFor(sid, before, limit))
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
    }
  }
  return pageFor(sid, before, limit)
})

vi.mock('./useApi', () => ({
  api: { get: (...args: unknown[]) => mockApiGet(...(args as [string])), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}))
vi.mock('./useWsHub', () => ({
  useWsHub: () => mockHub,
  useWsHubStatus: () => 'online' as const,
}))

import { useChatStream, cacheClear, type PermissionHandlers } from './useChatStream'
import { getSessionStore } from '../session-store/selectors'

function dispatchToSession(sessionId: string, frame: Record<string, unknown>) {
  const set = currentSessionListeners.get(sessionId)
  if (!set) throw new Error(`No listeners for session ${sessionId}`)
  for (const fn of set) fn(frame)
}

const noopPerms: PermissionHandlers = {
  onRequest: vi.fn(),
  onResolved: vi.fn(),
}

/** All `?limit=200`-only (no `before`) fetches — the tail-page requests. */
function tailFetchUrls(): string[] {
  return mockApiGet.mock.calls.map((c) => c[0] as string).filter((u) => !u.includes('before='))
}

/** All gap-fill fetches with their `before` cursor. */
function gapFetchUrls(): string[] {
  return mockApiGet.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('before='))
}

describe('useChatStream seq-window protocol', () => {
  beforeEach(() => {
    currentSessionListeners = new Map()
    transcripts.clear()
    staleNext = null
    deferredFetches = []
    mockSubscribe.mockClear()
    mockApiGet.mockClear()
    cacheClear()
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

    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))

    // Tail page: the newest 200 (seq 50..249), older history still exists.
    await waitFor(() => expect(result.current.replayReady).toBe(true))
    expect(tailFetchUrls()).toEqual([`/sessions/${sid}/messages?limit=200`])
    expect(result.current.messages).toHaveLength(200)
    expect(result.current.oldestSeq).toBe(50)
    expect(result.current.hasOlder).toBe(true)

    // The server allocated 10 more messages after the page was read.
    for (let i = 250; i < 260; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 260

    act(() => {
      dispatchToSession(sid, { kind: 'attached', sessionId: sid, generation: 0, headSeq: 260 })
    })

    // Gap-fill fetch anchored at headSeq (before=260), gap closed. The
    // ordered log holds only the WINDOWED seqs: 200 (tail) + 10 (gap) —
    // seqs 0..49 were never windowed (they are behind hasOlder).
    await waitFor(() => expect(result.current.messages).toHaveLength(210))
    expect(gapFetchUrls()).toEqual([`/sessions/${sid}/messages?before=260&limit=200`])
    expect(result.current.oldestSeq).toBe(50)
    const snap = getSessionStore(sid).getSnapshot()
    expect(snap.newestSeq).toBe(259)
    expect(snap.hole).toBeNull()
  })

  /** Open scenario ②: a live frame whose seq jumped parks in the window and
   *  the REST gap [newestSeq+1, seq-1] fills from the endpoint. */
  it('fills a live seq jump from REST before appending the parked frame', async () => {
    const sid = 'seq-hole'
    const t = transcript(sid)
    for (let i = 0; i < 10; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 10

    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    await waitFor(() => expect(result.current.replayReady).toBe(true))
    expect(result.current.messages).toHaveLength(10)

    // Live frames 10 and 11 are missed (disconnect); 12 arrives live.
    for (let i = 10; i < 13; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 13

    act(() => {
      dispatchToSession(sid, {
        kind: 'message',
        sessionId: sid,
        seq: 12,
        generation: 0,
        message: fakeMsg(sid, 12),
      })
    })

    // The frame parks (hole [10, 11]); fillGap anchors at the hole's top
    // edge + 1 = 12 — the endpoint's `before` is EXCLUSIVE, so before=12
    // returns exactly the missing range [10, 11].
    await waitFor(() => expect(result.current.messages).toHaveLength(13))
    expect(gapFetchUrls()).toEqual([`/sessions/${sid}/messages?before=12&limit=200`])
    const snap = getSessionStore(sid).getSnapshot()
    expect(snap.newestSeq).toBe(12)
    expect(snap.hole).toBeNull()
    // Seq order preserved: the parked frame's message renders at the tail.
    expect(result.current.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(
      Array.from({ length: 13 }, (_, i) => `${sid}-m${i}`),
    )
  })

  /** Open scenario ③: attached reveals a new generation (server-side /clear)
   *  → WINDOW_BUMP wipes the window, tail page refetched under the new
   *  generation. */
  it('bumps the window and refetches the tail when attached reports a new generation', async () => {
    const sid = 'seq-bump'
    const t = transcript(sid)
    for (let i = 0; i < 5; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 5

    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    await waitFor(() => expect(result.current.messages).toHaveLength(5))

    // The server /clears: generation bumps, seq space resets.
    t.generation = 1
    t.msgs = []
    t.headSeq = 0

    act(() => {
      dispatchToSession(sid, { kind: 'attached', sessionId: sid, generation: 1, headSeq: 0 })
    })

    await waitFor(() => {
      const snap = getSessionStore(sid).getSnapshot()
      expect(snap.generation).toBe(1)
    })
    expect(result.current.messages).toEqual([])
    expect(result.current.replayReady).toBe(true)
    // Exactly one refetch after the bump (the tail page, no `before`).
    expect(tailFetchUrls()).toHaveLength(2)
  })

  /** Open scenario ④: messages-evicted tombstones converge the window and
   *  the ordered log. */
  it('converges on messages-evicted (seq tombstones)', async () => {
    const sid = 'seq-evict'
    const t = transcript(sid)
    for (let i = 0; i < 10; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 10

    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    await waitFor(() => expect(result.current.messages).toHaveLength(10))

    act(() => {
      dispatchToSession(sid, { kind: 'messages-evicted', sessionId: sid, seqs: [3, 4], generation: 0 })
    })

    await waitFor(() => expect(result.current.messages).toHaveLength(8))
    const snap = getSessionStore(sid).getSnapshot()
    // Boundaries recomputed from the surviving contents.
    expect(snap.oldestSeq).toBe(0)
    expect(snap.newestSeq).toBe(9)
    expect(snap.hole).toBeNull()
    // The evicted uuids left the ordered log too.
    const uuids = result.current.messages.map((m) => (m as { uuid?: string }).uuid)
    expect(uuids).not.toContain(`${sid}-m3`)
    expect(uuids).not.toContain(`${sid}-m4`)
  })

  /** Open scenario ⑤: the P1 server still serves replay bursts on subscribe —
   *  their payloads are dropped (the tail page is authoritative), while the
   *  pending-request snapshots riding them are still harvested. */
  it('drops replay payloads and keeps their permission snapshots', async () => {
    const sid = 'seq-replay'
    const t = transcript(sid)
    for (let i = 0; i < 5; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 5

    const onRequest = vi.fn()
    const { result } = renderHook(() => useChatStream(sid, { onRequest, onResolved: vi.fn() }, false, false))
    await waitFor(() => expect(result.current.messages).toHaveLength(5))

    // A reconnect's replay burst lands AFTER the tail page: its messages
    // must NOT double-apply (a uuid-keyed REPLAY_REPLACE here would diverge
    // the ordered log from the seq window).
    act(() => {
      dispatchToSession(sid, {
        kind: 'replay',
        sessionId: sid,
        messages: [fakeMsg(sid, 100), fakeMsg(sid, 101)],
        permissions: [{ id: 'p1', kind: 'permission', toolName: 'Bash' }],
      })
      dispatchToSession(sid, { kind: 'replay-done', sessionId: sid })
    })

    expect(result.current.messages).toHaveLength(5)
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
    const snap = getSessionStore(sid).getSnapshot()
    expect(snap.oldestSeq).toBe(0)
    expect(snap.newestSeq).toBe(4)
  })

  // ── loadOlder (seq paging) ────────────────────────────────────────

  it('loadOlder pages before=oldestSeq and lets the window drive hasOlder', async () => {
    const sid = 'seq-older'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    await waitFor(() => expect(result.current.messages).toHaveLength(200))
    expect(result.current.hasOlder).toBe(true)

    let prepended = -1
    await act(async () => { prepended = await result.current.loadOlder() })
    expect(prepended).toBe(50)
    // before = the oldestSeq at call time (50): the page below the window.
    expect(gapFetchUrls()).toEqual([`/sessions/${sid}/messages?before=50&limit=200`])
    expect(result.current.messages).toHaveLength(250)
    expect(result.current.oldestSeq).toBe(0)
    // The page's hasMore (false — nothing below seq 0) is now authoritative.
    expect(result.current.hasOlder).toBe(false)
  })

  it('loadOlder is a no-op (no fetch) while the window is empty', async () => {
    // Guard per the Task 7 review: hasOlder can be stale-true on an emptied
    // window; oldestSeq == null must gate. Here the mount's tail page is
    // empty, so oldestSeq is null even though a seeded hasOlder might read
    // true on a stale snapshot.
    const sid = 'seq-empty-guard'
    transcript(sid) // empty transcript — the tail page comes back empty

    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    await waitFor(() => expect(result.current.replayReady).toBe(true))
    expect(result.current.oldestSeq).toBeNull()
    mockApiGet.mockClear()

    let prepended = -1
    await act(async () => { prepended = await result.current.loadOlder() })
    expect(prepended).toBe(0)
    expect(mockApiGet).not.toHaveBeenCalled()
  })

  // ── session-cleared: stale in-flight page retry ───────────────────

  it('retries a pre-clear tail page until the new generation answers', async () => {
    const sid = 'seq-stale'
    const t = transcript(sid)
    for (let i = 0; i < 3; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 3

    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    await waitFor(() => expect(result.current.messages).toHaveLength(3))

    // The clear lands on the server; a tail page that was ALREADY in flight
    // returns the pre-clear content at the OLD generation — adopting it on
    // the emptied window would resurrect the cleared transcript.
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

    act(() => {
      dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid })
    })

    await waitFor(() => {
      const snap = getSessionStore(sid).getSnapshot()
      expect(snap.generation).toBe(1)
    })
    // The pre-clear content did NOT resurrect.
    expect(result.current.messages).toEqual([])
    // Two tail fetches: the stale one (discarded) + the retry (adopted).
    expect(tailFetchUrls().length).toBeGreaterThanOrEqual(2)
  })

  // ── live frames before the tail page ──────────────────────────────

  it('drops seq-carrying live frames that arrive before the tail page, then heals', async () => {
    const sid = 'seq-race'
    const t = transcript(sid)
    for (let i = 0; i < 3; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 3

    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    // Frames landing while the window is still empty (generation -1) are
    // dropped by liveAppend's generation guard — the tail page is
    // authoritative for everything up to its read point.
    act(() => {
      dispatchToSession(sid, {
        kind: 'message',
        sessionId: sid,
        seq: 3,
        generation: 0,
        message: fakeMsg(sid, 3),
      })
    })
    expect(result.current.messages).toEqual([])

    // The page lands (seqs 0..2), then the next live frame arrives: it
    // parks behind the hole [3, 3] left by the dropped frame, and the REST
    // gap-fill heals it.
    t.msgs.push({ seq: 3, msg: fakeMsg(sid, 3) })
    t.msgs.push({ seq: 4, msg: fakeMsg(sid, 4) })
    t.headSeq = 5
    await waitFor(() => expect(result.current.messages).toHaveLength(3))
    act(() => {
      dispatchToSession(sid, {
        kind: 'message',
        sessionId: sid,
        seq: 4,
        generation: 0,
        message: fakeMsg(sid, 4),
      })
    })

    await waitFor(() => expect(result.current.messages).toHaveLength(5))
    expect(gapFetchUrls()).toContain(`/sessions/${sid}/messages?before=4&limit=200`)
  })

  // ── /clear races against in-flight pages (round-1 fix regressions) ──

  it('discards a loadOlder head page that was in flight when session-cleared lands', async () => {
    // CLEAR_TRANSCRIPT PRESERVES the window's generation and empties it, and
    // pageLoaded bootstraps ANY generation onto an empty window — so a
    // pre-clear head page resolving onto the emptied window would resurrect
    // the cleared transcript and pin the dead generation. loadOlder must go
    // through the same clear-epoch validation as every other page read.
    const sid = 'fix-older-clear'
    const t = transcript(sid)
    for (let i = 0; i < 250; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 250

    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(200)
      expect(result.current.oldestSeq).toBe(50)
    })

    // Park the loadOlder fetch mid-flight, THEN clear.
    const inFlight = queueDeferredFetch(/before=50&limit=200/)
    let loadResult: number | null = null
    let loadPromise!: Promise<number>
    act(() => {
      loadPromise = result.current.loadOlder().then((n) => { loadResult = n; return n })
    })

    t.generation = 1
    t.msgs = []
    t.headSeq = 0
    act(() => {
      dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid })
    })
    // The handler's own post-clear refetch has landed: empty, generation 1.
    await waitFor(() => {
      expect(getSessionStore(sid).getSnapshot().generation).toBe(1)
      expect(result.current.messages).toEqual([])
    })

    // NOW the pre-clear head page resolves: epoch-invalidated, retried into
    // a post-clear (empty, gen 1) page.
    await act(async () => {
      inFlight.resolve({
        generation: 0,
        headSeq: 50,
        totalCount: 50,
        startIndex: 0,
        hasMore: false,
        messages: Array.from({ length: 50 }, (_, i) => ({ seq: i, msg: fakeMsg(sid, i) })),
      })
      await loadPromise
    })
    // The pre-clear content did NOT resurrect; the retry adopted gen 1.
    expect(loadResult).toBe(0)
    expect(result.current.messages).toEqual([])
    expect(getSessionStore(sid).getSnapshot().generation).toBe(1)

    // The new generation is live: seq-carrying frames at gen 1 are NOT
    // dropped by a stale window generation.
    t.msgs.push({ seq: 0, msg: fakeMsg(sid, 0) })
    t.headSeq = 1
    act(() => {
      dispatchToSession(sid, {
        kind: 'message',
        sessionId: sid,
        seq: 0,
        generation: 1,
        message: fakeMsg(sid, 0),
      })
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
  })

  it('discards the open tail page when session-cleared lands before any generation was adopted (multi-tab race)', async () => {
    // The window has NOT adopted a generation yet (cursor −1), so the
    // session-cleared floor `generation + 1` degenerates to 0 and a pre-clear
    // gen-0 page would PASS it and bootstrap the cleared transcript onto the
    // empty window. The clear-epoch check is what invalidates the in-flight
    // request here.
    const sid = 'fix-epoch-clear'
    const t = transcript(sid)
    for (let i = 0; i < 3; i++) t.msgs.push({ seq: i, msg: fakeMsg(sid, i) })
    t.headSeq = 3

    // Park the OPEN tail fetch mid-flight.
    const inFlight = queueDeferredFetch(/\/sessions\/[^/]+\/messages\?limit=200/)
    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    expect(result.current.messages).toEqual([])

    // Another tab's /clear broadcast arrives while the fetch is in flight.
    t.generation = 1
    t.msgs = []
    t.headSeq = 0
    act(() => {
      dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid })
    })
    // The handler's own refetch: post-clear, gen 1, adopted.
    await waitFor(() => {
      expect(getSessionStore(sid).getSnapshot().generation).toBe(1)
      expect(result.current.replayReady).toBe(true)
    })

    // The pre-clear gen-0 tail page resolves — epoch-invalidated, retried
    // into the post-clear empty page.
    await act(async () => {
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
      })
    })
    await waitFor(() => {
      // Give the retry chain a tick to settle; the transcript must stay
      // empty and the adopted generation must stay 1.
      expect(getSessionStore(sid).getSnapshot().generation).toBe(1)
      expect(result.current.messages).toEqual([])
    })

    // Live frames of the new generation flow (not dropped).
    t.msgs.push({ seq: 0, msg: fakeMsg(sid, 0) })
    t.headSeq = 1
    act(() => {
      dispatchToSession(sid, {
        kind: 'message',
        sessionId: sid,
        seq: 0,
        generation: 1,
        message: fakeMsg(sid, 0),
      })
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
  })
})
