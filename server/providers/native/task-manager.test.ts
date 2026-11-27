// server/providers/native/task-manager.test.ts
import { describe, expect, it, vi } from 'vitest'
import { taskNotificationFrame, taskStartedFrame } from '../native-frames.js'
import { projectNativeEventToSdk } from '../native-host-frame-adapter.js'
import type { OperationalFrame } from './vocabulary/live-frame.js'
import { NativeTaskManager, type NativeTaskMetadata } from './task-manager.js'
import type { ToolOutcome } from './tools/types.js'

type TaskStarted = Extract<OperationalFrame, { type: 'task/started' }>
type TaskNotification = Extract<OperationalFrame, { type: 'task/notification' }>

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
  const frames: OperationalFrame[] = []
  const manager = new NativeTaskManager((frame) => frames.push(frame))
  return { manager, frames }
}

function notifications(frames: OperationalFrame[]): TaskNotification[] {
  return frames.filter((frame): frame is TaskNotification => frame.type === 'task/notification')
}

function started(frames: OperationalFrame[]): TaskStarted[] {
  return frames.filter((frame): frame is TaskStarted => frame.type === 'task/started')
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

  it('foreground subagent emits task/started at launch and task/notification at settle', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const meta: NativeTaskMetadata = {
      toolUseId: 'tu-fg-agent', taskType: 'subagent', description: 'research', subagentType: 'Explore',
    }
    const waiting = manager.runForeground(meta, () => execution.promise, new AbortController().signal)

    // The launch frame fires synchronously at registration, before execution settles.
    expect(started(frames)).toHaveLength(1)
    expect(started(frames)[0]).toMatchObject({
      type: 'task/started',
      taskId: 'tu-fg-agent',
      toolUseId: 'tu-fg-agent',
      taskType: 'local_agent',
      description: 'research',
      subagentType: 'Explore',
      isBackgrounded: false,
    })
    expect(typeof started(frames)[0].time).toBe('number')
    expect(notifications(frames)).toHaveLength(0)

    execution.resolve({ text: 'foreground report' })
    await expect(waiting).resolves.toEqual({ text: 'foreground report' })
    await flush()

    expect(notifications(frames)).toHaveLength(1)
    expect(notifications(frames)[0]).toMatchObject({
      taskId: 'tu-fg-agent',
      toolUseId: 'tu-fg-agent',
      description: 'research',
      status: 'completed',
      result: 'foreground report',
    })
    // Exactly one started (the launch) — no detach frame for a never-backgrounded task.
    expect(started(frames)).toHaveLength(1)
  })

  it('foreground subagent failure emits task/notification with status failed', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const meta: NativeTaskMetadata = {
      toolUseId: 'tu-fg-fail', taskType: 'subagent', description: 'research', subagentType: 'Explore',
    }
    const waiting = manager.runForeground(meta, () => execution.promise, new AbortController().signal)

    expect(started(frames)).toHaveLength(1)
    expect(notifications(frames)).toHaveLength(0)

    execution.resolve({ text: 'failure details', isError: true })
    await expect(waiting).resolves.toEqual({ text: 'failure details', isError: true })
    await flush()

    expect(notifications(frames)).toHaveLength(1)
    expect(notifications(frames)[0]).toMatchObject({
      taskId: 'tu-fg-fail',
      toolUseId: 'tu-fg-fail',
      description: 'research',
      status: 'failed',
      result: 'failure details',
    })
    expect(started(frames)).toHaveLength(1)
  })

  it('foreground subagent stopped via destroy emits task/notification with status stopped', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const meta: NativeTaskMetadata = {
      toolUseId: 'tu-fg-stop', taskType: 'subagent', description: 'research', subagentType: 'Explore',
    }
    const waiting = manager.runForeground(meta, () => execution.promise, new AbortController().signal)

    // destroy() is the stopRequested path a still-foreground record can take
    // (stop() itself rejects foreground tasks).
    const destroyed = manager.destroy()
    execution.resolve({ text: 'partial report' })
    await expect(waiting).resolves.toEqual({ text: 'partial report' })
    await destroyed
    await flush()

    expect(notifications(frames)).toHaveLength(1)
    expect(notifications(frames)[0]).toMatchObject({
      taskId: 'tu-fg-stop',
      status: 'stopped',
      result: 'partial report',
    })
    expect(started(frames)).toHaveLength(1)
  })

  it('foreground shell emits no task frames and resolves the loop', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-fg-shell'), () => execution.promise, new AbortController().signal)

    expect(frames).toEqual([])
    execution.resolve({ text: 'shell output' })
    await expect(waiting).resolves.toEqual({ text: 'shell output' })
    await flush()
    expect(frames).toEqual([])
  })

  it('foreground subagent backgrounded mid-flight emits exactly one notification', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const meta: NativeTaskMetadata = {
      toolUseId: 'tu-fg-flip', taskType: 'subagent', description: 'flip', subagentType: 'Explore',
    }
    const waiting = manager.runForeground(meta, () => execution.promise, new AbortController().signal)

    // Foreground launch frame.
    expect(started(frames)).toHaveLength(1)
    expect(started(frames)[0].isBackgrounded).toBe(false)

    expect(manager.background('tu-fg-flip')).toBe(true)
    await waiting

    // Detach frame added; the settle now takes the backgrounded branch.
    expect(started(frames)).toHaveLength(2)
    expect(started(frames)[1].isBackgrounded).toBe(true)

    execution.resolve({ text: 'flipped report' })
    await flush()

    // Exactly ONE notification — the backgrounded branch, never a duplicate foreground one.
    expect(notifications(frames)).toHaveLength(1)
    expect(notifications(frames)[0]).toMatchObject({
      taskId: 'tu-fg-flip', status: 'completed', result: 'flipped report',
    })
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
    expect(started(frames)).toHaveLength(1)
    expect(started(frames)[0]).toMatchObject({
      type: 'task/started',
      taskId: 'tu-detach',
      toolUseId: 'tu-detach',
      taskType: 'local_bash',
      description: 'description for tu-detach',
    })
    expect(typeof started(frames)[0].time).toBe('number')

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
      taskId: 'tu-complete',
      toolUseId: 'tu-complete',
      description: 'description for tu-complete',
      status: 'completed',
      result: 'real final report',
    })
    // The manager emits ONLY neutral task frames — never a result frame or a
    // tool_result (the real completion rides the notification, not a tool result).
    expect(frames.every((frame) => frame.type === 'task/started' || frame.type === 'task/notification')).toBe(true)
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
    // The foreground subagent parent carries only its launch frame (false) —
    // detaching the child never detaches the parent; the child carries its
    // detach frame (true).
    expect(started(frames).map((frame) => [frame.taskId, frame.isBackgrounded])).toEqual([
      ['tu-outer', false],
      ['tu-child', true],
    ])

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

    const byId = new Map(notifications(frames).map((frame) => [frame.taskId, frame]))
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

    expect(started(frames).map((frame) => frame.taskId)).toEqual(['tu-destroy-detached'])
    expect(notifications(frames)).toHaveLength(1)
    expect(notifications(frames)[0]).toMatchObject({ taskId: 'tu-destroy-detached', status: 'stopped' })
  })
})

describe('NativeTaskManager neutral emission projects to the identical legacy SDK task frames', () => {
  // Behavior-preserving pin (T16): the manager emits NEUTRAL operational frames
  // and the host adapter owns the SDK projection. Projecting the manager's
  // ACTUAL emission must equal the legacy frames.ts golden field-for-field (the
  // full native task field set — is_backgrounded / subagent_type / result /
  // reason / receivedAt). patch/summary/last_tool_name/output_file/run_id/
  // resource_links are claude-only task fields native never emits (R6), so they
  // are absent on both sides of the comparison.

  it('detach of a shell task → task/started → SDK task_started (local_bash, no subagent_type)', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-bash'), () => execution.promise, new AbortController().signal)
    manager.background('tu-bash')
    await waiting

    const neutral = started(frames)[0]
    expect(projectNativeEventToSdk(neutral)).toEqual(taskStartedFrame({
      taskId: 'tu-bash', toolUseId: 'tu-bash', taskType: 'local_bash',
      description: 'description for tu-bash', receivedAt: neutral.time,
    }))
    execution.resolve({ text: 'done' })
    await flush()
  })

  it('detach of a subagent task → task/started → SDK task_started (local_agent + subagent_type)', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const meta: NativeTaskMetadata = { toolUseId: 'tu-agent', taskType: 'subagent', description: 'research', subagentType: 'Explore' }
    const waiting = manager.runForeground(meta, () => execution.promise, new AbortController().signal)
    manager.background('tu-agent')
    await waiting

    // The foreground launch frame (isBackgrounded:false) now precedes the
    // detach frame; this pin projects the DETACH frame (isBackgrounded:true).
    const neutral = started(frames).find((frame) => frame.isBackgrounded)!
    expect(neutral.subagentType).toBe('Explore')
    expect(projectNativeEventToSdk(neutral)).toEqual(taskStartedFrame({
      taskId: 'tu-agent', toolUseId: 'tu-agent', taskType: 'local_agent',
      description: 'research', subagentType: 'Explore', receivedAt: neutral.time,
    }))
    execution.resolve({ text: 'report' })
    await flush()
  })

  it('backgrounded completion → task/notification → SDK task_notification (completed + result)', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-ok'), () => execution.promise, new AbortController().signal)
    manager.background('tu-ok')
    await waiting
    execution.resolve({ text: 'final report' })
    await flush()

    const neutral = notifications(frames)[0]
    expect(projectNativeEventToSdk(neutral)).toEqual(taskNotificationFrame({
      taskId: 'tu-ok', toolUseId: 'tu-ok', description: 'description for tu-ok',
      status: 'completed', result: 'final report', receivedAt: neutral.time,
    }))
  })

  it('backgrounded failure → task/notification → SDK task_notification (failed + result)', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-err'), () => execution.promise, new AbortController().signal)
    manager.background('tu-err')
    await waiting
    execution.resolve({ text: 'boom', isError: true })
    await flush()

    const neutral = notifications(frames)[0]
    expect(projectNativeEventToSdk(neutral)).toEqual(taskNotificationFrame({
      taskId: 'tu-err', toolUseId: 'tu-err', description: 'description for tu-err',
      status: 'failed', result: 'boom', receivedAt: neutral.time,
    }))
  })

  it('stop → task/notification → SDK task_notification (stopped + partial result)', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-stop'), () => execution.promise, new AbortController().signal)
    manager.background('tu-stop')
    await waiting
    const stopping = manager.stop('tu-stop')
    execution.resolve({ text: 'partial', isError: true })
    await stopping

    const neutral = notifications(frames)[0]
    expect(projectNativeEventToSdk(neutral)).toEqual(taskNotificationFrame({
      taskId: 'tu-stop', toolUseId: 'tu-stop', description: 'description for tu-stop',
      status: 'stopped', result: 'partial', receivedAt: neutral.time,
    }))
  })

  it('an empty result is omitted from the projected SDK notification', async () => {
    const { manager, frames } = setup()
    const execution = deferred<ToolOutcome>()
    const waiting = manager.runForeground(metadata('tu-empty'), () => execution.promise, new AbortController().signal)
    manager.background('tu-empty')
    await waiting
    execution.resolve({ text: '' })
    await flush()

    const neutral = notifications(frames)[0]
    const projected = projectNativeEventToSdk(neutral) as Record<string, unknown>
    expect(projected).toEqual(taskNotificationFrame({
      taskId: 'tu-empty', toolUseId: 'tu-empty', description: 'description for tu-empty',
      status: 'completed', result: '', receivedAt: neutral.time,
    }))
    expect('result' in projected).toBe(false)
  })
})
