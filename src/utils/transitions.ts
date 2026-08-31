/**
 * Motion transition presets shared by migrated components.
 *
 * These mirror the `--motion-duration-*` / `--motion-ease-*` design tokens in
 * `src/styles/tokens.css`. Motion's `animate`/`exit` props take numeric
 * seconds (and cubic-bezier easing arrays), not CSS variable references, so
 * we duplicate the token values here in JS form. Keep these in sync with
 * tokens.css. A future improvement could read the computed CSS vars at
 * runtime instead.
 *
 *   enter  -> --motion-duration-base (180ms), --motion-ease-enter
 *   exit   -> --motion-duration-fast (120ms), --motion-ease-exit
 */

import { useReducedMotion } from 'motion/react'

export const ENTER_TRANSITION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const }
export const EXIT_TRANSITION = { duration: 0.12, ease: [0.4, 0, 1, 1] as const }

// Menu/picker popovers (ContextMenu / EffortSlider / ModelPicker) use
// --motion-duration-fast (120ms) for BOTH entrance and exit (the ctx-menu-in
// /ctx-menu-out keyframes both used `fast`), so their entrance is 120ms, not
// 180ms like the recap/pinned overlays above. Exit reuses EXIT_TRANSITION.
export const MENU_ENTER_TRANSITION = { duration: 0.12, ease: [0.22, 1, 0.36, 1] as const }

// Two-layer overlays (ConfirmDialog / PromptDialog, and later PanelOverlay /
// settings / git / CommandPalette / modal) animate a backdrop (opacity) plus
// a card (opacity + scale + y). Card exit uses --motion-duration-base (180ms)
// ease-exit, one step longer than the backdrop exit (EXIT_TRANSITION, 120ms),
// matching the old overlay-panel-out keyframe.
export const OVERLAY_CARD_EXIT_TRANSITION = { duration: 0.18, ease: [0.4, 0, 1, 1] as const }

/**
 * Snap to `duration: 0` when the user prefers reduced motion, restoring the
 * codebase's pre-motion "snap everything" behavior (old CSS reduced-motion
 * blocks forced 0.01ms). Pass the normal transition; get back either it or
 * `{ duration: 0 }`. Complements MotionConfig reducedMotion="user", which
 * covers transform keys (x/y/scale); this additionally zeroes opacity.
 */
export function useMotionTransition<T extends { duration: number; ease: readonly number[] }>(
  normal: T,
) {
  return useReducedMotion() ? { duration: 0 } : normal
}

/**
 * Motion variants for the two-layer overlay pattern (backdrop + card), used by
 * ConfirmDialog / PromptDialog and reusable by the rest of the overlay family.
 * Mirrors the `overlay-backdrop-in/out` + `overlay-panel-in/out` keyframes:
 *   backdrop: opacity 0->1 (enter 180ms), 1->0 (exit 120ms)
 *   card:     opacity + scale 0.98 + y 8->0 (enter), 0->4 (exit); exit 180ms
 * `pointerEvents:'none'` on exit disables the backdrop/card while fading.
 * Reduced motion snaps both via useMotionTransition.
 */
export function useOverlayMotion() {
  const enter = useMotionTransition(ENTER_TRANSITION)
  const backdropExit = useMotionTransition(EXIT_TRANSITION)
  const cardExit = useMotionTransition(OVERLAY_CARD_EXIT_TRANSITION)
  return {
    backdrop: {
      initial: { opacity: 0, transition: enter },
      animate: { opacity: 1, transition: enter },
      exit: { opacity: 0, pointerEvents: 'none' as const, transition: backdropExit },
    },
    card: {
      initial: { opacity: 0, scale: 0.98, y: 8, transition: enter },
      animate: { opacity: 1, scale: 1, y: 0, transition: enter },
      exit: { opacity: 0, scale: 0.98, y: 4, pointerEvents: 'none' as const, transition: cardExit },
    },
  }
}

/**
 * Anchored popover/menu/picker motion (ContextMenu / EffortSlider /
 * ModelPicker / PluginPopover): scale 0.98 + a 4px upward nudge on enter,
 * 2px on exit — mirrors the old ctx-menu-in/out keyframes. Enter uses
 * MENU_ENTER (120ms), exit uses EXIT (120ms). `pointerEvents:'none'` on exit
 * so the fading surface can't be clicked.
 */
export function usePopoverMotion() {
  const enter = useMotionTransition(MENU_ENTER_TRANSITION)
  const exit = useMotionTransition(EXIT_TRANSITION)
  return {
    popover: {
      initial: { opacity: 0, scale: 0.98, y: -4, transition: enter },
      animate: { opacity: 1, scale: 1, y: 0, transition: enter },
      exit: { opacity: 0, scale: 0.98, y: -2, pointerEvents: 'none' as const, transition: exit },
    },
  }
}

/**
 * Top slide-down banner motion (PinnedUserMessage / RecapWindow): drops 6px
 * from the top of the chat panel, no scale. Enter is ENTER (180ms), exit is
 * EXIT (120ms).
 */
export function useTopBannerMotion() {
  const enter = useMotionTransition(ENTER_TRANSITION)
  const exit = useMotionTransition(EXIT_TRANSITION)
  return {
    banner: {
      initial: { opacity: 0, y: -6, transition: enter },
      animate: { opacity: 1, y: 0, transition: enter },
      exit: { opacity: 0, y: -6, pointerEvents: 'none' as const, transition: exit },
    },
  }
}
