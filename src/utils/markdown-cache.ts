// Compiled-markdown LRU. The unified pipeline (remark-parse + gfm + rehype
// + lowlight + search marks) is the dominant cost of mounting an assistant
// row (132ms avg / 416ms max in the whiteout probe). Virtuoso unmounts rows
// on scroll-out, so React.memo never survives — the cache is what makes a
// scroll-back remount a map hit.
//
// Keyed by (source, breaks, searchQuery, activeMatchIdx). Immutable React
// nodes are safe to share across mounts (same contract as diff-highlight's
// HIGHLIGHT_CACHE).

import { Fragment, type ReactNode } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkRehype from 'remark-rehype'
import { toJsxRuntime, type Options as ToJsxOptions } from 'hast-util-to-jsx-runtime'
import { rehypeStripStructuralWhitespace } from '../../shared/search/rehype-strip-structural-whitespace'
import { rehypeHighlightLite } from '../components/markdown-highlight'
import { rehypeHighlightQuery } from '../search'
import { MD_COMPONENTS } from '../components/markdown-components'

export interface CompileMarkdownOptions {
  breaks?: boolean
  searchQuery?: string
  activeMatchIdx?: number
}

const CACHE_CAP = 400
const cache = new Map<string, ReactNode>()

function cacheKey(source: string, opts: CompileMarkdownOptions): string {
  return `${opts.breaks ? 1 : 0}|${opts.activeMatchIdx ?? ''}|${opts.searchQuery ?? ''}|${source}`
}

/** Test-only: drop all cached trees. */
export function clearMarkdownCache(): void {
  cache.clear()
}

/** Test-only: current entry count. */
export function markdownCacheSize(): number {
  return cache.size
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const processors = new Map<string, any>()
/**
 * A unified processor is frozen at first `parse()` — `.use()` after that
 * throws. So the cacheable (non-search) pipeline is a stable singleton, and
 * the search path (query + active idx vary) builds a throwaway processor per
 * cache miss. Processor build is cheap next to parse+lowlight; the LRU of
 * OUTPUT trees is where the win is.
 */
function getBaseProcessor(breaks: boolean) {
  const key = breaks ? 'breaks' : 'plain'
  let proc = processors.get(key)
  if (!proc) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let p: any = unified().use(remarkParse).use(remarkGfm)
    if (breaks) p = p.use(remarkBreaks)
    proc = p
      .use(remarkRehype)
      .use(rehypeStripStructuralWhitespace)
      .use(rehypeHighlightLite)
    processors.set(key, proc)
  }
  return proc
}

function buildSearchProcessor(opts: CompileMarkdownOptions) {
  const q = opts.searchQuery!.trim()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any = unified().use(remarkParse).use(remarkGfm)
  if (opts.breaks) p = p.use(remarkBreaks)
  return p
    .use(remarkRehype)
    .use(rehypeStripStructuralWhitespace)
    .use(rehypeHighlightLite)
    // Attacher wrap mirrors Markdown.tsx (rehypeHighlightQuery returns a
    // transformer, unified wants an attacher).
    .use(() => rehypeHighlightQuery(q, opts.activeMatchIdx))
}

/** Compile markdown to a shareable React tree. Cached per (source, opts). */
export function compileMarkdown(source: string, opts: CompileMarkdownOptions): ReactNode {
  const key = cacheKey(source, opts)
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const q = opts.searchQuery?.trim()
  const proc = q ? buildSearchProcessor(opts) : getBaseProcessor(opts.breaks === true)
  const mdast = proc.parse(source)
  const hast = proc.runSync(mdast)

  const tree = toJsxRuntime(hast as never, {
    Fragment,
    jsx,
    jsxs,
    components: MD_COMPONENTS as ToJsxOptions['components'],
    elementAttributeNameCase: 'react',
    stylePropertyNameCase: 'css',
  })

  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, tree)
  return tree
}
