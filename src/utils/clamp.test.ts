import { describe, expect, it } from 'vitest'
import { clamp } from './clamp.js'

describe('clamp', () => {
  it('clamps below the minimum', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
  })

  it('clamps above the maximum', () => {
    expect(clamp(42, 0, 10)).toBe(10)
  })

  it('passes in-range values through', () => {
    expect(clamp(7, 0, 10)).toBe(7)
  })

  it('handles non-integer bounds', () => {
    expect(clamp(0.04, 0.05, 0.4)).toBe(0.05)
  })
})
