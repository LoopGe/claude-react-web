import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DialogBroker } from './user-dialog-broker.js'
import type { Session } from './session-types.js'
import { HttpError } from './errors.js'

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeFakeSession(overrides: Partial<Session> = {}): Session {
  const messages = {
    [Symbol.asyncIterator]() {
      return {
        next() { return Promise.resolve({ value: undefined as never, done: true }) },
        return() { return Promise.resolve({ value: undefined as never, done: true }) },
      }
    },
  }
  return {
    id: 'test-session',
    provider: 'claude',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    pluginSubscribers: new Map(),
    handle: {
      provider: 'claude',
      messages,
      enqueueUserMessage: vi.fn(),
      sendControlMessage: vi.fn(),
      clearQueuedInput: vi.fn(() => 0),
      queueDepth: 0,
      closed: false,
      abortSignal: new AbortController().signal,
      processExited: Promise.resolve(),
      abort: vi.fn(),
      destroy: vi.fn(),
      reloadSkills: vi.fn(async () => ({})),
    },
    subscribers: new Map(),
    permissionSubscribers: new Map(),
    pending: new Map(),
    elicitationSubscribers: new Map(),
    elicitationPending: new Map(),
    dialogSubscribers: new Map(),
    dialogPending: new Map(),
    history: [],
    subagentHistory: [],
    pumpTask: Promise.resolve(),
    running: true,
    terminated: false,
    pendingTurns: 0,
    ...overrides,
  } as unknown as Session
}

/** Park one user dialog via the broker's real buildOnUserDialog path.
 *  Returns the pending promise + the controller driving its signal. */
async function parkDialog(
  broker: DialogBroker,
  session: Session,
  request: Record<string, unknown> = {},
): Promise<{ promise: Promise<{ behavior: string; result?: unknown }>; ac: AbortController; id: string }> {
  const onUserDialog = broker.buildOnUserDialog(session)
  const ac = new AbortController()
  const { payload, ...rest } = request
  const extraPayload = (payload ?? {}) as Record<string, unknown>
  const promise = onUserDialog(
    {
      dialogKind: 'refusal_fallback_prompt',
      payload: {
        originalModel: 'model-a',
        fallbackModel: 'model-b',
        guidanceText: 'The model refused to continue.',
        ...extraPayload,
      },
      ...rest,
    } as Parameters<typeof onUserDialog>[0],
    { signal: ac.signal, requestId: 'req-1' },
  )
  // The promise parks synchronously (Promise executor runs immediately), so
  // the pending entry exists by the time this returns.
  const id = [...session.dialogPending.keys()][0]!
  return { promise: promise as Promise<{ behavior: string; result?: unknown }>, ac, id }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('DialogBroker', () => {
  let broker: DialogBroker

  beforeEach(() => {
    broker = new DialogBroker()
  })

  describe('buildOnUserDialog', () => {
    it('parks the request in dialogPending and parks the SDK promise', async () => {
      const session = makeFakeSession()
      const { promise, id } = await parkDialog(broker, session, {
        payload: { retractedMessageUuids: ['u1', 'u2'] },
      })
      expect(session.dialogPending.size).toBe(1)
      const pending = session.dialogPending.get(id)!
      expect(pending.dialogKind).toBe('refusal_fallback_prompt')
      expect(pending.payload.originalModel).toBe('model-a')
      expect(pending.payload.retractedMessageUuids).toEqual(['u1', 'u2'])
      // Promise must stay pending until decided.
      let settled = false
      void promise.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
    })

    it('short-circuits unknown dialog kinds to cancelled without parking', async () => {
      const session = makeFakeSession()
      const onUserDialog = broker.buildOnUserDialog(session)
      const ac = new AbortController()
      const result = await onUserDialog(
        { dialogKind: 'some_future_kind', payload: { x: 1 } } as Parameters<typeof onUserDialog>[0],
        { signal: ac.signal, requestId: 'req-1' },
      )
      expect(result).toEqual({ behavior: 'cancelled' })
      expect(session.dialogPending.size).toBe(0)
    })

    it('resolves via decideDialog with the user decision', async () => {
      const session = makeFakeSession()
      const { promise, id } = await parkDialog(broker, session)
      broker.decideDialog(session, id, { behavior: 'completed', result: 'retry_fallback' })
      await expect(promise).resolves.toEqual({ behavior: 'completed', result: 'retry_fallback' })
      expect(session.dialogPending.size).toBe(0)
    })

    it('throws 404 when deciding an unknown id', () => {
      const session = makeFakeSession()
      expect(() => broker.decideDialog(session, 'nope', { behavior: 'cancelled' }))
        .toThrow(HttpError)
    })

    it('resolves cancelled when the SDK aborts the signal', async () => {
      const session = makeFakeSession()
      const { promise, ac, id } = await parkDialog(broker, session)
      ac.abort()
      await expect(promise).resolves.toEqual({ behavior: 'cancelled' })
      expect(session.dialogPending.has(id)).toBe(false)
    })
  })

  describe('cancelAll', () => {
    it('resolves every pending dialog as cancelled and clears the map', async () => {
      const session = makeFakeSession()
      const parked = await Promise.all([
        parkDialog(broker, session),
        parkDialog(broker, session),
      ])
      expect(session.dialogPending.size).toBe(2)
      broker.cancelAll(session)
      for (const { promise } of parked) {
        await expect(promise).resolves.toEqual({ behavior: 'cancelled' })
      }
      expect(session.dialogPending.size).toBe(0)
    })
  })

  describe('subscribeDialog', () => {
    it('snapshots existing pending entries and fans out request/resolved events', async () => {
      const session = makeFakeSession()
      const { id } = await parkDialog(broker, session, {
        payload: { retractedMessageUuids: ['u1'] },
      })

      const sub = broker.subscribeDialog(session)
      expect(sub.snapshot).toHaveLength(1)
      expect(sub.snapshot[0]!.id).toBe(id)
      expect(sub.snapshot[0]!.dialogKind).toBe('refusal_fallback_prompt')
      // Snapshots must be JSON-safe — no resolve/signal/abortHandler leak.
      expect(JSON.parse(JSON.stringify(sub.snapshot[0]))).toEqual(sub.snapshot[0])

      const events: unknown[] = []
      void (async () => {
        for await (const ev of sub.iterable) events.push(ev)
      })()

      // A second request fans out to the subscriber.
      await parkDialog(broker, session)
      await new Promise((r) => setTimeout(r, 0))
      expect(events).toHaveLength(1)
      expect((events[0] as { kind: string }).kind).toBe('request')

      broker.decideDialog(session, id, { behavior: 'completed', result: 'retry_fallback' })
      await new Promise((r) => setTimeout(r, 0))
      expect(events).toHaveLength(2)
      // The resolved event carries the retracted uuids so every tab evicts.
      expect(events[1]).toMatchObject({
        kind: 'resolved',
        did: id,
        decision: { behavior: 'completed', result: 'retry_fallback' },
        retractedMessageUuids: ['u1'],
      })

      sub.unsubscribe()
    })

    it('carries retractedMessageUuids on abort-resolved events too', async () => {
      const session = makeFakeSession()
      const sub = broker.subscribeDialog(session)
      const events: unknown[] = []
      void (async () => {
        for await (const ev of sub.iterable) events.push(ev)
      })()
      const { ac } = await parkDialog(broker, session, {
        payload: { retractedMessageUuids: ['u9'] },
      })
      await new Promise((r) => setTimeout(r, 0))
      ac.abort()
      await new Promise((r) => setTimeout(r, 0))
      const resolved = events.find((e) => (e as { kind: string }).kind === 'resolved')
      expect(resolved).toMatchObject({ retractedMessageUuids: ['u9'] })
      sub.unsubscribe()
    })
  })
})
