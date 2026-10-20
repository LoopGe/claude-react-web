/**
 * Does this element have a box at all — is it actually being rendered?
 *
 * A box under a `display:none` ancestor (exactly what a keep-alive-cached panel
 * is: `.panel-slot-cached`) has none, so every metric read off it reports 0 —
 * and none of those zeros is a measurement. Both consumers of this rule pin a
 * height from such a read (a collapse body, a folded message body's overflow
 * verdict), and adopting the zero is what leaves a card header-only, or flips a
 * long message to "fits" and flashes it un-clamped, until something measures it
 * again.
 *
 * Deliberately NOT "its height is 0", and not "is it visible": a rendered box
 * that happens to be zero tall reports a real 0, and a `visibility: hidden` box
 * has real metrics — both must keep being measured.
 *
 * `checkVisibility` is this question exactly: it walks the ancestor chain and
 * ignores size and visibility (verified in the browser — a zero-height box and
 * a `visibility: hidden` box both answer true, a `display: none` ancestor
 * answers false). It sits behind a feature test only because it is younger than
 * browsers this app may run in; the fallback walks the display chain itself,
 * which is all the app's own hiding shape needs (`getComputedStyle` never
 * reports an ANCESTOR's display, so a per-node walk is the only way to see it).
 *
 * The fallback covers that shape and nothing more: it does not know about
 * `content-visibility`, about a shadow boundary (the walk stops at the
 * ShadowRoot), or about a detached box — none of which this app produces. Both
 * forms assume the element is not `display: contents`, which generates no box of
 * its own either.
 */
export function isRendered(el: HTMLElement): boolean {
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility
  if (typeof check === 'function') return check.call(el)
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false
  }
  return true
}