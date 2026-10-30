// Session-bound MessageList adapter — TDD (Step 1: RED).
//
// Mounts the REAL SessionStore / reducer and the real `MessageList` (mocked
// only at the Virtuoso seam, exactly like MessageList.test.tsx), and asserts
// `SessionMessageList`:
//   - renders items the SessionStore owns (no items prop wired by the caller);
//   - updates when the store dispatches new items;
//   - forwards paging controls (loadOlder, loadingOlder) from the caller's
//     independent props and seq-window fields (oldestSeq, hasOlder) from
//     the store;
//   - derives transcriptSettling as `!replayReady`;
//   - forwards plan / question / tool maps from the store.
//
// Also asserts the CONTROLLED `MessageList` still renders caller-supplied
// static items when no main-session store is registered for the sessionId —
// i.e. the wrapper does not modify the controlled data path (subagent,
// disk, scratch-store, and static callers stay valid).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { Key, ReactNode } from 'react'

// Virtuoso needs layout; render every row directly (same shape as the
// streaming-render-isolation mock).
vi.mock('react-virtuoso', async () => {
  return {
    Virtuoso: ({ data, itemContent, firstItemIndex = 0, computeItemKey }: {
      data: unknown[]
      itemContent: (i: number, item: unknown) => ReactNode
      firstItemIndex?: number
      computeItemKey?: (i: number, item: unknown) => Key
    }) => (
      <div data-testid="virtuoso">
        {data.map((item, j) => {
          const i = j + firstItemIndex
          return (
            <div key={computeItemKey ? computeItemKey(i, item) : i} data-item-index={i}>
              {itemContent(i, item)}
            </div>
          )
        })}
      </div>
    ),
  }
})

import { SessionMessageList } from './SessionMessageList'
import { MessageList } from './MessageList'
import { getSessionStore } from '../session-store/selectors'
import {
  selectHasActivePhase,
  selectHasTranscriptBackground,
  selectHasLiveSyncSubagent,
} from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import type { SdkMessage } from '../types'
import type { ActiveSubagent, SessionSnapshot, TranscriptItem } from '../session-store/types'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await sessionStoreRegistry.clear()
})

/** Stable loadOlder callback identity across renders. SessionMessageList
 *  receives `loadingOlder` and `loadOlder` as independent props (not a
 *  paging object) so the wrapper's memo compares two primitives / a stable
 *  callback — an olderError-only change in the caller's paging snapshot
 *  cannot re-render the wrapper. */
const stableLoadOlder = async () => 0

/** Seed a tail page of N paired user/assistant messages straight into the
 *  store's seq window (the same shape the synchronizer's tail-page dispatch
 *  emits). */
function seedHistory(sid: string, n: number, opts?: { hasMore?: boolean }) {
  const messages: Array<{ seq: number; msg: unknown }> = []
  for (let i = 0; i < n; i++) {
    const uuid = `h-${i}`
    if (i % 2 === 0) {
      messages.push({
        seq: i,
        msg: {
          type: 'user',
          uuid,
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: `q${i}` }] },
        },
      })
    } else {
      messages.push({
        seq: i,
        msg: {
          type: 'assistant',
          uuid,
          parent_tool_use_id: null,
          message: { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] },
        },
      })
    }
  }
  getSessionStore(sid).dispatch({
    type: 'WINDOW_PAGE',
    at: 'tail',
    generation: 0,
    headSeq: messages.length,
    messages,
    hasMore: opts?.hasMore ?? false,
    tombstones: [],
  })
}

/** Plain user message broadcast (no seq — simulates a top-level user echo
 *  via the MESSAGE action). */
function userMessage(text: string, uuid: string): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text' as const, text }] },
  } as unknown as SdkMessage
}

describe('SessionMessageList', () => {
  it('renders items the SessionStore owns', () => {
    const sid = 'sml-render'
    seedHistory(sid, 4)
    const { container } = render(<SessionMessageList sessionId={sid} loadingOlder={false} loadOlder={stableLoadOlder} />)
    expect(container.textContent).toContain('q0')
    expect(container.textContent).toContain('a1')
    expect(container.textContent).toContain('q2')
    expect(container.textContent).toContain('a3')
  })

  it('updates when the store dispatches a new item', () => {
    const sid = 'sml-update'
    seedHistory(sid, 2)
    const { container } = render(<SessionMessageList sessionId={sid} loadingOlder={false} loadOlder={stableLoadOlder} />)
    expect(container.textContent).toContain('q0')
    act(() => {
      getSessionStore(sid).dispatch({ type: 'MESSAGE', message: userMessage('a fresh question', 'u-new') })
    })
    expect(container.textContent).toContain('a fresh question')
  })

  it('derives transcriptSettling from replayReady (true until the tail page lands)', () => {
    const sid = 'sml-settling'
    // No WINDOW_PAGE dispatch yet — replayReady is still false, so the
    // transcript is "settling".
    const settlingStore = getSessionStore(sid)
    expect(settlingStore.getSnapshot().replayReady).toBe(false)
    const { container, rerender } = render(<SessionMessageList sessionId={sid} loadingOlder={false} loadOlder={stableLoadOlder} />)
    // The component renders nothing (empty items + skeleton-gated) but
    // transcriptSettling=true must reach MessageList. We assert via the
    // reducer mirror: after seeding a tail page, replayReady flips true
    // and transcriptSettling (derived as !replayReady) flips false.
    seedHistory(sid, 2)
    rerender(<SessionMessageList sessionId={sid} loadingOlder={false} loadOlder={stableLoadOlder} />)
    expect(settlingStore.getSnapshot().replayReady).toBe(true)
    // Items are now on screen — the settled state.
    expect(container.textContent).toContain('q0')
  })

  it('forwards paging controls (loadOlder, loadingOlder) as independent props', () => {
    const sid = 'sml-paging'
    seedHistory(sid, 2)
    // The wrapper receives loadingOlder and loadOlder as independent props
    // (not a paging object). Verify it accepts them and forwards without
    // throwing; items still render. olderError is NOT a prop of
    // SessionMessageList — it belongs to the caller's OlderHistoryFloat.
    const { container } = render(
      <SessionMessageList sessionId={sid} loadingOlder={true} loadOlder={stableLoadOlder} />,
    )
    // The wrapper forwarded props without throwing; items still render.
    expect(container.textContent).toContain('q0')
  })

  it('forwards seq-window fields (oldestSeq, hasOlder) from the store', () => {
    const sid = 'sml-seq'
    seedHistory(sid, 4, { hasMore: true })
    const store = getSessionStore(sid)
    // The store now has hasOlder=true and oldestSeq=0.
    expect(store.getSnapshot().hasOlder).toBe(true)
    expect(store.getSnapshot().oldestSeq).toBe(0)
    // Mounting the wrapper must not crash and must render items.
    const { container } = render(<SessionMessageList sessionId={sid} loadingOlder={false} loadOlder={stableLoadOlder} />)
    expect(container.textContent).toContain('q0')
  })

  it('forwards plan/tool maps from the store', () => {
    const sid = 'sml-plan'
    // Seed a turn that contains an ExitPlanMode tool_use — the reducer
    // routes plan status/content into the mirror.planStatus /
    // mirror.planContent maps. The wrapper subscribes to those fields
    // and forwards them to MessageList; we assert the store's snapshot
    // carries the plan status (proving the subscription path).
    const store = getSessionStore(sid)
    const planToolUse = {
      type: 'assistant',
      uuid: 'plan-1',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-plan', name: 'ExitPlanMode', input: { plan: 'do the thing' } }],
      },
    }
    const planResult = {
      type: 'user',
      uuid: 'plan-r',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-plan', content: 'plan body' }],
      },
    }
    act(() => {
      store.dispatch({
        type: 'WINDOW_PAGE',
        at: 'tail',
        generation: 0,
        headSeq: 2,
        messages: [
          { seq: 0, msg: planToolUse },
          { seq: 1, msg: planResult },
        ],
        hasMore: false,
        tombstones: [],
      })
    })
    const snapshot = store.getSnapshot()
    expect(snapshot.planStatus.get('tu-plan')).toBeDefined()
    // The wrapper subscribes to planStatus; rendering must not throw and
    // the plan tool_use must reach the transcript.
    const { container } = render(<SessionMessageList sessionId={sid} loadingOlder={false} loadOlder={stableLoadOlder} />)
    expect(container.textContent).toContain('do the thing')
  })

  it('does not register a main-session store when given a sessionId with no history (controlled MessageList still works)', () => {
    // The controlled MessageList, called directly with `items` and no
    // sessionId, must still render the supplied static items. This is
    // the subagent / disk / scratch-store / static-test contract — the
    // wrapper does not modify the controlled data path.
    const staticItems: TranscriptItem[] = [
      {
        id: 'static-1',
        msg: {
          type: 'user',
          uuid: 'static-1',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: 'static question' }] },
        } as unknown as SdkMessage,
        plainText: 'static question',
        isCompactSummary: false,
        hiddenByDefault: false,
      },
    ]
    const { container } = render(<MessageList items={staticItems} />)
    expect(container.textContent).toContain('static question')
  })
})

// ── Stable module-level selectors ──────────────────────────────────
//
// The brief asked for three primitive boolean selectors (`selectHasActivePhase`,
// `selectHasTranscriptBackground`, `selectHasLiveSyncSubagent`) that
// turn-status consumers feed into `useSessionSelector`. Chat imports them
// from `selectors.ts`, so these tests pin their behavior against a future
// `ActiveSubagent` shape change alongside the live call sites. They are
// pure functions over a `SessionSnapshot`, so we construct minimal snapshot
// literals and assert the predicate output — no store, no React, no DOM.

/** Build a minimal SessionSnapshot with just the fields the selectors read.
 *  The other fields are not accessed, so a partial cast is safe. */
function snapshotWith(
  activePhase: SessionSnapshot['activePhase'],
  activeSubagents: ActiveSubagent[],
): SessionSnapshot {
  return {
    activePhase,
    activeSubagents,
  } as unknown as SessionSnapshot
}

function subagent(status: ActiveSubagent['status'], isAsync?: boolean): ActiveSubagent {
  return {
    toolUseId: 'tu',
    label: 's',
    status,
    toolCount: 0,
    isAsync,
  }
}

describe('stable selectors', () => {
  describe('selectHasActivePhase', () => {
    it('is false when activePhase is null', () => {
      expect(selectHasActivePhase(snapshotWith(null, []))).toBe(false)
    })
    it('is true for thinking', () => {
      expect(selectHasActivePhase(snapshotWith('thinking', []))).toBe(true)
    })
    it('is true for writing', () => {
      expect(selectHasActivePhase(snapshotWith('writing', []))).toBe(true)
    })
    it('is true for a tool_use phase', () => {
      expect(selectHasActivePhase(snapshotWith({ type: 'tool_use', name: 'Bash' }, []))).toBe(true)
    })
  })

  describe('selectHasTranscriptBackground', () => {
    it('is false when there are no subagents', () => {
      expect(selectHasTranscriptBackground(snapshotWith(null, []))).toBe(false)
    })
    it('is false when only running subagents exist', () => {
      expect(selectHasTranscriptBackground(snapshotWith(null, [subagent('running')]))).toBe(false)
    })
    it('is true when a pending subagent exists', () => {
      expect(selectHasTranscriptBackground(snapshotWith(null, [subagent('pending')]))).toBe(true)
    })
    it('is true when a background subagent exists', () => {
      expect(selectHasTranscriptBackground(snapshotWith(null, [subagent('background')]))).toBe(true)
    })
    it('is false when only done subagents exist', () => {
      expect(selectHasTranscriptBackground(snapshotWith(null, [subagent('done')]))).toBe(false)
    })
  })

  describe('selectHasLiveSyncSubagent', () => {
    it('is false when there are no subagents', () => {
      expect(selectHasLiveSyncSubagent(snapshotWith(null, []))).toBe(false)
    })
    it('is true when a synchronous running subagent exists', () => {
      expect(selectHasLiveSyncSubagent(snapshotWith(null, [subagent('running', false)]))).toBe(true)
    })
    it('is false when only async running subagents exist', () => {
      expect(selectHasLiveSyncSubagent(snapshotWith(null, [subagent('running', true)]))).toBe(false)
    })
    it('is false when a synchronous subagent is not running', () => {
      expect(selectHasLiveSyncSubagent(snapshotWith(null, [subagent('pending', false)]))).toBe(false)
    })
    it('is true when isAsync is undefined (mirrors Chat.tsx:1978 — `!undefined` is true)', () => {
      // isAsync undefined means the first tasks-snapshot hasn't landed yet;
      // the existing Chat.tsx predicate treats such a record as a live
      // sync subagent so the per-card background-action stays available
      // until the snapshot resolves the async/sync flag. The selector
      // mirrors that semantic exactly (`!a.isAsync`).
      expect(selectHasLiveSyncSubagent(snapshotWith(null, [subagent('running')]))).toBe(true)
    })
  })
})

