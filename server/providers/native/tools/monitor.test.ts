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
import {
  createMonitorTool,
  MONITOR_BATCH_MS,
  MONITOR_GUIDANCE,
  type MonitorSpawnPort,
  type MonitorStreamEvents,
  type MonitorTarget,
} from './monitor.js'
import { createTaskStopTool } from './task-stop.js'
import { ToolInputError, type ToolContext } from './types.js'

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
    expect(injected[0]).toMatchObject({ taskId: 'tu-mon', description: 'watch', events: ['line1', 'line2', 'line3'] })
    // Event deliveries are NOT foldable completions: no tool-use-id, empty result
    // (the host renders them as neutral cards and never settles the task record).
    expect(injected[0].toolUseId).toBeUndefined()
    expect(injected[0].result).toBe('')

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

describe('Monitor background-task lifecycle', () => {
  it('TaskStop stops a running monitor and settles it stopped', async () => {
    const { port, calls } = stubSpawn()
    const injected: TaskNotificationFacts[] = []
    const frames: OperationalFrame[] = []
    const manager = new NativeTaskManager((f) => frames.push(f), (n) => injected.push(n))
    const tool = createMonitorTool({ inject: (n) => injected.push(n), spawn: port })
    const parent = new AbortController()

    const loop = manager.runForeground(
      { toolUseId: 'tu-stop', taskType: 'monitor', description: 'watch' },
      (signal) => tool.run({ description: 'watch', command: 'tail -f log' }, ctx('tu-stop', signal)),
      parent.signal,
    )
    expect(manager.background('tu-stop')).toBe(true)
    await expect(loop).resolves.toMatchObject({ text: expect.stringContaining('background') })
    // The detach announced a local_monitor task.
    expect(frames.find((f) => f.type === 'task/started')).toMatchObject({ taskType: 'local_monitor', isBackgrounded: true })

    calls[0].events.onEvent('early\n')
    await createTaskStopTool(manager).run({ task_id: 'tu-stop' }, ctx())
    expect(calls[0].handle.killed).toBe(true)
    const final = injected.find((n) => n.toolUseId === 'tu-stop')
    expect(final).toMatchObject({ status: 'stopped' })
    expect(manager.output('tu-stop', {}, ctx().signal)).resolves.toMatchObject({ text: expect.stringContaining('stopped') })
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
