import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

// Mock the markdown cache so we can flip it between healthy and throwing
// behavior per test. The healthy mock renders children inside a div so
// we can assert that normal rendering works and the fallback isn't used.
const compileMarkdownImpl = vi.fn<(source: string, opts: Record<string, unknown>) => React.ReactNode>()
vi.mock('../utils/markdown-cache', () => ({
  compileMarkdown: (source: string, opts: Record<string, unknown>) => compileMarkdownImpl(source, opts),
  clearMarkdownCache: () => {},
  markdownCacheSize: () => 0,
}))

// Import AFTER the mock so the module sees the stub.
import { Markdown } from './Markdown'

describe('Markdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Silence ErrorBoundary's componentDidCatch console output for the
    // throwing tests — without this, vitest prints React's own error
    // stack on every assertion that exercises the fallback path.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('renders normally when compileMarkdown succeeds', () => {
    compileMarkdownImpl.mockImplementation(() => (
      <div data-testid="rendered">hello world</div>
    ))

    const { container, queryByTestId } = render(<Markdown text="hello **world**" />)

    expect(queryByTestId('rendered')?.textContent).toBe('hello world')
    // No fallback should be rendered.
    expect(container.querySelector('.md-fallback')).toBeNull()
  })

  it('falls back to a raw <pre> when compileMarkdown throws', () => {
    compileMarkdownImpl.mockImplementation(() => {
      throw new Error('boom: bad rehype plugin')
    })

    const { container } = render(<Markdown text="raw text after boom" />)

    const fallback = container.querySelector('pre.md.md-fallback')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toBe('raw text after boom')
  })

  it('preserves the original text in the fallback verbatim', () => {
    compileMarkdownImpl.mockImplementation(() => {
      throw new Error('still broken')
    })

    const tricky = '# heading\n```\ncode\n```\n<not-rendered>'
    const { container } = render(<Markdown text={tricky} />)

    const fallback = container.querySelector('pre.md.md-fallback')
    expect(fallback?.textContent).toBe(tricky)
  })
})
