// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { applyAnimationSpeedToDocument } from './motion-preference-dom'
import { MOTION_DURATION_TOKENS } from '../../shared/animation-speed'

afterEach(() => {
  const root = document.documentElement
  delete root.dataset.motion
  for (const { token } of MOTION_DURATION_TOKENS) root.style.removeProperty(token)
})

describe('applyAnimationSpeedToDocument', () => {
  it('writes the scaled duration for every motion token', () => {
    applyAnimationSpeedToDocument('slow')
    for (const { token, baseMs } of MOTION_DURATION_TOKENS) {
      expect(document.documentElement.style.getPropertyValue(token), token).toBe(
        `${Math.round(baseMs * 1.5)}ms`,
      )
    }
    expect(document.documentElement.dataset.motion).toBeUndefined()
  })

  it('writes the near-zero sentinel and marks the document when Off', () => {
    applyAnimationSpeedToDocument('off')
    for (const { token } of MOTION_DURATION_TOKENS) {
      expect(document.documentElement.style.getPropertyValue(token), token).toBe('0.01ms')
    }
    expect(document.documentElement.dataset.motion).toBe('off')
  })

  it('clears the Off marker when switching back to a paced preset', () => {
    applyAnimationSpeedToDocument('off')
    applyAnimationSpeedToDocument('standard')
    expect(document.documentElement.dataset.motion).toBeUndefined()
  })
})
