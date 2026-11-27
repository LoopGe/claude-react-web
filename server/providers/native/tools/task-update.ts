// server/providers/native/tools/task-update.ts
//
// TaskUpdate mutates one task by its #N id through the per-session
// NativeTaskStore. The result is a JSON mutation report; an unknown id is a
// SOFT failure (isError result, not a throw) so the model can recover, while
// malformed input throws ToolInputError like every other tool. Validation here
// keeps the durable log well-formed — rebuild replays these inputs verbatim.
import type { NativeTaskStore, TaskUpdatePatch } from '../task-store.js'
import { ToolInputError, type ToolDef } from './types.js'

export const TASK_UPDATE_GUIDANCE = "Update a task by its #N id; status 'deleted' removes it."

export type TaskUpdateInput = TaskUpdatePatch & { taskId: string }

const STATUSES = ['pending', 'in_progress', 'completed', 'deleted'] as const

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolInputError(`${field} must be a non-empty string`)
  }
}

function requireStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new ToolInputError(`${field} must be an array of non-empty strings`)
  }
}

export function createTaskUpdateTool(store: NativeTaskStore): ToolDef<TaskUpdateInput> {
  return {
    name: 'TaskUpdate',
    description:
      "Update a task's fields or status by its #N id. status 'deleted' removes the task; addBlocks/addBlockedBy merge dependencies; metadata merges key-by-key (null deletes a key).",
    guidance: TASK_UPDATE_GUIDANCE,
    promptOrder: 180,
    schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The #N id assigned by TaskCreate.' },
        subject: { type: 'string', minLength: 1, description: 'New short imperative title.' },
        description: { type: 'string', minLength: 1, description: 'New task description.' },
        activeForm: { type: 'string', minLength: 1, description: 'New present-continuous running label.' },
        status: { type: 'string', enum: [...STATUSES], description: "New status; 'deleted' removes the task." },
        addBlocks: { type: 'array', items: { type: 'string' }, description: 'Task ids this task blocks (merged, deduped).' },
        addBlockedBy: { type: 'array', items: { type: 'string' }, description: 'Task ids that block this task (merged, deduped).' },
        owner: { type: 'string', minLength: 1, description: 'Owner label, e.g. a subagent id.' },
        metadata: {
          type: 'object',
          description: 'Key/value metadata merged into the task; a null value deletes that key.',
          additionalProperties: true,
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    async run(input) {
      requireNonEmptyString(input.taskId, 'taskId')
      if (input.subject !== undefined) requireNonEmptyString(input.subject, 'subject')
      if (input.description !== undefined) requireNonEmptyString(input.description, 'description')
      if (input.activeForm !== undefined) requireNonEmptyString(input.activeForm, 'activeForm')
      if (input.owner !== undefined) requireNonEmptyString(input.owner, 'owner')
      if (input.status !== undefined && !(STATUSES as readonly string[]).includes(input.status)) {
        throw new ToolInputError(`status must be one of ${STATUSES.join(', ')}`)
      }
      if (input.addBlocks !== undefined) requireStringArray(input.addBlocks, 'addBlocks')
      if (input.addBlockedBy !== undefined) requireStringArray(input.addBlockedBy, 'addBlockedBy')
      if (input.metadata !== undefined && (typeof input.metadata !== 'object' || input.metadata === null || Array.isArray(input.metadata))) {
        throw new ToolInputError('metadata must be an object')
      }
      const result = store.update(input.taskId, input)
      return { text: JSON.stringify(result), ...(result.success ? {} : { isError: true }) }
    },
  }
}