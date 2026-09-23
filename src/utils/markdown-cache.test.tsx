import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import {
  compileMarkdown,
  clearMarkdownCache,
  markdownCacheSize,
  markdownSearchBucketCount,
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

  // Fence tags are model output, so the language gate has to be as permissive
  // as lowlight itself. A hand-maintained Set of explicit aliases was not: it
  // silently dropped highlighting for every grammar-declared alias and for any
  // tag that wasn't already lowercase. `js` (the case above) is in that Set, so
  // it could not catch either regression — hence these.
  describe('language gate breadth', () => {
    const highlighted = (md: string) => {
      const { container } = render(<>{compileMarkdown(md, {})}</>)
      return container.querySelector('span[class*="hljs"]') != null
    }

    it.each([
      ['mjs', '```mjs\nconst x = 1\n```'],
      ['cjs', '```cjs\nconst x = 1\n```'],
      ['kt', '```kt\nval x = 1\n```'],
      ['patch', '```patch\n--- a\n+++ b\n```'],
      ['jsonc', '```jsonc\n{"a": 1}\n```'],
    ])('highlights a grammar-declared alias (%s)', (_name, md) => {
      expect(highlighted(md)).toBe(true)
    })

    it.each([
      ['Python', '```Python\nx = 1\n```'],
      ['JSON', '```JSON\n{"a": 1}\n```'],
    ])('highlights a non-lowercase tag (%s)', (_name, md) => {
      expect(highlighted(md)).toBe(true)
    })

    it('leaves an unknown language as plain text instead of throwing', () => {
      const { container } = render(
        <>{compileMarkdown('```not-a-real-language\nsome text\n```', {})}</>,
      )
      expect(container.querySelector('span[class*="hljs"]')).toBeNull()
      expect(container.querySelector('code')?.textContent).toContain('some text')
    })

    it('leaves an untagged fence as plain text', () => {
      const { container } = render(<>{compileMarkdown('```\nsome text\n```', {})}</>)
      expect(container.querySelector('span[class*="hljs"]')).toBeNull()
      expect(container.querySelector('code')?.textContent).toContain('some text')
    })
  })

  // The reason search variants get their own buckets: typing in the find bar
  // compiles a fresh entry per visible row per debounced keystroke, and a
  // shared LRU let that flush every plain entry — so closing the search box
  // meant re-parsing the whole viewport.
  describe('search bucketing', () => {
    it('keeps plain entries alive through a long search burst', () => {
      const plain = 'a settled assistant message'
      compileMarkdown(plain, {})
      // More distinct queries than SEARCH_BUCKET_CAP (8), each touching several
      // rows — the shape of someone typing then refining a query. Kept small on
      // purpose: the point is to overflow the search caps, and every extra
      // compile here is real unified-pipeline work that slows the whole suite.
      for (let k = 0; k < 12; k++) {
        for (let row = 0; row < 4; row++) {
          compileMarkdown(`row ${row}`, { searchQuery: `q${k}` })
        }
      }
      // The plain entry is still a hit: no new entry is added by this call.
      const before = markdownCacheSize()
      compileMarkdown(plain, {})
      expect(markdownCacheSize()).toBe(before)
    })

    it('retires stale search variants instead of growing without bound', () => {
      for (let k = 0; k < 12; k++) compileMarkdown('x', { searchQuery: `q${k}` })
      expect(markdownSearchBucketCount()).toBeLessThanOrEqual(8)
    })

    it('still returns a hit for a repeated source within the active query', () => {
      compileMarkdown('hello world', { searchQuery: 'hello' })
      const before = markdownCacheSize()
      compileMarkdown('hello world', { searchQuery: 'hello' })
      expect(markdownCacheSize()).toBe(before)
    })
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
