// server/providers/native/tools/monitor.test.ts
//
// Monitor watches a shell command's stdout lines (or a WebSocket's text frames)
// and injects each batch as a <task-notification> event delivery. The watch is
// a background task (taskType 'monitor'): the loop detaches it immediately, so
// the tool_result is the launch acknowledgement and the watch lives on past the
// call. These unit tests drive a STUB spawn port — no real subprocess / socket —
// so line buffering, the batch window, timeout and exit are deterministic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeTaskManager, type TaskNotificationFacts } from '../task-manager.js'
import type { OperationalFrame } from '../vocabulary/live-frame.js'
import { runTurn, type LoopDeps } from '../loop.js'
import { defaultFrameContext } from '../../native-frames.js'
import type { CanonicalEvent } from '../canonical.js'
import {
  createMonitorTool,
  MAX_EVENT_CHARS,
  MONITOR_BATCH_MS,
  MONITOR_GUIDANCE,
  type MonitorSpawnPort,
  type MonitorStreamEvents,
  type MonitorTarget,
} from './monitor.js'
import { createTaskStopTool } from './task-stop.js'
import { ToolInputError, type ToolContext } from './types.js'

const TRUNCATION_MARKER = '...[line truncated]'

interface StubCall {
  target: MonitorTarget
  events: MonitorStreamEvents
  handle: { killed: boolean; kill(): void }
}

/** A spawn port that records every watch and exposes its event sink + kill
 *  switch, so a test emits controlled stdout chunks / WS frames by hand. */
function stubSpawn(): { port: MonitorSpawnPort; calls: StubCall[] } {
  const calls: StubCall[] = []
  const port: MonitorSpawnPort = (target, events) => {
    const handle = {
      killed: false,
      kill() { this.killed = true },
    }
    calls.push({ target, events, handle })
    return handle
  }
  return { port, calls }
}

const ctx = (toolUseId = 'tu-mon', signal = new AbortController().signal): ToolContext =>
  ({ cwd: '/work', signal, toolUseId })

describe('Monitor tool metadata', () => {
  it('is a background monitor task ordered beside the task tools', () => {
    const { port } = stubSpawn()
    const tool = createMonitorTool({ inject: () => {}, spawn: port })
    expect(tool).toMatchObject({ name: 'Monitor', guidance: MONITOR_GUIDANCE, promptOrder: 84 })
    expect(tool.backgroundable).toMatchObject({ taskType: 'monitor' })
    expect(tool.backgroundable!.shouldBackground!({ description: 'd', command: 'c' })).toBe(true)
    expect(tool.backgroundable!.describe({ description: 'watch logs', command: 'c' })).toBe('watch logs')
    expect(tool.readOnlyHint).toBeUndefined()
    expect(tool.schema).toMatchObject({
      type: 'object',
      required: ['description'],
      properties: {
        description: { type: 'string' },
        timeout_ms: { type: 'number' },
        persistent: { type: 'boolean' },
        command: { type: 'string' },
        ws: { type: 'object' },
      },
    })
  })
})

describe('Monitor input validation', () => {
  const tool = () => createMonitorTool({ inject: () => {}, spawn: stubSpawn().port })

  it('rejects command and ws together', async () => {
    await expect(tool().run({ description: 'd', command: 'c', ws: { url: 'wss://x' } }, ctx()))
      .rejects.toThrow(ToolInputError)
  })

  it('rejects neither command nor ws', async () => {
    await expect(tool().run({ description: 'd' }, ctx())).rejects.toThrow(ToolInputError)
  })

  it('rejects a missing description', async () => {
    await expect(tool().run({ command: 'c' } as never, ctx())).rejects.toThrow(ToolInputError)
  })

  it('rejects a ws target without a url', async () => {
    await expect(tool().run({ description: 'd', ws: {} as never }, ctx())).rejects.toThrow(ToolInputError)
  })

  it('rejects a non-number or non-finite timeout_ms', async () => {
    await expect(tool().run({ description: 'd', command: 'c', timeout_ms: 'fast' as never }, ctx())).rejects.toThrow(ToolInputError)
    await expect(tool().run({ description: 'd', command: 'c', persistent: 'yes' as never }, ctx())).rejects.toThrow(/persistent must be a boolean/)
    await expect(tool().run({ description: 'd', command: 'c', timeout_ms: NaN }, ctx())).rejects.toThrow(ToolInputError)
    await expect(tool().run({ description: 'd', command: 'c', timeout_ms: Infinity }, ctx())).rejects.toThrow(ToolInputError)
  })

  it('exposes a total validate hook the loop calls before registration', () => {
    const t = tool()
    expect(() => t.validate!({ command: 'c' } as never)).toThrow(ToolInputError)
    expect(() => t.validate!({ description: 'd' } as never)).toThrow(ToolInputError)
    expect(() => t.validate!({ description: 'd', command: 'c', timeout_ms: NaN })).toThrow(ToolInputError)
    expect(() => t.validate!({ description: 'd', command: 'c' })).not.toThrow()
    expect(() => t.validate!({ description: 'd', ws: { url: 'wss://x' } })).not.toThrow()
  })
})

describe('Monitor command event stream', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('batches three stdout lines into ONE event notification, not three turns', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const running = tool.run({ description: 'watch', command: 'tail -f log' }, ctx())

    expect(calls).toHaveLength(1)
    expect(calls[0].target).toMatchObject({ kind: 'command', command: 'tail -f log', cwd: '/work' })
    calls[0].events.onEvent('line1\nline2\nline3\n')
    // The batch window is still open: nothing injected yet.
    expect(injected).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(MONITOR_BATCH_MS)
    expect(injected).toHaveLength(1)
    // An event batch is not a task status: no <task-id>/<status>, so the
    // client's settle-on-task-id consumer cannot hide a live watch.
    expect(injected[0]).toMatchObject({ description: 'watch', events: ['line1', 'line2', 'line3'] })
    expect(injected[0].taskId).toBeUndefined()
    expect(injected[0].status).toBeUndefined()
    // Event deliveries are NOT foldable completions: no tool-use-id, no result
    // (the host renders them as neutral cards and never settles the task record).
    expect(injected[0].toolUseId).toBeUndefined()
    expect(injected[0].result).toBeUndefined()

    calls[0].events.onEnd({ code: 0 })
    await expect(running).resolves.toMatchObject({ isError: false })
  })

  it('line-buffers across chunks and keeps the partial remainder', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const running = tool.run({ description: 'watch', command: 'c' }, ctx())

    calls[0].events.onEvent('li')
    calls[0].events.onEvent('ne1\nline2\npar')
    await vi.advanceTimersByTimeAsync(MONITOR_BATCH_MS)
    expect(injected).toHaveLength(1)
    expect(injected[0].events).toEqual(['line1', 'line2'])

    // The unterminated remainder flushes when the watch ends.
    calls[0].events.onEnd({ code: 0 })
    await running
    expect(injected.at(-1)!.events).toEqual(['par'])
  })

  it('opens a fresh batch window for a later burst', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const running = tool.run({ description: 'watch', command: 'c' }, ctx())

    calls[0].events.onEvent('a\n')
    await vi.advanceTimersByTimeAsync(MONITOR_BATCH_MS)
    calls[0].events.onEvent('b\n')
    await vi.advanceTimersByTimeAsync(MONITOR_BATCH_MS)
    expect(injected.map((n) => n.events)).toEqual([['a'], ['b']])

    calls[0].events.onEnd({ code: 0 })
    await running
  })

  it('kills the process and resolves an expiry outcome at timeout_ms', async () => {
    const { port, calls } = stubSpawn()
    const tool = createMonitorTool({ inject: () => {}, spawn: port })
    const running = tool.run({ description: 'watch', command: 'sleep 999', timeout_ms: 1000 }, ctx())

    await vi.advanceTimersByTimeAsync(1000)
    expect(calls[0].handle.killed).toBe(true)
    await expect(running).resolves.toMatchObject({ text: expect.stringContaining('1000ms') })
  })

  it('marks a non-zero exit as a failed watch', async () => {
    const { port, calls } = stubSpawn()
    const tool = createMonitorTool({ inject: () => {}, spawn: port })
    const running = tool.run({ description: 'watch', command: 'c' }, ctx())
    calls[0].events.onEnd({ code: 2 })
    await expect(running).resolves.toMatchObject({ isError: true, text: expect.stringContaining('exit code 2') })
  })

  it('surfaces a spawn error as a failed watch', async () => {
    const { port, calls } = stubSpawn()
    const tool = createMonitorTool({ inject: () => {}, spawn: port })
    const running = tool.run({ description: 'watch', command: 'c' }, ctx())
    calls[0].events.onEnd({ code: null, error: 'spawn ENOENT' })
    await expect(running).resolves.toMatchObject({ isError: true, text: expect.stringContaining('spawn ENOENT') })
  })
})

describe('Monitor WebSocket event stream', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('treats each text frame as an event and binary frames as a placeholder', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const running = tool.run({ description: 'watch', ws: { url: 'wss://x', protocols: ['v1'] } }, ctx())

    expect(calls[0].target).toMatchObject({ kind: 'ws', url: 'wss://x', protocols: ['v1'] })
    calls[0].events.onEvent('frame one')
    calls[0].events.onEvent(new Uint8Array([1, 2, 3]))
    calls[0].events.onEvent('frame two')
    await vi.advanceTimersByTimeAsync(MONITOR_BATCH_MS)
    expect(injected).toHaveLength(1)
    expect(injected[0].events).toEqual(['frame one', '[binary frame, 3 bytes]', 'frame two'])

    calls[0].events.onEnd({ code: null })
    await expect(running).resolves.toMatchObject({ isError: false })
  })
})

/** The metadata the loop hands `runForeground` for a Monitor call: the tool
 *  owns the detach acknowledgement, so a direct manager test must ask the tool
 *  for it exactly as the loop does (the loop wiring itself is pinned end to end
 *  in e2e-monitor). */
function monitorMetadata(tool: ReturnType<typeof createMonitorTool>, input: Parameters<typeof tool.run>[0], taskUseId: string) {
  return {
    toolUseId: taskUseId,
    taskType: 'monitor' as const,
    description: tool.backgroundable!.describe(input),
    launchAcknowledgement: tool.backgroundable!.launchAcknowledgement?.(input, taskUseId),
  }
}

describe('Monitor background-task lifecycle', () => {
  it('TaskStop stops a running monitor and settles it stopped', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const frames: OperationalFrame[] = []
    const manager = new NativeTaskManager((f) => frames.push(f), (n) => injected.push(n))
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const parent = new AbortController()
    const input = { description: 'watch', command: 'tail -f log' }

    const loop = manager.runForeground(
      monitorMetadata(tool, input, 'tu-stop'),
      (signal) => tool.run(input, ctx('tu-stop', signal)),
      parent.signal,
    )
    expect(manager.background('tu-stop')).toBe(true)
    // The launch acknowledgement is the CLI's sentence verbatim (deadline
    // phrase included), so MonitorBar can correlate TaskStop and settle
    // notifications with this row.
    await expect(loop).resolves.toMatchObject({
      text: 'Monitor started (task tu-stop, timeout 300000ms). You will be notified on each event. Keep working — do not poll or sleep. '
        + 'Events may arrive while you are waiting for the user — an event is not their reply. '
        + 'Stop it early with TaskStop task_id="tu-stop".',
    })
    // The detach announced a local_monitor task.
    expect(frames.find((f) => f.type === 'task/started')).toMatchObject({ taskType: 'local_monitor', isBackgrounded: true })

    calls[0].events.onEvent('early\n')
    await createTaskStopTool(manager).run({ task_id: 'tu-stop' }, ctx())
    expect(calls[0].handle.killed).toBe(true)
    const final = injected.find((n) => n.toolUseId === 'tu-stop')
    expect(final).toMatchObject({ status: 'stopped' })
    await expect(manager.output('tu-stop', {}, ctx().signal)).resolves.toMatchObject({ text: expect.stringContaining('stopped') })
  })

  it('injects a foldable expiry notification when the deadline fires', async () => {
    const { port } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const manager = new NativeTaskManager(() => {}, (n) => injected.push(n))
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const parent = new AbortController()

    const loop = manager.runForeground(
      { toolUseId: 'tu-exp', taskType: 'monitor', description: 'watch' },
      (signal) => tool.run({ description: 'watch', command: 'sleep 999', timeout_ms: 5 }, ctx('tu-exp', signal)),
      parent.signal,
    )
    manager.background('tu-exp')
    await loop

    await vi.waitFor(() => {
      const final = injected.find((n) => n.toolUseId === 'tu-exp')
      expect(final).toMatchObject({ status: 'completed', result: expect.stringContaining('5ms') })
    })
  })

  it('a persistent watch ignores timeout_ms and ends only on TaskStop', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const manager = new NativeTaskManager(() => {}, (n) => injected.push(n))
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const parent = new AbortController()

    const input = { description: 'watch', command: 'sleep 999', timeout_ms: 5, persistent: true }
    const loop = manager.runForeground(
      monitorMetadata(tool, input, 'tu-persist'),
      (signal) => tool.run(input, ctx('tu-persist', signal)),
      parent.signal,
    )
    manager.background('tu-persist')
    // A persistent watch's ack says so — and names no deadline.
    await expect(loop).resolves.toMatchObject({
      text: expect.stringContaining('Monitor started (task tu-persist, persistent — runs until TaskStop or session end).'),
    })

    // Past the requested deadline: a persistent watch is still alive.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls[0].handle.killed).toBe(false)
    expect(injected.find((n) => n.toolUseId === 'tu-persist')).toBeUndefined()

    await createTaskStopTool(manager).run({ task_id: 'tu-persist' }, ctx())
    expect(calls[0].handle.killed).toBe(true)
    await vi.waitFor(() => {
      expect(injected.find((n) => n.toolUseId === 'tu-persist')).toMatchObject({ status: 'stopped' })
    })
  })

  it('a natural exit settles completed and injects the foldable completion', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const manager = new NativeTaskManager(() => {}, (n) => injected.push(n))
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const parent = new AbortController()

    const loop = manager.runForeground(
      { toolUseId: 'tu-exit', taskType: 'monitor', description: 'watch' },
      (signal) => tool.run({ description: 'watch', command: 'c' }, ctx('tu-exit', signal)),
      parent.signal,
    )
    manager.background('tu-exit')
    await loop

    calls[0].events.onEvent('done\n')
    calls[0].events.onEnd({ code: 0 })
    await vi.waitFor(() => {
      const final = injected.find((n) => n.toolUseId === 'tu-exit')
      expect(final).toMatchObject({ status: 'completed' })
    })
    // The event delivery preceded the foldable completion, both on the sink.
    expect(injected.some((n) => n.events?.includes('done') && n.toolUseId === undefined)).toBe(true)
  })
})

describe('Monitor bounded buffers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('bounds a no-newline flood to a single truncated event', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const running = tool.run({ description: 'watch', command: 'c' }, ctx())

    // 200k characters with no newline — well past the cap, across many chunks.
    for (let i = 0; i < 20; i++) calls[0].events.onEvent('x'.repeat(10_000))
    calls[0].events.onEvent('\n')
    await vi.advanceTimersByTimeAsync(MONITOR_BATCH_MS)
    expect(injected).toHaveLength(1)
    expect(injected[0].events).toEqual(['x'.repeat(MAX_EVENT_CHARS) + TRUNCATION_MARKER])

    calls[0].events.onEnd({ code: 0 })
    await running
  })

  it('truncates a single oversized complete line', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const running = tool.run({ description: 'watch', command: 'c' }, ctx())

    calls[0].events.onEvent('y'.repeat(MAX_EVENT_CHARS + 5_000) + '\n')
    await vi.advanceTimersByTimeAsync(MONITOR_BATCH_MS)
    expect(injected[0].events).toEqual(['y'.repeat(MAX_EVENT_CHARS) + TRUNCATION_MARKER])

    calls[0].events.onEnd({ code: 0 })
    await running
  })

  it('caps an oversized WS text frame', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const running = tool.run({ description: 'watch', ws: { url: 'wss://x' } }, ctx())

    calls[0].events.onEvent('z'.repeat(MAX_EVENT_CHARS + 100))
    await vi.advanceTimersByTimeAsync(MONITOR_BATCH_MS)
    expect(injected[0].events).toEqual(['z'.repeat(MAX_EVENT_CHARS) + TRUNCATION_MARKER])

    calls[0].events.onEnd({ code: null })
    await running
  })
})

describe('Monitor input validation through the real loop', () => {
  it('a missing description is a clean error tool result — no background record, no injection', async () => {
    const { port } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const managerFrames: OperationalFrame[] = []
    const manager = new NativeTaskManager((f) => managerFrames.push(f), (n) => injected.push(n))
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })

    const start: CanonicalEvent = { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } }
    const scripts: CanonicalEvent[][] = [
      [
        start,
        { kind: 'block_start', index: 0, block: { type: 'tool_use', id: 'mon-1', name: 'Monitor' } },
        { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify({ command: 'tail -f log' }) } },
        { kind: 'block_end', index: 0 },
        { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
      ],
      [
        start,
        { kind: 'block_start', index: 0, block: { type: 'text' } },
        { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'recovered' } },
        { kind: 'block_end', index: 0 },
        { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
      ],
    ]
    let call = 0
    const requests: unknown[] = []
    const deps: LoopDeps = {
      stream: async function* (req) {
        requests.push(structuredClone(req.messages))
        for (const ev of scripts[call++] ?? []) yield ev
      },
      tools: [tool],
      cwd: '/work',
      tasks: manager,
      requestPermission: async (_t, input) => ({ allowed: true, input }),
      emit: () => {},
      persistToolResult: () => {},
      attachmentProjection: {},
      system: 'SYS',
    }

    const res = await runTurn(
      deps, defaultFrameContext('sess'), [],
      { role: 'user', content: [{ type: 'text', text: 'go' }] }, 'm1', new AbortController().signal,
    )

    // The turn recovers via an error tool result, not an errored wake turn.
    expect(res.isError).toBe(false)
    expect(res.finalText).toBe('recovered')
    // The wire carries a clean ToolInputError tool result for the Monitor call.
    const lastMsg = (requests[1] as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: Array<{ text: string }> }> }>).at(-1)!
    const tr = lastMsg.content.find((b) => b.type === 'tool_result')!
    expect(tr.tool_use_id).toBe('mon-1')
    expect(tr.is_error).toBe(true)
    expect(tr.content![0].text).toContain('description is required')
    // Nothing was registered or injected: no lost injection, no undefined-field wake.
    expect(managerFrames.some((f) => f.type === 'task/started')).toBe(false)
    expect(injected).toHaveLength(0)
    await expect(manager.output('mon-1', {}, new AbortController().signal))
      .resolves.toMatchObject({ text: expect.stringContaining('Unknown'), isError: true })
  })
})
