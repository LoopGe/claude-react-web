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
  OverlayStreamingRegion: 0,
  StreamingFooter: 0,
  LiveWorkingBubble: 0,
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
import { ToastProvider } from './ToastProvider'
import { getSessionStore } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import type { SessionInfo } from '../types'

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
    // And the bubble shows the whole streamed text.
    const bubble = container.querySelector('.chat-streaming-region .streaming-plain')
    expect(bubble?.textContent).toContain(`word0 `)
    expect(bubble?.textContent).toContain(`word${DELTAS - 1} `)
    // The working bar shows the leaf-subscribed phase label.
    expect(container.querySelector('.working-bar-label')?.textContent).toBe('Writing...')
  }, 30_000)

  it("inline mode still rebuilds the tail row from the store (MessageList owns that subscription)", async () => {
    const SID = 'stream-inline'
    const store = getSessionStore(SID)
    await act(async () => {
      store.dispatch({ type: 'REPLAY_REPLACE', messages: history(4) as never, permissions: [] })
    })
    const { container } = render(
      <MessageList items={store.getSnapshot().items} sessionId={SID} streamingMode="inline" />,
    )
    expect(container.querySelector('.streaming-msg--inline')).toBeNull()
    await act(async () => {
      store.dispatch({ type: 'MESSAGE', message: { type: 'stream_event', uuid: 'i0', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } } as never })
      store.dispatch({ type: 'MESSAGE', message: { type: 'stream_event', uuid: 'i1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'inline hello' } } } as never })
      await sleep(150)
    })
    const row = container.querySelector('.streaming-msg--inline')
    expect(row?.textContent).toContain('inline hello')
    // The overlay leaf is not mounted in inline mode.
    expect(container.querySelector('.chat-streaming-region')).toBeNull()
  })

  it('threads globalPrefs.streamingRenderMode into the MessageList seam', async () => {
    // The global setting's whole journey ends here: Chat must pass the mode
    // down to MessageList's streamingMode prop — a dropped hop silently pins
    // every panel to the floating bubble while the settings switch lies.
    const SID = 'stream-thread'
    const emit = (frame: Record<string, unknown>) => {
      for (const fn of sessionListeners.get(SID) ?? []) fn({ sessionId: SID, ...frame })
    }
    const session = {
      id: SID, title: 'thread', cwd: '/tmp/thread', running: true, working: true, workingSince: Date.now(),
      terminated: false, messageCount: 4, permissionMode: 'default', model: 'test-model',
      createdAt: Date.now(), lastActivityAt: Date.now(),
    } as unknown as SessionInfo
    const { container } = render(
      <ToastProvider>
        <Chat
          session={session}
          globalPrefs={{ ...globalPrefs, streamingRenderMode: 'inline' }}
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
      </ToastProvider>,
    )
    for (let i = 0; i < 100 && !sessionListeners.get(SID)?.size; i++) await act(() => sleep(20))
    expect(sessionListeners.get(SID)?.size).toBeGreaterThan(0)

    await act(async () => {
      emit({ kind: 'replay', messages: history(4) })
      emit({ kind: 'replay-done' })
      emit(streamEvent('t-0', { type: 'message_start', message: { id: 'm1' } }))
      emit(streamEvent('t-1', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      emit(streamEvent('t-2', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'threaded live text' } }))
      await sleep(150)
    })

    // The live text lands as the in-list tail row…
    const row = container.querySelector('.streaming-msg--inline')
    expect(row?.textContent).toContain('threaded live text')
    // …and the floating bubble is not mounted.
    expect(container.querySelector('.chat-streaming-region')).toBeNull()
  }, 30_000)
})
