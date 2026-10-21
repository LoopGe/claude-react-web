import { easeStandard } from './cubic-bezier'
import { prefersReducedMotion } from './reduced-motion'
import { revealDurationMs } from './reveal-duration'

/** Drive a collapsing/expanding grid track from rAF, writing WHOLE-PIXEL
 *  heights every frame.
 *
 *  A CSS `grid-template-rows: 0fr→1fr` animation (what `.grid-clip-reveal` and
 *  `tool-result-enter` used) resolves to a FRACTIONAL height every frame, so
 *  every glyph below the growing row is re-rasterized at a new sub-pixel phase
 *  — visible shimmer even though the layout positions themselves measure stable
 *  (a SubagentCard child row: clip slack ±0.5px, pin monotone, while the
 *  enclosing content height stepped 483.9 / 487.9 / 491.5 / 492.9 px). That is
 *  the mechanism aa7ea76e fixed inside AnimatedCollapse by rounding each frame
 *  of its height tween to whole CSS px; this is the same treatment for the
 *  reveal family, which is still CSS-driven.
 *
 *  Three things the removed keyframe gave for free, and how they are kept:
 *  - the row starts CLOSED (`from { grid-template-rows: 0fr }`). The track is
 *    collapsed synchronously here, before the first rAF, so no frame can paint
 *    the settled layout (callers run this from a layout effect, before paint).
 *  - the target is the item's natural BORDER-BOX height, measured with the
 *    track released — scrollHeight alone excludes the border.
 *  - the track re-resolved against the content every frame, so growth DURING
 *    the reveal was followed. The target is re-read each frame for the same
 *    reason; otherwise the strip past the initial target stays clipped for the
 *    rest of the tween and snaps to full height when the track clears.
 *
 *  Curve and duration are the ones the CSS declared: `--motion-ease-enter` is an
 *  alias of `--motion-ease-standard` (tokens.css, pinned by
 *  src/styles/reveal-curve-sync.test.ts), and `revealDurationMs()` is the same
 *  value the reveal class's fallback timer uses, so a token edit can't
 *  desynchronize the two. The inline track is CLEARED at the end so the CSS base
 *  `1fr` governs again — later content growth must not be constrained by a stale
 *  px value.
 *
 *  Returns a cancel function, idempotent and safe after completion; callers must
 *  run it on unmount or a row recycled mid-reveal keeps an inline track. */
export function tweenGridTrack(el: HTMLElement, inner: HTMLElement): () => void {
  // The preference is served by leaving the CSS base track (`1fr`) in place.
  if (prefersReducedMotion()) return () => {}

  const naturalScroll = inner.scrollHeight
  // offsetHeight is the border box; scrollHeight is content + padding only, so
  // `.tool-card-result-inner`'s `border-top: 1px` would otherwise be missing for
  // the whole reveal and snap in when the track clears. The difference is carried
  // so mid-reveal growth can be measured with scrollHeight alone.
  const measured = inner.offsetHeight || naturalScroll
  const borderDelta = Math.max(0, measured - naturalScroll)
  el.style.gridTemplateRows = '0px'
  if (measured <= 0) {
    el.style.gridTemplateRows = ''
    return () => {}
  }

  let target = measured
  const durationMs = revealDurationMs()
  const startedAt = performance.now()
  let raf = 0
  let timer = 0
  let done = false

  const finish = () => {
    if (done) return
    done = true
    window.cancelAnimationFrame(raf)
    window.clearTimeout(timer)
    el.style.gridTemplateRows = ''
  }

  const step = () => {
    if (done) return
    // Content can grow while the reveal plays (an image decoding, a line
    // wrapping); follow it rather than holding the height captured at the start.
    target = Math.max(target, inner.scrollHeight + borderDelta)
    const t = Math.min(1, (performance.now() - startedAt) / durationMs)
    el.style.gridTemplateRows = `${Math.max(0, Math.round(target * easeStandard(t)))}px`
    if (t < 1) raf = window.requestAnimationFrame(step)
    else finish()
  }
  raf = window.requestAnimationFrame(step)

  // Safety net for a stalled rAF clock — also what fake-timer tests ride on.
  timer = window.setTimeout(finish, durationMs + 120)

  return () => {
    if (done) return
    done = true
    window.cancelAnimationFrame(raf)
    window.clearTimeout(timer)
    el.style.gridTemplateRows = ''
  }
}