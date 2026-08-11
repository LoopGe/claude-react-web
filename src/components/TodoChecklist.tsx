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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SdkMessage } from '../types'
import type { Skin } from '../utils/theme'
import { IconCheck, IconCircleDot, IconCircle, IconCheckboxDot, IconCheckbox, IconChevronDown, IconChevronRight, IconRotateCcw } from './icons/ToolIcons'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useLocalStorage } from '../hooks/useLocalStorage'
import {
  buildTaskStateMap,
  lastUserInputIndex,
} from '../utils/task-events'

interface Todo {
  /** Stable identity for the local hide-set. Task* items use the server-
   *  assigned numeric id (`#N`, from TaskState.id); TodoWrite snapshots have
   *  no id, so the content string is the fallback. */
  key: string
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
  /** True while a /clear is in flight. Reuses the transcript's
   *  `clear-blur-fade` exit animation so the checklist dissolves in sync
   *  with the message list instead of snapping out when the server wipes
   *  the store. The last visible list is frozen for the duration so the
   *  panel stays mounted (and fading) after `messages` empties. */
  clearing?: boolean
  /** Per-session persistence key for the collapse + hidden-set state. When
   *  omitted both stay in memory only (no localStorage writes) — the tests
   *  rely on this. */
  sessionId?: string
}

// localStorage keys for per-session UI state. null → pure in-memory state.
const LS_PREFIX = 'claude-react-web:todo:'
function keyCollapsed(sid?: string): string | null {
  return sid ? `${LS_PREFIX}collapsed:${sid}` : null
}
function keyHidden(sid?: string): string | null {
  return sid ? `${LS_PREFIX}hidden:${sid}` : null
}

const LONG_PRESS_MS = 500
/** Pointer travel (px) from the press origin that cancels a long-press —
 *  the list is scrollable and a drag/scroll shouldn't trigger a hide. */
const PRESS_MOVE_SLOP = 10

export const TodoChecklist = memo(function TodoChecklist({ messages, working, skin, clearing, sessionId }: Props) {
  const result = useMemo(() => extractTodos(messages, !!working), [messages, working])
  const hc = skin === 'hc'
  // Cap the list height so a long checklist doesn't dominate the viewport
  // (the panel is position:sticky; without a cap a 20-item list fills the
  // whole chat area). The list scrolls internally via the project's overlay
  // scrollbar (same as MessageList / RecapWindow), keeping the header + count
  // visible. Declared here (before the early returns) so the hook order is
  // stable across renders where the panel is hidden.
  const setListScroller = useOverlayScrollbar({ autoHide: 'leave' })

  // --- collapse + hidden-set state --------------------------------------
  // Persisted per session in localStorage (null key → in-memory only, which
  // the existing tests rely on). All declared before the early return so the
  // hook order is stable across renders where the panel is hidden.
  const [collapsed, setCollapsed] = useLocalStorage<boolean>(keyCollapsed(sessionId), false, {
    validate: (v): v is boolean => typeof v === 'boolean',
  })
  const [hiddenList, setHiddenList] = useLocalStorage<string[]>(keyHidden(sessionId), [], {
    validate: (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  })
  const hiddenSet = useMemo(() => new Set(hiddenList), [hiddenList])

  const hideTodo = useCallback((k: string) => {
    setHiddenList((prev) => (prev.includes(k) ? prev : [...prev, k]))
  }, [setHiddenList])
  const undoHidden = useCallback(() => setHiddenList([]), [setHiddenList])

  // --- long-press-to-hide gesture (pointer events) ----------------------
  // Pointer-only affordance — a long-press has no keyboard equivalent. TODO:
  // add a keyboard-accessible alternative (per-item secondary action) before
  // treating this as the sole hide path.
  const pressTimerRef = useRef<number | null>(null)
  const pressStartRef = useRef<{ x: number; y: number } | null>(null)
  const [pressingKey, setPressingKey] = useState<string | null>(null)

  const clearPress = useCallback(() => {
    if (pressTimerRef.current != null) window.clearTimeout(pressTimerRef.current)
    pressTimerRef.current = null
    pressStartRef.current = null
    setPressingKey(null)
  }, [])
  // Cleanup on unmount so a pending timer can't fire on a detached item.
  useEffect(() => () => {
    if (pressTimerRef.current != null) window.clearTimeout(pressTimerRef.current)
  }, [])

  const onItemPointerDown = useCallback((e: React.PointerEvent<HTMLLIElement>, key: string) => {
    if (e.button !== 0) return
    clearPress()
    pressStartRef.current = { x: e.clientX, y: e.clientY }
    setPressingKey(key)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* jsdom / stale pointerId */ }
    pressTimerRef.current = window.setTimeout(() => {
      hideTodo(key)
      clearPress()
    }, LONG_PRESS_MS)
  }, [clearPress, hideTodo])

  const onItemPointerMove = useCallback((e: React.PointerEvent<HTMLLIElement>) => {
    const s = pressStartRef.current
    if (!s) return
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > PRESS_MOVE_SLOP) clearPress()
  }, [clearPress])

  const onItemPointerEnd = useCallback(() => clearPress(), [clearPress])

  // The result that would be shown right now under the normal hide rules
  // (null when the panel should be hidden). Mirrors the old inline early
  // returns: empty list → hide; all-done TodoWrite snapshot while idle →
  // hide. (Task* keeps an all-done batch up until the next user turn;
  // TodoWrite keeps it up while working — see extractFromTaskEvents /
  // extractLatestTodos for the cleanup boundaries.)
  const visibleResult = (() => {
    if (!result || result.todos.length === 0) return null
    const done = result.todos.every((t) => t.status === 'completed')
    if (done && result.source === 'todowrite' && !working) return null
    return result
  })()

  // Freeze the last visible result so a /clear can keep rendering it
  // (fading) after the store wipes `messages`. Updated only while NOT
  // clearing — during a clear we read the frozen value, never overwrite.
  // Setting it to `visibleResult` (which is null when hidden) also clears
  // any stale capture, so a clear that starts while the panel is already
  // hidden doesn't resurrect a faded-out stale list.
  const frozenRef = useRef<ExtractResult | null>(null)
  if (!clearing) frozenRef.current = visibleResult

  // During a clear, dissolve in sync with the transcript instead of
  // snapping out. Prefer the frozen capture (so the panel keeps fading after
  // the store wipes `messages`); fall back to the live `visibleResult` when
  // the capture is empty — e.g. a clear that lands on the very first render,
  // before any non-clearing render populated the ref. If both are null the
  // panel was hidden when the clear started, so there's nothing to fade.
  const renderResult = clearing ? (frozenRef.current ?? visibleResult) : visibleResult

  // Visible list is the render result minus locally-hidden tasks. The count
  // chip reflects only what's shown; the undo row explains the difference.
  const todos = renderResult ? renderResult.todos : []
  const visibleTodos = todos.filter((t) => !hiddenSet.has(t.key))
  const doneCount = visibleTodos.filter((t) => t.status === 'completed').length
  const hiddenVisibleCount = todos.filter((t) => hiddenSet.has(t.key)).length

  // Prune hidden keys that no longer exist in the FULL derived list — an
  // agent `TaskUpdate(status:'deleted')`, a /clear that wiped `messages`, or
  // a provisional `pending:<toolUseId>` key resolving to its real `#N`.
  // Uses `result` (not `renderResult`): when the panel is auto-hidden
  // (all-done + idle → renderResult null) the tasks still exist and the
  // hidden set must survive the auto-hide.
  useEffect(() => {
    if (hiddenList.length === 0) return
    const alive = new Set((result?.todos ?? []).map((t) => t.key))
    const pruned = hiddenList.filter((k) => alive.has(k))
    if (pruned.length !== hiddenList.length) setHiddenList(pruned)
  }, [result, hiddenList, setHiddenList])

  if (!renderResult) return null

  return (
    <div
      className={`todo-panel${working ? ' todo-panel-working' : ''}${clearing ? ' todo-panel-clearing' : ''}${collapsed ? ' todo-panel-collapsed' : ''}`}
      role="status"
      aria-label="Task checklist"
    >
      <div className="todo-panel-header">
        <span className="todo-panel-title">{renderResult.source === 'todowrite' ? 'TodoList' : 'TaskList'}</span>
        <div className="todo-panel-header-right">
          <button
            type="button"
            className="todo-panel-collapse"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? '展开任务列表' : '折叠任务列表'}
            aria-expanded={!collapsed}
            aria-controls="todo-panel-list"
            aria-label={collapsed ? '展开任务列表' : '折叠任务列表'}
          >
            {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
          </button>
          <span className="todo-panel-count">
            {doneCount}/{visibleTodos.length}
          </span>
        </div>
      </div>
      {hiddenVisibleCount > 0 && (
        <div className="todo-panel-undo">
          <span>已隐藏 {hiddenVisibleCount} 项</span>
          <button type="button" className="todo-panel-undo-btn" onClick={undoHidden}>
            <IconRotateCcw size={12} /> 撤销
          </button>
        </div>
      )}
      {!collapsed && (
        <ul ref={setListScroller} id="todo-panel-list" className="todo-panel-list">
          {visibleTodos.map((t, i) => (
            <li
              key={i}
              className={`todo-item todo-${t.status}${pressingKey === t.key ? ' todo-item-pressing' : ''}`}
              onPointerDown={(e) => onItemPointerDown(e, t.key)}
              onPointerMove={onItemPointerMove}
              onPointerUp={onItemPointerEnd}
              onPointerCancel={onItemPointerEnd}
              onPointerLeave={onItemPointerEnd}
            >
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
                <span className="todo-text-shimmer">
                  {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
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

/** Choose the source shape and reconstruct the current list. When both
 *  TodoWrite and Task* events exist in the same transcript (e.g. the CLI
 *  was upgraded or reconfigured mid-session), prefer whichever was used
 *  most recently — comparing the message index of the last TodoWrite vs
 *  the last TaskCreate/TaskUpdate. This prevents a stale TodoWrite snapshot
 *  from an old turn from shadowing a live Task* stream (and vice versa).
 *  Returns null when neither source has any items. */
function extractTodos(messages: SdkMessage[], working: boolean): ExtractResult | null {
  const tw = extractLatestTodos(messages, working)
  const tkTodos = extractFromTaskEvents(messages)
  // Compare last-message-index: whichever source was used more recently wins.
  // Check tw directly (not a derived variable) so TypeScript narrows it.
  if (tw && tw.todos.length > 0 && (!tkTodos || tw.lastIndex > lastTaskEventIndex(messages))) {
    return { todos: tw.todos, source: 'todowrite' }
  }
  if (tkTodos && tkTodos.length > 0) return { todos: tkTodos, source: 'task' }
  return null
}

/** Find the message index of the most recent TaskCreate/TaskUpdate tool_use,
 *  or -1 if none. Used by extractTodos to compare recency against TodoWrite. */
function lastTaskEventIndex(messages: SdkMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'tool_use' && (block.name === 'TaskCreate' || block.name === 'TaskUpdate')) {
        return i
      }
    }
  }
  return -1
}

/** Walk the message list in reverse and return the todos from the most
 *  recent `TodoWrite` tool_use block, plus the message index where it was
 *  found (for recency comparison in extractTodos). Returns null when none
 *  found.
 *
 *  When `working === true`, ignore TodoWrites that appear *before* the
 *  most recent `result` marker — those belong to a previous completed
 *  turn and would show stale todos on top of a fresh task until the
 *  assistant gets around to calling TodoWrite for the new task. (Many
 *  turns don't call TodoWrite at all; pinning to the last turn's
 *  todos while the new one runs is worse than showing nothing.)
 *  `stream_event` partials are skipped — their content lives on
 *  `event`, not `message.content`. */
function extractLatestTodos(messages: SdkMessage[], working: boolean): { todos: Todo[]; lastIndex: number } | null {
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
      return { todos: sanitizeTodos(input.todos), lastIndex: i }
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
      // TodoWrite snapshots have no per-item id — the content string is the
      // only stable-ish identity. A hidden item reappears if the agent
      // rewords it (key changes → old hidden key gets pruned).
      key: obj.content,
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

/** Fold the whole TaskCreate/TaskUpdate stream into the current list.
 *
 *  Unlike TodoWrite (a per-turn full snapshot), Task* state is cumulative
 *  across the session. The core fold (keyed by `#N`, correlating each
 *  create's tool_result to learn the id) lives in
 *  `buildTaskStateMap` (`src/utils/task-events.ts`); this wrapper applies
 *  the visibility cleanup on top — stale-completed tasks (resolved AND last
 *  touched before the latest user-input turn) and stale provisional orphans
 *  are dropped. Returns null when no Task* events exist. */
function extractFromTaskEvents(messages: SdkMessage[]): Todo[] | null {
  const tasks = buildTaskStateMap(messages)
  if (!tasks) return null

  // Cleanup boundary: a completed task whose last create/update predates
  // this turn belongs to a previous request the user has moved on from, so
  // it's stale and gets cleaned up. Tasks touched at or after this point
  // are part of the current request and stay visible (so a just-finished
  // task lingers with its ✔ until the user sends the next message).
  const lastUserInputIdx = lastUserInputIndex(messages)

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
      // Server-assigned `#N` id — the stable identity for the hide-set. A
      // provisional `pending:<toolUseId>` key resolves to `#N` once the
      // TaskCreate result lands; the old key is pruned and the task shows
      // again (it's genuinely in-flight).
      key: t.id,
      content: t.subject,
      // 'cancelled' maps to 'completed' for the 3-state UI (it's resolved —
      // won't be worked on); this also makes it count toward done/total.
      status: t.status === 'cancelled' ? 'completed' : t.status,
      activeForm: t.activeForm,
    })
  }
  return out
}
