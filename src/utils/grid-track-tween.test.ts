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
})