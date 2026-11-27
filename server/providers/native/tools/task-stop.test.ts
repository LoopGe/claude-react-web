// server/providers/native/tools/task-stop.test.ts
//
// TaskStop is a thin ToolDef over NativeTaskManager.stop. Unknown ids and
// non-backgrounded ids are SOFT failures (isError results, not throws) so the
// model sees the manager's own error text and re-plans; malformed input throws
// ToolInputError like every other tool.
import { describe, expect, it } from 'vitest'
import { NativeTaskManager } from '../task-manager.js'
import type { OperationalFrame } from '../vocabulary/live-frame.js'
import { createTaskStopTool, TASK_STOP_GUIDANCE } from './task-stop.js'
import { ToolInputError, type ToolContext, type ToolOutcome } from './types.js'

const ctx = (): ToolContext => ({ cwd: process.cwd(), signal: new AbortController().signal })

describe('TaskStop tool', () => {
  it('exposes the task_id schema and no background or read-only metadata', () => {
    const tool = createTaskStopTool(new NativeTaskManager(() => {}))

    expect(tool).toMatchObject({
      name: 'TaskStop',
      guidance: TASK_STOP_GUIDANCE,
      promptOrder: 83,
    })
    expect(tool.backgroundable).toBeUndefined()
    expect(tool.readOnlyHint).toBeUndefined()
    expect(tool.schema).toMatchObject({
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    })
  })

  it('stops a backgrounded task and awaits its stopped settle', async () => {
    const frames: OperationalFrame[] = []
    const manager = new NativeTaskManager((frame) => frames.push(frame))
    const tool = createTaskStopTool(manager)
    const loop = manager.runForeground(
      { toolUseId: 'tu-stop', taskType: 'shell', description: 'long command' },
      (signal) => new Promise<ToolOutcome>((resolve) => {
        signal.addEventListener('abort', () => resolve({ text: 'command aborted', isError: true }), { once: true })
      }),
      new AbortController().signal,
    )
    expect(manager.background('tu-stop')).toBe(true)
    await loop

    await expect(tool.run({ task_id: 'tu-stop' }, ctx())).resolves.toEqual({ text: 'Task tu-stop stopped.' })
    // stop awaits the settle, so the notification is already emitted and the
    // terminal record answers through the manager's output read path.
    const notification = frames.find((frame) => frame.type === 'task/notification')
    expect(notification).toMatchObject({ taskId: 'tu-stop', status: 'stopped' })
    await expect(manager.output('tu-stop', {}, ctx().signal)).resolves.toMatchObject({
      text: expect.stringContaining('Task tu-stop stopped.'),
    })
  })

  it('returns a soft isError result for an unknown id', async () => {
    const tool = createTaskStopTool(new NativeTaskManager(() => {}))

    await expect(tool.run({ task_id: 'missing' }, ctx())).resolves.toMatchObject({
      text: expect.stringContaining('Unknown task missing'),
      isError: true,
    })
  })

  it('returns a soft isError result for a non-backgrounded id', async () => {
    const manager = new NativeTaskManager(() => {})
    const tool = createTaskStopTool(manager)
    let finish!: (outcome: ToolOutcome) => void
    const loop = manager.runForeground(
      { toolUseId: 'tu-fg', taskType: 'shell', description: 'foreground command' },
      () => new Promise<ToolOutcome>((resolve) => { finish = resolve }),
      new AbortController().signal,
    )

    await expect(tool.run({ task_id: 'tu-fg' }, ctx())).resolves.toMatchObject({
      text: expect.stringContaining('not backgrounded'),
      isError: true,
    })
    finish({ text: 'done' })
    await loop
  })

  it('throws ToolInputError on missing or empty task_id', async () => {
    const tool = createTaskStopTool(new NativeTaskManager(() => {}))

    await expect(tool.run({} as { task_id: string }, ctx())).rejects.toThrow(ToolInputError)
    await expect(tool.run({ task_id: '' }, ctx())).rejects.toThrow(ToolInputError)
    await expect(tool.run({ task_id: '   ' }, ctx())).rejects.toThrow(ToolInputError)
    await expect(tool.run({ task_id: 42 } as unknown as { task_id: string }, ctx())).rejects.toThrow(ToolInputError)
  })
})