// Shared hover popover: a portal-based surface anchored to a trigger element.
//
// Two modes:
//   - passive (default): `role="tooltip"`, pointer-events:none, described-by
//     the trigger. Replaces the CSS-only Tooltip for rich content.
//   - interactive: `role="dialog"`, accepts pointer/focus input, dismisses on
//     Escape or an outside mousedown, and survives the trigger→popover gap.
//
// It never wraps its trigger: the caller passes `triggerRef` and the popover
// portals itself, so it cannot change the trigger's layout (the `tt-wrap`
// inline-flex wrapper was the source of the per-surface display/vertical-align
// hacks).
//
// Timing follows ContextOrb: a dwell before opening (a sweep across rows must
// not flash) and a grace period before closing (the pointer has to cross the
// gap between trigger and panel).

import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { useAnchorPosition, type AnchorAlign, type AnchorSide } from '../hooks/useAnchorPosition'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { usePopoverMotion } from '../utils/transitions'
import { markPortaledSurface, PANEL_SELECTOR } from '../theme'

export interface HoverPopoverProps {
  /** Element that owns the hover/focus trigger. */
  triggerRef: RefObject<HTMLElement | null>
  /** Preferred side. Default 'bottom'; flips when there is no room. */
  side?: AnchorSide
  /** Cross-axis alignment. Default 'center'. */
  align?: AnchorAlign
  /** Dwell before opening. Default 200ms. */
  delayMs?: number
  /** Grace before closing after the pointer/focus leaves. Default 150ms. */
  closeDelayMs?: number
  /** Accept pointer/keyboard input inside the popover. Default false. */
  interactive?: boolean
  /** Accessible name for the dialog variant. */
  ariaLabel?: string
  className?: string
  disabled?: boolean
  /** Close the open popover when this value changes. Consumers pass the
   *  selected-session / focus identity: a session switch can move or replace
   *  the trigger under a stationary pointer, and the browser emits no
   *  pointerleave for a DOM change. */
  closeKey?: unknown
  children: ReactNode
}

export function HoverPopover({
  triggerRef,
  side = 'bottom',
  align = 'center',
  delayMs = 200,
  closeDelayMs = 150,
  interactive = false,
  ariaLabel,
  className,
  disabled = false,
  closeKey,
  children,
}: HoverPopoverProps) {
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const disabledRef = useRef(disabled)
  const closeKeyRef = useRef(closeKey)
  // Whether the pending open came from keyboard focus. An interactive dialog
  // opened by Tab must receive focus; a pointer-opened one must not steal it.
  const openByFocus = useRef(false)
  useLayoutEffect(() => {
    openRef.current = open
  }, [open])
  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])
  // Render-phase adjustment: a popover disabled mid-hover must not stay on
  // screen, and re-enabling must not resurrect it without a fresh hover.
  if (disabled && open) setOpen(false)
  const bubbleId = useId()
  const { popover } = usePopoverMotion()
  const { ref, x, y, hidden, remeasure } = useAnchorPosition(triggerRef, {
    side,
    align,
    clampAfterFlip: true,
  })

  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const clearTimer = (timer: { current: number | null }) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  const close = useCallback(() => {
    clearTimer(openTimer)
    clearTimer(closeTimer)
    setOpen(false)
  }, [])
  const cancelClose = useCallback(() => clearTimer(closeTimer), [])
  const cancelOpen = useCallback(() => clearTimer(openTimer), [])
  const armOpen = useCallback(() => {
    cancelClose()
    clearTimer(openTimer)
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      if (disabledRef.current) return
      setOpen(true)
    }, delayMs)
  }, [cancelClose, delayMs])
  const armClose = useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      // Keyboard focus inside the trigger or the dialog outranks a pointer
      // leave: moving the mouse away must not dismiss a panel being tabbed
      // through.
      const active = document.activeElement
      if (active !== null && (ref.current?.contains(active) || triggerRef.current?.contains(active))) return
      setOpen(false)
    }, closeDelayMs)
  }, [closeDelayMs, cancelClose, ref, triggerRef])

  // A selection change closes an open card even when no pointer event fires
  // (keyboard session switch, a reordered strip under a stationary pointer).
  useLayoutEffect(() => {
    if (closeKeyRef.current === closeKey) return
    closeKeyRef.current = closeKey
    close()
  }, [closeKey, close])

  // Trigger listeners. Pointer and focus share the same dwell/grace: a
  // pointer sweep cancels the pending open, and focus gives keyboard users the
  // same reveal.
  useLayoutEffect(() => {
    if (disabled) return
    const trigger = triggerRef.current
    if (!trigger) return
    const onEnter = () => {
      openByFocus.current = false
      cancelClose()
      armOpen()
    }
    const onLeave = () => {
      cancelOpen()
      if (openRef.current) armClose()
    }
    const onFocusIn = () => {
      openByFocus.current = true
      cancelClose()
      armOpen()
    }
    const onFocusOut = (event: FocusEvent) => {
      cancelOpen()
      const next = event.relatedTarget as Node | null
      if (next && (trigger.contains(next) || ref.current?.contains(next))) return
      if (openRef.current) armClose()
    }
    trigger.addEventListener('pointerenter', onEnter)
    trigger.addEventListener('pointerleave', onLeave)
    trigger.addEventListener('focusin', onFocusIn)
    trigger.addEventListener('focusout', onFocusOut)
    return () => {
      trigger.removeEventListener('pointerenter', onEnter)
      trigger.removeEventListener('pointerleave', onLeave)
      trigger.removeEventListener('focusin', onFocusIn)
      trigger.removeEventListener('focusout', onFocusOut)
      clearTimer(openTimer)
      clearTimer(closeTimer)
    }
  }, [armClose, armOpen, cancelClose, cancelOpen, disabled, ref, triggerRef])

  // The portal mounts after `open` flips, so the hook's mount-time measure saw
  // no element. Measure and observe the surface once it exists: live content
  // (a session's status/error lines) can grow while the card is open, and the
  // viewport clamp must follow the new height.
  useLayoutEffect(() => {
    if (!open) return
    const el = ref.current
    if (el === null) return
    remeasure()
    const ro = new ResizeObserver(() => remeasure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, ref, remeasure])

  // A dialog opened by keyboard focus must receive focus; a pointer hover must
  // not steal it from the page.
  useLayoutEffect(() => {
    if (open && interactive && openByFocus.current) ref.current?.focus()
  }, [open, interactive, ref])

  // Interactive surfaces can hold focus and pointer; dismiss them like a menu.
  useOutsideMouseDown({ ref, onClose: close, triggerRef, active: open && interactive })
  useEscapeStack({
    active: open && interactive,
    onEscape: close,
    getContainer: () => ref.current,
  })

  // Passive surfaces describe their trigger. Preserve any pre-existing
  // description and restore it when the popover closes or unmounts.
  const previousDescribedBy = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (interactive) return
    const trigger = triggerRef.current
    if (!trigger) return
    if (open) {
      if (previousDescribedBy.current === null) {
        previousDescribedBy.current = trigger.getAttribute('aria-describedby')
      }
      trigger.setAttribute('aria-describedby', bubbleId)
      return
    }
    const previous = previousDescribedBy.current
    if (previous === null) trigger.removeAttribute('aria-describedby')
    else trigger.setAttribute('aria-describedby', previous)
  }, [bubbleId, interactive, open, triggerRef])

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (trigger === null || interactive) return
    return () => {
      const previous = previousDescribedBy.current
      if (previous === null) trigger.removeAttribute('aria-describedby')
      else trigger.setAttribute('aria-describedby', previous)
    }
  }, [interactive, triggerRef])

  // Stamp the portalled surface with its owning panel for the [data-portaled]
  // compensations (the portal breaks DOM ancestry).
  useLayoutEffect(() => {
    if (open && ref.current !== null) {
      markPortaledSurface(ref.current, triggerRef.current?.closest(PANEL_SELECTOR) ?? null)
    }
  }, [open, ref, triggerRef])

  if (!open) return null

  return createPortal(
    <motion.div
      ref={ref}
      id={bubbleId}
      className={`hover-pop${interactive ? ' hover-pop-interactive' : ''}${className ? ` ${className}` : ''}`}
      role={interactive ? 'dialog' : 'tooltip'}
      aria-label={interactive ? ariaLabel : undefined}
      tabIndex={interactive ? -1 : undefined}
      style={{
        left: x ?? undefined,
        top: y ?? undefined,
        visibility: hidden || x === null || y === null ? 'hidden' : undefined,
      }}
      initial={popover.initial}
      animate={popover.animate}
      onAnimationComplete={() => remeasure()}
      onPointerEnter={interactive ? cancelClose : undefined}
      onPointerLeave={interactive ? armClose : undefined}
      onFocus={interactive ? cancelClose : undefined}
      onBlur={interactive
        ? (event) => {
          const next = event.relatedTarget as Node | null
          if (next && (ref.current?.contains(next) || triggerRef.current?.contains(next))) return
          armClose()
        }
        : undefined}
    >
      {children}
    </motion.div>,
    document.body,
  )
}

/** Inline value pill for hover-card content: branch names, models, counts,
 *  hashes. The one styling home for emphasized values (the former `.tt-hl`). */
export function HoverValue({ children }: { children: ReactNode }) {
  return <span className="hover-pop-value">{children}</span>
}