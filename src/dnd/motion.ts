// Shared motion constants for the dnd-kit surfaces. One place so the
// displaced-siblings animation, the drop settle, and the overlay fade all
// speak the same motion language (and reduced-motion overrides stay in one
// CSS file — see styles/dnd.css).

/** Ease-out with a soft overshoot tail — the "icon snaps into the grid"
 *  curve. Used for sortable displacement transitions and the overlay drop. */
export const DND_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Transition applied by useSortable to an item's transform while a drag
 *  displaces it. Short + springy: siblings glide out of the way as the
 *  ghost approaches rather than teleporting after the drop. */
export const SORTABLE_TRANSITION = `transform 240ms ${DND_EASE}`

/** DragOverlay drop animation — the ghost springs to the final slot while
 *  the (dimmed) source card fades back in. */
export const DROP_ANIMATION = {
  duration: 260,
  easing: DND_EASE,
} as const
