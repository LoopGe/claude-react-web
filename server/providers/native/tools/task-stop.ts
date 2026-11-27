// server/providers/native/tools/task-stop.ts
//
// TaskStop is a thin ToolDef over NativeTaskManager.stop: it aborts a
// backgrounded task's own controller and awaits its settle. The manager's two
// error states — unknown id and non-backgrounded id — are SOFT failures
// (isError results carrying the manager's own message, not throws) so the
// model can re-plan, matching TaskUpdate's soft unknown-id failure. Malformed
// input throws ToolInputError like every other tool.
import type { NativeTaskManager } from '../task-manager.js'
import { ToolInputError, type ToolDef } from './types.js'

export const TASK_STOP_GUIDANCE = 'Stop a background task by its task_id.'

// Type alias (not interface): the implicit index signature lets
// ToolDef<TaskStopInput> compose with the session's ToolDef list.
export type TaskStopInput = {
  task_id: string
}

export function createTaskStopTool(tasks: NativeTaskManager): ToolDef<TaskStopInput> {
  return {
    name: 'TaskStop',
    description:
      'Stop a running background task by its task_id (the id from the background launch acknowledgement). The task settles as stopped; unknown or non-backgrounded ids return an error result.',
    guidance: TASK_STOP_GUIDANCE,
    promptOrder: 83,
    schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The id returned when the task was backgrounded.' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    async run(input) {
      if (typeof input.task_id !== 'string' || input.task_id.trim() === '') {
        throw new ToolInputError('task_id must be a non-empty string')
      }
      try {
        await tasks.stop(input.task_id)
      } catch (error) {
        // stop's entire error surface is the unknown-id and not-backgrounded
        // states; the model sees the manager's own message and re-plans.
        return { text: error instanceof Error ? error.message : String(error), isError: true }
      }
      return { text: `Task ${input.task_id} stopped.` }
    },
  }
}