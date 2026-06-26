// Sticky floating checklist that surfaces the current task list from the
// message stream. Rendered at the top of the chat area so users can see the
// current task list without scrolling through the transcript.
//
// Two source shapes are supported, because the underlying claude CLI exposes
// task management through ONE of two mutually-exclusive tool families
// (toggled by the CLAUDE_CODE_ENABLE_TASKS env var on the spawned CLI):
//
//   1. TodoWrite (legacy) — a single tool_use carrying the WHOLE todo list
//      as a snapshot. Each turn re-emits the full list. We just read the
//      latest snapshot.
//   2. TaskCreate / TaskUpdate (default in claude-code 2.x) — an INCREMENTAL
//      event stream. TaskCreate adds one task; its server-assigned numeric
//      id (`#N`) is returned in the tool_result text, NOT in the tool_use
//      input. TaskUpdate mutates a task by that id (status / subject / …),
//      with status 'deleted' removing it. We fold the whole stream back into
//      a list, correlating each create's tool_use id to its tool_result to
//      learn the `#N`.
//
// The panel auto-hides when there are no tasks or when all tasks are done and
// the assistant has stopped working.

import { memo, useMemo } from 'react'
import type { SdkMessage } from '../types'
import type { Skin } from '../utils/theme'
import { IconCheck, IconCircleDot, IconCircle, IconCheckboxDot, IconCheckbox } from './icons/ToolIcons'

interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

interface Props {
  messages: SdkMessage[]
  /** When true, the assistant is mid-turn — keeps the panel visible even
   *  if the last update was stale (e.g. user interrupted before a fresh
   *  TodoWrite landed). */
  working?: boolean
  /** Active skin — drives the pending / in-progress marker shape so the
   *  High-Contrast skin gets square checkboxes (the circular SVG icons
   *  can't be squared via border-radius). Completed always uses a check. */
  skin?: Skin
}

export const TodoChecklist = memo(function TodoChecklist({ messages, working, skin }: Props) {
  const result = useMemo(() => extractTodos(messages, !!working), [messages, working])
  const hc = skin === 'hc'

  // Hide when there's nothing useful to show.
  if (!result || result.todos.length === 0) return null
  const { todos, source } = result
  const done = todos.every((t) => t.status === 'completed')
  if (done) {
    // An all-done list still showing here means it's the CURRENT batch (for
    // Task*, stale-completed tasks were already filtered out during
    // reconstruction; for TodoWrite it's the latest snapshot). We keep it up
    // briefly so the user sees the finished ✔ state:
    //   - Task*: cleanup is driven by the next USER message, not completion.
    //     A finished batch lingers until then; once a new turn starts the
    //     stale filter empties the list and the panel disappears on its own.
    //     So we never force-hide here regardless of `working`.
    //   - TodoWrite: a per-turn full snapshot. Keep visible while working
    //     (next snapshot hasn't landed); hide when idle and all done.
    if (source === 'todowrite' && !working) return null
  }

  const doneCount = todos.filter((t) => t.status === 'completed').length

  return (
    <div className="todo-panel" role="status" aria-label="Task checklist">
      <div className="todo-panel-header">
        <span className="todo-panel-title">Checklist</span>
        <span className="todo-panel-count">
          {doneCount}/{todos.length}
        </span>
      </div>
      <ul className="todo-panel-list">
        {todos.map((t, i) => (
          <li key={i} className={`todo-item todo-${t.status}`}>
            <span className="todo-icon" aria-hidden>
              {t.status === 'completed' ? (
                <IconCheck size={12} />
              ) : t.status === 'in_progress' ? (
                hc ? <IconCheckboxDot size={12} /> : <IconCircleDot size={12} />
              ) : (
                hc ? <IconCheckbox size={12} /> : <IconCircle size={12} />
              )}
            </span>
            <span className="todo-text">
              {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
})

/** Which tool family produced the rendered list. The hide-when-done rule
 *  differs between them (see the component): TodoWrite keeps an all-done
 *  list up while working; Task* archives it. */
type TodoSource = 'todowrite' | 'task'

interface ExtractResult {
  todos: Todo[]
  source: TodoSource
}

/** Choose the source shape and reconstruct the current list. TodoWrite wins
 *  when present (it's authoritative and self-contained); otherwise fold the
 *  TaskCreate/TaskUpdate event stream. Returns null when neither is found. */
function extractTodos(messages: SdkMessage[], working: boolean): ExtractResult | null {
  const fromTodoWrite = extractLatestTodos(messages, working)
  // Note `[]` is truthy: an empty TodoWrite snapshot (or one whose every
  // item failed sanitizeTodos) must NOT short-circuit here, or it would
  // silently shadow a live TaskCreate/TaskUpdate stream. Only a non-empty
  // TodoWrite list wins; anything else falls through to the Task events.
  if (fromTodoWrite && fromTodoWrite.length > 0) return { todos: fromTodoWrite, source: 'todowrite' }
  const fromTasks = extractFromTaskEvents(messages)
  if (fromTasks && fromTasks.length > 0) return { todos: fromTasks, source: 'task' }
  return null
}

/** Walk the message list in reverse and return the todos from the most
 *  recent `TodoWrite` tool_use block. Returns null when none found.
 *
 *  When `working === true`, ignore TodoWrites that appear *before* the
 *  most recent `result` marker — those belong to a previous completed
 *  turn and would show stale todos on top of a fresh task until the
 *  assistant gets around to calling TodoWrite for the new task. (Many
 *  turns don't call TodoWrite at all; pinning to the last turn's
 *  todos while the new one runs is worse than showing nothing.)
 *  `stream_event` partials are skipped — their content lives on
 *  `event`, not `message.content`. */
function extractLatestTodos(messages: SdkMessage[], working: boolean): Todo[] | null {
  // Find the boundary: when working=true, only TodoWrites after the
  // most recent `result` count as current.
  let floor = -1
  if (working) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'result') {
        floor = i
        break
      }
    }
  }
  for (let i = messages.length - 1; i > floor; i--) {
    const msg = messages[i]
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    // Walk blocks in reverse too — a single assistant turn can carry
    // multiple tool calls and we want the last TodoWrite.
    for (let j = (content as unknown[]).length - 1; j >= 0; j--) {
      const block = (content as Record<string, unknown>[])[j]
      if (block.type !== 'tool_use' || block.name !== 'TodoWrite') continue
      const input = block.input as Record<string, unknown> | undefined
      if (!input || !Array.isArray(input.todos)) continue
      return sanitizeTodos(input.todos)
    }
  }
  return null
}

/** Defensive parse — the SDK input is unknown-shaped so we validate each
 *  field and drop anything that doesn't match. */
function sanitizeTodos(raw: unknown[]): Todo[] {
  const out: Todo[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    if (typeof obj.content !== 'string') continue
    const status = obj.status
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    out.push({
      content: obj.content,
      status,
      activeForm: typeof obj.activeForm === 'string' ? obj.activeForm : undefined,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Task* (TaskCreate / TaskUpdate) reconstruction
// ---------------------------------------------------------------------------

/** Internal accumulator — superset of Todo with the server-assigned id and
 *  the raw status (which has more states than the 3 the UI renders).
 *  `lastTouched` is the index of the message that last created/updated this
 *  task; used to decide whether a completed task is "stale" (predates the
 *  latest user turn) and should be cleaned up. */
interface TaskState {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  activeForm?: string
  lastTouched: number
  /** True while this entry is keyed by a synthesized `pending:<toolUseId>`
   *  key because its TaskCreate result (which carries the real `#N`) hasn't
   *  been seen. Cleared once the real id is learned. A provisional entry that
   *  goes stale is an orphan — its result will never arrive (history was
   *  truncated) and the real task it stood for has been folded under its
   *  numeric id elsewhere — so cleanup drops it. */
  provisional?: boolean
}

/** The task tools' four mutating verbs. `Task`/`TaskOutput`/`TaskStop` are
 *  subagent-spawn tools and unrelated to the task LIST. */
const TASK_CREATE = 'TaskCreate'
const TASK_UPDATE = 'TaskUpdate'

/** Fold the whole TaskCreate/TaskUpdate stream into the current list.
 *
 *  Unlike TodoWrite (a per-turn full snapshot), Task* state is cumulative
 *  across the session, so we walk the ENTIRE message list in order and apply
 *  every event — no result-floor. The numeric id (`#N`) used by TaskUpdate
 *  is assigned by the server and only appears in TaskCreate's tool_result
 *  text, so we first index tool_results by tool_use_id, then parse `#N` from
 *  the result that matches each create. Returns null when no Task* events
 *  exist (so the caller can fall through to "nothing to show"). */
function extractFromTaskEvents(messages: SdkMessage[]): Todo[] | null {
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

  // Index of the most recent genuine user-INPUT message (text/image the user
  // type — NOT a tool_result, which the SDK also wraps in a `user` frame).
  // This is the cleanup boundary: a completed task whose last create/update
  // predates this turn belongs to a previous request the user has moved on
  // from, so it's stale and gets cleaned up. Tasks touched at or after this
  // point are part of the current request and stay visible (so a just-
  // finished task lingers with its ✔ until the user sends the next message).
  let lastUserInputIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserInputMessage(messages[i])) { lastUserInputIdx = i; break }
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

  // 3) Clean up stale-completed tasks. A task is dropped when it is BOTH
  //    resolved (completed/cancelled) AND was last touched before the latest
  //    user-input turn — i.e. it belongs to a previous request the user has
  //    already moved past. Tasks that are still open (pending/in_progress),
  //    or that were touched during/after the current turn, are kept. This
  //    means a just-finished task stays on screen (with its ✔) until the
  //    user sends their next message, instead of vanishing the instant it
  //    completes.
  const out: Todo[] = []
  for (const t of tasks.values()) {
    const resolved = t.status === 'completed' || t.status === 'cancelled'
    const stale = t.lastTouched < lastUserInputIdx
    if (resolved && stale) continue
    // Drop stale provisional orphans: a TaskCreate whose result never arrived
    // (history truncated), so we never learned its `#N`. The real task it
    // represented was folded under its numeric id by a later TaskUpdate; this
    // leftover would otherwise hang forever as a phantom `pending` item (it's
    // never `completed`, so the rule above can't reach it) — the "stuck 0/1
    // checklist" bug. Keep provisional entries that are still current, so an
    // in-flight create whose result hasn't landed yet still shows this turn.
    if (t.provisional && stale) continue
    out.push({
      content: t.subject,
      // 'cancelled' maps to 'completed' for the 3-state UI (it's resolved —
      // won't be worked on); this also makes it count toward done/total.
      status: t.status === 'cancelled' ? 'completed' : t.status,
      activeForm: t.activeForm,
    })
  }
  return out
}

/** True for a genuine user-type message (text and/or image blocks), false
 *  for the `user`-type frames the SDK uses to carry tool_results. Mirrors
 *  the discriminator in server/session-pump.ts: a frame is input iff it
 *  carries NO tool_result block. A string content body is plain text → input. */
function isUserInputMessage(msg: SdkMessage): boolean {
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
function resultText(content: unknown): string {
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
function parseTaskId(text: string): string | null {
  const m = text.match(/#(\d+)/)
  return m ? m[1] : null
}

/** Narrow an unknown to a non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Map the Task* status vocabulary onto the states we track. 'deleted' is
 *  handled by the caller (removal); everything unknown is dropped (returns
 *  undefined so the caller keeps the previous status). */
function normalizeStatus(
  s: string | undefined,
): 'pending' | 'in_progress' | 'completed' | 'cancelled' | undefined {
  if (s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'cancelled') return s
  return undefined
}
