// server/providers/native/tools/task-list.ts
//
// TaskList is a read-only projection of the whole NativeTaskStore in creation
// order: JSON `{ tasks: [{ id, subject, status, owner?, blockedBy }] }` — the
// roster fields needed to pick the next task. `owner` is present only when set.
import type { NativeTaskStore } from '../task-store.js'
import type { ToolDef } from './types.js'

export const TASK_LIST_GUIDANCE = 'List all tasks with status and dependencies.'

export function createTaskListTool(store: NativeTaskStore): ToolDef {
  return {
    name: 'TaskList',
    description:
      'List every task in creation order with its status, owner (when set) and blockedBy dependencies. The result is JSON.',
    guidance: TASK_LIST_GUIDANCE,
    promptOrder: 180,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {},
    },
    async run() {
      const tasks = store.list().map((record) => ({
        id: record.id,
        subject: record.subject,
        status: record.status,
        ...(record.owner !== undefined ? { owner: record.owner } : {}),
        blockedBy: record.blockedBy,
      }))
      return { text: JSON.stringify({ tasks }) }
    },
  }
}