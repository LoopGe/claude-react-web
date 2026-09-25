// The "lifted card" — the floating clone rendered inside dnd-kit's
// <DragOverlay> for every migrated drag surface.
//
// Desktop-icon feel, piece by piece:
//   - scale + deep shadow: CSS (`.dnd-ghost`, `scale:` property so it
//     composes with motion's transform instead of fighting it)
//   - velocity tilt: pointer velocity → `tiltFromVelocity` → spring, so the
//     card leans into the direction of travel and eases back upright when
//     the pointer rests — the subtle life iOS icons have and system ghost
//     images don't.
//
// Reduced motion: no listener, no tilt — the ghost just follows the pointer.
// The root is also `inert` + `aria-hidden`: the cloned content carries real
// focusable/announced markup, and the clone must not enter either tree.

import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { motion, useMotionValue, useSpring } from 'motion/react'
import { prefersReducedMotion } from '../utils/reduced-motion'
import { tiltFromVelocity } from './payload'

/** Spring for the tilt — stiff enough to track a flick, damped enough not
 *  to oscillate. Shared by every surface so the motion language matches. */
const TILT_SPRING = { stiffness: 500, damping: 38, mass: 0.7 }

export function DragGhost({ children, className, style }: {
  children: ReactNode
  className?: string
  /** Surface-specific sizing (e.g. the session ghost matches the live
   *  sidebar width). Merged under the tilt so `rotate` stays authoritative. */
  style?: CSSProperties
}) {
  const tiltRaw = useMotionValue(0)
  const tilt = useSpring(tiltRaw, TILT_SPRING)

  useEffect(() => {
    if (prefersReducedMotion()) return
    let lastX: number | null = null
    let lastT = 0
    // Decay loop: when the pointer stops moving, ease the tilt back to 0
    // instead of freezing mid-lean. Runs on rAF until the next pointermove
    // resets the velocity baseline; stops itself at ~0.
    let decayRaf = 0
    const decay = () => {
      const v = tiltRaw.get()
      if (Math.abs(v) < 0.05) {
        tiltRaw.set(0)
        decayRaf = 0
        return
      }
      tiltRaw.set(v * 0.82)
      decayRaf = requestAnimationFrame(decay)
    }
    const scheduleDecay = () => {
      if (!decayRaf) decayRaf = requestAnimationFrame(decay)
    }
    const onMove = (e: PointerEvent) => {
      if (decayRaf) {
        cancelAnimationFrame(decayRaf)
        decayRaf = 0
      }
      const now = performance.now()
      if (lastX != null && now > lastT) {
        tiltRaw.set(tiltFromVelocity((e.clientX - lastX) / (now - lastT)))
      }
      lastX = e.clientX
      lastT = now
      scheduleDecay()
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      if (decayRaf) cancelAnimationFrame(decayRaf)
    }
  }, [tiltRaw])

  return (
    <motion.div
      className={className ? `dnd-ghost ${className}` : 'dnd-ghost'}
      style={{ rotate: tilt, ...style }}
      // The ghost is a visual clone of real, focusable markup (SessionCard,
      // sortable grips) — keep the clone out of the tab order and the a11y
      // tree; dnd-kit's live region announces the drag on its own.
      aria-hidden="true"
      inert
    >
      {children}
    </motion.div>
  )
}
