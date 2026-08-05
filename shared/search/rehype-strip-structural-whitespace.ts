// Rehype plugin: remove structural-whitespace text nodes from the hast tree.
//
// remark-rehype preserves the source markdown's inter-block newlines as text
// nodes between block elements (e.g. `<p>a</p>"\n"<p>b</p>`), and
// remark-breaks leaves a `"\n"` text node immediately after every `<br>` it
// inserts. Under the browser's default `white-space: normal` these collapse
// to a single space and are invisible. But `.md` prose uses
// `white-space: pre-wrap` (so tabs and indentation render), and pre-wrap
// renders every `\n` — so those structural newlines show up as extra blank
// lines between blocks, and as a doubled line break after each `<br>`.
//
// This plugin strips them so pre-wrap shows only the whitespace the sender
// actually typed. It removes exactly the text nodes the search walker already
// skips via `isStructuralWhitespace` (imported from hast-walk.ts, shared so
// the two never diverge), so it has ZERO effect on the canonical searchable
// text — ingest and render stay byte-aligned. A whitespace-only text node
// with NO newline (e.g. the space between two inline links `[a](u) [b](u)`)
// is meaningful and is left alone, matching the walker's rule.
//
// `<pre>` subtrees are skipped entirely: newlines inside code blocks are
// content, not structural whitespace.
//
// Shared by the render pipeline (src/components/Markdown.tsx) and the ingest
// pipeline (shared/search/extract.ts) so both see the same tree shape.

import { isStructuralWhitespace, type HastNode } from './hast-walk.js'

export function rehypeStripStructuralWhitespace(): (tree: HastNode) => void {
  return (tree: HastNode) => {
    const walk = (node: HastNode): void => {
      // Skip <pre> subtrees — newlines inside code blocks are content.
      if (node.type === 'element' && node.tagName === 'pre') return
      const children = node.children
      if (!children) return
      // Filter out structural-whitespace text nodes in place.
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i]
        if (child.type === 'text' && isStructuralWhitespace(child.value ?? '')) {
          children.splice(i, 1)
        } else {
          walk(child)
        }
      }
    }
    walk(tree)
  }
}
