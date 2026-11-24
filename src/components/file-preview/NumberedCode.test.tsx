// @vitest-environment happy-dom
// Line-numbered code body: one data-line anchor per line, target/range
// highlighting, per-line syntax highlighting via highlightLines, the filename
// bar label, and the plain fallback for very large bodies.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import { MAX_NUMBERED_LINES, NumberedCode } from './NumberedCode'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})

// Clipboard plumbing for the copy-cleanliness test: install a writeText stub,
// restore the original descriptor afterwards (same pattern as useCopy.test).
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator as object, 'clipboard')
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