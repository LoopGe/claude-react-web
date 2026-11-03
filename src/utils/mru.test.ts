// Pure MRU primitives and synchronous storage helpers.
//
// This file runs in the Node environment (per `environmentMatchGlobs` in
// vitest.config.ts: `src/utils/**/*.test.ts` → node), so `typeof window ===
// 'undefined'` holds — the no-window behavior tests below exercise that path
// directly, without mocking.

import { describe, it, expect } from 'vitest'
import {
  normalizeStringArray,
  nextMru,
  readStringList,
  rememberStringListNow,
} from './mru'

// ── normalizeStringArray ───────────────────────────────────────────

describe('normalizeStringArray', () => {
  it('returns [] for non-array values', () => {
    // A non-array stored value (corrupt JSON parsed to an object, a bare
    // primitive, null) must collapse to an empty list — never throw, never
    // return a partial shape that downstream MRU logic can't iterate.
    expect(normalizeStringArray(null)).toEqual([])
    expect(normalizeStringArray(undefined)).toEqual([])
    expect(normalizeStringArray('not-an-array')).toEqual([])
    expect(normalizeStringArray({ a: 1 })).toEqual([])
    expect(normalizeStringArray(42)).toEqual([])
    expect(normalizeStringArray(true)).toEqual([])
  })

  it('filters non-strings out of a mixed array, preserving order', () => {
    // The salvaging path: a mixed-shape persisted list keeps its valid
    // string entries in their original positions. This is what makes
    // `normalize` (salvage) different from `validate` (discard whole).
    expect(normalizeStringArray(['a', 1, 'b', true, null, 'c'])).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('does not dedup', () => {
    // Dedup is `nextMru`'s job, not the normalizer's. A list with repeats
    // must pass through unchanged so the caller can decide what to do.
    expect(normalizeStringArray(['a', 'a', 'a'])).toEqual(['a', 'a', 'a'])
  })

  it('does not truncate', () => {
    // Cap enforcement is `nextMru`'s job. A long list passes through at
    // full length — the initial read must not silently drop entries.
    const big = Array.from({ length: 100 }, (_, i) => `s${i}`)
    expect(normalizeStringArray(big)).toHaveLength(100)
  })

  it('passes an all-string array through unchanged', () => {
    expect(normalizeStringArray(['x', 'y', 'z'])).toEqual(['x', 'y', 'z'])
  })

  it('returns [] for an empty array', () => {
    expect(normalizeStringArray([])).toEqual([])
  })
})

// ── nextMru ────────────────────────────────────────────────────────

describe('nextMru', () => {
  it('returns null for a blank raw string (no-op signal)', () => {
    // Blank input must NOT produce a list — the caller uses null to skip
    // the state update entirely. A `[]` return would clobber the list.
    expect(nextMru(['a'], '', 10)).toBeNull()
    expect(nextMru(['a'], '   ', 10)).toBeNull()
    expect(nextMru(['a'], '\t\n', 10)).toBeNull()
  })

  it('trims the remembered value before placing it at the front', () => {
    // Whitespace around a real value is noise; the stored entry is the
    // trimmed form, so a later exact-match dedup actually matches.
    expect(nextMru([], '  hello  ', 10)).toEqual(['hello'])
  })

  it('places the new value at the front (MRU order)', () => {
    expect(nextMru(['old'], 'new', 10)).toEqual(['new', 'old'])
  })

  it('moves an existing exact-match entry to the front', () => {
    // Re-selecting an existing entry promotes it rather than duplicating.
    expect(nextMru(['a', 'b', 'c'], 'b', 10)).toEqual(['b', 'a', 'c'])
  })

  it('does NOT dedup across case variations (exact case match only)', () => {
    // 'Apple' and 'apple' are distinct entries — the dedup is case-sensitive
    // so a model id's casing (which is significant) is preserved.
    expect(nextMru(['Apple'], 'apple', 10)).toEqual(['apple', 'Apple'])
  })

  it('caps the resulting list length', () => {
    // cap=3 with a 4-item prev: the tail is dropped after prepend+dedup.
    expect(nextMru(['a', 'b', 'c', 'd'], 'new', 3)).toEqual(['new', 'a', 'b'])
  })

  it('does not truncate when the result fits within cap', () => {
    expect(nextMru(['a', 'b'], 'c', 10)).toEqual(['c', 'a', 'b'])
  })

  it('normalizes a previous list containing non-strings as part of this remember', () => {
    // The old list is only organized (filtered) when a remember actually
    // happens — a mixed-type prev is cleaned here, not at read time, so
    // the initial list is not silently rewritten until the user acts.
    expect(nextMru(['a', 42, 'b', true], 'new', 10)).toEqual(['new', 'a', 'b'])
  })

  it('handles a non-array previous value as an empty list', () => {
    // A corrupt previous (null, object, etc.) is treated as [] — the
    // remember still succeeds with just the new value.
    expect(nextMru({ not: 'an array' }, 'new', 10)).toEqual(['new'])
    expect(nextMru(null, 'new', 10)).toEqual(['new'])
    expect(nextMru(undefined, 'new', 10)).toEqual(['new'])
  })

  it('dedups the exact value once when it appears multiple times in prev', () => {
    // All exact matches are removed, not just the first.
    expect(nextMru(['x', 'x', 'y'], 'x', 10)).toEqual(['x', 'y'])
  })
})

// ── readStringList (no window) ─────────────────────────────────────

describe('readStringList (no window)', () => {
  // These tests run in the Node environment where `typeof window ===
  // 'undefined'`. The primitive must return [] and never throw, so a caller
  // in SSR or a server-rendered path doesn't crash.

  it('returns [] when window is undefined', () => {
    expect(readStringList('any-key')).toEqual([])
  })

  it('does not throw', () => {
    expect(() => readStringList('any-key')).not.toThrow()
  })
})

// ── rememberStringListNow (no window) ──────────────────────────────

describe('rememberStringListNow (no window)', () => {
  it('returns the next list without writing to disk', () => {
    // No window: readStringList returns [], so nextMru computes ['value']
    // from an empty prev. The primitive returns it without attempting any
    // write — there is no localStorage to write to.
    expect(rememberStringListNow('any-key', 'value', 10)).toEqual(['value'])
  })

  it('returns null for a blank raw string', () => {
    expect(rememberStringListNow('any-key', '   ', 10)).toBeNull()
  })

  it('does not throw', () => {
    expect(() => rememberStringListNow('any-key', 'value', 10)).not.toThrow()
  })
})
