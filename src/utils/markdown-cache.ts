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
//     Search variants now live in their own separately-capped buckets, retired
//     least-recently-USED (see searchBucketFor for why insertion order is the
//     wrong policy here).
//
// Capping is per bucket, so there is no single global bound; the worst case is
// 2 × PLAIN_CAP + SEARCH_BUCKET_CAP × SEARCH_CAP entries. Both plain buckets
// really are live at once (MessageView passes `breaks` for user messages and
// not for assistant ones), and nothing drops the search buckets when the find
// bar closes — they age out as later queries arrive. That is a deliberately
// looser envelope than the single flat cap it replaces: one shared number for
// two workloads with different lifetimes is what produced the eviction problem
// above. The entries are immutable React trees that the mounted rows are
// holding anyway in the common case.

import { Fragment, type ReactNode } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
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
/** Entries per search bucket. Sized for "the rows you can scroll through while
 *  one query is active" — note entries are compiled BLOCKS, and one row can
 *  hold several, so this is nearer 40 rows than 120. */
const SEARCH_CAP = 120
const searchBuckets = new Map<string, SourceBucket>()

/**
 * Get (or open) the bucket for one search variant, retiring the LEAST RECENTLY
 * USED variant once the cap is hit.
 *
 * Recency, not insertion order, and that distinction is the whole point here.
 * `activeMatchIdx` is part of the variant, and only the row holding the active
 * match carries one — every OTHER visible row compiles under the same
 * `…|''|query` variant. So a single query's working set splits into one big
 * bucket (all the non-active rows, created first) plus one small bucket per
 * match the user steps onto. Under FIFO the big bucket is the oldest and would
 * be the first evicted, i.e. the eviction order was the exact inverse of value:
 * navigating through 8 matches in one match-dense message would drop the bucket
 * every other row on screen is reading from. Re-inserting on access keeps it
 * hot, because every render touches it.
 */
function searchBucketFor(variant: string): SourceBucket {
  const existing = searchBuckets.get(variant)
  if (existing) {
    // Move to the young end: Map iteration is insertion-ordered, so delete +
    // re-set is how you express "touched" with a plain Map.
    searchBuckets.delete(variant)
    searchBuckets.set(variant, existing)
    return existing
  }
  if (searchBuckets.size >= SEARCH_BUCKET_CAP) {
    const lru = searchBuckets.keys().next().value
    if (lru !== undefined) searchBuckets.delete(lru)
  }
  const bucket: SourceBucket = new Map()
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
 * KaTeX options shared by both pipelines. `strict: false` silences katex's
 * console warnings for non-standard-but-renderable LaTeX (models freely mix
 * Unicode/CJK into math). `errorColor` is a CSS var because katex colors
 * parse errors via an INLINE style on the error spans — the stylesheet can't
 * reach them (a class rule would be dead CSS), but a var() resolves fine
 * inline and follows the theme. `trust` stays false (default): `\href` etc.
 * are inert, matching the no-raw-HTML stance in Markdown.tsx.
 */
const KATEX_OPTIONS = { strict: false, errorColor: 'var(--danger-text)' } as const

/**
 * A unified processor is frozen at first `parse()` — `.use()` after that
 * throws. So the cacheable (non-search) pipeline is a stable singleton, and
 * the search path (query + active idx vary) builds a throwaway processor per
 * cache miss. Processor build is cheap next to parse+lowlight; the LRU of
 * OUTPUT trees is where the win is.
 *
 * Math plugin placement: remark-math sits right after remark-gfm at the
 * remark layer (its math nodes carry content in `node.value`, so
 * remark-breaks' unconditional text-node newline→<br> walk can never corrupt
 * a formula). rehype-katex runs after the whitespace strip and BEFORE
 * rehypeHighlightLite so lowlight never sees the `language-math` code
 * handoff. In the SEARCH path katex runs LAST — after the query marker — so
 * search marks land on raw LaTeX and are then replaced wholesale; injecting
 * marks into katex's span tree would break its kerning/positioning. The
 * cost: a match inside a formula counts (ingest keeps raw LaTeX) but is not
 * visually marked.
 */
function getBaseProcessor(breaks: boolean) {
  const key = breaks ? 'breaks' : 'plain'
  let proc = processors.get(key)
  if (!proc) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let p: any = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
    if (breaks) p = p.use(remarkBreaks)
    proc = p
      .use(remarkRehype)
      .use(rehypeStripStructuralWhitespace)
      .use(rehypeKatex, KATEX_OPTIONS)
      .use(rehypeHighlightLite)
    processors.set(key, proc)
  }
  return proc
}

function buildSearchProcessor(opts: CompileMarkdownOptions) {
  const q = opts.searchQuery!.trim()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  if (opts.breaks) p = p.use(remarkBreaks)
  return p
    .use(remarkRehype)
    .use(rehypeStripStructuralWhitespace)
    .use(rehypeHighlightLite)
    // Attacher wrap mirrors Markdown.tsx (rehypeHighlightQuery returns a
    // transformer, unified wants an attacher).
    .use(() => rehypeHighlightQuery(q, opts.activeMatchIdx))
    // Katex last: see the math-placement note on getBaseProcessor.
    .use(rehypeKatex, KATEX_OPTIONS)
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
