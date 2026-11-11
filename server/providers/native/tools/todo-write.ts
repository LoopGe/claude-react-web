// server/providers/native/tools/todo-write.ts
//
// TodoWrite keeps ONE list per session, so it is a factory: the state object
// is closed over by the tool instance and never shared between sessions. Each
// call is a FULL replacement (the model re-sends every task with its current
// status) and the result reports the before/after snapshots — the client's
// TodoChecklist reads the latest tool_use input straight from the transcript.
import { ToolInputError, type ToolDef } from './types.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm: string
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']

/** The TodoWrite prompt-section guidance. Exported so the provider's static
 *  `tool:TodoWrite` section and the tool definition cannot drift. */
export const TODO_WRITE_GUIDANCE =
  'Use TodoWrite to track multi-step work: each call replaces the whole list, so return every task with its current status.'

function validateTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) throw new ToolInputError('todos must be an array')
  const seen = new Set<string>()
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new ToolInputError(`todos[${index}] must be an object`)
    }
    const { content, status, activeForm } = item as Record<string, unknown>
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ToolInputError(`todos[${index}].content must be a non-empty string`)
    }
    const trimmed = content.trim()
    if (seen.has(trimmed)) throw new ToolInputError(`duplicate todo content: ${trimmed}`)
    seen.add(trimmed)
    if (typeof status !== 'string' || !STATUSES.includes(status as TodoStatus)) {
      throw new ToolInputError(`todos[${index}].status must be one of ${STATUSES.join(', ')}`)
    }
    if (typeof activeForm !== 'string' || activeForm.trim() === '') {
      throw new ToolInputError(`todos[${index}].activeForm must be a non-empty string`)
    }
    return { content: trimmed, status: status as TodoStatus, activeForm: activeForm.trim() }
  })
}

export function createTodoWriteTool(state: { todos: TodoItem[] }): ToolDef<{ todos: TodoItem[] }> {
  return {
    name: 'TodoWrite',
    description:
      'Create and update the task list for the current session. Each call replaces the previous list.',
    guidance: TODO_WRITE_GUIDANCE,
    promptOrder: 180,
    schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete todo list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', minLength: 1, description: 'Imperative description of the task.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: {
                type: 'string',
                minLength: 1,
                description: 'Present-continuous label shown while the task runs, e.g. "Running tests".',
              },
            },
            required: ['content', 'status', 'activeForm'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    async run(input) {
      const todos = validateTodos(input.todos)
      const oldTodos = state.todos
      state.todos = todos
      let text = JSON.stringify({ oldTodos, newTodos: todos })
      // More than one in_progress task is accepted — it is a planning smell,
      // not a malformed call, so the model gets the new list plus a warning.
      const inProgress = todos.filter((todo) => todo.status === 'in_progress').length
      if (inProgress > 1) {
        text += `\n\nWarning: ${inProgress} todos are in_progress; keep only one task in progress at a time.`
      }
      return { text }
    },
  }
}