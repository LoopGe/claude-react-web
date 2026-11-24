// @vitest-environment happy-dom
// Height-animation wiring for the full-diff body. The cap math is unit-tested in
// capped-height-measure.test.ts; here the measure is mocked to controlled heights
// so the wiring (observer + key paths, pin release) is what's under test.
// Behavioral coverage (chunked Show-more, fetch failure) lives in FullDiffViewer.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { FullDiffViewer } from './FullDiffViewer'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

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
  // A never-settling fetch keeps the loading hint mounted, so the content
  // wrapper is present and the observer has a stable target to fire on.
  render(
    <FullDiffViewer
      open
      onClose={vi.fn()}
      name="some/file.ts"
      fetchText={() => new Promise<string>(() => {})}
    />,
  )
}

describe('FullDiffViewer height animation', () => {
  it('tweens the body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const body = document.querySelector<HTMLElement>('.file-viewer-body')!
    const content = document.querySelector<HTMLElement>('.file-viewer-body-content')!
    height = 300
    fireResize(content)
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const body = document.querySelector<HTMLElement>('.file-viewer-body')!
    const content = document.querySelector<HTMLElement>('.file-viewer-body-content')!
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
})