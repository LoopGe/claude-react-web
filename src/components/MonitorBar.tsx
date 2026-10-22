// Sticky bar that surfaces Monitor background tasks that are currently
// running, rendered at the top of the chat area (alongside TodoChecklist) so
// users can see at a glance that a Monitor is live without scrolling the
// transcript.
//
// The `Monitor` tool starts a background script; each stdout line is injected
// into the conversation as a notification. This app has no dedicated handling
// for those events, so without this bar a running Monitor is nearly invisible
// (it falls through to the unknown-tool JSON card in ToolUseBlock).
//
// HOW RUNNING-NESS IS DETERMINED (best-effort, see plan):
// The tool_result for a Monitor call returns at START ("Monitor started …"),
// NOT at completion, so it can't tell us if the monitor is still alive. We
// rely on two signals that are SAFE (no false "stopped" while it's running):
//   - A `TaskStop` whose task_id matches  → stopped. This is the clean,
//     reliable end signal (TaskStop's input carries {task_id}).
//   - A `<task-notification>` user injection whose <task-id> matches →
//     settled. The harness delivers this when the background task ends
//     (completion OR expiry — e.g. a persistent Monitor timing out). It is
//     the ONLY end signal a persistent monitor gets short of TaskStop, and
//     it also makes history replay correct (the walk re-reads the whole
//     stream, so ended monitors never reappear in old transcripts).
//   - Non-persistent + past its timeout window (receivedAt + timeout_ms)
//     → assumed ended.
//   - Otherwise → running.
// `now` is refreshed on an interval so the timeout rule takes effect over time.
//
// We deliberately do NOT scan free text for "ended"/"completed"/"exit"
// markers: a monitor's own grep filter routinely contains those very words
// (e.g. `grep -E "done|exited|completed"`), and the command is echoed into the
// stream — so a text scan would falsely hide a RUNNING monitor. Showing a
// finished monitor slightly too long is far better than hiding a live one.

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SdkMessage } from '../types'
import { AnimatePresence } from 'motion/react'
import { BottomCardMotion } from './BottomCardMotion'
import { AnimatedCollapse } from './AnimatedCollapse'
import { DockRotor } from './DockRotor'
import { IconChevronDown, IconCircleDot } from './icons/ToolIcons'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useRotor } from '../hooks/useRotor'
import { isTaskNotificationUserMessage } from '../session-store/normalize'
import { extractTags } from './message-list/rendering'
import { MonitorDetailPopover, type MonitorDetail } from './MonitorDetailPopover'
import type { AnchorRect } from './AnchoredPopover'

interface MonitorInfo {
  /** tool_use id of the Monitor call — stable key. */
  key: string
  /** Server-assigned background task id (e.g. "biuwhpwky"), if parsed. */
  taskId?: string
  description: string
  persistent: boolean
  /** The Monitor tool's full `command` input — shown in the detail popover
   *  (the row's label is the description, or the command's first line). */
  command?: string
}

interface Props {
  messages: SdkMessage[]
  /** True while a /clear is in flight. Reuses the transcript's
   *  `clear-blur-fade` exit animation so the bar dissolves in sync with the
   *  message list instead of snapping out when the server wipes the store.
   *  The last visible list is frozen for the duration so the bar stays
   *  mounted (and fading) after `messages` empties. */
  clearing?: boolean
  /** Per-session persistence key for the collapse state. When omitted the
   *  state stays in memory only (no localStorage writes) — the tests rely
   *  on this. Mirrors TodoChecklist's sessionId contract. */
  sessionId?: string
}

const TICK_MS = 5000

// localStorage key for the per-session collapse state (same scheme as the
// TodoChecklist card). null → pure in-memory state.
const LS_PREFIX = 'claude-react-web:monitor:'
function keyCollapsed(sid?: string): string | null {
  return sid ? `${LS_PREFIX}collapsed:${sid}` : null
}

export const MonitorBar = memo(function MonitorBar({ messages, clearing, sessionId }: Props) {
  const [now, setNow] = useState(() => Date.now())

  // Overlay scrollbar for the list (same treatment as .todo-panel-list: the
  // native bar is hidden and a leave-autohide thumb is drawn instead).
  const setListOs = useOverlayScrollbar({ autoHide: 'leave' })

  // Unique per mounted bar: up to 3 chat panels can each render a MonitorBar,
  // and a hardcoded id would duplicate across them (invalid HTML — every
  // button's aria-controls would resolve to whichever card mounts first).
  const listId = useId()

  // Collapse state — persisted per session like the TodoChecklist card's
  // (null sessionId → in-memory only, which the tests rely on).
  const [collapsed, setCollapsed] = useLocalStorage<boolean>(keyCollapsed(sessionId), false, {
    validate: (v): v is boolean => typeof v === 'boolean',
  })

  // Refresh `now` so the timeout heuristic advances. Only meaningful while the
  // bar might be showing, but the cost is trivial; keep it simple.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [])

  const monitors = useMemo(() => extractRunningMonitors(messages, now), [messages, now])

  // Freeze the last non-empty monitor list so a /clear can keep rendering it
  // (fading) after the store wipes `messages`. Updated only while NOT
  // clearing — during a clear we read the frozen value, never overwrite.
  // Setting it to null when the bar is empty (no running monitors) also
  // clears any stale capture, so a clear that starts while the bar is
  // already hidden doesn't resurrect a faded-out stale list.
  const frozenRef = useRef<MonitorInfo[] | null>(null)
  if (!clearing) frozenRef.current = monitors.length > 0 ? monitors : null

  // During a clear, dissolve in sync with the transcript instead of snapping
  // out. Prefer the frozen capture (keeps fading after the store wipe); fall
  // back to the live list when the ref is empty (a clear that lands on the
  // very first render, before any non-clearing render populated it). If both
  // are empty the bar was hidden when the clear started — nothing to fade.
  const renderList = clearing ? (frozenRef.current ?? monitors) : monitors
  // Mount rise-in + staggered exit come from the shared BottomCardMotion
  // wrapper (also the exit-only overflow clip); AnimatePresence keeps the bar
  // mounted through the exit and re-renders its LAST element (props frozen),
  // so the exiting bar keeps its content and its `-clearing` class. Snaps
  // under reduced motion.

  // --- collapsed-header rotor -------------------------------------------
  // While the bar is collapsed (docked behind the composer) the header's left
  // slot rotates through the running monitors' descriptions — one every 3s,
  // wrapping, paused while the pointer rests on the header (so the expand
  // target stays put under the cursor). The expanded header keeps the static
  // title alone. Same shared useRotor hook as the TodoChecklist card; the sig
  // is the running monitors' key-join — a PRIMITIVE, since renderList is a
  // fresh array identity whenever `messages` or the 5s `now` tick re-renders
  // the bar. Every item in renderList IS running by construction (that is the
  // bar's whole point), so the rotator's item set is the list itself. The
  // running signal is the label's own shimmer (the same class the list rows
  // carry) — no spinner glyph.
  const rotorSig = renderList.map((m) => m.key).join('\u0000')
  const rotorActive = collapsed && renderList.length > 0
  const rotor = useRotor({ sig: rotorSig, count: renderList.length, active: rotorActive })
  const rotorItem = rotorActive ? renderList[rotor.index] : null
  const rotorLabel = rotorItem ? rotorItem.description : ''

  // --- click-open detail popover ----------------------------------------
  // Behavior parity with the TaskList card (TodoChecklist): clicking a row
  // opens MonitorDetailPopover anchored to it — the full description, the
  // background task id, and the command the row's one-line label drops.
  const [openDetail, setOpenDetail] = useState<{ key: string; anchor: AnchorRect } | null>(null)
  const openRowRef = useRef<HTMLElement | null>(null)
  // The open row's Monitor, re-derived every render — if the monitor vanishes
  // (settles, TaskStop, timeout) the popover closes with it.
  const openMonitor = openDetail ? renderList.find((m) => m.key === openDetail.key) : undefined
  const closeDetail = useCallback(() => setOpenDetail(null), [])
  // The detail object is built from the open monitor's PRIMITIVES, not from
  // `openMonitor` itself: renderList is a fresh array on every `now` tick (5s)
  // and every messages change, so an object keyed on the found record would
  // change identity constantly and defeat MonitorDetailPopover's memo for the
  // whole life of the bar.
  const openDescription = openMonitor?.description
  const openTaskId = openMonitor?.taskId
  const openCommand = openMonitor?.command
  const openPersistent = openMonitor?.persistent === true
  const detail: MonitorDetail | null = useMemo(() => {
    if (openDescription === undefined) return null
    return {
      description: openDescription,
      ...(openTaskId !== undefined ? { taskId: openTaskId } : {}),
      ...(openCommand !== undefined ? { command: openCommand } : {}),
      persistent: openPersistent,
    }
  }, [openDescription, openTaskId, openCommand, openPersistent])

  // Collapse hides the rows the popover anchors to — close it with them.
  useEffect(() => {
    if (collapsed) setOpenDetail(null)
  }, [collapsed])
  // The open monitor vanishing (stale cleanup, TaskStop, timeout, /clear)
  // unmounts the popover — but `openDetail` must be cleared too, or a later
  // monitor reusing the same key re-opens the popover with no user click.
  useEffect(() => {
    if (openDetail && !openMonitor) setOpenDetail(null)
  }, [openDetail, openMonitor])

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

  return (
    <>
    {/* NOT inside the AnimatePresence below: AnimatePresence holds an
        unmounting child through its exit animation with props frozen, which
        is right for the bar but wrong for the popover — a dismissed popover
        must unmount instantly (same convention as TodoChecklist's). */}
    <AnimatePresence initial={false}>
      {renderList.length > 0 && (
        <BottomCardMotion key="monitor-bar">
          <div
            className={`monitor-bar${clearing ? ' monitor-bar-clearing' : ''}${collapsed ? ' monitor-bar-collapsed' : ''}`}
            role="status"
            aria-label="Running monitors"
          >
            <div
              className="monitor-bar-header"
              onMouseEnter={rotor.hoverStart}
              onMouseLeave={rotor.hoverEnd}
            >
              <span className="monitor-bar-title">Monitors</span>
              {rotorActive && (
                <DockRotor
                  slideKey={rotorItem?.key ?? ''}
                  index={rotor.index}
                  total={renderList.length}
                  label={rotorLabel}
                  shimmerClass="monitor-text-shimmer"
                />
              )}
              <div className="monitor-bar-header-right">
                <button
                  type="button"
                  className={`monitor-bar-collapse${collapsed ? '' : ' open'}`}
                  onClick={() => setCollapsed((c) => !c)}
                  title={collapsed ? 'Expand monitor list' : 'Collapse monitor list'}
                  aria-expanded={!collapsed}
                  aria-controls={listId}
                  aria-label={collapsed ? 'Expand monitor list' : 'Collapse monitor list'}
                >
                  <IconChevronDown size={16} />
                </button>
                <span className="monitor-bar-count">{renderList.length}</span>
              </div>
            </div>
            {/* Same fold topology as the TodoChecklist card: the stack's height
                cap lands on the collapse BODY (which scrolls), the list keeps
                its intrinsic height, and animateResize tweens a row appearing
                or disappearing (see .monitor-bar .animated-collapse).
                unmountOnExit stays OFF so the folded body keeps `listId`
                reachable for the button's aria-controls — AnimatedCollapse
                marks it aria-hidden once the fold settles, which is the exact
                case its `id` prop documents. */}
            <AnimatedCollapse open={!collapsed} unmountOnExit={false} id={listId} animateResize remeasureWhileClamped>
              <ul ref={setListOs} className="monitor-bar-list">
                {renderList.map((m) => (
                  <li
                    // Key on the tool_use id (stable) so an open popover's
                    // triggerRef keeps pointing at ITS row when sibling rows
                    // are added/removed above it.
                    key={m.key}
                    className="monitor-item monitor-item-clickable"
                    role="button"
                    tabIndex={0}
                    aria-haspopup="dialog"
                    aria-expanded={openDetail?.key === m.key}
                    onClick={(e) => onItemActivate(e, m.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onItemActivate(e, m.key)
                      }
                    }}
                  >
                    <span className="monitor-icon" aria-hidden>
                      <IconCircleDot size={12} />
                    </span>
                    <span className="monitor-text truncate">
                      <span className="monitor-text-shimmer">{m.description}</span>
                    </span>
                    {m.persistent && <span className="tool-chip tool-chip-accent">persistent</span>}
                  </li>
                ))}
              </ul>
            </AnimatedCollapse>
          </div>
        </BottomCardMotion>
      )}
    </AnimatePresence>
    {detail && openDetail && (
      <MonitorDetailPopover
        detail={detail}
        anchor={openDetail.anchor}
        triggerRef={openRowRef}
        onClose={closeDetail}
      />
    )}
    </>
  )
})

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

const MONITOR = 'Monitor'
const TASK_STOP = 'TaskStop'

/** Walk the message stream and return the Monitor calls that appear to still
 *  be running. Mirrors the tool_use/tool_result correlation approach used by
 *  TodoChecklist's extractFromTaskEvents. */
function extractRunningMonitors(messages: SdkMessage[], now: number): MonitorInfo[] {
  // 1) Index every tool_result text by the tool_use_id it answers.
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

  // 2) Collect task ids that have been explicitly stopped via TaskStop.
  const stoppedTaskIds = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_use' || block.name !== TASK_STOP) continue
      const input = block.input as Record<string, unknown> | undefined
      const id = str(input?.task_id) ?? str(input?.shell_id)
      if (id) stoppedTaskIds.add(id)
    }
  }

  // 3) Walk Monitor tool_use blocks into candidate records; decide
  // running-ness AFTER, so the (comparatively expensive) settled-notification
  // scan only runs when a monitor with a parsed taskId actually exists.
  const candidates: Array<MonitorInfo & { timeoutEnd?: number }> = []
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_use' || block.name !== MONITOR) continue
      const toolUseId = typeof block.id === 'string' ? block.id : undefined
      const input = (block.input as Record<string, unknown> | undefined) ?? undefined

      const resText = toolUseId ? resultByToolUseId.get(toolUseId) : undefined
      const taskId = resText ? parseMonitorTaskId(resText) : undefined
      const persistent = input?.persistent === true
      const timeoutMs = typeof input?.timeout_ms === 'number' ? input.timeout_ms : undefined
      const start = typeof msg.receivedAt === 'number' ? msg.receivedAt : undefined

      const description =
        str(input?.description) ?? firstLine(str(input?.command)) ?? 'Background monitor'

      candidates.push({
        key: toolUseId ?? `monitor:${candidates.length}`,
        taskId,
        description,
        persistent,
        command: str(input?.command),
        timeoutEnd: !persistent && start && timeoutMs ? start + timeoutMs : undefined,
      })
    }
  }
  if (candidates.length === 0) return []

  // 4) Collect task ids the harness has reported SETTLED via a
  // <task-notification> user injection — the authoritative end signal for a
  // monitor that was never TaskStopped and (being persistent) has no timeout
  // window: the injection's <task-id> is the same server task id
  // parseMonitorTaskId extracts from the "Monitor started (task …)" result,
  // so the correlation is exact. Structured-tag sniffing, not free text —
  // the false-positive concern in the header comment doesn't apply. A
  // notification can carry MULTIPLE task-ids (corpus: "2 background shell
  // command tasks didn't finish" lists 3-4), so extract all of them.
  const settledTaskIds = new Set<string>()
  if (candidates.some((c) => c.taskId)) {
    for (const msg of messages) {
      if (!isTaskNotificationUserMessage(msg)) continue
      // Parse the LEADING text block only — the same slice the canonical
      // grammar (shared/user-frames taskNotificationText) matched on. A
      // later block quoting '<task-id>…' verbatim must not settle a task.
      const text = leadingUserText(msg)
      if (!text) continue
      for (const id of extractTags(text, 'task-id')) {
        if (id) settledTaskIds.add(id)
      }
    }
  }

  // 5) Ended? (the three safe signals; see header comment.)
  return candidates.flatMap((c) => {
    if (c.taskId && stoppedTaskIds.has(c.taskId)) return []
    if (c.taskId && settledTaskIds.has(c.taskId)) return []
    if (c.timeoutEnd != null && now > c.timeoutEnd) return []
    const { timeoutEnd: _drop, ...info } = c
    return [info]
  })
}

/** Parse the background task id out of a "Monitor started (task <id>, …)"
 *  result string. */
function parseMonitorTaskId(text: string): string | undefined {
  const m = text.match(/task\s+([A-Za-z0-9]+)/)
  return m ? m[1] : undefined
}

/** Coerce a tool_result `content` field (string | array of text blocks |
 *  other) to a flat string. Same shape as TodoChecklist.resultText. */
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

/** First non-empty line of a string, trimmed. */
function firstLine(s: string | undefined): string | undefined {
  if (!s) return undefined
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return line
}

/** Narrow an unknown to a non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** The message's FIRST text block only — the slice the canonical
 *  `<task-notification>` grammar (shared/user-frames) matches on. Unlike
 *  extractUserText this never joins later blocks, so a quoted
 *  `<task-id>` literal in a trailing block can't settle a task. */
function leadingUserText(msg: SdkMessage): string | null {
  const content = msg.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const b = (content as Array<{ type?: unknown; text?: unknown }>).find(
      (b) => b?.type === 'text' && typeof b.text === 'string',
    )
    return b && typeof b.text === 'string' ? b.text : null
  }
  return null
}
