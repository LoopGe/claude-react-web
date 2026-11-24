// @vitest-environment happy-dom
// Line-numbered code body: one data-line anchor per line, target/range
// highlighting, and the plain fallback for very large bodies.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../../test/resize-observer-stub'
import { MAX_NUMBERED_LINES, NumberedCode } from './NumberedCode'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  stubResizeObserver()
})

afterEach(() => {
  clearResizeObserverStub()
  vi.restoreAllMocks()
})

describe('NumberedCode', () => {
  it('renders one data-line anchor per line', () => {
    render(<NumberedCode contents={'alpha\nbeta\ngamma'} lang="ts" />)
    const lines = document.querySelectorAll('[data-line]')
    expect(lines).toHaveLength(3)
    expect([...lines].map((line) => line.getAttribute('data-line'))).toEqual(['1', '2', '3'])
  })

  it('highlights the target line and the range', () => {
    render(<NumberedCode contents={'one\ntwo\nthree\nfour'} line={2} endLine={3} revision={1} />)
    const lines = [...document.querySelectorAll<HTMLElement>('[data-line]')]
    expect(lines[1].className).toContain('code-line-target')
    expect(lines[2].className).toContain('code-line-in-range')
    expect(lines[0].className).not.toContain('code-line-target')
    expect(lines[3].className).not.toContain('code-line-in-range')
  })

  it('does not number a phantom line for a trailing newline', () => {
    render(<NumberedCode contents={'one\ntwo\n'} />)
    expect(document.querySelectorAll('[data-line]')).toHaveLength(2)
  })

  it('falls back to plain text above the line cap', () => {
    const contents = Array.from({ length: MAX_NUMBERED_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    render(<NumberedCode contents={contents} line={10} />)
    expect(document.querySelectorAll('[data-line]')).toHaveLength(0)
    expect(document.body.textContent).toContain('Line navigation is unavailable')
  })

  it('keeps copy source equal to the raw contents (no gutter text)', () => {
    render(<NumberedCode contents={'one\ntwo'} />)
    // The line spans contain only the code; numbers come from CSS counters.
    expect(document.querySelector('.numbered-code')?.textContent).toBe('onetwo')
  })
})

// The resource modal animates its body height (useAutoHeightTransition), so the
// code scroller's viewport grows/shrinks during the 240ms tween AFTER the
// scroll-to-line effect has centered the target against the start height. The
// jump must stay centered through that resize — re-center on container resize
// until the user scrolls away (a manual scroll is an intentional move we must
// not yank back).
describe('NumberedCode line centering through a viewport resize', () => {
  const contents = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

  // Model a scroll-dependent target rect: the target sits at content offset
  // 500, so its viewport-relative top is 500 − scrollTop (container top 0).
  // With that, the centering formula reduces to the stable 500 − viewport/2.
  function mockGeometry(container: HTMLElement, target: HTMLElement, viewport: { current: number }) {
    vi.spyOn(container, 'scrollHeight', 'get').mockReturnValue(1000)
    vi.spyOn(container, 'clientHeight', 'get').mockImplementation(() => viewport.current)
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect)
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 500 - container.scrollTop }) as DOMRect,
    )
  }

  it('re-centers the target when the container grows after the jump', () => {
    const viewport = { current: 200 }
    const { rerender } = render(<NumberedCode contents={contents} />)
    const container = document.querySelector<HTMLElement>('.file-viewer-code')!
    const target = document.querySelector<HTMLElement>('[data-line="10"]')!
    mockGeometry(container, target, viewport)

    rerender(<NumberedCode contents={contents} line={10} revision={1} />)
    // Initial jump centers against the 200px viewport: 500 − 100 = 400.
    expect(container.scrollTop).toBe(400)

    // The modal tween grows the viewport to 400px; the target must re-center.
    viewport.current = 400
    fireResize(container)
    expect(container.scrollTop).toBe(300) // 500 − 200
  })

  it('stops re-centering once the user scrolls away', () => {
    const viewport = { current: 200 }
    const { rerender } = render(<NumberedCode contents={contents} />)
    const container = document.querySelector<HTMLElement>('.file-viewer-code')!
    const target = document.querySelector<HTMLElement>('[data-line="10"]')!
    mockGeometry(container, target, viewport)

    rerender(<NumberedCode contents={contents} line={10} revision={1} />)
    expect(container.scrollTop).toBe(400)

    // The user scrolls to an intentional position (wheel marks user intent).
    container.scrollTop = 100
    fireEvent.wheel(container)
    viewport.current = 400
    fireResize(container)
    // A resize must not yank the user back to the centered target.
    expect(container.scrollTop).toBe(100)
  })

  it('stops re-centering once the animation window elapses', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const viewport = { current: 200 }
    const { rerender } = render(<NumberedCode contents={contents} />)
    const container = document.querySelector<HTMLElement>('.file-viewer-code')!
    const target = document.querySelector<HTMLElement>('[data-line="10"]')!
    mockGeometry(container, target, viewport)

    rerender(<NumberedCode contents={contents} line={10} revision={1} />)
    expect(container.scrollTop).toBe(400)

    // Past the window (a later window resize, not the modal tween): leave it.
    now.mockReturnValue(1500)
    viewport.current = 400
    fireResize(container)
    expect(container.scrollTop).toBe(400)
  })

  it('stands down on an overlay-scrollbar thumb drag (a sibling of the pre)', () => {
    const viewport = { current: 200 }
    const { rerender } = render(<NumberedCode contents={contents} />)
    const container = document.querySelector<HTMLElement>('.file-viewer-code')!
    const target = document.querySelector<HTMLElement>('[data-line="10"]')!
    mockGeometry(container, target, viewport)

    rerender(<NumberedCode contents={contents} line={10} revision={1} />)
    expect(container.scrollTop).toBe(400)

    // The overlay thumb lives on the pre's parent, outside the pre. A pointerdown
    // there is a scrollbar drag — stand down before the drag can be yanked back.
    const thumb = document.createElement('div')
    container.parentElement!.appendChild(thumb)
    fireEvent.pointerDown(thumb)
    viewport.current = 400
    fireResize(container)
    expect(container.scrollTop).toBe(400)
  })

  it('keeps re-centering after a plain click inside the code (text selection)', () => {
    const viewport = { current: 200 }
    const { rerender } = render(<NumberedCode contents={contents} />)
    const container = document.querySelector<HTMLElement>('.file-viewer-code')!
    const target = document.querySelector<HTMLElement>('[data-line="10"]')!
    mockGeometry(container, target, viewport)

    rerender(<NumberedCode contents={contents} line={10} revision={1} />)
    expect(container.scrollTop).toBe(400)

    // A pointerdown INSIDE the pre is text selection, not a scroll — it must not
    // disable re-centering.
    fireEvent.pointerDown(target)
    viewport.current = 400
    fireResize(container)
    expect(container.scrollTop).toBe(300)
  })
})