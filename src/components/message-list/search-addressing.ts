// Row-level search match space: every rendered member's own segments PLUS
// the tool_result payloads merged into their tool cards. A folded group row
// renders all its members, and a result consumed into a card no longer
// renders as a standalone user row — both kinds of match must be counted on
// the OWNING row, otherwise the row never receives the query (no passive
// marks) and a closed group never force-opens on a member-only hit.
//
// The count is a SUM over the row's match space; mapping a navigation ordinal
// back to a specific renderer is a separate concern (the ordinal walk).

import type { SdkMessage } from '../../types'
import type { ToolResultEntry } from '../../session-store/types'
import { countCachedMessageSearchMatches, extractToolUseId, getBlocks } from '../../session-store/normalize'
import { countMatches } from '../../../shared/search/match.js'
import { extractPlainText, extractToolUseDiffText } from '../../../shared/search/extract.js'
import { toolResultTextRuns } from '../../../shared/tool-result-text.js'

/** Total search matches owned by one transcript row. A folded group row
 *  renders ALL its members, so the match space sums each member's own cached
 *  segments (markdown text, attachment names, tool_use diffs — and a user
 *  tool_result row's raw runs) over `members ?? [msg]` — the head is
 *  members[0], counted exactly once — plus, for every tool_use id in block
 *  order whose result has landed in `toolResults`, the matches over that
 *  result's rendered text runs (the single view from shared/tool-result-text).
 *  User rows carry no tool_use blocks, so their own tool_result segments are
 *  never double-counted through the map. */
export function rowSearchMatchCount(
  msg: SdkMessage,
  members: readonly SdkMessage[] | undefined,
  toolResults: ReadonlyMap<string, ToolResultEntry>,
  query: string,
): number {
  let count = 0
  for (const member of members ?? [msg]) {
    count += countCachedMessageSearchMatches(member, query)
    for (const block of getBlocks(member)) {
      if (block.type !== 'tool_use') continue
      const id = extractToolUseId(block)
      if (!id) continue
      const entry = toolResults.get(id)
      if (!entry) continue
      for (const run of toolResultTextRuns(entry.content)) {
        count += countMatches(run, query)
      }
    }
  }
  return count
}

/** Per-block active-match routing for a tool-only group member (the fold
 *  contract in transcript-rows.ts — its visible content is tool_use blocks only,
 *  possibly SEVERAL parallel calls). Returns one `{ diffIdx, resultIdx }` entry
 *  per tool_use block, in block order; only the block that owns the active
 *  ordinal carries a number, every other entry stays undefined — so the group
 *  lights exactly one card, never a shared pair broadcast across the member.
 *
 *  The match space is the SAME segments-then-results space as rowSearchMatchCount
 *  and assistantResultIdxByBlock: the member's own segments first (the tool_use
 *  diffs, in block order), THEN the consumed results' rendered-run matches (in
 *  tool_use block order). Two passes subtract those counts until the ordinal
 *  falls inside one segment, recording it on the OWNING block's entry:
 *   - inside a diff  → that entry's `diffIdx` (diff-local, the Nth match of the
 *     tool_use's indexed del+add text);
 *   - inside a result → that entry's `resultIdx` (result-global across that id's
 *     runs, the coordinate ToolResultDetails rebases per run).
 *  Past the end of the space (or a result that has not landed) every entry is
 *  undefined. Counts use the SAME views as the renderers and rowSearchMatchCount
 *  (extractToolUseDiffText / toolResultTextRuns + countMatches), so the routed
 *  mark is exactly the one the count layer attributed to this member. */
export function memberBlockOrdinals(
  memberMsg: SdkMessage,
  toolResults: ReadonlyMap<string, ToolResultEntry>,
  ordinal: number,
  query: string,
): Array<{ diffIdx: number | undefined; resultIdx: number | undefined }> {
  const toolBlocks = getBlocks(memberMsg).filter((b) => b.type === 'tool_use')
  const out: Array<{ diffIdx: number | undefined; resultIdx: number | undefined }> =
    toolBlocks.map(() => ({ diffIdx: undefined, resultIdx: undefined }))
  let remaining = ordinal
  // Pass 1 — own segments: the tool_use diffs, in block order.
  for (let i = 0; i < toolBlocks.length; i++) {
    const b = toolBlocks[i]
    const diffN = countMatches(extractToolUseDiffText(b.input, b.name), query)
    if (remaining < diffN) {
      out[i].diffIdx = remaining
      return out
    }
    remaining -= diffN
  }
  // Pass 2 — consumed results, in tool_use block order.
  for (let i = 0; i < toolBlocks.length; i++) {
    const b = toolBlocks[i]
    const id = extractToolUseId(b)
    const entry = id ? toolResults.get(id) : undefined
    if (!entry) continue
    let n = 0
    for (const run of toolResultTextRuns(entry.content)) n += countMatches(run, query)
    if (n === 0) continue
    if (remaining < n) {
      out[i].resultIdx = remaining
      return out
    }
    remaining -= n
  }
  return out
}

/** Per-block result-global active-match routing for a NON-folded assistant row
 *  (which may carry several parallel tool_use blocks). Returns one entry per
 *  content block in order; only the tool_use block whose consumed result holds
 *  the active ordinal gets a number (the result-global index across that id's
 *  runs, the coordinate ToolResultDetails rebases per run) — every other entry
 *  is undefined, so exactly one card lights the active mark.
 *
 *  The walk follows the SAME attribution order as rowSearchMatchCount and
 *  blockActiveIdx: the row's own segments first (text blocks + tool_use diffs,
 *  in block order), THEN the consumed results (in tool_use block order). That
 *  order is what the navigation ordinal is counted against, and it keeps this
 *  walk in lockstep with blockActiveIdx's diff routing: an ordinal that lands
 *  in a text block or a diff leaves EVERY entry undefined (those marks are
 *  blockActiveIdx's), and only an ordinal past all own segments routes into a
 *  result. Out of range → all undefined. Pure; the caller (MessageList) reads
 *  the toolResults map so MessageView itself never subscribes to it. */
export function assistantResultIdxByBlock(
  msg: SdkMessage,
  toolResults: ReadonlyMap<string, ToolResultEntry>,
  ordinal: number,
  query: string,
): (number | undefined)[] {
  const blocks = getBlocks(msg)
  const out: (number | undefined)[] = blocks.map(() => undefined)
  let remaining = ordinal
  // Own segments: text + tool_use diffs, in block order (blockActiveIdx's space).
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      remaining -= countMatches(extractPlainText(b.text), query)
    } else if (b.type === 'tool_use') {
      remaining -= countMatches(extractToolUseDiffText(b.input, b.name), query)
    }
    if (remaining < 0) return out // active match is in a text block or a diff
  }
  // Consumed results, in tool_use block order.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type !== 'tool_use') continue
    const id = extractToolUseId(b)
    const entry = id ? toolResults.get(id) : undefined
    if (!entry) continue
    let n = 0
    for (const run of toolResultTextRuns(entry.content)) n += countMatches(run, query)
    if (n === 0) continue
    if (remaining < n) {
      out[i] = remaining
      return out
    }
    remaining -= n
  }
  return out
}
