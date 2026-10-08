// Shared motion constants for the dnd-kit surfaces. One place so the
// displaced-siblings animation, the drop settle, and the overlay fade all
// speak the same motion language (and reduced-motion overrides stay in one
// CSS file — see styles/dnd.css).

import { defaultDropAnimationSideEffects, type DropAnimationSideEffects } from '@dnd-kit/core'

/** Ease-out with a soft overshoot tail — the "icon snaps into the grid"
 *  curve. Used for sortable displacement transitions and the overlay drop. */
export const DND_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Transition applied by useSortable to an item's transform while a drag
 *  displaces it. Short + springy: siblings glide out of the way as the
 *  ghost approaches rather than teleporting after the drop. */
export const SORTABLE_TRANSITION = `transform 240ms ${DND_EASE}`

/** DragOverlay drop animation — the ghost springs to the final slot while
 *  the source card springs back into place.
 *
 *  dnd-kit's DEFAULT side effects set the draggable NODE's opacity to 0 for
 *  the drop-glide (anti-double-vision: the source stays hidden until the
 *  ghost settles). Whether that default is right depends on the SURFACE:
 *   - main-panel: the draggable node is the WHOLE .chat-panel (the node must
 *     match the whole-panel clone so the ghost aligns without the 2px
 *     border-top pop — see ChatPanel's panelNodeRef), so the default blanks
 *     the entire panel for the 260ms glide — a white flash at every drop.
 *     The panel ghost lands pixel-exact on the source (measured), so the
 *     side effect is skipped for panels and the fly-home shows the source.
 *   - every other surface (sidebar cards, group pills, Profiles rows) keeps
 *     the default: their sources are small, hand-width-approximated ghosts,
 *     and hiding the source through the glide is what keeps the handoff
 *     single-carded.
 *  One shared object config, with the side effect branching on the active
 *  drag's kind (dnd-kit's function-config form is a custom animation RUNNER,
 *  not a config factory). */
const defaultHideSource = defaultDropAnimationSideEffects({
  styles: { active: { opacity: '0' } },
})
export const DROP_ANIMATION = {
  duration: 260,
  easing: DND_EASE,
  sideEffects: ((args: Parameters<DropAnimationSideEffects>[0]) => {
    const kind = (args.active.data.current as { kind?: string } | undefined)?.kind
    return kind === 'main-panel' ? undefined : defaultHideSource(args)
  }) as DropAnimationSideEffects,
}
