// Circular context-usage button for the composer bar (sits left of Send).
//
// Resting state: a ring-only orb — arc length = used %, a short tick marks
// the auto-compact threshold. No percentage text (that lives in the hover
// panel so the bar stays quiet). Warn/danger tint the ring as the window
// fills, matching the old ContextBar's urgency colours.
//
// Hover (with a short dwell so a pass-through toward Send doesn't flash the
// panel) / click-to-pin / keyboard focus opens a popover that hosts the
// existing ContextBar. All drag / keyboard / commit logic stays there —
// this file is only the trigger + chrome. Level math is shared via
// contextUsageStats so the ring tint can never drift from the panel.

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ContextUsage } from '../hooks/useChatStream'
import { ContextBar, contextUsageStats } from './ContextBar'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'

interface Props {
  usage: ContextUsage | null
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

export const ContextOrb = memo(function ContextOrb({
  usage,
  editable = false,
  custom = false,
  disabled = false,
  onSetWindow,
}: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const [hoverOpen, setHoverOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const hoverTimer = useRef<number | null>(null)

  const show = pinned || hoverOpen

  // Stable identity: useOutsideMouseDown re-arms its window listener whenever
  // onClose changes, and ContextOrb re-renders on every context-usage frame.
  const close = useCallback(() => {
    setPinned(false)
    setHoverOpen(false)
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }, [])

  // Outside mousedown dismisses a pinned (or hover-open) panel — same
  // contract as CommandPicker / SchedulePicker.
  useOutsideMouseDown({ ref: wrapRef, onClose: close, capture: true })

  // Escape via the shared stack so it never fights App's interrupt chain or
  // another overlay that owns the key.
  useEscapeStack({
    active: show,
    onEscape: close,
    getContainer: () => wrapRef.current,
  })

  useEffect(
    () => () => {
      if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
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
      onMouseEnter={() => {
        if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
        hoverTimer.current = window.setTimeout(() => setHoverOpen(true), HOVER_OPEN_MS)
      }}
      onMouseLeave={() => {
        if (hoverTimer.current != null) {
          window.clearTimeout(hoverTimer.current)
          hoverTimer.current = null
        }
        // Pinned panel stays until outside-click / Escape / second click.
        if (!pinned) setHoverOpen(false)
      }}
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
          if (!wrapRef.current?.contains(e.relatedTarget as Node | null) && !pinned) {
            setHoverOpen(false)
          }
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
      {show && (
        <div className="ctx-orb-pop" role="dialog" aria-label="Context usage details">
          <ContextBar
            usage={usage}
            editable={editable}
            custom={custom}
            disabled={disabled}
            onSetWindow={onSetWindow}
          />
        </div>
      )}
    </span>
  )
})
