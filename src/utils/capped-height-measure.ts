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
 * `card` is supplied by the caller (its class varies per surface). The cap is
 * resolved NON-INVASIVELY from the card's computed `max-height`: a px length (vh
 * and min(vh,px) already resolve to px) reads straight; a percentage or a
 * min()/max() containing one is resolved against the card parent's fixed content
 * height. Nothing about the box is mutated, so the measure cannot disturb the
 * hook's pin or let the box reflow to its natural height mid-tween (an earlier
 * empirical "force the box tall, read the card, restore" lift did exactly that —
 * restoring an auto box let it jump to full height before the tween pinned its
 * start, killing the loading→content animation, and mid-tween the lift animated
 * against the hook's height transition, collapsing the ceiling into an oscillation).
 *
 * `content` is a content-sized wrapper inside the box (its children are the rows /
 * form fields, not flex-fill children that shrink), so `content.scrollHeight` reads
 * the natural content height even while the box is pinned mid-tween. The box's own
 * `max-height` (e.g. a palette list's 50vh) is an additional sub-cap; `none` means
 * no sub-cap.
 */

/** Evaluate a CSS length expression whose percentages have already been
 *  substituted with px: a plain length, or min()/max()/clamp() of lengths. */
function evalLength(expr: string): number {
  const trimmed = expr.trim()
  const fn = trimmed.match(/^(min|max|clamp)\((.*)\)$/s)
  if (!fn) return parseFloat(trimmed)
  // Split top-level commas (depth-aware so nested functions survive).
  const args: string[] = []
  let depth = 0
  let current = ''
  for (const ch of fn[2]) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      args.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  args.push(current)
  const values = args.map(evalLength)
  if (fn[1] === 'min') return Math.min(...values)
  if (fn[1] === 'max') return Math.max(...values)
  // clamp(min, val, max)
  return Math.min(Math.max(values[1], values[0]), values[2])
}

/** The card's max-height cap in px, resolved against the parent's content height
 *  for percentage terms. `none` → no cap. Pin-independent: the parent (backdrop /
 *  panel overlay) has a fixed height, unlike the content-sized card itself. */
function resolveCardCap(card: HTMLElement): number {
  const raw = window.getComputedStyle(card).maxHeight
  if (raw === 'none') return Number.POSITIVE_INFINITY
  if (!raw.includes('%')) return parseFloat(raw)
  const parent = card.parentElement
  if (!parent) return parseFloat(raw)
  const parentStyle = window.getComputedStyle(parent)
  const parentContentHeight =
    parent.clientHeight - parseFloat(parentStyle.paddingTop) - parseFloat(parentStyle.paddingBottom)
  const substituted = raw.replace(/(-?[\d.]+)%/g, (_match, n: string) => {
    return `${(parentContentHeight * parseFloat(n)) / 100}px`
  })
  return evalLength(substituted)
}

export function measureCappedContentHeight(
  box: HTMLElement,
  content: HTMLElement,
  card: HTMLElement,
): number {
  const cap = resolveCardCap(card)

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