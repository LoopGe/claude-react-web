// Floating session-recap window — slides in from the top of the ChatPanel.
// Non-modal: occupies only the top portion (~45% max height) so the chat
// stays visible and scrollable beneath it. Frosted-glass backdrop matches
// the SettingsPanel/GitPanel overlays. A close (X) button dismisses it;
// once dismissed it stays hidden until a NEW recap arrives (new generatedAt)
// or the user reopens it via the header button.
//
// Three states share the same shell (ready / pending / error), mirroring the
// old RecapFooter that lived in the Virtuoso footer slot.

import { prefersReducedMotion } from '../utils/reduced-motion'
import { memo, useLayoutEffect, useRef } from 'react'
import { motion, useIsPresent } from 'motion/react'
import type { SessionRecap } from '../../shared/session-info'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useTopBannerMotion, useTopCardMotion } from '../utils/transitions'
import { Markdown } from './Markdown'
import { IconSparkles, IconAlertTriangle, IconX } from './icons/ToolIcons'

interface Props {
  recap: SessionRecap
  /** True while a /clear is in flight. Reuses the transcript's
   *  `clear-blur-fade` exit animation so the recap dissolves in sync with
   *  the message list instead of snapping out when the server confirms. */
  clearing?: boolean
  onClose: () => void
}

export const RecapWindow = memo(function RecapWindow({ recap, clearing, onClose }: Props) {
  const windowRef = useRef<HTMLDivElement>(null)
  const setBodyOs = useOverlayScrollbar({ autoHide: 'leave' })
  // Natural height captured at the end of the previous render's layout pass.
  // On the NEXT content change this is the "from" value — because
  // useLayoutEffect runs AFTER React has already written the new content to
  // the DOM, reading offsetHeight at the top of the effect would give the NEW
  // height, not the old one. So we stash the previous height here and use it
  // as the tween's start point.
  const prevHeightRef = useRef<number | null>(null)
  // Under reduced motion, snap (duration:0) instead of fading — see
  // useMotionTransition. Normal close is the staggered fade + height collapse
  // (useTopCardMotion): folding the card's height away progressively reveals
  // the transcript beneath it instead of popping the covered messages into
  // view when the node unmounts. The /clear dissolve keeps the old banner
  // exit — the clear-blur-fade CSS animation owns the look there, and a
  // height collapse would fight the transcript's own dissolve. banner's
  // initial/animate go unused (card owns mount), but the hook stays the
  // single source of the dissolve shape shared with PinnedUserMessage in the
  // same stack — an inline copy would drift out of sync with it.
  const { banner } = useTopBannerMotion()
  const { card } = useTopCardMotion()
  // Presence read inside the AnimatePresence child (this component is one).
  // isPresentRef below is what the content tween gates on; the flip effect
  // that follows freezes any mid-flight content tween when the exit starts.
  // The collapse itself needs no overflow clip — glass.css keeps
  // .recap-window overflow:hidden at rest.
  const isPresent = useIsPresent()
  // Read by the content tween's effect WITHOUT being in its dep array — the
  // tween is keyed on content only, so an aborted exit's re-entry (isPresent
  // flip with unchanged content) can't re-run it and erase the inline height
  // motion is mid-way through re-growing (animate carries height:'auto').
  // Mirror of MessageList's settlingRef render-time sync pattern.
  const isPresentRef = useRef(isPresent)
  if (isPresentRef.current !== isPresent) isPresentRef.current = isPresent
  // Exit start: motion takes ownership of height (per-frame collapse
  // writes). A content tween caught mid-flight must not double-interpolate
  // those writes — freeze the box at its CURRENT (mid-interpolation) height
  // and drop the inline transition. Dropping the transition alone would let
  // the box snap to the tween's end px; freezing first hands motion a
  // seamless start value. (No overflow clip needed: glass.css keeps
  // .recap-window overflow:hidden at rest.)
  useLayoutEffect(() => {
    if (isPresent) return
    const el = windowRef.current
    if (!el) return
    el.style.height = getComputedStyle(el).height
    el.style.removeProperty('transition')
  }, [isPresent])

  // Animate the window height when the recap content changes (pending →
  // ready, a new ready summary arriving, ready → error). CSS can't transition
  // to/from `auto`, so we freeze the element at its previous height, force a
  // reflow, then set the new height — the CSS `transition: height` tweens
  // between the two explicit pixel values. After the transition the inline
  // height is cleared so the element returns to its natural flex-driven size.
  // Skipped on first mount (the entrance keyframe handles that) and under
  // prefers-reduced-motion.
  useLayoutEffect(() => {
    const el = windowRef.current
    if (!el) return
    // On the EXITING ghost the skip is mandatory, not cosmetic: motion owns
    // the height there (per-frame collapse writes; an exit that starts
    // mid-tween freezes the box and takes over via the isPresent flip
    // effect). Skipping the whole body — prevHeightRef bookkeeping included,
    // since offsetHeight on a collapsing box is the animated height, not the
    // natural one — and the effect is keyed on content only, so a re-entry
    // can't re-run it either.
    if (!isPresentRef.current) return
    const reduceMotion = prefersReducedMotion()
    if (reduceMotion) {
      el.style.height = ''
      prevHeightRef.current = null
      return
    }

    // Drop any inline height left by a prior tween so offsetHeight reflects
    // the just-rendered content's natural height.
    el.style.height = ''
    const endHeight = el.offsetHeight
    const prevHeight = prevHeightRef.current
    prevHeightRef.current = endHeight

    // First mount, or no height change — nothing to tween.
    if (prevHeight == null || prevHeight === endHeight) return

    // The height transition is applied INLINE for the tween's lifetime (not
    // on the base .recap-window rule): motion's exit / aborted-exit re-entry
    // also write height per frame, and an always-on CSS transition would lag
    // each written frame into a rubber-band. Scoped here, motion paths run
    // transition-free and the tween still reads as a smooth grow/shrink.
    el.style.transition = 'height var(--motion-duration-base) var(--motion-ease-standard)'
    // Freeze at the previous height, commit it with a reflow, then transition
    // to the new height. The reflow between the two writes is what makes the
    // browser register a property change to animate.
    el.style.height = `${prevHeight}px`
    void el.offsetHeight
    el.style.height = `${endHeight}px`

    const onEnd = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== 'height') return
      el.style.height = ''
      el.style.transition = ''
      el.removeEventListener('transitionend', onEnd)
    }
    el.addEventListener('transitionend', onEnd)
    return () => el.removeEventListener('transitionend', onEnd)
    // Content-driven deps: status swap, new summary, or a fresh generation.
    // Presence is read via isPresentRef (not a dep) — a presence flip alone
    // must not re-run this effect.
  }, [recap.status, recap.summary, recap.generatedAt])

  return (
    <motion.div
      ref={windowRef}
      className={`recap-window${clearing ? ' recap-window-clearing' : ''}`}
      role="dialog"
      aria-label="Session recap"
      initial={card.initial}
      animate={card.animate}
      // Normal close fades + folds the height away (useTopCardMotion) so the
      // transcript beneath is revealed progressively. pointerEvents:'none'
      // disables the close button / body scrollbar while the element fades
      // out — replaces the deleted [data-state="closing"]{pointer-events:none}
      // CSS rule so the exiting ghost can't be re-clicked. The /clear
      // dissolve stays CSS-driven (recap-window-clearing class) with the old
      // banner exit; motion owns normal open/close.
      exit={clearing ? banner.exit : card.exit}
    >
      <div className="recap-window-header">
        <span className="recap-window-title">
          {recap.status === 'error' ? (
            <IconAlertTriangle size={14} />
          ) : (
            <IconSparkles size={14} />
          )}
          {recap.status === 'error' ? 'Recap unavailable' : 'Session recap'}
        </span>
        <button
          type="button"
          className="recap-window-close"
          onClick={onClose}
          aria-label="Close recap"
        >
          <IconX size={14} />
        </button>
      </div>
      <div className="recap-window-body" ref={setBodyOs}>
        {/* Key includes generatedAt so a freshly-GENERATED summary (same
            'ready' status, new generation) remounts and replays the per-block
            reveal; pending carries no generatedAt (key 'pending:'). The
            -ready class opts the mounted summary out of the whole-body
            recap-body-in fade — the reveal is per-block there, and the two
            fades would multiply into mush. */}
        <div
          key={`${recap.status}:${recap.generatedAt ?? ''}`}
          className={`recap-window-body-inner${
            recap.status === 'ready' ? ' recap-window-body-ready' : ''
          }`}
        >
          {recap.status === 'pending' ? (
            <div className="recap-msg-loading-body">
              <span className="recap-msg-loading-bar" aria-hidden />
              <span>Catching you up on this session…</span>
            </div>
          ) : recap.status === 'error' ? (
            <div className="recap-window-error">{recap.error ?? 'Unknown error'}</div>
          ) : (
            <RecapBody recap={recap} />
          )}
        </div>
      </div>
    </motion.div>
  )
})

function RecapBody({ recap }: { recap: SessionRecap }) {
  const revealRef = useRef<HTMLDivElement>(null)
  // Index each top-level markdown block for the staggered reveal: CSS reads
  // --i as the animation-delay multiplier (see .recap-reveal in
  // overlays.css). The wrapper remounts on every fresh generation
  // (body-inner key = status:generatedAt), so the pass — and the reveal —
  // replays per summary. Runs pre-paint in a layout effect, so no block is
  // ever painted at full opacity before its delay comes up. Keyed on the
  // summary too: a ready frame that arrives summary-less (defensive server
  // frame) then gains one with the SAME generatedAt must re-index, or the
  // stagger collapses into a simultaneous flash.
  useLayoutEffect(() => {
    const root = revealRef.current
    if (!root) return
    Array.from(root.querySelectorAll('.md > *')).forEach((el, i) => {
      ;(el as HTMLElement).style.setProperty('--i', String(i))
    })
  }, [recap.summary])
  // status === 'ready' — summary may still legitimately be missing if the
  // server constructed the ready frame defensively; bail rather than render a
  // half-card.
  if (!recap.summary) return null
  return (
    <div ref={revealRef} className="recap-reveal">
      <Markdown text={recap.summary} />
    </div>
  )
}
