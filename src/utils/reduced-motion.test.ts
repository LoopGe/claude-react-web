import { describe, expect, it } from 'vitest'
import { prefersReducedMotion } from './reduced-motion.js'

describe('prefersReducedMotion', () => {
  it('returns a boolean and does not throw in the test (jsdom) environment', () => {
    expect(typeof prefersReducedMotion()).toBe('boolean')
  })
})
