// Cross-node-aware search highlighter.
//
// The previous implementation regex'd each text node independently,
// which silently dropped any phrase that straddled two text nodes
// (e.g. "**hello** world" with query "hello world" — the rendered
// markup splits "hello" and " world" into separate text nodes).
//
// This plugin instead works in three stages:
//
//   1. Walk the hast tree and flatten it into a single canonical
//      string (the same view extract.ts builds at ingest time).
//   2. Run the regex once on that flat string to find ALL matches,
//      including ones that span node boundaries.
//   3. Walk the tree a second time, slicing text nodes wherever a
//      match starts or ends and inserting <mark> elements for the
//      portions that fall inside a match.
//
// A phrase that genuinely spans two nodes ends up wrapped as two
// adjacent <mark>s — visually contiguous because the CSS background
// is set on `.search-hl`, not on the parent node.

import { findRanges } from './match'
import { walkSearchable, type HastNode, type WalkEvent } from './hast-walk'
import type { Range } from './types'

/** A planned splice to apply after the second walk completes.  We
 *  collect these instead of mutating during traversal because the
 *  walker uses sibling indices that go stale once we touch the
 *  array. */
interface Splice {
  parent: HastNode
  index: number
  newChildren: HastNode[]
}

/** Slice a single text node's contents into an alternating sequence
 *  of plain text and <mark> elements according to which character
 *  ranges fall inside the node.  Returns null if no part of the node
 *  is highlighted (caller can skip the splice entirely). */
function buildHighlightedChildren(
  text: string,
  nodeStart: number,
  ranges: Range[],
): HastNode[] | null {
  const nodeEnd = nodeStart + text.length

  // Binary search would be tighter, but message-level range counts
  // are small in practice — a linear filter is easier to read and
  // the constant factor wins for typical N.
  const overlapping: Range[] = []
  for (const r of ranges) {
    if (r.end <= nodeStart) continue
    if (r.start >= nodeEnd) break
    overlapping.push(r)
  }
  if (overlapping.length === 0) return null

  const out: HastNode[] = []
  let cursor = 0
  for (const r of overlapping) {
    const localStart = Math.max(0, r.start - nodeStart)
    const localEnd = Math.min(text.length, r.end - nodeStart)
    if (localStart < cursor) continue // overlap with previous mark — shouldn't happen with non-overlapping ranges, but skip defensively
    if (localStart > cursor) {
      out.push({ type: 'text', value: text.slice(cursor, localStart) })
    }
    out.push({
      type: 'element',
      tagName: 'mark',
      properties: { className: ['search-hl'] },
      children: [{ type: 'text', value: text.slice(localStart, localEnd) }],
    })
    cursor = localEnd
  }
  if (cursor < text.length) {
    out.push({ type: 'text', value: text.slice(cursor) })
  }
  return out
}

/** Apply a list of planned splices.  Order matters: within a single
 *  parent we must splice from the END backwards so earlier indices
 *  remain valid.  Across parents the order is irrelevant.  We bucket
 *  by parent identity to avoid an O(N²) sort over the whole list. */
function applySplices(splices: Splice[]): void {
  const byParent = new Map<HastNode, Splice[]>()
  for (const s of splices) {
    let bucket = byParent.get(s.parent)
    if (!bucket) {
      bucket = []
      byParent.set(s.parent, bucket)
    }
    bucket.push(s)
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => b.index - a.index)
    for (const { parent, index, newChildren } of bucket) {
      parent.children!.splice(index, 1, ...newChildren)
    }
  }
}

/** rehype plugin: highlight every match of `query` in the rendered
 *  hast tree.  Always recomputes its own range list from the tree
 *  it receives so the visible highlights are guaranteed to match
 *  what the user actually sees, regardless of any drift between
 *  ingest-time plain-text extraction and react-markdown's render. */
export function rehypeHighlightQuery(query: string) {
  const trimmed = query.trim()
  return (tree: unknown): void => {
    if (!trimmed) return

    // Stage 1: flatten the tree, tracking each text node's offset
    // in the canonical string.  We keep the WalkEvents around so
    // stage 3 can replay them without re-walking.
    const events: WalkEvent[] = []
    let flat = ''
    walkSearchable(tree as HastNode, (e) => {
      events.push(e)
      flat += e.text
    })
    if (!flat) return

    // Stage 2: find every match in the flat string.
    const ranges = findRanges(flat, trimmed)
    if (ranges.length === 0) return

    // Stage 3: replay the events; for each text event compute the
    // splice (if any) and queue it.  Separator events carry no node
    // and are skipped — their virtual characters were only there to
    // keep cross-block matches from happening at all.
    const splices: Splice[] = []
    for (const e of events) {
      if (e.type !== 'text') continue
      const newChildren = buildHighlightedChildren(e.text, e.offset, ranges)
      if (newChildren) {
        splices.push({ parent: e.parent, index: e.index, newChildren })
      }
    }
    applySplices(splices)
  }
}
