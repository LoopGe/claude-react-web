/**
 * Height target for the resource preview modal body
 * (`.resource-modal-body`), consumed by `useAutoHeightTransition`'s
 * `measureTargetHeight`.
 *
 * The body is the card's flexible remainder: when the content is short the
 * card is content-sized and the body's height IS the content height; when the
 * content is tall the card is capped by its own
 * `max-height: min(86vh, 760px)` (resource-modal.css) and the body sits at
 * that ceiling minus the header. So the target is
 * `min(content.scrollHeight + bodyPadding, ceiling)` — the value
 * `clearInlineHeight` must agree with, or the end of every height tween snaps
 * the box (the jump class settings-panel-measure documents).
 *
 * Unlike the settings panel, the cap lives on the CARD itself, so the ceiling
 * is plain arithmetic — no offsetParent promotion to walk:
 *
 *   ceiling = cardMaxHeight − cardBorders − headerHeight
 *
 * `cardMaxHeight` is read from computed style, which resolves the
 * `min(86vh, 760px)` to a used px value. The body's natural border-box height
 * adds its own vertical padding to the content wrapper's scrollHeight.
 */
export function measureResourceModalBodyHeight(
  body: HTMLElement,
  content: HTMLElement,
  header: HTMLElement,
): number {
  const card = body.closest('.resource-modal') as HTMLElement | null
  if (!card) {
    // The DOM contract (ResourceModal renders Overlay > .resource-modal card >
    // header + body > content) holds for the only caller — a silent fallback
    // would mask a contract break as an uncapped tween target.
    throw new Error('measureResourceModalBodyHeight: body is not inside a .resource-modal card')
  }
  const cardStyle = window.getComputedStyle(card)
  const cap = parseFloat(cardStyle.maxHeight)
  const cardBorders = parseFloat(cardStyle.borderTopWidth) + parseFloat(cardStyle.borderBottomWidth)
  const available = Math.max(0, cap - cardBorders - header.offsetHeight)
  const bodyStyle = window.getComputedStyle(body)
  const bodyPadding = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom)
  // The content wrapper is flex-fill (`flex: 1 1 auto; min-height: 0`) so the
  // five resource kinds keep their INNER scrollers (the code pre / markdown
  // container scroll, not the body). A flex-fill wrapper clamps to the body's
  // current height — which captureHeight has pinned at the OLD height — so its
  // scrollHeight tracks the pin, not the new content, and the tween would
  // degenerate to a snap. Flip it content-sized for the read so its children
  // expand to their natural height and scrollHeight reports the truth, then
  // restore. Synchronous (no paint between flip and restore); the settings
  // precedent avoids this only because its wrapper is permanently content-sized
  // and its BODY scrolls — a shape that would move this modal's scrolling off
  // the inner elements that carry the overlay scrollbars.
  const previousFlex = content.style.flex
  content.style.flex = '0 0 auto'
  const naturalHeight = content.scrollHeight
  content.style.flex = previousFlex
  const contentHeight = naturalHeight + bodyPadding
  return Math.min(contentHeight, available)
}