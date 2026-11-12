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
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { useFloatingSurface, FloatingSurfaceProvider } from '../hooks/useFloatingSurface'
import { useHoverAdmission } from '../hooks/useHoverAdmission'
import { isNodeInSurfaceBranch } from '../hooks/floating-surface-registry'
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
    // Closed hints mount by the hundred in dense lists; only the open one
    // should register scroll/resize observers.
    active: open,
  })

  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const { canOpen, armAttempt, cancelAttempt } = useHoverAdmission(triggerRef)
  const clearTimer = (timer: { current: number | null }) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  const close = useCallback(() => {
    clearTimer(openTimer)
    clearTimer(closeTimer)
    cancelAttempt()
    setOpen(false)
  }, [cancelAttempt])
  const { surfaceId } = useFloatingSurface({
    kind: interactive ? 'popover' : 'tooltip',
    active: open,
    phase: 'open',
    getContainer: () => ref.current,
    getTrigger: () => triggerRef.current,
    onDismiss: close,
    onEscape: interactive ? close : undefined,
  })
  const cancelClose = useCallback(() => clearTimer(closeTimer), [])
  const cancelOpen = useCallback(() => {
    clearTimer(openTimer)
    cancelAttempt()
  }, [cancelAttempt])
  const armOpen = useCallback(() => {
    cancelClose()
    cancelOpen()
    if (!canOpen()) return
    if (!armAttempt(() => clearTimer(openTimer))) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      cancelAttempt()
      if (disabledRef.current || !canOpen()) return
      setOpen(true)
    }, delayMs)
  }, [armAttempt, canOpen, cancelAttempt, cancelClose, cancelOpen, delayMs])
  const armClose = useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      // Keyboard focus inside the trigger or the dialog outranks a pointer
      // leave: moving the mouse away must not dismiss a panel being tabbed
      // through.
      const active = document.activeElement
      if (active !== null && (ref.current?.contains(active) || triggerRef.current?.contains(active) || isNodeInSurfaceBranch(surfaceId, active))) return
      setOpen(false)
    }, closeDelayMs)
  }, [closeDelayMs, cancelClose, ref, surfaceId, triggerRef])

  // A selection change closes an open card even when no pointer event fires
  // (keyboard session switch, a reordered strip under a stationary pointer).
  useLayoutEffect(() => {
    if (closeKeyRef.current === closeKey) return
    closeKeyRef.current = closeKey
    close()
  }, [closeKey, close])

  // Trigger listeners. Check the DOM node identity on every commit: a keyed
  // trigger replacement keeps the ref object but not its listeners.
  const listenerBindingRef = useRef<{
    trigger: HTMLElement | null
    armClose: typeof armClose
    armOpen: typeof armOpen
    cancelClose: typeof cancelClose
    cancelOpen: typeof cancelOpen
    disabled: boolean
    cleanup: () => void
  } | null>(null)
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const previous = listenerBindingRef.current
    if (previous
      && previous.trigger === trigger
      && previous.armClose === armClose
      && previous.armOpen === armOpen
      && previous.cancelClose === cancelClose
      && previous.cancelOpen === cancelOpen
      && previous.disabled === disabled) return
    previous?.cleanup()
    if (previous && previous.trigger !== trigger && openRef.current) remeasure()
    if (disabled || !trigger) {
      listenerBindingRef.current = { trigger, armClose, armOpen, cancelClose, cancelOpen, disabled, cleanup: () => {} }
      return
    }
    const onEnter = () => {
      openByFocus.current = false
      cancelClose()
      armOpen()
    }
    const onLeave = () => {
      if (openByFocus.current && trigger.contains(document.activeElement)) {
        if (openRef.current) armClose()
        return
      }
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
      if (next && (trigger.contains(next) || ref.current?.contains(next) || isNodeInSurfaceBranch(surfaceId, next))) return
      if (openRef.current) armClose()
    }
    trigger.addEventListener('pointerenter', onEnter)
    trigger.addEventListener('pointerleave', onLeave)
    trigger.addEventListener('focusin', onFocusIn)
    trigger.addEventListener('focusout', onFocusOut)
    listenerBindingRef.current = {
      trigger,
      armClose,
      armOpen,
      cancelClose,
      cancelOpen,
      disabled,
      cleanup: () => {
        trigger.removeEventListener('pointerenter', onEnter)
        trigger.removeEventListener('pointerleave', onLeave)
        trigger.removeEventListener('focusin', onFocusIn)
        trigger.removeEventListener('focusout', onFocusOut)
        cancelOpen()
        clearTimer(closeTimer)
      },
    }
  })
  useLayoutEffect(() => () => {
    listenerBindingRef.current?.cleanup()
    listenerBindingRef.current = null
  }, [])

  // The hook observes the surface while `active` (== open) and re-measures on
  // content growth; nothing to attach here.

  // A dialog opened by keyboard focus must receive focus; a pointer hover must
  // not steal it from the page.
  useLayoutEffect(() => {
    if (open && interactive && openByFocus.current) ref.current?.focus()
  }, [open, interactive, ref])

  // Interactive surfaces can hold focus and pointer; dismiss them like a menu.
  useOutsideMouseDown({ ref, onClose: close, triggerRef, surfaceId, active: open && interactive })

  // Primitive hint text is available to assistive technology before the visual
  // dwell without mounting a second copy of a rich hover tree. While the visual
  // tooltip is open, aria-describedby takes over so the text is not announced twice.
  const descriptionBindingRef = useRef<{ trigger: HTMLElement; ownedValue: string } | null>(null)
  const restoreAriaDescription = () => {
    const binding = descriptionBindingRef.current
    if (!binding) return
    if (binding.trigger.getAttribute('aria-description') === binding.ownedValue) {
      binding.trigger.removeAttribute('aria-description')
    }
    descriptionBindingRef.current = null
  }
  const hintDescription = typeof children === 'string' || typeof children === 'number' ? String(children) : null
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const binding = descriptionBindingRef.current
    if (binding && (binding.trigger !== trigger || open || interactive || disabled || hintDescription === null)) {
      restoreAriaDescription()
    } else if (binding && trigger && hintDescription !== null) {
      if (trigger.getAttribute('aria-description') !== binding.ownedValue) {
        // The caller replaced the attribute; do not reclaim it on a later
        // open, close, rerender, or unmount.
        descriptionBindingRef.current = null
        return
      }
      if (binding.ownedValue !== hintDescription) {
        trigger.setAttribute('aria-description', hintDescription)
        binding.ownedValue = hintDescription
      }
      return
    }
    if (trigger && !open && !interactive && !disabled && hintDescription !== null
      && !descriptionBindingRef.current && trigger.getAttribute('aria-description') === null) {
      trigger.setAttribute('aria-description', hintDescription)
      descriptionBindingRef.current = { trigger, ownedValue: hintDescription }
    }
  })

  // Preserve other descriptions and add/remove only this popover's bubble id,
  // including after DOM replacement.
  const removeBubbleDescription = (trigger: HTMLElement, bubbleId: string) => {
    const current = trigger.getAttribute('aria-describedby')
    if (current === null) return
    const remaining = current.split(/\s+/).filter((id) => id !== bubbleId).join(' ')
    if (remaining) trigger.setAttribute('aria-describedby', remaining)
    else trigger.removeAttribute('aria-describedby')
  }
  useLayoutEffect(() => {
    if (interactive) return
    const trigger = triggerRef.current
    if (!trigger) return
    if (open && !disabled) {
      const base = (trigger.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((id) => id !== bubbleId)
        .join(' ')
      trigger.setAttribute('aria-describedby', base ? `${base} ${bubbleId}` : bubbleId)
      return
    }
    removeBubbleDescription(trigger, bubbleId)
  })

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    return () => {
      restoreAriaDescription()
      if (trigger !== null && !interactive) removeBubbleDescription(trigger, bubbleId)
    }
    // A new ref wrapper each render must not reset attribute ownership; the
    // registration effect above handles actual trigger-node replacement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubbleId, interactive])

  // Stamp the portalled surface with its owning panel for the [data-portaled]
  // compensations (the portal breaks DOM ancestry).
  useLayoutEffect(() => {
    if (open && ref.current !== null) {
      markPortaledSurface(ref.current, triggerRef.current?.closest(PANEL_SELECTOR) ?? null)
    }
  }, [open, ref, triggerRef])

  if (!open) return null

  return (
    <FloatingSurfaceProvider surfaceId={surfaceId}>
      {createPortal(
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
          if (next && (ref.current?.contains(next) || triggerRef.current?.contains(next) || isNodeInSurfaceBranch(surfaceId, next))) return
          armClose()
        }
        : undefined}
    >
      {children}
    </motion.div>,
      document.body,
      )}
    </FloatingSurfaceProvider>
  )
}

/** Inline value pill for hover-card content: branch names, models, counts,
 *  hashes. The one styling home for emphasized values (the former `.tt-hl`). */
export function HoverValue({ children }: { children: ReactNode }) {
  return <span className="hover-pop-value">{children}</span>
}