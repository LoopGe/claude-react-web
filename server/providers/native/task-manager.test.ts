// server/providers/native/task-manager.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { Frame } from './frames.js'
import { NativeTaskManager, type NativeTaskMetadata } from './task-manager.js'
import type { ToolOutcome } from './tools/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function metadata(toolUseId: string, taskType: NativeTaskMetadata['taskType'] = 'shell'): NativeTaskMetadata {
  return { toolUseId, taskType, description: `description for ${toolUseId}` }
}

function setup() {
  const frames: Frame[] = []
  const manager = new NativeTaskManager((frame) => frames.push(frame as Frame))
  return { manager, frames }
}

function notifications(frames: Frame[]): Frame[] {
  return frames.filter((frame) => frame.type === 'system' && frame.subtype === 'task_notification')
}

describe('NativeTaskManager', () => {
  it('returns a real foreground outcome without emitting task frames', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const parent = new AbortController()

    const waiting = manager.runForeground(metadata('tu-foreground'), () => execution.promise, parent.signal)
    execution.resolve({ text: 'real foreground output' })

    await expect(waiting).resolves.toEqual({ text: 'real foreground output' })
    expect(frames).toEqual([])
  })

  it('detaches with a TaskOutput acknowledgement while execution remains unresolved', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    let executionSettled = false
    void execution.promise.then(() => { executionSettled = true })
    const parent = new AbortController()

    const waiting = manager.runForeground(metadata('tu-detach'), () => execution.promise, parent.signal)
    expect(manager.background('tu-detach')).toBe(true)

    await expect(waiting).resolves.toEqual({
      text: 'Task tu-detach is running in the background.\nUse TaskOutput with task_id="tu-detach" to retrieve its final output.',
      isError: false,
    })
    expect(executionSettled).toBe(false)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      type: 'system',
      subtype: 'task_started',
      task_id: 'tu-detach',
      tool_use_id: 'tu-detach',
      task_type: 'local_bash',
      description: 'description for tu-detach',
      is_backgrounded: true,
    })
    expect(typeof frames[0].receivedAt).toBe('number')

    execution.resolve({ text: 'eventual output' })
    await flush()
  })

  it('emits the real completion as a task notification and never as a tool result', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-complete'), () => execution.promise, new AbortController().signal)
    manager.background('tu-complete')
    await waiting

    execution.resolve({ text: 'real final report' })
    await flush()

    expect(notifications(frames)).toHaveLength(1)
    expect(notifications(frames)[0]).toMatchObject({
      task_id: 'tu-complete',
      tool_use_id: 'tu-complete',
      description: 'description for tu-complete',
      status: 'completed',
      result: 'real final report',
    })
    expect(frames.some((frame) => frame.type === 'result')).toBe(false)
    expect(frames.some((frame) => frame.type === 'user' && Array.isArray(frame.message?.content)
      && frame.message.content.some((block: { type?: string }) => block.type === 'tool_result'))).toBe(false)
  })

  it('detaches every foreground record with no id and rejects unknown or terminal ids', async () => {
    const { manager } = setup()
    const first = deferred<ToolOutcome>()
    const second = deferred<ToolOutcome>()
    const firstWait = manager.runForeground(metadata('tu-all-1'), () => first.promise, new AbortController().signal)
    const secondWait = manager.runForeground(metadata('tu-all-2'), () => second.promise, new AbortController().signal)

    expect(manager.background('missing')).toBe(false)
    expect(manager.background()).toBe(true)
    await expect(firstWait).resolves.toMatchObject({ isError: false })
    await expect(secondWait).resolves.toMatchObject({ isError: false })
    expect(manager.background()).toBe(false)

    first.resolve({ text: 'first done' })
    second.resolve({ text: 'second done' })
    await flush()
    expect(manager.background('tu-all-1')).toBe(false)
    expect(manager.background('tu-all-2')).toBe(false)
  })

  it('rejects stop for an unknown or still-foreground task', async () => {
    const { manager } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-not-detached'), () => execution.promise, new AbortController().signal)

    await expect(manager.stop('missing')).rejects.toThrow(/unknown/i)
    await expect(manager.stop('tu-not-detached')).rejects.toThrow(/not backgrounded/i)

    manager.background('tu-not-detached')
    await waiting
    execution.resolve({ text: 'done' })
    await flush()
  })

  it('keeps the parent abort subscription while foreground', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const parent = new AbortController()
    let taskSignal!: AbortSignal
    const waiting = manager.runForeground(metadata('tu-parent-before'), (signal) => {
      taskSignal = signal
      return execution.promise
    }, parent.signal)

    parent.abort()
    expect(taskSignal.aborted).toBe(true)
    execution.resolve({ text: 'aborted', isError: true })
    await expect(waiting).resolves.toEqual({ text: 'aborted', isError: true })
    expect(frames).toEqual([])
  })

  it('removes the parent abort subscription on detach', async () => {
    const { manager } = setup()
    const execution = deferred<ToolOutcome>()
    const parent = new AbortController()
    let taskSignal!: AbortSignal
    const waiting = manager.runForeground(metadata('tu-parent-after'), (signal) => {
      taskSignal = signal
      return execution.promise
    }, parent.signal)
    manager.background('tu-parent-after')
    await waiting

    parent.abort()
    expect(taskSignal.aborted).toBe(false)
    execution.resolve({ text: 'survived interrupt' })
    await flush()
    expect(manager.background('tu-parent-after')).toBe(false)
  })

  it('detaches nested work without detaching its foreground parent', async () => {
    const { manager, frames } = setup()
    const outerExecution = deferred<ToolOutcome>()
    const childExecution = deferred<ToolOutcome>()
    let childWait!: Promise<ToolOutcome>
    const outerWait = manager.runForeground(metadata('tu-outer', 'subagent'), (outerSignal) => {
      childWait = manager.runForeground(metadata('tu-child'), () => childExecution.promise, outerSignal, 'tu-outer')
      return outerExecution.promise
    }, new AbortController().signal)

    expect(manager.background('tu-child')).toBe(true)
    await expect(childWait).resolves.toMatchObject({ isError: false })
    await expect(manager.stop('tu-outer')).rejects.toThrow(/not backgrounded/i)
    expect(frames.filter((frame) => frame.subtype === 'task_started').map((frame) => frame.task_id)).toEqual(['tu-child'])

    outerExecution.resolve({ text: 'outer report' })
    childExecution.resolve({ text: 'child output' })
    await expect(outerWait).resolves.toEqual({ text: 'outer report' })
    await flush()
  })

  it('stopping an outer task aborts attached children but spares an independently detached child', async () => {
    const { manager } = setup()
    const detachedChildExecution = deferred<ToolOutcome>()
    let detachedChildSignal!: AbortSignal
    let attachedChildSignal!: AbortSignal
    let detachedChildWait!: Promise<ToolOutcome>
    let attachedChildWait!: Promise<ToolOutcome>

    const outerWait = manager.runForeground(metadata('tu-outer-stop', 'subagent'), (outerSignal) => {
      detachedChildWait = manager.runForeground(metadata('tu-child-free'), (signal) => {
        detachedChildSignal = signal
        return detachedChildExecution.promise
      }, outerSignal, 'tu-outer-stop')
      attachedChildWait = manager.runForeground(metadata('tu-child-attached'), (signal) => {
        attachedChildSignal = signal
        return new Promise<ToolOutcome>((resolve) => {
          signal.addEventListener('abort', () => resolve({ text: 'child aborted', isError: true }), { once: true })
        })
      }, outerSignal, 'tu-outer-stop')
      return new Promise<ToolOutcome>((resolve) => {
        outerSignal.addEventListener('abort', () => resolve({ text: 'outer aborted', isError: true }), { once: true })
      })
    }, new AbortController().signal)

    manager.background('tu-child-free')
    manager.background('tu-outer-stop')
    await detachedChildWait
    await outerWait
    await manager.stop('tu-outer-stop')

    expect(attachedChildSignal.aborted).toBe(true)
    await expect(attachedChildWait).resolves.toEqual({ text: 'child aborted', isError: true })
    expect(detachedChildSignal.aborted).toBe(false)

    detachedChildExecution.resolve({ text: 'independent result' })
    await flush()
  })

  it('stop waits for observed settlement and maps the terminal status to stopped', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    let taskSignal!: AbortSignal
    const waiting = manager.runForeground(metadata('tu-stop'), (signal) => {
      taskSignal = signal
      return execution.promise
    }, new AbortController().signal)
    manager.background('tu-stop')
    await waiting

    let stopReturned = false
    const stopping = manager.stop('tu-stop').then(() => { stopReturned = true })
    expect(taskSignal.aborted).toBe(true)
    await flush()
    expect(stopReturned).toBe(false)

    execution.resolve({ text: 'partial output before stop' })
    await stopping
    expect(notifications(frames)).toHaveLength(1)
    expect(notifications(frames)[0]).toMatchObject({ status: 'stopped', result: 'partial output before stop' })
  })

  it('maps error outcomes to failed and successful outcomes to completed', async () => {
    const { manager, frames } = setup()
    const failed = deferred<ToolOutcome>()
    const completed = deferred<ToolOutcome>()
    const failedWait = manager.runForeground(metadata('tu-failed'), () => failed.promise, new AbortController().signal)
    const completedWait = manager.runForeground(metadata('tu-completed'), () => completed.promise, new AbortController().signal)
    manager.background('tu-failed')
    manager.background('tu-completed')
    await failedWait
    await completedWait

    failed.resolve({ text: 'failure details', isError: true })
    completed.resolve({ text: 'success details' })
    await flush()

    const byId = new Map(notifications(frames).map((frame) => [frame.task_id, frame]))
    expect(byId.get('tu-failed')).toMatchObject({ status: 'failed', result: 'failure details' })
    expect(byId.get('tu-completed')).toMatchObject({ status: 'completed', result: 'success details' })
  })

  it('observes execution rejection as a failed outcome after detach', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-rejected'), () => execution.promise, new AbortController().signal)
    manager.background('tu-rejected')
    await waiting

    execution.reject(new Error('worker crashed'))
    await flush()

    expect(notifications(frames)[0]).toMatchObject({ status: 'failed', result: 'worker crashed' })
  })

  it('returns an error for an unknown output task id', async () => {
    const { manager } = setup()

    await expect(manager.output('missing', {}, new AbortController().signal)).resolves.toMatchObject({
      text: expect.stringMatching(/unknown or expired/i),
      isError: true,
    })
  })

  it('reads running and terminal outcomes without blocking', async () => {
    const { manager } = setup()
    const running = deferred<ToolOutcome>()
    const completed = deferred<ToolOutcome>()
    const failed = deferred<ToolOutcome>()
    const waits = [
      manager.runForeground(metadata('tu-running'), () => running.promise, new AbortController().signal),
      manager.runForeground(metadata('tu-read-completed'), () => completed.promise, new AbortController().signal),
      manager.runForeground(metadata('tu-read-failed'), () => failed.promise, new AbortController().signal),
    ]
    manager.background()
    await Promise.all(waits)

    await expect(manager.output('tu-running', {}, new AbortController().signal)).resolves.toEqual({
      text: 'Task tu-running is still running.',
      isError: false,
    })
    completed.resolve({ text: 'completed output' })
    failed.resolve({ text: 'failed output', isError: true })
    await flush()
    await expect(manager.output('tu-read-completed', {}, new AbortController().signal)).resolves.toEqual({
      text: 'Task tu-read-completed completed.\ncompleted output',
      isError: false,
    })
    await expect(manager.output('tu-read-failed', {}, new AbortController().signal)).resolves.toEqual({
      text: 'Task tu-read-failed failed.\nfailed output',
      isError: true,
    })

    running.resolve({ text: 'eventually done' })
    await flush()
  })

  it('resolves a blocking output read with the terminal outcome', async () => {
    const { manager } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-blocking'), () => execution.promise, new AbortController().signal)
    manager.background('tu-blocking')
    await waiting

    const reading = manager.output('tu-blocking', { block: true }, new AbortController().signal)
    execution.resolve({ text: 'blocking final output' })

    await expect(reading).resolves.toEqual({
      text: 'Task tu-blocking completed.\nblocking final output',
      isError: false,
    })
  })

  it('times out as a non-error running outcome without changing task state', async () => {
    vi.useFakeTimers()
    try {
      const { manager, frames } = setup()
      const execution = deferred<ToolOutcome>()
      const waiting = manager.runForeground(metadata('tu-timeout'), () => execution.promise, new AbortController().signal)
      manager.background('tu-timeout')
      await waiting

      let settled = false
      const reading = manager.output('tu-timeout', { block: true, timeout: 25 }, new AbortController().signal)
        .then((outcome) => { settled = true; return outcome })
      await vi.advanceTimersByTimeAsync(24)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await expect(reading).resolves.toEqual({
        text: 'Task tu-timeout is still running.',
        isError: false,
      })
      await expect(manager.output('tu-timeout', {}, new AbortController().signal)).resolves.toMatchObject({
        text: expect.stringContaining('still running'),
        isError: false,
      })
      expect(notifications(frames)).toEqual([])
      expect(vi.getTimerCount()).toBe(0)

      execution.resolve({ text: 'completed after timeout' })
      await flush()
      expect(notifications(frames)[0]).toMatchObject({ status: 'completed', result: 'completed after timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts only the blocking output read and leaves the task running', async () => {
    const { manager } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-output-abort'), () => execution.promise, new AbortController().signal)
    manager.background('tu-output-abort')
    await waiting
    const caller = new AbortController()

    const reading = manager.output('tu-output-abort', { block: true }, caller.signal)
    caller.abort()

    await expect(reading).resolves.toEqual({ text: 'TaskOutput aborted', isError: true })
    await expect(manager.output('tu-output-abort', {}, new AbortController().signal)).resolves.toMatchObject({
      text: expect.stringContaining('still running'),
      isError: false,
    })
    execution.resolve({ text: 'survived output abort' })
    await flush()
  })

  it('returns stopped status and output produced before the stop', async () => {
    const { manager } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-stopped-output'), () => execution.promise, new AbortController().signal)
    manager.background('tu-stopped-output')
    await waiting

    const stopping = manager.stop('tu-stopped-output')
    execution.resolve({ text: 'partial stopped output', isError: true })
    await stopping

    await expect(manager.output('tu-stopped-output', {}, new AbortController().signal)).resolves.toEqual({
      text: 'Task tu-stopped-output stopped.\npartial stopped output',
      isError: false,
    })
  })

  it('evicts the oldest of 51 terminal outputs while an older active task survives', async () => {
    const { manager } = setup()
    const active = deferred<ToolOutcome>()
    const executions = Array.from({ length: 51 }, () => deferred<ToolOutcome>())
    const waits = [
      manager.runForeground(metadata('tu-active-survivor'), () => active.promise, new AbortController().signal),
      ...executions.map((execution, index) => manager.runForeground(
        metadata(`tu-terminal-${index}`),
        () => execution.promise,
        new AbortController().signal,
      )),
    ]
    manager.background()
    await Promise.all(waits)

    for (const execution of executions) execution.resolve({ text: 'terminal output' })
    await flush()

    await expect(manager.output('tu-terminal-0', {}, new AbortController().signal)).resolves.toMatchObject({
      text: expect.stringMatching(/unknown or expired/i),
      isError: true,
    })
    await expect(manager.output('tu-terminal-1', {}, new AbortController().signal)).resolves.toMatchObject({
      text: expect.stringContaining('completed'),
      isError: false,
    })
    await expect(manager.output('tu-active-survivor', {}, new AbortController().signal)).resolves.toEqual({
      text: 'Task tu-active-survivor is still running.',
      isError: false,
    })

    active.resolve({ text: 'active completed' })
    await flush()
  })

  it('destroy aborts all active records, awaits them, and emits only detached terminal frames', async () => {
    const { manager, frames } = setup()
    const foregroundExecution = deferred<ToolOutcome>()
    const detachedExecution = deferred<ToolOutcome>()
    let foregroundSignal!: AbortSignal
    let detachedSignal!: AbortSignal
    const foregroundWait = manager.runForeground(metadata('tu-destroy-foreground'), (signal) => {
      foregroundSignal = signal
      return foregroundExecution.promise
    }, new AbortController().signal)
    const detachedWait = manager.runForeground(metadata('tu-destroy-detached'), (signal) => {
      detachedSignal = signal
      return detachedExecution.promise
    }, new AbortController().signal)
    manager.background('tu-destroy-detached')
    await detachedWait

    let destroyReturned = false
    const destroying = manager.destroy().then(() => { destroyReturned = true })
    expect(foregroundSignal.aborted).toBe(true)
    expect(detachedSignal.aborted).toBe(true)
    await flush()
    expect(destroyReturned).toBe(false)

    foregroundExecution.resolve({ text: 'foreground stopped', isError: true })
    detachedExecution.resolve({ text: 'detached stopped', isError: true })
    await destroying
    await expect(foregroundWait).resolves.toEqual({ text: 'foreground stopped', isError: true })

    expect(frames.filter((frame) => frame.subtype === 'task_started').map((frame) => frame.task_id)).toEqual(['tu-destroy-detached'])
    expect(notifications(frames)).toHaveLength(1)
    expect(notifications(frames)[0]).toMatchObject({ task_id: 'tu-destroy-detached', status: 'stopped' })
  })
})
