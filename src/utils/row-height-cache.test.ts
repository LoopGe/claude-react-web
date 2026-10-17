import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordRowHeight,
  lookupRowHeight,
  clearRowHeightCache,
  rowHeightCacheSize,
} from './row-height-cache'

describe('row-height-cache', () => {
  beforeEach(() => {
    clearRowHeightCache()
  })

  it('records and looks up a measured height', () => {
    expect(lookupRowHeight('m1')).toBeUndefined()
    recordRowHeight('m1', 123)
    expect(lookupRowHeight('m1')).toBe(123)
  })

  it('rounds to whole pixels', () => {
    recordRowHeight('m1', 122.6)
    expect(lookupRowHeight('m1')).toBe(123)
    recordRowHeight('m2', 122.4)
    expect(lookupRowHeight('m2')).toBe(122)
  })

  it('overwrites an existing id (rows resize while mounted)', () => {
    recordRowHeight('m1', 100)
    recordRowHeight('m1', 250)
    expect(lookupRowHeight('m1')).toBe(250)
    expect(rowHeightCacheSize()).toBe(1)
  })

  it('rejects non-finite and non-positive heights (jsdom/gated DOM reads)', () => {
    recordRowHeight('bad1', 0)
    recordRowHeight('bad2', -10)
    recordRowHeight('bad3', Number.NaN)
    recordRowHeight('bad4', Number.POSITIVE_INFINITY)
    expect(rowHeightCacheSize()).toBe(0)
  })

  it('evicts the oldest entry at the cap', () => {
    // CAP is 20_000 — fill it, then push one more and verify FIFO eviction.
    for (let i = 0; i < 20_000; i++) recordRowHeight(`id-${i}`, i + 1)
    expect(rowHeightCacheSize()).toBe(20_000)
    expect(lookupRowHeight('id-0')).toBe(1)
    recordRowHeight('overflow', 1)
    expect(rowHeightCacheSize()).toBe(20_000)
    expect(lookupRowHeight('id-0')).toBeUndefined()
    expect(lookupRowHeight('id-1')).toBe(2)
    expect(lookupRowHeight('overflow')).toBe(1)
  })

  it('re-recording an existing id at the cap does not evict', () => {
    for (let i = 0; i < 20_000; i++) recordRowHeight(`id-${i}`, i + 1)
    recordRowHeight('id-5000', 999) // already cached — no eviction
    expect(rowHeightCacheSize()).toBe(20_000)
    expect(lookupRowHeight('id-0')).toBe(1)
    expect(lookupRowHeight('id-5000')).toBe(999)
  })
})
