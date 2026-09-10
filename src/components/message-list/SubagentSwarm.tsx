// Aggregate display for a subagent fan-out (working-bar chrome).
//
// Why this exists: the working bar used to render one chip per in-flight
// subagent, wrapping onto new rows, capped at 5 chips with a "+N more" badge.
// In a narrow (3-panel) column each chip claims a whole row, so a 5-way
// fan-out grew the bar to ~176px — past `.working-bar`'s `max-height: 120px`
// — and `overflow: hidden` silently ate the tail. The "+N more" badge renders
// LAST, so the one element that signalled "there is more" was the first one
// clipped. On top of that the bar's height jumping from 1 to 6 rows mid-turn
// is exactly the viewport churn Chat's `pendingTurnSince` bridge exists to
// avoid, and N chips meant N independent 1Hz `ElapsedTimer` intervals inside
// an `aria-live` region.
//
// The fix is structural rather than a bigger cap: past a small threshold the
// chips collapse into ONE pill whose height is constant by construction, and
// the per-agent detail moves into a popover. That also lets the detail rows
// carry `progressSummary` / `lastToolName` — fields the store already tracks
// but which previously only surfaced in a chip's `title` tooltip.
//
// The popover is the summary/entry point for the surfaces that already own
// the full picture (SubagentOverlay for a single agent's transcript,
// TasksPanel for the task list) — deliberately not a third list
// implementation.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { usePopoverMotion } from '../../utils/transitions'
import { useEscapeStack } from '../../hooks/useEscapeStack'
import { useOverlayScrollbar } from '../../hooks/useOverlayScrollbar'
import { useMergedRef } from '../../utils/mergedRef'
import { applyPortaledThemeVars } from '../../theme'
import { ElapsedTimer } from '../ElapsedTimer'
import { IconChevronDown, IconExternalLink } from '../icons/ToolIcons'
import type { ActiveSubagent } from '../../session-store/types'

/** Up to this many concurrent subagents render as individual chips in the
 *  working bar; above it they collapse into a single `SubagentSwarmPill`.
 *  Two is the largest count that reliably fits without wrapping the bar past
 *  two rows in the narrowest (3-panel) column. */
export const SUBAGENT_INLINE_LIMIT = 2

/** Viewport-coordinate anchor for the popover. `source` is the pill itself —
 *  the popover portals to <body> and needs it to find the panel whose accent
 *  to carry (see `applyPortaledThemeVars`). */
interface Anchor {
  x: number
  y: number
  source: Element | null
}

/** The secondary line for a row: the agent's own words about what it is doing
 *  (refreshed ~every 30s by task_progress) with the last tool it ran as the
 *  fallback. Empty when the store has neither yet. */
function rowDetail(a: ActiveSubagent): string {
  if (a.progressSummary) return a.progressSummary
  if (a.lastToolName) return `Running ${a.lastToolName}`
  return ''
}

/** Earliest `startedAt` across the set — the pill shows this ONE timer
 *  ("how long has this fan-out been going") instead of one per agent, so the
 *  always-visible bar ticks once a second no matter how wide the fan-out. */
function oldestStart(subagents: readonly ActiveSubagent[]): number | undefined {
  let min: number | undefined
  for (const a of subagents) {
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
  const a11yLabel =
    waiting > 0
      ? `${total} subagents in flight, ${waiting} waiting in the background — open the list`
      : `${total} subagents in flight — open the list`

  return (
    <>
      <button
        type="button"
        className={`subagent-swarm${anchor ? ' subagent-swarm-open' : ''}${allWaiting ? ' subagent-swarm-waiting' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={anchor != null}
        aria-label={a11yLabel}
        title={a11yLabel}
        onClick={(e) => {
          // Toggle: a second click on the pill closes the popover instead of
          // re-anchoring it (the outside-mousedown handler never fires for a
          // click on the trigger itself).
          if (anchor) {
            close()
            return
          }
          const r = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: r.left, y: r.bottom + 4, source: e.currentTarget })
        }}
      >
        <span className="subagent-chip-dots" aria-hidden>
          <span />
          <span />
        </span>
        <span className="subagent-swarm-count">
          {total} agent{total === 1 ? '' : 's'}
        </span>
        {waiting > 0 && running > 0 && (
          <span className="subagent-swarm-split" aria-hidden>
            {waiting} waiting
          </span>
        )}
        {startedAt != null && (
          <span aria-hidden>
            <ElapsedTimer startedAt={startedAt} live className="subagent-chip-timer" />
          </span>
        )}
        <span className="subagent-swarm-caret" aria-hidden>
          <IconChevronDown size={12} />
        </span>
      </button>
      {anchor && (
        <SubagentSwarmPopover
          anchor={anchor}
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
  subagents,
  running,
  waiting,
  onOpenSubagent,
  onClose,
}: {
  anchor: Anchor
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
    applyPortaledThemeVars(el, anchor.source)
  }, [anchor.x, anchor.y, anchor.source, subagents.length])

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

  // Outside-click dismissal (Escape is owned by the stack above).
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDocMouseDown)
    return () => window.removeEventListener('mousedown', onDocMouseDown)
  }, [onClose])

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
      aria-label="Subagents in flight"
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
        <span className="subagent-swarm-pop-title">Subagents</span>
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
                    // always-mounted chip row.
                    <ElapsedTimer
                      startedAt={a.startedAt}
                      live
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
