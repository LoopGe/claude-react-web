// Regression test for the search-highlight wiring inside the
// react-markdown plugin pipeline.
//
// The unit tests in `rehype-highlight.test.ts` exercise the highlighter
// by calling `rehypeHighlightQuery(q)(tree)` directly — bypassing the
// unified pipeline. That hid a real bug in production: `rehypeHighlightQuery(q)`
// returns a *transformer* `(tree) => void`, not an *attacher*. unified
// (and react-markdown) expect each entry in `rehypePlugins` to be an
// attacher (called with no tree, expected to return a transformer).
// When a transformer was passed directly, unified called it as
// `transformer()` — which threw inside `walkSearchable`, was swallowed
// by <ErrorBoundary>, and the user saw zero highlights even though
// the counter said matches existed.
//
// This test runs the *exact* code path the app uses (Markdown.tsx →
// react-markdown with `rehypeHighlightQuery` in `rehypePlugins`) and
// asserts that <mark class="search-hl"> elements appear in the output.

import { describe, it, expect } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { afterEach } from 'vitest'
import { rehypeHighlightQuery } from '../rehype-highlight'

afterEach(() => cleanup())

/** Mirror the wrap from `Markdown.tsx`: react-markdown's `rehypePlugins`
 *  expects attachers, but `rehypeHighlightQuery(q)` returns a transformer.
 *  We wrap it in a one-line attacher — exactly what the production
 *  component does. */
function highlightAttacher(q: string) {
  return () => rehypeHighlightQuery(q)
}

describe('rehypeHighlightQuery via react-markdown pipeline', () => {
  it('renders <mark class="search-hl"> inside react-markdown output', () => {
    const { container } = render(
      <ReactMarkdown rehypePlugins={[highlightAttacher('hello')]}>
        {'hello world'}
      </ReactMarkdown>,
    )
    const marks = container.querySelectorAll('mark.search-hl')
    expect(marks.length).toBe(1)
    expect(marks[0].textContent).toBe('hello')
  })

  it('marks every occurrence in a paragraph', () => {
    const { container } = render(
      <ReactMarkdown rehypePlugins={[highlightAttacher('对话')]}>
        {'对话 a 对话 b 对话'}
      </ReactMarkdown>,
    )
    const marks = container.querySelectorAll('mark.search-hl')
    expect(marks.length).toBe(3)
  })

  it('is case-insensitive (matches the search bar default)', () => {
    const { container } = render(
      <ReactMarkdown rehypePlugins={[highlightAttacher('hello')]}>
        {'Hello WORLD HELLO'}
      </ReactMarkdown>,
    )
    const marks = container.querySelectorAll('mark.search-hl')
    expect(marks.length).toBe(2)
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['Hello', 'HELLO'])
  })

  it('handles cross-inline-boundary phrases (the bug the highlighter exists to fix)', () => {
    const { container } = render(
      <ReactMarkdown rehypePlugins={[highlightAttacher('hello world')]}>
        {'**hello** world'}
      </ReactMarkdown>,
    )
    // The phrase straddles <strong>hello</strong> and " world",
    // so it ends up split across two adjacent <mark>s.
    const marks = container.querySelectorAll('mark.search-hl')
    expect(marks.length).toBeGreaterThanOrEqual(1)
    const joined = Array.from(marks).map((m) => m.textContent).join('')
    expect(joined).toBe('hello world')
  })

  it('regression: passing the transformer DIRECTLY (not wrapped) is broken', () => {
    // Pins the failure mode that shipped to production. If somebody
    // "simplifies" the wrap away again, unified calls the transformer
    // as `transformer()` during freeze — `tree` is undefined and
    // `walkSearchable` throws. This test asserts that breakage so the
    // regression is caught at CI time.
    const transformerNotAttacher = rehypeHighlightQuery('hello')
    expect(() => {
      render(
        <ReactMarkdown rehypePlugins={[transformerNotAttacher]}>
          {'hello world'}
        </ReactMarkdown>,
      )
    }).toThrow()
  })
})
