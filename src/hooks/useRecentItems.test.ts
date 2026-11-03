// Adapter tests for useRecentItems / useRecentCwds / useRecentModels.
//
// Runs in happy-dom (per `environmentMatchGlobs`: `src/**` → happy-dom after
// the node overrides), so `window` and `localStorage` are available.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecentItems, useRecentCwds, useRecentModels } from './useRecentItems'
import { removeLocalStorageKey } from './useLocalStorage'
import {
  RECENT_CWDS_KEY,
  RECENT_CWDS_CAP_KEY,
  RECENT_MODELS_KEY,
} from '../constants/recentKeys'

beforeEach(() => {
  localStorage.clear()
})

describe('useRecentItems', () => {
  it('rememberNow reads the latest disk and writes synchronously', () => {
    // Render with empty disk → React state holds [].
    const { result } = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )
    expect(result.current.recents).toEqual([])

    // External write to disk AFTER mount. We do NOT dispatch a storage
    // event, so React state stays stale at []. rememberNow must read the
    // FRESH disk value (['external']), not the stale React state.
    localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(['external']))

    // The synchronous primitive writes before rememberNow returns.
    act(() => result.current.rememberNow('new'))

    // Disk was updated synchronously inside rememberNow, stacking 'new'
    // on top of the externally-written ['external'].
    expect(JSON.parse(localStorage.getItem(RECENT_CWDS_KEY)!)).toEqual([
      'new',
      'external',
    ])
    expect(result.current.recents).toEqual(['new', 'external'])
  })

  it('two consecutive rememberNow calls preserve both writes', () => {
    // The first rememberNow writes to disk synchronously; the second must
    // read that fresh disk (not a stale React state that hasn't flushed
    // yet between the two calls) and stack on top of it.
    const { result } = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )

    act(() => result.current.rememberNow('first'))
    // Disk immediately reflects the first write — before the second call.
    expect(JSON.parse(localStorage.getItem(RECENT_CWDS_KEY)!)).toEqual([
      'first',
    ])

    act(() => result.current.rememberNow('second'))
    // The second call read ['first'] from disk and prepended 'second'.
    expect(JSON.parse(localStorage.getItem(RECENT_CWDS_KEY)!)).toEqual([
      'second',
      'first',
    ])
    expect(result.current.recents).toEqual(['second', 'first'])
  })

  it('normalizes corrupt and mixed stored lists consistently', () => {
    // Corrupt JSON at mount → [] (JSON.parse throws inside useLocalStorage,
    // caught → returns initial []). The adapter's normalize option is NOT
    // what catches this — the JSON parse failure does. The point is that
    // the adapter surfaces [] for corrupt data, not a throw or a bad shape.
    localStorage.setItem(RECENT_CWDS_KEY, '{not json')
    const { result: r1, unmount: unmount1 } = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )
    expect(r1.current.recents).toEqual([])

    // A remember on a corrupt-initialized adapter: prev (React state) is
    // [], so next is ['new']. The normalize semantics apply on the update
    // path too — a non-string in the functional-update prev would be
    // filtered, but here prev is already [].
    act(() => r1.current.remember('new'))
    expect(r1.current.recents).toEqual(['new'])
    expect(JSON.parse(localStorage.getItem(RECENT_CWDS_KEY)!)).toEqual([
      'new',
    ])

    // Now put a MIXED array on disk and re-mount to test the read boundary.
    // The adapter's `normalize: normalizeStringArray` option must filter
    // non-strings at the initial read, salvaging the valid entries instead
    // of discarding the whole list (which a `validate` guard would do).
    unmount1()
    localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(['a', 42, 'b', true]))
    const { result: r2 } = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )
    expect(r2.current.recents).toEqual(['a', 'b'])

    // rememberNow reads the fresh disk value (normalized) and stacks on
    // top. This proves the disk-read path (readStringList → normalize) uses
    // the SAME semantics as the React-state read path (useLocalStorage
    // normalize option).
    act(() => r2.current.rememberNow('c'))
    expect(JSON.parse(localStorage.getItem(RECENT_CWDS_KEY)!)).toEqual([
      'c',
      'a',
      'b',
    ])
    expect(r2.current.recents).toEqual(['c', 'a', 'b'])
  })

  it('synchronizes remember, rememberNow, forget, and external deletion between instances', () => {
    // Two independent adapter instances on the same key — all mutations
    // on one must converge on the other via useLocalStorage's same-tab
    // echo, and an external delete must reset both without re-persisting
    // (no notification loop).
    const a = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )
    const b = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )

    // remember on A propagates to B via same-tab echo.
    act(() => a.result.current.remember('a-value'))
    expect(a.result.current.recents).toEqual(['a-value'])
    expect(b.result.current.recents).toEqual(['a-value'])

    // rememberNow on A: writes synchronously, then state echo reaches B.
    act(() => a.result.current.rememberNow('b-value'))
    expect(a.result.current.recents).toEqual(['b-value', 'a-value'])
    expect(b.result.current.recents).toEqual(['b-value', 'a-value'])

    // forget on A propagates to B.
    act(() => a.result.current.forget('a-value'))
    expect(a.result.current.recents).toEqual(['b-value'])
    expect(b.result.current.recents).toEqual(['b-value'])

    // External deletion resets both instances to [] without re-persisting
    // through the echo (the suppression set prevents the reset from writing
    // '[]' back). The spy is set up AFTER the forget write's effect has
    // flushed so only the delete path is observed.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    act(() => removeLocalStorageKey(RECENT_CWDS_KEY))
    expect(a.result.current.recents).toEqual([])
    expect(b.result.current.recents).toEqual([])
    expect(localStorage.getItem(RECENT_CWDS_KEY)).toBeNull()
    expect(setItemSpy).not.toHaveBeenCalled()
    setItemSpy.mockRestore()
  })

  it('clamps cap to 3 and 50 and only truncates on remember', () => {
    // Seed an old list of 10 items. The initial read must NOT truncate it,
    // even when the cap is clamped down — the cap only bites on remember.
    const ten = Array.from({ length: 10 }, (_, i) => `old-${i}`)

    // cap key = 0 → clamped to MIN_CAP (3).
    localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(ten))
    localStorage.setItem(RECENT_CWDS_CAP_KEY, JSON.stringify(0))
    const { result: cap3 } = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )
    // Initial read: 10 items, untruncated. Lowering the cap does not
    // silently drop existing entries.
    expect(cap3.current.recents).toHaveLength(10)

    // remember truncates to ≤3: ['new', 'old-0', 'old-1'].
    act(() => cap3.current.remember('new'))
    expect(cap3.current.recents).toHaveLength(3)
    expect(cap3.current.recents[0]).toBe('new')

    // cap key = 999 → clamped to MAX_CAP (50). 10 items fit, so remember
    // grows the list to 11 (still ≤50).
    localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(ten))
    localStorage.setItem(RECENT_CWDS_CAP_KEY, JSON.stringify(999))
    const { result: cap50 } = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )
    expect(cap50.current.recents).toHaveLength(10)

    act(() => cap50.current.remember('new'))
    expect(cap50.current.recents).toHaveLength(11)
    expect(cap50.current.recents[0]).toBe('new')
  })

  it('remember is a no-op for a blank raw string', () => {
    const { result } = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )
    // The initial mount persists [] (useLocalStorage's first effect), so
    // disk already holds '[]' before the no-op. The point of this test is
    // that blank remember does NOT add a '   ' entry — the list and disk
    // stay at [] (the empty initial), not ['   '].
    act(() => result.current.remember('   '))
    expect(result.current.recents).toEqual([])
    expect(JSON.parse(localStorage.getItem(RECENT_CWDS_KEY)!)).toEqual([])
  })

  it('rememberNow is a no-op for a blank raw string', () => {
    // Seed disk so we can confirm the blank no-op does NOT overwrite it.
    localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(['existing']))
    const { result } = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )
    act(() => result.current.rememberNow('   '))
    expect(result.current.recents).toEqual(['existing'])
    expect(JSON.parse(localStorage.getItem(RECENT_CWDS_KEY)!)).toEqual([
      'existing',
    ])
  })

  it('forget removes an exact match and leaves the rest in order', () => {
    localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(['a', 'b', 'c']))
    const { result } = renderHook(() =>
      useRecentItems(RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, 10),
    )
    act(() => result.current.forget('b'))
    expect(result.current.recents).toEqual(['a', 'c'])
  })
})

describe('useRecentCwds / useRecentModels', () => {
  it('useRecentCwds binds the CWD key and cap', () => {
    const { result } = renderHook(() => useRecentCwds())
    act(() => result.current.rememberNow('/path/to/cwd'))
    expect(JSON.parse(localStorage.getItem(RECENT_CWDS_KEY)!)).toEqual([
      '/path/to/cwd',
    ])
  })

  it('useRecentModels binds the models key and cap', () => {
    const { result } = renderHook(() => useRecentModels())
    act(() => result.current.rememberNow('claude-sonnet-4'))
    expect(JSON.parse(localStorage.getItem(RECENT_MODELS_KEY)!)).toEqual([
      'claude-sonnet-4',
    ])
  })
})
