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
import { lineDiff } from './line-diff.js'

interface SearchableMessage {
  type?: string
  error?: unknown
  message?: unknown
}

interface SearchableBlock {
  type?: unknown
  text?: unknown
  name?: unknown
  input?: unknown
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

/** Split a string into lines the way the diff renderer does ("" → [], "\n" →
 *  ["", ""]). Mirrors DiffChunk's oldLines/newLines derivation so the lines we
 *  count here are exactly the lines rendered there. */
function toLines(s: string): string[] {
  return s === '' ? [] : s.split('\n')
}

/** The del+add lines (the actual modifications) of an Edit, in unified-diff
 *  reading order — the same order DiffChunk renders them. eq (common) lines
 *  are excluded so the count describes only what changed, not the surrounding
 *  fragment. Joined with "\n". */
function editDiffText(oldString: string, newString: string): string {
  const ops = lineDiff(toLines(oldString), toLines(newString))
  const out: string[] = []
  for (const op of ops) {
    if (op.type === 'del' || op.type === 'add') out.push(op.text)
  }
  return out.join('\n')
}

/** Extract the searchable text for a single `tool_use` block's INPUT — the
 *  diff/modification content, in the order the renderer draws it. Returns ''
 *  when the tool carries no searchable diff (Bash/Read/Grep/etc., or a
 *  delete-mode NotebookEdit).
 *
 *  This is the render-side counterpart to what `extractMessagePlainText` adds
 *  to `plainText` for `tool_use` blocks — the offset-walk in MessageList calls
 *  this per-block to rebase the active-match index, so the two MUST stay
 *  aligned: same text, same order. Edit/MultiEdit index only del+add lines
 *  (the modifications) because the rendered Edit diff's context lines come
 *  from async server hunks not available at ingest; Write/NotebookEdit are
 *  pure additions so their full content is indexed. */
export function extractToolUseDiffText(input: unknown, name: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  if (name === 'Edit') {
    const o = typeof i.old_string === 'string' ? i.old_string : ''
    const n = typeof i.new_string === 'string' ? i.new_string : ''
    if (!o && !n) return ''
    return editDiffText(o, n)
  }
  if (name === 'MultiEdit') {
    const edits = i.edits
    if (!Array.isArray(edits)) return ''
    const parts: string[] = []
    for (const e of edits) {
      if (!e || typeof e !== 'object') continue
      const eo = e as Record<string, unknown>
      const o = typeof eo.old_string === 'string' ? eo.old_string : ''
      const n = typeof eo.new_string === 'string' ? eo.new_string : ''
      if (!o && !n) continue
      const t = editDiffText(o, n)
      if (t) parts.push(t)
    }
    return parts.join('\n\n')
  }
  if (name === 'Write') {
    return typeof i.content === 'string' ? i.content : ''
  }
  if (name === 'NotebookEdit') {
    // delete-mode carries no new content to search.
    if (i.edit_mode === 'delete') return ''
    return typeof i.new_source === 'string' ? i.new_source : ''
  }
  return ''
}

/** Extract the searchable plain text for an entire SDK message.
 *
 *  `text`-type content blocks are extracted through the markdown
 *  pipeline.  `tool_result` blocks also contribute — their `content`
 *  field (string or nested text blocks) is extracted as plain text
 *  so tool output (e.g. bash stdout/stderr) is searchable.
 *  `tool_use` blocks contribute their diff/modification text (see
 *  `extractToolUseDiffText`) so code edits are searchable too.
 *
 *  Multiple contributing blocks in the same message are joined
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
      if (b.type === 'text' && typeof b.text === 'string') {
        const text = extractPlainText(b.text)
        if (text) parts.push(text)
      } else if (b.type === 'tool_result') {
        // tool_result content can be a string or an array of nested blocks.
        const rc = (b as { content?: unknown }).content
        if (typeof rc === 'string') {
          const text = extractPlainText(rc)
          if (text) parts.push(text)
        } else if (Array.isArray(rc)) {
          for (const inner of rc as SearchableBlock[]) {
            if (inner.type === 'text' && typeof inner.text === 'string') {
              const text = extractPlainText(inner.text)
              if (text) parts.push(text)
            }
          }
        }
      } else if (b.type === 'tool_use') {
        const text = extractToolUseDiffText(b.input, b.name)
        if (text) parts.push(text)
      }
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
