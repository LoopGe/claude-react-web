import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ── Mocks ──────────────────────────────────────────────────────────

type WsHubListener = (frame: Record<string, unknown>) => void

let currentSessionListeners: Map<string, Set<WsHubListener>>
let currentGlobalListeners: Set<WsHubListener>
const mockSubscribe = vi.fn((_sessionId: string, _sinceUuid?: string) => vi.fn())
const mockSetLastMessageUuid = vi.fn()

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
  setLastMessageUuid: mockSetLastMessageUuid,
}

vi.mock('./useWsHub', () => ({
  useWsHub: () => mockHub,
  useWsHubStatus: () => 'online' as const,
}))

// Import AFTER mock so useChatStream picks up our stub.
import { useChatStream, cacheClear, type PermissionHandlers } from './useChatStream'

// ── Helpers ────────────────────────────────────────────────────────

function dispatchToSession(sessionId: string, frame: Record<string, unknown>) {
  const set = currentSessionListeners.get(sessionId)
  if (!set) throw new Error(`No listeners for session ${sessionId}`)
  for (const fn of set) fn(frame)
}

const noopPerms: PermissionHandlers = {
  onRequest: vi.fn(),
  onResolved: vi.fn(),
}

// ── Tests ──────────────────────────────────────────────────────────

describe('useChatStream', () => {
  beforeEach(() => {
    currentSessionListeners = new Map()
    currentGlobalListeners = new Set()
    mockSubscribe.mockClear()
    mockSetLastMessageUuid.mockClear()
    cacheClear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Replay buffering ──────────────────────────────────────────

  it('buffers replay messages and applies on replay-done', async () => {
    const { result } = renderHook(
      ({ sid }) => useChatStream(sid, noopPerms),
      { initialProps: { sid: 's1' } },
    )

    expect(result.current.messages).toEqual([])

    // Dispatch replay + replay-done in a single act() so they hit the
    // same listener instance (startTransition between act blocks causes
    // the effect to re-run, resetting the local replayDone flag).
    act(() => {
      dispatchToSession('s1', {
        kind: 'replay',
        sessionId: 's1',
        messages: [
          { type: 'user', message: { content: 'hello' } },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        ],
      })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
    })

    // startTransition defers the setMessages; use waitFor.
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2)
    })
  })

  it('queues live messages until replay-done, then flushes', async () => {
    const { result } = renderHook(
      ({ sid }) => useChatStream(sid, noopPerms),
      { initialProps: { sid: 's2' } },
    )

    // Dispatch replay + live message (queued) + replay-done (flushes)
    // all in one act() to keep the same listener instance.
    act(() => {
      dispatchToSession('s2', {
        kind: 'replay',
        sessionId: 's2',
        messages: [{ type: 'user', uuid: 'u1' }],
      })
      // Live message arrives before replay-done — queued in `pending`.
      dispatchToSession('s2', {
        kind: 'message',
        sessionId: 's2',
        message: { type: 'assistant', uuid: 'a1' },
      })
      // replay-done flushes the pending live message.
      dispatchToSession('s2', { kind: 'replay-done', sessionId: 's2' })
    })

    // startTransition defers the update; wait for it.
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2)
    })
  })

  it('appends live messages after replay is done', async () => {
    const { result } = renderHook(
      ({ sid }) => useChatStream(sid, noopPerms),
      { initialProps: { sid: 's3' } },
    )

    // Complete replay + send two live messages, all in one act().
    act(() => {
      dispatchToSession('s3', { kind: 'replay', sessionId: 's3', messages: [] })
      dispatchToSession('s3', { kind: 'replay-done', sessionId: 's3' })
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

    // startTransition defers all setMessages calls; wait for them.
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2)
    })
  })

  // ── Session switch reset ──────────────────────────────────────

  it('resets messages when sessionId changes', () => {
    const { result, rerender } = renderHook(
      ({ sid }) => useChatStream(sid, noopPerms),
      { initialProps: { sid: 's1' } },
    )

    // Add some messages to s1.
    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [{ type: 'user', uuid: 'u1' }] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
    })
    expect(result.current.messages).toHaveLength(1)

    // Switch to s2 — should reset.
    rerender({ sid: 's2' })
    expect(result.current.messages).toEqual([])
    expect(result.current.contextUsage).toBeNull()
    expect(result.current.tokenRate).toBeNull()
  })

  // ── Frame types ───────────────────────────────────────────────

  it('dispatches permission-request to handler', () => {
    const onRequest = vi.fn()
    const onResolved = vi.fn()
    renderHook(
      () => useChatStream('s1', { onRequest, onResolved }),
    )

    act(() => {
      dispatchToSession('s1', {
        kind: 'replay',
        sessionId: 's1',
        messages: [],
        permissions: [{ id: 'p1', kind: 'permission', toolName: 'Bash' }],
      })
    })

    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', toolName: 'Bash' }),
    )
  })

  it('dispatches permission-resolved to handler', () => {
    const onResolved = vi.fn()
    renderHook(
      () => useChatStream('s1', { onRequest: vi.fn(), onResolved }),
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

  it('updates context-usage', () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
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
      () => useChatStream('s1', noopPerms),
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
      () => useChatStream('s1', noopPerms),
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
      () => useChatStream('s1', noopPerms),
    )

    // Dispatch replay + replay-done + both message_delta events all in a
    // single act() so they hit the SAME listener instance (before React
    // re-renders and re-runs the effect, which resets the local replayDone
    // flag). The perfSpy mock is set up outside act so it's active when
    // the listener calls performance.now().
    const perfSpy = vi.spyOn(performance, 'now')
    perfSpy.mockReturnValue(1000)

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
      // First message_delta — establishes baseline, no rate yet.
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 50 } },
        },
      })
      // Second message_delta — 100 tokens in 500ms = 200 tok/s.
      perfSpy.mockReturnValue(1500)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 150 } },
        },
      })
    })

    // setTokenRate is called outside startTransition so it's a sync
    // state update, but React may batch it with the transition flush.
    await waitFor(() => {
      expect(result.current.tokenRate).toBe(200)
    })
  })

  it('resets token rate on result (message_stop clears baseline)', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    const perfSpy = vi.spyOn(performance, 'now')
    perfSpy.mockReturnValue(0)

    // All dispatches in one act to keep the same listener instance.
    // message_stop clears the baseline ref; result clears tokenRate entirely.
    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
      // Establish baseline.
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 10 } },
        },
      })
      // Compute rate: 100 tokens in 500ms = 200 tok/s.
      perfSpy.mockReturnValue(500)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 110 } },
        },
      })
      // message_stop clears the baseline ref but NOT the displayed rate.
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_stop' },
        },
      })
      // result message clears everything (tokenRate + ref).
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

  // ── reset ─────────────────────────────────────────────────────

  it('resets all state on reset()', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    // Populate state.
    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [{ type: 'user', uuid: 'u1' }] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
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

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.contextUsage).not.toBeNull()

    act(() => {
      result.current.reset()
    })

    expect(result.current.messages).toEqual([])
    expect(result.current.contextUsage).toBeNull()
    expect(result.current.tokenRate).toBeNull()
    expect(result.current.error).toBeNull()
  })

  // ── session-cleared ───────────────────────────────────────────

  it('wipes transcript + state on a session-cleared frame', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    // Populate the transcript.
    act(() => {
      dispatchToSession('s1', {
        kind: 'replay',
        sessionId: 's1',
        messages: [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }],
      })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
    })
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2)
    })

    // Backend confirms /clear — the transcript should reset.
    act(() => {
      dispatchToSession('s1', { kind: 'session-cleared', sessionId: 's1' })
    })

    await waitFor(() => {
      expect(result.current.messages).toEqual([])
    })
    // hasOlder flips false so the cleared transcript can't be paged back.
    expect(result.current.hasOlder).toBe(false)
  })

  it('does not resurrect old messages from a replay after a clear', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [{ type: 'user', uuid: 'u1' }] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    // Clear, then a fresh (empty) replay arrives — as the server now sends
    // after truncating its ring. The transcript stays empty.
    act(() => {
      dispatchToSession('s1', { kind: 'session-cleared', sessionId: 's1' })
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
    })
    await waitFor(() => expect(result.current.messages).toEqual([]))
  })

  it('drops a pre-clear replay that raced ahead (clear lands mid-replay)', async () => {
    // Race: a reconnect's `replay` (built BEFORE the server truncated its
    // ring, so it carries pre-clear messages) arrives, then `session-cleared`
    // lands, then `replay-done`. Without the mid-replay guard, replay-done's
    // REPLAY_REPLACE would re-apply the buffered pre-clear messages on top of
    // the reset store and resurrect the cleared transcript.
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    act(() => {
      // Stale replay opens (buffered, not yet applied)...
      dispatchToSession('s1', {
        kind: 'replay',
        sessionId: 's1',
        messages: [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }],
      })
      // ...clear confirmation races in BEFORE replay-done...
      dispatchToSession('s1', { kind: 'session-cleared', sessionId: 's1' })
      // ...and the (now-stale) replay-done arrives.
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
    })

    // The pre-clear messages must NOT be resurrected.
    await waitFor(() => expect(result.current.messages).toEqual([]))
    expect(result.current.hasOlder).toBe(false)
  })

  // ── subscribe/unsubscribe lifecycle ──────────────────────────

  it('subscribes to hub on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    expect(mockSubscribe).toHaveBeenCalledWith('s1', undefined)

    const cleanupFn = mockSubscribe.mock.results[0].value
    expect(cleanupFn).not.toHaveBeenCalled()

    unmount()
    expect(cleanupFn).toHaveBeenCalled()
  })
})
