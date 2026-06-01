import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { PermissionBroker } from './permission-broker.js'
import type { Session, PendingPermission } from './session-types.js'

// ─── Helpers ─────────────────────────────────────────────────────────

function makeFakeSession(overrides: Partial<Session> = {}): Session {
  const ac = new AbortController()
  return {
    id: 'test-session',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    input: { push() {}, end() {}, closed: false, hasWaiter: false, queueDepth: 0, iterable: { [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ value: undefined as never, done: true }) }, return() { return Promise.resolve({ value: undefined as never, done: true }) } } } } },
    query: { [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ value: undefined as never, done: true }) }, return() { return Promise.resolve({ value: undefined as never, done: true }) } } }, interrupt: vi.fn(async () => {}), setModel: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}), applyFlagSettings: vi.fn(async () => {}), supportedModels: vi.fn(async () => []), supportedCommands: vi.fn(async () => []), supportedAgents: vi.fn(async () => []), mcpServerStatus: vi.fn(async () => ({})), reconnectMcpServer: vi.fn(async () => {}), toggleMcpServer: vi.fn(async () => {}), setMcpServers: vi.fn(async () => ({})), reloadPlugins: vi.fn(async () => ({})), getContextUsage: vi.fn(async () => ({})) } as unknown as Session['query'],
    subscribers: new Map(),
    permissionSubscribers: new Map(),
    pending: new Map(),
    history: [],
    contextUsageSubscribers: new Set(),
    gitStatusSubscribers: new Set(),
    messageStatusSubscribers: new Set(),
    recapSubscribers: new Set(),
    abortController: ac,
    pumpTask: Promise.resolve(),
    running: true,
    terminated: false,
    pendingTurns: 0,
    ...overrides,
  }
}

function makeToolPermission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  const ac = new AbortController()
  const base: PendingPermission = {
    kind: 'permission',
    id: 'perm-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    title: 'Run bash',
    displayName: 'Bash',
    description: 'Execute a bash command',
    suggestions: [],
    toolUseID: 'tu-1',
    createdAt: Date.now(),
    resolve: vi.fn() as PendingPermission['resolve'],
    signal: ac.signal,
    abortHandler: vi.fn(),
    timeoutTimer: null,
  }
  return { ...base, ...overrides } as PendingPermission
}

function makeQuestionPermission(overrides: Record<string, unknown> = {}): PendingPermission {
  const ac = new AbortController()
  const base: Record<string, unknown> = {
    kind: 'question',
    id: 'q-1',
    toolName: 'AskUserQuestion',
    questions: [
      {
        question: 'Pick a color',
        options: [
          { label: 'Red' },
          { label: 'Blue' },
        ],
      },
    ],
    toolUseID: 'tu-q1',
    createdAt: Date.now(),
    resolve: vi.fn(),
    signal: ac.signal,
    abortHandler: vi.fn(),
    timeoutTimer: null,
  }
  return { ...base, ...overrides } as unknown as PendingPermission
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('PermissionBroker', () => {
  let broker: PermissionBroker

  beforeEach(() => {
    vi.useFakeTimers()
    broker = new PermissionBroker({ permissionTimeoutMs: 5000 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ─── buildCanUseTool ────────────────────────────────────────────

  describe('buildCanUseTool', () => {
    it('auto-allows in bypassPermissions mode', async () => {
      const session = makeFakeSession({ permissionMode: 'bypassPermissions' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        signal: new AbortController().signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })
      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: { command: 'ls' },
        toolUseID: 'tu-1',
      })
    })

    it('creates a pending permission for tool calls in default mode', () => {
      const session = makeFakeSession()
      const onReq = vi.fn()
      const canUseTool = broker.buildCanUseTool(session, onReq)

      const ac = new AbortController()
      canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        signal: ac.signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })

      expect(session.pending.size).toBe(1)
      const pending = Array.from(session.pending.values())[0]
      expect(pending.kind).toBe('permission')
      expect(pending.toolName).toBe('Bash')
    })

    it('broadcasts permission request to subscribers', () => {
      const session = makeFakeSession()
      const received: unknown[] = []
      const subId = 'sub-1'
      session.permissionSubscribers.set(subId, {
        id: subId,
        push: (ev) => received.push(ev),
        end: vi.fn(),
      })

      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const ac = new AbortController()
      canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        signal: ac.signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })

      expect(received).toHaveLength(1)
      expect(received[0]).toEqual({ kind: 'request', payload: expect.objectContaining({ kind: 'permission', toolName: 'Bash' }) })
    })

    it('calls onPermissionRequest for global broadcast', () => {
      const session = makeFakeSession()
      const onReq = vi.fn()
      const canUseTool = broker.buildCanUseTool(session, onReq)
      const ac = new AbortController()
      canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        signal: ac.signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })

      expect(onReq).toHaveBeenCalledOnce()
      expect(onReq).toHaveBeenCalledWith(session, expect.objectContaining({ kind: 'permission', toolName: 'Bash' }))
    })

    it('auto-denies AskUserQuestion with malformed input', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('AskUserQuestion', { garbage: true }, {
        toolUseID: 'tu-malformed',
        signal: new AbortController().signal,
        title: 'Ask',
        displayName: 'AskUserQuestion',
        description: '',
        suggestions: [],
      })
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.interrupt).toBe(false)
      }
    })

    it('creates a question pending for AskUserQuestion with valid input', () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const ac = new AbortController()
      canUseTool('AskUserQuestion', {
        questions: [{ question: 'Color?', options: [{ label: 'Red' }] }],
      }, {
        toolUseID: 'tu-q1',
        signal: ac.signal,
        title: 'Ask',
        displayName: 'AskUserQuestion',
        description: '',
        suggestions: [],
      })

      expect(session.pending.size).toBe(1)
      const pending = Array.from(session.pending.values())[0]
      expect(pending.kind).toBe('question')
    })

    it('times out and auto-denies when permissionTimeoutMs > 0', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const ac = new AbortController()

      const promise = canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        signal: ac.signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })

      // Pending is created
      expect(session.pending.size).toBe(1)

      // Advance past timeout
      vi.advanceTimersByTime(5001)

      const result = await promise
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.interrupt).toBe(false)
      }
      expect(session.pending.size).toBe(0)
    })

    it('resolves with deny on abort', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const ac = new AbortController()

      const promise = canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        signal: ac.signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })

      ac.abort()
      const result = await promise
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.interrupt).toBe(false)
      }
      expect(session.pending.size).toBe(0)
    })
  })

  // ─── decide ─────────────────────────────────────────────────────

  describe('decide', () => {
    it('resolves a pending permission with allow', () => {
      const session = makeFakeSession()
      const pending = makeToolPermission()
      session.pending.set(pending.id, pending)

      broker.decide(session, pending.id, { behavior: 'allow' })

      expect(pending.resolve).toHaveBeenCalledWith(expect.objectContaining({
        behavior: 'allow',
        updatedInput: pending.kind === 'permission' ? pending.input : undefined,
      }))
      expect(session.pending.has(pending.id)).toBe(false)
    })

    it('resolves a pending permission with deny', () => {
      const session = makeFakeSession()
      const pending = makeToolPermission()
      session.pending.set(pending.id, pending)

      broker.decide(session, pending.id, { behavior: 'deny', message: 'nope' })

      expect(pending.resolve).toHaveBeenCalledWith(expect.objectContaining({
        behavior: 'deny',
        message: 'nope',
        interrupt: false,
      }))
      expect(session.pending.has(pending.id)).toBe(false)
    })

    it('promotes suggestions to session when persistForSession=true', () => {
      const session = makeFakeSession()
      const pending = makeToolPermission({
        suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'test' }], behavior: 'allow' as const, destination: 'userSettings' as const }],
      })
      session.pending.set(pending.id, pending)

      broker.decide(session, pending.id, { behavior: 'allow', persistForSession: true })

      expect(pending.resolve).toHaveBeenCalledWith(expect.objectContaining({
        updatedPermissions: expect.arrayContaining([
          expect.objectContaining({ destination: 'session' }),
        ]),
      }))
    })

    it('throws 404 for unknown pending id', () => {
      const session = makeFakeSession()
      expect(() => broker.decide(session, 'nonexistent', { behavior: 'allow' })).toThrow('not found')
    })

    it('throws 400 when deciding on a question', () => {
      const session = makeFakeSession()
      const pending = makeQuestionPermission()
      session.pending.set(pending.id, pending)
      expect(() => broker.decide(session, pending.id, { behavior: 'allow' })).toThrow('interactive question')
    })

    it('clears timeout timer on decide', () => {
      const session = makeFakeSession()
      const timer = setTimeout(() => {}, 99999)
      const pending = makeToolPermission({ timeoutTimer: timer })
      session.pending.set(pending.id, pending)

      broker.decide(session, pending.id, { behavior: 'allow' })

      expect(pending.resolve).toHaveBeenCalled()
    })
  })

  // ─── answerQuestion ─────────────────────────────────────────────

  describe('answerQuestion', () => {
    it('resolves a question with formatted answers', () => {
      const session = makeFakeSession()
      const pending = makeQuestionPermission()
      session.pending.set(pending.id, pending)

      broker.answerQuestion(session, pending.id, ['Red'])

      expect(pending.resolve).toHaveBeenCalledWith(expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
      }))
      // The message should contain the formatted answer
      const msg = (pending.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0].message
      expect(msg).toContain('Red')
    })

    it('encodes skipped questions as null', () => {
      const session = makeFakeSession()
      const pending = makeQuestionPermission({
        questions: [
          { question: 'Q1', options: [{ label: 'A' }] },
          { question: 'Q2', options: [{ label: 'B' }] },
        ],
      })
      session.pending.set(pending.id, pending)

      broker.answerQuestion(session, pending.id, ['A', null])

      const msg = (pending.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0].message
      const parsed = JSON.parse(msg)
      expect(parsed.answers[0].answer).toBe('A')
      expect(parsed.answers[1].answer).toBeNull()
    })

    it('throws 400 for non-question pending', () => {
      const session = makeFakeSession()
      const pending = makeToolPermission()
      session.pending.set(pending.id, pending)
      expect(() => broker.answerQuestion(session, pending.id, ['yes'])).toThrow('not an interactive question')
    })
  })

  // ─── denyAll ────────────────────────────────────────────────────

  describe('denyAll', () => {
    it('denies all pending permissions', () => {
      const session = makeFakeSession()
      const p1 = makeToolPermission({ id: 'p1' })
      const p2 = makeToolPermission({ id: 'p2' })
      session.pending.set('p1', p1)
      session.pending.set('p2', p2)

      broker.denyAll(session)

      expect(p1.resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'deny', message: 'session closed' }))
      expect(p2.resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'deny', message: 'session closed' }))
      expect(session.pending.size).toBe(0)
    })

    it('clears timeout timers', () => {
      const session = makeFakeSession()
      const timer = setTimeout(() => {}, 99999)
      const p = makeToolPermission({ timeoutTimer: timer })
      session.pending.set('p1', p)

      broker.denyAll(session)
      expect(p.resolve).toHaveBeenCalled()
    })
  })

  // ─── listPending ────────────────────────────────────────────────

  describe('listPending', () => {
    it('returns snapshots of all pending permissions', () => {
      const session = makeFakeSession()
      const p1 = makeToolPermission({ id: 'p1' })
      const q1 = makeQuestionPermission({ id: 'q1' })
      session.pending.set('p1', p1)
      session.pending.set('q1', q1)

      const list = broker.listPending(session)
      expect(list).toHaveLength(2)
      expect(list.find((s) => s.id === 'p1')).toEqual(expect.objectContaining({ kind: 'permission', toolName: 'Bash' }))
      expect(list.find((s) => s.id === 'q1')).toEqual(expect.objectContaining({ kind: 'question' }))
    })
  })

  // ─── subscribePermissions ───────────────────────────────────────

  describe('subscribePermissions', () => {
    it('returns a snapshot of pending and an iterable', () => {
      const session = makeFakeSession()
      const p = makeToolPermission({ id: 'p1' })
      session.pending.set('p1', p)

      const { snapshot, iterable, unsubscribe } = broker.subscribePermissions(session)
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0].id).toBe('p1')
      expect(iterable).toBeDefined()
      unsubscribe()
    })

    it('broadcasts events to the subscriber', async () => {
      const session = makeFakeSession()
      const { iterable, unsubscribe } = broker.subscribePermissions(session)

      // Trigger a permission request
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const ac = new AbortController()
      canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        signal: ac.signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })

      const iter = iterable[Symbol.asyncIterator]()
      const { value, done } = await iter.next()
      expect(done).toBe(false)
      expect(value).toEqual({ kind: 'request', payload: expect.objectContaining({ toolName: 'Bash' }) })

      unsubscribe()
    })

    it('removes subscriber on unsubscribe', () => {
      const session = makeFakeSession()
      const { unsubscribe } = broker.subscribePermissions(session)
      expect(session.permissionSubscribers.size).toBe(1)
      unsubscribe()
      expect(session.permissionSubscribers.size).toBe(0)
    })
  })
})
