// One-line hover hint built on HoverPopover: the call-site replacement for
// Tooltip where the hint does not need Tooltip's always-mounted bubble.
//
// It clones its single intrinsic child to attach an anchor ref (merged with
// any ref the child already carries, so dnd-kit activators keep working), and
// — unlike Tooltip — the child is NOT wrapped in a `.tt-wrap` span. The
// portalled popover therefore never participates in the parent's flex/grid
// layout and is never clipped by an ancestor's overflow.
//
// Rich/multi-line content uses HoverPopover directly; this wrapper is for the
// short string hints on chips and buttons.

import { cloneElement, useRef, type ReactElement, type ReactNode, type Ref } from 'react'
import { HoverPopover } from './HoverPopover'
import { useMergedRef } from '../utils/mergedRef'
import type { AnchorAlign, AnchorSide } from '../hooks/useAnchorPosition'

export interface HoverHintProps<T extends HTMLElement = HTMLElement> {
  label: ReactNode
  /** Single intrinsic element (button/span/div/…). An existing ref is merged
   *  with the anchor ref, not overwritten. */
  children: ReactElement<{ ref?: Ref<T> }>
  side?: AnchorSide
  align?: AnchorAlign
  disabled?: boolean
  className?: string
}

export function HoverHint<T extends HTMLElement = HTMLElement>({
  label,
  children,
  side = 'top',
  align = 'center',
  disabled,
  className,
}: HoverHintProps<T>) {
  const ref = useRef<T>(null)
  const childRef = children.props.ref
  // Merge instead of overwrite: dnd-kit's activator ref must keep working.
  // useMergedRef owns the `.current` writes (module-level, stable callback).
  const mergedRef = useMergedRef(ref, childRef)
  // Disabled form controls are not pointer/focus event targets, so the card
  // can never open on them. Keep the native title as the fallback for exactly
  // that state — it is the behavior the old `title` attribute had, and it
  // keeps the "why is this disabled" explanation reachable.
  const childDisabled = (children.props as { disabled?: boolean }).disabled === true
  const fallbackTitle = childDisabled && typeof label === 'string' ? { title: label } : {}
  return (
    <>
      {cloneElement(children, { ...fallbackTitle, ref: mergedRef })}
      <HoverPopover
        triggerRef={ref}
        side={side}
        align={align}
        disabled={disabled}
        className={className}
      >
        {label}
      </HoverPopover>
    </>
  )
}