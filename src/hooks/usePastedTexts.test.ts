import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePastedTexts } from './usePastedTexts'

describe('usePastedTexts', () => {
  it('stores content under ids that increase from 1', () => {
    const { result } = renderHook(() => usePastedTexts())
    let first = 0
    let second = 0
    act(() => {
      first = result.current.add('first body')
      second = result.current.add('second body')
    })
    expect(first).toBe(1)
    expect(second).toBe(2)
    expect(result.current.expand(`[Pasted text #${first}]`)).toBe('first body')
    expect(result.current.expand(`[Pasted text #${second}]`)).toBe('second body')
  })

  it('expands using content added earlier in the same act', () => {
    // Mirrors the real write path: a paste stores its body and immediately
    // needs it expanded for the draft, before React re-renders.
    const { result } = renderHook(() => usePastedTexts())
    let expanded = ''
    act(() => {
      const id = result.current.add('the pasted body')
      expanded = result.current.expand(`[Pasted text #${id} +3 lines]`)
    })
    expect(expanded).toBe('the pasted body')
  })

  it('leaves an unresolvable reference verbatim', () => {
    const { result } = renderHook(() => usePastedTexts())
    expect(result.current.expand('a [Pasted text #7] b')).toBe('a [Pasted text #7] b')
  })

  // Regression guard for the orphan sweep that used to live in Chat: any edit
  // that made the reference stop matching — history browse, undo/redo, a
  // keystroke inside the token — permanently destroyed the body. A body has to
  // outlive the text that pointed at it.
  it('keeps a body while its reference is absent from the text', () => {
    const { result } = renderHook(() => usePastedTexts())
    let id = 0
    act(() => {
      id = result.current.add('the pasted body')
    })

    expect(result.current.expand('unrelated text')).toBe('unrelated text')

    expect(result.current.expand(`[Pasted text #${id}]`)).toBe('the pasted body')
  })

  it('keeps a body when the reference is mangled rather than deleted', () => {
    const { result } = renderHook(() => usePastedTexts())
    let id = 0
    act(() => {
      id = result.current.add('the pasted body')
    })

    // A stray keystroke inside the token — no longer a reference at all.
    expect(result.current.expand('[ Pasted text #1]')).toBe('[ Pasted text #1]')

    expect(result.current.expand(`[Pasted text #${id}]`)).toBe('the pasted body')
  })
})
