// Lightweight tooltip primitive. Replaces native `title=""` for elements
// where we want the hint to also be reachable by keyboard users
// (focus-visible) and to render in a styled bubble that matches the
// rest of the app instead of the OS-level grey box.
//
// Design notes:
//   - Pure CSS visibility (driven by :hover and :focus-within on the
//     wrapper). No JS state, no portals, no layout thrash. Acceptable
//     because our tooltips are short hints, not interactive popovers.
//   - The child receives an `aria-describedby` link to the bubble id so
//     screen readers announce the hint after the element's accessible
//     name (the rule `tooltip-keyboard` from UI/UX Pro Max).
//   - We wrap in <span> with `display: contents` so the wrapper does
//     not change the inline layout of the trigger. The tooltip itself
//     is positioned relative to a wrapping `.tt-wrap` span that pulls
//     `display: inline-flex` only when the child rendering needs it.
//   - `placement` controls which side the bubble appears on. Default
//     "top". Useful overrides: "bottom" for chips near the top of the
//     viewport, "right"/"left" for vertically dense lists.
//   - When `disabled` is true (no label, or caller wants to opt out),
//     the trigger is rendered as-is without a wrapper — useful for
//     conditional tooltips.

import { Children, cloneElement, isValidElement, useId } from 'react'
import type { ReactElement, ReactNode } from 'react'

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  /** Hint text. If empty/null, the tooltip is disabled and the child
   *  renders unchanged. */
  label?: ReactNode
  /** Side of the trigger to place the bubble on. Default "top". */
  placement?: TooltipPlacement
  /** Single trigger element. Must be a React element (not a string)
   *  because we forward `aria-describedby` to it. */
  children: ReactElement<{ 'aria-describedby'?: string }>
  /** Force-disable the tooltip without unmounting. */
  disabled?: boolean
}

export function Tooltip({ label, placement = 'top', children, disabled }: TooltipProps) {
  const id = useId()
  const child = Children.only(children)

  // Disabled / no label: render the child untouched. Keeping this
  // branch means callers can write `<Tooltip label={maybeStr}>...` and
  // not have to memoize the conditional themselves.
  if (disabled || !label) return child

  // Forward aria-describedby so AT users hear the hint after the
  // element's primary label. We only set it if the child doesn't
  // already have one — preserving caller intent.
  const describedChild =
    isValidElement(child) && !child.props['aria-describedby']
      ? cloneElement(child, { 'aria-describedby': id })
      : child

  return (
    <span className={`tt-wrap tt-${placement}`}>
      {describedChild}
      <span
        id={id}
        role="tooltip"
        className="tt-bubble"
        // Hidden from layout when not visible; CSS controls opacity
        // and pointer-events. `aria-hidden` flips with visibility on
        // focus/hover — handled in CSS via attribute selector.
      >
        {label}
      </span>
    </span>
  )
}
