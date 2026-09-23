// Compiled-markdown LRU. The unified pipeline (remark-parse + gfm + rehype
// + lowlight + search marks) is the dominant cost of mounting an assistant
// row (132ms avg / 416ms max in the whiteout probe). Virtuoso unmounts rows
// on scroll-out, so React.memo never survives — the cache is what makes a
// scroll-back remount a map hit.
//
// Immutable React nodes are safe to share across mounts (same contract as
// diff-highlight's HIGHLIGHT_CACHE).
//
// Storage is BUCKETED by render variant rather than one flat map keyed by
// `variant + source`, for two reasons:
//
//  1. No key allocation. A flat key had to concatenate the whole message body
//     on EVERY call, including cache hits — a multi-hundred-KB assistant reply
//     allocated (and the map then retained) a full copy of itself per lookup.
//     Bucketing puts the variant in the outer key and the source in the inner
//     one, so a hit is a plain `Map.get(source)` with no string building. The
//     source strings are stable references across re-renders, so V8's cached
//     string hash makes repeat lookups cheap.
//
//  2. A search burst can't evict the steady state. `searchQuery` and
//     `activeMatchIdx` are part of the variant, so typing in the find bar
//     compiles a fresh entry per visible row per debounced keystroke. Sharing
//     one LRU with the plain entries meant a ~20-keystroke query flushed the
//     entire cache and every row had to be re-parsed after the search closed.
//     Search variants now live in their own small, separately-capped buckets,
//     and a stale query's bucket is dropped whole (which is what you want —
//     nothing in it is reachable again once the query moves on).

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

type SourceBucket = Map<string, ReactNode>

/** Entries per plain (search-inactive) bucket. There are only two such buckets
 *  — `breaks` off / on — so this is effectively the transcript's cache. */
const PLAIN_CAP = 400
/** Indexed by `breaks ? 1 : 0`. */
const plainBuckets: readonly [SourceBucket, SourceBucket] = [new Map(), new Map()]

/** How many distinct search variants (breaks + activeMatchIdx + query) stay
 *  resident. Small on purpose: only the current query is reachable, the rest
 *  are history. */
const SEARCH_BUCKET_CAP = 8
/** Entries per search bucket — roughly "rows visible during one query". */
const SEARCH_CAP = 60
const searchBuckets = new Map<string, SourceBucket>()

/** Get (or open) the bucket for one search variant, retiring the oldest
 *  variant wholesale once the cap is hit. */
function searchBucketFor(variant: string): SourceBucket {
  let bucket = searchBuckets.get(variant)
  if (bucket) return bucket
  if (searchBuckets.size >= SEARCH_BUCKET_CAP) {
    const oldest = searchBuckets.keys().next().value
    if (oldest !== undefined) searchBuckets.delete(oldest)
  }
  bucket = new Map()
  searchBuckets.set(variant, bucket)
  return bucket
}

/** Evict the oldest entry once a bucket is at its cap. Map iteration order is
 *  insertion order, so `keys().next()` is the oldest. */
function admit(bucket: SourceBucket, cap: number, source: string, tree: ReactNode): void {
  if (bucket.size >= cap) {
    const oldest = bucket.keys().next().value
    if (oldest !== undefined) bucket.delete(oldest)
  }
  bucket.set(source, tree)
}

/** Test-only: drop all cached trees. */
export function clearMarkdownCache(): void {
  plainBuckets[0].clear()
  plainBuckets[1].clear()
  searchBuckets.clear()
}

/** Test-only: total cached entry count across every bucket. */
export function markdownCacheSize(): number {
  let total = plainBuckets[0].size + plainBuckets[1].size
  for (const bucket of searchBuckets.values()) total += bucket.size
  return total
}

/** Test-only: how many distinct search variants are resident. */
export function markdownSearchBucketCount(): number {
  return searchBuckets.size
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

/** Compile markdown to a shareable React tree. Cached per (variant, source). */
export function compileMarkdown(source: string, opts: CompileMarkdownOptions): ReactNode {
  const q = opts.searchQuery?.trim()
  const breaks = opts.breaks === true
  // Only the search path needs a composed variant key, and it is built from
  // small values — never from `source`. See the bucketing note at the top.
  const bucket = q
    ? searchBucketFor(`${breaks ? 1 : 0}|${opts.activeMatchIdx ?? ''}|${q}`)
    : plainBuckets[breaks ? 1 : 0]

  const hit = bucket.get(source)
  if (hit !== undefined) return hit

  const proc = q ? buildSearchProcessor(opts) : getBaseProcessor(breaks)
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

  admit(bucket, q ? SEARCH_CAP : PLAIN_CAP, source, tree)
  return tree
}
