import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import {
  compileMarkdown,
  clearMarkdownCache,
  markdownCacheSize,
} from './markdown-cache'

afterEach(() => {
  cleanup()
  clearMarkdownCache()
})

describe('compileMarkdown cache', () => {
  it('renders markdown (smoke)', () => {
    const { container } = render(
      <>{compileMarkdown('hello **world**', {})}</>,
    )
    expect(container.querySelector('strong')?.textContent).toBe('world')
    expect(container.textContent).toContain('hello')
  })

  it('returns a cache hit for the same source+opts without re-growing the cache', () => {
    compileMarkdown('# t', {})
    expect(markdownCacheSize()).toBe(1)
    const a = compileMarkdown('# t', {})
    expect(markdownCacheSize()).toBe(1) // hit, no new entry
    expect(a).toBeTruthy()
  })

  it('misses when breaks / searchQuery / activeMatchIdx differ', () => {
    compileMarkdown('x', {})
    compileMarkdown('x', { breaks: true })
    compileMarkdown('x', { searchQuery: 'x' })
    compileMarkdown('x', { searchQuery: 'x', activeMatchIdx: 0 })
    expect(markdownCacheSize()).toBe(4)
  })

  it('applies search marks when searchQuery is set', () => {
    const { container } = render(
      <>{compileMarkdown('hello world', { searchQuery: 'hello' })}</>,
    )
    expect(container.querySelector('mark.search-hl')?.textContent).toBe('hello')
  })

  it('highlights fenced code blocks', () => {
    const { container } = render(
      <>{compileMarkdown('```js\nconst x = 1\n```', {})}</>,
    )
    expect(container.querySelector('.hljs-keyword, .hljs-title, span[class*="hljs"]')).toBeTruthy()
  })

  // toJsxRuntime has no urlTransform hook, so MD_COMPONENTS' `a` renderer is
  // the only href gate on this path. These lock in that it delegates to
  // react-markdown's defaultUrlTransform rather than a hand-rolled scheme test
  // (which let data:text/html through).
  describe('href sanitization', () => {
    it('strips javascript: URLs from links', () => {
      const { container } = render(
        <>{compileMarkdown('[click](javascript:alert(1))', {})}</>,
      )
      const anchor = container.querySelector('a')
      expect(anchor).toBeTruthy()
      expect(anchor!.getAttribute('href')).not.toContain('javascript:')
    })

    it('strips data:text/html URLs from links', () => {
      const { container } = render(
        <>{compileMarkdown('[click](data:text/html,<script>alert(1)</script>)', {})}</>,
      )
      const anchor = container.querySelector('a')
      expect(anchor).toBeTruthy()
      expect(anchor!.getAttribute('href')).not.toContain('data:text/html')
    })

    it('allows normal http URLs through', () => {
      const { container } = render(
        <>{compileMarkdown('[click](https://example.com)', {})}</>,
      )
      const anchor = container.querySelector('a')
      expect(anchor).toBeTruthy()
      expect(anchor!.getAttribute('href')).toBe('https://example.com')
    })

    it('keeps data:image/* usable as an <img> src', () => {
      // The img gate deliberately bypasses sanitizeHref — assistants emit
      // legitimate base64 images and defaultUrlTransform would strip them.
      const png = 'data:image/png;base64,iVBORw0KGgo='
      const { container } = render(
        <>{compileMarkdown(`![shot](${png})`, {})}</>,
      )
      expect(container.querySelector('img.msg-image')?.getAttribute('src')).toBe(png)
    })
  })
})
