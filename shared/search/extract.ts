// Canonical "markdown -> plain searchable text" extractor.
//
// MUST stay aligned with what react-markdown actually renders.  We
// guarantee that by running the same unified pipeline (remark-parse +
// remark-gfm + remark-rehype) and walking the resulting hast tree
// through the SAME walker the rehype highlight plugin uses at render
// time.  An alignment test in __tests__/alignment.test.ts asserts
// the contract holds against a representative sample of markdown.

import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'

import { flattenHast, type HastNode } from './hast-walk.js'

interface SearchableMessage {
  type?: string
  error?: unknown
  message?: unknown
}

interface SearchableBlock {
  type?: unknown
  text?: unknown
}

/** Lazy-built processor.  Parsing is synchronous; we keep one
 *  shared instance because the compiled pipeline is non-trivial to
 *  build and is fully reusable across calls. */
let _processor: Processor | null = null
function getProcessor(): Processor {
  if (_processor) return _processor
  _processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype) as unknown as Processor
  return _processor
}

/** Build the canonical hast tree for a markdown source.  Used by
 *  both the extractor here and the alignment test (which compares
 *  the result against react-markdown's own output). */
export function parseMarkdownToHast(markdown: string): HastNode {
  const proc = getProcessor()
  const mdast = proc.parse(markdown)
  const hast = proc.runSync(mdast) as unknown as HastNode
  return hast
}

/** Extract the canonical plain-text view of a markdown string.  The
 *  result has all markdown syntax characters stripped and block
 *  boundaries collapsed to single newlines — i.e. what the user
 *  would see if they selected the rendered output and copied it. */
export function extractPlainText(markdown: string): string {
  if (!markdown) return ''
  try {
    return flattenHast(parseMarkdownToHast(markdown))
  } catch {
    // Pathological markdown that crashes the parser shouldn't break
    // ingest — fall back to the raw source.  An exact alignment with
    // the rehype highlighter is preferred but the user still gets a
    // searchable string.
    return markdown
  }
}

/** Extract the searchable plain text for an entire SDK message.
 *
 *  Per the design decision: only `text`-type content blocks
 *  contribute; tool_use / tool_result / image / thinking blocks are
 *  excluded.  Multiple text blocks in the same message are joined
 *  with a double newline so cross-block phrase matches don't fire
 *  (and so paragraph separation reads naturally to the user). */
export function extractMessagePlainText(msg: SearchableMessage): string | null {
  const message = msg.message
  const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : undefined
  if (typeof content === 'string') {
    const text = extractPlainText(content)
    return text || null
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content as SearchableBlock[]) {
      if (b.type !== 'text' || typeof b.text !== 'string') continue
      const text = extractPlainText(b.text)
      if (text) parts.push(text)
    }
    return parts.length ? parts.join('\n\n') : null
  }
  // System error frames carry their text in a different field — keep
  // searching them for parity with the previous extractor.
  if (msg.type === 'system' && typeof msg.error === 'string') {
    return msg.error || null
  }
  return null
}
