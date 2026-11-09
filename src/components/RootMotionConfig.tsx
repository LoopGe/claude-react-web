import type { ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { useMotionSuppressed } from '../utils/reduced-motion'

/** `reducedMotion` follows the app-level motion gate (OS preference OR the
 *  in-app Animation speed = Off preset) so transform/layout animations snap on
 *  the same switch as the CSS tokens. Migrated components pair this with
 *  useMotionTransition() (src/utils/transitions.ts), which also zeroes
 *  opacity. Unmigrated components keep their own CSS/hook guards. */
export function RootMotionConfig({ children }: { children: ReactNode }) {
  const suppressed = useMotionSuppressed()
  return <MotionConfig reducedMotion={suppressed ? 'always' : 'user'}>{children}</MotionConfig>
}
