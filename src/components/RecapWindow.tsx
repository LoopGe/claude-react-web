// Floating session-recap window — slides in from the top of the ChatPanel.
// Non-modal: occupies only the top portion (~45% max height) so the chat
// stays visible and scrollable beneath it. Frosted-glass backdrop matches
// the SettingsPanel/GitPanel overlays. A close (X) button dismisses it;
// once dismissed it stays hidden until a NEW recap arrives (new generatedAt)
// or the user reopens it via the header button.
//
// Three states share the same shell (ready / pending / error), mirroring the
// old RecapFooter that lived in the Virtuoso footer slot.

import { memo, useLayoutEffect, useRef } from 'react'
import { motion } from 'motion/react'
import type { SessionRecap } from '../../shared/session-info'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { ENTER_TRANSITION, EXIT_TRANSITION } from '../utils/transitions'
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
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
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

    // Freeze at the previous height, commit it with a reflow, then transition
    // to the new height. The reflow between the two writes is what makes the
    // browser register a property change to animate.
    el.style.height = `${prevHeight}px`
    void el.offsetHeight
    el.style.height = `${endHeight}px`

    const onEnd = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== 'height') return
      el.style.height = ''
      el.removeEventListener('transitionend', onEnd)
    }
    el.addEventListener('transitionend', onEnd)
    return () => el.removeEventListener('transitionend', onEnd)
    // Content-driven deps: status swap, new summary, or a fresh generation.
  }, [recap.status, recap.summary, recap.generatedAt])

  return (
    <motion.div
      ref={windowRef}
      className={`recap-window${clearing ? ' recap-window-clearing' : ''}`}
      role="dialog"
      aria-label="Session recap"
      initial={{ opacity: 0, y: -8, transition: ENTER_TRANSITION }}
      animate={{ opacity: 1, y: 0, transition: ENTER_TRANSITION }}
      // Normal close slides up + fades (mirrors the old recap-window-out).
      // pointerEvents:'none' disables the close button / body scrollbar while
      // the element fades out — replaces the deleted
      // [data-state="closing"]{pointer-events:none} CSS rule so the exiting
      // ghost can't be re-clicked. The /clear dissolve stays CSS-driven
      // (recap-window-clearing class); motion only owns normal open/close.
      exit={{ opacity: 0, y: -8, pointerEvents: 'none', transition: EXIT_TRANSITION }}
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
        <div key={recap.status} className="recap-window-body-inner">
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
  // status === 'ready' — summary may still legitimately be missing if the
  // server constructed the ready frame defensively; bail rather than render a
  // half-card.
  if (!recap.summary) return null
  return <Markdown text={recap.summary} />
}
