import { describe, expect, it } from 'vitest'
import { snapToDevicePx } from './pixel-grid'

describe('snapToDevicePx', () => {
  it('rounds to whole CSS px at dpr=1 (the device grid IS the CSS grid)', () => {
    expect(snapToDevicePx(10, 1)).toBe(10)
    expect(snapToDevicePx(10.4, 1)).toBe(10)
    expect(snapToDevicePx(10.5, 1)).toBe(11)
    expect(snapToDevicePx(10.666666, 1)).toBe(11)
  })

  it('rounds to whole DEVICE px at dpr=1.5 (the 150% scaling case)', () => {
    // 15 device px exactly — nothing to round.
    expect(snapToDevicePx(10, 1.5)).toBe(10)
    // 15.6 device px → 16 device px = 10.666… CSS px.
    expect(snapToDevicePx(10.4, 1.5)).toBeCloseTo(16 / 1.5, 10)
    // 10.5 CSS px = 15.75 device px → 16 device px.
    expect(snapToDevicePx(10.5, 1.5)).toBeCloseTo(16 / 1.5, 10)
    // The quantization residual the old CSS-px rounding left on scroll writes
    // (measured live: write 13659 → the DOM held 20489/1.5).
    expect(snapToDevicePx(13659, 1.5)).toBeCloseTo(20489 / 1.5, 10)
  })

  it('always lands on the device grid at fractional dpr', () => {
    for (const dpr of [1.25, 1.5, 1.75, 2, 2.5]) {
      for (const v of [0, 0.1, 0.5, 1, 10.4, 55.333, 13659, 13659.333333]) {
        const snapped = snapToDevicePx(v, dpr)
        expect(Math.abs(snapped * dpr - Math.round(snapped * dpr))).toBeLessThan(1e-9)
      }
    }
  })

  it('never moves a value by more than half a device px', () => {
    for (const dpr of [1, 1.5, 2]) {
      for (const v of [0, 0.3, 7.9, 13659.333333]) {
        expect(Math.abs(snapToDevicePx(v, dpr) - v)).toBeLessThanOrEqual(0.5 / dpr + 1e-9)
      }
    }
  })
})
