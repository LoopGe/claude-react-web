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
 *  Curve and duration are the ones the CSS declared: `--motion-ease-enter` is an
 *  alias of `--motion-ease-standard` (tokens.css, pinned by
 *  src/styles/reveal-curve-sync.test.ts), and `revealDurationMs()` is the same
 *  value the reveal class's fallback timer uses, so a token edit can't
 *  desynchronize the two. The row's natural height is the target, and the inline
 *  track is CLEARED at the end so the CSS base `1fr` governs again — content that
 *  grows during or after the reveal must not be constrained by a stale px value.
 *
 *  Returns a cancel function, idempotent and safe after completion; callers must
 *  run it on unmount or a row recycled mid-reveal keeps an inline track. */
export function tweenGridTrack(el: HTMLElement, inner: HTMLElement): () => void {
  // The preference is served by leaving the CSS base track (`1fr`) in place.
  if (prefersReducedMotion()) return () => {}
  const target = inner.scrollHeight
  if (target <= 0) return () => {}

  const durationMs = revealDurationMs()
  const startedAt = performance.now()
  let raf = 0
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
    const t = Math.min(1, (performance.now() - startedAt) / durationMs)
    el.style.gridTemplateRows = `${Math.max(0, Math.round(target * easeStandard(t)))}px`
    if (t < 1) raf = window.requestAnimationFrame(step)
    else finish()
  }
  raf = window.requestAnimationFrame(step)

  // Safety net for a stalled rAF clock — also what fake-timer tests ride on.
  const timer = window.setTimeout(finish, durationMs + 120)

  return () => {
    if (done) return
    done = true
    window.cancelAnimationFrame(raf)
    window.clearTimeout(timer)
    el.style.gridTemplateRows = ''
  }
}