// Per-line syntax highlighting for diff views.
//
// react-markdown / lowlight expects a multi-line code block; we instead
// have one line at a time inside a flex row, each with a marker column.
// This module wraps `lowlight.highlight(lang, line)` and converts the
// resulting hast tree into React elements (spans with `hljs-*` classes
// the existing CSS already styles).
//
// Why not use a fenced code block + react-markdown? Two reasons:
//   1. The diff layout needs marker columns ("+" / "-" / " ") aligned
//      with the highlighted text — markdown rendering doesn't give us
//      that structure.
//   2. Per-line rendering means we can lazily render hidden lines
//      inside <details> without paying the highlight cost up front.
//
// Empty lines or unregistered languages return `null`; the caller is
// expected to fall back to plain text.

import type { ReactNode } from 'react'
import { lowlight, isRegisteredLanguage } from './lowlight-instance'

/** Loose hast-like node so we can walk lowlight's output without pulling
 *  in the full @types/hast dependency tree. */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: string[]; [k: string]: unknown }
  children?: HastNode[]
}

/** Convert a hast subtree into React children. Only handles the two
 *  node types lowlight emits: `text` (string content) and `element`
 *  (always a <span> with hljs-* classes). Anything else is ignored. */
function renderHast(nodes: HastNode[]): ReactNode[] {
  const out: ReactNode[] = []
  let key = 0
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(node.value ?? '')
    } else if (node.type === 'element' && node.tagName === 'span') {
      const className = Array.isArray(node.properties?.className)
        ? node.properties!.className.join(' ')
        : undefined
      out.push(
        <span key={key++} className={className}>
          {node.children ? renderHast(node.children) : null}
        </span>,
      )
    } else if (node.children) {
      // Defensive: walk into anything else we don't recognise.
      out.push(...renderHast(node.children))
    }
  }
  return out
}

/** Highlight a single source line with lowlight; return React children or
 *  null when nothing useful to highlight (empty line, unknown language).
 *
 *  Best-effort by design — diff lines often contain partial syntax (a
 *  truncated string, an unbalanced brace) which lowlight tolerates by
 *  walking until end-of-line. We don't need the result to round-trip
 *  through a parser; we just need *some* token colourisation so the eye
 *  can pick out keywords and identifiers. */
export function highlightLineHast(language: string, line: string): ReactNode | null {
  if (!line) return null
  if (!isRegisteredLanguage(language)) return null
  try {
    const result = lowlight.highlight(language, line)
    const children = (result.children ?? []) as HastNode[]
    if (children.length === 0) return null
    return <>{renderHast(children)}</>
  } catch {
    return null
  }
}
