// Row-level search match space: a transcript row's own segments PLUS the
// tool_result payloads merged into its tool cards (or its group members'
// cards). A result consumed into a card no longer renders as a standalone
// user row, so its matches must be counted on the OWNING row — otherwise the
// row never receives the query (no passive marks) and a closed group never
// force-opens on a result-only hit.
//
// The count is a SUM over the row's match space; mapping a navigation ordinal
// back to a specific renderer is a separate concern (the ordinal walk).

import type { SdkMessage } from '../../types'
import type { ToolResultEntry } from '../../session-store/types'
import { countCachedMessageSearchMatches, extractToolUseId, getBlocks } from '../../session-store/normalize'
import { countMatches } from '../../../shared/search/match.js'
import { toolResultTextRuns } from '../../../shared/tool-result-text.js'

/** Total search matches owned by one transcript row: the row message's own
 *  cached segments (markdown text, attachment names, tool_use diffs — and a
 *  user tool_result row's raw runs), plus, for every tool_use id in block
 *  order of `members ?? [msg]` whose result has landed in `toolResults`, the
 *  matches over that result's rendered text runs (the single view from
 *  shared/tool-result-text). User rows carry no tool_use blocks, so their
 *  own tool_result segments are never double-counted through the map. */
export function rowSearchMatchCount(
  msg: SdkMessage,
  members: readonly SdkMessage[] | undefined,
  toolResults: ReadonlyMap<string, ToolResultEntry>,
  query: string,
): number {
  let count = countCachedMessageSearchMatches(msg, query)
  for (const member of members ?? [msg]) {
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