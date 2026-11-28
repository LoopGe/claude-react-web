// server/providers/native/tools/task-create.ts
//
// TaskCreate is a thin ToolDef over the per-session NativeTaskStore. The result
// text carries the assigned #N id (`Task #N created successfully: <subject>`)
// — the SAME format the host's shared/task-list.ts fold parses, so the client
// checklist and the native store agree on identity. Input is validated here so
// only well-formed records reach the store and the durable log (which rebuild
// replays verbatim).
import type { NativeTaskStore, TaskCreateInput } from '../task-store.js'
import { ToolInputError, type ToolDef } from './types.js'

export const TASK_CREATE_GUIDANCE = 'Create a structured task; the result carries its #N id.'

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolInputError(`${field} must be a non-empty string`)
  }
  return value
}

export function createTaskCreateTool(store: NativeTaskStore): ToolDef<TaskCreateInput> {
  return {
    name: 'TaskCreate',
    description:
      'Create a structured task in the session task list. The result text carries the assigned #N id used by TaskUpdate and TaskGet.',
    guidance: TASK_CREATE_GUIDANCE,
    promptOrder: 180,
    schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', minLength: 1, description: 'Short imperative title of the task.' },
        description: { type: 'string', minLength: 1, description: 'What the task involves and why.' },
        activeForm: {
          type: 'string',
          minLength: 1,
          description: 'Present-continuous label shown while the task runs, e.g. "Deploying the service".',
        },
        metadata: {
          type: 'object',
          description: 'Optional free-form key/value metadata stored with the task.',
          additionalProperties: true,
        },
      },
      required: ['subject', 'description'],
      additionalProperties: false,
    },
    async run(input) {
      requireNonEmptyString(input.subject, 'subject')
      requireNonEmptyString(input.description, 'description')
      if (input.activeForm !== undefined) requireNonEmptyString(input.activeForm, 'activeForm')
      if (input.metadata !== undefined && (typeof input.metadata !== 'object' || input.metadata === null || Array.isArray(input.metadata))) {
        throw new ToolInputError('metadata must be an object')
      }
      const record = store.create(input)
      return { text: `Task #${record.id} created successfully: ${record.subject}` }
    },
  }
}