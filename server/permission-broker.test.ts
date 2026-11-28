import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PermissionBroker, firstPartyReadOnlyTools, isQuestionResult, type BrokerPermissionResult } from './permission-broker.js'
import { firstPartyRegistry } from './sdk-tools/registry.js'
import type { Session, PendingPermission } from './session-types.js'
import { __setConfigForTest } from './config.js'

// The auto-mode classifier is stubbed so a test can assert which model the
// broker asks it to run on (the injected aux-fallback resolver) without an
// API call. Nothing else in this file exercises the classifier.
vi.mock('./auto-classifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auto-classifier.js')>()),
  classifyToolAction: vi.fn(async () => ({ allow: true, reason: 'mocked' })),
}))

// 鈹€鈹€鈹€ Helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function makeFakeSession(overrides: Partial<Session> = {}): Session {
  const ac = new AbortController()
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
      abortSignal: ac.signal,
      processExited: Promise.resolve(),
      abort: vi.fn(() => ac.abort()),
      destroy: vi.fn(),
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      supportedAgents: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({})),
      reconnectMcpServer: vi.fn(async () => {}),
      toggleMcpServer: vi.fn(async () => {}),
      setMcpServers: vi.fn(async () => ({})),
      reloadPlugins: vi.fn(async () => ({})),
      getContextUsage: vi.fn(async () => ({})),
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
    contextUsageSubscribers: new Set(),
    promptSuggestionSubscribers: new Set(),
    tasks: new Map(),
    taskSubscribers: new Set(),
    gitStatusSubscribers: new Set(),
    tasklistSubscribers: new Set(),
    messageStatusSubscribers: new Set(),
    withdrawnUuids: [],
    steeredInFlight: new Map(),
    commandSubscribers: new Set(),
    hookRuns: [],
    hookRunSubscribers: new Set(),
    recapSubscribers: new Set(),
    sessionClearedSubscribers: new Set(),
    pumpTask: Promise.resolve(),
    running: true,
    terminated: false,
    pendingTurns: 0,
    autoCompacting: false,
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
  }
  return { ...base, ...overrides } as unknown as PendingPermission
}

// 鈹€鈹€鈹€ Tests 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe('PermissionBroker', () => {
  let broker: PermissionBroker

  beforeEach(() => {
    vi.useFakeTimers()
    // () => false: the fixture provider has no CLI-side plan steering, so the
    // host plan gate applies (the native shape). The scoping tests below build
    // a () => true broker for the claude shape.
    broker = new PermissionBroker(() => undefined, () => false)
  })

  afterEach(() => {
    vi.useRealTimers()
    __setConfigForTest({ allowSensitivePathEdits: false })
  })

  // 鈹€鈹€鈹€ buildCanUseTool 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  describe('buildCanUseTool', () => {
    it('auto-allows in bypassPermissions mode', async () => {
      const session = makeFakeSession({ permissionMode: 'bypassPermissions' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
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

    it('uses one explicit per-call mode for dontAsk, bypass, and acceptEdits decisions', async () => {
      const session = makeFakeSession({ permissionMode: 'bypassPermissions', cwd: '/work/app' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const input = { file_path: '/work/app/src/x.ts', content: 'x' }
      const options = {
        toolUseID: 'tu-mode-override',
        requestId: 'req-mode-override',
        signal: new AbortController().signal,
        title: 'Write file', displayName: 'Write', description: '', suggestions: [],
      }

      const locked = await canUseTool('Write', input, { ...options, permissionMode: 'dontAsk' })
      expect(locked.behavior).toBe('deny')

      session.permissionMode = 'dontAsk'
      const bypassed = await canUseTool('Write', input, { ...options, permissionMode: 'bypassPermissions' })
      expect(bypassed.behavior).toBe('allow')

      session.permissionMode = 'default'
      const accepted = await canUseTool('Write', input, { ...options, permissionMode: 'acceptEdits' })
      expect(accepted.behavior).toBe('allow')
      expect(session.pending.size).toBe(0)
    })

    it('still prompts for sensitive paths in bypassPermissions mode by default', () => {
      const session = makeFakeSession({ permissionMode: 'bypassPermissions', cwd: '/work/app' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      canUseTool('Write', { file_path: '/work/app/.claude/settings.json', content: 'x' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Write file', displayName: 'Write', description: '', suggestions: [],
      })
      canUseTool('Bash', { command: 'cat /work/app/.git/config' }, {
        toolUseID: 'tu-2',
        requestId: 'req-tu-2',
        signal: new AbortController().signal,
        title: 'Run bash', displayName: 'Bash', description: '', suggestions: [],
      })
      expect(session.pending.size).toBe(2)
    })

    it('auto-allows sensitive paths in bypassPermissions mode when allowSensitivePathEdits is on', async () => {
      __setConfigForTest({ allowSensitivePathEdits: true })
      const session = makeFakeSession({ permissionMode: 'bypassPermissions', cwd: '/work/app' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const editResult = await canUseTool('Write', { file_path: '/work/app/.claude/settings.json', content: 'x' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Write file', displayName: 'Write', description: '', suggestions: [],
      })
      const bashResult = await canUseTool('Bash', { command: 'cat /work/app/.git/config' }, {
        toolUseID: 'tu-2',
        requestId: 'req-tu-2',
        signal: new AbortController().signal,
        title: 'Run bash', displayName: 'Bash', description: '', suggestions: [],
      })
      expect(editResult.behavior).toBe('allow')
      expect(bashResult.behavior).toBe('allow')
      expect(session.pending.size).toBe(0)
    })

    it('auto-allows edit tools targeting paths inside cwd in acceptEdits mode', async () => {
      const session = makeFakeSession({ permissionMode: 'acceptEdits', cwd: '/work/app' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const input = { file_path: '/work/app/src/x.ts', content: 'hi' }
      const result = await canUseTool('Write', input, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Write file',
        displayName: 'Write',
        description: '',
        suggestions: [],
      })
      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: input,
        toolUseID: 'tu-1',
      })
      // No prompt was raised.
      expect(session.pending.size).toBe(0)
    })

    it('still prompts for edit tools targeting paths OUTSIDE cwd in acceptEdits mode', () => {
      const session = makeFakeSession({ permissionMode: 'acceptEdits', cwd: '/work/app' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      canUseTool('Write', { file_path: '/etc/passwd', content: 'x' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Write file', displayName: 'Write', description: '', suggestions: [],
      })
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('Write')
    })

    it('still prompts for edit tools targeting sensitive paths inside cwd in acceptEdits mode', () => {
      const session = makeFakeSession({ permissionMode: 'acceptEdits', cwd: '/work/app' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      canUseTool('Write', { file_path: '/work/app/.git/config', content: 'x' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Write file', displayName: 'Write', description: '', suggestions: [],
      })
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('Write')
    })

    it('auto-allows sensitive-path edits in acceptEdits mode when allowSensitivePathEdits is on', async () => {
      __setConfigForTest({ allowSensitivePathEdits: true })
      const session = makeFakeSession({ permissionMode: 'acceptEdits', cwd: '/work/app' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const input = { file_path: '/work/app/.claude/settings.json', content: 'x' }
      const result = await canUseTool('Write', input, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Write file', displayName: 'Write', description: '', suggestions: [],
      })
      expect(result).toEqual({ behavior: 'allow', updatedInput: input, toolUseID: 'tu-1' })
      expect(session.pending.size).toBe(0)
    })

    it('still prompts for OUT-of-cwd edits in acceptEdits mode even when allowSensitivePathEdits is on', () => {
      __setConfigForTest({ allowSensitivePathEdits: true })
      const session = makeFakeSession({ permissionMode: 'acceptEdits', cwd: '/work/app' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      canUseTool('Write', { file_path: '/etc/passwd', content: 'x' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Write file', displayName: 'Write', description: '', suggestions: [],
      })
      expect(session.pending.size).toBe(1)
    })

    it('still prompts for non-edit tools (Bash) in acceptEdits mode', () => {
      const session = makeFakeSession({ permissionMode: 'acceptEdits' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('Bash')
    })

    it('auto-approves whitelisted filesystem Bash commands in acceptEdits mode', async () => {
      const session = makeFakeSession({ permissionMode: 'acceptEdits' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('Bash', { command: 'mkdir -p src/new' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })
      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: { command: 'mkdir -p src/new' },
        toolUseID: 'tu-1',
      })
      expect(session.pending.size).toBe(0)
    })

    it('still prompts for dangerous Bash (absolute path / shell features) in acceptEdits mode', () => {
      const session = makeFakeSession({ permissionMode: 'acceptEdits' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      // Absolute path — must NOT be auto-approved.
      canUseTool('Bash', { command: 'rm -rf /etc/passwd' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Run bash', displayName: 'Bash', description: '', suggestions: [],
      })
      // Shell chaining — must NOT be auto-approved.
      canUseTool('Bash', { command: 'mkdir ok && curl evil' }, {
        toolUseID: 'tu-2',
        requestId: 'req-tu-2',
        signal: new AbortController().signal,
        title: 'Run bash', displayName: 'Bash', description: '', suggestions: [],
      })
      expect(session.pending.size).toBe(2)
    })

    it('still raises a plan review for ExitPlanMode in acceptEdits mode', () => {
      const session = makeFakeSession({ permissionMode: 'acceptEdits' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      canUseTool('ExitPlanMode', { plan: 'do the thing' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Plan',
        displayName: 'ExitPlanMode',
        description: '',
        suggestions: [],
      })
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('ExitPlanMode')
    })

    it('carries the SDK defaultToNo / suppressAlwaysAllowRule hints onto the request snapshot', () => {
      const session = makeFakeSession()
      const onRequest = vi.fn()
      const canUseTool = broker.buildCanUseTool(session, onRequest)
      // No await: the pending promise resolves only on decide() — the snapshot
      // is broadcast synchronously inside the call.
      void canUseTool('Bash', { command: 'rm -rf build' }, {
        toolUseID: 'tu-hints',
        requestId: 'req-tu-hints',
        signal: new AbortController().signal,
        title: 'Dangerous command',
        displayName: 'Bash',
        description: '',
        suggestions: [],
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
        mcpServer: { name: 'linear', source: 'sdk' },
      })
      const pending = Array.from(session.pending.values())[0]
      expect(pending.kind).toBe('permission')
      if (pending.kind !== 'permission') throw new Error('expected a permission request')
      expect(pending.defaultToNo).toBe(true)
      expect(pending.suppressAlwaysAllowRule).toBe(true)
      // The wire snapshot (what the client dialog reads) must carry them too.
      expect(onRequest.mock.calls[0][1]).toMatchObject({
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
        mcpServer: { name: 'linear', source: 'sdk' },
      })
    })

    // 鈹€鈹€鈹€ dontAsk mode 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    const ctx = (toolUseID = 'tu-1') => ({
      toolUseID,
      requestId: `req-${toolUseID}`,
      signal: new AbortController().signal,
      title: '', displayName: '', description: '', suggestions: [],
    })

    it('dontAsk auto-allows read-only built-in tools', async () => {
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      for (const [name, input] of [
        ['Read', { file_path: 'a.txt' }],
        ['AttachmentRead', { id: 'upload-1' }],
      ] as const) {
        const result = await canUseTool(name, input, ctx())
        expect(result).toMatchObject({ behavior: 'allow' })
      }
      expect(session.pending.size).toBe(0)
    })

    it('auto auto-allows AttachmentRead without consulting the classifier', async () => {
      const { classifyToolAction } = await import('./auto-classifier.js')
      const mockClassify = vi.mocked(classifyToolAction)
      mockClassify.mockClear()
      const session = makeFakeSession({ permissionMode: 'auto' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('AttachmentRead', { id: 'upload-1' }, ctx())
      expect(result).toMatchObject({ behavior: 'allow' })
      expect(session.pending.size).toBe(0)
      expect(mockClassify).not.toHaveBeenCalled()
    })

    it('dontAsk auto-allows the Skill tool (a skill load is read-only)', async () => {
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('Skill', { skill: 'demo' }, ctx())
      expect(result).toMatchObject({ behavior: 'allow' })
      expect(session.pending.size).toBe(0)
    })

    it('dontAsk auto-allows the LS tool (a directory listing is read-only)', async () => {
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('LS', { path: '.' }, ctx())
      expect(result).toMatchObject({ behavior: 'allow' })
      expect(session.pending.size).toBe(0)
    })

    it('dontAsk auto-allows the native StructuredOutput capture tool', async () => {
      // The terminal capture records the run's answer — no filesystem
      // mutation — so a structured run (nested or one-shot) can finish under
      // CI lockdown. Inert for claude: no such tool exists there.
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('StructuredOutput', { result: 'x' }, ctx())
      expect(result).toMatchObject({ behavior: 'allow' })
      expect(session.pending.size).toBe(0)
    })

    it('auto auto-allows the Skill tool without consulting the classifier', async () => {
      // A skill load is read-only, so it belongs in SAFE_AUTO_TOOLS like
      // Read/Grep — no classifier round-trip, no prompt.
      const { classifyToolAction } = await import('./auto-classifier.js')
      const mockClassify = vi.mocked(classifyToolAction)
      mockClassify.mockClear()
      const session = makeFakeSession({ permissionMode: 'auto' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('Skill', { skill: 'demo' }, ctx())
      expect(result).toMatchObject({ behavior: 'allow' })
      expect(session.pending.size).toBe(0)
      expect(mockClassify).not.toHaveBeenCalled()
    })

    it('auto auto-allows the LS tool without consulting the classifier', async () => {
      const { classifyToolAction } = await import('./auto-classifier.js')
      const mockClassify = vi.mocked(classifyToolAction)
      mockClassify.mockClear()
      const session = makeFakeSession({ permissionMode: 'auto' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('LS', { path: '.' }, ctx())
      expect(result).toMatchObject({ behavior: 'allow' })
      expect(session.pending.size).toBe(0)
      expect(mockClassify).not.toHaveBeenCalled()
    })

    it('dontAsk auto-allows read-only Bash commands', async () => {
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('Bash', { command: 'git status' }, ctx())
      expect(result).toMatchObject({ behavior: 'allow' })
      expect(session.pending.size).toBe(0)
    })

    it('dontAsk auto-allows read-only first-party tools (permission seam)', async () => {
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('mcp__git-tools__git_status', {}, ctx())
      expect(result).toMatchObject({ behavior: 'allow' })
      expect(session.pending.size).toBe(0)
    })

    it('dontAsk still auto-DENIES first-party write tools (permission seam)', async () => {
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('mcp__git-tools__git_commit', { message: 'x' }, ctx())
      expect(result).toMatchObject({ behavior: 'deny', interrupt: false })
      expect(session.pending.size).toBe(0)
    })

    it('dontAsk auto-DENIES edits without prompting', async () => {
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('Write', { file_path: 'a', content: 'x' }, ctx())
      expect(result).toMatchObject({ behavior: 'deny', interrupt: false })
      // No prompt was raised — it's an immediate deny, not a pending request.
      expect(session.pending.size).toBe(0)
    })

    it('dontAsk auto-DENIES write Bash commands without prompting', async () => {
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('Bash', { command: 'rm x' }, ctx())
      expect(result).toMatchObject({ behavior: 'deny', interrupt: false })
      expect(session.pending.size).toBe(0)
    })

    it('dontAsk still raises a plan review for ExitPlanMode (ordering preserved)', () => {
      const session = makeFakeSession({ permissionMode: 'dontAsk' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      canUseTool('ExitPlanMode', { plan: 'p' }, ctx())
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('ExitPlanMode')
    })

    it('creates a pending permission for tool calls in default mode', () => {
      const session = makeFakeSession()
      const onReq = vi.fn()
      const canUseTool = broker.buildCanUseTool(session, onReq)

      const ac = new AbortController()
      canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
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
        requestId: 'req-tu-1',
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
        requestId: 'req-tu-1',
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
        requestId: 'req-tu-malformed',
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
        requestId: 'req-tu-q1',
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

    it('keeps AskUserQuestion pending indefinitely', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const ac = new AbortController()

      const promise = canUseTool('AskUserQuestion', {
        questions: [{ question: 'Color?', options: [{ label: 'Red' }] }],
      }, {
        toolUseID: 'tu-q1',
        requestId: 'req-tu-q1',
        signal: ac.signal,
        title: 'Ask',
        displayName: 'AskUserQuestion',
        description: '',
        suggestions: [],
      })

      expect(session.pending.size).toBe(1)
      const pending = Array.from(session.pending.values())[0]
      expect(pending.kind).toBe('question')

      vi.advanceTimersByTime(5001)

      expect(session.pending.size).toBe(1)
      broker.answerQuestion(session, pending.id, ['Red'])

      const result = await promise
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.message).toContain('Color?')
        expect(result.message).toContain('Red')
      }
      expect(session.pending.size).toBe(0)
    })

    // ─── AskUserQuestion answer marker ───────────────────────────────
    //
    // The native loop treats a denial as the ANSWER only when the broker
    // sets the internal question-result marker. Answered, clarified and
    // malformed results carry it; aborts and denyAll must not.

    const askOptions = (signal: AbortSignal) => ({
      toolUseID: 'tu-q1',
      requestId: 'req-tu-q1',
      signal,
      title: 'Ask',
      displayName: 'AskUserQuestion',
      description: '',
      suggestions: [],
    })

    it('marks an answered question as a question result', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const promise = canUseTool(
        'AskUserQuestion',
        { questions: [{ question: 'Color?', options: [{ label: 'Red' }] }] },
        askOptions(new AbortController().signal),
      )
      const pending = Array.from(session.pending.values())[0]
      broker.answerQuestion(session, pending.id, ['Red'])

      const result = await promise
      expect(result.behavior).toBe('deny')
      expect(isQuestionResult(result)).toBe(true)
    })

    it('marks a clarified question as a question result', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const promise = canUseTool(
        'AskUserQuestion',
        { questions: [{ question: 'Color?', options: [{ label: 'Red' }] }] },
        askOptions(new AbortController().signal),
      )
      const pending = Array.from(session.pending.values())[0]
      broker.clarifyQuestion(session, pending.id, 'tell me more')

      const result = await promise
      expect(result.behavior).toBe('deny')
      expect(isQuestionResult(result)).toBe(true)
    })

    it('marks a malformed immediate denial as a question result', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool(
        'AskUserQuestion',
        { garbage: true },
        askOptions(new AbortController().signal),
      )
      expect(result.behavior).toBe('deny')
      expect(isQuestionResult(result)).toBe(true)
    })

    it('does not mark an aborted question as a question result', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const ac = new AbortController()
      const promise = canUseTool(
        'AskUserQuestion',
        { questions: [{ question: 'Color?', options: [{ label: 'Red' }] }] },
        askOptions(ac.signal),
      )
      ac.abort()

      const result = await promise
      expect(result.behavior).toBe('deny')
      expect(isQuestionResult(result)).toBe(false)
    })

    it('does not mark a denyAll session-close question as a question result', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const promise = canUseTool(
        'AskUserQuestion',
        { questions: [{ question: 'Color?', options: [{ label: 'Red' }] }] },
        askOptions(new AbortController().signal),
      )
      broker.denyAll(session)

      const result = await promise
      expect(result.behavior).toBe('deny')
      expect(isQuestionResult(result)).toBe(false)
    })

    it('auto-approves whitelisted PowerShell edit commands in acceptEdits mode', async () => {
      const session = makeFakeSession({ permissionMode: 'acceptEdits', cwd: '/work/app' })
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const result = await canUseTool('PowerShell', { command: 'Remove-Item -Force src/tmp' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: new AbortController().signal,
        title: 'Run PowerShell',
        displayName: 'PowerShell',
        description: '',
        suggestions: [],
      })
      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: { command: 'Remove-Item -Force src/tmp' },
        toolUseID: 'tu-1',
      })
      expect(session.pending.size).toBe(0)
    })

    it('permission request stays pending indefinitely (no auto-deny timeout)', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const ac = new AbortController()

      const promise = canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
        signal: ac.signal,
        title: 'Run bash',
        displayName: 'Bash',
        description: '',
        suggestions: [],
      })

      // Pending is created
      expect(session.pending.size).toBe(1)

      // Advance well past any former default timeout — should still be pending
      vi.advanceTimersByTime(10 * 60 * 1000)

      expect(session.pending.size).toBe(1)

      // Resolve manually via decide
      const pendingId = Array.from(session.pending.keys())[0]
      broker.decide(session, pendingId, { behavior: 'allow' })
      const result = await promise
      expect(result.behavior).toBe('allow')
      expect(session.pending.size).toBe(0)
    })

    it('resolves with deny on abort', async () => {
      const session = makeFakeSession()
      const canUseTool = broker.buildCanUseTool(session, vi.fn())
      const ac = new AbortController()

      const promise = canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tu-1',
        requestId: 'req-tu-1',
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

  // ─── plan-mode enforcement ───────────────────────────────────────
  //
  // The gate reads the LIVE session.permissionMode, never the per-call
  // snapshot (ctx.permissionMode) that native main turns carry from turn
  // start. A call that falls through the gate raises a pending prompt
  // instead of settling, so the helper reports which of the two happened
  // rather than awaiting a prompt forever.

  describe('plan-mode enforcement', () => {
    type Mode = NonNullable<Session['permissionMode']>

    async function callBroker(opts: {
      toolName: string
      input?: Record<string, unknown>
      sessionMode: Mode
      ctxMode: Mode
      /** Provider-declared tool read-only hint (native ToolDef.readOnlyHint). */
      readOnlyHint?: boolean
      /** true = the provider enforces plan mode CLI-side (claude) — the host
       *  gate must stand down. Defaults to the outer host-enforced broker. */
      cliSidePlanSteering?: boolean
    }): Promise<{ decision: BrokerPermissionResult | null; session: Session }> {
      const session = makeFakeSession({ permissionMode: opts.sessionMode, cwd: '/work/app' })
      const b = opts.cliSidePlanSteering === undefined
        ? broker
        : new PermissionBroker(() => undefined, () => opts.cliSidePlanSteering!)
      const canUseTool = b.buildCanUseTool(session, vi.fn())
      const promise = canUseTool(opts.toolName, opts.input ?? {}, {
        toolUseID: 'tu-plan',
        requestId: 'req-tu-plan',
        signal: new AbortController().signal,
        title: '', displayName: '', description: '', suggestions: [],
        permissionMode: opts.ctxMode,
        ...(opts.readOnlyHint !== undefined ? { readOnlyHint: opts.readOnlyHint } : {}),
      })
      let decision: BrokerPermissionResult | null = null
      void promise.then((r) => { decision = r })
      // Immediate allow/deny paths settle in microtasks (no await precedes
      // the gate); a fall-through prompt stays pending. Flush microtasks so
      // either state is observable without advancing fake timers.
      await Promise.resolve()
      await Promise.resolve()
      return { decision, session }
    }

    function expectPlanDeny(decision: BrokerPermissionResult | null, session: Session): void {
      if (!decision || decision.behavior !== 'deny') throw new Error('expected an immediate plan-mode deny')
      expect(decision.message).toMatch(/plan mode/i)
      expect(decision.interrupt).toBe(false)
      expect(session.pending.size).toBe(0)
    }

    it('denies Edit when the live session mode is plan even if the call snapshot is default', async () => {
      const { decision, session } = await callBroker({
        toolName: 'Edit', input: { file_path: '/work/app/x.ts' }, sessionMode: 'plan', ctxMode: 'default',
      })
      expectPlanDeny(decision, session)
    })

    it('allows Edit when the live mode left plan even if the turn snapshot is plan', async () => {
      const { decision, session } = await callBroker({
        toolName: 'Edit', input: { file_path: '/work/app/x.ts' }, sessionMode: 'default', ctxMode: 'plan',
      })
      // No immediate deny — falls through to the normal default pipeline (prompt).
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('Edit')
    })

    it('allows Read in plan mode', async () => {
      const { decision, session } = await callBroker({
        toolName: 'Read', input: { file_path: '/work/app/a.txt' }, sessionMode: 'plan', ctxMode: 'plan',
      })
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('Read')
    })

    it('passes StructuredOutput with its readOnlyHint through the plan gate', async () => {
      // The capture tool is read-only evidence (ToolDef.readOnlyHint), so the
      // plan gate must not hard-deny it; it reaches the normal pipeline like
      // the built-in reads (a live plan session still reviews the call).
      const { decision, session } = await callBroker({
        toolName: 'StructuredOutput', input: { result: 'x' }, sessionMode: 'plan', ctxMode: 'plan', readOnlyHint: true,
      })
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('StructuredOutput')
    })

    it('denies mutating Bash in plan mode', async () => {
      const { decision, session } = await callBroker({
        toolName: 'Bash', input: { command: 'rm -rf x' }, sessionMode: 'plan', ctxMode: 'plan',
      })
      expectPlanDeny(decision, session)
    })

    it('plan gate precedes acceptEdits auto-allow', async () => {
      // Live plan, snapshot acceptEdits: Edit must still deny.
      const { decision, session } = await callBroker({
        toolName: 'Edit', input: { file_path: '/work/app/x.ts' }, sessionMode: 'plan', ctxMode: 'acceptEdits',
      })
      expectPlanDeny(decision, session)
    })

    it('plan gate precedes bypassPermissions auto-allow', async () => {
      const { decision, session } = await callBroker({
        toolName: 'Edit', input: { file_path: '/work/app/x.ts' }, sessionMode: 'plan', ctxMode: 'bypassPermissions',
      })
      expectPlanDeny(decision, session)
    })

    it.each([
      ['Write', { file_path: '/work/app/x.ts', content: 'x' }],
      ['NotebookEdit', { notebook_path: '/work/app/n.ipynb' }],
      ['MultiEdit', { file_path: '/work/app/x.ts', edits: [] }],
    ] as const)('denies %s in plan mode', async (toolName, input) => {
      const { decision, session } = await callBroker({ toolName, input, sessionMode: 'plan', ctxMode: 'plan' })
      expectPlanDeny(decision, session)
    })

    it.each([
      'ls && rm x',
      'git status > out.txt',
      'cat file; rm file',
    ])('fail-closed: denies unprovable Bash %j in plan mode', async (command) => {
      const { decision, session } = await callBroker({
        toolName: 'Bash', input: { command }, sessionMode: 'plan', ctxMode: 'plan',
      })
      expectPlanDeny(decision, session)
    })

    it('does not deny provably read-only Bash in plan mode', async () => {
      const { decision, session } = await callBroker({
        toolName: 'Bash', input: { command: 'git status' }, sessionMode: 'plan', ctxMode: 'plan',
      })
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
    })

    it('still raises a plan review for ExitPlanMode in plan mode', async () => {
      const { decision, session } = await callBroker({
        toolName: 'ExitPlanMode', input: { plan: 'do the thing' }, sessionMode: 'plan', ctxMode: 'plan',
      })
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('ExitPlanMode')
    })

    it('still auto-allows EnterPlanMode in plan mode', async () => {
      const { decision, session } = await callBroker({
        toolName: 'EnterPlanMode', input: {}, sessionMode: 'plan', ctxMode: 'plan',
      })
      expect(decision).toMatchObject({ behavior: 'allow' })
      expect(session.pending.size).toBe(0)
    })

    // Comprehensive read-only enforcement: the gate denies anything not
    // PROVABLY read-only, so a mutating MCP/first-party tool can never reach
    // a prompt a user could approve while the chip says plan.

    it.each([
      'mcp__git-tools__git_commit',
      'mcp__git-tools__git_checkout',
      'mcp__skills-tools__create',
      'mcp__skills-tools__delete',
      'mcp__marketplace-tools__remove',
    ])('denies mutating first-party tool %s in plan mode', async (toolName) => {
      const { decision, session } = await callBroker({ toolName, input: {}, sessionMode: 'plan', ctxMode: 'plan' })
      expectPlanDeny(decision, session)
    })

    it('passes read-only first-party tool mcp__git-tools__git_status in plan mode', async () => {
      const { decision, session } = await callBroker({
        toolName: 'mcp__git-tools__git_status', input: {}, sessionMode: 'plan', ctxMode: 'plan',
      })
      // No deny — falls through to the normal pipeline (default-mode prompt).
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
      expect(Array.from(session.pending.values())[0].toolName).toBe('mcp__git-tools__git_status')
    })

    it('fail-closed: denies an unknown MCP tool with no read-only evidence in plan mode', async () => {
      const { decision, session } = await callBroker({
        toolName: 'mcp__unknown__mutate', input: {}, sessionMode: 'plan', ctxMode: 'plan',
      })
      expectPlanDeny(decision, session)
    })

    it('passes an MCP tool whose definition declares readOnlyHint in plan mode', async () => {
      const { decision, session } = await callBroker({
        toolName: 'mcp__custom__inspect', input: {}, sessionMode: 'plan', ctxMode: 'plan', readOnlyHint: true,
      })
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
    })

    it('denies a tool whose definition declares readOnlyHint false in plan mode', async () => {
      const { decision, session } = await callBroker({
        toolName: 'mcp__custom__mutate', input: {}, sessionMode: 'plan', ctxMode: 'plan', readOnlyHint: false,
      })
      expectPlanDeny(decision, session)
    })

    it.each(['WebFetch', 'WebSearch'])('passes %s (read-only exploration) in plan mode', async (toolName) => {
      const { decision, session } = await callBroker({
        toolName, input: { url: 'https://example.test' }, sessionMode: 'plan', ctxMode: 'plan',
      })
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
    })

    it.each([
      ['TodoWrite', { todos: [] }],
      ['Agent', { description: 'd', prompt: 'p' }],
      ['Task', { description: 'd', prompt: 'p' }],
    ] as const)('denies non-read-only builtin %s in plan mode', async (toolName, input) => {
      const { decision, session } = await callBroker({ toolName, input, sessionMode: 'plan', ctxMode: 'plan' })
      expectPlanDeny(decision, session)
    })

    // Provider scoping: the claude CLI enforces plan mode itself BEFORE
    // canUseTool, so the host gate must not re-classify its already-allowed
    // calls (a quoted grep the CLI proved read-only fails isReadOnlyBash's
    // metachar gate and would otherwise be hard-denied here).

    it('does not fire for a cliSidePlanSteering provider: Edit in plan mode prompts, not denies', async () => {
      const { decision, session } = await callBroker({
        toolName: 'Edit', input: { file_path: '/work/app/x.ts' }, sessionMode: 'plan', ctxMode: 'plan',
        cliSidePlanSteering: true,
      })
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
    })

    it('does not fire for a cliSidePlanSteering provider: CLI-allowed quoted grep is not re-denied', async () => {
      const { decision, session } = await callBroker({
        toolName: 'Bash', input: { command: 'grep "x" f' }, sessionMode: 'plan', ctxMode: 'plan',
        cliSidePlanSteering: true,
      })
      expect(decision).toBeNull()
      expect(session.pending.size).toBe(1)
    })

    it('the same quoted grep IS denied for a host-enforced provider (scoping contrast)', async () => {
      const { decision, session } = await callBroker({
        toolName: 'Bash', input: { command: 'grep "x" f' }, sessionMode: 'plan', ctxMode: 'plan',
        cliSidePlanSteering: false,
      })
      expectPlanDeny(decision, session)
    })
  })

  // 鈹€鈹€鈹€ decide 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

    it('resolves a pending permission with deny + interrupt:true when requested', () => {
      const session = makeFakeSession()
      const pending = makeToolPermission()
      session.pending.set(pending.id, pending)

      broker.decide(session, pending.id, { behavior: 'deny', message: 'stop', interrupt: true })

      expect(pending.resolve).toHaveBeenCalledWith(expect.objectContaining({
        behavior: 'deny',
        message: 'stop',
        interrupt: true,
      }))
    })

    it('defaults interrupt to false when not provided on deny', () => {
      const session = makeFakeSession()
      const pending = makeToolPermission()
      session.pending.set(pending.id, pending)

      broker.decide(session, pending.id, { behavior: 'deny', message: 'nope' })

      expect(pending.resolve).toHaveBeenCalledWith(expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
      }))
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

    it('resolves pending on decide', () => {
      const session = makeFakeSession()
      const pending = makeToolPermission()
      session.pending.set(pending.id, pending)

      broker.decide(session, pending.id, { behavior: 'allow' })

      expect(pending.resolve).toHaveBeenCalled()
    })

    // ─── allowedPrompts verification ───
    // ExitPlanMode's tool_use input carries `allowedPrompts` (the list the UI
    // renders as "On approval, allow:"). This test pins down what the broker
    // actually hands back to the SDK when a plan is approved via the real UI
    // path (planTargetMode, no persistForSession — exactly what the
    // PermissionDialog sends). The expectation is the open question: does the
    // broker translate allowedPrompts into updatedPermissions rules?
    it('ExitPlanMode approval: echoes allowedPrompts in updatedInput but does NOT derive updatedPermissions', () => {
      const session = makeFakeSession()
      const allowedPrompts = [
        { tool: 'Bash', prompt: 'run tests' },
        { tool: 'Bash', prompt: 'install dependencies' },
      ]
      const pending = makeToolPermission({
        id: 'perm-plan',
        toolName: 'ExitPlanMode',
        input: { plan: 'do the thing', allowedPrompts },
        title: 'Plan ready',
        displayName: 'ExitPlanMode',
        description: '',
        suggestions: [],
        toolUseID: 'tu-plan',
      })
      session.pending.set(pending.id, pending)

      broker.decide(session, pending.id, {
        behavior: 'allow',
        planTargetMode: 'default',
      })

      expect(pending.resolve).toHaveBeenCalledTimes(1)
      const result = (pending.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0]

      // 1. The allow result echoes the original input unchanged, so
      //    allowedPrompts rides along back to the SDK inside updatedInput.
      expect(result.behavior).toBe('allow')
      expect(result.updatedInput).toEqual({ plan: 'do the thing', allowedPrompts })

      // 2. THE KEY ASSERTION: the broker does NOT translate allowedPrompts
      //    into updatedPermissions. Whatever makes the list effective must
      //    therefore happen inside the SDK/CLI subprocess, not in our code.
      expect(result.updatedPermissions).toBeUndefined()
    })
  })

  // 鈹€鈹€鈹€ answerQuestion 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

  describe('clarifyQuestion', () => {
    it('resolves with free-form context and broadcasts a clarified marker', async () => {
      const session = makeFakeSession()
      const pending = makeQuestionPermission()
      session.pending.set(pending.id, pending)
      const subscription = broker.subscribePermissions(session)
      const nextEvent = subscription.iterable[Symbol.asyncIterator]().next()

      broker.clarifyQuestion(session, pending.id, '  Why do you recommend red?  ')

      expect(session.pending.has(pending.id)).toBe(false)
      expect(pending.resolve).toHaveBeenCalledWith(expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
        toolUseID: pending.toolUseID,
        message: expect.stringContaining('Why do you recommend red?'),
      }))
      await expect(nextEvent).resolves.toEqual(expect.objectContaining({
        value: expect.objectContaining({
          kind: 'resolved',
          decision: expect.objectContaining({ questionResolution: 'clarified' }),
        }),
      }))
      subscription.unsubscribe()
    })

    it.each(['', '   ', 'x'.repeat(4001)])('rejects invalid feedback', (feedback) => {
      const session = makeFakeSession()
      const pending = makeQuestionPermission()
      session.pending.set(pending.id, pending)
      expect(() => broker.clarifyQuestion(session, pending.id, feedback)).toThrow()
      expect(session.pending.has(pending.id)).toBe(true)
    })

    it('rejects non-question pending requests', () => {
      const session = makeFakeSession()
      const pending = makeToolPermission()
      session.pending.set(pending.id, pending)
      expect(() => broker.clarifyQuestion(session, pending.id, 'explain')).toThrow('not an interactive question')
    })
  })

  // 鈹€鈹€鈹€ denyAll 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

    it('resolves all pending on denyAll', () => {
      const session = makeFakeSession()
      const p = makeToolPermission()
      session.pending.set('p1', p)

      broker.denyAll(session)
      expect(p.resolve).toHaveBeenCalled()
    })
  })

  // 鈹€鈹€鈹€ listPending 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

  // 鈹€鈹€鈹€ subscribePermissions 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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
        requestId: 'req-tu-1',
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

describe('auto mode classifier model', () => {
  it('classifies with the injected aux target (model + the session profile)', async () => {
    // With autoClassifierModel empty (the shipped default), the classifier
    // must run on the model the manager resolves for THIS session — its
    // model group's haiku tier, else its own model — and against that
    // session's own profile endpoint/token, not on a stale global default.
    const { classifyToolAction } = await import('./auto-classifier.js')
    const mockClassify = vi.mocked(classifyToolAction)
    mockClassify.mockClear()
    __setConfigForTest({ autoClassifierModel: '' })

    const target = { model: 'vendor/aux-model', baseUrl: 'https://gw-session', authToken: 'sk-session' }
    const injected = vi.fn(() => target)
    const autoBroker = new PermissionBroker(injected, () => false)
    const session = makeFakeSession({ id: 'auto-1', permissionMode: 'auto', cwd: '/work/app' })
    const canUseTool = autoBroker.buildCanUseTool(session, vi.fn())

    // Not an in-cwd edit and not a whitelisted filesystem command, so it skips
    // auto mode's acceptEdits fast path and actually reaches the classifier.
    await canUseTool('Bash', { command: 'git push --force origin main' }, {
      toolUseID: 'tu-auto',
      requestId: 'req-auto',
      signal: new AbortController().signal,
      title: 'Run bash',
      displayName: 'Bash',
      description: '',
      suggestions: [],
    })

    expect(injected).toHaveBeenCalledWith('auto-1')
    expect(mockClassify).toHaveBeenCalledTimes(1)
    expect(mockClassify.mock.calls[0][0]).toMatchObject({
      toolName: 'Bash',
      target,
    })
  })
})

describe('firstPartyReadOnlyTools (dynamic lookup)', () => {
  it('sees a first-party server registered AFTER this module loaded', () => {
    // The bug this guards: the exemption set used to be captured at module
    // load, so a server registered at runtime (appdebug, via enableDevMode)
    // was never exempt. Register one now — long after import — and assert the
    // lookup picks it up.
    firstPartyRegistry.register({
      name: 'regtest-late',
      description: 'regression probe',
      defaultEnabled: false,
      requiresCwd: false,
      buildTools: () => [],
      readOnlyToolNames: new Set(['probe']),
    })
    expect(firstPartyReadOnlyTools().has('mcp__regtest-late__probe')).toBe(true)
  })
})

// ─── Memory-root exemption (native auto-memory) ─────────────────────────────
//
// The exemption is REALPATH-based, so these fixtures are real tmpdirs (the
// lexical broker fixtures above cannot exercise it). The broker is built with
// () => false (no CLI-side plan steering — the native shape), so the host plan
// gate applies and the plan-mode denial pin is meaningful.

describe('memory-root exemption', () => {
  const memDirs: string[] = []
  let broker: PermissionBroker

  beforeEach(() => {
    broker = new PermissionBroker(() => undefined, () => false)
  })

  afterEach(async () => {
    __setConfigForTest({ allowSensitivePathEdits: false })
    for (const dir of memDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  async function memoryLayout(): Promise<{ base: string; own: string; claude: string; outside: string }> {
    const base = await mkdtemp(join(tmpdir(), 'broker-memory-'))
    memDirs.push(base)
    const own = join(base, 'own')
    const claude = join(base, 'claude')
    const outside = join(base, 'outside')
    await mkdir(own)
    await mkdir(claude)
    await mkdir(outside)
    await writeFile(join(own, 'existing.md'), 'own')
    await writeFile(join(claude, 'existing.md'), 'claude')
    return { base, own, claude, outside }
  }

  function nativeSession(roots: { own: string; claude: string | null }, mode: string, cwd: string, memory?: Session['memory']): Session {
    const session = makeFakeSession({ provider: 'native', permissionMode: mode as Session['permissionMode'], cwd, memoryRoots: roots, memory })
    // The exemption requires the core's realpath-validated roots to have settled
    // (handle.getAutoMemoryRoots). The fake handle reports the same roots the
    // lexical fixture uses — a real native session's seed validates these.
    session.handle.getAutoMemoryRoots = () => ({ ownDir: roots.own, claudeDir: roots.claude })
    return session
  }

  function ctx(toolUseID: string) {
    return {
      toolUseID,
      requestId: `req-${toolUseID}`,
      signal: new AbortController().signal,
      title: '', displayName: '', description: '', suggestions: [],
    }
  }

  it('default mode: Write inside ownDir is allowed without a prompt', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const input = { file_path: join(own, 'existing.md'), content: 'x' }
    const result = await canUseTool('Write', input, ctx('tu-own'))
    expect(result).toEqual({ behavior: 'allow', updatedInput: input, toolUseID: 'tu-own' })
    expect(session.pending.size).toBe(0)
  })

  it('default mode: Write to a NEW file inside ownDir is allowed (first-time save)', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const result = await canUseTool('Write', { file_path: join(own, 'new.md'), content: 'x' }, ctx('tu-new'))
    expect(result.behavior).toBe('allow')
    expect(session.pending.size).toBe(0)
  })

  it('default mode: Write inside claudeDir still prompts (write isolation)', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    canUseTool('Write', { file_path: join(claude, 'existing.md'), content: 'x' }, ctx('tu-claude'))
    // The realpath exemption checks are async, so the pending request lands
    // after they resolve — wait for it rather than reading synchronously.
    await vi.waitFor(() => expect(session.pending.size).toBe(1))
    expect(Array.from(session.pending.values())[0].toolName).toBe('Write')
  })

  it('default mode: Write outside cwd and both roots still prompts', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    canUseTool('Write', { file_path: join(outside, 'elsewhere.md'), content: 'x' }, ctx('tu-out'))
    await vi.waitFor(() => expect(session.pending.size).toBe(1))
  })

  it('default mode: Read inside claudeDir is allowed', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const input = { file_path: join(claude, 'existing.md') }
    const result = await canUseTool('Read', input, ctx('tu-read'))
    expect(result).toEqual({ behavior: 'allow', updatedInput: input, toolUseID: 'tu-read' })
    expect(session.pending.size).toBe(0)
  })

  it('default mode: Read inside ownDir is allowed', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const result = await canUseTool('Read', { file_path: join(own, 'existing.md') }, ctx('tu-read-own'))
    expect(result.behavior).toBe('allow')
    expect(session.pending.size).toBe(0)
  })

  it('plan mode: Write inside ownDir is DENIED (plan gate stays fail-closed)', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'plan', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const result = await canUseTool('Write', { file_path: join(own, 'existing.md'), content: 'x' }, ctx('tu-plan'))
    expect(result.behavior).toBe('deny')
    expect(session.pending.size).toBe(0)
  })

  it('dontAsk mode: Write inside ownDir is DENIED (restrictive posture unchanged)', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'dontAsk', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const result = await canUseTool('Write', { file_path: join(own, 'existing.md'), content: 'x' }, ctx('tu-dontask'))
    expect(result.behavior).toBe('deny')
    expect(session.pending.size).toBe(0)
  })

  it('acceptEdits mode: Write inside ownDir is allowed', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'acceptEdits', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const result = await canUseTool('Write', { file_path: join(own, 'existing.md'), content: 'x' }, ctx('tu-accept'))
    expect(result.behavior).toBe('allow')
    expect(session.pending.size).toBe(0)
  })

  it('acceptEdits mode: Write inside claudeDir still prompts (write isolation)', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'acceptEdits', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    canUseTool('Write', { file_path: join(claude, 'existing.md'), content: 'x' }, ctx('tu-accept-claude'))
    await vi.waitFor(() => expect(session.pending.size).toBe(1))
  })

  it('bypassPermissions mode: Write inside ownDir is allowed', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'bypassPermissions', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const result = await canUseTool('Write', { file_path: join(own, 'existing.md'), content: 'x' }, ctx('tu-bypass'))
    expect(result.behavior).toBe('allow')
    expect(session.pending.size).toBe(0)
  })

  it('no memoryRoots (claude session): out-of-cwd Write behavior is unchanged (prompts)', async () => {
    const { own, outside } = await memoryLayout()
    const session = makeFakeSession({ provider: 'claude', permissionMode: 'default', cwd: outside })
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    canUseTool('Write', { file_path: join(own, 'existing.md'), content: 'x' }, ctx('tu-claude-session'))
    expect(session.pending.size).toBe(1)
  })

  // Decision-integrity pin: a relative file_path must be judged against the
  // SESSION cwd (the base the tool writes against), never process.cwd(). Both
  // tests chdir so process.cwd() (base) deliberately differs from session.cwd
  // (base/proj), then restore in finally.
  it('relative file_path is judged against session.cwd, not process.cwd() (prompts when the session anchor escapes own)', async () => {
    const { base, own, claude } = await memoryLayout()
    const proj = join(base, 'proj')
    await mkdir(proj)
    const session = nativeSession({ own, claude }, 'default', proj)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const prevCwd = process.cwd()
    process.chdir(base)
    try {
      // From process.cwd() (base) this forward relative path resolves INSIDE
      // own — the old bare-resolve code would exempt it. From the session cwd
      // (proj) it lands in proj/own, outside own, so it must prompt.
      canUseTool('Write', { file_path: 'own/existing.md', content: 'x' }, ctx('tu-rel-escape'))
      await vi.waitFor(() => expect(session.pending.size).toBe(1))
    } finally {
      process.chdir(prevCwd)
    }
  })

  it('relative file_path that reaches own from session.cwd is allowed', async () => {
    const { base, own, claude } = await memoryLayout()
    const proj = join(base, 'proj')
    await mkdir(proj)
    const session = nativeSession({ own, claude }, 'default', proj)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const prevCwd = process.cwd()
    process.chdir(base)
    try {
      // '../own/existing.md' from proj resolves into own; from process.cwd()
      // (base) it would resolve outside own — so allowing proves the exemption
      // anchored at session.cwd, not process.cwd().
      const rel = relative(proj, join(own, 'existing.md'))
      const input = { file_path: rel, content: 'x' }
      const result = await canUseTool('Write', input, ctx('tu-rel-own'))
      expect(result).toEqual({ behavior: 'allow', updatedInput: input, toolUseID: 'tu-rel-own' })
      expect(session.pending.size).toBe(0)
    } finally {
      process.chdir(prevCwd)
    }
  })

  // §5.4 posture: the exemption is justified by the user's explicit opt-in via
  // the auto-memory switch, and by the core's realpath-validated resolve. Either
  // missing → the normal permission chain runs (no silent allowance).
  it('disabled auto-memory: Write inside ownDir prompts (no exemption)', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside, { autoMemoryEnabled: false })
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    canUseTool('Write', { file_path: join(own, 'existing.md'), content: 'x' }, ctx('tu-disabled'))
    await vi.waitFor(() => expect(session.pending.size).toBe(1))
  })

  it('disabled auto-memory: Read inside ownDir prompts too (whole exemption gated)', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside, { autoMemoryEnabled: false })
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    canUseTool('Read', { file_path: join(own, 'existing.md') }, ctx('tu-disabled-read'))
    await vi.waitFor(() => expect(session.pending.size).toBe(1))
  })

  it('core roots not settled (getAutoMemoryRoots null): Write inside ownDir prompts', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    // A rejected override never settles the seed — the broker must not exempt
    // against the lexical roots the core refused.
    session.handle.getAutoMemoryRoots = () => null
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    canUseTool('Write', { file_path: join(own, 'existing.md'), content: 'x' }, ctx('tu-unsettled'))
    await vi.waitFor(() => expect(session.pending.size).toBe(1))
  })

  it('sensitive file under the own root (.git/config) still prompts by default', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    canUseTool('Write', { file_path: join(own, '.git', 'config'), content: 'x' }, ctx('tu-sensitive'))
    await vi.waitFor(() => expect(session.pending.size).toBe(1))
  })

  it('sensitive basename under the own root (.bashrc) still prompts by default', async () => {
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    canUseTool('Write', { file_path: join(own, '.bashrc'), content: 'x' }, ctx('tu-sensitive-basename'))
    await vi.waitFor(() => expect(session.pending.size).toBe(1))
  })

  it('allowSensitivePathEdits opt-in: a sensitive file under the own root is exempt', async () => {
    __setConfigForTest({ allowSensitivePathEdits: true })
    const { own, claude, outside } = await memoryLayout()
    const session = nativeSession({ own, claude }, 'default', outside)
    const canUseTool = broker.buildCanUseTool(session, vi.fn())
    const result = await canUseTool('Write', { file_path: join(own, '.git', 'config'), content: 'x' }, ctx('tu-sensitive-optin'))
    expect(result.behavior).toBe('allow')
    expect(session.pending.size).toBe(0)
  })
})
