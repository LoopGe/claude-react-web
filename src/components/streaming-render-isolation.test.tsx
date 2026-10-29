// Streaming re-renders stay in the leaves.
//
// Mounts the REAL <Chat> against the REAL SessionStore / reducer, fed through
// the REAL useChatStream WS path (the hub is mocked only at the transport
// seam), and counts renders of the real memo components by wrapping their
// render functions (same memo compare, same hooks). A React <Profiler> around
// the tree counts commits. During a window of live text deltas — i.e. N
// LIVE_TURN_FLUSH cycles plus char-estimated token-rate samples — the panel
// body (Chat) and the transcript (MessageList) must not render at all, while
// the overlay bubble (StreamingFooter) renders once per flush and the
// WorkingBubble leaf picks up the token rate on its own.
//
// Baseline before the leaf subscriptions (same harness shape, 2s window,
// 200 deltas): Chat 3, MessageList ~41 (2× per flush), StreamingFooter ~22.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Profiler, memo, type ComponentType } from 'react'
import { act, render } from '@testing-library/react'

const counts = vi.hoisted(() => ({
  Chat: 0,
  MessageList: 0,
  SessionMessageList: 0,
  OverlayStreamingRegion: 0,
  StreamingFooter: 0,
  LiveWorkingBubble: 0,
  DraftTextBody: 0,
}))
type CountKey = keyof typeof counts

type MemoLike = { type: (p: unknown) => unknown; compare?: ((a: unknown, b: unknown) => boolean) | null }
function counted(key: CountKey, real: unknown) {
  const m = real as MemoLike
  const inner = m.type
  const Wrapped = function CountedRender(props: unknown) {
    counts[key]++
    return inner(props) as never
  }
  Object.defineProperty(Wrapped, 'name', { value: (inner as { name?: string }).name ?? key })
  return memo(Wrapped as ComponentType<object>, m.compare ?? undefined)
}

vi.mock('./Chat', async (orig) => {
  const mod = await orig<typeof import('./Chat')>()
  return { ...mod, Chat: counted('Chat', mod.Chat) }
})
vi.mock('./MessageList', async (orig) => {
  const mod = await orig<typeof import('./MessageList')>()
  return { ...mod, MessageList: counted('MessageList', mod.MessageList) }
})
vi.mock('./SessionMessageList', async (orig) => {
  const mod = await orig<typeof import('./SessionMessageList')>()
  return { ...mod, SessionMessageList: counted('SessionMessageList', mod.SessionMessageList) }
})
vi.mock('./message-list/OverlayStreamingRegion', async (orig) => {
  const mod = await orig<typeof import('./message-list/OverlayStreamingRegion')>()
  return { ...mod, OverlayStreamingRegion: counted('OverlayStreamingRegion', mod.OverlayStreamingRegion) }
})
vi.mock('./message-list/transcript-chrome', async (orig) => {
  const mod = await orig<typeof import('./message-list/transcript-chrome')>()
  return { ...mod, StreamingFooter: counted('StreamingFooter', mod.StreamingFooter) }
})
vi.mock('./message-list/WorkingBubble', async (orig) => {
  const mod = await orig<typeof import('./message-list/WorkingBubble')>()
  return { ...mod, LiveWorkingBubble: counted('LiveWorkingBubble', mod.LiveWorkingBubble) }
})
vi.mock('./message-list/draft-body', async (orig) => {
  const mod = await orig<typeof import('./message-list/draft-body')>()
  return { ...mod, DraftTextBody: counted('DraftTextBody', mod.DraftTextBody) }
})

// Virtuoso needs layout; render a fixed tail window like a real viewport.
vi.mock('react-virtuoso', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    Virtuoso: ({ data, itemContent, firstItemIndex = 0, components, scrollerRef, computeItemKey }: {
      data: unknown[]; itemContent: (i: number, item: unknown) => React.ReactNode; firstItemIndex?: number
      components?: { Footer?: React.ComponentType }; scrollerRef?: (el: HTMLElement | null) => void
      computeItemKey?: (i: number, item: unknown) => React.Key
    }) => {
      const ref = React.useRef<HTMLDivElement | null>(null)
      React.useLayoutEffect(() => { scrollerRef?.(ref.current); return () => scrollerRef?.(null) }, [scrollerRef])
      const start = Math.max(0, data.length - 20)
      return (
        <div ref={ref}>
          {data.slice(start).map((item, j) => {
            const i = start + j + firstItemIndex
            return <div key={computeItemKey ? computeItemKey(i, item) : i} data-item-index={i}>{itemContent(i, item)}</div>
          })}
          {components?.Footer && <components.Footer />}
        </div>
      )
    },
  }
})

// ── transport seam: hub + REST ──────────────────────────────────────
type L = (frame: Record<string, unknown>) => void
const sessionListeners = new Map<string, Set<L>>()
const hub = {
  addListener: () => () => {},
  addSessionListener: (id: string, fn: L) => {
    let s = sessionListeners.get(id)
    if (!s) sessionListeners.set(id, (s = new Set()))
    s.add(fn)
    return () => { s!.delete(fn) }
  },
  subscribe: vi.fn(() => () => {}),
  setLastMessageUuid: vi.fn(),
  isReplayBurstOpen: () => false,
  send: vi.fn(),
}
vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => hub,
  useWsHubStatus: () => 'online' as const,
}))
vi.mock('../hooks/useApi', () => {
  const get = vi.fn(async (path: string) => {
    if (path.includes('/messages')) return { messages: [], totalCount: 0, startIndex: 0, hasMore: false }
    return { schedules: [], commands: [], agents: [], models: [], anchors: [], tasks: [], items: [], entries: [] }
  })
  return { api: { get, post: vi.fn(async () => ({})), put: vi.fn(async () => ({})), patch: vi.fn(async () => ({})), del: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) } }
})

import { Chat } from './Chat'
import { MessageList } from './MessageList'
import { SessionMessageList } from './SessionMessageList'
import { ToastProvider } from './ToastProvider'
import { getSessionStore } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import type { SessionInfo } from '../types'
import type { TranscriptPaging } from '../session-sync/useSessionSynchronizer'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function history(n: number) {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < n; i++) {
    const uuid = `h-${i}`
    if (i % 2 === 0) {
      out.push({ type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: `question ${i}` }] } })
    } else {
      out.push({ type: 'assistant', uuid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } })
    }
  }
  return out
}

const streamEvent = (uuid: string, event: Record<string, unknown>) => ({
  kind: 'message',
  message: { type: 'stream_event', uuid, parent_tool_use_id: null, event },
})

const noop = () => {}
const globalPrefs = { showPinnedUserMessage: true, autoRecap: false, toolGroupCards: true, autoExpandRunningGroups: true, showMessageHeaders: true, streamingRenderMode: 'overlay' as const }
const snippets = { snippets: [], add: noop, update: noop, remove: noop, reorder: noop } as never

afterEach(async () => {
  await sessionStoreRegistry.clear()
})

describe('live-turn streaming re-renders only the leaves', () => {
  it('Chat and MessageList stay at 0 renders across N flushes while the bubble re-renders each flush', async () => {
    const SID = 'stream-iso'
    const emit = (frame: Record<string, unknown>) => {
      for (const fn of sessionListeners.get(SID) ?? []) fn({ sessionId: SID, ...frame })
    }
    const session = {
      id: SID, title: 'iso', cwd: '/tmp/iso', running: true, working: true, workingSince: Date.now(),
      terminated: false, messageCount: 40, permissionMode: 'default', model: 'test-model',
      createdAt: Date.now(), lastActivityAt: Date.now(),
    } as unknown as SessionInfo
    const commits = { n: 0 }
    const { container } = render(
      <ToastProvider>
        <Profiler id="chat" onRender={() => { commits.n++ }}>
          <Chat
            session={session}
            globalPrefs={globalPrefs}
            snippets={snippets}
            onOpenSnippetsManager={noop}
            onSaveCurrentAsSnippet={noop}
            onSessionUpdate={noop}
            onRequestResumeForPanel={noop}
            onOpenSettingsTab={noop}
            onShowHelp={noop}
            onClearSession={noop}
            onHandoffSession={noop}
            focused
          />
        </Profiler>
      </ToastProvider>,
    )
    for (let i = 0; i < 100 && !sessionListeners.get(SID)?.size; i++) await act(() => sleep(20))
    expect(sessionListeners.get(SID)?.size).toBeGreaterThan(0)

    await act(async () => {
      emit({ kind: 'replay', messages: history(40) })
      emit({ kind: 'replay-done' })
      await sleep(200)
    })
    // Start the assistant message + a text block: the phase flips to writing
    // (hasActivePhase false → true re-renders Chat ONCE, before the window).
    await act(async () => {
      emit(streamEvent('s-0', { type: 'message_start', message: { id: 'm1' } }))
      emit(streamEvent('s-1', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      await sleep(150)
    })
    const store = getSessionStore(SID)
    expect(store.getSnapshot().activePhase).toBe('writing')

    // Track every distinct streamingContent the store publishes = one flush each.
    const seen = new Set<string>()
    const unsub = store.subscribe(() => {
      const c = store.getSnapshot().streamingContent
      if (c) seen.add(c)
    })
    for (const k of Object.keys(counts) as CountKey[]) counts[k] = 0
    commits.n = 0

    const DELTAS = 36
    for (let i = 0; i < DELTAS; i++) {
      await act(async () => {
        emit(streamEvent(`d-${i}`, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${i} ` } }))
        // ~25ms apart: several deltas coalesce into each 80ms flush, and the
        // char-estimate rate samples (500ms throttle) land inside the window.
        await sleep(25)
      })
    }
    await act(() => sleep(150)) // trailing flush
    unsub()

    const flushes = seen.size
    // The window really did stream: several flushes, and the token rate moved.
    expect(flushes).toBeGreaterThanOrEqual(5)
    expect(store.getSnapshot().tokenRate).not.toBeNull()
    // The heavy parents never rendered…
    expect(counts.Chat).toBe(0)
    expect(counts.MessageList).toBe(0)
    // …while the bubble re-rendered once per published flush (memo bail-outs
    // aside, never fewer), and the WorkingBubble leaf followed the rate.
    expect(counts.StreamingFooter).toBeGreaterThanOrEqual(flushes)
    expect(counts.OverlayStreamingRegion).toBeGreaterThanOrEqual(flushes)
    expect(counts.LiveWorkingBubble).toBeGreaterThan(0)
    expect(commits.n).toBeGreaterThanOrEqual(flushes)
    // And the bubble shows the whole streamed text. (No trailing-space
    // assertion on the last word: the streaming card renders markdown now,
    // and markdown whitespace normalization drops end-of-paragraph trailing
    // spaces — exactly like the settled card will.)
    const bubble = container.querySelector('.chat-streaming-region .streaming-plain')
    expect(bubble?.textContent).toContain(`word0 `)
    expect(bubble?.textContent).toContain(`word${DELTAS - 1}`)
    // The working bar shows the leaf-subscribed phase label.
    expect(container.querySelector('.working-bar-label')?.textContent).toBe('Writing...')
  }, 30_000)

  it('inline mode keeps MessageList at 0 renders per flush (the draft body leaf owns the subscription)', async () => {
    const SID = 'stream-inline'
    const store = getSessionStore(SID)
    await act(async () => {
      store.dispatch({ type: 'REPLAY_REPLACE', messages: history(4) as never, permissions: [] })
    })
    const { container } = render(
      <MessageList items={store.getSnapshot().items} sessionId={SID} streamingMode="inline" />,
    )
    // Start the draft (the row appears — one legitimate row-layer render)…
    await act(async () => {
      store.dispatch({ type: 'MESSAGE', message: { type: 'stream_event', uuid: 'i0', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'word0 ' } } } as never })
      await sleep(150)
    })
    expect(container.querySelector('.draft-body')).toBeTruthy()
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] = 0
    // …then grow it through several flushes: only the draft body leaf may
    // render (MessageList must stay at 0 — the same leaf-isolation contract
    // the overlay bubble honours).
    const FLUSHES = 5
    for (let i = 1; i <= FLUSHES; i++) {
      store.dispatch({ type: 'MESSAGE', message: { type: 'stream_event', uuid: `i${i}`, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${i} ` } } } as never })
      await act(() => sleep(110))
    }
    await act(() => sleep(150))
    expect(counts.MessageList).toBe(0)
    expect(counts.DraftTextBody).toBeGreaterThanOrEqual(FLUSHES)
    // The growing text lives in the draft card; no footer row exists.
    expect(container.querySelector('.draft-body .md')?.textContent).toContain(`word${FLUSHES}`)
    expect(container.querySelector('.streaming-footer-wrapper')).toBeNull()
    // The overlay leaf is not mounted in inline mode.
    expect(container.querySelector('.chat-streaming-region')).toBeNull()
  }, 30_000)

  it('overlay mode: SessionMessageList wrapper stays at 0 renders per flush (the overlay leaf owns the subscription)', async () => {
    const SID = 'session-msglist-iso'
    // Seed a settled transcript (items / replayReady are stable across
    // LIVE_TURN_FLUSH), then mount SessionMessageList with a stable paging
    // object. The wrapper subscribes only to items / replayReady /
    // planStatus / planContent / questionAnswers / toolStatus / toolResults
    // / oldestSeq / hasOlder — none of those change identity during a
    // streaming flush, so the wrapper (and the controlled MessageList
    // inside it) must not re-render while the OverlayStreamingRegion leaf
    // re-renders once per published flush.
    const store = getSessionStore(SID)
    await act(async () => {
      store.dispatch({ type: 'REPLAY_REPLACE', messages: history(4) as never, permissions: [] })
    })
    const stablePaging: TranscriptPaging = {
      loadingOlder: false,
      olderError: null,
      loadOlder: async () => 0,
    }
    const { container } = render(
      <SessionMessageList sessionId={SID} paging={stablePaging} />,
    )
    // Start the assistant message + a text block so the live turn exists
    // and `streamingContent` becomes non-empty after the first flush.
    await act(async () => {
      store.dispatch({ type: 'MESSAGE', message: { type: 'stream_event', uuid: 's-0', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } } as never })
      store.dispatch({ type: 'MESSAGE', message: { type: 'stream_event', uuid: 's-1', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } } as never })
      await sleep(150)
    })
    // The store's activePhase is 'writing' (the content_block_start landed),
    // but SessionMessageList does NOT subscribe to activePhase — it must
    // not have rendered for that transition either.
    expect(store.getSnapshot().activePhase).toBe('writing')

    // Track every distinct streamingContent the store publishes = one flush.
    const seen = new Set<string>()
    const unsub = store.subscribe(() => {
      const c = store.getSnapshot().streamingContent
      if (c) seen.add(c)
    })
    for (const k of Object.keys(counts) as CountKey[]) counts[k] = 0

    const DELTAS = 24
    for (let i = 0; i < DELTAS; i++) {
      await act(async () => {
        store.dispatch({ type: 'MESSAGE', message: { type: 'stream_event', uuid: `d-${i}`, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${i} ` } } } as never })
        await sleep(25)
      })
    }
    await act(() => sleep(150)) // trailing flush
    unsub()

    const flushes = seen.size
    expect(flushes).toBeGreaterThanOrEqual(5)
    // The wrapper never rendered across the whole streaming window…
    expect(counts.SessionMessageList).toBe(0)
    expect(counts.MessageList).toBe(0)
    // …while the overlay leaf re-rendered at least once per published flush.
    expect(counts.OverlayStreamingRegion).toBeGreaterThanOrEqual(flushes)
    expect(counts.StreamingFooter).toBeGreaterThanOrEqual(flushes)
    // And the streamed text reached the overlay bubble.
    expect(container.querySelector('.chat-streaming-region .streaming-plain')?.textContent).toContain(`word0 `)
    expect(container.querySelector('.chat-streaming-region .streaming-plain')?.textContent).toContain(`word${DELTAS - 1}`)
  }, 30_000)
})
