// Aggregate display for in-flight subagents (working-bar chrome).
//
// The pill is the working bar's ONLY subagent surface, at every fan-out width
// including a single agent. It replaced a per-agent chip row that wrapped onto
// new rows and grew the bar by one row per agent: in a narrow (3-panel) column
// a 5-way fan-out reached ~176px, past `.working-bar`'s old `max-height: 120px`,
// and `overflow: hidden` silently ate the tail — starting with the "+N more"
// badge that rendered last. It also meant N rows of churn as agents settled
// (the viewport jump Chat's `pendingTurnSince` bridge exists to avoid) and N
// independent 1Hz `ElapsedTimer` intervals inside an `aria-live` region.
//
// The bar height no longer scales with fan-out width — one row's worth of
// subagent chrome at any count — and the per-agent detail moves into a
// popover: `progressSummary` / `lastToolName` / elapsed per row, plus the
// drill-in. (The bar itself is still `flex-wrap: wrap` and the pill still
// `nowrap`, so a row that overflows the column can wrap as a whole; what can
// no longer happen is growth proportional to the agent count.) A single agent
// shows only "1 agent" + its timer — its label is deliberately NOT inlined, so
// the bar reads the same at every width and the popover stays the one place
// detail is read.
//
// The popover is the summary/entry point for the surfaces that already own
// the full picture (SubagentOverlay for a single agent's transcript,
// TasksPanel for the task list) — deliberately not a third list
// implementation.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { usePopoverMotion } from '../../utils/transitions'
import { useEscapeStack } from '../../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../../hooks/useOutsideMouseDown'
import { useOverlayScrollbar } from '../../hooks/useOverlayScrollbar'
import { useMergedRef } from '../../utils/mergedRef'
import { applyPortaledThemeVars } from '../../theme'
import { ElapsedTimer } from '../ElapsedTimer'
import { IconChevronDown, IconExternalLink } from '../icons/ToolIcons'
import type { ActiveSubagent } from '../../session-store/types'

/** Viewport-coordinate anchor for the popover. The element the popover has to
 *  find (its trigger, for the theme vars and the outside-press exemption) is a
 *  ref, not part of this state — see `triggerRef` on the pill. */
interface Anchor {
  x: number
  y: number
}

/** The secondary line for a row: the agent's own words about what it is doing
 *  (refreshed ~every 30s by task_progress) with the last tool it ran as the
 *  fallback. Empty when the store has neither yet. */
function rowDetail(a: ActiveSubagent): string {
  if (a.progressSummary) return a.progressSummary
  if (a.lastToolName) return `Running ${a.lastToolName}`
  return ''
}

/** Statuses that are still actively working (timer keeps counting from `now`).
 *  Shared by the aggregate pill timer, the popover row timer, and — by
 *  convention — SubagentCard's `isRunning` gate, so the three can't drift.
 *  `pending` freezes at `endedAt` (the parent turn is over; the wait must not
 *  inflate the run time). */
export function isActivelyWorking(status: ActiveSubagent['status']): boolean {
  return status === 'running' || status === 'background'
}

/** Skip a row whose last activity is older than this when picking the
 *  aggregate start — a stranded record (no child frames / completion signal for
 *  half an hour) must not paint a multi-dozen-hour timer over live work that
 *  is seconds old. Matches the reducer's PENDING_TIMEOUT_MS. */
const STALE_ACTIVITY_MS = 30 * 60 * 1000

/** Earliest `startedAt` among ACTIVELY WORKING agents that still show recent
 *  activity — the pill shows this ONE timer ("how long has this fan-out been
 *  going") instead of one per agent, so the always-visible bar ticks once a
 *  second no matter how wide the fan-out.
 *
 *  `pending` is excluded (see isActivelyWorking). Rows whose `endedAt ??
 *  startedAt` is older than STALE_ACTIVITY_MS are also excluded: a stranded
 *  `running` record from 14h/38h ago would otherwise dominate oldestStart
 *  while the live agent is seconds old. A legitimately long-running agent is
 *  safe — its child frames keep `endedAt` fresh. */
function oldestStart(subagents: readonly ActiveSubagent[]): number | undefined {
  const now = Date.now()
  let min: number | undefined
  for (const a of subagents) {
    if (!isActivelyWorking(a.status)) continue
    const lastActivity = a.endedAt ?? a.startedAt
    if (typeof lastActivity === 'number' && now - lastActivity > STALE_ACTIVITY_MS) continue
    if (a.startedAt != null && (min == null || a.startedAt < min)) min = a.startedAt
  }
  return min
}

export const SubagentSwarmPill = memo(function SubagentSwarmPill({
  subagents,
  onOpenSubagent,
}: {
  /** In-flight subagents, in spawn order (the store's Map insertion order).
   *  Order is preserved deliberately: sorting by elapsed or status would make
   *  rows jump around under the cursor as the fan-out progresses. */
  subagents: ActiveSubagent[]
  /** When provided, a row drills into that subagent's transcript. Omitted by
   *  hosts with no overlay — the popover is still useful read-only. */
  onOpenSubagent?: (toolUseId: string) => void
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  /** This pill. Two roles, one node: the popover copies its panel accent from
   *  here (`applyPortaledThemeVars`) and exempts it from outside-press
   *  dismissal (a press on the trigger is the toggle). A ref rather than
   *  state so the exemption reads the live element. */
  const triggerRef = useRef<HTMLButtonElement>(null)

  const total = subagents.length
  const waiting = useMemo(
    () => subagents.reduce((n, a) => (a.status === 'pending' ? n + 1 : n), 0),
    [subagents],
  )
  const running = total - waiting
  const startedAt = useMemo(() => oldestStart(subagents), [subagents])

  const close = useCallback(() => setAnchor(null), [])

  // Everything alive has been swept to `pending` (background work outliving
  // the turn) — calm the pill the same way `.working-bar-waiting` calms the
  // bar, so it doesn't read as active in-turn work.
  const allWaiting = total > 0 && running === 0

  // Stable text for AT: the elapsed timer inside the pill is wrapped
  // aria-hidden below, because `.working-bar` is an aria-live region and a
  // 1Hz-ticking digit there would re-announce the whole pill every second.
  // Singular-aware because the pill now renders for a LONE subagent too — the
  // visible count already pluralizes, and "1 subagents in flight" is the kind
  // of thing a screen-reader user hears on the commonest case. The `plural`
  // suffix is shared by this component's two strings so they can't drift; the
  // popover derives its own (it is a separate component, and the dialog's name
  // is a phrase — "Subagent in flight" — rather than a count plus noun).
  const plural = total === 1 ? '' : 's'
  const a11yLabel =
    waiting > 0
      ? `${total} subagent${plural} in flight, ${waiting} waiting in the background — open the list`
      : `${total} subagent${plural} in flight — open the list`
  const pillLabel = `${total} agent${plural}`

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`subagent-swarm${anchor ? ' subagent-swarm-open' : ''}${allWaiting ? ' subagent-swarm-waiting' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={anchor != null}
        aria-label={a11yLabel}
        title={a11yLabel}
        onClick={(e) => {
          // Toggle: a second click on the pill closes the popover instead of
          // re-anchoring it. The full rationale (and this toggle's two known
          // gaps) lives on the popover's outside-press guard — see
          // `useOutsideMouseDown`'s `triggerRef`.
          if (anchor) {
            close()
            return
          }
          const r = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: r.left, y: r.bottom + 4 })
        }}
      >
        <span className="subagent-swarm-dots" aria-hidden>
          <span />
          <span />
        </span>
        <span className="subagent-swarm-count">{pillLabel}</span>
        {waiting > 0 && running > 0 && (
          <span className="subagent-swarm-split" aria-hidden>
            {waiting} waiting
          </span>
        )}
        {startedAt != null && (
          <span aria-hidden>
            <ElapsedTimer startedAt={startedAt} live className="subagent-swarm-timer" />
          </span>
        )}
        <span className="subagent-swarm-caret" aria-hidden>
          <IconChevronDown size={12} />
        </span>
      </button>
      {anchor && (
        <SubagentSwarmPopover
          anchor={anchor}
          triggerRef={triggerRef}
          subagents={subagents}
          running={running}
          waiting={waiting}
          onOpenSubagent={onOpenSubagent}
          onClose={close}
        />
      )}
    </>
  )
})

function SubagentSwarmPopover({
  anchor,
  triggerRef,
  subagents,
  running,
  waiting,
  onOpenSubagent,
  onClose,
}: {
  anchor: Anchor
  /** The pill that opened this popover — theme source and outside-press
   *  exemption. See the hook's `triggerRef`. */
  triggerRef: RefObject<HTMLButtonElement | null>
  subagents: ActiveSubagent[]
  running: number
  waiting: number
  onOpenSubagent?: (toolUseId: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const setListOs = useOverlayScrollbar({ autoHide: 'leave' })
  const listRefMerged = useMergedRef(listRef, setListOs)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: anchor.x, y: anchor.y })
  const [cursor, setCursor] = useState(0)
  const { popover } = usePopoverMotion()

  const clickable = !!onOpenSubagent
  // Derive rather than store: the fan-out shrinks as agents settle, so a
  // stored index can outrun the list between renders.
  const activeIndex = Math.min(cursor, Math.max(0, subagents.length - 1))

  // Singular-aware for the same reason the pill's label is (see above): the
  // dialog must not announce the plural straight after the button announced
  // the singular for the same one-agent set.
  const popoverLabel = subagents.length === 1 ? 'Subagent in flight' : 'Subagents in flight'

  // Measure after layout, clamp into the viewport, and carry the owning
  // panel's per-session accent across the portal boundary. Re-runs on row
  // count changes because the popover's height (and therefore its clamp)
  // moves as agents settle.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = Math.min(anchor.x, window.innerWidth - rect.width - 4)
    const ny = Math.min(anchor.y, window.innerHeight - rect.height - 4)
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) })
    applyPortaledThemeVars(el, triggerRef.current)
  }, [anchor.x, anchor.y, triggerRef, subagents.length])

  // Esc closes just this popover. Registered through the shared stack (window
  // CAPTURE + stopPropagation) so the keypress cannot fall through to App's
  // interrupt branch or to a chat-panel overlay underneath.
  useEscapeStack({
    active: true,
    onEscape: onClose,
    getContainer: () => ref.current,
  })

  // Focus the popover root so the arrow-key handler below receives keys
  // without needing a text input to hold focus.
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])

  // Outside-click dismissal (Escape is owned by the stack above). The trigger
  // is exempt because it is a TOGGLE: closing on its own mousedown would
  // unmount this popover before the click lands, and that click would read a
  // null `anchor` and re-anchor — the pill could never dismiss its own popover.
  // Two accepted gaps, in gestures whose click never reaches the toggle:
  // a left press released off the trigger, and the clamp parking the popover
  // over the pill (pre-existing geometry — the popover hit-tests first, so the
  // second click lands on its head or a row; in a host passing no
  // `onOpenSubagent` those rows are inert, leaving Esc / an outside click).
  useOutsideMouseDown({ ref, onClose, triggerRef })

  // The last agent settling closes the popover: an empty list would otherwise
  // sit open over a bar that no longer has a pill to anchor it to.
  useEffect(() => {
    if (subagents.length === 0) onClose()
  }, [subagents.length, onClose])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const open = (toolUseId: string) => {
    onOpenSubagent?.(toolUseId)
    onClose()
  }

  return createPortal(
    <motion.div
      ref={ref}
      className="subagent-swarm-pop"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={popoverLabel}
      tabIndex={-1}
      initial={popover.initial}
      animate={popover.animate}
      exit={popover.exit}
      // The window mousedown listener above would otherwise treat a click
      // inside the popover as an outside click.
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setCursor(Math.min(activeIndex + 1, subagents.length - 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setCursor(Math.max(activeIndex - 1, 0))
        } else if (e.key === 'Enter' && clickable) {
          e.preventDefault()
          const target = subagents[activeIndex]
          if (target) open(target.toolUseId)
        }
      }}
    >
      <div className="subagent-swarm-pop-head">
        <span className="subagent-swarm-pop-title">{popoverLabel}</span>
        <span className="subagent-swarm-pop-meta">
          {running > 0 && `${running} running`}
          {running > 0 && waiting > 0 && ' · '}
          {waiting > 0 && `${waiting} waiting`}
        </span>
      </div>
      <div className="subagent-swarm-pop-list" ref={listRefMerged}>
        {subagents.map((a, i) => {
          const detail = rowDetail(a)
          const Tag = clickable ? 'button' : 'div'
          return (
            <Tag
              key={a.toolUseId}
              type={clickable ? 'button' : undefined}
              data-row={i}
              className={`subagent-swarm-row${clickable ? ' subagent-swarm-row-clickable' : ''}${i === activeIndex ? ' selected' : ''}${a.status === 'pending' ? ' subagent-swarm-row-waiting' : ''}`}
              title={clickable ? `Open ${a.label}` : a.label}
              onMouseEnter={() => setCursor(i)}
              onClick={clickable ? () => open(a.toolUseId) : undefined}
            >
              <span className="subagent-swarm-row-dot" aria-hidden />
              <span className="subagent-swarm-row-text">
                <span className="subagent-swarm-row-head">
                  <span className="subagent-swarm-row-label">{a.label}</span>
                  {a.startedAt != null && (
                    // Rows only exist while the popover is open, so the
                    // per-row 1Hz intervals are short-lived — unlike the old
                    // always-mounted chip row. `live` matches SubagentCard:
                    // pending freezes at endedAt so the wait after the parent
                    // turn does not inflate the run time.
                    <ElapsedTimer
                      startedAt={a.startedAt}
                      endedAt={a.endedAt}
                      live={isActivelyWorking(a.status)}
                      className="subagent-swarm-row-time"
                    />
                  )}
                </span>
                <span className="subagent-swarm-row-sub">
                  {detail || (a.status === 'pending' ? 'Waiting — running in the background' : 'Starting…')}
                </span>
              </span>
              {clickable && (
                <span className="subagent-swarm-row-open" aria-hidden>
                  <IconExternalLink size={12} />
                </span>
              )}
            </Tag>
          )
        })}
      </div>
    </motion.div>,
    // Portal to <body>: `pos` is in VIEWPORT coordinates and the clamp above
    // compares it against the window, so an ancestor carrying
    // backdrop-filter / transform (the chat panel with wallpaper on, or a
    // panel mid-enter) would take over as the containing block and displace
    // the popover. Canonical statement: the body.has-bg note in layout.css.
    document.body,
  )
}
