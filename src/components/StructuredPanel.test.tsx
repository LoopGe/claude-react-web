// @vitest-environment happy-dom
// Height-animation wiring for the structured-output dialog's two scrollers (the
// form body and the result section). The cap math is unit-tested in
// capped-height-measure.test.ts; here the measure is mocked to controlled heights
// so the wiring (observer + key paths, pin release) is what's under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { StructuredPanel } from './StructuredPanel'

const { measureMock, runState } = vi.hoisted(() => ({
  measureMock: vi.fn(),
  runState: { running: false, result: null as unknown, error: null as string | null },
}))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))
vi.mock('../hooks/useStructuredRun', () => ({
  useStructuredRun: () => ({ ...runState, run: vi.fn(), cancel: vi.fn(), reset: vi.fn() }),
}))

beforeEach(() => {
  measureMock.mockReset()
  runState.running = false
  runState.result = null
  runState.error = null
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
  render(<StructuredPanel open onClose={vi.fn()} />)
}

describe('StructuredPanel height animation', () => {
  it('tweens the form body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const body = document.querySelector<HTMLElement>('.structured-body')!
    const content = document.querySelector<HTMLElement>('.structured-body-content')!
    height = 300
    fireResize(content)
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })

  it('releases the body pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const body = document.querySelector<HTMLElement>('.structured-body')!
    const content = document.querySelector<HTMLElement>('.structured-body-content')!
    height = 300
    fireResize(content)
    expect(body.style.height).toBe('300px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      body.dispatchEvent(evt)
    })
    expect(body.classList.contains('auto-height-animating')).toBe(false)
    expect(body.style.height).toBe('')
  })

  it('tweens the result section height on a content-driven resize', () => {
    runState.running = true
    let height = 40
    measureMock.mockImplementation(() => height)
    setup()
    const result = document.querySelector<HTMLElement>('.structured-result')!
    const content = document.querySelector<HTMLElement>('.structured-result-content')!
    height = 260
    fireResize(content)
    expect(result.classList.contains('auto-height-animating')).toBe(true)
    expect(result.style.height).toBe('40px')
  })
})

describe('StructuredPanel overlay scrollbar', () => {
  it('attaches the project overlay scrollbar to the form body scroller', () => {
    setup()
    const body = document.querySelector<HTMLElement>('.structured-body')!
    expect(body.hasAttribute('data-os-native-hidden')).toBe(true)
    expect(document.querySelector('.structured-panel .os-track')).toBeTruthy()
  })

  it('attaches the project overlay scrollbar to the result section scroller', () => {
    runState.running = true
    setup()
    const result = document.querySelector<HTMLElement>('.structured-result')!
    expect(result.hasAttribute('data-os-native-hidden')).toBe(true)
  })

  it('attaches both-axis overlay scrollbars to the result JSON pre', () => {
    runState.result = { ok: true, structuredOutput: { answer: 42 } }
    setup()
    const pre = document.querySelector<HTMLElement>('.structured-json')!
    expect(pre.hasAttribute('data-os-native-hidden')).toBe(true)
    // orientation 'both' → a vertical AND a horizontal track beside the pre
    // (its parent is the content wrapper, which holds no other scroller).
    expect(pre.parentElement!.querySelectorAll('.os-track').length).toBe(2)
  })
})
