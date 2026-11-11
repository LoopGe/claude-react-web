// server/providers/native/tools/task-output.test.ts
import { describe, expect, it, vi } from 'vitest'
import { NativeTaskManager } from '../task-manager.js'
import { createTaskOutputTool, TASK_OUTPUT_GUIDANCE } from './task-output.js'
import type { ToolOutcome } from './types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('TaskOutput tool', () => {
  it('exposes the task id schema, wait defaults, and no background metadata', () => {
    const tool = createTaskOutputTool(new NativeTaskManager(() => {}))

    expect(tool).toMatchObject({
      name: 'TaskOutput',
      guidance: TASK_OUTPUT_GUIDANCE,
      promptOrder: 82,
    })
    expect(tool.backgroundable).toBeUndefined()
    expect(tool.schema).toMatchObject({
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        block: { type: 'boolean', default: false },
        timeout: { type: 'number', default: 30_000, maximum: 600_000 },
      },
    })
  })

  it('maps task_id to the manager and returns unknown ids as errors', async () => {
    const tool = createTaskOutputTool(new NativeTaskManager(() => {}))

    await expect(tool.run(
      { task_id: 'missing' },
      { cwd: process.cwd(), signal: new AbortController().signal },
    )).resolves.toMatchObject({ text: expect.stringMatching(/unknown or expired/i), isError: true })
  })

  it('uses the 30 second default and caps blocking waits at 600 seconds', async () => {
    vi.useFakeTimers()
    try {
      const manager = new NativeTaskManager(() => {})
      const tool = createTaskOutputTool(manager)
      const first = deferred<ToolOutcome>()
      const second = deferred<ToolOutcome>()
      const waits = [
        manager.runForeground(
          { toolUseId: 'tu-default', taskType: 'shell', description: 'default timeout' },
          () => first.promise,
          new AbortController().signal,
        ),
        manager.runForeground(
          { toolUseId: 'tu-capped', taskType: 'shell', description: 'capped timeout' },
          () => second.promise,
          new AbortController().signal,
        ),
      ]
      manager.background()
      await Promise.all(waits)
      const signal = new AbortController().signal
      const ctx = { cwd: process.cwd(), signal }

      let defaultSettled = false
      const defaultRead = tool.run({ task_id: 'tu-default', block: true }, ctx)
        .then((outcome) => { defaultSettled = true; return outcome })
      await vi.advanceTimersByTimeAsync(29_999)
      expect(defaultSettled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(defaultRead).resolves.toMatchObject({
        text: expect.stringContaining('still running'),
        isError: false,
      })
      expect(vi.getTimerCount()).toBe(0)

      let cappedSettled = false
      const cappedRead = tool.run({ task_id: 'tu-capped', block: true, timeout: 600_001 }, ctx)
        .then((outcome) => { cappedSettled = true; return outcome })
      await vi.advanceTimersByTimeAsync(599_999)
      expect(cappedSettled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(cappedRead).resolves.toMatchObject({
        text: expect.stringContaining('still running'),
        isError: false,
      })
      expect(vi.getTimerCount()).toBe(0)

      first.resolve({ text: 'first done' })
      second.resolve({ text: 'second done' })
      await flush()
    } finally {
      vi.useRealTimers()
    }
  })
})
