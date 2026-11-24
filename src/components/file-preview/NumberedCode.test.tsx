// @vitest-environment happy-dom
// Line-numbered code body: one data-line anchor per line, target/range
// highlighting, per-line syntax highlighting via highlightLines, the filename
// bar label, and the plain fallback for very large bodies.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
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

// Clipboard plumbing for the copy-cleanliness test: install a writeText stub,
// restore the original descriptor afterwards (same pattern as useCopy.test).
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator as object, 'clipboard')
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

  it('syntax-highlights a known language inside the line spans', () => {
    render(<NumberedCode contents={'const x = 1'} lang="javascript" />)
    const keyword = document.querySelector('[data-line="1"] .hljs-keyword')
    expect(keyword).not.toBeNull()
    expect(keyword?.textContent).toBe('const')
    // Highlight markup must not alter the rendered text.
    expect(document.querySelector('[data-line="1"]')?.textContent).toBe('const x = 1')
  })

  it('carries a multi-line comment span onto every line it covers', () => {
    render(<NumberedCode contents={'/* a\nb\nc */'} lang="javascript" />)
    const lines = [...document.querySelectorAll<HTMLElement>('[data-line]')]
    expect(lines).toHaveLength(3)
    expect(lines[1].querySelector('.hljs-comment')?.textContent).toBe('b')
    expect(lines[0].querySelector('.hljs-comment')).not.toBeNull()
    expect(lines[2].querySelector('.hljs-comment')).not.toBeNull()
  })

  it('renders plain text lines for an unknown / absent language (no throw)', () => {
    const { unmount } = render(<NumberedCode contents={'const x = 1'} />)
    expect(document.querySelector('.hljs-keyword')).toBeNull()
    expect(document.querySelector('[data-line="1"]')?.textContent).toBe('const x = 1')
    unmount()
    // An unregistered language id also falls back to plain text.
    render(<NumberedCode contents={'const x = 1'} lang="xyz" />)
    expect(document.querySelector('.hljs-keyword')).toBeNull()
    expect(document.querySelector('[data-line="1"]')?.textContent).toBe('const x = 1')
  })

  it('keeps an empty line occupying a gutter row in a highlighted file', () => {
    // Blank line INSIDE a multi-line comment: the carried comment span is empty,
    // so a space must still render to preserve the row height / gutter alignment.
    render(<NumberedCode contents={'/* a\n\nb */'} lang="javascript" />)
    const lines = [...document.querySelectorAll<HTMLElement>('[data-line]')]
    expect(lines).toHaveLength(3)
    expect(lines[1].querySelector('.hljs-comment')).not.toBeNull()
    expect(lines[1].textContent).toBe(' ')
  })

  it('keeps an empty line occupying a gutter row outside any token', () => {
    render(<NumberedCode contents={'const a = 1\n\nconst b = 2'} lang="javascript" />)
    const lines = [...document.querySelectorAll<HTMLElement>('[data-line]')]
    expect(lines).toHaveLength(3)
    expect(lines[1].textContent).toBe(' ')
  })

  it('shows the filename label in the bar, not the detected language', () => {
    render(<NumberedCode contents={'const x = 1'} lang="javascript" label="Foo.js" />)
    expect(document.querySelector('.code-block-lang')?.textContent).toBe('Foo.js')
  })

  it('falls back to the language then "code" when no label is given', () => {
    const { unmount } = render(<NumberedCode contents={'x'} lang="javascript" />)
    expect(document.querySelector('.code-block-lang')?.textContent).toBe('javascript')
    unmount()
    render(<NumberedCode contents={'x'} />)
    expect(document.querySelector('.code-block-lang')?.textContent).toBe('code')
  })

  it('copies the raw contents, not the highlighted markup or gutter', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    const contents = 'const x = 1\nreturn x'
    render(<NumberedCode contents={contents} lang="javascript" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(contents))
  })

  it('passes the detected language to the over-cap CodeBlock fallback', () => {
    const contents = Array.from({ length: MAX_NUMBERED_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    render(<NumberedCode contents={contents} lang="javascript" line={10} />)
    expect(document.querySelectorAll('[data-line]')).toHaveLength(0)
    expect(document.body.textContent).toContain('Line navigation is unavailable')
    // The fallback bar labels the detected language.
    expect(document.querySelector('.code-block-lang')?.textContent).toBe('javascript')
  })

  it('shows the filename label in the over-cap fallback bar, like the numbered bar', () => {
    const contents = Array.from({ length: MAX_NUMBERED_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    render(<NumberedCode contents={contents} lang="javascript" label="Foo.js" />)
    expect(document.querySelectorAll('[data-line]')).toHaveLength(0)
    // The label wins over the detected language in the fallback bar too.
    expect(document.querySelector('.code-block-lang')?.textContent).toBe('Foo.js')
  })

  it('highlights the over-cap fallback for a known language', () => {
    const contents = ['const x = 1', ...Array.from({ length: MAX_NUMBERED_LINES }, (_, i) => `line ${i}`)].join('\n')
    render(<NumberedCode contents={contents} lang="javascript" />)
    expect(document.querySelectorAll('[data-line]')).toHaveLength(0)
    // The fallback body carries highlight spans (whole-text block, not per-line).
    expect(document.querySelector('.file-viewer-code .hljs-keyword')?.textContent).toBe('const')
    expect(document.querySelector('.file-viewer-code')?.textContent).toBe(contents)
  })

  it('renders the over-cap fallback as plain text for an unknown language (no throw)', () => {
    const contents = Array.from({ length: MAX_NUMBERED_LINES + 1 }, (_, i) => `const ${i}`).join('\n')
    const { unmount } = render(<NumberedCode contents={contents} lang="xyz" />)
    expect(document.querySelector('.file-viewer-code .hljs-keyword')).toBeNull()
    expect(document.querySelector('.file-viewer-code')?.textContent).toBe(contents)
    unmount()
    render(<NumberedCode contents={contents} />)
    expect(document.querySelector('.file-viewer-code .hljs-keyword')).toBeNull()
    expect(document.querySelector('.file-viewer-code')?.textContent).toBe(contents)
  })

  it('copies the raw contents from the over-cap fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    const contents = ['const x = 1', ...Array.from({ length: MAX_NUMBERED_LINES }, (_, i) => `line ${i}`)].join('\n')
    render(<NumberedCode contents={contents} lang="javascript" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(contents))
  })
})

describe('NumberedCode wrap toggle', () => {
  it('defaults to wrap ON: pre carries numbered-code-wrap and the toggle is pressed', () => {
    render(<NumberedCode contents={'one\ntwo'} />)
    const pre = document.querySelector('pre.numbered-code')!
    expect(pre.classList.contains('numbered-code-wrap')).toBe(true)
    const toggle = screen.getByRole('button', { name: 'Toggle word wrap' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('title')).toBe('Toggle word wrap')
  })

  it('clicking the toggle flips the pre class and aria-pressed', () => {
    render(<NumberedCode contents={'one\ntwo'} />)
    const pre = document.querySelector('pre.numbered-code')!
    const toggle = screen.getByRole('button', { name: 'Toggle word wrap' })
    fireEvent.click(toggle)
    expect(pre.classList.contains('numbered-code-wrap')).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(pre.classList.contains('numbered-code-wrap')).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps the gutter counter scope and clean line text under wrap (numbers stay CSS-only)', () => {
    const contents = 'const a = 1\nconst b = 2'
    render(<NumberedCode contents={contents} lang="javascript" />)
    const pre = document.querySelector('pre.numbered-code')!
    const toggle = screen.getByRole('button', { name: 'Toggle word wrap' })
    const textOf = () => [...document.querySelectorAll('[data-line]')].map((l) => l.textContent)
    const before = textOf()
    expect(before).toEqual(['const a = 1', 'const b = 2'])
    // The counter-reset scope (.numbered-code) must survive the wrap class, and
    // toggling wrap must never inject gutter digits into the line text.
    expect(pre.classList.contains('numbered-code')).toBe(true)
    fireEvent.click(toggle) // OFF
    expect(pre.classList.contains('numbered-code')).toBe(true)
    expect(pre.classList.contains('numbered-code-wrap')).toBe(false)
    expect(textOf()).toEqual(before)
    fireEvent.click(toggle) // ON
    expect(pre.classList.contains('numbered-code')).toBe(true)
    expect(pre.classList.contains('numbered-code-wrap')).toBe(true)
    expect(textOf()).toEqual(before)
  })

  it('re-centers the scroll target when wrap toggles (taller wrapped lines)', () => {
    const contents = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    render(<NumberedCode contents={contents} line={10} revision={1} />)
    const pre = document.querySelector<HTMLElement>('pre.numbered-code')!
    const target = pre.querySelector<HTMLElement>('[data-line="10"]')!
    // Model the scroll container: a 200px viewport over 2000px of content. The
    // nine lines above the target are taller when wrapped (60px) than nowrap
    // (20px), so the target's offset — and the centered scrollTop — tracks the
    // wrap class. getBoundingClientRect is viewport-relative, hence `- scroll`.
    let scroll = 0
    Object.defineProperties(pre, {
      scrollTop: { configurable: true, get: () => scroll, set: (v: number) => { scroll = v } },
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => 2000 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 200, left: 0, right: 800, height: 200, width: 800 }),
      },
    })
    Object.defineProperty(target, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const lineHeight = pre.classList.contains('numbered-code-wrap') ? 60 : 20
        const top = 9 * lineHeight - scroll
        return { top, bottom: top + lineHeight, left: 0, right: 800, height: lineHeight, width: 800 }
      },
    })
    const toggle = screen.getByRole('button', { name: 'Toggle word wrap' })
    // ON → OFF: lines shrink, the target re-centers to 9*20 - 200/2 = 80.
    fireEvent.click(toggle)
    expect(scroll).toBe(80)
    // OFF → ON: wrapped lines are taller, re-centers to 9*60 - 200/2 = 440.
    fireEvent.click(toggle)
    expect(scroll).toBe(440)
  })
})

// The fading navigation band rides the .code-line-target / .code-line-in-range
// classes (the keyframe itself is pinned CSS-side in code-nav-band.test.ts).
// A CSS animation only replays when its element remounts, so the re-trigger
// contract is observable as DOM-node identity: a revision bump must remount the
// animated spans (new key) while a same-content refetch must keep them.
describe('NumberedCode navigation band re-trigger', () => {
  const contents = 'one\ntwo\nthree\nfour\nfive'

  it('remounts the target and range spans on a revision bump (replays the band)', () => {
    const { rerender } = render(
      <NumberedCode contents={contents} line={2} endLine={3} revision={1} />,
    )
    const targetBefore = document.querySelector('[data-line="2"]')!
    const rangeBefore = document.querySelector('[data-line="3"]')!
    const plainBefore = document.querySelector('[data-line="1"]')!
    expect(targetBefore.className).toContain('code-line-target')
    expect(rangeBefore.className).toContain('code-line-in-range')

    rerender(<NumberedCode contents={contents} line={2} endLine={3} revision={2} />)
    const targetAfter = document.querySelector('[data-line="2"]')!
    const rangeAfter = document.querySelector('[data-line="3"]')!
    const plainAfter = document.querySelector('[data-line="1"]')!
    // Animated spans remount (fresh node) so the keyframe animation restarts.
    expect(targetAfter).not.toBe(targetBefore)
    expect(rangeAfter).not.toBe(rangeBefore)
    expect(targetAfter.className).toContain('code-line-target')
    expect(rangeAfter.className).toContain('code-line-in-range')
    // Non-animated spans keep their node (stable key) — no whole-file remount.
    expect(plainAfter).toBe(plainBefore)
  })

  it('does NOT replay on a same-content refetch (revision unchanged)', () => {
    const { rerender } = render(
      <NumberedCode contents={contents} line={2} endLine={3} revision={1} />,
    )
    const targetBefore = document.querySelector('[data-line="2"]')!
    const rangeBefore = document.querySelector('[data-line="3"]')!
    // A refetch returns identical contents and the same revision: the animated
    // spans must keep their DOM nodes so the band does not flash again.
    rerender(
      <NumberedCode contents={'one\ntwo\nthree\nfour\nfive'} line={2} endLine={3} revision={1} />,
    )
    expect(document.querySelector('[data-line="2"]')).toBe(targetBefore)
    expect(document.querySelector('[data-line="3"]')).toBe(rangeBefore)
  })

  it('animates every line of a multi-line range, not just the first', () => {
    render(<NumberedCode contents={contents} line={2} endLine={4} revision={1} />)
    expect(document.querySelector('[data-line="2"]')!.className).toContain('code-line-target')
    for (const n of [3, 4]) {
      expect(document.querySelector(`[data-line="${n}"]`)!.className).toContain('code-line-in-range')
    }
    expect(document.querySelector('[data-line="5"]')!.className).not.toContain('code-line-in-range')
  })

  it('keeps the target node stable across a wrap toggle (no band replay on wrap)', () => {
    const { rerender } = render(
      <NumberedCode contents={contents} line={2} endLine={3} revision={1} />,
    )
    const targetBefore = document.querySelector('[data-line="2"]')!
    // Wrap is local state; toggling it must not remount the target (the scroll
    // re-centering effect reuses the same node). Revision is unchanged here.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle word wrap' }))
    expect(document.querySelector('[data-line="2"]')).toBe(targetBefore)
    rerender(<NumberedCode contents={contents} line={2} endLine={3} revision={1} />)
    expect(document.querySelector('[data-line="2"]')).toBe(targetBefore)
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
  // The rect is mocked at the prototype level keyed on data-line because the
  // target span REMOUNTS when it becomes animated (its key carries revision),
  // which would detach an instance-level spy.
  function mockGeometry(container: HTMLElement, viewport: { current: number }) {
    vi.spyOn(container, 'scrollHeight', 'get').mockReturnValue(1000)
    vi.spyOn(container, 'clientHeight', 'get').mockImplementation(() => viewport.current)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.getAttribute('data-line') === '10') return { top: 500 - container.scrollTop } as DOMRect
      return { top: 0 } as DOMRect
    })
  }

  it('re-centers the target when the container grows after the jump', () => {
    const viewport = { current: 200 }
    const { rerender } = render(<NumberedCode contents={contents} />)
    const container = document.querySelector<HTMLElement>('.file-viewer-code')!
    mockGeometry(container, viewport)

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
    mockGeometry(container, viewport)

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
    mockGeometry(container, viewport)

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
    mockGeometry(container, viewport)

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
    mockGeometry(container, viewport)

    rerender(<NumberedCode contents={contents} line={10} revision={1} />)
    expect(container.scrollTop).toBe(400)

    // A pointerdown INSIDE the pre is text selection, not a scroll — it must not
    // disable re-centering.
    const target = document.querySelector<HTMLElement>('[data-line="10"]')!
    fireEvent.pointerDown(target)
    viewport.current = 400
    fireResize(container)
    expect(container.scrollTop).toBe(300)
  })
})