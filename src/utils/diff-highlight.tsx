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
import { rehypeHighlightQuery } from '../search'

/** Loose hast-like node so we can walk lowlight's output without pulling
 *  in the full @types/hast dependency tree. */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: string[]; [k: string]: unknown }
  children?: HastNode[]
}

/** Convert a hast subtree into React children. Handles the node types lowlight
 *  emits (`text`, `<span>` with hljs-* classes) plus the `<mark>` elements the
 *  search-highlight transformer (`rehypeHighlightQuery`) splices in
 *  (`search-hl` / `search-hl-active`). Anything else is walked into defensively. */
function renderHast(nodes: HastNode[]): ReactNode[] {
  const out: ReactNode[] = []
  let key = 0
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(node.value ?? '')
    } else if (node.type === 'element' && (node.tagName === 'span' || node.tagName === 'mark')) {
      const className = Array.isArray(node.properties?.className)
        ? node.properties!.className.join(' ')
        : undefined
      // Render <mark> as a real <mark> — the search-hl CSS targets
      // `mark.search-hl` (element selector), so a <span> wouldn't match.
      const Tag = node.tagName as 'span' | 'mark'
      out.push(
        <Tag key={key++} className={className}>
          {node.children ? renderHast(node.children) : null}
        </Tag>,
      )
    } else if (node.children) {
      // Defensive: walk into anything else we don't recognise.
      out.push(...renderHast(node.children))
    }
  }
  return out
}

/** Module-level memo cache for highlighted lines. Diff lines repeat heavily
 *  across files and messages (blank lines, `}`, `import …`, common keywords),
 *  so caching by (language, line)摊薄掉重复高亮成本 — even when a parent
 *  re-render or a non-memoized call site bypasses React's own memoization.
 *
 *  The cached value is an immutable React element tree (or null), which is
 *  safe to reuse across many render sites. Bounded to avoid unbounded growth
 *  on long sessions; oldest entry is evicted when the cap is hit. */
const HIGHLIGHT_CACHE = new Map<string, ReactNode | null>()
const HIGHLIGHT_CACHE_MAX = 2000

/** Highlight a single source line with lowlight; return React children or
 *  null when nothing useful to highlight (empty line, unknown language).
 *
 *  When `query` is given, search matches are additionally wrapped in
 *  `<mark class="search-hl">` (the `activeMatchIdx`-th one gets
 *  `search-hl-active`) by running the same `rehypeHighlightQuery` transformer
 *  the Markdown path uses, on lowlight's hast. The result composes syntax
 *  colouring with search marks. The (language, line) cache is bypassed while
 *  searching — the cache key doesn't include query/active, and re-using a
 *  non-search cached tree would drop the marks.
 *
 *  Best-effort by design — diff lines often contain partial syntax (a
 *  truncated string, an unbalanced brace) which lowlight tolerates by
 *  walking until end-of-line. We don't need the result to round-trip
 *  through a parser; we just need *some* token colourisation so the eye
 *  can pick out keywords and identifiers. */
export function highlightLineHast(
  language: string | null,
  line: string,
  query?: string,
  activeMatchIdx?: number,
): ReactNode | null {
  if (!line) return null
  const q = query?.trim()
  // `language && isRegisteredLanguage(language)` narrows language to string
  // for the lowlight calls below (lowlight.highlight requires a string).
  const lang = language != null && isRegisteredLanguage(language) ? language : null

  if (!q) {
    // No search query — syntax-only, cached. No marks for unknown languages.
    if (!lang) return null
    const cacheKey = `${lang}\n${line}`
    const cached = HIGHLIGHT_CACHE.get(cacheKey)
    if (cached !== undefined) return cached

    let value: ReactNode | null = null
    try {
      const result = lowlight.highlight(lang, line)
      const children = (result.children ?? []) as HastNode[]
      value = children.length === 0 ? null : <>{renderHast(children)}</>
    } catch {
      value = null
    }

    if (HIGHLIGHT_CACHE.size >= HIGHLIGHT_CACHE_MAX) {
      const oldest = HIGHLIGHT_CACHE.keys().next().value
      if (oldest !== undefined) HIGHLIGHT_CACHE.delete(oldest)
    }
    HIGHLIGHT_CACHE.set(cacheKey, value)
    return value
  }

  // Search active. If the language is registered, compose syntax colouring
  // with <mark>s by running the search transformer on lowlight's hast tree
  // (the transformer takes the ROOT node — it walks root.children, so passing
  // the children array directly would miss). For unregistered languages,
  // still wrap matches on the plain text so search works on every diff line.
  if (lang) {
    try {
      const result = lowlight.highlight(lang, line)
      rehypeHighlightQuery(q, activeMatchIdx)(result)
      const children = (result.children ?? []) as HastNode[]
      return children.length === 0 ? null : <>{renderHast(children)}</>
    } catch {
      return null
    }
  }
  const tree: HastNode = { type: 'root', children: [{ type: 'text', value: line }] }
  try {
    rehypeHighlightQuery(q, activeMatchIdx)(tree)
  } catch {
    return line
  }
  const children = (tree.children ?? []) as HastNode[]
  return children.length === 0 ? line : <>{renderHast(children)}</>
}
