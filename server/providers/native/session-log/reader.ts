// server/providers/native/session-log/reader.ts
//
// History read surface over the native session log. Mirrors history-reader's
// two read paths so search, paging, and side-chat boundaries work unchanged:
//
//   - entries: every renderable line as { index, message }, untrimmed (search
//     reads content for snippets and must not lose recall);
//   - pages: the shared `paginateRenderable` window (before / beforeUuid /
//     limit), trimmed for the wire.
//
// Both paths append `repairRenderableLines`' synthetic tool_result lines for a
// turn a crash cut short, so an interrupted session renders (and pages) as
// complete without rewriting the log. They also apply the side-chat
// `afterUuid` boundary with parseRenderable's exact semantics: skip the
// boundary line and everything before it; if the boundary is absent, drop
// everything.

import { normalize, paginateRenderable } from '../../../history-reader.js'
import type { HistoryEntry, HistoryPage, RawLine } from '../../../history-reader.js'
import { nativeHistoryCache } from './cache.js'
import { repairRenderableLines } from './replay.js'

function emptyPage(): HistoryPage {
  return { messages: [], totalCount: 0, startIndex: 0, hasMore: false }
}

/** Cached durable lines plus the synthetic tail for unanswered tool_use ids.
 *  The cache itself is never mutated. */
function withRepair(lines: readonly RawLine[]): RawLine[] {
  return [...lines, ...repairRenderableLines(lines)]
}

/** Mirror history-reader.parseRenderable's afterUuid filter: nothing is
 *  included until the boundary uuid has been seen (and skipped). */
function filterAfterUuid(lines: readonly RawLine[], afterUuid?: string): RawLine[] {
  if (!afterUuid) return [...lines]
  const out: RawLine[] = []
  let past = false
  for (const line of lines) {
    if (!past) {
      if (line.uuid === afterUuid) past = true
      continue
    }
    out.push(line)
  }
  return out
}

export async function readNativeHistoryEntries(
  stateDir: string,
  id: string,
  opts: { afterUuid?: string } = {},
): Promise<HistoryEntry[]> {
  const loaded = await nativeHistoryCache.load(stateDir, id)
  if (!loaded) return []
  return filterAfterUuid(withRepair(loaded.lines), opts.afterUuid).map((line, index) => ({
    index,
    // No trim: this path feeds search, which reads content to build snippets
    // and never ships the full message over WS.
    message: normalize(line, id, false),
  }))
}

export async function readNativeHistoryPage(
  stateDir: string,
  id: string,
  opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
): Promise<HistoryPage> {
  const loaded = await nativeHistoryCache.load(stateDir, id)
  if (!loaded) return emptyPage()
  return paginateRenderable(filterAfterUuid(withRepair(loaded.lines), opts.afterUuid), id, opts)
}