// Tiny progress bar showing how full the context window is, with an optional
// draggable auto-compact threshold marker.
//
// Display-only by default — data arrives via the WebSocket hub (the server
// pushes a `context_usage` event periodically). No fetch calls, no timers.
//
// When `editable`, the marker on the track is a draggable slider that pins
// `Settings.autoCompactWindow`: dragging it to pct% sets the window so the
// auto-compact THRESHOLD lands on pct% (the marker shows where auto-compact
// actually triggers, matching the "X% until auto-compact" warning). A commit
// fires only when the pointer moved ≥ DRAG_SLOP_PX, so a plain click is a
// no-op and double-clicking the bar resets to auto without racing a pin POST.

import {
  memo,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { ContextUsage } from '../hooks/useChatStream'
import { formatTokens } from '../utils/format'
import { windowForAutoCompactThreshold } from '../../shared/auto-compact'

/** Marker drag range / grid. Min 20 keeps auto-compact far enough from the
 *  prompt edge to be useful; step 5 matches the old slider's snap. */
const MIN_PCT = 20
const MAX_PCT = 100
const STEP_PCT = 5
/** A pointer interaction must move this far (px) before it counts as a drag
 *  and commits. Below this a click is a no-op → double-click-to-reset is
 *  clean (no intermediate pin POST). */
const DRAG_SLOP_PX = 3

function snapPct(p: number): number {
  return Math.min(MAX_PCT, Math.max(MIN_PCT, Math.round(p / STEP_PCT) * STEP_PCT))
}

interface Props {
  /** Latest usage snapshot from the WebSocket hub, or null if none yet. */
  usage: ContextUsage | null
  /** When true, the auto-compact threshold marker is draggable: dragging it
   *  pins Settings.autoCompactWindow so auto-compact triggers at the drop
   *  position. Default false = pure display. */
  editable?: boolean
  /** True when the session has a pinned custom window (session.autoCompactWindow
   *  set) — drives marker styling (accent = custom, muted = auto). */
  custom?: boolean
  /** Disable marker interaction (terminated / dormant / busy). */
  disabled?: boolean
  /** Called with the absolute window tokens to pin, or null to reset to auto. */
  onSetWindow?: (windowTokens: number | null) => void
}

export const ContextBar = memo(function ContextBar({
  usage,
  editable = false,
  custom = false,
  disabled = false,
  onSetWindow,
}: Props) {
  // Prefer rawMaxTokens (the model's real advertised context window) over
  // maxTokens (which may be reduced by compaction headroom reserves).
  const max = usage?.rawMaxTokens ?? usage?.maxTokens

  // ── drag / keyboard state ─────────────────────────────────────────────
  // All hooks are declared unconditionally (before the empty-state early
  // return below) so the hook order is stable across renders.
  const [dragging, setDragging] = useState(false)
  const [draftPct, setDraftPct] = useState<number | null>(null)
  const draggingRef = useRef(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const pointerIdRef = useRef<number | null>(null)
  const startClientXRef = useRef(0)
  const movedRef = useRef(false)
  const trackRectRef = useRef<DOMRect | null>(null)
  const keyboardDraftRef = useRef<number | null>(null)

  const interactive = editable && !disabled && onSetWindow != null

  // % of the model window → absolute Settings.autoCompactWindow tokens such
  // that the derived threshold lands exactly at pct% (inverse of the pump's
  // computeAutoCompactThreshold). Uses the same maxOutputTokens the pump used.
  const pctToWindow = useCallback(
    (pct: number) => {
      if (typeof max !== 'number' || max <= 0) return 0
      return Math.round(windowForAutoCompactThreshold((pct / 100) * max, usage?.maxOutputTokens))
    },
    [max, usage?.maxOutputTokens],
  )

  const commit = useCallback(
    (pct: number | null) => {
      if (!onSetWindow) return
      if (pct == null) onSetWindow(null)
      else onSetWindow(pctToWindow(pct))
    },
    [onSetWindow, pctToWindow],
  )

  if (!usage || max == null || max <= 0) {
    return (
      <div className="ctx-bar ctx-bar-empty">
        <div className="ctx-bar-label">Context: —</div>
        <div className="ctx-bar-track" aria-hidden>
          <div
            className="ctx-bar-fill"
            style={{ ['--ctx-progress' as string]: 0 } as CSSProperties}
          />
        </div>
      </div>
    )
  }

  const used = usage.totalTokens ?? 0
  // Prefer SDK's percentage (it may weigh differently than raw tokens / max)
  // but fall back to a straight division if absent.
  const computedPct = usage.percentage ?? (used / max) * 100
  const bounded = Math.min(100, Math.max(0, computedPct))
  const level = bounded >= 90 ? 'danger' : bounded >= 70 ? 'warn' : 'ok'

  // Auto-compact warning: only render once we have a threshold (i.e. after
  // the first `result`) AND the user is far enough along that the nudge is
  // actionable (within 50% of the threshold). Mirrors the CLI's TokenWarning
  // "X% until auto-compact" line.
  const threshold = usage.autoCompactThreshold
  const thresholdPct =
    typeof threshold === 'number' && threshold > 0 ? (threshold / max) * 100 : null
  let warning: { percentLeft: number; level: 'ok' | 'warn' | 'danger' } | null = null
  if (typeof threshold === 'number' && threshold > 0) {
    const percentLeft = Math.max(0, Math.round(((threshold - used) / threshold) * 100))
    if (percentLeft <= 50) {
      warning = {
        percentLeft,
        level: percentLeft <= 15 ? 'danger' : percentLeft <= 30 ? 'warn' : 'ok',
      }
    }
  }

  const displayPct = draftPct ?? thresholdPct

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || e.button !== 0) return
    const wrap = wrapRef.current
    if (!wrap) return
    try {
      wrap.setPointerCapture(e.pointerId)
    } catch {
      // jsdom / detached node: setPointerCapture throws — abort the drag.
      return
    }
    pointerIdRef.current = e.pointerId
    startClientXRef.current = e.clientX
    movedRef.current = false
    trackRectRef.current = wrap.getBoundingClientRect()
    // A new pointer interaction cancels any pending keyboard commit.
    keyboardDraftRef.current = null
    draggingRef.current = true
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) return
    const rect = trackRectRef.current
    if (!rect || rect.width <= 0) return
    if (Math.abs(e.clientX - startClientXRef.current) >= DRAG_SLOP_PX) {
      movedRef.current = true
    }
    const ratio = (e.clientX - rect.left) / rect.width
    setDraftPct(snapPct(ratio * 100))
  }

  const endDrag = () => {
    const wrap = wrapRef.current
    const pid = pointerIdRef.current
    draggingRef.current = false
    setDragging(false)
    pointerIdRef.current = null
    trackRectRef.current = null
    if (wrap && pid != null) {
      try {
        wrap.releasePointerCapture(pid)
      } catch {
        /* ignore */
      }
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) return
    const didMove = movedRef.current
    const pct = draftPct
    endDrag()
    setDraftPct(null)
    if (didMove && pct != null) commit(pct)
  }

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) return
    endDrag()
    setDraftPct(null)
  }

  const onDoubleClick = () => {
    if (!interactive) return
    commit(null)
  }

  const commitKeyboardDraft = () => {
    const d = keyboardDraftRef.current
    if (d == null) return
    keyboardDraftRef.current = null
    setDraftPct(null)
    commit(d)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return
    const current = draftPct ?? thresholdPct ?? MIN_PCT
    let next: number | null
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = snapPct(current + STEP_PCT)
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        next = snapPct(current - STEP_PCT)
        break
      case 'Home':
        next = MIN_PCT
        break
      case 'End':
        next = MAX_PCT
        break
      case 'Delete':
      case 'Backspace':
        next = null
        break
      default:
        return
    }
    e.preventDefault()
    if (next == null) {
      keyboardDraftRef.current = null
      commit(null)
    } else {
      keyboardDraftRef.current = next
      setDraftPct(next)
    }
  }

  const markerClass =
    `ctx-bar-marker` +
    (!custom && !dragging ? ' ctx-bar-marker-auto' : '') +
    (dragging ? ' ctx-bar-marker-dragging' : '') +
    (editable ? ' ctx-bar-marker-interactive' : '')

  return (
    <div className={`ctx-bar ctx-bar-${level}`}>
      <div className="ctx-bar-label">
        <span>
          {editable && displayPct != null && (dragging || custom) && (
            <span className={`ctx-bar-compact${dragging ? ' ctx-bar-compact-dragging' : ''}`}>
              Compact at {Math.round(displayPct)}%
            </span>
          )}
          {warning && (
            <span className={`ctx-bar-warning ctx-bar-warning-${warning.level}`}>
              {warning.percentLeft}% until auto-compact
            </span>
          )}
        </span>
        <span className="ctx-bar-nums">
          {formatTokens(used)} / {formatTokens(max)}
          <span className="ctx-bar-pct"> · {bounded.toFixed(1)}%</span>
          {usage.outputTokens != null && usage.outputTokens > 0 && (
            <span className="ctx-bar-out" title={`Output tokens this call: ${formatTokens(usage.outputTokens)}`}>
              {' '}· {formatTokens(usage.outputTokens)} out
            </span>
          )}
          {usage.cacheReadTokens != null && usage.cacheReadTokens > 0 && (
            <span className="ctx-bar-cache" title={`Cache hit: ${formatTokens(usage.cacheReadTokens)} read · ${formatTokens(usage.cacheCreationTokens ?? 0)} written`}>
              {' '}· cache {formatTokens(usage.cacheReadTokens)}
            </span>
          )}
        </span>
      </div>
      <div
        className={`ctx-bar-track-wrap${editable ? ' ctx-bar-track-editable' : ''}`}
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
      >
        <div className="ctx-bar-track" aria-hidden>
          <div
            className="ctx-bar-fill"
            style={{ ['--ctx-progress' as string]: bounded / 100 } as CSSProperties}
          />
        </div>
        {displayPct != null && (
          <div
            className={markerClass}
            style={{ left: `${displayPct}%` }}
            {...(interactive
              ? {
                  role: 'slider',
                  tabIndex: 0,
                  'aria-label': 'Auto-compact threshold',
                  'aria-valuemin': MIN_PCT,
                  'aria-valuemax': MAX_PCT,
                  'aria-valuenow': Math.round(displayPct),
                  'aria-valuetext': `${Math.round(displayPct)}%`,
                  title: 'Drag to set when auto-compact triggers · double-click to reset to auto',
                  onKeyDown,
                  onKeyUp: commitKeyboardDraft,
                  onBlur: commitKeyboardDraft,
                }
              : { 'aria-hidden': true })}
          />
        )}
      </div>
    </div>
  )
})
