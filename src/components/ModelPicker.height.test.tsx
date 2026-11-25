// @vitest-environment happy-dom
// Height-animation wiring for the model picker list. The cap math is unit-tested
// in capped-height-measure.test.ts; here the measure is mocked to controlled
// heights so the wiring (observer + key paths, pin release) is what's under test.
// Kept in a sibling file so the behavioral ModelPicker.test.tsx runs unmocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { ModelPicker } from './ModelPicker'
import type { ModelOptions } from '../hooks/useModelOptions'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

const options: ModelOptions = {
  models: [{ id: 'm1' }, { id: 'm2' }],
  recents: [],
  defaultModel: 'm1',
}

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
  return render(
    <ModelPicker
      anchor={{ x: 0, y: 0, source: null }}
      current={undefined}
      options={options}
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

describe('ModelPicker height animation', () => {
  it('tweens the list height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const list = document.querySelector<HTMLElement>('.model-picker-list')!
    const content = document.querySelector<HTMLElement>('.model-picker-list-content')!
    height = 300
    fireResize(content)
    expect(list.classList.contains('auto-height-animating')).toBe(true)
    expect(list.style.height).toBe('100px')
  })

  it('tweens via the key path when the query filters rows (no resize fired)', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const list = document.querySelector<HTMLElement>('.model-picker-list')!
    height = 300
    // Filtering narrows the row set, changing the hook key — the layout-effect
    // path must tween even though no ResizeObserver delivery happens.
    fireEvent.change(document.querySelector('.model-picker-input')!, { target: { value: 'm1' } })
    expect(list.classList.contains('auto-height-animating')).toBe(true)
    expect(list.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const list = document.querySelector<HTMLElement>('.model-picker-list')!
    const content = document.querySelector<HTMLElement>('.model-picker-list-content')!
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
