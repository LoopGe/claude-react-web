// Sticky floating checklist that surfaces the latest TodoWrite state from
// the message stream. Rendered at the top of the chat area so users can see
// the current task list without scrolling through the transcript.
//
// The panel auto-hides when there are no todos or when all tasks are done
// and the assistant has stopped working.

import { useMemo } from 'react'
import type { SdkMessage } from '../types'

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
}

export function TodoChecklist({ messages, working }: Props) {
  const todos = useMemo(() => extractLatestTodos(messages, !!working), [messages, working])

  // Hide when there's nothing useful to show.
  if (!todos || todos.length === 0) return null
  const done = todos.every((t) => t.status === 'completed')
  if (done && !working) return null

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
              {t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '◉' : '○'}
            </span>
            <span className="todo-text">
              {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
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
