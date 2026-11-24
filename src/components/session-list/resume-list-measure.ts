/**
 * Height target for the resume-session picker's list (`.palette-list`),
 * consumed by `useAutoHeightTransition`'s `measureTargetHeight`.
 *
 * The list is a flex:1 scroller inside `.modal-section`, inside a card capped
 * at 84vh (modal variant) or max-height:100% of the chat panel (panel variant),
 * AND it carries its own inline max-height:50vh. So its used height is
 * `min(content, 50vh, flex ceiling)` — in a short panel the flex ceiling binds
 * below 50vh. Capping the target only at 50vh would overshoot the ceiling, pin
 * the list past the card's space, and snap back when `clearInlineHeight`
 * releases — the jump class settings-panel-measure documents. The target is
 * `min(content, flex ceiling, 50vh)`.
 *
 * The ceiling MUST be pin-independent: the card is content-sized below its cap,
 * so a ceiling derived from the section's (or card's) current height collapses
 * to the list's pinned height during an in-flight tween, clamping a mid-tween
 * retarget to where the tween already is and settling short. It is therefore
 * computed from the card's CAP (a layout constant) minus the fixed chrome:
 *
 *   ceiling = cardMaxHeight − chrome
 *   chrome  = card borders/padding + header + footer + section padding
 *             + sibling rows (input, scope checkbox) + flex gaps + list margins
 *
 * `cardMaxHeight` resolves both variants: a vh/px max-height reads straight from
 * computed style; a percentage (the panel's 100%) does NOT resolve to px in
 * computed style, so it is resolved against the parent's content height. All
 * chrome terms are used values of fixed elements, immune to the enter-animation
 * transform and to the list's pin.
 *
 * The content wrapper is content-sized (the rows are fixed-height buttons the
 * list scrolls, not flex-fill children that shrink), so its scrollHeight reads
 * the natural content height even while the list's height is pinned mid-tween.
 */
export function measureResumeListHeight(list: HTMLElement, content: HTMLElement): number {
  const card = list.closest('.modal, .panel-overlay-card') as HTMLElement | null
  const section = list.parentElement
  if (!card || !section) {
    // The DOM contract (card > .modal-section > .palette-list) holds for the
    // only caller — a silent fallback would mask a contract break as an
    // uncapped tween target.
    throw new Error('measureResumeListHeight: list is not inside a modal/panel card section')
  }
  const cardStyle = window.getComputedStyle(card)
  const maxHeight = cardStyle.maxHeight
  const parent = card.parentElement
  const parentStyle = parent ? window.getComputedStyle(parent) : null
  const parentContentHeight =
    parent && parentStyle
      ? parent.clientHeight - parseFloat(parentStyle.paddingTop) - parseFloat(parentStyle.paddingBottom)
      : 0
  const cap = maxHeight.endsWith('%')
    ? (parentContentHeight * parseFloat(maxHeight)) / 100
    : parseFloat(maxHeight)
  const header = card.querySelector('.modal-header') as HTMLElement | null
  const footer = card.querySelector('.modal-footer') as HTMLElement | null
  const sectionStyle = window.getComputedStyle(section)
  const sectionPadding = parseFloat(sectionStyle.paddingTop) + parseFloat(sectionStyle.paddingBottom)
  const gap = parseFloat(sectionStyle.rowGap) || 0
  let siblings = 0
  for (const child of Array.from(section.children) as HTMLElement[]) {
    if (child === list) continue
    const childStyle = window.getComputedStyle(child)
    siblings +=
      child.offsetHeight + parseFloat(childStyle.marginTop) + parseFloat(childStyle.marginBottom)
  }
  const listStyle = window.getComputedStyle(list)
  const listMargin = parseFloat(listStyle.marginTop) + parseFloat(listStyle.marginBottom)
  const chrome =
    parseFloat(cardStyle.borderTopWidth) +
    parseFloat(cardStyle.borderBottomWidth) +
    parseFloat(cardStyle.paddingTop) +
    parseFloat(cardStyle.paddingBottom) +
    (header?.offsetHeight ?? 0) +
    (footer?.offsetHeight ?? 0) +
    sectionPadding +
    siblings +
    gap * (section.children.length - 1) +
    listMargin
  // A squeezed geometry is a real 0 ceiling — no falsy-zero fail-open to the
  // full content height (same rule as settings-panel-measure).
  const ceiling = Math.max(0, cap - chrome)
  const listCap = parseFloat(listStyle.maxHeight)
  const verticalPadding = parseFloat(listStyle.paddingTop) + parseFloat(listStyle.paddingBottom)
  const contentHeight = content.scrollHeight + verticalPadding
  return Math.min(contentHeight, ceiling, listCap)
}