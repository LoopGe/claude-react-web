// Pinned "current question" header — the real user message from the turn
// currently in view, shown at the top of the chat panel when that message has
// scrolled out of the viewport. Reuses the RecapWindow frosted-glass
// treatment (rendered as a sibling inside .chat-top-stack, beneath the recap
// when both are open). Clicking the body scrolls back to the message —
// MessageList's registered navigator targets exactly the message this bar
// shows.
//
// A chevron toggle on the right EXPANDS the header in-place into a panel
// listing every user message in the transcript (capped at ~5 rows by CSS
// max-height, scrollable beyond that). Unlike a floating dropdown, the
// expansion grows the header's own height — it stays a flow flex child of
// .chat-top-stack, so it never overlaps the transcript and the stack's
// max-height cap applies naturally.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useTopBannerMotion } from '../utils/transitions'
import { IconChevronDown, IconUser } from './icons/ToolIcons'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import { useExitPresence } from '../hooks/useExitPresence'

export interface PinnedUserMessageInfo {
  id: string
  text: string
  /** Renderable-item index; passable to ScrollNavigator.to. */
  index: number
}

interface Props {
  /** Truncated for display via CSS ellipsis; full text kept for the tooltip. */
  text: string
  /** True while a /clear is in flight. Reuses the transcript's
   *  `clear-blur-fade` exit animation so the pinned header dissolves in sync
   *  with the message list instead of snapping out when the server confirms
   *  (mirrors RecapWindow, its sibling in `.chat-top-stack`). */
  clearing?: boolean
  /** All rendered user messages (oldest→newest) for the expanded list. */
  userMessages?: PinnedUserMessageInfo[]
  /** The id of the currently-pinned question, highlighted in the list. */
  activeId?: string
  /** Jump to a specific user message by id (used by the list). */
  onJumpTo?: (id: string) => void
  onClick: () => void
}

export const PinnedUserMessage = memo(function PinnedUserMessage({ text, clearing, userMessages, activeId, onJumpTo, onClick }: Props) {
  // Under reduced motion, snap (duration:0) instead of fading — see
  // useMotionTransition.
  const { banner } = useTopBannerMotion()

  const [expanded, setExpanded] = useState(false)
  // Keep the wrapper mounted through the collapse tween: useExitPresence delays
  // the unmount so the natural→0 height animation has time to play (otherwise
  // React removes the DOM the instant `expanded` flips false and there's
  // nothing to animate). The timeout MUST exceed the CSS transition duration
  // (180ms) — if they're equal, a scheduling jitter can unmount the wrapper
  // mid-tween, leaving the list frozen at an intermediate height before it
  // vanishes. 250ms gives the 180ms transition a comfortable margin.
  const exitPresence = useExitPresence(expanded, 250)
  const shouldRenderList = exitPresence.shouldRender
  const isExiting = exitPresence.isExiting
  const rootRef = useRef<HTMLDivElement>(null)
  const listWrapperRef = useRef<HTMLDivElement>(null)
  const setWrapperOs = useOverlayScrollbar({ autoHide: 'leave' })
  const wrapperRefMerged = useMergedRef(listWrapperRef, setWrapperOs)
  // Mirror activeId into a ref so the transitionend closure reads the latest
  // value without re-running the layout effect (which would restart the tween)
  // every time activeId changes.
  const activeIdRef = useRef(activeId)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  // Height tween the LIST WRAPPER only (not the root). Tweening the root
  // froze it at the collapsed (header-only) height while the list DOM was
  // already present, and the reflow at that frozen height re-laid the header
  // text — a visible jitter on text that should never move. By tweening only
  // the list wrapper's height, the header row stays completely untouched.
  // Expand: 0 → natural. Collapse: natural → 0 (wrapper still mounted via
  // useExitPresence). Mirrors RecapWindow's freeze/reflow/tween/clear pattern.
  useLayoutEffect(() => {
    const wrapper = listWrapperRef.current
    if (!wrapper) return
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      wrapper.style.height = ''
      return
    }

    const cssMaxHeight = parseInt(getComputedStyle(wrapper).maxHeight, 10)
    const cap = Number.isFinite(cssMaxHeight) && cssMaxHeight > 0 ? cssMaxHeight : Infinity

    if (isExiting) {
      // Collapse: reset scrollTop (may be scrolled to active item from
      // expand; shrinking height clamps scrollTop → content jump). Freeze
      // the current height. Zero border-top + padding NOW (same frame as
      // the freeze, while the element is at full height — the snap is
      // invisible because the content fills the frozen height). Then on
      // the next frame tween height to 0. Without zeroing border+padding,
      // height:0 sticks at 9px (border 1 + padding 8) — the browser keeps
      // a minimum rendered box for the scroll container.
      wrapper.scrollTop = 0
      const currentHeight = wrapper.offsetHeight
      wrapper.style.height = `${currentHeight}px`
      wrapper.style.borderTopWidth = '0px'
      wrapper.style.paddingTop = '0px'
      wrapper.style.paddingBottom = '0px'
      void wrapper.offsetHeight
      const raf = requestAnimationFrame(() => {
        wrapper.style.height = '0px'
      })
      const onEnd = (e: TransitionEvent) => {
        if (e.target !== wrapper || e.propertyName !== 'height') return
        wrapper.removeEventListener('transitionend', onEnd)
        // Leave at 0; useExitPresence unmounts shortly after.
      }
      wrapper.addEventListener('transitionend', onEnd)
      return () => {
        cancelAnimationFrame(raf)
        wrapper.removeEventListener('transitionend', onEnd)
      }
    }

    // Expand: freeze 0, then on the next frame tween to the natural height.
    // Restore border+padding in case a prior collapse left them zeroed inline
    // (fast toggle: collapse started → user re-expanded before useExitPresence
    // unmounted the wrapper, so the same DOM element runs expand with
    // borderTopWidth/padding still at 0px from the collapse branch).
    wrapper.style.borderTopWidth = ''
    wrapper.style.paddingTop = ''
    wrapper.style.paddingBottom = ''
    wrapper.style.height = '0px'
    void wrapper.offsetHeight
    const naturalHeight = Math.min(wrapper.scrollHeight, cap)
    const raf = requestAnimationFrame(() => {
      wrapper.style.height = `${naturalHeight}px`
    })
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== wrapper || e.propertyName !== 'height') return
      wrapper.removeEventListener('transitionend', onEnd)
      wrapper.style.height = ''
      const aid = activeIdRef.current
      if (aid) {
        const activeEl = wrapper.querySelector<HTMLElement>('.pinned-user-message-list-item.active')
        if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }
    wrapper.addEventListener('transitionend', onEnd)
    return () => {
      cancelAnimationFrame(raf)
      wrapper.removeEventListener('transitionend', onEnd)
    }
  }, [isExiting, shouldRenderList])

  // Dismiss the expanded list on outside mousedown (mirrors ContextMenu's
  // pattern — mousedown beats click, feels snappier and avoids swallowing the
  // click that opened it) and on Escape. Only armed while expanded.
  useEffect(() => {
    if (!expanded) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      // Capture + stopPropagation (same pattern as AppearancePanel's
      // popover): this press collapses the expansion, it must not keep
      // bubbling to App's escape chain — idle-Esc now opens the resume
      // picker (escapeAction), and a plain bubble listener here fires
      // AFTER App's (registered at App mount), so stopPropagation alone
      // wouldn't help.
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setExpanded(false)
      }
    }
    window.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [expanded])

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation() // don't trigger the body's onClick (jump prev)
    setExpanded((v) => !v)
  }, [])

  const handleJump = useCallback((id: string) => {
    onJumpTo?.(id)
    setExpanded(false)
  }, [onJumpTo])

  const hasList = !!userMessages && userMessages.length > 0

  return (
    <motion.div
      ref={rootRef}
      className={`pinned-user-message${clearing ? ' pinned-user-message-clearing' : ''}`}
      initial={banner.initial}
      animate={banner.animate}
      // Normal close slides up + fades (mirrors the old
      // pinned-user-message-out). pointerEvents:'none' disables the header
      // while it fades out — replaces the deleted
      // [data-state="closing"]{pointer-events:none} CSS rule so the exiting
      // ghost can't fire onClick (a spurious scroll-nav) mid-fade. The /clear
      // dissolve stays CSS-driven (pinned-user-message-clearing class).
      exit={banner.exit}
    >
      <div className="pinned-user-message-header-row">
        <button
          type="button"
          className="pinned-user-message-body"
          onClick={onClick}
          title={text}
        >
          <span className="pinned-user-message-label">
            <IconUser size={12} />
            You
          </span>
          <span className="pinned-user-message-text">{text}</span>
        </button>
        {hasList && (
          <button
            type="button"
            className={`pinned-user-message-dropdown-toggle${expanded ? ' open' : ''}`}
            onClick={handleToggle}
            aria-label="Show all questions"
            aria-expanded={expanded}
          >
            <IconChevronDown size={14} />
          </button>
        )}
      </div>
      {shouldRenderList && hasList && (
        <div className="pinned-user-message-list" ref={wrapperRefMerged}>
          {userMessages!.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`pinned-user-message-list-item${m.id === activeId ? ' active' : ''}`}
              title={m.text}
              onClick={() => handleJump(m.id)}
            >
              {m.text || '(empty)'}
            </button>
          ))}
        </div>
      )}
    </motion.div>
  )
})
