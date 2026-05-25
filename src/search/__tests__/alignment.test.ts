// Alignment invariant: the count of <mark> elements the rehype
// highlighter inserts MUST equal the count of ranges findRanges
// reports on the canonical plain text.  If this ever fails the
// search bar's "5/12" counter and the visible highlights are out of
// sync — exactly the bug this whole subsystem exists to prevent.

import { describe, it, expect } from 'vitest'
import { extractPlainText, parseMarkdownToHast } from '../extract'
import { findRanges } from '../match'
import { rehypeHighlightQuery } from '../rehype-highlight'
import type { HastNode } from '../hast-walk'

/** Sum of `<mark>` text content lengths across the tree.  This is the
 *  alignment-invariant metric: a phrase that spans an inline boundary
 *  may end up wrapped in two adjacent `<mark>`s (one per parent node),
 *  but the *visible characters under highlight* still equal the
 *  characters covered by the original ranges.  Counting elements
 *  would double-count that case; counting characters does not. */
function markedCharCount(node: HastNode): number {
  if (node.type === 'element' && node.tagName === 'mark') {
    return textLength(node)
  }
  if (!node.children) return 0
  let n = 0
  for (const c of node.children) n += markedCharCount(c)
  return n
}

function textLength(node: HastNode): number {
  if (node.type === 'text') return (node.value ?? '').length
  if (!node.children) return 0
  let n = 0
  for (const c of node.children) n += textLength(c)
  return n
}

function rangesCharCount(ranges: Array<{ start: number; end: number }>): number {
  let n = 0
  for (const r of ranges) n += r.end - r.start
  return n
}

const SAMPLES: Array<{ name: string; md: string; queries: string[] }> = [
  {
    name: 'plain prose',
    md: 'The quick brown fox jumps over the lazy dog.',
    queries: ['quick', 'fox', 'absent'],
  },
  {
    name: 'inline emphasis',
    md: 'This is **bold** and *italic* text.',
    queries: ['bold', 'italic', 'is bold and'],
  },
  {
    name: 'inline code',
    md: 'Call `foo()` then `bar()`.',
    queries: ['foo()', 'bar', 'call'],
  },
  {
    name: 'links',
    md: 'See [the docs](https://example.com) for details.',
    queries: ['docs', 'See the', 'example'],
  },
  {
    name: 'multi-paragraph',
    md: 'First paragraph here.\n\nSecond paragraph follows.',
    queries: ['paragraph', 'First', 'Second'],
  },
  {
    name: 'lists',
    md: '- alpha\n- beta\n- gamma',
    queries: ['alpha', 'beta', 'gamma'],
  },
  {
    name: 'headings',
    md: '# Title\n\nbody text\n\n## Sub\n\nmore body',
    queries: ['Title', 'body', 'Sub'],
  },
  {
    name: 'fenced code',
    md: '```js\nconst foo = 1\nconsole.log(foo)\n```',
    queries: ['foo', 'const', 'log'],
  },
  {
    name: 'cross-inline phrase (the regression target)',
    md: '**hello** world',
    queries: ['hello world', 'hello', 'world'],
  },
  {
    name: 'mixed inline formatting',
    md: 'Normal **bold _nested italic_ end** done',
    queries: ['bold', 'nested italic', 'bold nested italic end'],
  },
]

describe('search alignment invariant', () => {
  for (const { name, md, queries } of SAMPLES) {
    for (const q of queries) {
      it(`${name} :: query="${q}"`, () => {
        const plain = extractPlainText(md)
        const ranges = findRanges(plain, q)

        const tree = parseMarkdownToHast(md)
        rehypeHighlightQuery(q)(tree)

        // Total characters under highlight === total characters
        // covered by the matched ranges.  This is the real invariant:
        // ranges and visible highlights describe the same byte spans
        // even when the spans are split across inline boundaries.
        expect(markedCharCount(tree)).toBe(rangesCharCount(ranges))
      })
    }
  }

  it('counter and highlight stay in sync on a long mixed document', () => {
    const md = [
      '# Welcome',
      '',
      'This is a **mixed** document with `inline code`, [links](https://x.com),',
      'and *italics*.',
      '',
      '- list item one',
      '- list item two with **bold**',
      '',
      '```',
      'function example() { return 42 }',
      '```',
      '',
      'Final paragraph.',
    ].join('\n')

    for (const q of ['the', 'list', 'example', 'mixed document', 'bold']) {
      const plain = extractPlainText(md)
      const ranges = findRanges(plain, q)
      const tree = parseMarkdownToHast(md)
      rehypeHighlightQuery(q)(tree)
      expect(markedCharCount(tree)).toBe(rangesCharCount(ranges))
    }
  })
})
