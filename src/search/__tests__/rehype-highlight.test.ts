import { describe, it, expect } from 'vitest'
import { rehypeHighlightQuery } from '../rehype-highlight'
import { parseMarkdownToHast } from '../extract'
import type { HastNode } from '../hast-walk'

/** Render a hast subtree to a flat HTML-ish string for assertion.
 *  Just enough to verify <mark> placement; not a real serializer.
 *  When a `<mark>` carries the `search-hl-active` class, render it as
 *  `<mark.active>...</mark>` so the test can assert on which match is
 *  the active one without having to teach the serializer about the
 *  full className layout. */
function toHtml(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.type === 'root') return (node.children ?? []).map(toHtml).join('')
  if (node.type === 'element') {
    const tag = node.tagName ?? 'unknown'
    const inner = (node.children ?? []).map(toHtml).join('')
    if (tag === 'mark') {
      const cls = (node.properties as { className?: string[] } | undefined)?.className ?? []
      if (cls.includes('search-hl-active')) return `<mark.active>${inner}</mark.active>`
    }
    return `<${tag}>${inner}</${tag}>`
  }
  return ''
}

function applyHighlight(markdown: string, query: string, activeIdx?: number): string {
  const tree = parseMarkdownToHast(markdown)
  rehypeHighlightQuery(query, activeIdx)(tree)
  return toHtml(tree)
}

describe('rehypeHighlightQuery', () => {
  it('highlights a simple word', () => {
    expect(applyHighlight('hello world', 'world')).toBe(
      '<p>hello <mark>world</mark></p>',
    )
  })

  it('is a no-op for an empty query', () => {
    expect(applyHighlight('hello world', '')).toBe('<p>hello world</p>')
    expect(applyHighlight('hello world', '   ')).toBe('<p>hello world</p>')
  })

  it('highlights matches that span an inline boundary (the cross-node bug)', () => {
    // "**hello** world" → <strong>hello</strong> world
    // The phrase "hello world" exists across the boundary; the old
    // per-text-node implementation could not see it.  Each segment
    // gets its own <mark>; visually they line up because the CSS
    // background lives on .search-hl, not on the node.
    const html = applyHighlight('**hello** world', 'hello world')
    expect(html).toBe('<p><strong><mark>hello</mark></strong><mark> world</mark></p>')
  })

  it('does not match across block boundaries', () => {
    // The virtual \n separator the walker inserts between paragraphs
    // is what blocks this — without it a regex over the flat string
    // would happily match across paragraphs.
    const html = applyHighlight('hello\n\nworld', 'hello world')
    // Neither paragraph contains the full phrase, so no <mark>.
    expect(html).not.toContain('<mark>')
  })

  it('marks every occurrence in a multi-match document', () => {
    const html = applyHighlight('foo bar foo baz foo', 'foo')
    expect(html).toBe(
      '<p><mark>foo</mark> bar <mark>foo</mark> baz <mark>foo</mark></p>',
    )
  })

  it('is case-insensitive (matches the search bar default)', () => {
    expect(applyHighlight('Hello world', 'hello')).toContain('<mark>Hello</mark>')
    expect(applyHighlight('HELLO world', 'hello')).toContain('<mark>HELLO</mark>')
  })

  it('highlights matches inside fenced code blocks', () => {
    // Per the design decision, code IS searched.  Note that the
    // hljs syntax highlighter has not run here (we feed the tree
    // straight from remark-rehype), so the code text is just one
    // text node — we still want it marked.
    const html = applyHighlight('```\nconst foo = 1\n```', 'foo')
    expect(html).toContain('<mark>foo</mark>')
  })

  it('handles a query that meta-characters in the regex sense', () => {
    expect(applyHighlight('use a.b in code', 'a.b')).toContain('<mark>a.b</mark>')
    expect(applyHighlight('use a.b in code', '.')).toBe(
      '<p>use a<mark>.</mark>b in code</p>',
    )
  })

  it('survives a query that matches nothing', () => {
    const html = applyHighlight('hello world', 'absent')
    expect(html).toBe('<p>hello world</p>')
  })

  describe('active-match highlighting', () => {
    it('marks the Nth match active when activeRangeIdx is given', () => {
      // 3 occurrences of "foo"; activeIdx=1 should mark only the
      // middle one with .search-hl-active.
      const html = applyHighlight('foo bar foo baz foo', 'foo', 1)
      expect(html).toBe(
        '<p><mark>foo</mark> bar <mark.active>foo</mark.active> baz <mark>foo</mark></p>',
      )
    })

    it('leaves all marks plain when activeRangeIdx is undefined', () => {
      // Backwards compatibility: existing call sites pass no second
      // arg and should see no .active class anywhere.
      const html = applyHighlight('foo bar foo baz', 'foo')
      expect(html).toBe('<p><mark>foo</mark> bar <mark>foo</mark> baz</p>')
      expect(html).not.toContain('mark.active')
    })

    it('silently ignores out-of-range active indices', () => {
      // Stale state from a previous query (where there were more
      // matches) shouldn't crash or render bogus active marks.
      const html = applyHighlight('foo bar', 'foo', 99)
      expect(html).toBe('<p><mark>foo</mark> bar</p>')
      expect(html).not.toContain('mark.active')
    })

    it('marks every node of a cross-boundary active match', () => {
      // The phrase "hello world" spans <strong>hello</strong> + " world".
      // Both <mark> halves represent the SAME range — both should
      // carry the active class so the highlight reads as one block.
      const html = applyHighlight('**hello** world', 'hello world', 0)
      expect(html).toBe(
        '<p><strong><mark.active>hello</mark.active></strong><mark.active> world</mark.active></p>',
      )
    })
  })
})
