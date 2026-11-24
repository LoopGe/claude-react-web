// @vitest-environment happy-dom
// Height-animation wiring for the input history list. The cap math is unit-tested
// in capped-height-measure.test.ts; here the measure is mocked to controlled
// heights so the wiring (observer + key paths, pin release) is what's under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { InputHistoryPanel } from './InputHistoryPanel'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))
vi.mock('../hooks/useInputHistoryPanel', () => ({
  useInputHistoryPanel: () => ({
    sessionItems: [],
    otherItems: [{ id: '1', text: 'hello' }, { id: '2', text: 'world' }],
    flat: [{ id: '1', text: 'hello' }, { id: '2', text: 'world' }],
    totalCount: 2,
  }),
}))

beforeEach(() => {
  measureMock.mockReset()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  stubResizeObserver()
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
})

afterEach(() => {
  clearResizeObserverStub()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup() {
  render(<InputHistoryPanel open onClose={vi.fn()} onSelect={vi.fn()} currentSessionId={null} />)
}

describe('InputHistoryPanel height animation', () => {
  it('tweens the list height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const list = document.querySelector<HTMLElement>('.palette-list')!
    const content = document.querySelector<HTMLElement>('.palette-list-content')!
    height = 300
    fireResize(content)
    expect(list.classList.contains('auto-height-animating')).toBe(true)
    expect(list.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const list = document.querySelector<HTMLElement>('.palette-list')!
    const content = document.querySelector<HTMLElement>('.palette-list-content')!
    height = 300
    fireResize(content)
    expect(list.style.height).toBe('300px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      list.dispatchEvent(evt)
    })
    expect(list.classList.contains('auto-height-animating')).toBe(false)
    expect(list.style.height).toBe('')
  })
})