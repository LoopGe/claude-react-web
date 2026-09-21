import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { WsSubscribeResultReason } from '../ws-types'

// ── Mocks ──────────────────────────────────────────────────────────

type WsHubListener = (frame: Record<string, unknown>) => void

let currentSessionListeners: Map<string, Set<WsHubListener>>
let currentGlobalListeners: Set<WsHubListener>
const mockSubscribe = vi.fn(
  (_sessionId: string, _sinceUuid?: string, _opts?: { force?: boolean; replayMode?: 'tail-backfill' }) =>
    vi.fn(),
)
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
import { getSessionStore } from '../session-store/selectors'

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

  // ── Terminated session ─────────────────────────────────────────

  const syncAgentFrame = {
    type: 'assistant',
    uuid: 'a-sync',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_term', name: 'Agent', input: { description: 'sync work' } }],
    },
  }
  const replaySyncAgent = (sid: string) => {
    dispatchToSession(sid, { kind: 'replay', sessionId: sid, messages: [syncAgentFrame] })
    dispatchToSession(sid, { kind: 'replay-done', sessionId: sid })
  }
  const subagentStatus = (sid: string) =>
    getSessionStore(sid).getState().mirror.activeSubagents.get('tu_term')?.status

  it('sweeps a stranded sync subagent on a RELOADED terminated session', async () => {
    // The reload flow: on mount the store is empty and `terminated` is already
    // true, so a sweep at mount would no-op — the record only exists once the
    // replay lands. Gating the dispatch on replayReady is what makes the sweep
    // hit the rebuilt record, and it also lets a replayed Agent tool_result
    // (whose merge needs status 'running') be applied BEFORE the sweep.
    renderHook(() => useChatStream('term-reload', noopPerms, false, true))
    act(() => { replaySyncAgent('term-reload') })

    await waitFor(() => expect(subagentStatus('term-reload')).toBe('interrupted'))
  })

  it('sweeps a stranded sync subagent when a session terminates LIVE', async () => {
    // The common case: the session replayed while alive, then terminated. The
    // record is running first (the in-flight subagent) and must settle when
    // `terminated` flips — no result frame will ever arrive to do it.
    const { rerender } = renderHook(
      ({ terminated }: { terminated: boolean }) => useChatStream('term-live', noopPerms, false, terminated),
      { initialProps: { terminated: false } },
    )
    act(() => { replaySyncAgent('term-live') })
    await waitFor(() => expect(subagentStatus('term-live')).toBe('running'))

    rerender({ terminated: true })
    await waitFor(() => expect(subagentStatus('term-live')).toBe('interrupted'))
  })

  it('leaves a live session alone (terminated=false must not sweep)', async () => {
    // An in-flight sync subagent must keep running on a live session — its
    // output still arrives as the tool_result, and settling early would
    // swallow it.
    renderHook(() => useChatStream('term-alive', noopPerms, true, false))
    act(() => { replaySyncAgent('term-alive') })

    await waitFor(() => expect(subagentStatus('term-alive')).toBe('running'))
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

  // ── Tail-first replay + background backfill ───────────────────
  //
  // The no-cache cold-start path: the server sends ONE tail frame
  // (newest 50, `tail: true`) followed by backfill frames (`backfill:
  // true`, newest→oldest) and a final replay-done. The tail must
  // render immediately (no waiting for the backfill to drain), and
  // each backfill frame must PREPEND above what's already on screen.

  it('applies a tail replay frame immediately (renders before replay-done)', async () => {
    const { result } = renderHook(
      () => useChatStream('tail1', noopPerms),
    )

    // ONLY the tail frame dispatches — no replay-done yet. The old
    // buffered path would still show an empty transcript here.
    act(() => {
      dispatchToSession('tail1', {
        kind: 'replay',
        sessionId: 'tail1',
        tail: true,
        messages: [
          { type: 'user', uuid: 'u1' },
          { type: 'assistant', uuid: 'a1' },
        ],
      })
    })

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2)
    })
    expect(result.current.replayReady).toBe(true)
  })

  it('prepends backfill frames above the tail, newest chunk first', async () => {
    const { result } = renderHook(
      () => useChatStream('tail2', noopPerms),
    )

    act(() => {
      // Tail: the newest message.
      dispatchToSession('tail2', {
        kind: 'replay',
        sessionId: 'tail2',
        tail: true,
        messages: [{ type: 'assistant', uuid: 'tail-msg' }],
      })
      // Backfill chunk 1 (newer of the two older chunks).
      dispatchToSession('tail2', {
        kind: 'replay',
        sessionId: 'tail2',
        backfill: true,
        messages: [{ type: 'assistant', uuid: 'older-2' }],
      })
      // Backfill chunk 2 (oldest).
      dispatchToSession('tail2', {
        kind: 'replay',
        sessionId: 'tail2',
        backfill: true,
        messages: [{ type: 'assistant', uuid: 'older-1' }],
      })
      dispatchToSession('tail2', { kind: 'replay-done', sessionId: 'tail2' })
    })

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(3)
    })
    // Chronological order: oldest first, tail last.
    expect(result.current.messages.map((m) => (m as { uuid?: string }).uuid))
      .toEqual(['older-1', 'older-2', 'tail-msg'])
  })

  it('applies the permissions snapshot carried by the tail frame (first paint)', async () => {
    const perm = {
      kind: 'permission',
      id: 'p1',
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseID: 'toolu_1',
      createdAt: 1,
    }
    const { result } = renderHook(
      () => useChatStream('tail3', noopPerms),
    )

    // The snapshots ride the tail frame itself (same shape as the ordinary
    // single-frame replay), NOT the terminator — so a pending permission
    // card appears with the first paint, before the backfill drains.
    act(() => {
      dispatchToSession('tail3', {
        kind: 'replay',
        sessionId: 'tail3',
        tail: true,
        messages: [{ type: 'assistant', uuid: 'a1' }],
        permissions: [perm],
      })
    })

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1)
    })
    const state = getSessionStore('tail3').getState()
    expect(state.mirror.permissionPending.get('p1')).toBeDefined()
  })

  it('does not advance the reconnect anchor until the burst completes', async () => {
    const { result } = renderHook(
      () => useChatStream('tail5', noopPerms),
    )

    act(() => {
      dispatchToSession('tail5', {
        kind: 'replay',
        sessionId: 'tail5',
        tail: true,
        messages: [{ type: 'assistant', uuid: 'a1' }],
      })
      // A live message lands mid-burst — it must NOT advance the anchor
      // either (an anchor set mid-burst would make a disconnect resume
      // strictly-after the tail and skip the unsent backfill).
      dispatchToSession('tail5', {
        kind: 'message',
        sessionId: 'tail5',
        message: { type: 'assistant', uuid: 'live-1' },
      })
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    expect(mockSetLastMessageUuid).not.toHaveBeenCalled()

    // Burst terminator: NOW the anchor may advance.
    act(() => {
      dispatchToSession('tail5', { kind: 'replay-done', sessionId: 'tail5' })
    })
    await waitFor(() => expect(mockSetLastMessageUuid).toHaveBeenCalled())
  })

  it('keeps suppressing the anchor when the effect re-runs mid-burst', async () => {
    // The burst's tail frame is applied by closure 1; a `running` flip then
    // tears the effect down and closure 2 (tailMode=false) re-subscribes.
    // The store now carries the tail's uuid, so without the cross-closure
    // burst ref the re-subscribe would send it as `sinceUuid` and the
    // server would skip the still-unsent backfill chunks.
    const { rerender } = renderHook(
      ({ running }) => useChatStream('tail7', noopPerms, running),
      { initialProps: { running: false } },
    )

    act(() => {
      dispatchToSession('tail7', {
        kind: 'replay',
        sessionId: 'tail7',
        tail: true,
        messages: [{ type: 'assistant', uuid: 'a1' }],
      })
    })
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled())
    mockSubscribe.mockClear()

    // Mid-burst effect re-run: running flips false→true → the effect
    // re-subscribes, and the burst is still open.
    rerender({ running: true })

    // The re-subscribe must NOT carry the tail's uuid as a cursor: that
    // would make the server resume strictly after the tail and never send
    // the still-unsent backfill chunks.
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).toHaveBeenLastCalledWith('tail7', undefined, {
      force: true,
      replayMode: 'tail-backfill',
    })

    // Burst completes → the anchor is allowed to advance again.
    act(() => {
      dispatchToSession('tail7', { kind: 'replay-done', sessionId: 'tail7' })
    })
    await waitFor(() => expect(mockSetLastMessageUuid).toHaveBeenCalled())
  })

  it('recovers when a reconnect interrupts the burst (ordinary burst after tail)', async () => {
    // Race: the tail frame lands, the socket drops mid-backfill, and the
    // reconnect re-subscribes WITH a sinceUuid — the server then serves an
    // ordinary (unmarked) incremental burst. The ordinary burst must reset
    // the tailMode latch; otherwise replay-done takes the tailMode branch
    // and silently drops the buffered incremental messages.
    const { result } = renderHook(
      () => useChatStream('tail6', noopPerms),
    )

    act(() => {
      // Tail frame lands (burst opens)...
      dispatchToSession('tail6', {
        kind: 'replay',
        sessionId: 'tail6',
        tail: true,
        messages: [{ type: 'assistant', uuid: 'tail-msg' }],
      })
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    // ...socket drops mid-burst, reconnect re-subscribes with an anchor,
    // and the server answers with an ordinary chunked burst.
    act(() => {
      dispatchToSession('tail6', {
        kind: 'replay',
        sessionId: 'tail6',
        messages: [
          { type: 'assistant', uuid: 'gap-1' },
          { type: 'assistant', uuid: 'gap-2' },
        ],
      })
      dispatchToSession('tail6', { kind: 'replay-done', sessionId: 'tail6' })
    })

    // The reconnect's messages must be applied (REPLAY_REPLACE merge
    // appends them after the tail), not dropped by a stale tailMode latch.
    await waitFor(() => {
      expect(result.current.messages.map((m) => (m as { uuid?: string }).uuid))
        .toEqual(['tail-msg', 'gap-1', 'gap-2'])
    })
  })

  it('ignores backfill frames that race in after a session-cleared', async () => {
    const { result } = renderHook(
      () => useChatStream('tail4', noopPerms),
    )

    act(() => {
      dispatchToSession('tail4', {
        kind: 'replay',
        sessionId: 'tail4',
        tail: true,
        messages: [{ type: 'assistant', uuid: 'a1' }],
      })
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    // /clear confirmation lands mid-backfill; the stale backfill frames
    // (built from the pre-clear ring) must not resurrect the transcript.
    act(() => {
      dispatchToSession('tail4', { kind: 'session-cleared', sessionId: 'tail4' })
      dispatchToSession('tail4', {
        kind: 'replay',
        sessionId: 'tail4',
        backfill: true,
        messages: [{ type: 'assistant', uuid: 'pre-clear' }],
      })
      dispatchToSession('tail4', { kind: 'replay-done', sessionId: 'tail4' })
    })

    await waitFor(() => expect(result.current.messages).toEqual([]))
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

  it('dispatches elicitation-request to handler', () => {
    const onElicitationRequest = vi.fn()
    renderHook(
      () => useChatStream('s1', { ...noopPerms, onElicitationRequest }),
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
      () => useChatStream('s1', { ...noopPerms, onElicitationResolved }),
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

  it('seeds elicitations from replay frames', () => {
    const onElicitationRequest = vi.fn()
    renderHook(
      () => useChatStream('s1', { ...noopPerms, onElicitationRequest }),
    )

    act(() => {
      dispatchToSession('s1', {
        kind: 'replay',
        sessionId: 's1',
        messages: [],
        elicitations: [
          { id: 'e1', serverName: 'github', message: 'Sign in', createdAt: 1 },
          { id: 'e2', serverName: 'linear', message: 'Form', createdAt: 2 },
        ],
      })
      dispatchToSession('s1', {
        kind: 'replay-done',
        sessionId: 's1',
        elicitations: [
          { id: 'e2', serverName: 'linear', message: 'Form', createdAt: 2 },
        ],
      })
    })

    expect(onElicitationRequest).toHaveBeenCalledTimes(3)
    expect(onElicitationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
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
    // flag). The dateSpy mock is set up outside act so it's active when
    // the listener calls Date.now() (the reducer uses wall-clock ms for
    // rate timing, not performance.now()).
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(1000)

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
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
      () => useChatStream('s1', noopPerms),
    )

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
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

  it('sidechain text starts seed the char-estimate rate without flipping the parent phase', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

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
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(1000)

    // All dispatches in one act to keep the same listener instance.
    // message_stop clears outputTokens; result clears tokenRate entirely
    // (and nulls the mirror's liveTurn).
    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
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
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

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
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

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
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

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
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

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
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

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
    // reset() shares the /clear wipe semantic: the post-reset state is live
    // and empty with no pending replay, so replayReady must be true —
    // otherwise MessageList sits on the skeleton (the /clear stuck-skeleton
    // bug, which reset() would silently reintroduce if it diverged).
    expect(result.current.replayReady).toBe(true)
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

  it('marks the transcript ready after a session-cleared frame (no stuck skeleton)', async () => {
    // Regression: /clear resets the store, but the post-clear session is
    // live and empty. There is no pending replay — the WS subscription
    // persists across clear (no re-subscribe), the server doesn't re-replay,
    // and the fresh Query's system/init is NOT broadcast to clients. So
    // replayReady MUST flip true on session-cleared, otherwise MessageList
    // shows an infinite skeleton until the user sends a message.
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    // Populate + ready the transcript first.
    act(() => {
      dispatchToSession('s1', {
        kind: 'replay',
        sessionId: 's1',
        messages: [{ type: 'user', uuid: 'u1' }],
      })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })
    })
    await waitFor(() => expect(result.current.replayReady).toBe(true))

    act(() => {
      dispatchToSession('s1', { kind: 'session-cleared', sessionId: 's1' })
    })

    await waitFor(() => expect(result.current.messages).toEqual([]))
    expect(result.current.replayReady).toBe(true)
  })

  // ── subscribe/unsubscribe lifecycle ──────────────────────────

  it('subscribes to hub on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    // `force` because this listener needs the history itself, not just a live
    // channel: the server re-serves a replay sliced at the cursor. A missing
    // cursor means no cached transcript, so the subscribe also opts into
    // tail-first replay.
    expect(mockSubscribe).toHaveBeenCalledWith('s1', undefined, {
      force: true,
      replayMode: 'tail-backfill',
    })

    const cleanupFn = mockSubscribe.mock.results[0].value
    expect(cleanupFn).not.toHaveBeenCalled()

    unmount()
    expect(cleanupFn).toHaveBeenCalled()
  })

  // ── channel state (dormant / slept blank-transcript fix) ─────────────

  it('forces the channel on every effect run, including each running flip', () => {
    // The mount itself has to force — the channel may already be live (another
    // consumer subscribed first, or the resume's own replay landed before this
    // listener existed), and a confirmed channel would otherwise suppress the
    // frame and leave the transcript blank. The false→true flip forces for the
    // same reason (a channel that went dormant is gone). One mechanism, no
    // "did this instance observe the transition" bookkeeping.
    const { rerender } = renderHook(
      ({ running }) => useChatStream('s1', noopPerms, running),
      { initialProps: { running: false } },
    )
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).toHaveBeenLastCalledWith('s1', undefined, {
      force: true,
      replayMode: 'tail-backfill',
    })

    // Resume completes → running flips true → the effect re-runs and asks
    // again, so the server serves a replay to this connection.
    rerender({ running: true })
    expect(mockSubscribe).toHaveBeenCalledTimes(2)
    expect(mockSubscribe).toHaveBeenLastCalledWith('s1', undefined, {
      force: true,
      replayMode: 'tail-backfill',
    })
  })

  it('clears a stale channel error only when the server confirms the channel', () => {
    const { result } = renderHook(() => useChatStream('s1', noopPerms, false))

    act(() => {
      dispatchToSession('s1', { kind: 'error', sessionId: 's1', message: 'session not loaded' })
    })
    expect(result.current.error).toBe('session not loaded')

    // A refusal keeps the band: the state frame says the same thing.
    act(() => {
      dispatchToSession('s1', subResult('s1', false, 'refused'))
    })
    expect(result.current.error).toBe('session not loaded')

    // Being served does clear it — REPLAY_REPLACE preserves `intent.error`, so
    // nothing else would, and a healed panel would show a stale band.
    act(() => {
      dispatchToSession('s1', subResult('s1', true, 'served'))
    })
    expect(result.current.error).toBeNull()
  })
})
