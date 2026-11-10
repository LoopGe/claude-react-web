import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionStoreRegistry } from '../session-store/registry'
import { getSessionStore } from '../session-store/selectors'
import { SessionSynchronizer } from '../session-sync/session-synchronizer'
import type { SessionSyncHandlers, SessionSyncHub } from '../session-sync/session-synchronizer'
import type { WsServerFrame } from '../ws-types'
import { resolveRevealItemIndex } from './message-list/reveal'
import { NewerHistoryFloat } from './message-list/transcript-chrome'

type Listener = (frame: WsServerFrame) => void
const listeners = new Map<string, Set<Listener>>()

const fakeHub: SessionSyncHub = {
  addSessionListener: (sessionId, fn) => {
    let set = listeners.get(sessionId)
    if (!set) {
      set = new Set()
      listeners.set(sessionId, set)
    }
    set.add(fn)
    return () => { set!.delete(fn) }
  },
  subscribe: vi.fn(() => vi.fn()),
}

const handlers: SessionSyncHandlers = { onRequest: vi.fn(), onResolved: vi.fn() }

const ALL = Array.from({ length: 10 }, (_, i) => ({
  seq: i,
  msg: {
    type: 'assistant',
    uuid: `m${i}`,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: `m${i}` }] },
  },
}))

function page(messages: typeof ALL, extra: Record<string, unknown> = {}) {
  return {
    generation: 0,
    headSeq: 10,
    totalCount: 10,
    startIndex: messages[0]?.seq ?? 0,
    hasMore: false,
    messages,
    tombstones: [],
    ...extra,
  }
}

const get = vi.fn(async (url: string) => {
  const around = /[?&]around=(\d+)/.exec(url)
  if (around) {
    const seq = Number(around[1])
    const messages = ALL.filter((m) => m.seq >= seq - 2 && m.seq <= seq + 2)
    return page(messages, {
      startIndex: messages[0].seq,
      hasMore: messages[0].seq > 0,
      hasNewer: messages[messages.length - 1].seq < 9,
    })
  }
  return page(ALL)
})

async function waitReady(store: ReturnType<typeof getSessionStore>) {
  for (let i = 0; i < 200; i++) {
    if (store.getSnapshot().replayReady) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('tail page never landed')
}

beforeEach(() => {
  listeners.clear()
  get.mockClear()
  void sessionStoreRegistry.clear()
})

describe('session search jump integration', () => {
  it('anchors, resolves the reveal target, and returns to head through the pill', async () => {
    const store = getSessionStore('s1')
    const sync = new SessionSynchronizer({
      sessionId: 's1',
      store,
      hub: fakeHub,
      get: get as never,
      handlers,
    })
    sync.start()
    await waitReady(store)

    await sync.anchorAt({ seq: 5 })
    expect(store.getSnapshot().anchored).toBe(true)
    expect(resolveRevealItemIndex(store.getSnapshot().items, { messageUuid: 'm5' })).toBeGreaterThanOrEqual(0)

    for (const fn of listeners.get('s1') ?? []) {
      fn({
        kind: 'message',
        sessionId: 's1',
        seq: 20,
        generation: 0,
        message: {
          type: 'assistant',
          uuid: 'live',
          message: { role: 'assistant', content: [{ type: 'text', text: 'live' }] },
        },
      } as unknown as WsServerFrame)
    }
    expect(sync.getPagingSnapshot().newerCount).toBe(1)

    render(<NewerHistoryFloat count={1} onReturn={() => { void sync.returnToHead() }} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /1 new message/ }))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(store.getSnapshot().anchored).toBe(false)
    expect(store.getSnapshot().items).toHaveLength(10)
  })
})