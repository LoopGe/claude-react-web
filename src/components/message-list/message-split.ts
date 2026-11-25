// Shape-driven row split for MIXED assistant messages — the native provider's
// host adapter projects one neutral assistant message (text/thinking + tool_use
// together, the raw Anthropic API shape) as ONE SDK frame, while the claude CLI
// splits those blocks into separate messages. The row model's fold eligibility
// (isToolGroupEligible) assumes the split granularity, so a mixed message never
// folds its tool run. This module is the display-layer answer (DSH parity):
// the DATA stays combined (store, log, wire untouched — the combined message is
// the API-replay unit); the ROW layer projects consecutive block-kind runs into
// separate rows, so the non-tool run renders as a boundary reply and the tool
// run participates in tool-group folding.
//
// Provider-blind on purpose: a pure message (claude's split frames, or a native
// pure-tool frame) returns null and keeps the original single-row path. The
// predicate here is the SINGLE source of truth shared by pushRow (which rows
// exist) and routeSplitItemOrdinal (which run owns a search ordinal) — a gate
// added to one caller only would desync the identity join.

import type { Block, SdkMessage } from '../../types'
import { getBlocks } from '../../session-store/normalize'

/** Weak-keyed on the original message object: the store's messages are
 *  referentially stable across rebuilds, so the projected runs are too — the
 *  identity contract behind ToolGroupCard's member memo, MessageView's blocks
 *  memo, and the streaming-render-isolation 0-render pin. A replaced frame
 *  re-projects; nothing is retained past the original's lifetime. */
const splitCache = new WeakMap<SdkMessage, SdkMessage[] | null>()

/** Split a mixed assistant message into consecutive maximal block-kind runs
 *  (tool_use runs vs non-tool runs, block order preserved — handles interleaved
 *  `[text, tool, text]`). Returns null when no split applies: non-assistant,
 *  pure-kind content, or a special frame whose top-level fields would duplicate
 *  across runs.
 *
 *  Runs are enumerated by KIND, not visibility: an empty-text sibling still
 *  occupies a run index (pushRow drops the empty row via willRenderEmpty, and
 *  the search routing shares this enumeration, so run indices must not shift).
 *  Every run keeps the original envelope (uuid / type / parent_tool_use_id /
 *  session_id) and replaces only `message.content` with its block subset. */
export function splitMixedAssistantMessage(msg: SdkMessage): SdkMessage[] | null {
  const cached = splitCache.get(msg)
  if (cached !== undefined) return cached
  const runs = computeSplit(msg)
  splitCache.set(msg, runs)
  return runs
}

function computeSplit(msg: SdkMessage): SdkMessage[] | null {
  if (msg.type !== 'assistant') return null
  // Special frames render through dedicated MessageView branches (error
  // divider, structured context/usage cards, draft body); their top-level
  // fields would copy onto EVERY run and paint once per run. MessageView's
  // in-row split excludes the same shapes.
  if (msg.isDraft || msg.error || msg.isApiErrorMessage || msg.context_usage || msg.usage_report) return null
  const blocks = getBlocks(msg)
  let hasTool = false
  let hasNonTool = false
  for (const b of blocks) {
    if (b == null) return null
    if (b.type === 'tool_use') hasTool = true
    else hasNonTool = true
  }
  if (!hasTool || !hasNonTool) return null

  const runs: Block[][] = []
  let current: Block[] = []
  let currentIsTool: boolean | null = null
  for (const b of blocks) {
    const isTool = b.type === 'tool_use'
    if (currentIsTool !== isTool) {
      if (current.length > 0) runs.push(current)
      current = []
      currentIsTool = isTool
    }
    current.push(b)
  }
  if (current.length > 0) runs.push(current)

  return runs.map((runBlocks) => ({
    ...msg,
    message: { ...msg.message, content: runBlocks },
  }))
}

/** True when a projected run is a tool_use run (the fold-eligible kind). The
 *  first NON-tool run is the draft heir — the row that adopts the in-place
 *  draft's alias key at settle (see rowDraftAlias). */
export function isToolRun(run: SdkMessage): boolean {
  const blocks = getBlocks(run)
  return blocks.length > 0 && blocks[0].type === 'tool_use'
}

/** The draft-alias gate shared by every identity consumer (computeItemKey,
 *  MeasuredItem's crwRowId stamp, the anchor-reveal fallback, the height-cache
 *  lookup). Split runs keep the original uuid on their projected messages, so
 *  an UNGATED `draftRowKeys[msg.uuid]` lookup aliases EVERY run of a settled
 *  draft-born message to the one draft key — duplicate React keys and colliding
 *  height-cache writes. Only the unsplit row (id === uuid) or the designated
 *  heir run may adopt the alias; every other run keeps its derived id. */
export function rowDraftAlias(
  row: { id?: string; draftHeir?: boolean; msg?: { uuid?: string } },
  draftRowKeys: Readonly<Record<string, string>> | null | undefined,
): string | undefined {
  const uuid = row.msg?.uuid
  if (uuid == null || !draftRowKeys) return undefined
  if (row.id !== uuid && !row.draftHeir) return undefined
  return draftRowKeys[uuid]
}
