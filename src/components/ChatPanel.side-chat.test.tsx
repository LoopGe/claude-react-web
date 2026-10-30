// ChatPanel Side Chat lifecycle (Task 7) — TDD Step 1: RED.
//
// ChatPanel owns the Side Chat synchronization/permission lifecycle. The
// SideChatDrawer unmounts on collapse and remounts on expand, but the
// ChatPanel-level useSessionSynchronizer must stay alive across that cycle —
// exactly ONE force subscribe and ONE initial tail fetch for the side chat
// session, regardless of collapse/expand.
//
// The fake hub defers the tail fetch so the call count is observable before
// the page resolves (and so the synchronizer's run stays in its "fetching"
// state across the collapse/expand toggle, where a drawer-owned synchronizer
// would have torn down and re-subscribed).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render } from '@testing-library/react'

// ── Deferred-tail fake hub ──────────────────────────────────────────
type L = (frame: Record<string, unknown>) => void
const sessionListeners = new Map<string, Set<L>>()

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Per-session tail fetch deferral. The synchronizer calls
// api.get('/sessions/:id/messages?limit=200') once on start; we capture that
// call and hand back a deferred promise we control.
const tailDeferred = makeDeferred<{ generation: number; headSeq: number; totalCount: number; startIndex: number; hasMore: false; messages: unknown[] }>()

const subscribeSpy = vi.fn((_sessionId: string, _opts?: { force?: boolean }) => () => {})
const apiGetSpy = vi.fn(async (path: string) => {
  if (path.includes('/messages')) return tailDeferred.promise
  if (path.includes('/permissions')) return { pending: [] }
  if (path.includes('/git/')) return { isRepo: false }
  return {}
})

// A single module-level hub object so useSessionSynchronizer's useMemo
// ([sessionId, hub]) does not recreate the synchronizer on every ChatPanel
// render — the factory below returns the SAME reference each call.
const hub = {
  addListener: () => () => {},
  addSessionListener: (id: string, fn: L) => {
    let s = sessionListeners.get(id)
    if (!s) sessionListeners.set(id, (s = new Set()))
    s.add(fn)
    return () => { s!.delete(fn) }
  },
  subscribe: subscribeSpy,
  setLastMessageUuid: vi.fn(),
  isReplayBurstOpen: () => false,
  send: vi.fn(),
}
vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => hub,
  useWsHubStatus: () => 'online' as const,
}))

vi.mock('../hooks/useApi', () => ({
  api: {
    get: (...args: unknown[]) => apiGetSpy(...(args as [string])),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  },
}))

// Mock the heavy <Chat> to a stub. The main-session synchronizer lives inside
// <Chat>; stubbing it isolates the Side Chat synchronizer ChatPanel owns, so
// the subscribe/tail-fetch counts reflect ONLY the side chat session.
vi.mock('./Chat', () => ({
  Chat: () => <div data-testid="chat-stub" />,
}))

import { ChatPanel } from './ChatPanel'
import { ToastProvider } from './ToastProvider'
import { sessionStoreRegistry } from '../session-store/registry'
import type { SessionInfo } from '../types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const noop = () => {}

function makeSession(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: id,
    cwd: '/tmp/' + id,
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

const basePanelProps = {
  focused: true,
  slot: 1,
  globalPrefs: {
    showPinnedUserMessage: true,
    autoRecap: false,
    toolGroupCards: true,
    autoExpandRunningGroups: true,
    showMessageHeaders: true,
    streamingRenderMode: 'overlay' as const,
  },
  onFocus: noop,
  onClose: noop,
  onSessionUpdate: noop,
  onRequestResumeForPanel: noop,
  onClearSession: noop,
  onHandoffSession: noop,
  onOpenSettingsTab: noop,
  onShowHelp: noop,
  onOpenSettings: noop,
  onCloseSettings: noop,
  onOpenGitPanel: noop,
  onCloseGitPanel: noop,
  onOpenTasksPanel: noop,
  onCloseTasksPanel: noop,
  onOpenWorktree: noop,
  onCloseWorktree: noop,
  snippets: { snippets: [], add: noop, update: noop, remove: noop, reorder: noop } as never,
  onOpenSnippetsManager: noop,
  onSaveCurrentAsSnippet: noop,
}

beforeEach(() => {
  sessionListeners.clear()
  subscribeSpy.mockClear()
  apiGetSpy.mockClear()
  void sessionStoreRegistry.clear()
})

afterEach(async () => {
  await sessionStoreRegistry.clear()
})

describe('ChatPanel Side Chat lifecycle (session-synchronizer)', () => {
  it('owns exactly one force subscribe and one initial tail fetch for the side chat across collapse/expand', async () => {
    const SIDE_ID = 'side-lifecycle'
    const mainSession = makeSession('main-lifecycle')
    const sideSession = makeSession(SIDE_ID, { working: false })

    const sideChatProps = {
      sideChatSession: sideSession,
      sideChatCollapsed: false,
      onCloseSideChat: noop,
      onToggleCollapseSideChat: noop,
    }

    const { rerender } = render(
      <ToastProvider>
        <ChatPanel
          {...basePanelProps}
          session={mainSession}
          {...sideChatProps}
        />
      </ToastProvider>,
    )

    // Wait for the ChatPanel-level synchronizer to start (force subscribe +
    // tail fetch for the side chat id).
    await act(() => sleep(200))

    // One force subscribe for the side chat session.
    const sideSubs = subscribeSpy.mock.calls.filter((c) => c[0] === SIDE_ID)
    expect(sideSubs.length).toBe(1)
    expect(sideSubs[0][1]).toEqual({ force: true })

    // One initial tail fetch for the side chat session.
    const sideTails = apiGetSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes(`/sessions/${SIDE_ID}/messages`),
    )
    expect(sideTails.length).toBe(1)

    // ── Collapse: SideChatDrawer unmounts ──────────────────────────────
    rerender(
      <ToastProvider>
        <ChatPanel
          {...basePanelProps}
          session={mainSession}
          {...sideChatProps}
          sideChatCollapsed
        />
      </ToastProvider>,
    )
    await act(() => sleep(100))

    // No new subscribe or tail fetch — the synchronizer lives at ChatPanel.
    expect(subscribeSpy.mock.calls.filter((c) => c[0] === SIDE_ID).length).toBe(1)
    expect(
      apiGetSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes(`/sessions/${SIDE_ID}/messages`),
      ).length,
    ).toBe(1)

    // ── Expand: SideChatDrawer remounts ────────────────────────────────
    rerender(
      <ToastProvider>
        <ChatPanel
          {...basePanelProps}
          session={mainSession}
          {...sideChatProps}
        />
      </ToastProvider>,
    )
    await act(() => sleep(100))

    // STILL only one subscribe and one tail fetch — the collapse/expand never
    // tore the ChatPanel-owned synchronizer down.
    expect(subscribeSpy.mock.calls.filter((c) => c[0] === SIDE_ID).length).toBe(1)
    expect(
      apiGetSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes(`/sessions/${SIDE_ID}/messages`),
      ).length,
    ).toBe(1)

    // Resolve the deferred tail page (clean shutdown, no pending promises).
    await act(async () => {
      tailDeferred.resolve({ generation: 0, headSeq: 0, totalCount: 0, startIndex: 0, hasMore: false, messages: [] })
      await sleep(50)
    })
  }, 20_000)

  it('does not subscribe or fetch when no Side Chat session is present', async () => {
    const mainSession = makeSession('main-noside')
    render(
      <ToastProvider>
        <ChatPanel
          {...basePanelProps}
          session={mainSession}
        />
      </ToastProvider>,
    )
    await act(() => sleep(150))

    // No side chat id → no synchronizer force-subscribe and no tail fetch.
    // (useGitStatus still subscribes for the main session's git-snapshot
    // channel — that call carries no { force: true } opts, so it is excluded.)
    expect(
      subscribeSpy.mock.calls.filter(
        (c) => c[1] && (c[1] as { force?: boolean }).force === true,
      ).length,
    ).toBe(0)
    expect(
      apiGetSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/messages'),
      ).length,
    ).toBe(0)
  }, 15_000)
})
