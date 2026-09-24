// Shared AnimatePresence child for the transcript's bottom-overlay cards
// (TodoChecklist / MonitorBar / the WorkingBubble — via Chat and
// SideChatDrawer). Owns the motion.div that runs the mount rise-in and the
// staggered exit (see useBottomCardMotion), plus the EXIT-ONLY overflow clip.
//
// The clip must NOT apply at rest: the wrapper hugs its card exactly (top edge
// = card top, bottom = card bottom + row gap), so a rest-state `overflow:
// clip` would cut the card's `--drawer-shadow` halo to the wrapper's box — the
// top/bottom of the shadow vanish and its left-offset tail reads as a stray
// shadow band beside the card (the "shadow on the left of the working bubble"
// regression). Only while exiting does the height animate to 0, and the clip
// is what hides the content through that collapse. `useIsPresent` is what
// knows "exiting", and it must be read INSIDE the AnimatePresence child —
// which is exactly what this component is. (It cannot be read by the files
// that render this tree: they sit OUTSIDE the presence context that
// AnimatePresence provides around each child.)
//
// Timing note: the class (and thus the clip) engages at exit START —
// isPresent flips the moment AnimatePresence begins the exit, while the
// height tween is delayed ~90ms behind the 110ms fade. That shadow pop is
// the same trade the pre-motion design made (its exiting class also applied
// the clip at exit start); mid-fade it is not worth a timer to shave.
//
// Deliberately `useIsPresent`, NOT `usePresence`: the latter REGISTERS this
// component as an exit participant that must call `safeToRemove` — which it
// never does, so AnimatePresence would wait forever and the card would never
// unmount. The inner motion.div owns the exit animation and the removal;
// here we only READ presence.

import { motion, useIsPresent } from 'motion/react'
import type { ReactNode } from 'react'
import { useBottomCardMotion } from '../utils/transitions'

export function BottomCardMotion({
  fixed = false,
  children,
}: {
  /** Status card (WorkingBubble): never shrink under the stack's 45% cap. */
  fixed?: boolean
  children: ReactNode
}) {
  const isPresent = useIsPresent()
  const bottomCard = useBottomCardMotion()
  return (
    <motion.div
      className={`bottom-card-motion${fixed ? ' bottom-card-motion-fixed' : ''}${isPresent ? '' : ' bottom-card-motion-exiting'}`}
      initial={bottomCard.card.initial}
      animate={bottomCard.card.animate}
      exit={bottomCard.card.exit}
    >
      {children}
    </motion.div>
  )
}
