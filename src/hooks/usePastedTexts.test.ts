import { describe, it, expect, vi } from 'vitest'
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

describe('usePastedTexts draft restore', () => {
  it('expands references restored from a draft', () => {
    const { result } = renderHook(() =>
      usePastedTexts({ 4: { id: 4, content: 'restored body' } }),
    )
    expect(result.current.expand('[Pasted text #4 +1 lines]')).toBe('restored body')
  })

  it('allocates new ids past the restored ones', () => {
    // Reusing a restored id would make an existing reference in the composer
    // resolve to whatever is pasted next.
    const onBodiesChange = vi.fn()
    const { result } = renderHook(() =>
      usePastedTexts({ 4: { id: 4, content: 'old body' } }, onBodiesChange),
    )
    let id = 0
    act(() => {
      id = result.current.add('new body')
    })
    expect(id).toBe(5)
    expect(result.current.expand('[Pasted text #4]')).toBe('old body')
    expect(result.current.expand(`[Pasted text #${id}]`)).toBe('new body')
  })

  it('reports the whole map whenever a body is added', () => {
    const onBodiesChange = vi.fn()
    const { result } = renderHook(() => usePastedTexts({}, onBodiesChange))
    act(() => {
      result.current.add('body')
    })
    expect(onBodiesChange).toHaveBeenCalledWith({ 1: { id: 1, content: 'body' } })
  })
})
