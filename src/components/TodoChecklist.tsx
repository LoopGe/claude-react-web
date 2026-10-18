// Floating checklist that surfaces the current task list from the message
// stream. Rendered as the bottom member of the transcript's overlay stack
// (.chat-bottom-stack, alongside the live streaming bubble), so settled
// messages scroll behind it and show through its frosted background.
// MessageList measures the stack and reserves its height, so the newest
// message can always be scrolled clear of the card.
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
import { IconCheck, IconCircleDot, IconCircle, IconCheckboxDot, IconCheckbox, IconChevronDown } from './icons/ToolIcons'
import { AnimatedCollapse } from './AnimatedCollapse'
import { DockRotor } from './DockRotor'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { AnimatePresence } from 'motion/react'
import { BottomCardMotion } from './BottomCardMotion'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { useRotor } from '../hooks/useRotor'
import { TodoDetailPopover } from './TodoDetailPopover'
import {
  buildTaskStateMap,
  lastUserInputIndex,
  filterVisibleTasks,
  mergeTaskList,
  type TasklistSnapshotPayload,
} from '../utils/task-events'

interface Todo {
  /** Stable identity for the item (strike-transition bookkeeping). Task*
   *  items use the server-assigned numeric id (`#N`, from TaskState.id);
   *  TodoWrite snapshots have no id, so the content string is the fallback. */
  key: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  /** Task* items only — the TaskCreate/TaskUpdate description, shown in the
   *  click-open detail popover. TodoWrite snapshots carry none. */
  description?: string
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
  /** Per-session persistence key for the collapse state. When omitted the
   *  collapse stays in memory only (no localStorage writes) — the tests
   *  rely on this. */
  sessionId?: string
  /** Server-derived full-transcript fold (useTaskList). Base layer merged
   *  UNDER the window fold — window entries win per id. null/undefined =
   *  degrade to window-only (pre-snapshot behavior). */
  serverTasks?: TasklistSnapshotPayload | null
}

// localStorage keys for per-session UI state. null → pure in-memory state.
const LS_PREFIX = 'claude-react-web:todo:'
function keyCollapsed(sid?: string): string | null {
  return sid ? `${LS_PREFIX}collapsed:${sid}` : null
}

export const TodoChecklist = memo(function TodoChecklist({ messages, working, skin, clearing, sessionId, serverTasks }: Props) {
  const result = useMemo(() => extractTodos(messages, !!working, serverTasks), [messages, working, serverTasks])
  const hc = skin === 'hc'
  // Cap the list height so a long checklist doesn't dominate the viewport
  // (the card is a bottom overlay; without a cap the stack outgrows the
  // transcript and blanks it out). The list scrolls internally via the
  // project's overlay
  // scrollbar (same as MessageList / RecapWindow), keeping the header + count
  // visible. Declared here (before the early returns) so the hook order is
  // stable across renders where the panel is hidden.
  const setListScroller = useOverlayScrollbar({ autoHide: 'leave' })

  // --- collapse state ----------------------------------------------------
  // Persisted per session in localStorage (null key → in-memory only, which
  // the existing tests rely on). Declared before the early return so the
  // hook order is stable across renders where the panel is hidden.
  const [collapsed, setCollapsed] = useLocalStorage<boolean>(keyCollapsed(sessionId), false, {
    validate: (v): v is boolean => typeof v === 'boolean',
  })

  // One-time cleanup: the long-press-to-hide feature (removed) persisted a
  // `hidden:<sid>` key per session. Nothing reads it anymore — drop it.
  useEffect(() => {
    if (sessionId) window.localStorage.removeItem(`${LS_PREFIX}hidden:${sessionId}`)
  }, [sessionId])

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
  // Mount rise-in + staggered exit (fade leads, height collapse follows) come
  // from the shared BottomCardMotion wrapper (also the exit-only overflow
  // clip). AnimatePresence keeps the node mounted through the exit and
  // re-renders its LAST element — props frozen — so the exiting card keeps its
  // content AND its `-clearing` class (a /clear's blur survives the handoff
  // with no manual latch). Snaps under reduced motion.

  // Visible list is the render result. The count chip reflects it.
  // Memoised so the `[]` fallback (panel hidden) keeps a stable identity and
  // the useMemo/useEffect below don't re-run on every render while hidden.
  const todos = useMemo(() => (renderResult ? renderResult.todos : []), [renderResult])
  const doneCount = todos.filter((t) => t.status === 'completed').length

  // --- collapsed-header rotor -------------------------------------------
  // While the card is collapsed (docked behind the composer) and tasks are
  // running, the header's left slot rotates through the in_progress items'
  // activeForm — one every 3s (useRotor's shared default; MonitorBar docks
  // the same way, so the two bars cannot drift apart), wrapping, paused while
  // the pointer rests on the header (so the expand target stays put under
  // the cursor). Expanded, idle, or nothing-running headers keep the static
  // title. The sig is the running items' key-join — a PRIMITIVE, since
  // todos is a fresh array every render and during a turn `messages`
  // churns constantly.
  const runningTodos = todos.filter((t) => t.status === 'in_progress')
  const runningSig = runningTodos.map((t) => t.key).join('\u0000')
  const rotorActive = collapsed && runningTodos.length > 0
  const rotor = useRotor({ sig: runningSig, count: runningTodos.length, active: rotorActive })
  const rotorTask = rotorActive ? runningTodos[rotor.index] : null
  const rotorLabel = rotorTask ? rotorTask.activeForm || rotorTask.content : ''

  // --- fresh-completion strike animation -------------------------------
  // A completed item's strike sweeps left→right ONLY on the render where it
  // transitions to completed (live, while mounted) — not on initial load or
  // history replay, where already-done tasks just show a static line. The
  // transition is detected at render time by comparing each render's statuses
  // against the previous COMMITTED render's (`prevStatusRef`, written by the
  // effect below); the fresh keys are then merged into `struckKeys` (state)
  // so the `.todo-strike-anim` class survives the renders that follow the
  // transition frame — otherwise a message landing inside the sweep window
  // would drop the class and cut the animation short.
  const [struckKeys, setStruckKeys] = useState<ReadonlySet<string>>(new Set())
  const prevStatusRef = useRef<Map<string, Todo['status']> | null>(null)
  const freshCompletedKeys = useMemo(() => {
    const out = new Set<string>()
    const prev = prevStatusRef.current
    if (!prev) return out
    for (const t of todos) {
      // Only a genuine pending / in_progress → completed transition animates.
      // A task that first APPEARS as completed (a new key in the next snapshot,
      // or history replay) is not a live completion and stays static.
      if (t.status === 'completed') {
        const was = prev.get(t.key)
        if (was === 'pending' || was === 'in_progress') out.add(t.key)
      }
    }
    return out
  }, [todos])

  useEffect(() => {
    // Panel hidden (no todos rendered): keep the baseline so a re-shown list
    // of already-completed tasks doesn't sweep on re-appear.
    if (!renderResult) return
    const map = new Map<string, Todo['status']>()
    for (const t of todos) map.set(t.key, t.status)
    setStruckKeys((prev) => {
      const next = new Set<string>()
      let changed = false
      for (const k of prev) {
        if (map.get(k) === 'completed') next.add(k)
        else changed = true
      }
      for (const k of freshCompletedKeys) {
        if (!next.has(k)) { next.add(k); changed = true }
      }
      return changed ? next : prev
    })
    prevStatusRef.current = map
  }, [todos, freshCompletedKeys, renderResult])

  // --- click-open detail popover ----------------------------------------
  // Task* rows carry fields the one-line card can't show (description, the
  // server `#N`, activeForm) — clicking a row opens TodoDetailPopover
  // anchored to it. TodoWrite snapshot rows have nothing beyond the line
  // already shown, so they stay non-interactive.
  const sourceIsTask = renderResult?.source === 'task'
  const [openDetail, setOpenDetail] = useState<{ key: string; anchor: { top: number; bottom: number; left: number; width: number; height: number } } | null>(null)
  const openRowRef = useRef<HTMLElement | null>(null)
  // The open row's Todo, re-derived every render — if the task vanishes
  // (agent deletes it, /clear) the popover closes with it.
  const openTodo = openDetail && sourceIsTask ? todos.find((t) => t.key === openDetail.key) : undefined

  // Collapse hides the rows the popover anchors to — close it with them.
  useEffect(() => {
    if (collapsed) setOpenDetail(null)
  }, [collapsed])
  // The open task vanishing (stale cleanup, agent delete, /clear) unmounts
  // the popover — but `openDetail` must be cleared too, or a later task reusing
  // the same key re-opens the popover with no user click.
  useEffect(() => {
    if (openDetail && !openTodo) setOpenDetail(null)
  }, [openDetail, openTodo])

  const onItemActivate = (e: React.SyntheticEvent<HTMLLIElement>, key: string) => {
    // Held-key auto-repeat would toggle the popover open/shut every ~30ms.
    if (e.nativeEvent instanceof KeyboardEvent && e.nativeEvent.repeat) return
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    openRowRef.current = el
    setOpenDetail((prev) =>
      prev?.key === key
        ? null
        : { key, anchor: { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height } },
    )
  }

  // The id chip only makes sense for a resolved `#N` — an in-flight create's
  // provisional key is `pending:<toolUseId>` and must not render as `#…`.
  const detail = useMemo(
    () => openTodo
      ? {
          id: /^\d+$/.test(openTodo.key) ? openTodo.key : undefined,
          subject: openTodo.content,
          status: openTodo.status,
          activeForm: openTodo.activeForm,
          description: openTodo.description,
        }
      : null,
    [openTodo],
  )
  const closeDetail = useCallback(() => setOpenDetail(null), [])

  return (
    <>
    {/* NOT inside the AnimatePresence below: AnimatePresence holds an
        unmounting child through its exit animation with props frozen, which
        is right for the card but wrong for the popover — a dismissed popover
        must unmount instantly (same convention as ContextMenu's callers).
        Inside, a jsdom/no-rAF exit would strand the node forever. */}
    <AnimatePresence initial={false}>
      {renderResult && (
        <BottomCardMotion key="todo-panel">
          <div
            className={`todo-panel${working ? ' todo-panel-working' : ''}${clearing ? ' todo-panel-clearing' : ''}${collapsed ? ' todo-panel-collapsed' : ''}`}
            role="status"
            aria-label="Task checklist"
          >
            <div
              className="todo-panel-header"
              onMouseEnter={rotor.hoverStart}
              onMouseLeave={rotor.hoverEnd}
            >
              <span className="todo-panel-title">{renderResult.source === 'todowrite' ? 'TodoList' : 'TaskList'}</span>
              {rotorActive && (
                <DockRotor
                  slideKey={rotorTask?.key ?? ''}
                  index={rotor.index}
                  total={runningTodos.length}
                  label={rotorLabel}
                  shimmerClass="todo-text-shimmer"
                />
              )}
              <div className="todo-panel-header-right">
                <button
                  type="button"
                  className={`todo-panel-collapse${collapsed ? '' : ' open'}`}
                  onClick={() => setCollapsed((c) => !c)}
                  title={collapsed ? 'Expand task list' : 'Collapse task list'}
                  aria-expanded={!collapsed}
                  aria-controls="todo-panel-list"
                  aria-label={collapsed ? 'Expand task list' : 'Collapse task list'}
                >
                  <IconChevronDown size={16} />
                </button>
                <span className="todo-panel-count">
                  {doneCount}/{todos.length}
                </span>
              </div>
            </div>
            {/* remeasureWhileClamped: this card lives in .chat-bottom-stack, whose
                45% height cap lands on the collapse body. The card's own content is
                left at its intrinsic height (see `.todo-panel .animated-collapse-content`),
                so the body can be re-pinned to it while the cap holds and come back at
                full height when the cap lifts. */}
            <AnimatedCollapse open={!collapsed} animateResize remeasureWhileClamped>
              <ul ref={setListScroller} id="todo-panel-list" className="todo-panel-list">
                {todos.map((t, i) => {
                  // Only Task* rows are clickable — TodoWrite snapshots carry
                  // nothing beyond the rendered line.
                  const clickable = sourceIsTask
                  return (
                  <li
                    // Task* rows key on the stable task id (an open popover's
                    // triggerRef must keep pointing at ITS row when sibling
                    // rows are added/removed above it — an index key would
                    // reuse DOM nodes and misalign it). TodoWrite snapshots
                    // have no id and can carry duplicate contents, so they
                    // stay index-keyed; those rows never open a popover.
                    key={sourceIsTask ? t.key : i}
                    className={`todo-item todo-${t.status}${clickable ? ' todo-item-clickable' : ''}${t.status === 'completed' && (struckKeys.has(t.key) || freshCompletedKeys.has(t.key)) ? ' todo-strike-anim' : ''}`}
                    {...(clickable
                      ? {
                          role: 'button',
                          tabIndex: 0,
                          'aria-haspopup': 'dialog',
                          'aria-expanded': openDetail?.key === t.key,
                          onClick: (e) => onItemActivate(e, t.key),
                          onKeyDown: (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onItemActivate(e, t.key)
                            }
                          },
                        }
                      : {})}
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
                    <span className="todo-text truncate">
                      <span className="todo-text-shimmer">
                        {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
                      </span>
                    </span>
                  </li>
                  )
                })}
              </ul>
            </AnimatedCollapse>
          </div>
        </BottomCardMotion>
      )}
    </AnimatePresence>
    {detail && openDetail && (
      <TodoDetailPopover
        detail={detail}
        anchor={openDetail.anchor}
        triggerRef={openRowRef}
        onClose={closeDetail}
      />
    )}
    </>
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
function extractTodos(messages: SdkMessage[], working: boolean, serverTasks: TasklistSnapshotPayload | null | undefined): ExtractResult | null {
  const tw = extractLatestTodos(messages, working)
  const tkTodos = extractFromTaskEvents(messages, serverTasks)
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
function extractFromTaskEvents(messages: SdkMessage[], serverTasks: TasklistSnapshotPayload | null | undefined): Todo[] | null {
  const windowTasks = buildTaskStateMap(messages)
  const merged = mergeTaskList(serverTasks, windowTasks)
  if (merged.size === 0) return null

  // Cleanup boundary: a completed task whose last create/update predates
  // this turn belongs to a previous request the user has moved on from, so
  // it's stale and gets cleaned up. Tasks touched at or after this point
  // are part of the current request and stay visible (so a just-finished
  // task lingers with its ✔ until the user sends the next message).
  // The filter itself is the shared filterVisibleTasks (one copy for the
  // component and the cross-layer regression test).
  const lastUserInputIdx = lastUserInputIndex(messages)

  const out: Todo[] = []
  for (const t of filterVisibleTasks(merged, lastUserInputIdx)) {
    out.push({
      key: t.id,
      content: t.subject,
      status: t.status === 'cancelled' ? 'completed' : t.status,
      activeForm: t.activeForm,
      ...(t.description !== undefined ? { description: t.description } : {}),
    })
  }
  return out
}
