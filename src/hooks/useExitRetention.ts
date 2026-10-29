// Exit-retention primitive: when `value` becomes null, keep returning the
// last value — flagged `exiting` — for one exit window (`ms`) so a CSS exit
// animation can play before the element unmounts. That "value outlives its
// state by 120ms" is what the nav strip's exits ride: the working dot and
// the working wash fade instead of being cut, and the strip shell plays its
// slide-out before the collapse unmounts it.
//
// A new non-null value cancels the hold immediately — two live values never
// get an exit beat between them (working -> dormant is a swap, not a fade).
// Reduced motion skips the hold entirely: nothing animates, so nothing needs
// outliving its state (same gate flip.ts applies). Purely local — the caller
// owns what the retained value renders. Values are compared with Object.is
// (deps semantics), so pass primitives.

import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../utils/reduced-motion'

/** The hold window, in ms — MUST track `--motion-duration-fast` in tokens.css
 *  (the duration the dot / wash CSS exits run at). Pin-tested against the
 *  token so a retune can't silently unmount exits mid-fade. */
export const EXIT_WINDOW_MS = 120

/** The nav-strip shell's hold window — its exit runs at
 *  `--motion-duration-moderate` (the entrance / sidebar-grid cadence, not the
 *  fast fade), so it needs the longer window. Pin-tested alongside. */
export const STRIP_EXIT_WINDOW_MS = 240

interface Snapshot<T> {
  /** The `value` this snapshot was computed for — the change detector. */
  prev: T | null
  shown: T | null
  exiting: boolean
}

export function useExitRetention<T>(value: T | null, ms = EXIT_WINDOW_MS): { shown: T | null; exiting: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({
    prev: value,
    shown: value,
    exiting: false,
  })

  // "Adjust state when a prop change" — the render-phase update pattern
  // (react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes),
  // applied only on the frame `value` actually changes. Transitions are
  // immediate: live -> live swaps, live -> null arms the hold, reduced motion
  // clears on the spot.
  if (!Object.is(snapshot.prev, value)) {
    if (value !== null || prefersReducedMotion()) {
      setSnapshot({ prev: value, shown: value, exiting: false })
    } else {
      setSnapshot({ prev: value, shown: snapshot.shown, exiting: snapshot.shown !== null })
    }
  }

  // The exit window itself is just a timer — the one piece that belongs in
  // an effect, and only while a hold is actually playing (an idle mount with
  // a null value arms nothing).
  useEffect(() => {
    if (!snapshot.exiting) return
    const t = window.setTimeout(() => {
      setSnapshot((s) => (s.exiting ? { ...s, shown: null, exiting: false } : s))
    }, ms)
    return () => window.clearTimeout(t)
  }, [value, ms, snapshot.exiting])

  return { shown: snapshot.shown, exiting: snapshot.exiting }
}
