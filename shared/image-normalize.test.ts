import { describe, expect, it } from 'vitest'
import {
  NORMALIZED_IMAGE_MAX_BYTES,
  NORMALIZED_IMAGE_MAX_DIMENSION,
  NORMALIZED_IMAGE_MAX_PIXELS,
  NORMALIZED_IMAGE_QUALITIES,
  normalizedImageDimensions,
  requestImageDimensions,
} from './image-normalize'

describe('normalization constants', () => {
  it('matches the DSH policy', () => {
    expect(NORMALIZED_IMAGE_MAX_PIXELS).toBe(4_194_304)
    expect(NORMALIZED_IMAGE_MAX_DIMENSION).toBe(8192)
    expect(NORMALIZED_IMAGE_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(NORMALIZED_IMAGE_QUALITIES).toEqual([0.85, 0.75, 0.6])
  })
})

describe('requestImageDimensions', () => {
  it('leaves images inside the pixel budget unchanged', () => {
    expect(requestImageDimensions(1000, 1000, 4_194_304)).toEqual({ width: 1000, height: 1000 })
  })

  it('downscales proportionally and never exceeds the budget', () => {
    expect(requestImageDimensions(4000, 3000, 4_194_304)).toEqual({ width: 2364, height: 1773 })
  })

  it('rejects non-positive dimensions', () => {
    expect(() => requestImageDimensions(0, 10, 4_194_304)).toThrow(RangeError)
    expect(() => requestImageDimensions(10, 0, 4_194_304)).toThrow(RangeError)
  })
})

describe('normalizedImageDimensions', () => {
  it('applies the long-edge cap after the pixel budget', () => {
    // 10,000×500 is 5 MP: budgeting leaves 9157×458, then the 8192 cap applies.
    expect(normalizedImageDimensions(10_000, 500)).toEqual({ width: 8192, height: 409 })
  })

  it('keeps a panorama whose pixel count is inside the budget', () => {
    expect(normalizedImageDimensions(4000, 500)).toEqual({ width: 4000, height: 500 })
  })

  it('caps an extremely wide image at the long edge', () => {
    expect(normalizedImageDimensions(10_000, 1)).toEqual({ width: 8192, height: 1 })
  })
})