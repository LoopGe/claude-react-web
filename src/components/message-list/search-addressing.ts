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
import { extractToolUseDiffText } from '../../../shared/search/extract.js'
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

/** Route a member-local active-match ordinal into the one renderer that owns
 *  it. PRECONDITION: `memberMsg` is a tool-only group member (the fold contract
 *  in transcript-rows.ts — its visible content is tool_use blocks only), so the
 *  match space is, per tool_use block in block order: the diff's matches then
 *  the consumed result's rendered-run matches. Walks that space subtracting
 *  each segment's count until the ordinal falls inside one:
 *   - inside a diff  → `diffIdx` (diff-local, the Nth match of that tool_use's
 *     indexed del+add text), `resultIdx` undefined;
 *   - inside a result → `resultIdx` (result-global across that id's runs, the
 *     coordinate ToolResultDetails rebases per run), `diffIdx` undefined.
 *  Past the end of the space (or a result that has not landed) both are
 *  undefined. Counts use the SAME views as the renderers and rowSearchMatchCount
 *  (extractToolUseDiffText / toolResultTextRuns + countMatches), so the routed
 *  mark is exactly the one the count layer attributed to this member. */
export function splitMemberOrdinal(
  memberMsg: SdkMessage,
  toolResults: ReadonlyMap<string, ToolResultEntry>,
  ordinal: number,
  query: string,
): { diffIdx: number | undefined; resultIdx: number | undefined } {
  let remaining = ordinal
  for (const block of getBlocks(memberMsg)) {
    if (block.type !== 'tool_use') continue
    const diffN = countMatches(extractToolUseDiffText(block.input, block.name), query)
    if (remaining < diffN) return { diffIdx: remaining, resultIdx: undefined }
    remaining -= diffN
    const id = extractToolUseId(block)
    const entry = id ? toolResults.get(id) : undefined
    if (!entry) continue
    let n = 0
    for (const run of toolResultTextRuns(entry.content)) n += countMatches(run, query)
    if (n === 0) continue
    if (remaining < n) return { diffIdx: undefined, resultIdx: remaining }
    remaining -= n
  }
  return { diffIdx: undefined, resultIdx: undefined }
}
