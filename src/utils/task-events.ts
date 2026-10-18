// Client-side surface of the shared Task* fold (shared/task-list.ts):
// re-exports the pure fold for existing import sites (TodoChecklist,
// TaskMutationView, useTaskInfo) and keeps the two window-relative helpers
// that depend on the client's richer isHumanUserMessage classification.

export {
  buildTaskStateMap,
  buildTaskStateMapFromItems,
  countTaskEvents,
  filterVisibleTasks,
  isGenuineUserInputFrame,
  mergeTaskList,
  normalizeStatus,
  parseTaskId,
  resultText,
  str,
  TASK_CREATE,
  TASK_UPDATE,
} from '../../shared/task-list'
export type { TaskState, TasklistSnapshotPayload, TasklistSnapshotTask } from '../../shared/task-list'

import type { SdkMessage } from '../types'
import { isHumanUserMessage } from '../session-store/normalize'

/** Index of the most recent genuine HUMAN-typed message — the cleanup
 *  boundary for stale completed tasks. Must use isHumanUserMessage (not the
 *  looser isUserInputMessage) so synthetic user-role injections the pump
 *  forwards — `<task-notification>` background-subagent results, peer /
 *  auto-continuation frames — do NOT become the boundary. Otherwise a
 *  background subagent completing mid-turn would mark every prior completed
 *  task as stale and drop its checkmark from the panel. */
export function lastUserInputIndex(messages: readonly SdkMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHumanUserMessage(messages[i])) return i
  }
  return -1
}

/** True for a genuine user-type message (text and/or image blocks), false
 *  for the `user`-type frames the SDK uses to carry tool_results. Mirrors
 *  the discriminator in server/session-pump.ts: a frame is input iff it
 *  carries NO tool_result block. A string content body is plain text → input. */
export function isUserInputMessage(msg: SdkMessage): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message?.content
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  for (const block of content as Record<string, unknown>[]) {
    if (block && block.type === 'tool_result') return false
  }
  return true
}