import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { WsSubscribeResultReason } from '../ws-types'

// ── Mocks ──────────────────────────────────────────────────────────

type WsHubListener = (frame: Record<string, unknown>) => void

let currentSessionListeners: Map<string, Set<WsHubListener>>
let currentGlobalListeners: Set<WsHubListener>
const mockSubscribe = vi.fn(
  (
    _sessionId: string,
    _opts?: { force?: boolean },
  ) => vi.fn(),
)

// Stable hub object — returned on every useWsHub() call so the hook's
// useEffect (which depends on `[hub]`) doesn't re-run on every render.
const mockHub = {
  addListener: (fn: WsHubListener) => {
    currentGlobalListeners.add(fn)
    return () => { currentGlobalListeners.delete(fn) }
  },
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
vi.mock('./useApi', () => ({
  api: { get: (...args: unknown[]) => mockApiGet(...(args as [])), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}))

vi.mock('./useWsHub', () => ({
  useWsHub: () => mockHub,
  useWsHubStatus: () => 'online' as const,
}))

// Import AFTER mock so useChatStream picks up our stub.
import { useChatStream, cacheClear, type PermissionHandlers } from './useChatStream'
import { getSessionStore, useSessionField } from '../session-store/selectors'

/** `useChatStream` plus the live-turn telemetry it used to expose.
 *
 *  `tokenRate` / `activePhase` left ChatStream (the WorkingBubble leaf now
 *  subscribes to them directly, so Chat no longer re-renders per rate sample
 *  or phase change). The fields were always plain `useSessionField`
 *  subscriptions on the store this hook feeds, so reading them the same way
 *  here keeps every rate / phase assertion below testing exactly what it did:
 *  the value the hook's WS handling put in the store. */
function useChatStreamWithTelemetry(...args: Parameters<typeof useChatStream>) {
  const stream = useChatStream(...args)
  const tokenRate = useSessionField(args[0], 'tokenRate')
  const activePhase = useSessionField(args[0], 'activePhase')
  return { ...stream, tokenRate, activePhase }
}

// ── Helpers ────────────────────────────────────────────────────────

function dispatchToSession(sessionId: string, frame: Record<string, unknown>) {
  const set = currentSessionListeners.get(sessionId)
  if (!set) throw new Error(`No listeners for session ${sessionId}`)
  for (const fn of set) fn(frame)
}

/** The server's answer to one subscribe frame (see WsSubscribeResult). The
 *  reason is typed on the shared vocabulary so a renamed one can't pass. */
function subResult(
  sessionId: string,
  ok: boolean,
  reason: WsSubscribeResultReason,
): Record<string, unknown> {
  return { kind: 'subscribe-result', sessionId, ok, reason }
}

const noopPerms: PermissionHandlers = {
  onRequest: vi.fn(),
  onResolved: vi.fn(),
}

/** Seed the store's seq window directly (the seq-protocol equivalent of what
 *  a replay used to do): one WINDOW_PAGE tail dispatch through the real
 *  reducer, so replayReady flips and the windowed messages run the full
 *  applyMessage pipeline. */
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

// ── Tests ──────────────────────────────────────────────────────────

describe('useChatStream', () => {
  beforeEach(() => {
    currentSessionListeners = new Map()
    currentGlobalListeners = new Set()
    mockSubscribe.mockClear()
    mockApiGet.mockReset()
    mockApiGet.mockImplementation(async () => ({ ...emptyPage }))
    cacheClear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Terminated session ─────────────────────────────────────────

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

  it('sweeps a stranded sync subagent on a RELOADED terminated session', async () => {
    // The reload flow: on mount the store is empty and `terminated` is already
    // true, so a sweep at mount would no-op — the record only exists once the
    // tail page lands. Gating the dispatch on replayReady is what makes the
    // sweep hit the rebuilt record, and it also lets a windowed Agent
    // tool_result (whose merge needs status 'running') be applied BEFORE the
    // sweep.
    renderHook(() => useChatStream('term-reload', noopPerms, false, true))
    act(() => { seedSyncAgent('term-reload') })

    await waitFor(() => expect(subagentStatus('term-reload')).toBe('interrupted'))
  })

  it('sweeps a stranded sync subagent when a session terminates LIVE', async () => {
    // The common case: the transcript loaded while alive, then terminated. The
    // record is running first (the in-flight subagent) and must settle when
    // `terminated` flips — no result frame will ever arrive to do it.
    const { rerender } = renderHook(
      ({ terminated }: { terminated: boolean }) => useChatStream('term-live', noopPerms, false, terminated),
      { initialProps: { terminated: false } },
    )
    act(() => { seedSyncAgent('term-live') })
    await waitFor(() => expect(subagentStatus('term-live')).toBe('running'))

    rerender({ terminated: true })
    await waitFor(() => expect(subagentStatus('term-live')).toBe('interrupted'))
  })

  it('leaves a live session alone (terminated=false must not sweep)', async () => {
    // An in-flight sync subagent must keep running on a live session — its
    // output still arrives as the tool_result, and settling early would
    // swallow it.
    renderHook(() => useChatStream('term-alive', noopPerms, true, false))
    act(() => { seedSyncAgent('term-alive') })

    await waitFor(() => expect(subagentStatus('term-alive')).toBe('running'))
  })

  // ── Live messages ─────────────────────────────────────────────

  it('appends seq-less live messages through the legacy path', async () => {
    // Frames without seq/generation (pre-seq server, synthetic frames) keep
    // the legacy MESSAGE dispatch — no window engagement. Seq-carrying
    // frames take the WINDOW_LIVE path (covered in useChatStream.seq.test.ts).
    const { result } = renderHook(
      ({ sid }) => useChatStream(sid, noopPerms, false, false),
      { initialProps: { sid: 's3' } },
    )

    act(() => {
      dispatchToSession('s3', {
        kind: 'message',
        sessionId: 's3',
        message: { type: 'user', uuid: 'u1' },
      })
      dispatchToSession('s3', {
        kind: 'message',
        sessionId: 's3',
        message: { type: 'assistant', uuid: 'a1' },
      })
    })

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2)
    })
  })

  // ── Session switch reset ──────────────────────────────────────

  it('resets messages when sessionId changes', () => {
    const { result, rerender } = renderHook(
      ({ sid }) => useChatStreamWithTelemetry(sid, noopPerms, false, false),
      { initialProps: { sid: 's1' } },
    )

    // Add some messages to s1.
    act(() => {
      seedPage('s1', [{ seq: 0, msg: { type: 'user', uuid: 'u1' } }])
    })
    expect(result.current.messages).toHaveLength(1)

    // Switch to s2 — should reset.
    rerender({ sid: 's2' })
    expect(result.current.messages).toEqual([])
    expect(result.current.contextUsage).toBeNull()
    expect(result.current.tokenRate).toBeNull()
  })

  // ── Frame types ───────────────────────────────────────────────

  it('dispatches subscribe-time pending permission re-broadcasts to the handler', () => {
    // With replay retired, the server re-broadcasts still-outstanding
    // requests on subscribe as ordinary `permission-request` frames (the
    // reconnect recovery path for permission cards).
    const onRequest = vi.fn()
    const onResolved = vi.fn()
    renderHook(
      () => useChatStream('s1', { onRequest, onResolved }, false, false),
    )

    act(() => {
      dispatchToSession('s1', {
        kind: 'permission-request',
        sessionId: 's1',
        payload: { id: 'p1', kind: 'permission', toolName: 'Bash' },
      })
    })

    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', toolName: 'Bash' }),
    )
  })

  it('dispatches permission-resolved to handler', () => {
    const onResolved = vi.fn()
    renderHook(
      () => useChatStream('s1', { onRequest: vi.fn(), onResolved }, false, false),
    )

    act(() => {
      dispatchToSession('s1', {
        kind: 'permission-resolved',
        sessionId: 's1',
        id: 'p1',
        decision: { behavior: 'allow', persisted: false },
      })
    })

    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', behavior: 'allow' }),
    )
  })

  it('dispatches elicitation-request to handler', () => {
    const onElicitationRequest = vi.fn()
    renderHook(
      () => useChatStream('s1', { ...noopPerms, onElicitationRequest }, false, false),
    )

    act(() => {
      dispatchToSession('s1', {
        kind: 'elicitation-request',
        sessionId: 's1',
        payload: { id: 'e1', serverName: 'github', message: 'Sign in', mode: 'url', createdAt: 1 },
      })
    })

    expect(onElicitationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', serverName: 'github', mode: 'url' }),
    )
  })

  it('dispatches elicitation-resolved to handler', () => {
    const onElicitationResolved = vi.fn()
    renderHook(
      () => useChatStream('s1', { ...noopPerms, onElicitationResolved }, false, false),
    )

    act(() => {
      dispatchToSession('s1', {
        kind: 'elicitation-resolved',
        sessionId: 's1',
        id: 'e1',
        decision: { action: 'accept' },
      })
    })

    expect(onElicitationResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', decision: { action: 'accept' } }),
    )
  })

  it('updates context-usage', () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms, false, false),
    )

    act(() => {
      dispatchToSession('s1', {
        kind: 'context-usage',
        sessionId: 's1',
        usage: { totalTokens: 5000, maxTokens: 200000, percentage: 2.5 },
      })
    })

    expect(result.current.contextUsage).toEqual({
      totalTokens: 5000,
      maxTokens: 200000,
      percentage: 2.5,
    })
  })

  it('surfaces session-scope errors', () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms, false, false),
    )

    act(() => {
      dispatchToSession('s1', {
        kind: 'error',
        sessionId: 's1',
        message: 'Unknown session',
      })
    })

    expect(result.current.error).toBe('Unknown session')
  })

  it('clears error on clearError()', () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms, false, false),
    )

    act(() => {
      dispatchToSession('s1', {
        kind: 'error',
        sessionId: 's1',
        message: 'oops',
      })
    })
    expect(result.current.error).toBe('oops')

    act(() => {
      result.current.clearError()
    })
    expect(result.current.error).toBeNull()
  })

  // ── Token rate ────────────────────────────────────────────────

  it('computes token rate from stream_event message_delta', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    // Dispatch both message_delta events in a single act() so they hit the
    // same listener instance (startTransition between act blocks causes
    // the effect to re-run). The dateSpy mock is set up outside act so it's
    // active when the listener calls Date.now() (the reducer uses wall-clock
    // ms for rate timing, not performance.now()).
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(1000)

    act(() => {
      // First message_delta — lazily creates liveTurn (startedAt = 1000).
      // First real sample resets the window to [(1000, 50)]; with a single
      // sample there's no rate yet.
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 50 } },
        },
      })
      // Second message_delta — window-incremental semantics: token delta
      // (120-50) over 0.6s = 116.67, rounded to 117 tok/s.
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 120 } },
        },
      })
    })

    // setTokenRate is called outside startTransition so it's a sync
    // state update, but React may batch it with the transition flush.
    await waitFor(() => {
      expect(result.current.tokenRate).toBe(117)
    })
  })

  // ── Phase mirror ──────────────────────────────────────────────

  it('sidechain content_block_start events do not flip the top-level phase', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    act(() => {
      // Top-level tool_use block start — the parent turn enters its
      // tool_use phase (this is what the Composer Background morph and the
      // WorkingBubble label key off).
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Task' } },
        },
      })
      // The subagent's own sidechain stream (parent_tool_use_id set): its
      // thinking and text block starts must NOT clobber the parent phase —
      // for the whole subagent run the parent is parked in tool_use.
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          parent_tool_use_id: 'toolu_01',
          event: { type: 'content_block_start', content_block: { type: 'thinking' } },
        },
      })
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          parent_tool_use_id: 'toolu_01',
          event: { type: 'content_block_start', content_block: { type: 'text' } },
        },
      })
    })

    await waitFor(() => {
      expect(result.current.activePhase).toEqual({ type: 'tool_use', name: 'Task' })
    })
  })

  it('exposes only hasActivePhase: phase transitions inside a turn do not re-render the host', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms, false, false),
    )
    const blockStart = (content_block: Record<string, unknown>) => ({
      kind: 'message',
      sessionId: 's1',
      message: { type: 'stream_event', event: { type: 'content_block_start', content_block } },
    })

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
    })
    expect(result.current.hasActivePhase).toBe(false)

    act(() => { dispatchToSession('s1', blockStart({ type: 'thinking' })) })
    await waitFor(() => expect(result.current.hasActivePhase).toBe(true))

    // thinking → writing → tool_use: the store's activePhase changes three
    // times, the boolean never does — so the hook's host (Chat) is not
    // re-rendered and hands back the very same stream object.
    const during = result.current
    act(() => {
      dispatchToSession('s1', blockStart({ type: 'text' }))
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } },
      })
      dispatchToSession('s1', blockStart({ type: 'tool_use', name: 'Bash' }))
    })
    expect(getSessionStore('s1').getSnapshot().activePhase).toEqual({ type: 'tool_use', name: 'Bash' })
    expect(result.current).toBe(during)

    // The turn ends → false.
    act(() => {
      dispatchToSession('s1', { kind: 'message', sessionId: 's1', message: { type: 'result', uuid: 'r-phase' } })
    })
    await waitFor(() => expect(result.current.hasActivePhase).toBe(false))
  })

  it('sidechain text starts seed the char-estimate rate without flipping the parent phase', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      // Parent turn: straight to a tool_use (Task) with NO top-level text
      // block — the shape that used to freeze the tok/s readout for the
      // whole subagent run once the phase gate landed (nothing ever seeded
      // writingStartedAt, so every child delta failed the sample gate).
      dateSpy.mockReturnValue(1000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Task' } },
        },
      })
      // The subagent's sidechain text start: seeds writingStartedAt (the
      // delta branch's sample gate) but must NOT flip the parent phase.
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          parent_tool_use_id: 'toolu_01',
          event: { type: 'content_block_start', content_block: { type: 'text' } },
        },
      })
      // Child delta at t=1000: inside the 500ms throttle → no sample yet.
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          parent_tool_use_id: 'toolu_01',
          event: { type: 'content_block_delta', delta: { text: 'a'.repeat(40) } },
        },
      })
      // t=1600: 400 chars → round(400/4) = 100 estimated tokens → first sample.
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          parent_tool_use_id: 'toolu_01',
          event: { type: 'content_block_delta', delta: { text: 'b'.repeat(360) } },
        },
      })
      // t=2200: 800 chars → 200 estimated tokens → second sample →
      // window rate (200-100)/0.6 = 166.7 → 167.
      dateSpy.mockReturnValue(2200)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          parent_tool_use_id: 'toolu_01',
          event: { type: 'content_block_delta', delta: { text: 'c'.repeat(400) } },
        },
      })
    })

    await waitFor(() => {
      // Parent phase never left tool_use…
      expect(result.current.activePhase).toEqual({ type: 'tool_use', name: 'Task' })
      // …and the tok/s readout stayed live from the child's text flow.
      expect(result.current.tokenRate).toBe(167)
    })
  })

  it('resets token rate on result (message_stop clears baseline)', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(1000)

    // All dispatches in one act to keep the same listener instance.
    // message_stop clears outputTokens; result clears tokenRate entirely
    // (and nulls the mirror's liveTurn).
    act(() => {
      // Establish baseline (startedAt = 1000, elapsed 0, no rate yet).
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 10 } },
        },
      })
      // Window-incremental: token delta (120-10) over 0.6s = 183.33 →
      // 183 tok/s (only the final `result`-clears-null is asserted here).
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 120 } },
        },
      })
      // message_stop clears outputTokens but NOT the displayed rate.
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_stop' },
        },
      })
      // result message clears everything (tokenRate + liveTurn).
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'result', uuid: 'r1' },
      })
    })

    // Final state: tokenRate is null after result clears it.
    await waitFor(() => {
      expect(result.current.tokenRate).toBeNull()
    })
  })

  it('char-fallback rate uses the sliding window with the 500ms throttle', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      // Writing phase starts (liveTurn lazily created at t=0).
      dateSpy.mockReturnValue(0)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'text' } },
        },
      })

      // First char delta at t=100 — only 100ms after liveTurn creation, so
      // it's inside the throttle window: no sample pushed, no rate.
      dateSpy.mockReturnValue(100)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { text: 'aaaa' } },
        },
      })

      // t=600: past the throttle (600-0 ≥ 500), estimated = round(8/4) = 2
      // tokens > 0 → first sample (600, 2).
      dateSpy.mockReturnValue(600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { text: 'aaaa' } },
        },
      })

      // t=1200: second sample (1200, 3) → window rate (3-2)/0.6 = 1.67 → 2.
      dateSpy.mockReturnValue(1200)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { text: 'aaaa' } },
        },
      })

      // t=1300: only 100ms after the last push → throttled, no new sample.
      // If the throttle were broken the rate would jump to 3 — the final
      // assertion distinguishes the two.
      dateSpy.mockReturnValue(1300)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { text: 'aaaa' } },
        },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(2)
    })
  })

  it('freezes the displayed rate across a long idle (tool-call gap)', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      // Two real deltas establish a rate of 117 tok/s.
      dateSpy.mockReturnValue(1000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } },
      })
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })

      // Long tool gap: 30s later a tool_use block starts, but no text or
      // message_delta → no samples pushed → rate must stay frozen.
      dateSpy.mockReturnValue(31000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
        },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(117)
    })
  })

  it('recomputes from fresh samples after a long idle (pre-idle samples pruned)', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      // Establish 117 tok/s.
      dateSpy.mockReturnValue(1000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } },
      })
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })

      // 10s idle (> RATE_WINDOW_MS). First post-idle delta: the window prunes
      // the pre-idle samples; with a single fresh sample the rate keeps the
      // frozen 117.
      dateSpy.mockReturnValue(11000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })
      // Second post-idle delta at +0.5s: rate recomputes from the two fresh
      // samples only: (200-120)/0.5 = 160 tok/s.
      dateSpy.mockReturnValue(11500)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 200 } } },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(160)
    })
  })

  it('estimate→real seam: first real delta resets the window and keeps the displayed value', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      // Char samples establish an estimated rate of 2 tok/s.
      dateSpy.mockReturnValue(0)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
      dateSpy.mockReturnValue(600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'aaaa' } } },
      })
      dateSpy.mockReturnValue(1200)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'aaaa' } } },
      })

      // First REAL delta: resets the window, keeps the displayed 2.
      dateSpy.mockReturnValue(1800)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 100 } } },
      })
    })

    // The seam itself: one real sample exists, displayed value still 2.
    await waitFor(() => {
      expect(result.current.tokenRate).toBe(2)
    })

    // Next real delta: recomputes from real counts only: (160-100)/0.6 = 100.
    dateSpy.mockReturnValue(2400)
    act(() => {
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 160 } } },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(100)
    })
  })

  it('keeps the frozen rate when post-idle deltas report no token growth', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      // Establish 117 tok/s.
      dateSpy.mockReturnValue(1000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } },
      })
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })

      // 10s idle. First post-idle delta reports the same cumulative count
      // (no new output during the gap): window pruned to a single sample,
      // rate keeps 117.
      dateSpy.mockReturnValue(11000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })
      // Second post-idle delta, still no growth (Δtokens = 0): rate keeps 117.
      dateSpy.mockReturnValue(11500)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(117)
    })
  })

  // ── reset ─────────────────────────────────────────────────────

  it('resets all state on reset()', async () => {
    const { result } = renderHook(
      () => useChatStreamWithTelemetry('s1', noopPerms, false, false),
    )

    // Populate state.
    act(() => {
      seedPage('s1', [{ seq: 0, msg: { type: 'user', uuid: 'u1' } }])
      dispatchToSession('s1', {
        kind: 'context-usage',
        sessionId: 's1',
        usage: { totalTokens: 1000 },
      })
      dispatchToSession('s1', {
        kind: 'error',
        sessionId: 's1',
        message: 'test error',
      })
    })

    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.contextUsage).not.toBeNull()

    act(() => {
      result.current.reset()
    })

    expect(result.current.messages).toEqual([])
    expect(result.current.contextUsage).toBeNull()
    expect(result.current.tokenRate).toBeNull()
    expect(result.current.error).toBeNull()
    // reset() shares the /clear wipe semantic: the post-reset state is live
    // and empty with no pending page, so replayReady must be true —
    // otherwise MessageList sits on the skeleton (the /clear stuck-skeleton
    // bug, which reset() would silently reintroduce if it diverged).
    expect(result.current.replayReady).toBe(true)
  })

  // ── session-cleared ───────────────────────────────────────────

  it('wipes transcript + state on a session-cleared frame and re-anchors the generation', async () => {
    // Post-clear, the server's transcript store has bumped its generation;
    // the refetch the handler fires must carry the NEW generation (a page
    // read before the clear carries pre-clear content and is discarded —
    // covered by the stale-page retry test in useChatStream.seq.test.ts).
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms, false, false),
    )
    act(() => {
      seedPage('s1', [
        { seq: 0, msg: { type: 'user', uuid: 'u1' } },
        { seq: 1, msg: { type: 'assistant', uuid: 'a1' } },
      ])
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(2))

    // The post-clear tail page: empty, generation 1.
    mockApiGet.mockImplementation(async () => ({
      generation: 1,
      headSeq: 0,
      totalCount: 0,
      startIndex: 0,
      hasMore: false,
      messages: [],
    }))

    // Backend confirms /clear — the transcript should reset.
    act(() => {
      dispatchToSession('s1', { kind: 'session-cleared', sessionId: 's1' })
    })

    await waitFor(() => {
      expect(result.current.messages).toEqual([])
      expect(getSessionStore('s1').getSnapshot().generation).toBe(1)
    })
    // hasOlder flips false: the window is empty and the post-clear page
    // reported nothing older — the cleared transcript can't be paged back.
    expect(result.current.hasOlder).toBe(false)
  })

  it('marks the transcript ready after a session-cleared frame (no stuck skeleton)', async () => {
    // Regression: /clear resets the store, but the post-clear session is
    // live and empty. There is no pending page — the WS subscription
    // persists across clear (no re-subscribe), the server doesn't re-replay,
    // and the fresh Query's system/init is NOT broadcast to clients. So
    // replayReady MUST flip true on session-cleared, otherwise MessageList
    // shows an infinite skeleton until the user sends a message.
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms, false, false),
    )

    // Populate + ready the transcript first.
    act(() => {
      seedPage('s1', [{ seq: 0, msg: { type: 'user', uuid: 'u1' } }])
    })
    await waitFor(() => expect(result.current.replayReady).toBe(true))

    mockApiGet.mockImplementation(async () => ({
      generation: 1,
      headSeq: 0,
      totalCount: 0,
      startIndex: 0,
      hasMore: false,
      messages: [],
    }))
    act(() => {
      dispatchToSession('s1', { kind: 'session-cleared', sessionId: 's1' })
    })

    await waitFor(() => expect(result.current.messages).toEqual([]))
    expect(result.current.replayReady).toBe(true)
  })

  // ── subscribe/unsubscribe lifecycle ──────────────────────────

  it('subscribes to hub on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(
      () => useChatStream('s1', noopPerms, false, false),
    )

    // `force` because this listener needs the channel established for
    // itself — the attached handshake (subscribe-result + attached) is the
    // reconnect catch-up trigger. No replay cursor: content comes from the
    // REST tail page.
    expect(mockSubscribe).toHaveBeenCalledWith('s1', { force: true })

    const cleanupFn = mockSubscribe.mock.results[0].value
    expect(cleanupFn).not.toHaveBeenCalled()

    unmount()
    expect(cleanupFn).toHaveBeenCalled()
  })

  it('fetches the transcript tail page on mount', async () => {
    renderHook(() => useChatStream('s1', noopPerms, false, false))

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/sessions/s1/messages?limit=200')
    })
  })

  // ── channel state (dormant / slept blank-transcript fix) ─────────────

  it('forces the channel on every effect run, including each running flip', () => {
    // The mount itself has to force — the channel may already be live (another
    // consumer subscribed first, or the resume landed before this listener
    // existed), and a confirmed channel would otherwise suppress the attached
    // handshake and leave the transcript blank. The false→true flip forces
    // for the same reason (a channel that went dormant is gone). One
    // mechanism, no "did this instance observe the transition" bookkeeping.
    const { rerender } = renderHook(
      ({ running }) => useChatStream('s1', noopPerms, running, false),
      { initialProps: { running: false } },
    )
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).toHaveBeenLastCalledWith('s1', { force: true })

    // Resume completes → running flips true → the effect re-runs and asks
    // again, so the server re-answers with attached (the catch-up trigger)
    // and the tail page refetches over anything missed while dormant.
    rerender({ running: true })
    expect(mockSubscribe).toHaveBeenCalledTimes(2)
    expect(mockSubscribe).toHaveBeenLastCalledWith('s1', { force: true })
  })

  it('clears a stale channel error only when the server confirms the channel', () => {
    const { result } = renderHook(() => useChatStream('s1', noopPerms, false, false))

    act(() => {
      dispatchToSession('s1', { kind: 'error', sessionId: 's1', message: 'session not loaded' })
    })
    expect(result.current.error).toBe('session not loaded')

    // A refusal keeps the band: the state frame says the same thing.
    act(() => {
      dispatchToSession('s1', subResult('s1', false, 'refused'))
    })
    expect(result.current.error).toBe('session not loaded')

    // Being served does clear it — intent.error survives every server-frame
    // handler, so nothing else would clear it on a healed panel.
    act(() => {
      dispatchToSession('s1', subResult('s1', true, 'served'))
    })
    expect(result.current.error).toBeNull()
  })
})

// ── transcriptSettling (pinned-header freeze signal) ─────────────────

describe('transcriptSettling', () => {
  // The signal freezes MessageList's pinned "current question" notification
  // while the transcript is still settling. Its lifecycle has exactly one
  // settle point under the seq protocol: the tail page landing. The old
  // burst-drain windows (tail-first backfill, IDB cold-load) are gone with
  // the replay machinery.
  const sid = 'settling-sid'
  const userMsg = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }

  // Outside the sibling describe's beforeEach scope — initialize the shared
  // mock-hub state here too.
  beforeEach(() => {
    currentSessionListeners = new Map()
    currentGlobalListeners = new Set()
    mockSubscribe.mockClear()
    mockApiGet.mockReset()
    mockApiGet.mockImplementation(async () => ({ ...emptyPage }))
    cacheClear()
    vi.clearAllMocks()
  })

  const waitListening = () =>
    waitFor(() => expect(currentSessionListeners.has(sid)).toBe(true))

  it('is true before the tail page lands', () => {
    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    // Asserted synchronously: the mount's tail fetch resolves on a
    // microtask, so any await would let the (empty) page land and flip the
    // flag before the assertion.
    expect(result.current.transcriptSettling).toBe(true)
  })

  it('closes once the tail page lands', async () => {
    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    await waitListening()
    act(() => {
      seedPage(sid, [{ seq: 0, msg: userMsg }])
    })
    await waitFor(() => expect(result.current.transcriptSettling).toBe(false))
    expect(result.current.messages).toHaveLength(1)
  })

  it('closes on an error frame before any page (forced ready, no stuck skeleton)', async () => {
    const { result } = renderHook(() => useChatStream(sid, noopPerms, false, false))
    // Same synchronous assertion as above — the empty tail page must not
    // have landed yet.
    expect(result.current.transcriptSettling).toBe(true)
    act(() => {
      dispatchToSession(sid, { kind: 'error', sessionId: sid, message: 'boom' })
    })
    await waitFor(() => expect(result.current.transcriptSettling).toBe(false))
    expect(result.current.error).toBe('boom')
  })
})
