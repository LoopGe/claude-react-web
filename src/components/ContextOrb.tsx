// Circular context-usage button for the composer bar (sits left of Send).
//
// Resting state: a ring-only orb — arc length = used %, a short tick marks
// the auto-compact threshold. No percentage text (that lives in the hover
// panel so the bar stays quiet). Warn/danger tint the ring as the window
// fills, matching the old ContextBar's urgency colours.
//
// Hover (with a short dwell so a pass-through toward Send doesn't flash the
// panel) / click-to-pin / keyboard focus opens a popover that hosts the
// existing ContextBar plus the composition breakdown. All drag / keyboard /
// commit logic stays there — this file is only the trigger + chrome. Level
// math is shared via contextUsageStats so the ring tint can never drift
// from the panel.
//
// The popover portals to <body> with position:fixed, exactly like
// ModelPicker: AnimatePresence's direct child is a KEYED COMPONENT whose
// output is the portal wrapping the motion.div (the portal element itself as
// the direct child does not register with the presence context). Load-bearing
// on two counts: the composer card is a backdrop-filter stacking context and
// the WorkingBubble / dock siblings paint their own stacking contexts — an
// absolutely positioned popover inside the composer was getting occluded by
// the WorkingBubble's rows. And it is bottom-anchored so the async-loaded
// breakdown grows UPWARD, away from the composer.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import type { ContextUsage } from '../hooks/useChatStream'
import { ContextBar } from './ContextBar'
import { ContextComposition } from './ContextComposition'
import { AnimatedCollapse } from './AnimatedCollapse'
import { contextUsageStats } from '../utils/context-usage'
import { useDetailedContextUsage } from '../hooks/useDetailedContextUsage'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { usePopoverMotion } from '../utils/transitions'
import { applyPortaledThemeVars } from '../theme'

interface Props {
  usage: ContextUsage | null
  /** Session id — the popover's composition breakdown needs the on-demand
   *  detailed fetch (the lite WS snapshot carries no categories). */
  sessionId: string
  editable?: boolean
  custom?: boolean
  disabled?: boolean
  onSetWindow?: (windowTokens: number | null) => void
}

/** SVG ring geometry. pathLength=100 so stroke-dashoffset maps 1:1 to %.
 *  Radius is chosen so the stroke's OUTER edge fills the 32px hit box —
 *  same optical diameter as the solid Send circle beside it (r + half
 *  stroke = 18 in viewBox units → 32px when the svg is 32px wide). */
const RING_R = 16.75
const VIEW = 36
/** Dwell before hover opens the panel. Filters out a pointer crossing the orb
 *  on its way to the adjacent Send button. */
const HOVER_OPEN_MS = 160
/** Grace between the pointer leaving the orb/wrap and the panel closing —
 *  the portal puts the panel OUTSIDE the wrap's DOM subtree, so the pointer
 *  hopping orb → panel fires wrap's mouseleave first; this grace (cancelled
 *  by the panel's own mouseenter) makes the hop seamless. */
const HOVER_CLOSE_MS = 200

/** The portaled popover. Mounted exactly while open (AnimatePresence child),
 *  so the detailed fetch runs with enabled=true for its whole life. The
 *  popover ref is OWNED by the parent (blur dismissal must check containment
 *  against it). */
function OrbPopover({
  usage,
  sessionId,
  editable,
  custom,
  disabled,
  onSetWindow,
  anchorRef,
  popRef,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  usage: ContextUsage | null
  sessionId: string
  editable: boolean
  custom: boolean
  disabled: boolean
  onSetWindow?: (windowTokens: number | null) => void
  anchorRef: RefObject<HTMLSpanElement | null>
  popRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}) {
  const { popover: popMotion } = usePopoverMotion()

  // Detailed breakdown — mounted == open, so the hook fetches on mount and
  // refetches on each retry; DISABLED sessions (dormant / terminated) are
  // gated off — the endpoint is a live-Query control read that would 4xx
  // forever (SettingsPanel gates the same read; ContextComposition's doc
  // promises a resume hint there instead of a dead retry). Merged
  // lite-first so the live numbers always win on shared fields and the
  // categories ride in from the detailed payload; the same merge shape as
  // SettingsPanel's Context tab.
  const { detailed, loading, error, retry } = useDetailedContextUsage(sessionId, !disabled)
  const mergedUsage = useMemo<ContextUsage | null>(
    () => (detailed || usage ? { ...detailed, ...usage } : null),
    [detailed, usage],
  )

  // Position the portaled panel: BOTTOM-anchored just above the orb, so the
  // async-loaded breakdown grows UPWARD away from the composer (growth after
  // mount needs no reposition). Right-aligned to the orb so the ::after
  // arrow keeps pointing at it; clamped to both side edges (a narrow panel
  // must not push the 320px card past the left viewport edge). Height is
  // deliberately uncapped per product call — no scrollbar.
  useLayoutEffect(() => {
    const el = popRef.current
    const anchor = anchorRef.current
    if (!el || !anchor) return
    applyPortaledThemeVars(el, anchor)
    const rect = anchor.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    el.style.top = 'auto'
    el.style.left = 'auto'
    el.style.bottom = `${Math.max(8, vh - rect.top + 10)}px`
    let right = vw - rect.right
    if (right < 8) right = 8
    if (right > vw - 328) right = Math.max(8, vw - 328)
    el.style.right = `${right}px`
  }, [anchorRef, popRef])

  // Outside mousedown dismisses the panel — same contract as
  // CommandPicker / SchedulePicker. The surface ref is this portaled panel;
  // the orb button is the trigger exemption.
  useOutsideMouseDown({ ref: popRef, triggerRef: anchorRef, onClose, capture: true })

  // Escape via the shared stack so it never fights App's interrupt chain or
  // another overlay that owns the key.
  useEscapeStack({
    active: true,
    onEscape: onClose,
    getContainer: () => popRef.current,
  })

  return createPortal(
    <motion.div
      ref={popRef}
      className="ctx-orb-pop"
      role="dialog"
      aria-label="Context usage details"
      initial={popMotion.initial}
      animate={popMotion.animate}
      exit={popMotion.exit}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <ContextBar
        usage={usage}
        editable={editable}
        custom={custom}
        disabled={disabled}
        onSetWindow={onSetWindow}
      />
      {!disabled && (
        <div className="ctx-orb-pop-comp">
          {/* animateResize: the breakdown arrives ASYNC (loading note → rows),
              which would snap the popover's height mid-open — the
              ResizeObserver-driven tween smooths exactly that change. The
              AnimatePresence ABOVE owns the card's appear/disappear; the two
              are separate concerns on purpose — folding the card for every
              detail swap would replay a full open/close per fetch. */}
          <AnimatedCollapse open animateResize unmountOnExit={false}>
            <ContextComposition usage={mergedUsage} loading={loading} error={error} onRetry={retry} />
          </AnimatedCollapse>
        </div>
      )}
    </motion.div>,
    document.body,
  )
}

export const ContextOrb = memo(function ContextOrb({
  usage,
  sessionId,
  editable = false,
  custom = false,
  disabled = false,
  onSetWindow,
}: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  // The portaled panel's ref is OWNED here: the button's blur dismissal must
  // check containment against the panel too (focus can move into it).
  const popRef = useRef<HTMLDivElement | null>(null)
  const [hoverOpen, setHoverOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const hoverTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const show = pinned || hoverOpen

  const close = useCallback(() => {
    setPinned(false)
    setHoverOpen(false)
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  // Hover flyout over TWO surfaces: the portaled panel is not a DOM
  // descendant of the wrap, so leaving the wrap fires before entering the
  // panel. One shared grace timer covers the hop; entering either surface
  // cancels it. Pinned stays until outside-click / Escape / second click.
  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])
  const scheduleClose = useCallback(() => {
    // Leaving the wrap also cancels a pending OPEN dwell — without this, a
    // sub-160ms pass across the orb would still pop the panel after the
    // pointer is gone (the exact flash HOVER_OPEN_MS exists to filter, and
    // each flash costs a detailed fetch).
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    cancelClose()
    if (pinned) return
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setHoverOpen(false)
    }, HOVER_CLOSE_MS)
  }, [cancelClose, pinned])
  const armOpen = useCallback(() => {
    cancelClose()
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHoverOpen(true), HOVER_OPEN_MS)
  }, [cancelClose])

  useEffect(
    () => () => {
      if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  const { hasData, bounded, level } = contextUsageStats(usage)

  const title = hasData && bounded != null ? `Context ${Math.round(bounded)}%` : 'Context usage'
  const aria =
    hasData && bounded != null
      ? `Context usage ${Math.round(bounded)} percent. Activate for details.`
      : 'Context usage. Activate for details.'

  const fillOffset = bounded != null ? 100 - bounded : null

  return (
    <span
      ref={wrapRef}
      className="ctx-orb-wrap"
      onMouseEnter={armOpen}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={
          'ctx-orb' +
          (level === 'warn' ? ' warn' : '') +
          (level === 'danger' ? ' danger' : '') +
          (show ? ' open' : '')
        }
        title={title}
        aria-label={aria}
        aria-expanded={show}
        aria-haspopup="dialog"
        disabled={disabled && !hasData}
        onClick={() => {
          const next = !pinned
          setPinned(next)
          setHoverOpen(next)
        }}
        onFocus={() => setHoverOpen(true)}
        onBlur={(e) => {
          // Keyboard close: focus moved somewhere OTHER than the wrap or the
          // portaled panel. Focus into the panel (the marker) keeps it open;
          // focus anywhere else closes — hover-open has no mouseleave to do
          // it, so this is the only dismissal keyboard navigation gets.
          const next = e.relatedTarget as Node | null
          if (pinned) return
          if (next && (wrapRef.current?.contains(next) || popRef.current?.contains(next))) return
          setHoverOpen(false)
        }}
      >
        {/* Ring only — used % as arc length. No threshold tick: the compact
            marker lives on the popover's track, where it is actually
            draggable; a 1.2-dash tick on a 32px ring was unreadable noise. */}
        <svg className="ctx-orb-ring" viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden>
          <circle className="track" cx={VIEW / 2} cy={VIEW / 2} r={RING_R} />
          {fillOffset != null && (
            <circle
              className="fill"
              cx={VIEW / 2}
              cy={VIEW / 2}
              r={RING_R}
              pathLength={100}
              style={{ strokeDashoffset: fillOffset }}
            />
          )}
        </svg>
      </button>
      {/* AnimatePresence owns the card's appear/disappear (usePopoverMotion —
          the repo's standard anchored-popover beat); the AnimatedCollapse
          INSIDE the popover owns the async-growth beat. */}
      <AnimatePresence>
        {show && (
          <OrbPopover
            key="ctx-orb-pop"
            usage={usage}
            sessionId={sessionId}
            editable={editable}
            custom={custom}
            disabled={disabled}
            onSetWindow={onSetWindow}
            anchorRef={wrapRef}
            popRef={popRef}
            onClose={close}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
          />
        )}
      </AnimatePresence>
    </span>
  )
})
