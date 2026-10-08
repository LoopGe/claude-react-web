/**
 * Raw-HTML → literal-text handler for the remark-rehype boundary.
 *
 * remark-rehype's default treatment of mdast `html` nodes is to DROP them:
 * without `allowDangerousHtml` the node produces no hast output at all. A
 * message whose body is one big HTML blob — a pasted DOM dump, say — then
 * parses as a single `html` block and renders as an entirely EMPTY bubble,
 * and the same nodes vanish from the search index.
 *
 * `htmlAsTextHandlers` replaces the default `html` handler so the raw source
 * becomes an inert text node: the markup is visible as literal text (what
 * Markdown.tsx's header comment has always claimed the pipeline does) and
 * nothing is ever parsed into real elements — React escapes text nodes, so
 * `<img onerror>` or `<script>` stay inert. NEVER pass the value through as
 * a `raw` node instead: `raw` is the XSS door this pipeline deliberately
 * keeps shut.
 *
 * CONTRACT: every remark-rehype site in the repo must pass
 * `{ handlers: htmlAsTextHandlers }` — the render pipelines in
 * src/utils/markdown-cache.ts AND the search-index pipeline in
 * shared/search/extract.ts — so the index never drifts from what the bubble
 * renders (the invariant pinned by src/search/__tests__/alignment.test.ts,
 * which carries a raw-HTML sample). A new pipeline that copies the plain
 * `.use(remarkRehype)` idiom silently reopens the blank-bubble/index-drift
 * bug. (A preconfigured wrapper plugin was considered and dropped: unified's
 * `Pluggable` typing rejects the `[remarkRehype, options]` tuple form —
 * remark-rehype exports a bare overloaded function, not a `Plugin` — and
 * wrapping it as a real plugin adds indirection without enforcement.) The
 * map is typed as mdast-util-to-hast's `Handlers`, which checks the key and
 * the return shape HERE at the one definition — the markdown-cache.ts builder
 * chains are `any`-typed and would not catch drift at the call site; the node
 * parameter is typed against mdast's `Html` so the `value` access is checked
 * too (`Handler` itself types the parameter `any`).
 */
import type { Html } from 'mdast'
import type { Handlers, State } from 'mdast-util-to-hast'

function htmlAsText(_state: State, node: Html): { type: 'text'; value: string } {
  return { type: 'text', value: node.value }
}

/** Spread into `remarkRehype`'s options: `.use(remarkRehype, { handlers: htmlAsTextHandlers })`. */
export const htmlAsTextHandlers: Handlers = { html: htmlAsText }
