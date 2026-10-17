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
// Bare ease arrays for per-key transition configs (motion's per-value
// `transition` entries take an ease, not a full transition object). Same
// token mirrors as above — keep in sync with tokens.css.
const ENTER_EASE = ENTER_TRANSITION.ease
const EXIT_EASE = EXIT_TRANSITION.ease

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
 * Top slide-down banner motion (PinnedUserMessage; RecapWindow keeps it only
 * for its /clear dissolve exit): drops 6px from the top of the chat panel,
 * no scale. Enter is ENTER (180ms), exit is EXIT (120ms).
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

// Mirrored layout values for useTopCardMotion's collapse — same convention as
// the motion tokens above: JS duplicates what CSS owns so the exit can cancel
// layout the element leaves behind. Keep in sync with the cited rules.
//   border: glass.css gives .recap-window (Transcript cards group) a
//     `border: 2px solid` shell, and the global `*` rule sets
//     box-sizing: border-box. The exit animates `height: 0`, but borders are
//     NOT part of the animated value: at height 0 the box still renders its
//     2px top + 2px bottom border, so the exiting ghost occupies 4px of
//     phantom layout until AnimatePresence unmounts it — the transcript
//     beneath visibly jumps at the last frame. Zeroing border-width on the
//     height's own timing folds the shell into the collapse.
//   margin: overlays.css separates .chat-top-stack's children (recap above,
//     pinned-question header below) with `gap: var(--space-2)` (8px). The gap
//     belongs to the PARENT, so it survives the recap's own collapse and pops
//     8px at unmount whenever both cards are open. The exit animates a
//     matching negative bottom margin (gap + margin → 0) so the pinned header
//     finishes its rise exactly at unmount instead of taking a final step.
//     The `animate` target restores both rest values so an aborted exit
//     recovers the shell, same as the height:'auto' restore below.
const RECAP_SHELL_BORDER_PX = 2
const TOP_STACK_GAP_PX = 8

/**
 * Top-overlay card motion (RecapWindow). Mount is the same top-banner drop-in
 * as useTopBannerMotion (opacity + y:-6, ENTER 180ms); the exit is where it
 * differs — a STAGGERED fade + height collapse, mirrored from
 * useBottomCardMotion: the card fades/lifts in ~120ms while its height
 * collapses over 200ms after a 90ms delay, so the shrinking box never
 * squashes a still-visible card. The collapse is the point: the recap
 * overlays the transcript (absolute .chat-top-stack), so folding its height
 * away progressively reveals the messages beneath instead of popping them in
 * when the node unmounts. AnimatePresence keeps the node mounted through the
 * exit and owns the height auto → 0 animation. (No overflow clip is needed
 * for the collapse: glass.css keeps .recap-window overflow:hidden at rest,
 * so the shrinking box clips its own content.) border-width and a gap-
 * cancelling negative margin-bottom ride the height's timing so the box ends
 * at exactly 0 occupied space — see RECAP_SHELL_BORDER_PX / TOP_STACK_GAP_PX.
 * Reduced motion snaps everything to 0.
 */
export function useTopCardMotion() {
  const reduce = useReducedMotion()
  if (reduce) {
    return {
      card: {
        initial: { opacity: 0 },
        // height:'auto' restores the natural size when an exit is aborted
        // mid-collapse (AnimatePresence re-entry) — motion animates its
        // internal height value back, so no stranded inline height. The
        // border/margin rest values ride along for the same aborted-exit
        // recovery (see the mirrored-value comments above).
        animate: {
          opacity: 1,
          height: 'auto',
          borderWidth: RECAP_SHELL_BORDER_PX,
          marginBottom: 0,
          transition: { duration: 0 },
        },
        exit: {
          opacity: 0,
          height: 0,
          borderWidth: 0,
          marginBottom: -TOP_STACK_GAP_PX,
          transition: { duration: 0 },
        },
      },
    }
  }
  return {
    card: {
      initial: { opacity: 0, y: -6 },
      // height:'auto' in animate (vs the bare banner) is what makes an
      // aborted exit recover: motion re-grows the collapsed height back to
      // natural instead of leaving the box squashed at its last mid-collapse
      // value. height: 0 in the exit target is the collapse itself — the
      // transition entry below does nothing without it. borderWidth /
      // marginBottom pair with height the same way (restore on animate, zero
      // out on exit) so the collapse ends at exactly 0 occupied space.
      animate: {
        opacity: 1,
        y: 0,
        height: 'auto',
        borderWidth: RECAP_SHELL_BORDER_PX,
        marginBottom: 0,
        transition: ENTER_TRANSITION,
      },
      exit: {
        opacity: 0,
        y: -6,
        height: 0,
        borderWidth: 0,
        marginBottom: -TOP_STACK_GAP_PX,
        pointerEvents: 'none' as const,
        transition: {
          opacity: { duration: 0.12, ease: EXIT_EASE },
          y: { duration: 0.12, ease: EXIT_EASE },
          // height / border-width / gap-cancelling margin share one timing:
          // the box must fold as a unit — a border thinning ahead of the
          // height (or lagging behind it) would read as the outline detaching
          // from the shrinking box.
          height: { duration: 0.2, ease: ENTER_EASE, delay: 0.09 },
          borderWidth: { duration: 0.2, ease: ENTER_EASE, delay: 0.09 },
          marginBottom: { duration: 0.2, ease: ENTER_EASE, delay: 0.09 },
        },
      },
    },
  }
}

/**
 * Bottom-overlay card motion (TodoChecklist / MonitorBar / WorkingBubble).
 * Mount is a rise-in; exit is a STAGGERED fade + height collapse — the card
 * fades/sinks in ~110ms while the wrapper's height collapses over 160ms after a
 * 90ms delay, so the shrinking box never squashes a still-visible card.
 * AnimatePresence keeps the node mounted through the exit (no manual delayed
 * unmount) and owns the height `auto → 0` animation.
 */
export function useBottomCardMotion() {
  const reduce = useReducedMotion()
  if (reduce) {
    return {
      card: {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0 } },
        exit: { opacity: 0, height: 0, transition: { duration: 0 } },
      },
    }
  }
  return {
    card: {
      initial: { opacity: 0, y: 4 },
      animate: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const } },
      exit: {
        opacity: 0,
        y: 6,
        height: 0,
        transition: {
          opacity: { duration: 0.11, ease: [0.4, 0, 1, 1] as const },
          y: { duration: 0.11, ease: [0.4, 0, 1, 1] as const },
          height: { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const, delay: 0.09 },
        },
      },
    },
  }
}
