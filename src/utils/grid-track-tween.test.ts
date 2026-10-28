// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tweenGridTrack } from './grid-track-tween'

/** A reveal-shaped pair: grid wrapper + clipped inner, as GridClipEnter and
 *  ToolResultSection render them. */
function mount(trackHeight: number) {
  const el = document.createElement('div')
  const inner = document.createElement('div')
  el.appendChild(inner)
  document.body.appendChild(el)
  Object.defineProperty(inner, 'scrollHeight', { configurable: true, get: () => trackHeight })
  return { el, inner }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('tweenGridTrack', () => {
  it('writes whole-pixel track values on every frame', () => {
    const { el, inner } = mount(400)
    tweenGridTrack(el, inner)

    const seen: string[] = []
    for (let frame = 0; frame < 6; frame++) {
      vi.advanceTimersByTime(16)
      if (el.style.gridTemplateRows) seen.push(el.style.gridTemplateRows)
    }
    expect(seen.length).toBeGreaterThan(2)
    for (const v of seen) expect(v).toMatch(/^\d+px$/) // never a fraction — this is the whole point
  })

  it('writes DEVICE-pixel-aligned track values at fractional dpr', () => {
    // At dpr=1.5 a whole CSS px is 1.5 device px — NOT a whole device px, so
    // a CSS-px-rounded track re-phases the glyph raster of everything below
    // (the expand shimmer reported at 150% Windows scaling). The track must
    // land on the device grid: value × dpr is integral.
    vi.stubGlobal('devicePixelRatio', 1.5)
    const { el, inner } = mount(400)
    tweenGridTrack(el, inner)

    const seen: string[] = []
    for (let frame = 0; frame < 6; frame++) {
      vi.advanceTimersByTime(16)
      if (el.style.gridTemplateRows) seen.push(el.style.gridTemplateRows)
    }
    expect(seen.length).toBeGreaterThan(2)
    for (const v of seen) {
      const px = Number.parseFloat(v)
      expect(Math.abs(px * 1.5 - Math.round(px * 1.5))).toBeLessThan(1e-9)
    }
  })

  it('clears the inline track when it finishes (so later growth is unconstrained)', () => {
    const { el, inner } = mount(400)
    tweenGridTrack(el, inner)
    vi.advanceTimersByTime(400)
    expect(el.style.gridTemplateRows).toBe('')
  })

  it('reaches the measured height before clearing', () => {
    const { el, inner } = mount(240)
    tweenGridTrack(el, inner)
    vi.advanceTimersByTime(248)
    // the last written frame is the target (or already cleared on the very next tick)
    expect(el.style.gridTemplateRows === '' || el.style.gridTemplateRows === '240px').toBe(true)
  })

  it('cancel clears the track and stops writing', () => {
    const { el, inner } = mount(400)
    const cancel = tweenGridTrack(el, inner)
    vi.advanceTimersByTime(16)
    cancel()
    expect(el.style.gridTemplateRows).toBe('')
    vi.advanceTimersByTime(400)
    expect(el.style.gridTemplateRows).toBe('')
  })

  it('writes nothing under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    const { el, inner } = mount(400)
    tweenGridTrack(el, inner)
    vi.advanceTimersByTime(400)
    expect(el.style.gridTemplateRows).toBe('')
  })

  it('does nothing for a zero-height target', () => {
    const { el, inner } = mount(0)
    tweenGridTrack(el, inner)
    vi.advanceTimersByTime(400)
    expect(el.style.gridTemplateRows).toBe('')
  })

  it('collapses the track synchronously, before the first frame', () => {
    const { el, inner } = mount(400)
    tweenGridTrack(el, inner)
    // With the first write deferred to rAF, the element sits at the CSS base
    // `1fr` until that callback — and a frame that paints in between (the mount
    // commit landing inside a rendering batch, as react-virtuoso's measurement
    // renders do) shows the settled layout for one frame: content below jumps
    // down, then back up. The CSS keyframe collapsed from the first computed
    // style, so the tween must too.
    expect(el.style.gridTemplateRows).toBe('0px')
  })

  it('targets the inner border box, not scrollHeight (which excludes the border)', () => {
    const { el, inner } = mount(300)
    // .tool-card-result-inner carries border-top, so the natural box is taller
    // than scrollHeight: a scrollHeight-only target leaves the track short for
    // the whole reveal and snaps when it clears. (20px here so the assertion has
    // a margin the frame grid's rounding can't eat.)
    Object.defineProperty(inner, 'offsetHeight', { configurable: true, get: () => 320 })
    tweenGridTrack(el, inner)

    let maxWritten = 0
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(16)
      const v = Number.parseFloat(el.style.gridTemplateRows)
      if (Number.isFinite(v)) maxWritten = Math.max(maxWritten, v)
    }
    expect(maxWritten).toBeGreaterThan(310) // a scrollHeight-only target caps near 300
  })

  it('follows content that grows mid-reveal instead of clipping it', () => {
    let height = 200
    const el = document.createElement('div')
    const inner = document.createElement('div')
    el.appendChild(inner)
    document.body.appendChild(el)
    Object.defineProperty(inner, 'scrollHeight', { configurable: true, get: () => height })

    tweenGridTrack(el, inner)
    vi.advanceTimersByTime(120)
    height = 300 // e.g. an image block finishing its decode mid-reveal

    let maxWritten = 0
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(16)
      const v = Number.parseFloat(el.style.gridTemplateRows)
      if (Number.isFinite(v)) maxWritten = Math.max(maxWritten, v)
    }
    // A target captured once at the start leaves the grown strip clipped for the
    // rest of the tween and then snaps to full height when the track clears.
    expect(maxWritten).toBeGreaterThan(250)
  })
})