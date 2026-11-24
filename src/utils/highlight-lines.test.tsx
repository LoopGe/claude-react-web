// Whole-text highlight + per-line split. The load-bearing contract is that a
// token spanning several lines (block comment / template string) keeps its
// span on EVERY line it covers, and that the rendered text round-trips to the
// source (copy cleanliness). The line split must match NumberedCode exactly.
//
// Runs under happy-dom (the `src/utils/**/*.test.ts` node override does not
// match a `.tsx` file), so `document` is available for reading textContent back
// out of the static markup.

import { describe, it, expect } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { highlightLines, highlightBlock } from './highlight-lines'

function markup(node: ReactNode): string {
  return renderToStaticMarkup(<>{node}</>)
}

/** Rendered text of one line node (tags stripped, entities decoded). */
function textOf(node: ReactNode): string {
  const div = document.createElement('div')
  div.innerHTML = markup(node)
  return div.textContent ?? ''
}

/** Per-line textContent joined with '\n' — reconstructs the source minus the
 *  phantom trailing newline. */
function joinedText(nodes: ReactNode[]): string {
  return nodes.map(textOf).join('\n')
}

describe('highlightLines', () => {
  it('carries a multi-line block comment span across every line', () => {
    const contents = '/* a\nb\nc */'
    const nodes = highlightLines('javascript', contents)
    expect(nodes).toHaveLength(3)
    const m = nodes.map(markup)
    // Line 2 ('b') stays inside the comment span opened on line 1 — the span
    // state is carried across the newline, not re-highlighted per line.
    expect(m[1]).toBe('<span class="hljs-comment">b</span>')
    expect(m[0]).toContain('hljs-comment')
    expect(m[2]).toContain('hljs-comment')
    expect(joinedText(nodes)).toBe(contents)
  })

  it('carries a multi-line template string span across every line', () => {
    const contents = '`a\nb\nc`'
    const nodes = highlightLines('javascript', contents)
    expect(nodes).toHaveLength(3)
    const m = nodes.map(markup)
    expect(m[1]).toBe('<span class="hljs-string">b</span>')
    expect(m[0]).toContain('hljs-string')
    expect(m[2]).toContain('hljs-string')
    expect(joinedText(nodes)).toBe(contents)
  })

  it('keeps the comment span on a blank line inside the token', () => {
    const contents = '/* a\n\nc */'
    const nodes = highlightLines('javascript', contents)
    expect(nodes).toHaveLength(3)
    // The middle line is empty but still inside the comment span.
    expect(nodes.map(markup)[1]).toBe('<span class="hljs-comment"></span>')
    expect(joinedText(nodes)).toBe(contents)
  })

  it('carries a nested multi-line span (depth > 1) onto every line it covers', () => {
    // A template substitution nested inside a string, where the INNER span
    // itself spans lines: on the middle line both the outer string and the
    // inner subst clone must be re-opened (a depth-2 carry, not just depth 1).
    const contents = '`a ${/* x\ny\nz */} b`'
    const nodes = highlightLines('javascript', contents)
    expect(nodes).toHaveLength(3)
    const m = nodes.map(markup)
    expect(m[1]).toBe('<span class="hljs-string"><span class="hljs-subst">y</span></span>')
    expect(m[0]).toContain('hljs-subst')
    expect(m[2]).toContain('hljs-subst')
    expect(joinedText(nodes)).toBe(contents)
  })

  it('renders a doctag nested inside a carried multi-line comment on the middle line', () => {
    // The comment span is carried from line 1; the doctag/variable open INSIDE
    // the carried clone on line 2 (depth-2 nesting), never at the line root.
    const contents = '/**\n * @param x\n */'
    const nodes = highlightLines('javascript', contents)
    expect(nodes).toHaveLength(3)
    expect(nodes.map(markup)[1]).toBe(
      '<span class="hljs-comment"> * <span class="hljs-doctag">@param</span> <span class="hljs-variable">x</span></span>',
    )
    expect(joinedText(nodes)).toBe(contents)
  })

  it('round-trips HTML-special characters in the plain-text fallback', () => {
    const contents = '<div> & "x"\n</div>'
    const nodes = highlightLines('xyz', contents)
    expect(nodes).toHaveLength(2)
    // textContent decodes the escaped entities back to the exact source bytes.
    expect(joinedText(nodes)).toBe(contents)
    expect(nodes.map(markup).join('')).not.toContain('hljs-')
    // The whole-block fallback round-trips the same bytes.
    expect(textOf(highlightBlock('xyz', contents))).toBe(contents)
  })

  it('matches the split rule for leading-newline and newline-only contents', () => {
    // split('\n') drops ONLY a phantom final empty segment (a trailing newline);
    // a leading newline keeps its empty first line. [contents, lineCount, joined]
    const cases: Array<[string, number, string]> = [
      ['\na', 2, '\na'],
      ['\n', 1, ''],
      ['\n\n', 2, '\n'],
    ]
    for (const [contents, count, joined] of cases) {
      // Both the highlighted and plain paths must obey the same split rule.
      for (const lang of ['javascript', 'xyz']) {
        const nodes = highlightLines(lang, contents)
        expect(nodes, `lang=${lang} contents=${JSON.stringify(contents)}`).toHaveLength(count)
        expect(joinedText(nodes)).toBe(joined)
      }
    }
  })

  it('falls back to plain text nodes for an unknown language (no throw)', () => {
    const contents = '/* a\nb */'
    const nodes = highlightLines('xyz', contents)
    expect(nodes).toHaveLength(2)
    expect(joinedText(nodes)).toBe(contents)
    expect(nodes.map(markup).join('')).not.toContain('hljs-')
  })

  it('falls back to plain text nodes when lang is undefined (no throw)', () => {
    const contents = 'a\nb'
    const nodes = highlightLines(undefined, contents)
    expect(nodes).toHaveLength(2)
    expect(joinedText(nodes)).toBe(contents)
    expect(nodes.map(markup).join('')).not.toContain('hljs-')
  })

  it('drops the phantom trailing newline (a\\nb\\n -> 2 lines)', () => {
    const nodes = highlightLines('javascript', 'a\nb\n')
    expect(nodes).toHaveLength(2)
    expect(joinedText(nodes)).toBe('a\nb')
  })

  it('keeps two lines when there is no trailing newline (a\\nb -> 2)', () => {
    const nodes = highlightLines('javascript', 'a\nb')
    expect(nodes).toHaveLength(2)
    expect(joinedText(nodes)).toBe('a\nb')
  })

  it('keeps a single empty node for empty contents (matches NumberedCode)', () => {
    const nodes = highlightLines('javascript', '')
    expect(nodes).toHaveLength(1)
    expect(joinedText(nodes)).toBe('')
  })
})

describe('highlightBlock', () => {
  it('highlights the whole text as one block, preserving the source text', () => {
    const contents = 'const x = 1\nreturn x'
    const node = highlightBlock('javascript', contents)
    expect(markup(node)).toContain('hljs-keyword')
    expect(textOf(node)).toBe(contents)
  })

  it('keeps a multi-line comment span intact (no per-line split)', () => {
    const contents = '/* a\nb\nc */'
    const node = highlightBlock('javascript', contents)
    expect(markup(node)).toContain('hljs-comment')
    expect(textOf(node)).toBe(contents)
  })

  it('returns the raw contents string for an unknown language (no throw)', () => {
    const contents = 'const x = 1'
    expect(highlightBlock('xyz', contents)).toBe(contents)
  })

  it('returns the raw contents string when lang is undefined (no throw)', () => {
    const contents = 'const x = 1'
    expect(highlightBlock(undefined, contents)).toBe(contents)
  })
})
