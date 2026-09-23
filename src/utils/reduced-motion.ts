/** Whether the user prefers reduced motion (prefers-reduced-motion: reduce).
 *  Pure, non-reactive probe — call it at the point of use. Components that
 *  need to REACT to changes should subscribe to the MediaQueryList themselves.
 *  Safe in non-DOM environments (returns false). */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  )
}
