import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  motionSuppressed,
  osPrefersReducedMotion,
  setAppMotionOff,
  subscribeMotionSuppressed,
} from './reduced-motion.js'

afterEach(() => setAppMotionOff(false))

describe('app motion suppression', () => {
  it('is off by default', () => {
    expect(motionSuppressed()).toBe(false)
  })

  it('flips with setAppMotionOff', () => {
    setAppMotionOff(true)
    expect(motionSuppressed()).toBe(true)
    setAppMotionOff(false)
    expect(motionSuppressed()).toBe(false)
  })

  it('notifies subscribers on real changes only', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeMotionSuppressed(listener)

    setAppMotionOff(true)
    expect(listener).toHaveBeenCalledTimes(1)

    setAppMotionOff(true) // no-op
    expect(listener).toHaveBeenCalledTimes(1)

    setAppMotionOff(false)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    setAppMotionOff(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps the OS probe independent of the app setting', () => {
    // Node environment: no matchMedia, so the OS answer is false even while
    // the app-level suppression is on.
    setAppMotionOff(true)
    expect(osPrefersReducedMotion()).toBe(false)
    expect(motionSuppressed()).toBe(true)
  })
})
