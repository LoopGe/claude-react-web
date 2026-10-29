// Environment: repo default happy-dom (the real SessionStore uses
// window.clearTimeout in destroy()/purge(), so the registry clear between
// tests needs a DOM).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WsSubscribeResultReason } from '../ws-types'

// Framework-free synchronizer protocol tests (Task 3). Ported from
// useChatStream.test.ts: direct `new SessionSynchronizer` + start/stop
// replaces renderHook; assertions read from the real SessionStore snapshot.
// The fake hub/REST mirror the useChatStream test fixtures so case coverage
// is preserved verbatim.

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

// Default open-path answer: an empty transcript page at generation 0.
const emptyPage = {
  generation: 0,
  headSeq: 0,
  totalCount: 0,
  startIndex: 0,
  hasMore: false,
  messages: [],
}
const mockApiGet = vi.fn(async () => ({ ...emptyPage }))
const fakeGet = mockApiGet as unknown as <T>(path: string) => Promise<T>

// ── Helpers ────────────────────────────────────────────────────────

function dispatchToSession(sessionId: string, frame: WsServerFrame): void {
  const set = currentSessionListeners.get(sessionId)
  if (!set) throw new Error(`No listeners for session ${sessionId}`)
  for (const fn of set) fn(frame)
}

/** The server's answer to one subscribe frame (see WsSubscribeResult). */
function subResult(
  sessionId: string,
  ok: boolean,
  reason: WsSubscribeResultReason,
): WsServerFrame {
  return { kind: 'subscribe-result', sessionId, ok, reason }
}

const noopHandlers: SessionSyncHandlers = {
  onRequest: vi.fn(),
  onResolved: vi.fn(),
}

/** Seed the store's seq window directly: one WINDOW_PAGE tail dispatch
 *  through the real reducer, so replayReady flips and the windowed messages
 *  run the full applyMessage pipeline. */
function seedPage(
  sid: string,
  messages: Array<{ seq: number; msg: unknown }>,
  opts?: { hasMore?: boolean; generation?: number; headSeq?: number },
) {
  const headSeq = opts?.headSeq ?? (messages.length > 0 ? messages[messages.length - 1].seq + 1 : 0)
  getSessionStore(sid).dispatch({
    type: 'WINDOW_PAGE',
    at: 'tail',
    generation: opts?.generation ?? 0,
    headSeq,
    messages,
    hasMore: opts?.hasMore ?? false,
    tombstones: [],
  })
}

/** A sync Agent tool_use that seeds a `running` subagent record. */
const syncAgentFrame = {
  type: 'assistant',
  uuid: 'a-sync',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_term', name: 'Agent', input: { description: 'sync work' } }],
  },
}
const seedSyncAgent = (sid: string) => seedPage(sid, [{ seq: 0, msg: syncAgentFrame }])
const subagentStatus = (sid: string) =>
  getSessionStore(sid).getState().mirror.activeSubagents.get('tu_term')?.status

// ── Tests ──────────────────────────────────────────────────────────

describe('SessionSynchronizer protocol', () => {
  beforeEach(() => {
    currentSessionListeners = new Map()
    mockSubscribe.mockClear()
    mockApiGet.mockReset()
    mockApiGet.mockImplementation(async () => ({ ...emptyPage }))
    void sessionStoreRegistry.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Terminated session ─────────────────────────────────────────

  it('sweeps a stranded sync subagent on a RELOADED terminated session', async () => {
    // The reload flow: on start the store is empty and `terminated` is
    // already true, so a sweep at start would no-op — the record only
    // exists once the tail page lands. Gating the dispatch on
    // replayReady is what makes the sweep hit the rebuilt record.
    const sync = new SessionSynchronizer({
      sessionId: 'term-reload',
      store: getSessionStore('term-reload'),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    sync.setTerminated(true)
    seedSyncAgent('term-reload')

    // The store subscription set by setTerminated fires once the seed
    // makes replayReady true, dispatching SESSION_TERMINATED.
    await vi.waitFor(() => expect(subagentStatus('term-reload')).toBe('interrupted'))
    sync.stop()
  })

  it('sweeps a stranded sync subagent when a session terminates LIVE', async () => {
    // The common case: the transcript loaded while alive, then terminated.
    const sync = new SessionSynchronizer({
      sessionId: 'term-live',
      store: getSessionStore('term-live'),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    seedSyncAgent('term-live')
    await vi.waitFor(() => expect(subagentStatus('term-live')).toBe('running'))

    sync.setTerminated(true)
    // replayReady already true → SESSION_TERMINATED dispatched immediately.
    await vi.waitFor(() => expect(subagentStatus('term-live')).toBe('interrupted'))
    sync.stop()
  })

  it('leaves a live session alone (terminated=false must not sweep)', async () => {
    const sync = new SessionSynchronizer({
      sessionId: 'term-alive',
      store: getSessionStore('term-alive'),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    seedSyncAgent('term-alive')

    await vi.waitFor(() => expect(subagentStatus('term-alive')).toBe('running'))
    sync.stop()
  })

  // ── Live messages (seq-less legacy path) ───────────────────────

  it('appends seq-less live messages through the legacy path', async () => {
    // Frames without seq/generation keep the legacy MESSAGE dispatch — no
    // window engagement. Seq-carrying frames take the WINDOW_LIVE path
    // (covered in the seq test suite).
    const sid = 's3'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    dispatchToSession(sid, {
      kind: 'message',
      sessionId: sid,
      message: { type: 'user', uuid: 'u1' },
    } as WsServerFrame)
    dispatchToSession(sid, {
      kind: 'message',
      sessionId: sid,
      message: { type: 'assistant', uuid: 'a1' },
    } as WsServerFrame)

    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(2))
    sync.stop()
  })

  // ── Frame types ───────────────────────────────────────────────

  it('dispatches subscribe-time pending permission re-broadcasts to the handler', () => {
    const onRequest = vi.fn()
    const onResolved = vi.fn()
    const sid = 's1'
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: { onRequest, onResolved },
    })
    sync.start()

    dispatchToSession(sid, {
      kind: 'permission-request',
      sessionId: sid,
      payload: { id: 'p1', kind: 'permission', toolName: 'Bash' },
    } as WsServerFrame)

    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', toolName: 'Bash' }),
    )
    sync.stop()
  })

  it('dispatches permission-resolved to handler', () => {
    const onResolved = vi.fn()
    const sid = 's1'
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: { onRequest: vi.fn(), onResolved },
    })
    sync.start()

    dispatchToSession(sid, {
      kind: 'permission-resolved',
      sessionId: sid,
      id: 'p1',
      decision: { behavior: 'allow', persisted: false },
    } as WsServerFrame)

    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', behavior: 'allow' }),
    )
    sync.stop()
  })

  it('dispatches elicitation-request to handler', () => {
    const onElicitationRequest = vi.fn()
    const sid = 's1'
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: { ...noopHandlers, onElicitationRequest },
    })
    sync.start()

    dispatchToSession(sid, {
      kind: 'elicitation-request',
      sessionId: sid,
      payload: { id: 'e1', serverName: 'github', message: 'Sign in', mode: 'url', createdAt: 1 },
    } as WsServerFrame)

    expect(onElicitationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', serverName: 'github', mode: 'url' }),
    )
    sync.stop()
  })

  it('dispatches elicitation-resolved to handler', () => {
    const onElicitationResolved = vi.fn()
    const sid = 's1'
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: { ...noopHandlers, onElicitationResolved },
    })
    sync.start()

    dispatchToSession(sid, {
      kind: 'elicitation-resolved',
      sessionId: sid,
      id: 'e1',
      decision: { action: 'accept' },
    } as WsServerFrame)

    expect(onElicitationResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', decision: { action: 'accept' } }),
    )
    sync.stop()
  })

  it('dispatches dialog-request to handler', () => {
    const onDialogRequest = vi.fn()
    const sid = 's1'
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: { ...noopHandlers, onDialogRequest },
    })
    sync.start()

    dispatchToSession(sid, {
      kind: 'dialog-request',
      sessionId: sid,
      payload: { id: 'd1', kind: 'refusal_fallback_prompt', originalModel: 'm1', fallbackModel: 'm2' },
    } as unknown as WsServerFrame)

    expect(onDialogRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd1' }),
    )
    sync.stop()
  })

  it('extracts edit_prompt text and evicts on dialog-resolved', () => {
    const onDialogResolved = vi.fn()
    const onEditPrompt = vi.fn()
    const sid = 'd-edit'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: { ...noopHandlers, onDialogResolved, onEditPrompt },
    })
    sync.start()

    // Seed a user message that will be evicted by the dialog resolution.
    seedPage(sid, [
      { seq: 0, msg: { type: 'user', uuid: 'evicted-u', message: { role: 'user', content: 'hello world' } } },
    ])
    expect(store.getSnapshot().messages).toHaveLength(1)

    dispatchToSession(sid, {
      kind: 'dialog-resolved',
      sessionId: sid,
      id: 'd1',
      decision: { behavior: 'completed', result: 'edit_prompt' },
      retractedMessageUuids: ['evicted-u'],
    } as WsServerFrame)

    // The edit_prompt handler lifted the evicted leg's last user text.
    expect(onEditPrompt).toHaveBeenCalledWith('hello world')
    // The evicted uuid is gone from the transcript.
    expect(store.getSnapshot().messages).toEqual([])
    // The resolved callback received the full envelope.
    expect(onDialogResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd1', retractedMessageUuids: ['evicted-u'] }),
    )
    sync.stop()
  })

  it('updates context-usage', () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    dispatchToSession(sid, {
      kind: 'context-usage',
      sessionId: sid,
      usage: { totalTokens: 5000, maxTokens: 200000, percentage: 2.5 },
    } as WsServerFrame)

    expect(store.getSnapshot().contextUsage).toEqual({
      totalTokens: 5000,
      maxTokens: 200000,
      percentage: 2.5,
    })
    sync.stop()
  })

  it('dispatches prompt-suggestion', () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    dispatchToSession(sid, {
      kind: 'prompt-suggestion',
      sessionId: sid,
      suggestion: 'next prompt',
    } as WsServerFrame)

    expect(store.getSnapshot().promptSuggestion).toBe('next prompt')
    sync.stop()
  })

  it('dispatches tasks-snapshot', () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    const tasks = [{ taskId: 't1', agentId: 'a1', status: 'running', isBackgrounded: false }]
    dispatchToSession(sid, {
      kind: 'tasks-snapshot',
      sessionId: sid,
      tasks,
    } as unknown as WsServerFrame)

    expect(store.getSnapshot().tasks).toEqual(tasks)
    sync.stop()
  })

  it('dispatches message-consumed', () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    seedPage(sid, [{ seq: 0, msg: { type: 'user', uuid: 'u-cons', message: { role: 'user', content: 'hi' } } }])

    dispatchToSession(sid, {
      kind: 'message-consumed',
      sessionId: sid,
      uuid: 'u-cons',
      consumedAt: 12345,
    } as WsServerFrame)

    const item = store.getSnapshot().items[0]
    expect(item.deliveryStatus).toBe('consumed')
    sync.stop()
  })

  it('dispatches messages-withdrawn (uuid eviction)', () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    seedPage(sid, [
      { seq: 0, msg: { type: 'user', uuid: 'w1', message: { role: 'user', content: 'a' } } },
      { seq: 1, msg: { type: 'assistant', uuid: 'w2', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } } },
    ])
    expect(store.getSnapshot().messages).toHaveLength(2)

    dispatchToSession(sid, {
      kind: 'messages-withdrawn',
      sessionId: sid,
      uuids: ['w1'],
    } as WsServerFrame)

    expect(store.getSnapshot().messages.map((m) => (m as { uuid?: string }).uuid)).not.toContain('w1')
    sync.stop()
  })

  it('surfaces session-scope errors', () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    dispatchToSession(sid, {
      kind: 'error',
      sessionId: sid,
      message: 'Unknown session',
    } as WsServerFrame)

    expect(store.getSnapshot().error).toBe('Unknown session')
    sync.stop()
  })

  it('forces replayReady on an error frame before any page (no stuck skeleton)', () => {
    // If the transcript never became ready (e.g. the subscribe failed
    // because the session was already torn down), the error frame forces
    // the ready state so the error becomes visible.
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    expect(store.getSnapshot().replayReady).toBe(false)
    dispatchToSession(sid, {
      kind: 'error',
      sessionId: sid,
      message: 'boom',
    } as WsServerFrame)

    expect(store.getSnapshot().replayReady).toBe(true)
    expect(store.getSnapshot().error).toBe('boom')
    sync.stop()
  })

  it('clears error via ERROR dispatch', () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    dispatchToSession(sid, { kind: 'error', sessionId: sid, message: 'oops' } as WsServerFrame)
    expect(store.getSnapshot().error).toBe('oops')

    store.dispatch({ type: 'ERROR', message: null })
    expect(store.getSnapshot().error).toBeNull()
    sync.stop()
  })

  // ── reset ─────────────────────────────────────────────────────

  it('resets all state on store.reset()', async () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    seedPage(sid, [{ seq: 0, msg: { type: 'user', uuid: 'u1' } }])
    dispatchToSession(sid, {
      kind: 'context-usage',
      sessionId: sid,
      usage: { totalTokens: 1000 },
    } as WsServerFrame)
    dispatchToSession(sid, { kind: 'error', sessionId: sid, message: 'test error' } as WsServerFrame)

    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(1))
    expect(store.getSnapshot().contextUsage).not.toBeNull()

    store.reset()

    expect(store.getSnapshot().messages).toEqual([])
    expect(store.getSnapshot().contextUsage).toBeNull()
    expect(store.getSnapshot().error).toBeNull()
    // reset() shares the /clear wipe semantic: the post-reset state is
    // live and empty with no pending page, so replayReady must be true.
    expect(store.getSnapshot().replayReady).toBe(true)
    sync.stop()
  })

  // ── session-cleared ───────────────────────────────────────────

  it('wipes transcript + state on a session-cleared frame and re-anchors the generation', async () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()
    seedPage(sid, [
      { seq: 0, msg: { type: 'user', uuid: 'u1' } },
      { seq: 1, msg: { type: 'assistant', uuid: 'a1' } },
    ])
    await vi.waitFor(() => expect(store.getSnapshot().messages).toHaveLength(2))

    // The post-clear tail page: empty, generation 1.
    mockApiGet.mockImplementation(async () => ({
      generation: 1,
      headSeq: 0,
      totalCount: 0,
      startIndex: 0,
      hasMore: false,
      messages: [],
    }))

    dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid } as WsServerFrame)

    await vi.waitFor(() => {
      expect(store.getSnapshot().messages).toEqual([])
      expect(store.getSnapshot().generation).toBe(1)
    })
    // hasOlder flips false: the window is empty and the post-clear page
    // reported nothing older.
    expect(store.getSnapshot().hasOlder).toBe(false)
    sync.stop()
  })

  it('marks the transcript ready after a session-cleared frame (no stuck skeleton)', async () => {
    // Regression: /clear resets the store, but the post-clear session is
    // live and empty. replayReady MUST flip true on session-cleared,
    // otherwise the transcript shows an infinite skeleton.
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    seedPage(sid, [{ seq: 0, msg: { type: 'user', uuid: 'u1' } }])
    await vi.waitFor(() => expect(store.getSnapshot().replayReady).toBe(true))

    mockApiGet.mockImplementation(async () => ({
      generation: 1,
      headSeq: 0,
      totalCount: 0,
      startIndex: 0,
      hasMore: false,
      messages: [],
    }))
    dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid } as WsServerFrame)

    await vi.waitFor(() => expect(store.getSnapshot().messages).toEqual([]))
    expect(store.getSnapshot().replayReady).toBe(true)
    sync.stop()
  })

  it('invokes onCleared on a session-cleared frame', () => {
    const onCleared = vi.fn()
    const sid = 's1'
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: { ...noopHandlers, onCleared },
    })
    sync.start()

    dispatchToSession(sid, { kind: 'session-cleared', sessionId: sid } as WsServerFrame)
    expect(onCleared).toHaveBeenCalledTimes(1)
    sync.stop()
  })

  // ── subscribe/unsubscribe lifecycle ──────────────────────────

  it('subscribes on start and unsubscribes on stop', () => {
    const sync = new SessionSynchronizer({
      sessionId: 's1',
      store: getSessionStore('s1'),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    // `force` because this listener needs the channel established for
    // itself — the attached handshake (subscribe-result + attached) is
    // the reconnect catch-up trigger.
    expect(mockSubscribe).toHaveBeenCalledWith('s1', { force: true })
    const cleanupFn = mockSubscribe.mock.results[0].value
    expect(cleanupFn).not.toHaveBeenCalled()

    sync.stop()
    expect(cleanupFn).toHaveBeenCalled()
  })

  it('fetches the transcript tail page on start', async () => {
    const sync = new SessionSynchronizer({
      sessionId: 's1',
      store: getSessionStore('s1'),
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    await vi.waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/sessions/s1/messages?limit=200')
    })
    sync.stop()
  })

  // ── channel state (subscribe-result error clearing) ───────────

  it('clears a stale channel error only when the server confirms the channel', () => {
    const sid = 's1'
    const store = getSessionStore(sid)
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store,
      hub: fakeHub,
      get: fakeGet,
      handlers: noopHandlers,
    })
    sync.start()

    dispatchToSession(sid, { kind: 'error', sessionId: sid, message: 'session not loaded' } as WsServerFrame)
    expect(store.getSnapshot().error).toBe('session not loaded')

    // A refusal keeps the band: the state frame says the same thing.
    dispatchToSession(sid, subResult(sid, false, 'refused'))
    expect(store.getSnapshot().error).toBe('session not loaded')

    // Being served does clear it — intent.error survives every server-frame
    // handler, so nothing else would clear it on a healed panel.
    dispatchToSession(sid, subResult(sid, true, 'served'))
    expect(store.getSnapshot().error).toBeNull()
    sync.stop()
  })

  // ── setHandlers ──────────────────────────────────────────────

  it('setHandlers uses the newest callbacks without another subscribe', () => {
    const sid = 's1'
    const handlersA: SessionSyncHandlers = { onRequest: vi.fn(), onResolved: vi.fn() }
    const handlersB: SessionSyncHandlers = { onRequest: vi.fn(), onResolved: vi.fn() }
    const sync = new SessionSynchronizer({
      sessionId: sid,
      store: getSessionStore(sid),
      hub: fakeHub,
      get: fakeGet,
      handlers: handlersA,
    })
    sync.start()

    const subscribeCalls = mockSubscribe.mock.calls.length
    // Swap to the new handlers WITHOUT re-starting — the listener reads
    // this.handlers at call time so the newest callbacks take effect.
    sync.setHandlers(handlersB)
    // No re-subscribe occurred.
    expect(mockSubscribe.mock.calls.length).toBe(subscribeCalls)

    dispatchToSession(sid, {
      kind: 'permission-request',
      sessionId: sid,
      payload: { id: 'p1', kind: 'permission', toolName: 'Bash' },
    } as WsServerFrame)

    // The NEW handler received the callback, not the old one.
    expect(handlersB.onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
    )
    expect(handlersA.onRequest).not.toHaveBeenCalled()
    sync.stop()
  })
})
