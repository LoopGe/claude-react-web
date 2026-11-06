// One-line hover hint built on HoverPopover: the call-site replacement for
// Tooltip where the hint does not need Tooltip's always-mounted bubble.
//
// It clones its single intrinsic child to attach an anchor ref, so the trigger
// keeps its own element and props and — unlike Tooltip — is NOT wrapped in a
// `.tt-wrap` span. The portalled popover therefore never participates in the
// parent's flex/grid layout and is never clipped by an ancestor's overflow.
//
// Rich/multi-line content uses HoverPopover directly; this wrapper is for the
// short string hints on chips and buttons.

import { cloneElement, useRef, type ReactElement, type ReactNode, type Ref } from 'react'
import { HoverPopover } from './HoverPopover'
import type { AnchorAlign, AnchorSide } from '../hooks/useAnchorPosition'

export interface HoverHintProps<T extends HTMLElement = HTMLElement> {
  label: ReactNode
  /** Single intrinsic element (button/span/…). Its own ref, if any, is
   *  overwritten by the anchor ref — do not pass a ref'd child. */
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
  return (
    <>
      {cloneElement(children, { ref })}
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