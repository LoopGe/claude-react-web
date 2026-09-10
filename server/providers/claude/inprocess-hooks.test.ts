import { describe, expect, it, vi } from 'vitest'
import { buildInProcessHooks, capHookInput, parseHookBackgroundTasks, parseSubagentStopInput } from './inprocess-hooks.js'
import type { InProcessHookForward, InProcessSubagentStop, InProcessTaskSnapshot } from './inprocess-hooks.js'

describe('buildInProcessHooks', () => {
  it('registers a Stop hook matcher', () => {
    const hooks = buildInProcessHooks()
    expect((hooks as Record<string, unknown>).Stop).toBeDefined()
  })

  it('Stop callback forwards an inproc record with transcript_path', async () => {
    const forward = vi.fn()
    const hooks = buildInProcessHooks(forward as InProcessHookForward)
    const matchers = (hooks as Record<string, unknown>).Stop as { hooks: Array<(input: any) => Promise<unknown>> }[]
    const cb = matchers[0].hooks[0]
    const input = { session_id: 's1', transcript_path: '/tmp/t.json' }
    await cb(input)
    expect(forward).toHaveBeenCalledTimes(1)
    const [sid, event] = (forward as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(sid).toBe('s1')
    expect(event.kind).toBe('completed')
    expect(event.run.hookId).toBeTruthy()
    expect(event.run.hookName).toBe('inproc:Stop')
    expect(event.run.event).toBe('Stop')
    expect(event.run.hookInput).toContain('transcript_path')
  })

  it('does not forward when session_id is missing', async () => {
    const forward = vi.fn()
    const hooks = buildInProcessHooks(forward as InProcessHookForward)
    const matchers = (hooks as Record<string, unknown>).Stop as { hooks: Array<(input: any) => Promise<unknown>> }[]
    await matchers[0].hooks[0]({ transcript_path: '/tmp/t.json' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('does not forward when no forward is provided', async () => {
    const hooks = buildInProcessHooks()
    const matchers = (hooks as Record<string, unknown>).Stop as { hooks: Array<(input: any) => Promise<unknown>> }[]
    await expect(matchers[0].hooks[0]({ session_id: 's1', transcript_path: '/tmp/t.json' })).resolves.toBeUndefined()
  })

  it('defensiveHook swallows a throwing inner callback instead of rejecting', async () => {
    const forward = vi.fn()
    const hooks = buildInProcessHooks(forward as InProcessHookForward)
    // Force a bad input shape that the callback mishandles: non-object input.
    const matchers = (hooks as Record<string, unknown>).Stop as { hooks: Array<(input: any, toolUseID?: string, deps?: unknown) => Promise<unknown>> }[]
    await expect(matchers[0].hooks[0](null)).resolves.not.toThrow()
    // Default options object is used when the SDK omits it.
    await expect(matchers[0].hooks[0]({ session_id: 's1', transcript_path: '/tmp/t.json' }, 'tid', undefined)).resolves.not.toThrow()
  })
})

describe('parseHookBackgroundTasks', () => {
  it('narrows BackgroundTaskSummary entries to id + status', () => {
    const out = parseHookBackgroundTasks({
      session_id: 's1',
      background_tasks: [
        { id: 't-1', type: 'subagent', status: 'running', description: 'work', agent_type: 'explore' },
        { id: 't-2', type: 'shell', status: 'pending', description: 'npm test' },
      ],
    })
    expect(out).toEqual([
      { id: 't-1', status: 'running' },
      { id: 't-2', status: 'pending' },
    ])
  })

  it('distinguishes an empty in-flight set from a missing field', () => {
    // [] is the CLI positively reporting "nothing is in flight" — the signal
    // the sweep acts on. A missing/garbage field must NOT be read as empty.
    expect(parseHookBackgroundTasks({ background_tasks: [] })).toEqual([])
    expect(parseHookBackgroundTasks({ session_id: 's1' })).toBeNull()
    expect(parseHookBackgroundTasks({ background_tasks: 'nope' })).toBeNull()
    expect(parseHookBackgroundTasks(null)).toBeNull()
  })

  it('drops entries without a usable id and omits a non-string status', () => {
    const out = parseHookBackgroundTasks({
      background_tasks: [{ id: '' }, { id: 42 }, null, 'x', { id: 't-3', status: 7 }],
    })
    expect(out).toEqual([{ id: 't-3' }])
  })
})

describe('Stop hook task snapshot routing', () => {
  const stopCb = (
    forward?: InProcessHookForward,
    snapshot?: InProcessTaskSnapshot,
  ): ((input: unknown) => Promise<unknown>) => {
    const hooks = buildInProcessHooks(forward, snapshot)
    const matchers = (hooks as Record<string, unknown>).Stop as { hooks: Array<(input: any) => Promise<unknown>> }[]
    return matchers[0].hooks[0]
  }

  it('routes background_tasks to onTaskSnapshot with the session id', async () => {
    const onSnapshot = vi.fn()
    await stopCb(undefined, onSnapshot as InProcessTaskSnapshot)({
      session_id: 's1',
      background_tasks: [{ id: 't-1', status: 'running' }],
    })
    expect(onSnapshot).toHaveBeenCalledWith('s1', [{ id: 't-1', status: 'running' }])
  })

  it('forwards an empty array (nothing in flight) but not a missing field', async () => {
    const onSnapshot = vi.fn()
    const cb = stopCb(undefined, onSnapshot as InProcessTaskSnapshot)
    await cb({ session_id: 's1', background_tasks: [] })
    expect(onSnapshot).toHaveBeenCalledWith('s1', [])
    onSnapshot.mockClear()
    await cb({ session_id: 's1', transcript_path: '/tmp/t.json' })
    expect(onSnapshot).not.toHaveBeenCalled()
  })

  it('fires the snapshot even when no run-log forward is wired', async () => {
    // The reconciliation must not be coupled to the run-log plumbing.
    const onSnapshot = vi.fn()
    await stopCb(undefined, onSnapshot as InProcessTaskSnapshot)({ session_id: 's1', background_tasks: [] })
    expect(onSnapshot).toHaveBeenCalledTimes(1)
  })

  it('still forwards the run-log record alongside the snapshot', async () => {
    const forward = vi.fn()
    const onSnapshot = vi.fn()
    await stopCb(forward as InProcessHookForward, onSnapshot as InProcessTaskSnapshot)({
      session_id: 's1',
      transcript_path: '/tmp/t.json',
      background_tasks: [],
    })
    expect(forward).toHaveBeenCalledTimes(1)
    expect(onSnapshot).toHaveBeenCalledTimes(1)
  })

  it('skips the snapshot when session_id is missing', async () => {
    const onSnapshot = vi.fn()
    await stopCb(undefined, onSnapshot as InProcessTaskSnapshot)({ background_tasks: [{ id: 't-1' }] })
    expect(onSnapshot).not.toHaveBeenCalled()
  })
})

describe('parseSubagentStopInput', () => {
  it('narrows the real SubagentStop payload', () => {
    // Shape captured from a live probe (SDK 0.3.252 / CLI 2.1.252).
    expect(parseSubagentStopInput({
      hook_event_name: 'SubagentStop',
      session_id: '9ac54e57',
      agent_id: 'a9e4d7c8364c6bffa',
      agent_type: 'general-purpose',
      agent_transcript_path: 'C:\\Users\\x\\.claude\\projects\\p\\s\\subagents\\agent-a9e4d7c8364c6bffa.jsonl',
      last_assistant_message: 'pong',
      stop_hook_active: false,
    })).toEqual({
      sessionId: '9ac54e57',
      agentId: 'a9e4d7c8364c6bffa',
      transcriptPath: 'C:\\Users\\x\\.claude\\projects\\p\\s\\subagents\\agent-a9e4d7c8364c6bffa.jsonl',
      lastAssistantMessage: 'pong',
    })
  })

  it('requires session_id and agent_id, tolerates the rest missing', () => {
    expect(parseSubagentStopInput({ session_id: 's1' })).toBeNull()
    expect(parseSubagentStopInput({ agent_id: 'a1' })).toBeNull()
    expect(parseSubagentStopInput({ session_id: '', agent_id: 'a1' })).toBeNull()
    expect(parseSubagentStopInput(null)).toBeNull()
    // No transcript path / no text: still actionable (the settle path falls
    // back to an empty summary rather than failing).
    expect(parseSubagentStopInput({ session_id: 's1', agent_id: 'a1' })).toEqual({
      sessionId: 's1', agentId: 'a1',
    })
  })
})

describe('SubagentStop hook registration', () => {
  const subagentCb = (cb: InProcessSubagentStop): ((input: unknown) => Promise<unknown>) => {
    const hooks = buildInProcessHooks(undefined, undefined, cb)
    const matchers = (hooks as Record<string, unknown>).SubagentStop as { hooks: Array<(input: any) => Promise<unknown>> }[]
    return matchers[0].hooks[0]
  }

  it('is only registered when a handler is provided', () => {
    expect((buildInProcessHooks() as Record<string, unknown>).SubagentStop).toBeUndefined()
    expect((buildInProcessHooks(undefined, undefined, vi.fn()) as Record<string, unknown>).SubagentStop).toBeDefined()
  })

  it('routes the completion edge with the hook-provided transcript path', async () => {
    const onSubagentStop = vi.fn()
    await subagentCb(onSubagentStop as InProcessSubagentStop)({
      session_id: 's1',
      agent_id: 'a1',
      agent_transcript_path: '/tmp/agent-a1.jsonl',
      last_assistant_message: 'done',
    })
    expect(onSubagentStop).toHaveBeenCalledWith('s1', {
      agentId: 'a1',
      transcriptPath: '/tmp/agent-a1.jsonl',
      lastAssistantMessage: 'done',
    })
  })

  it('does not fire on an unusable payload and never rejects', async () => {
    const onSubagentStop = vi.fn()
    const cb = subagentCb(onSubagentStop as InProcessSubagentStop)
    await expect(cb({ session_id: 's1' })).resolves.not.toThrow()
    await expect(cb(null)).resolves.not.toThrow()
    expect(onSubagentStop).not.toHaveBeenCalled()
  })
})

describe('capHookInput', () => {
  it('caps a long string and preserves the head', () => {
    const s = 'a'.repeat(1000)
    const out = capHookInput(s, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.startsWith('a'.repeat(80))).toBe(true) // head preserved, truncation marker
  })

  it('returns short strings unchanged', () => {
    expect(capHookInput('hi', 100)).toBe('hi')
  })
})