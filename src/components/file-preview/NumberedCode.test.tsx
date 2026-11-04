// @vitest-environment happy-dom
// Line-numbered code body: one data-line anchor per line, target/range
// highlighting, and the plain fallback for very large bodies.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MAX_NUMBERED_LINES, NumberedCode } from './NumberedCode'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
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