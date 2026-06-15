// Canonical hast walker — the single source of truth for "what
// characters does a hast tree expose to search?".  Both extract.ts
// (ingest-time flattening) and rehype-highlight.ts (render-time
// splicing) drive their work through this walker so the offsets they
// see are guaranteed to agree.
//
// The canonical view inserts a virtual `\n` separator at the boundary
// of any block-level element (p, li, h1-h6, etc.) so that:
//   1. plainText reads naturally — paragraphs are line-separated.
//   2. A regex with the default `.` semantics will not span block
//      boundaries (avoids spurious cross-paragraph matches).
//
// Inline elements (em/strong/code/a/...) emit no separator: a phrase
// like "**hello** world" flattens to "hello world" so a query for
// "hello world" matches in one piece, fixing the cross-node hole the
// previous per-text-node regex couldn't reach.

/** Loose hast-like node shape.  We avoid importing the full hast type
 *  union to keep this module self-contained — every consumer (rehype
 *  plugins, our own extractor) only needs these fields. */
export interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: string[] | string;[k: string]: unknown }
  children?: HastNode[]
}

/** Tags that introduce a visual line break.  When the walker enters
 *  one of these (and we're not at the very start of the document) we
 *  emit a virtual `\n` *before* descending into its children.
 *
 *  `br` is special: it's a void inline tag — no children — so we emit
 *  the separator on entry and skip the descend. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'hr', 'br',
  // Note: <code> is intentionally NOT in this set so inline code
  //       (e.g. `foo`) flattens flush against surrounding text.
  //       Fenced code blocks live inside <pre> which IS a block.
])

/** Tags whose entire subtree is excluded from the search corpus.
 *  Empty by default — code blocks ARE searchable per the design
 *  decision in CLAUDE.md follow-up — but kept as an extension point
 *  so a future toggle (e.g. "skip code") just needs to add to this
 *  set on both walkers. */
const SKIP_SUBTREE_TAGS = new Set<string>([])

/** Event emitted by `walkSearchable` for each piece of the corpus.
 *  `text` events carry the node + parent + index so callers (the
 *  rehype highlighter) can splice replacements back into the tree.
 *  `separator` events have no node — they're virtual characters
 *  contributed by block boundaries. */
export type WalkEvent =
  | {
      type: 'text'
      node: HastNode
      parent: HastNode
      index: number
      offset: number
      text: string
    }
  | {
      type: 'separator'
      offset: number
      text: string
    }

/** A text node is "structural whitespace" if it contains only ASCII
 *  whitespace AND at least one newline.  These come from the source
 *  markdown's indentation/inter-block newlines that remark-rehype
 *  preserves as text siblings between block elements (e.g. a `<ul>`
 *  with three `<li>`s ends up with `"\n"` text nodes between each
 *  item).  They contribute zero search-relevant content — block
 *  separation is already handled by the virtual separator below.
 *
 *  IMPORTANT: a text node containing only spaces (no `\n`) is NOT
 *  structural — it's the meaningful whitespace between two inline
 *  elements like "[a](u) [b](u)" → `<a>a</a>" "<a>b</a>`.  Dropping
 *  that would silently glue inline siblings together. */
function isStructuralWhitespace(text: string): boolean {
  if (text.length === 0) return false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // 9=\t 10=\n 13=\r 32=space
    if (c !== 9 && c !== 10 && c !== 13 && c !== 32) return false
  }
  return text.includes('\n')
}

/** Walk a hast tree in document order, emitting one event per text
 *  node and one event per virtual block-boundary separator.  The
 *  walker NEVER mutates the tree — callers that want to splice must
 *  collect events first and apply changes in a second pass (the
 *  index stored on each text event becomes stale once any sibling
 *  has been spliced).
 *
 *  Two normalisations keep the canonical view tidy:
 *
 *    - Virtual separators are deduplicated: if the previous emit
 *      already ended with `\n`, a redundant separator is skipped.
 *      This collapses sequences like `<ul>` → `<li>` (two nested
 *      block opens) into a single newline.
 *
 *    - Structural-whitespace text nodes are dropped (see
 *      `isStructuralWhitespace`).  They're an artefact of how
 *      remark-rehype preserves source-markdown layout and contain
 *      no user-visible content. */
export function walkSearchable(
  tree: HastNode,
  emit: (event: WalkEvent) => void,
): void {
  let offset = 0
  let lastChar = ''

  function pushSeparator(): void {
    if (lastChar === '\n') return
    emit({ type: 'separator', offset, text: '\n' })
    offset += 1
    lastChar = '\n'
  }

  function go(node: HastNode, parent: HastNode | null, indexInParent: number): void {
    if (node.type === 'text') {
      const text = node.value ?? ''
      if (text.length === 0 || parent == null) return
      if (isStructuralWhitespace(text)) return
      emit({ type: 'text', node, parent, index: indexInParent, offset, text })
      offset += text.length
      lastChar = text.charAt(text.length - 1)
      return
    }

    if (node.type !== 'element' && node.type !== 'root') return

    const tag = node.tagName ?? ''
    if (node.type === 'element' && SKIP_SUBTREE_TAGS.has(tag)) return

    const isBlock = node.type === 'element' && BLOCK_TAGS.has(tag)
    // Emit separator BEFORE descending — guarded by offset>0 so the
    // very first block doesn't get a leading newline, and by the
    // lastChar dedup inside pushSeparator so nested blocks (e.g.
    // <ul> wrapping <li>s) only contribute one newline between
    // peers.
    if (isBlock && offset > 0) pushSeparator()

    // <br> is a void element — no children to descend into.  The
    // separator above is the entire contribution.
    if (tag === 'br') return

    const children = node.children
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      go(children[i], node, i)
    }
  }

  go(tree, null, 0)
}

/** Convenience: flatten the searchable text of a hast tree to a single
 *  string.  Identical to concatenating the `text` field of every event
 *  emitted by `walkSearchable`. */
export function flattenHast(tree: HastNode): string {
  const parts: string[] = []
  walkSearchable(tree, (e) => {
    parts.push(e.text)
  })
  return parts.join('')
}
