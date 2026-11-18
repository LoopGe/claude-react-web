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