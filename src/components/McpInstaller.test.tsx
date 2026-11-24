// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { McpInstaller } from './McpInstaller'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}))

// The height measure is mocked file-wide. With no implementation it returns
// undefined, which useAutoHeightTransition treats as "no measurement" — so the
// behavioural tests below never tween and need no DOM-metric stubs. The height
// describe gives it controlled heights.
const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

afterEach(() => {
  cleanup()
})

function renderInstaller(overrides: Partial<React.ComponentProps<typeof McpInstaller>> = {}) {
  return render(
    <McpInstaller
      onSave={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  )
}

describe('McpInstaller', () => {
  it('closes on a backdrop mousedown, not on a mousedown inside the card', () => {
    const onClose = vi.fn()
    const { container } = renderInstaller({ onClose })

    // The modal is portaled to <body>, so query document.body.
    const backdrop = document.body.querySelector('.modal-backdrop')!
    const card = container.querySelector('.modal') ?? document.body.querySelector('.modal')!

    // mousedown inside the card (target !== backdrop) must NOT close — this
    // is what lets a user select text and release over the backdrop safely.
    fireEvent.mouseDown(card)
    expect(onClose).not.toHaveBeenCalled()

    // mousedown on the backdrop root closes.
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// The form body's height tweens on content changes (type swap, row add/remove,
// validation errors) via useAutoHeightTransition. The measure math is unit-tested
// in capped-height-measure.test.ts; here it is mocked to controlled heights so the
// WIRING (observer + key paths, pin release) is what's under test. rAF is stubbed
// inert so the tween holds its start pin and the assertion does not race the frame.
describe('McpInstaller height animation', () => {
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

  function bodyAndContent() {
    const content = document.body.querySelector<HTMLElement>('.mcp-installer-content')!
    return { content, body: content.parentElement as HTMLElement }
  }

  it('tweens the body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    renderInstaller()
    const { body, content } = bodyAndContent()
    height = 300
    fireResize(content)
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    renderInstaller()
    const { body, content } = bodyAndContent()
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

  it('tweens the body height on a stdio → url type switch (key path)', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    renderInstaller()
    const { body } = bodyAndContent()
    // The mount measurement only establishes the baseline — no tween yet.
    expect(body.classList.contains('auto-height-animating')).toBe(false)
    height = 300
    fireEvent.change(document.body.querySelector('select')!, { target: { value: 'sse' } })
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })
})
