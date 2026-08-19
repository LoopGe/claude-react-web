import { useEffect, useRef, useState } from 'react'
import type { ActivePhase } from '../session-store/types'

/** Alias so the hook's public API matches the spec's name while reusing the
 *  canonical type (no duplicate structural type). */
export type ActivePhaseValue = ActivePhase

/** Normalize a phase to a stable string key. The tool_use value is a fresh
 *  object per content_block_start, so comparing by reference would restart the
 *  dwell timer for the *same* tool. */
export function phaseKey(p: ActivePhaseValue): string | null {
  if (p == null) return null
  if (typeof p === 'string') return p
  return `tool_use:${p.name}`
}

/** Holds a phase label until it has been stable for `dwellMs` (default 300).
 *  null→phase and phase→null commit immediately; a transient blip A→B→A inside
 *  the window never shows B. The clear-at-top is mandatory — without it, B's
 *  timer from the A→B leg stays armed and commits B after the phase is already
 *  back on A. */
export function usePhaseDwell(
  activePhase: ActivePhaseValue,
  dwellMs = 300,
): ActivePhaseValue {
  const [display, setDisplay] = useState<ActivePhaseValue>(activePhase)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeKey = phaseKey(activePhase)
  const displayKey = phaseKey(display)

  // Immediate transitions commit during render (React's "adjust state when a
  // prop changes" pattern) rather than in an effect — the effect body must not
  // call setState synchronously (react-hooks/set-state-in-effect). Only the
  // dwell commit (A→B after dwellMs) is async, so it lives in the effect.
  if (activeKey == null) {
    // Turn ended → show nothing right away.
    if (displayKey !== null) setDisplay(activePhase)
  } else if (displayKey == null || activeKey === displayKey) {
    // First phase, or the same phase re-issued (fresh object, same key) →
    // commit immediately if not already shown; a same-key re-issue keeps the
    // stable reference so a memoized bubble doesn't re-render per block start.
    if (activeKey !== displayKey) setDisplay(activePhase)
  }

  // Unmount cleanup.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  // Dwell: when the phase differs from what's showing (both non-null), hold the
  // current display until the new phase has been stable for dwellMs. The
  // clear-at-top is mandatory — without it, B's timer from the A→B leg stays
  // armed and commits B after the phase is already back on A.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (activeKey != null && displayKey != null && activeKey !== displayKey) {
      timerRef.current = setTimeout(() => setDisplay(activePhase), dwellMs)
    }
  }, [activeKey, displayKey, activePhase, dwellMs])

  return display
}
