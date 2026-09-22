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
})
