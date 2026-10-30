// Tiny progress bar showing how full the context window is, with a read-only
// marker at the auto-compact threshold.
//
// Display-only by design — data arrives via the WebSocket hub (the server
// pushes a `context_usage` event periodically). No fetch calls, no timers, no
// interaction. The drag-to-pin-threshold feature was removed: the SDK's
// applyFlagSettings channel is inert for `autoCompactWindow` on current CLIs,
// so thresholds are set at spawn (New session form → Options.settings) or
// mid-session via the CLI's own `/autocompact` command. The marker therefore
// only ever reports where auto-compact ACTUALLY triggers, per the CLI's own
// answer (or the local formula replica when the CLI hasn't answered yet).

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { ContextUsage } from '../types/context-usage'
import { contextUsageStats } from '../utils/context-usage'
import { formatTokens } from '../utils/format'

/** The percentage-cells show bare numbers (25% · 84% · 70%) by default; the
 *  "used · compact · until" word labels are revealed on hover and revert to
 *  numbers-only this many ms after the pointer leaves the readout. */
const REVEAL_DELAY_MS = 3000

interface Props {
  /** Latest usage snapshot from the WebSocket hub, or null if none yet. */
  usage: ContextUsage | null
}

export const ContextBar = memo(function ContextBar({ usage }: Props) {
  // Prefer rawMaxTokens (the model's real advertised context window) over
  // maxTokens (which may be reduced by compaction headroom reserves).
  // Shared used%/threshold/level math — one ladder for the bar and the orb.
  const { max, hasData, usedTokens, bounded, level: barLevel, threshold, thresholdPct } =
    contextUsageStats(usage)

  // ── hover-reveal of the used/compact/until word labels ────────────────
  // Resting state shows bare percentages; hovering the natural-width
  // percentage readout (`.ctx-bar-stats-hit`) reveals the words. On
  // pointer-leave a 3s timer hides them again (and is cancelled if the pointer
  // re-enters first). State stays holdable while the pointer is over that
  // readout — the wrapper around it is deliberately excluded.
  const [revealed, setRevealed] = useState(false)
  const revealTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (revealTimerRef.current != null) window.clearTimeout(revealTimerRef.current)
    },
    [],
  )
  const revealLabels = useCallback(() => {
    if (revealTimerRef.current != null) {
      window.clearTimeout(revealTimerRef.current)
      revealTimerRef.current = null
    }
    setRevealed(true)
  }, [])
  const hideLabelsAfterDelay = useCallback(() => {
    if (revealTimerRef.current == null) {
      revealTimerRef.current = window.setTimeout(() => {
        revealTimerRef.current = null
        setRevealed(false)
      }, REVEAL_DELAY_MS)
    }
  }, [])

  // CLI reports auto-compact OFF → the marker is informational only and the
  // compact/until stats say so instead of showing a percentage that will
  // never trigger.
  const autoCompactOff = usage?.autoCompactEnabled === false

  // The bar always shows the same three percentages (used / auto-compact
  // threshold / until auto-compact). When there's no data yet — no usage
  // snapshot, or a window of unknown/zero size — every stat falls back to a
  // `—` placeholder so the label row's size stays stable (no layout jump).
  let percentLeft: number | null = null
  let untilLevel: 'ok' | 'warn' | 'danger' = 'ok'
  if (hasData && typeof threshold === 'number' && threshold > 0 && usedTokens != null) {
    // Mirrors the CLI's TokenWarning line: share of the threshold still free.
    // Higher = safer; it carries the ok/warn/danger color of the old warning.
    const pct = Math.max(0, Math.round(((threshold - usedTokens) / threshold) * 100))
    percentLeft = pct
    untilLevel = pct <= 15 ? 'danger' : pct <= 30 ? 'warn' : 'ok'
  }

  // CLI says auto-compact will not fire: show `off` rather than a percentage
  // that will never trigger.
  const compactStat: number | null | 'off' = autoCompactOff ? 'off' : thresholdPct
  const untilStat: number | null = autoCompactOff ? null : percentLeft

  // One percentage cell. The word label is always mounted; it is visually
  // collapsed to zero width / transparent at rest and expands via a CSS
  // max-width transition when the bar carries `.ctx-bar-revealed` (hovered).
  // Keeping it mounted is what lets the *width* animate instead of snapping.
  // `lvl` colors the "until" stat as it approaches the threshold (warn/danger);
  // ok and missing stay muted. aria-label always carries the full "used 25%"
  // meaning for AT, even though the words are visually hidden at rest.
  const stat = (
    name: string,
    label: string,
    value: number | null | 'off',
    lvl?: 'warn' | 'danger',
  ) => {
    const text =
      value === 'off' ? 'off' : value != null ? `${Math.round(value)}%` : '—'
    const aria =
      value === 'off'
        ? `${label} off`
        : value != null
          ? `${label} ${Math.round(value)}%`
          : `${label} —`
    return (
      <span
        className={`ctx-bar-stat ctx-bar-stat-${name}${lvl ? ` ctx-bar-stat-${lvl}` : ''}`}
        aria-label={aria}
      >
        <span className="ctx-bar-stat-label">{label}</span>
        {text}
      </span>
    )
  }

  const markerClass =
    'ctx-bar-marker ctx-bar-marker-auto' +
    // The CLI reports auto-compact off — dim the marker to match the stats.
    (autoCompactOff ? ' ctx-bar-marker-disabled' : '')

  return (
    <div className={`ctx-bar ctx-bar-${barLevel}${revealed ? ' ctx-bar-revealed' : ''}`}>
      <div className="ctx-bar-label">
        <span className="ctx-bar-stats">
          {/* The pointer handlers live on this natural-width readout, NOT the
              .ctx-bar-stats wrapper — the wrapper is sized to the readout, so
              hovering the empty stretch of the label row to its right must not
              reveal the labels. */}
          <span
            className="ctx-bar-stats-hit"
            onPointerEnter={revealLabels}
            onPointerLeave={hideLabelsAfterDelay}
          >
            {stat('used', 'used', bounded)}
            <span className="ctx-bar-sep" aria-hidden>
              {' '}·{' '}
            </span>
            {stat('compact', 'compact', compactStat)}
            <span className="ctx-bar-sep" aria-hidden>
              {' '}·{' '}
            </span>
            {stat(
              'until',
              'until',
              untilStat,
              // When compact is off the placeholder is not a warning — never
              // paint the '—' with warn/danger from the unused-headroom math.
              !autoCompactOff && (untilLevel === 'warn' || untilLevel === 'danger')
                ? untilLevel
                : undefined,
            )}
          </span>
        </span>
        <span className="ctx-bar-nums">
          {hasData ? `${formatTokens(usedTokens!)} / ${formatTokens(max!)}` : '— / —'}
          {usage?.outputTokens != null && usage.outputTokens > 0 && (
            <span className="ctx-bar-out" title={`Output tokens this call: ${formatTokens(usage.outputTokens)}`}>
              {' '}· {formatTokens(usage.outputTokens)} out
            </span>
          )}
          {usage?.cacheReadTokens != null && usage.cacheReadTokens > 0 && (
            <span className="ctx-bar-cache" title={`Cache hit: ${formatTokens(usage.cacheReadTokens)} read · ${formatTokens(usage.cacheCreationTokens ?? 0)} written`}>
              {' '}· cache {formatTokens(usage.cacheReadTokens)}
            </span>
          )}
        </span>
      </div>
      <div className="ctx-bar-track-wrap">
        <div className="ctx-bar-track" aria-hidden>
          <div
            className="ctx-bar-fill"
            style={{ ['--ctx-progress' as string]: (bounded ?? 0) / 100 } as CSSProperties}
          />
        </div>
        {thresholdPct != null && (
          <div
            className={markerClass}
            style={{ left: `${thresholdPct}%` }}
            aria-hidden
          />
        )}
      </div>
    </div>
  )
})
