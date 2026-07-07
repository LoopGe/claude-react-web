// Shared fold of the TaskCreate / TaskUpdate event stream into a
// Map<taskId, TaskState>. Extracted from TodoChecklist so the same fold
// can be consumed by the inline TaskMutationView card (to resolve a
// TaskUpdate's subject, which is set at TaskCreate time and not repeated
// in the update input) without duplicating the logic.
//
// The claude CLI exposes task management through ONE of two mutually-
// exclusive tool families (toggled by the CLAUDE_CODE_ENABLE_TASKS env
// var on the spawned CLI):
//
//   1. TodoWrite (legacy) — a single tool_use carrying the WHOLE todo
//      list as a snapshot. Not handled here (TodoChecklist reads it
//      directly from the latest tool_use input).
//   2. TaskCreate / TaskUpdate (default in claude-code 2.x) — an
//      INCREMENTAL event stream. TaskCreate adds one task; its server-
//      assigned numeric id (`#N`) is returned in the tool_result text,
//      NOT in the tool_use input. TaskUpdate mutates a task by that id
//      (status / subject / …), with status 'deleted' removing it. We
//      fold the whole stream back into a map, correlating each create's
//      tool_use id to its tool_result to learn the `#N`.

import type { SdkMessage } from '../types'
import { isHumanUserMessage } from '../session-store/normalize'

/** Internal accumulator — superset of Todo with the server-assigned id and
 *  the raw status (which has more states than the 3 the UI renders).
 *  `lastTouched` is the index of the message that last created/updated this
 *  task; used by TodoChecklist's cleanup to decide whether a completed task
 *  is "stale" (predates the latest user turn) and should be cleaned up.
 *  Exposed so the inline TaskMutationView card can read `subject`/`status`. */
export interface TaskState {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  activeForm?: string
  lastTouched: number
  /** True while this entry is keyed by a synthesized `pending:<toolUseId>`
   *  key because its TaskCreate result (which carries the real `#N`) hasn't
   *  been seen. Cleared once the real id is learned. */
  provisional?: boolean
}

/** The task tools' two mutating verbs. `Task`/`TaskOutput`/`TaskStop` are
 *  subagent-spawn tools and unrelated to the task LIST. */
export const TASK_CREATE = 'TaskCreate'
export const TASK_UPDATE = 'TaskUpdate'

/** Fold the whole TaskCreate/TaskUpdate stream into a Map keyed by numeric
 *  task id (`#N`).
 *
 *  Unlike TodoWrite (a per-turn full snapshot), Task* state is cumulative
 *  across the session, so we walk the ENTIRE message list in order and
 *  apply every event. The numeric id (`#N`) used by TaskUpdate is assigned
 *  by the server and only appears in TaskCreate's tool_result text, so we
 *  first index tool_results by tool_use_id, then parse `#N` from the
 *  result that matches each create.
 *
 *  Returns the **pre-cleanup** map (no stale-completed removal) — callers
 *  that need the visible checklist list (TodoChecklist) apply their own
 *  cleanup on top. Returns `null` when no Task* events exist, so callers
 *  can fall through to "nothing to show". */
export function buildTaskStateMap(
  messages: readonly SdkMessage[],
): Map<string, TaskState> | null {
  // 1) Index every tool_result's text by the tool_use_id it answers. The
  //    SDK wraps tool_results in `user` messages; content may be a string
  //    or an array of text blocks.
  const resultByToolUseId = new Map<string, string>()
  for (const msg of messages) {
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_result') continue
      const tuid = block.tool_use_id
      if (typeof tuid !== 'string') continue
      resultByToolUseId.set(tuid, resultText(block.content))
    }
  }

  // 2) Walk assistant tool_use blocks in order, folding create/update into
  //    a Map keyed by numeric id. Map preserves insertion (creation) order.
  //    `idx` is the message index, recorded as each task's lastTouched.
  const tasks = new Map<string, TaskState>()
  let sawAny = false

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_use') continue
      const input = (block.input as Record<string, unknown> | undefined) ?? undefined

      if (block.name === TASK_CREATE) {
        sawAny = true
        const toolUseId = typeof block.id === 'string' ? block.id : null
        const resText = toolUseId ? resultByToolUseId.get(toolUseId) : undefined
        const id = resText ? parseTaskId(resText) : null
        // In-flight create whose result hasn't landed yet: we don't know the
        // server id, so synthesize a stable provisional key from the tool_use
        // id. A later TaskUpdate can only reference the real `#N`, so this
        // provisional entry naturally resolves once the result arrives and a
        // subsequent render parses the id.
        const key = id ?? (toolUseId ? `pending:${toolUseId}` : `pending:${tasks.size}`)
        tasks.set(key, {
          id: id ?? key,
          subject: str(input?.subject) ?? '(no subject)',
          status: normalizeStatus(str(input?.status)) ?? 'pending',
          activeForm: str(input?.activeForm),
          lastTouched: idx,
          provisional: id == null,
        })
        continue
      }

      if (block.name === TASK_UPDATE) {
        sawAny = true
        const id = str(input?.taskId)
        if (!id) continue
        const rawStatus = str(input?.status)
        // 'deleted' removes the task from the list entirely.
        if (rawStatus === 'deleted') {
          tasks.delete(id)
          continue
        }
        const existing = tasks.get(id)
        const next: TaskState = existing ?? {
          // Update for a task created before our history window (or whose
          // create we never saw) — materialize a stub so it still shows.
          id,
          subject: str(input?.subject) ?? `Task #${id}`,
          status: 'pending',
          lastTouched: idx,
        }
        if (input && 'subject' in input) {
          const s = str(input.subject)
          if (s) next.subject = s
        }
        if (input && 'activeForm' in input) {
          next.activeForm = str(input.activeForm)
        }
        const ns = normalizeStatus(rawStatus)
        if (ns) next.status = ns
        next.lastTouched = idx
        tasks.set(id, next)
      }
    }
  }

  if (!sawAny) return null
  return tasks
}

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

/** Coerce a tool_result `content` field (string | array of text blocks |
 *  other) to a flat string for `#N` parsing. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text
        }
        return ''
      })
      .join(' ')
  }
  return ''
}

/** Pull the server-assigned numeric task id out of a TaskCreate result like
 *  `"Task #3 created successfully: Deploy"`. Returns the id as a string (to
 *  match TaskUpdate's `taskId`), or null when absent. */
export function parseTaskId(text: string): string | null {
  const m = text.match(/#(\d+)/)
  return m ? m[1] : null
}

/** Narrow an unknown to a non-empty string, else undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Map the Task* status vocabulary onto the states we track. 'deleted' is
 *  handled by the caller (removal); everything unknown is dropped (returns
 *  undefined so the caller keeps the previous status). */
export function normalizeStatus(
  s: string | undefined,
): 'pending' | 'in_progress' | 'completed' | 'cancelled' | undefined {
  if (s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'cancelled') return s
  return undefined
}
