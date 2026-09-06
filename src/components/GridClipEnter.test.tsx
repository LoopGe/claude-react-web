// Verifies GridClipEnter's one-shot reveal:
//
// • no clip when `entering` is false  — the Virtuoso scroll-back remount
//   case (parent's useEnterOnArrival gate is closed because the row is
//   already present at mount), so no replay flash on every scroll-through;
// • the `-entering` class appears on a genuine false→true transition AND on
//   a first render where `entering` is already true (parent armed the arrival
//   gate before the row mounted);
// • a plain re-render while `entering` stays true does not re-arm.
//
// The `animationend` strip is not asserted here: jsdom does not implement
// `window.AnimationEvent` (nor route `animationend` through React's delegated
// listener), so that path — identical to ToolResultSection's `onAnimationEnd`
// — is exercised in the real browser only. Its FALLBACK is asserted instead:
// the timeout clears the class even when no `animationend` ever fires (the
// prefers-reduced-motion case, where `animation: none` suppresses the event
// and the reveal-only `overflow:hidden` would otherwise persist and clip the
// contained button's focus ring).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { GridClipEnter } from './GridClipEnter'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('GridClipEnter', () => {
  it('no clip when entering is false', () => {
    const { container } = render(
      <GridClipEnter entering={false}><div className="child" /></GridClipEnter>,
    )
    expect(container.querySelector('.grid-clip-enter')!.className).not.toContain('grid-clip-entering')
    cleanup()
  })

  it('adds clip on a false→true transition', () => {
    const { container, rerender } = render(
      <GridClipEnter entering={false}><div /></GridClipEnter>,
    )
    rerender(<GridClipEnter entering={true}><div /></GridClipEnter>)
    expect(container.querySelector('.grid-clip-enter')!.className).toContain('grid-clip-entering')
    cleanup()
  })

  it('adds clip on first render when entering is already true', () => {
    const { container } = render(
      <GridClipEnter entering={true}><div /></GridClipEnter>,
    )
    expect(container.querySelector('.grid-clip-enter')!.className).toContain('grid-clip-entering')
    cleanup()
  })

  it('does not remove the clip on a re-render while entering stays true', () => {
    const { container, rerender } = render(
      <GridClipEnter entering={true}><div /></GridClipEnter>,
    )
    const el = container.querySelector('.grid-clip-enter')!
    rerender(<GridClipEnter entering={true}><span /></GridClipEnter>)
    expect(el.className).toContain('grid-clip-entering')
    cleanup()
  })

  it('renders children inside the inner clip wrapper', () => {
    const { container } = render(
      <GridClipEnter entering={false}><div className="child">x</div></GridClipEnter>,
    )
    expect(container.querySelector('.grid-clip-enter-inner .child')).toBeTruthy()
    cleanup()
  })

  it('fallback: clears the class by timeout when no animationend ever fires', () => {
    // jsdom never delivers the animationend, so only the timeout fallback can
    // strip the `-entering` class (and its reveal-only overflow clip) — the
    // reduced-motion / disabled-animation safety net.
    vi.useFakeTimers()
    const { container, rerender } = render(
      <GridClipEnter entering={false}><div className="child">x</div></GridClipEnter>,
    )
    act(() => {
      rerender(<GridClipEnter entering={true}><div className="child">x</div></GridClipEnter>)
    })
    const el = container.querySelector('.grid-clip-enter')!
    expect(el.className).toContain('grid-clip-entering')
    act(() => { vi.advanceTimersByTime(500) })
    expect(el.className).not.toContain('grid-clip-entering')
    cleanup()
  })
})