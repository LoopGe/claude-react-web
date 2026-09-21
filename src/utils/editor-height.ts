/**
 * Grow a contenteditable to fit its content instead of scrolling it — until it
 * reaches `max-height`, at which point it must scroll instead of clipping.
 *
 * `scrollHeight` reports the content, but only while the height is `auto` —
 * hence the reset. That reset is also why the tween needs the extra write:
 * reading `scrollHeight` forces a style recalc, which commits `auto` as the
 * last computed value, and `auto` is not a length. A transition starting there
 * resolves BOTH endpoints against the post-change content (they coincide), so
 * the transition is created but never moves — the box still jumps. Re-stating
 * a px start and flushing makes the tween run from where the box actually is.
 *
 * Exported as a standalone module rather than a helper inside the component
 * for two reasons: the DOM test environment has no layout engine, so the
 * sequence of writes is the only observable part and it deserves its own
 * tests; and a component file that also exports a function opts out of React
 * Fast Refresh (react-refresh/only-export-components).
 */
export function syncEditorHeight(el: HTMLElement) {
  // Start from the RENDERED height, not `el.style.height`. That inline value
  // is the previous write's target, and `max-height` can leave it far above
  // the box: a 600px draft clamps to 180px, so a tween restarted from the
  // inline 600px would hold still for most of its duration and then snap.
  // The computed value is also the live mid-tween height, which is what keeps
  // fast typing from jumping when a tween is still in flight.
  const computed = getComputedStyle(el)
  const start = Number.parseFloat(computed.height)
  // The cap the box can never grow past. Read before the `height: auto` write
  // below, so the overflow decision uses the same value the layout does.
  const maxHeight = Number.parseFloat(computed.maxHeight)
  el.style.height = 'auto'
  const next = el.scrollHeight
  // Past `max-height` the content is unreachable by growing, so the box has to
  // become a real scroll container (`overflow-y: auto`). The base rule is
  // `overflow: hidden` — that hides the transient scrollbar while the box is
  // still growing — but left in place it clips the capped tail with no scroll
  // wheel, touch, or scrollbar to reach it. Keeping `hidden` whenever the
  // content fits means the mid-tween box never flashes a scrollbar either.
  const overflows = Number.isFinite(maxHeight) && next > maxHeight + 1
  const wantOverflow = overflows ? 'auto' : 'hidden'
  if (el.style.overflowY !== wantOverflow) el.style.overflowY = wantOverflow
  // No rendered height to tween from (first measure, or an element with no
  // layout box), or nothing to tween: the box is already the height its
  // content wants. Both land directly — and the second case is most
  // keystrokes, where the reflow below would be lining up a transition
  // between two identical lengths.
  if (!Number.isFinite(start) || Math.abs(start - next) < 1) {
    el.style.height = `${next}px`
    return
  }
  el.style.height = `${start}px`
  void el.offsetHeight // commit `start`, so the tween has a real beginning
  el.style.height = `${next}px`
}
