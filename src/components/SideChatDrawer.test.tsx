// SideChatDrawer (Task 7) — TDD Step 1: RED.
//
// The drawer no longer takes a `stream: ChatStream` prop. It receives only
// `paging: TranscriptPaging` (for OlderHistoryFloat) and `permissions:
// UsePermissionChannel` (ChatPanel owns the permission lifecycle), and reads
// every transcript field itself via narrow selectors / the session-bound
// wrappers:
//   · SessionMessageList  — items / replayReady / plan / tool maps / seq window
//   · SessionWorkingBubble — activeSubagents / apiRetry
//   · useSessionCommands  — insertUserMessage / ackUserMessage / rollbackUserMessage
//   · useSessionStreamError — the projected error banner string
//   · useSessionField('activeSubagents') — the waiting/mountBubble computation
//
// These tests mount the REAL drawer against a REAL SessionStore / reducer,
// mocked only at the Virtuoso + api.post + useWsHubStatus seams, and exercise:
//   · sending through insert/ack/rollback commands
//   · older-history paging (loadingOlder / olderError via the paging prop)
//   · waiting rendering (a background subagent seeds the WorkingBubble)
//   · error rendering (store error → useSessionStreamError → error bar)
//   · SideChatAutoScroll reading items length + streamingContent from the store

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import type { Key, ReactNode } from 'react'

// Virtuoso needs layout; render every row directly (same shape as
// SessionMessageList.test.tsx / streaming-render-isolation.test.tsx).
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

// useSessionStreamError calls useWsHubStatus — keep the channel "online" so a
// real store error passes through unchanged.
vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => ({
    addListener: () => () => {},
    addSessionListener: () => () => {},
    subscribe: () => () => {},
    setLastMessageUuid: vi.fn(),
    isReplayBurstOpen: () => false,
    send: vi.fn(),
  }),
  useWsHubStatus: () => 'online' as const,
}))

// api.post is the send endpoint. api.get is unused by the drawer itself but
// imported transitively; keep it a no-op stub.
const postMock = vi.fn()
vi.mock('../hooks/useApi', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: (...args: unknown[]) => postMock(...(args as [])),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    del: vi.fn(),
  },
}))

import { SideChatDrawer } from './SideChatDrawer'
import { getSessionStore } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import type { SessionInfo } from '../types'
import type { TranscriptPaging } from '../session-sync/useSessionSynchronizer'
import type { UsePermissionChannel } from '../hooks/usePermissionChannel'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'side-1',
    title: 'Side Chat',
    cwd: '/tmp/side',
    running: true,
    working: false,
    terminated: false,
    messageCount: 0,
    permissionMode: 'default',
    model: 'test-model',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  } as unknown as SessionInfo
}

const noopPaging: TranscriptPaging = {
  loadingOlder: false,
  olderError: null,
  loadOlder: vi.fn(async () => 0),
}

const noopPermissions: UsePermissionChannel = {
  pending: [],
  error: null,
  decide: vi.fn(async () => {}),
  answerQuestion: vi.fn(async () => {}),
  clarifyQuestion: vi.fn(async () => {}),
  onRequest: vi.fn(),
  onResolved: vi.fn(),
  reset: vi.fn(),
  clearError: vi.fn(),
}

function makeProps(opts: {
  session?: SessionInfo
  paging?: TranscriptPaging
  permissions?: UsePermissionChannel
} = {}) {
  const session = opts.session ?? makeSession()
  return {
    session,
    parentSession: makeSession({ id: 'main-1', title: 'Main' }),
    paging: opts.paging ?? noopPaging,
    permissions: opts.permissions ?? noopPermissions,
    toolGroupCards: true,
    autoExpandRunningGroups: true,
    showMessageHeaders: true,
    streamingMode: 'overlay' as const,
    onClose: vi.fn(),
    onCollapse: vi.fn(),
  }
}

/** Seed the store's seq window directly (same shape as the synchronizer's
 *  tail-page dispatch). */
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

function userMsg(uuid: string, text: string) {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function assistantText(uuid: string, text: string) {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

beforeEach(() => {
  postMock.mockReset()
  vi.clearAllMocks()
})

afterEach(async () => {
  await sessionStoreRegistry.clear()
})

describe('SideChatDrawer (session-synchronizer migration)', () => {
  it('renders the empty state when the store has no items', async () => {
    const props = makeProps()
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(50))
    // The Side-Chat-specific empty state copy.
    expect(container.querySelector('.chat-messages-empty-side')).toBeTruthy()
  })

  it('renders items the SessionStore owns (no items prop wired by the caller)', async () => {
    const props = makeProps()
    seedPage(props.session.id, [
      { seq: 0, msg: userMsg('u-0', 'hello side') },
      { seq: 1, msg: assistantText('a-0', 'hi back') },
    ])
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(50))
    // The Virtuoso mock renders every row; the user message text is present.
    expect(container.textContent).toContain('hello side')
    expect(container.textContent).toContain('hi back')
  })

  // ── Sending through insert/ack/rollback commands ───────────────────

  it('optimistically inserts a user message, POSTs, and acks on success', async () => {
    const props = makeProps()
    seedPage(props.session.id, [])
    const store = getSessionStore(props.session.id)
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(50))

    // Type into the rich editor. RichPromptInput serializes contentEditable
    // text through onInput → onChange; setting the value prop directly is the
    // controlled path the Composer's draft restore uses.
    const editor = container.querySelector('[contenteditable="true"]') as HTMLElement
    expect(editor).toBeTruthy()
    await act(() => {
      editor.textContent = 'send me'
      // Fire input so RichPromptInput's onInput handler reports the text.
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Stub the POST to succeed with a server uuid.
    postMock.mockResolvedValueOnce({ ok: true, message: { uuid: 'server-uuid-1', receivedAt: 12345 } })

    // Click the send button (the btn-primary action button).
    const sendBtn = container.querySelector('.side-chat-drawer-actions .btn-primary') as HTMLButtonElement
    await act(async () => {
      sendBtn.click()
      await sleep(50)
    })

    // The optimistic insert dispatched OPTIMISTIC_USER_MESSAGE → items grew.
    expect(store.getSnapshot().items.length).toBeGreaterThan(0)
    // The POST hit /sessions/:id/messages.
    expect(postMock).toHaveBeenCalledWith(
      `/sessions/${props.session.id}/messages`,
      expect.anything(),
    )
    // After the await, ack fired: the optimistic placeholder's uuid is
    // rewritten to the server uuid in the messages snapshot (the placeholder
    // is re-keyed from pendingId → serverUuid in intent.pendingPlaceholders).
    const messages = store.getSnapshot().messages
    expect(messages.some((m: { uuid?: string }) => m.uuid === 'server-uuid-1')).toBe(true)
  })

  it('rolls back the optimistic message when the POST fails', async () => {
    const props = makeProps()
    seedPage(props.session.id, [])
    const store = getSessionStore(props.session.id)
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(50))

    const editor = container.querySelector('[contenteditable="true"]') as HTMLElement
    await act(() => {
      editor.textContent = 'doomed'
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const beforeCount = store.getSnapshot().items.length
    postMock.mockRejectedValueOnce(new Error('network down'))

    const sendBtn = container.querySelector('.side-chat-drawer-actions .btn-primary') as HTMLButtonElement
    await act(async () => {
      sendBtn.click()
      await sleep(50)
    })

    // The rollback removed the optimistic placeholder → items count is back.
    expect(store.getSnapshot().items.length).toBe(beforeCount)
  })

  // ── Older-history paging (paging prop → OlderHistoryFloat) ─────────

  it('shows the loading float when paging.loadingOlder is true', async () => {
    const props = makeProps({
      paging: { loadingOlder: true, olderError: null, loadOlder: vi.fn(async () => 0) },
    })
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(50))
    const pill = container.querySelector('.chat-older-float-pill')
    expect(pill).toBeTruthy()
    // Loading pill text (matches transcript-chrome's "Loading…"-ish copy).
    expect(pill?.textContent).toBeTruthy()
  })

  it('shows the error float with a retry button when paging.olderError is set', async () => {
    const retry = vi.fn(async () => 0)
    const props = makeProps({
      paging: { loadingOlder: false, olderError: 'Could not load', loadOlder: retry },
    })
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(50))
    const pill = container.querySelector('.chat-older-float-pill--error')
    expect(pill).toBeTruthy()
    expect(pill?.textContent).toContain('Could not load')
    // Clicking the retry button calls loadOlder.
    const retryBtn = pill?.querySelector('button')
    expect(retryBtn).toBeTruthy()
    await act(async () => {
      retryBtn!.click()
      await sleep(20)
    })
    expect(retry).toHaveBeenCalled()
  })

  // ── Waiting rendering (background subagent → WorkingBubble) ────────

  it('mounts the WorkingBubble when a turn is active (waiting/working render)', async () => {
    const session = makeSession({ working: true, workingSince: Date.now() })
    const props = makeProps({ session })
    seedPage(session.id, [
      { seq: 0, msg: userMsg('u-0', 'question') },
      { seq: 1, msg: assistantText('a-0', 'answering…') },
    ])
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(80))
    // shouldMountWorkingBubble is true while the turn is active; the
    // SessionWorkingBubble wrapper renders LiveWorkingBubble, which carries
    // the .working-bar element.
    expect(container.querySelector('.working-bar')).toBeTruthy()
  })

  // ── Error rendering (store error → useSessionStreamError → error bar) ─

  it('renders the error bar from useSessionStreamError when the store has an error', async () => {
    const props = makeProps()
    seedPage(props.session.id, [])
    const store = getSessionStore(props.session.id)
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(50))

    act(() => {
      store.dispatch({ type: 'ERROR', message: 'side chat broke' })
    })
    await act(() => sleep(20))

    const bar = container.querySelector('.error-bar')
    expect(bar).toBeTruthy()
    expect(bar?.textContent).toContain('side chat broke')
  })

  // ── SideChatAutoScroll reads items length + streamingContent from the store ─

  it('SideChatAutoScroll subscribes to items length from the store (scroll follows items growth)', async () => {
    const session = makeSession({ working: false })
    const props = makeProps({ session })
    seedPage(session.id, [
      { seq: 0, msg: userMsg('u-0', 'first') },
    ])
    const store = getSessionStore(session.id)
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(50))

    const body = container.querySelector('.side-chat-drawer-body') as HTMLElement
    expect(body).toBeTruthy()

    // Mock scrollHeight to track items length so a scroll effect is
    // observable (jsdom defaults both scrollTop and scrollHeight to 0). Set
    // the spies up BEFORE triggering the items change so the effect's write
    // is captured.
    const scrollHeightSpy = vi.spyOn(body, 'scrollHeight', 'get')
    scrollHeightSpy.mockImplementation(() => store.getSnapshot().items.length * 100)
    const scrollTopSetter = vi.fn()
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: scrollTopSetter,
    })
    // Re-trigger the effect by flushing the current items (the spy is now in
    // place): a re-dispatch of the same WINDOW_PAGE creates a fresh items
    // reference so the SideChatAutoScroll subscription fires.
    scrollTopSetter.mockClear()

    // Grow the store's items — SideChatAutoScroll subscribes to items, so the
    // effect must re-fire and set scrollTop to the new (taller) scrollHeight.
    await act(() => {
      store.dispatch({
        type: 'WINDOW_PAGE',
        at: 'tail',
        generation: 0,
        headSeq: 3,
        messages: [
          { seq: 0, msg: userMsg('u-0', 'first') },
          { seq: 1, msg: assistantText('a-0', 'second') },
          { seq: 2, msg: userMsg('u-1', 'third') },
        ],
        hasMore: false,
        tombstones: [],
      })
      return sleep(30)
    })
    // 3 items → scrollHeight 300 → scrollTop set to 300.
    expect(scrollTopSetter).toHaveBeenCalledWith(300)

    scrollHeightSpy.mockRestore()
  }, 15_000)

  it('SideChatAutoScroll subscribes to streamingContent from the store', async () => {
    const session = makeSession({ working: true, workingSince: Date.now() })
    const props = makeProps({ session })
    seedPage(session.id, [
      { seq: 0, msg: userMsg('u-0', 'question') },
      { seq: 1, msg: assistantText('a-0', '') },
    ])
    const store = getSessionStore(session.id)
    const { container } = render(<SideChatDrawer {...props} />)
    await act(() => sleep(50))

    const body = container.querySelector('.side-chat-drawer-body') as HTMLElement
    const scrollTopSetter = vi.fn()
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: scrollTopSetter,
    })

    // Reset after the initial items-driven effect.
    scrollTopSetter.mockClear()

    // Drive a streaming delta into the store — SideChatAutoScroll subscribes
    // to streamingContent, so the effect must re-fire even though items
    // didn't change.
    await act(() => {
      store.dispatch({
        type: 'MESSAGE',
        message: {
          type: 'stream_event',
          uuid: 's-delta',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streaming word ' } },
        },
      } as never)
      return sleep(120) // LIVE_TURN_FLUSH is 80ms
    })

    // The streamingContent slot is now populated.
    expect(store.getSnapshot().streamingContent).toBeTruthy()
    // The scroll effect re-fired for the streaming-content change.
    expect(scrollTopSetter).toHaveBeenCalled()
  }, 15_000)
})
