import { useCallback, useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../utils/reduced-motion'

/**
 * Transcript settle on recap close (drives the `transcript-settle-up`
 * keyframe in chat.css). The RecapWindow overlays the transcript (absolute
 * .chat-top-stack), so closing it would otherwise pop the covered messages
 * into view with no motion; paired with the window's height-collapse exit
 * (useTopCardMotion) this nudge makes the reveal read as the history sliding
 * up into the freed space.
 *
 * recapOpen flips false in two ways and only one gets the settle:
 *   - user close (ChatPanel records recapDismissedAt — the recap data STAYS
 *     on the session) → settle plays;
 *   - server invalidation (new turn; `hasRecap` → false) → settle never
 *     starts / is cut short — the transcript is about to move for real.
 * `clearing` (/clear) cancels too, mid-flight included: the transcript runs
 * its own blur-fade there and a settle would fight it.
 *
 * The class is removed via the caller's animationend hook (name-filtered —
 * the transcript bubbles many animations), so no timer can drift out of sync
 * with the CSS duration token. Restart robustness: the settle class is
 * dropped and re-added two frames later, so close → reopen → close restarts
 * the keyframe; a reopen before the restart chain fires cancels it instead
 * (no nudge while the window is open).
 */
export function useRecapSettle(
  recapOpen: boolean,
  hasRecap: boolean,
  clearing: boolean,
): { settleActive: boolean; handleAnimationEnd: (animationName: string) => void } {
  const [settleActive, setSettleActive] = useState(false)
  const rafRef = useRef(0)

  const trigger = useCallback(() => {
    // Reduced motion: never start the settle at all. The CSS media query
    // also disables the keyframe, but the class would then linger forever
    // (animation:none means no animationend ever removes it) — and if the
    // OS-level setting is later switched off, the stale class would play
    // the nudge spontaneously, the exact motion the setting suppresses.
    if (prefersReducedMotion()) return
    cancelAnimationFrame(rafRef.current)
    setSettleActive(false)
    // Re-add the class two frames later so the keyframe restarts even when a
    // previous settle is still mid-flight. Two rAFs guarantee a painted
    // frame carrying the class-less state between the two updates — a single
    // rAF can batch with the `false` above and leave the running keyframe
    // un-restarted.
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => setSettleActive(true))
    })
  }, [])

  const prevOpenRef = useRef(recapOpen)
  useEffect(() => {
    const was = prevOpenRef.current
    prevOpenRef.current = recapOpen
    if (!hasRecap || clearing) {
      // Invalidation (/clear included, mid-flight included): cut the settle
      // and any pending restart frame — they'd stack with the transcript's
      // own movement. (The user-close path keeps the recap data on the
      // session, so it never takes this branch.)
      cancelAnimationFrame(rafRef.current)
      setSettleActive(false)
    } else if (was && !recapOpen) {
      // User close.
      trigger()
    } else if (recapOpen) {
      // Reopened (manual, or a fresh recap auto-reopening on a new
      // generatedAt): cancel any pending restart chain AND cut a settle
      // that's already animating — no nudge while the window is open.
      cancelAnimationFrame(rafRef.current)
      setSettleActive(false)
    }
  }, [recapOpen, hasRecap, clearing, trigger])
  // Cancel a pending restart frame on unmount.
  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  // Animation cancelled mid-flight (OS reduced-motion toggled on while the
  // settle is playing, or an ancestor going display:none): no animationend
  // will come, so the class would linger — and if the OS setting is later
  // switched off, the stale class would replay the nudge unprompted, the
  // exact motion the setting suppresses. animationcancel isn't in React's
  // synthetic event set, so listen natively at the window (capture phase —
  // the event bubbles, but capturing also covers non-bubbling edge cases).
  useEffect(() => {
    if (!settleActive) return
    const on = (e: AnimationEvent) => {
      if (e.animationName === 'transcript-settle-up') setSettleActive(false)
    }
    window.addEventListener('animationcancel', on, true)
    return () => window.removeEventListener('animationcancel', on, true)
  }, [settleActive])

  // Name filter lives here so the JSX stays a one-liner. Under
  // prefers-reduced-motion the animation is `none`, no end event fires, and
  // the class merely lingers with no visual effect until the next close.
  const handleAnimationEnd = useCallback((animationName: string) => {
    if (animationName === 'transcript-settle-up') setSettleActive(false)
  }, [])

  return { settleActive, handleAnimationEnd }
}
