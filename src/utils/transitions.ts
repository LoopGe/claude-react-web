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

export const ENTER_TRANSITION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const }
export const EXIT_TRANSITION = { duration: 0.12, ease: [0.4, 0, 1, 1] as const }
