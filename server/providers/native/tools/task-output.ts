// server/providers/native/tools/task-output.ts
import type { NativeTaskManager } from '../task-manager.js'
import type { ToolDef } from './types.js'

export const TASK_OUTPUT_GUIDANCE =
  'Use TaskOutput when a background task result is needed before deciding the next step.'

interface TaskOutputInput {
  task_id: string
  block?: boolean
  timeout?: number
}

export function createTaskOutputTool(tasks: NativeTaskManager): ToolDef {
  return {
    name: 'TaskOutput',
    description: 'Read a background task status and final output, optionally waiting for completion.',
    guidance: TASK_OUTPUT_GUIDANCE,
    promptOrder: 82,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The id returned when the task was backgrounded.' },
        block: {
          type: 'boolean',
          default: false,
          description: 'Wait for terminal output instead of returning immediately.',
        },
        timeout: {
          type: 'number',
          default: 30_000,
          maximum: 600_000,
          description: 'Maximum wait in milliseconds when block is true; longer values are capped.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    async run(raw, ctx) {
      const input = raw as unknown as TaskOutputInput
      return tasks.output(
        input.task_id,
        { block: input.block, timeout: input.timeout },
        ctx.signal,
      )
    },
  }
}
