import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ElicitationBroker } from './elicitation-broker.js'
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
    history: [],
    subagentHistory: [],
    pumpTask: Promise.resolve(),
    running: true,
    terminated: false,
    pendingTurns: 0,
    ...overrides,
  } as unknown as Session
}

/** Park one elicitation via the broker's real buildOnElicitation path.
 *  Returns the pending promise + the controller driving its signal. */
async function parkElicitation(
  broker: ElicitationBroker,
  session: Session,
  request: Record<string, unknown> = {},
): Promise<{ promise: Promise<{ action: string; content?: unknown }>; ac: AbortController; id: string }> {
  const onElicitation = broker.buildOnElicitation(session)
  const ac = new AbortController()
  const promise = onElicitation(
    { serverName: 'github', message: 'Sign in', ...request } as Parameters<typeof onElicitation>[0],
    { signal: ac.signal, requestId: 'req-1' },
  )
  // The promise parks synchronously (Promise executor runs immediately), so
  // the pending entry exists by the time this returns.
  const id = [...session.elicitationPending.keys()][0]!
  return { promise: promise as Promise<{ action: string; content?: unknown }>, ac, id }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('ElicitationBroker', () => {
  let broker: ElicitationBroker

  beforeEach(() => {
    broker = new ElicitationBroker()
  })

  describe('buildOnElicitation', () => {
    it('parks the request in elicitationPending and parks the SDK promise', async () => {
      const session = makeFakeSession()
      const { promise, id } = await parkElicitation(broker, session, {
        mode: 'url',
        url: 'https://example.com/auth',
      })
      expect(session.elicitationPending.size).toBe(1)
      const pending = session.elicitationPending.get(id)!
      expect(pending.serverName).toBe('github')
      expect(pending.mode).toBe('url')
      expect(pending.url).toBe('https://example.com/auth')
      // Promise must stay pending until decided.
      let settled = false
      void promise.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
    })

    it('uses elicitationId as the pending id when provided', async () => {
      const session = makeFakeSession()
      const onElicitation = broker.buildOnElicitation(session)
      const ac = new AbortController()
      void onElicitation(
        { serverName: 's', message: 'm', elicitationId: 'elicit-42' } as Parameters<typeof onElicitation>[0],
        { signal: ac.signal, requestId: 'req-1' },
      )
      expect(session.elicitationPending.has('elicit-42')).toBe(true)
    })

    it('resolves via decideElicitation with the user decision', async () => {
      const session = makeFakeSession()
      const { promise, id } = await parkElicitation(broker, session, { mode: 'form' })
      broker.decideElicitation(session, id, { action: 'accept', content: { token: 'abc' } })
      await expect(promise).resolves.toEqual({ action: 'accept', content: { token: 'abc' } })
      expect(session.elicitationPending.size).toBe(0)
    })

    it('throws 404 when deciding an unknown id', () => {
      const session = makeFakeSession()
      expect(() => broker.decideElicitation(session, 'nope', { action: 'cancel' }))
        .toThrow(HttpError)
    })

    it('resolves cancel when the SDK aborts the signal', async () => {
      const session = makeFakeSession()
      const { promise, ac, id } = await parkElicitation(broker, session)
      ac.abort()
      await expect(promise).resolves.toEqual({ action: 'cancel' })
      expect(session.elicitationPending.has(id)).toBe(false)
    })
  })

  describe('cancelAll', () => {
    it('resolves every pending elicitation as cancel and clears the map', async () => {
      const session = makeFakeSession()
      const parked = await Promise.all([
        parkElicitation(broker, session),
        parkElicitation(broker, session),
      ])
      expect(session.elicitationPending.size).toBe(2)
      broker.cancelAll(session)
      for (const { promise } of parked) {
        await expect(promise).resolves.toEqual({ action: 'cancel' })
      }
      expect(session.elicitationPending.size).toBe(0)
    })
  })

  describe('subscribeElicitation', () => {
    it('snapshots existing pending entries and fans out request/resolved events', async () => {
      const session = makeFakeSession()
      const { id } = await parkElicitation(broker, session, { mode: 'url' })

      const sub = broker.subscribeElicitation(session)
      expect(sub.snapshot).toHaveLength(1)
      expect(sub.snapshot[0]!.id).toBe(id)
      expect(sub.snapshot[0]!.serverName).toBe('github')
      // Snapshots must be JSON-safe — no resolve/signal/abortHandler leak.
      expect(JSON.parse(JSON.stringify(sub.snapshot[0]))).toEqual(sub.snapshot[0])

      const events: unknown[] = []
      void (async () => {
        for await (const ev of sub.iterable) events.push(ev)
      })()

      // A second request fans out to the subscriber.
      await parkElicitation(broker, session)
      await new Promise((r) => setTimeout(r, 0))
      expect(events).toHaveLength(1)
      expect((events[0] as { kind: string }).kind).toBe('request')

      broker.decideElicitation(session, id, { action: 'accept' })
      await new Promise((r) => setTimeout(r, 0))
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({ kind: 'resolved', eid: id })

      sub.unsubscribe()
    })
  })
})
