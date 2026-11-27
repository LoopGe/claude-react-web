// server/providers/native/tools/task-get.ts
//
// TaskGet is a read-only projection of one NativeTaskStore record: JSON
// `{ task: { id, subject, description, status, blocks, blockedBy } | null }`.
// An unknown id is a normal null answer, not an isError failure — a read miss
// has no mutation to report; malformed input throws ToolInputError like every
// other tool.
import type { NativeTaskStore } from '../task-store.js'
import { ToolInputError, type ToolDef } from './types.js'

export const TASK_GET_GUIDANCE = 'Read one task by #N id.'

export interface TaskGetInput {
  taskId: string
}

export function createTaskGetTool(store: NativeTaskStore): ToolDef<TaskGetInput> {
  return {
    name: 'TaskGet',
    description:
      'Read one task by its #N id: subject, description, status and blocks/blockedBy dependencies. The result is JSON; an unknown id returns {"task":null}.',
    guidance: TASK_GET_GUIDANCE,
    promptOrder: 180,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The #N id assigned by TaskCreate.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    async run(input) {
      if (typeof input.taskId !== 'string' || input.taskId.trim() === '') {
        throw new ToolInputError('taskId must be a non-empty string')
      }
      const record = store.get(input.taskId)
      const task =
        record === null
          ? null
          : {
              id: record.id,
              subject: record.subject,
              description: record.description,
              status: record.status,
              blocks: record.blocks,
              blockedBy: record.blockedBy,
            }
      return { text: JSON.stringify({ task }) }
    },
  }
}