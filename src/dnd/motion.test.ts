// Geometry pin for the drag-landing counter-translation. dnd-kit aligns the
// measured (SCALED) ghost box to the landing slot, so the landing's return to
// scale 1 must be paired with an exact opposite translate or the card lands
// ~2.5% of its width off and snaps when the ghost is discarded.
import { describe, expect, it } from 'vitest'
import { landingCounterTranslate } from './motion'

describe('landingCounterTranslate', () => {
  it('cancels exactly the centre-origin shrink shift', () => {
    const layout = 300
    const lift = 1.05
    const measured = layout * lift
    // The scaled box was aligned to the card, so shrinking to scale 1 about
    // its centre moves the visual left edge right by half the scale growth.
    expect(landingCounterTranslate(measured, lift)).toBeCloseTo(-(measured - layout) / 2)
  })

  it('is zero when the ghost is not lifted', () => {
    expect(landingCounterTranslate(400, 1)).toBeCloseTo(0)
  })
})
