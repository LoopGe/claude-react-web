/**
 * Motion transition presets shared by migrated components.
 *
 * These mirror the `--motion-duration-*` / `--motion-ease-*` design tokens in
 * `src/styles/tokens.css`. Motion's `animate`/`exit` props take numeric
 * seconds (and cubic-bezier easing arrays), not CSS variable references, so
 * we duplicate the token values here in JS form. Keep these in sync with
 * tokens.css — a future improvement could read the computed CSS vars at
 * runtime instead.
 *
 *   enter  → --motion-duration-base (180ms) · --motion-ease-enter
 *   exit   → --motion-duration-fast (120ms) · --motion-ease-exit
 */

import { useReducedMotion } from 'motion/react'

export const ENTER_TRANSITION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const }
export const EXIT_TRANSITION = { duration: 0.12, ease: [0.4, 0, 1, 1] as const }

// Menu/picker popovers (ContextMenu / EffortSlider / ModelPicker) use
// --motion-duration-fast (120ms) for BOTH entrance and exit (the ctx-menu-in
// /ctx-menu-out keyframes both used `fast`), so their entrance is 120ms — not
// 180ms like the recap/pinned overlays above. Exit reuses EXIT_TRANSITION.
export const MENU_ENTER_TRANSITION = { duration: 0.12, ease: [0.22, 1, 0.36, 1] as const }

/**
 * Force a transition to `duration: 0` (snap) when the user prefers reduced
 * motion. MotionConfig `reducedMotion="user"` snaps POSITIONAL keys
 * (x/y/scale) but NOT opacity/filter — those still animate, which would leave
 * a 120ms opacity fade under reduced motion. The app's pre-motion behavior
 * was to snap EVERYTHING (the old CSS `prefers-reduced-motion` blocks forced
 * `animation-duration: 0.01ms`), so this restores that: pass the normal
 * transition, get back either it or `{ duration: 0 }`.
 */
export function useMotionTransition<T extends { duration: number; ease: readonly number[] }>(
  normal: T,
) {
  return useReducedMotion() ? { duration: 0 } : normal
}
