/**
 * Generic pin-independent height target for an auto-sized, capped content box
 * (a palette list, a dialog body, a panel scroller) animated by
 * `useAutoHeightTransition`.
 *
 * The box lives inside a card with a `max-height` cap (84vh, min(480px,100%),
 * 100%, …). Its used height is `min(content, card ceiling, box's own max-height)`.
 * Capping the tween target only at the content height would overshoot the card
 * ceiling, pin the box past the card's space, and snap back when the hook
 * releases the pin — the jump class settings-panel-measure documents.
 *
 * The ceiling MUST be pin-independent. The card is content-sized below its cap,
 * so a ceiling read from the current height of the box (or any ancestor) collapses
 * to the pinned height during an in-flight tween, clamping a mid-tween retarget to
 * where the tween already is and settling short. It is therefore computed from the
 * card CAP (a layout constant) minus the FIXED chrome between the cap and the box:
 * the card borders, and — walking from the box up to the card — each ancestor's
 * padding, flex gaps, and non-ancestor children (siblings along the chain), plus
 * the box's own margins. Every term is a used value of a fixed element, immune to
 * the enter-animation transform and to the box's pin.
 *
 * `card` is supplied by the caller (its class varies per surface). The cap is read
 * EMPIRICALLY: computed style leaves percentage and min()/max() caps unresolved
 * (e.g. `min(480px, 100%)`), so instead the box is momentarily forced tall (its
 * height/flex/max-height lifted) so the card clamps at its true max-height, the
 * card's used height is read, and the box is restored — synchronous, no paint, and
 * independent of whatever cap expression the card uses. The observer watches the
 * content wrapper (not the box), so this lift fires no resize observation.
 *
 * `content` is a content-sized wrapper inside the box (its children are the rows /
 * form fields, not flex-fill children that shrink), so `content.scrollHeight` reads
 * the natural content height even while the box is pinned mid-tween. The box's own
 * `max-height` (e.g. a palette list's 50vh) is an additional sub-cap; `none` means
 * no sub-cap.
 */
export function measureCappedContentHeight(
  box: HTMLElement,
  content: HTMLElement,
  card: HTMLElement,
): number {
  const prevHeight = box.style.height
  const prevFlex = box.style.flex
  const prevMaxHeight = box.style.maxHeight
  const prevTransition = box.style.transition
  // Disable the box's height transition for the lift: mid-tween the hook has set
  // `transition: height …`, so a forced height would ANIMATE toward 100000px and
  // the card-height read below would catch the stale (pre-lift) height, collapsing
  // the ceiling — a one-shot oscillation on open. Snap the lift instead.
  box.style.transition = 'none'
  box.style.flex = '0 0 auto'
  box.style.maxHeight = 'none'
  box.style.height = '100000px'
  void card.offsetHeight
  const cap = card.offsetHeight
  box.style.height = prevHeight
  box.style.flex = prevFlex
  box.style.maxHeight = prevMaxHeight
  box.style.transition = prevTransition
  void card.offsetHeight

  const cardStyle = window.getComputedStyle(card)
  const outerHeight = (el: HTMLElement) => {
    const s = window.getComputedStyle(el)
    return el.offsetHeight + parseFloat(s.marginTop) + parseFloat(s.marginBottom)
  }
  const levelChrome = (level: HTMLElement, exclude: HTMLElement) => {
    const s = window.getComputedStyle(level)
    const padding = parseFloat(s.paddingTop) + parseFloat(s.paddingBottom)
    const gap = parseFloat(s.rowGap) || 0
    let siblings = 0
    let inFlow = 0
    for (const child of Array.from(level.children) as HTMLElement[]) {
      // Out-of-flow children (the overlay-scrollbar track appended to the card,
      // a nested absolute overlay) consume NO flex space, so they are not chrome
      // and do not participate in the flex gap. Counting them collapsed the
      // ceiling to ~0 whenever the scroller overflowed (the track's height equals
      // the box's). Skip them.
      const position = window.getComputedStyle(child).position
      if (position === 'absolute' || position === 'fixed') continue
      inFlow += 1
      if (child !== exclude) siblings += outerHeight(child)
    }
    return padding + gap * Math.max(0, inFlow - 1) + siblings
  }

  let chrome = parseFloat(cardStyle.borderTopWidth) + parseFloat(cardStyle.borderBottomWidth)
  let node = box
  while (node.parentElement && node.parentElement !== card) {
    chrome += levelChrome(node.parentElement, node)
    node = node.parentElement
  }
  // node is now a direct child of the card (or the box itself, for a flat card).
  chrome += levelChrome(card, node)
  const boxStyle = window.getComputedStyle(box)
  chrome += parseFloat(boxStyle.marginTop) + parseFloat(boxStyle.marginBottom)

  // A squeezed geometry is a real 0 ceiling — no falsy-zero fail-open to the full
  // content height (same rule as settings-panel-measure).
  const ceiling = Math.max(0, cap - chrome)
  const boxMaxHeight = boxStyle.maxHeight
  const subCap = boxMaxHeight === 'none' ? Number.POSITIVE_INFINITY : parseFloat(boxMaxHeight)
  const verticalPadding = parseFloat(boxStyle.paddingTop) + parseFloat(boxStyle.paddingBottom)
  const contentHeight = content.scrollHeight + verticalPadding
  // The box's own min-height floors the used height (e.g. a snippets list's
  // 120px): a target below it would diverge from the rendered box and give a
  // growth tween a dead zone. `auto`/keyword min-heights parse to NaN → no floor.
  const minHeight = parseFloat(boxStyle.minHeight)
  const floor = Number.isFinite(minHeight) ? minHeight : 0
  return Math.max(floor, Math.min(contentHeight, ceiling, subCap))
}