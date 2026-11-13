/** @vitest-environment jsdom */
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetFocusModalityForTests, isPointerFocusTask } from './focus-modality'

beforeEach(() => {
  vi.useFakeTimers()
  __resetFocusModalityForTests()
})

afterEach(() => vi.useRealTimers())

describe('pointer focus task', () => {
  it('lasts through the pointer event task only', () => {
    fireEvent.pointerDown(document.body, { button: 0 })
    expect(isPointerFocusTask()).toBe(true)
    vi.advanceTimersByTime(0)
    expect(isPointerFocusTask()).toBe(false)
  })

  it('covers compatibility focus after pointerup', () => {
    fireEvent.pointerUp(document.body, { button: 0 })
    expect(isPointerFocusTask()).toBe(true)
  })

  it('resets when keyboard input arrives', () => {
    fireEvent.pointerDown(document.body, { button: 0 })
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(isPointerFocusTask()).toBe(false)
  })
})
