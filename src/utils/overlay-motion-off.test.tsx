import { afterEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useOverlayMotion, usePopoverMotion } from './transitions'
import { setAppMotionOff } from './reduced-motion'

afterEach(() => setAppMotionOff(false))

// ConfirmDialog / PromptDialog are the only dialogs on Overlay's motion mode,
// and every popover/menu uses usePopoverMotion — both pass numeric durations
// that the CSS token write cannot reach. The app-level Off preset must snap
// them through the motion gate.
describe('motion hooks honour the in-app Off preset', () => {
  it('overlay backdrop and card transitions collapse to duration 0', () => {
    setAppMotionOff(true)
    const { result } = renderHook(() => useOverlayMotion())

    expect(result.current.backdrop.animate.transition).toEqual({ duration: 0 })
    expect(result.current.backdrop.exit.transition).toEqual({ duration: 0 })
    expect(result.current.card.animate.transition).toEqual({ duration: 0 })
    expect(result.current.card.exit.transition).toEqual({ duration: 0 })
  })

  it('popover transitions collapse to duration 0', () => {
    setAppMotionOff(true)
    const { result } = renderHook(() => usePopoverMotion())

    expect(result.current.popover.animate.transition).toEqual({ duration: 0 })
    expect(result.current.popover.exit.transition).toEqual({ duration: 0 })
  })

  it('returns the normal durations once the preset is not Off', () => {
    const { result } = renderHook(() => useOverlayMotion())
    expect(result.current.card.animate.transition).toEqual({
      duration: 0.18,
      ease: [0.22, 1, 0.36, 1],
    })
  })
})
