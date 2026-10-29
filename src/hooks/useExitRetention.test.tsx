import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useExitRetention, EXIT_WINDOW_MS, STRIP_EXIT_WINDOW_MS } from './useExitRetention'
import { readCss } from '../styles/contrast-test-utils'

// The exit-retention primitive behind the nav strip's exit animations (tab
// dots, the working wash, the strip shell itself): when a value disappears,
// keep rendering it — flagged `exiting` — for one exit window so a CSS exit
// animation can play before the element unmounts. Under reduced motion the
// hold is skipped entirely (nothing animates, so nothing needs outliving).

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('passes a live value straight through', () => {
  const { result } = renderHook(() => useExitRetention('a'))
  expect(result.current).toEqual({ shown: 'a', exiting: false })
})

it('swaps to a new value immediately, without an exit beat', () => {
  const { result, rerender } = renderHook(({ v }: { v: string | null }) => useExitRetention(v), {
    initialProps: { v: 'a' as string | null },
  })
  rerender({ v: 'b' })
  expect(result.current).toEqual({ shown: 'b', exiting: false })
})

it('holds the last value as exiting when the value clears', () => {
  const { result, rerender } = renderHook(({ v }: { v: string | null }) => useExitRetention(v), {
    initialProps: { v: 'a' as string | null },
  })
  rerender({ v: null })
  expect(result.current).toEqual({ shown: 'a', exiting: true })
})

it('releases the held value after the hold window', () => {
  const { result, rerender } = renderHook(({ v }: { v: string | null }) => useExitRetention(v), {
    initialProps: { v: 'a' as string | null },
  })
  rerender({ v: null })
  act(() => {
    vi.advanceTimersByTime(120)
  })
  expect(result.current).toEqual({ shown: null, exiting: false })
})

it('honors a custom hold window', () => {
  const { result, rerender } = renderHook(({ v }: { v: string | null }) => useExitRetention(v, 50), {
    initialProps: { v: 'a' as string | null },
  })
  rerender({ v: null })
  act(() => {
    vi.advanceTimersByTime(49)
  })
  expect(result.current).toEqual({ shown: 'a', exiting: true })
  act(() => {
    vi.advanceTimersByTime(2)
  })
  expect(result.current).toEqual({ shown: null, exiting: false })
})

it('cancels the release when the value comes back during the hold', () => {
  const { result, rerender } = renderHook(({ v }: { v: string | null }) => useExitRetention(v), {
    initialProps: { v: 'a' as string | null },
  })
  rerender({ v: null })
  rerender({ v: 'b' })
  expect(result.current).toEqual({ shown: 'b', exiting: false })
  act(() => {
    vi.advanceTimersByTime(500)
  })
  expect(result.current).toEqual({ shown: 'b', exiting: false })
})

it('skips the hold entirely under reduced motion', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  const { result, rerender } = renderHook(({ v }: { v: string | null }) => useExitRetention(v), {
    initialProps: { v: 'a' as string | null },
  })
  rerender({ v: null })
  expect(result.current).toEqual({ shown: null, exiting: false })
})

it('arms no timer when nothing is held (the common idle mount)', () => {
  renderHook(() => useExitRetention(null))
  expect(vi.getTimerCount()).toBe(0)
})

it('arms the hold timer only once a value is actually retained', () => {
  const { rerender } = renderHook(({ v }: { v: string | null }) => useExitRetention(v), {
    initialProps: { v: 'a' as string | null },
  })
  expect(vi.getTimerCount()).toBe(0)
  rerender({ v: null })
  expect(vi.getTimerCount()).toBe(1)
})

it('exit windows match the tokens their CSS exits ride', () => {
  // JS/CSS mirror: the retained exits fade on their matching --motion-duration-*
  // token, so the holds must track those tokens or a retune silently unmounts
  // exits mid-fade. Loud coupling, same contract as the recap exit-collapse pins.
  const css = readCss('tokens.css')
  const fast = css.match(/--motion-duration-fast:\s*([^;]+);/g) ?? []
  expect(fast.length, '--motion-duration-fast missing from tokens.css').toBeGreaterThan(0)
  for (const decl of fast) expect(decl).toContain('120ms')
  expect(EXIT_WINDOW_MS).toBe(120)
  // The strip shell's exit runs at --motion-duration-moderate (the entrance /
  // sidebar-grid cadence), so its hold is the moderate window, not the default.
  const moderate = css.match(/--motion-duration-moderate:\s*([^;]+);/g) ?? []
  expect(moderate.length, '--motion-duration-moderate missing from tokens.css').toBeGreaterThan(0)
  for (const decl of moderate) expect(decl).toContain('240ms')
  expect(STRIP_EXIT_WINDOW_MS).toBe(240)
})
