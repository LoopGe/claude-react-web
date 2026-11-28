// Shared motion constants for the dnd-kit surfaces. One place so the
// displaced-siblings animation, the drop settle, and the overlay fade all
// speak the same motion language (and reduced-motion overrides stay in one
// CSS file — see styles/dnd.css).

import { defaultDropAnimationSideEffects, type DropAnimationSideEffects } from '@dnd-kit/core'
import { dndPayloadOf } from './payload'

/** Ease-out with a soft overshoot tail — the "icon snaps into the grid"
 *  curve. Used for sortable displacement transitions and the overlay drop. */
export const DND_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Transition applied by useSortable to an item's transform while a drag
 *  displaces it. Short + springy: siblings glide out of the way as the
 *  ghost approaches rather than teleporting after the drop. */
export const SORTABLE_TRANSITION = `transform 240ms ${DND_EASE}`

/** Class the drop animation adds to the overlay wrapper; dnd.css keys the
 *  landing settle off it (lift scale 1.05 → 1, ghost radius → the landing
 *  card's run-position radius). Kept here so the CSS wizard and the JS
 *  reader can't drift. */
export const DND_GHOST_LANDING_CLASS = 'dnd-ghost-landing'

/** Counter-translation for the landing scale settle, in px.
 *
 *  dnd-kit measures the overlay's single child — the lifted ghost, at scale
 *  `lift` — and aligns that SCALED box's top-left to the landing card. The
 *  landing animates the ghost back to scale 1 about its centre, which slides
 *  its visual top-left by half the scale-induced growth:
 *  `(measuredWidth - measuredWidth/lift) / 2`. This returns exactly the
 *  opposite, so the visual top-left stays pinned to the card for the whole
 *  glide and the handoff has no positional jump. Pure so the geometry is
 *  unit-testable. */
export function landingCounterTranslate(measuredSize: number, lift: number): number {
  return -(measuredSize * (lift - 1)) / (2 * lift)
}

/** The run-position radius a sidebar card will carry after the drop, read from
 *  the `--run-radius` custom property session-list.css derives from the run
 *  classes. Custom properties are substituted, not transitioned, so the value
 *  is exact even while the card's `border-radius` is mid-animation — no
 *  ordering dependency on when `.dragging` is stripped. A mid-run card carries
 *  no `--run-radius`, so it falls back to square. */
function landingRadiusOf(shell: HTMLElement): string | null {
  const card = shell.querySelector<HTMLElement>('.session-item')
  if (!card) return null
  return getComputedStyle(card).getPropertyValue('--run-radius').trim() || '0'
}

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
 *  Every NON-panel division also adds the landing class: the lifted copy
 *  settles back into the flat card (scale → 1, pinned in place by the
 *  counter-translation below) and, for the single-card sidebar ghost, morphs
 *  its full rounding to the landing card's run radius instead of popping in
 *  at the end of the glide. (main-panel returns early and gets no landing
 *  class — its rigid ghost already lands pixel-exact.)
 *  One shared object config, with the side effect branching on the active
 *  drag's kind (dnd-kit's function-config form is a custom animation RUNNER,
 *  not a config factory). */
const defaultHideSource = defaultDropAnimationSideEffects({
  styles: { active: { opacity: '0' } },
})
/** The drop glide's length — the SINGLE owner. The landing settle transitions
 *  in dnd.css read it through the `--dnd-drop-duration` custom property the
 *  side effects write below (their 260ms fallback mirrors it, pinned by
 *  drag-motion.test.ts): the ghost is discarded when the glide ends, so a
 *  shorter settle would finish early and a longer one would be cut off
 *  mid-transition. */
export const DROP_DURATION_MS = 260
export const DROP_ANIMATION = {
  duration: DROP_DURATION_MS,
  easing: DND_EASE,
  sideEffects: ((args: Parameters<DropAnimationSideEffects>[0]) => {
    // The payload rides under the `crw` wrapper key — read it through
    // dndPayloadOf (a bare .kind read is always undefined and would
    // silently route panels back to the whole-panel blanking).
    const kind = dndPayloadOf(args.active.data.current as Record<string, unknown>)?.kind
    if (kind === 'main-panel') return undefined
    // READS first, batched: every getComputedStyle forces a style flush, and
    // interleaving the variable writes between reads would pay the flush
    // twice at the most frame-sensitive moment (the drop handoff).
    const radius = kind === 'sidebar-card' ? landingRadiusOf(args.active.node) : null
    const ghost = args.dragOverlay.node.firstElementChild as HTMLElement | null
    const lift = ghost ? parseFloat(getComputedStyle(ghost).getPropertyValue('scale')) : Number.NaN
    // Then the WRITES, all before the class flip so the ghost's first landing
    // frame is still its static scale/radius and the class change animates
    // them. dnd-kit measures the overlay's single child (the lifted ghost,
    // scaled 1.05) and aligns THAT scaled box to the landing slot; shrinking
    // it about its centre in the landing would slide the visual box
    // right/down by (scale-1)/2 of the measured size and snap back when the
    // ghost is discarded. Counter-translate by exactly that amount; the CSS
    // transitions both with the same ease/duration from their pre-drop
    // values, so the visual top-left stays pinned to the landing card for
    // the whole settle.
    const overlayStyle = args.dragOverlay.node.style
    if (radius) overlayStyle.setProperty('--dnd-landing-radius', radius)
    if (Number.isFinite(lift) && lift !== 1) {
      overlayStyle.setProperty(
        '--dnd-landing-dx',
        `${landingCounterTranslate(args.dragOverlay.rect.width, lift)}px`,
      )
      overlayStyle.setProperty(
        '--dnd-landing-dy',
        `${landingCounterTranslate(args.dragOverlay.rect.height, lift)}px`,
      )
    }
    overlayStyle.setProperty('--dnd-drop-duration', `${DROP_DURATION_MS}ms`)
    args.dragOverlay.node.classList.add(DND_GHOST_LANDING_CLASS)
    // Hide the source through the glide (fades out under its own base
    // transition while the ghost flies home — the soft emptying of the hole is
    // intended).
    const hideSource = defaultHideSource(args)
    return () => {
      // Re-show the source INSTANTLY at the handoff. The ghost has landed
      // pixel-exact on the card and is discarded this same frame; restoring
      // the inline opacity under the shell's base `transition: opacity 180ms`
      // would fade the card back in from 0 AFTER the ghost is gone — a hole,
      // then a slow materialize (the whole-card flash at every drop). Freeze
      // transitions, restore, force a style flush while frozen, then hand the
      // transition property back (a later-frame restore would transition
      // again: the after-change style's transition list is what arms it).
      const node = args.active.node
      const prevTransition = node.style.transition
      node.style.transition = 'none'
      hideSource?.()
      node.getBoundingClientRect() // synchronous style flush under transition:none
      node.style.transition = prevTransition
      args.dragOverlay.node.classList.remove(DND_GHOST_LANDING_CLASS)
    }
  }) as DropAnimationSideEffects,
}
