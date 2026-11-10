import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionStoreRegistry } from '../session-store/registry'
import { getSessionStore } from '../session-store/selectors'
import type { WsServerFrame } from '../ws-types'
import { SessionSynchronizer } from './session-synchronizer'
import type { SessionSyncHandlers, SessionSyncHub } from './session-synchronizer'

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

function aroundPage(seq: number) {
  const messages = ALL.filter((m) => m.seq >= seq - 2 && m.seq <= seq + 2)
  return page(messages, {
    startIndex: messages[0].seq,
    hasMore: messages[0].seq > 0,
    hasNewer: messages[messages.length - 1].seq < 9,
  })
}

const get = vi.fn(async (url: string) => {
  const around = /[?&]around=(\d+)/.exec(url)
  if (around) return aroundPage(Number(around[1]))
  const aroundUuid = /[?&]aroundUuid=([^&]+)/.exec(url)
  if (aroundUuid) return aroundPage(Number(aroundUuid[1].replace(/^m/, '')))
  return page(ALL)
})

function make() {
  const store = getSessionStore('s1')
  const sync = new SessionSynchronizer({
    sessionId: 's1',
    store,
    hub: fakeHub,
    get: get as never,
    handlers,
  })
  return { store, sync }
}

async function waitReady(store: ReturnType<typeof getSessionStore>) {
  for (let i = 0; i < 200; i++) {
    if (store.getSnapshot().replayReady) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('tail page never landed')
}

function emit(frame: WsServerFrame) {
  for (const fn of listeners.get('s1') ?? []) fn(frame)
}

beforeEach(() => {
  listeners.clear()
  get.mockClear()
  void sessionStoreRegistry.clear()
})

describe('SessionSynchronizer anchored history', () => {
  it('anchorAt fetches around, resets the transcript, and reports the anchor', async () => {
    const { store, sync } = make()
    sync.start()
    await waitReady(store)

    await sync.anchorAt({ seq: 5 })

    expect(get).toHaveBeenCalledWith('/sessions/s1/messages?around=5&limit=200')
    const snap = store.getSnapshot()
    expect(snap.anchored).toBe(true)
    expect(snap.anchorSeq).toBe(5)
    expect(snap.items.map((item) => item.msg.uuid)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7'])
    expect(sync.getPagingSnapshot()).toMatchObject({ anchored: true, newerCount: 0 })
  })

  it('discards a page requested before ANCHOR_RESET', async () => {
    let resolveParked!: (value: unknown) => void
    const parked = new Promise((resolve) => { resolveParked = resolve })
    get.mockImplementationOnce(() => parked as never)

    const { store, sync } = make()
    sync.start()
    await sync.anchorAt({ seq: 5 })

    resolveParked(page(ALL))
    await new Promise((r) => setTimeout(r, 0))

    expect(store.getSnapshot().items.map((item) => item.msg.uuid)).toEqual([
      'm3', 'm4', 'm5', 'm6', 'm7',
    ])
  })

  it('parks live frames while anchored and counts them without gap-filling', async () => {
    const { store, sync } = make()
    sync.start()
    await waitReady(store)
    await sync.anchorAt({ seq: 5 })
    get.mockClear()

    emit({
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

    expect(get).not.toHaveBeenCalled()
    expect(sync.getPagingSnapshot().newerCount).toBe(1)
    expect(store.getSnapshot().items.map((item) => item.msg.uuid)).toEqual([
      'm3', 'm4', 'm5', 'm6', 'm7',
    ])
  })

  it('returnToHead re-anchors at the newest page and clears anchored', async () => {
    const { store, sync } = make()
    sync.start()
    await waitReady(store)
    await sync.anchorAt({ seq: 5 })

    await sync.returnToHead()

    expect(get).toHaveBeenLastCalledWith('/sessions/s1/messages?limit=200')
    expect(store.getSnapshot().anchored).toBe(false)
    expect(store.getSnapshot().items).toHaveLength(10)
  })

  it('reconnect start() re-fetches the anchored cursor, not head', async () => {
    const { store, sync } = make()
    sync.start()
    await waitReady(store)
    await sync.anchorAt({ seq: 5 })

    sync.stop()
    get.mockClear()
    sync.start()
    await new Promise((r) => setTimeout(r, 10))

    expect(get).toHaveBeenLastCalledWith('/sessions/s1/messages?around=5&limit=200')
  })

  it('resolves a uuid anchor to the target seq', async () => {
    const { store, sync } = make()
    sync.start()
    await waitReady(store)

    await sync.anchorAt({ uuid: 'm5' })

    expect(get).toHaveBeenCalledWith('/sessions/s1/messages?aroundUuid=m5&limit=200')
    expect(store.getSnapshot().anchorSeq).toBe(5)
  })
})