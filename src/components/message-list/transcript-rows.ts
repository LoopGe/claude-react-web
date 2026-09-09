/**
 * L1 of the transcript list: the ROW MODEL.
 *
 * `MessageList` used to derive its Virtuoso `data` array inline, in the same
 * component that owns virtualization, imperative scroll control and the
 * entrance-animation gate. That coupling is why every rendering bug in the
 * transcript had to be fixed twice — once for the main list and once for the
 * SubagentOverlay drawer, which feeds the same component a differently-shaped
 * input.
 *
 * This module owns exactly one question: **given the raw transcript plus the
 * live lifecycle maps, which rows exist, in what order, and under what
 * identity?** It is pure and synchronous so it can be unit-tested without a
 * DOM, and so the answer is the same for every caller.
 *
 * After filtering, consecutive tool-only assistant rows are folded into one
 * group row (see `foldToolGroupRows`) so the UI can collapse historical tool
 * cascades. Length-1 runs stay unwrapped.
 * The invariants the virtualization layer depends on:
 *
 *  I1  `row.id` is stable and unique within a build. It is the React/Virtuoso
 *      key (see `computeItemKey` in MessageList). Stability is what lets a row
 *      keep its own DOM node — and therefore its measured height and mounted
 *      subtree state — when other rows appear or disappear around it.
 *
 *  I2  Synthetic rows (SubagentOverlay's injected prompt/result, the transient
 *      `api_retry` divider) are ordinary rows with ordinary ids. Callers must
 *      hand in referentially stable `TranscriptItem`s for them; a fresh object
 *      per flush defeats both the row memo and the front-anchor bookkeeping.
 *
 *  I3  Rows are NOT append-only. `willRenderEmpty(…, isResultConsumed)` drops
 *      a row once its tool_result has been merged into the owning card, and
 *      `isResultConsumed` keeps changing during a turn — so rows can vanish
 *      from the MIDDLE of the list. That is deliberate (it is what keeps the
 *      transcript from accumulating blank gaps after every tool call), and it
 *      is precisely why I1 is mandatory: Virtuoso's size cache is index-keyed
 *      and cannot be told about a middle removal, so the only defence is that
 *      surviving rows keep their identity and their measurement.
 */
import type { SdkMessage } from '../../types'
import type { ActiveSubagent, TranscriptItem } from '../../session-store/types'
import { getBlocks, userMessageHasToolResult } from '../../session-store/normalize'
import { willRenderEmpty } from './rendering'

/**
 * One row of the rendered transcript — an entry in Virtuoso's `data` array.
 *
 * `isCompactSummary` is pre-computed here so `itemContent` doesn't need a
 * `rows[i - 1]` look-back. `itemIndex` maps back to the original `items[]`
 * position for search-result scrolling (search indices reference the full,
 * unfiltered list); synthetic rows get negative sentinels since they have no
 * position there.
 */
export interface TranscriptRow {
  /** Stable per-row id (SdkMessage uuid, or a synthetic id). Doubles as the
   *  virtualization key (I1) and drives the entrance-animation gate. */
  id: string
  msg: SdkMessage
  isCompactSummary: boolean
  renderableIndex: number
  itemIndex: number
  /** Optimistic placeholder still in flight — drives the user bubble's
   *  "sending" spinner. Cleared automatically by the reducer when the
   *  server's broadcast lands and the optimistic gets swapped out. */
  sending?: boolean
  /** Queue-delivery state of a top-level user turn ('queued' = waiting
   *  behind an in-flight turn, 'consumed' = SDK has started processing).
   *  Undefined for everything else. Drives the queued/processing chip. */
  deliveryStatus?: 'queued' | 'consumed'
  /** Wall-clock ms when first observed. Carried from the TranscriptItem so
   *  the entrance-animation gate can tell a live arrival (timestamp present)
   *  from disk-restored history (undefined). */
  receivedAt?: number
  /** Present only on a folded group of >=2 consecutive tool-only assistant
   *  rows. `id` stays the FIRST member's uuid so live 1->2 growth is a
   *  same-key height change + mid-list removal of the second row (I3). */
  toolGroup?: {
    members: SdkMessage[]
    memberItemIndices: number[]
    memberIds: string[]
  }
}

export interface BuildTranscriptRowsInput {
  /** The session's full transcript, unfiltered. */
  items: readonly TranscriptItem[]
  /**
   * Filter on `parent_tool_use_id`:
   *  - null / undefined: only root messages. The main transcript — a
   *    subagent's internals are surfaced as a SubagentCard in the parent's
   *    tool_use slot, and the full inner stream lives in SubagentOverlay.
   *  - string: only DIRECT children of that tool_use id. Nested subagents
   *    inside it surface as SubagentCards again, allowing drill-down.
   */
  parentToolUseIdFilter?: string | null
  /** Has this tool_use_id's result already been consumed by a card? See
   *  `makeResultConsumed`. */
  isResultConsumed: (id: string) => boolean
  /** Rows prepended BEFORE the parent-filtered children, bypassing the
   *  filter (SubagentOverlay's injected input prompt, which the SDK never
   *  echoes as a child frame for an async subagent). */
  leadingItems?: readonly TranscriptItem[]
  /** Rows appended AFTER the parent-filtered children, bypassing the filter
   *  (a synchronous subagent's reply, which lands as the Agent tool_result on
   *  the MAIN thread and so has parent_tool_use_id = null). */
  trailingItems?: readonly TranscriptItem[]
  /** Transient `api_retry` frame. Render-only: it lives in its own slot, not
   *  in items/messages/IDB, and is appended as a synthetic tail row. */
  apiRetry?: SdkMessage | null
}

export interface TranscriptRowsResult {
  rows: TranscriptRow[]
  /** First / last row ids, so `itemContent` can apply the outer-edge padding
   *  classes without depending on the rows array reference. */
  firstItemId: string | undefined
  lastItemId: string | undefined
  /** rowId → the NEXT row's `msg.type`. Same reason: keeps `itemContent` off
   *  the array reference, which changes on every append and would defeat the
   *  row-level memo. */
  nextItemTypeMap: Map<string, string>
}

/** Synthetic row id for the transient api_retry divider. Stable across
 *  consecutive retry frames so the slot is overwritten in place (fresh
 *  delayMs props, no remount) instead of appending a new row each time. */
export const API_RETRY_ROW_ID = '__api_retry__'

function pushRow(
  out: TranscriptRow[],
  item: TranscriptItem,
  itemIndex: number,
  isResultConsumed: (id: string) => boolean,
): void {
  if (item.hiddenByDefault) return
  // Drop messages MessageView would render as null (merged tool_result
  // frames, subagent heartbeats, empty assistant shells). Otherwise each
  // leaves an empty `.virtuoso-item-wrapper` whose padding doubles the gap
  // after every tool call. Kept in lockstep with MessageView via the shared
  // willRenderEmpty.
  if (willRenderEmpty(item.msg, item.isCompactSummary, isResultConsumed)) return
  out.push({
    id: item.id,
    msg: item.msg,
    isCompactSummary: item.isCompactSummary,
    renderableIndex: out.length,
    itemIndex,
    sending: item.sending,
    deliveryStatus: item.deliveryStatus,
    receivedAt: item.receivedAt,
  })
}

/** A row eligible for tool-group folding: a root assistant message whose
 *  only visible content is one or more tool_use blocks. Thinking, text,
 *  and anything else break the run (SDK emits those as separate messages). */
export function isToolGroupEligible(row: TranscriptRow): boolean {
  if (row.msg.type !== 'assistant') return false
  if (row.isCompactSummary) return false
  if (row.msg.parent_tool_use_id != null) return false
  const blocks = getBlocks(row.msg)
  let hasToolUse = false
  for (const b of blocks) {
    if (b == null) return false
    if (b.type === 'tool_use') {
      hasToolUse = true
      continue
    }
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) return false
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim().length > 0) return false
    // image / unknown / empty text / empty thinking -> not a pure tool row
    return false
  }
  return hasToolUse
}

/** Fold consecutive eligible runs of length >=2 into one group row. Length-1
 *  runs stay untouched so a lone tool keeps today's appearance. */
export function foldToolGroupRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const out: TranscriptRow[] = []
  let i = 0
  while (i < rows.length) {
    if (!isToolGroupEligible(rows[i]!)) {
      out.push(rows[i]!)
      i += 1
      continue
    }
    let j = i + 1
    while (j < rows.length && isToolGroupEligible(rows[j]!)) j += 1
    if (j - i === 1) {
      out.push(rows[i]!)
    } else {
      const members = rows.slice(i, j)
      const first = members[0]!
      out.push({
        ...first,
        toolGroup: {
          members: members.map((m) => m.msg),
          memberItemIndices: members.map((m) => m.itemIndex),
          memberIds: members.map((m) => m.id),
        },
      })
    }
    i = j
  }
  return out
}

export function buildTranscriptRows({
  items,
  parentToolUseIdFilter,
  isResultConsumed,
  leadingItems,
  trailingItems,
  apiRetry,
}: BuildTranscriptRowsInput): TranscriptRowsResult {
  const out: TranscriptRow[] = []

  if (leadingItems) {
    // Negative sentinel itemIndex: these rows have no position in `items[]`,
    // and the values must not collide with real indices or with the trailing
    // block's sentinels (search's itemIndex → row index reverse map is keyed
    // on them).
    for (let li = 0; li < leadingItems.length; li++) {
      pushRow(out, leadingItems[li], -1 - li, isResultConsumed)
    }
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const parent = item.msg.parent_tool_use_id
    if (parentToolUseIdFilter == null) {
      if (parent != null) continue
    } else {
      if (parent !== parentToolUseIdFilter) continue
    }
    pushRow(out, item, i, isResultConsumed)
  }

  if (trailingItems) {
    for (let ti = 0; ti < trailingItems.length; ti++) {
      pushRow(out, trailingItems[ti], -1000 - ti, isResultConsumed)
    }
  }

  if (apiRetry) {
    out.push({
      id: API_RETRY_ROW_ID,
      msg: apiRetry,
      isCompactSummary: false,
      renderableIndex: out.length,
      // No receivedAt, so the entrance-animation gate skips it.
      itemIndex: -2,
    })
  }

  // Fold tool-only assistant runs. Must run before nextItemTypeMap so the
  // map keys on the surviving (group) ids.
  const folded = foldToolGroupRows(out)

  const nextItemTypeMap = new Map<string, string>()
  for (let i = 0; i < folded.length - 1; i++) {
    nextItemTypeMap.set(folded[i]!.id, folded[i + 1]!.msg.type)
  }

  // I1 is load-bearing now that rows are keyed by id: a duplicate would give
  // React a duplicate key AND make Virtuoso's index-based size cache resolve
  // two rows to one measurement — the exact failure mode keying by id exists to
  // prevent, but silent. `nextItemTypeMap` is also keyed by id, so a duplicate
  // corrupts the last-row detection too. Dev-only: Vite tree-shakes it out of
  // the shipped bundle (same pattern as the store's debug dump).
  if (import.meta.env.DEV && nextItemTypeMap.size < folded.length - 1) {
    const seen = new Set<string>()
    const dupes = folded.map((r) => r.id).filter((id) => !seen.add(id))
    console.error(
      '[transcript-rows] duplicate row ids break virtualization (invariant I1):',
      Array.from(new Set(dupes)),
    )
  }

  return {
    rows: folded,
    firstItemId: folded[0]?.id,
    lastItemId: folded[folded.length - 1]?.id,
    nextItemTypeMap,
  }
}

// ─── Subagent synthetic rows ────────────────────────────────────────────
//
// A subagent's inner conversation is the parent-filtered slice of the session
// transcript — but two of its most important messages are NOT in that slice,
// so the row model synthesises them:
//
//   prompt  The SDK does not echo an ASYNC/background subagent's input prompt
//           back as a child frame, so the filter leaves the subagent's reply
//           with no question for context. Skipped for synchronous subagents,
//           where the SDK does echo it (injecting anyway would show it twice).
//
//   result  A SYNCHRONOUS subagent's reply lands as the Agent tool_result on
//           the MAIN thread (parent_tool_use_id = null), so the filter hides
//           it and the overlay would show a prompt with no answer. Skipped for
//           async subagents, whose reply streams as a child assistant frame
//           and is therefore already in the slice.
//
// These live here rather than in SubagentOverlay so the whole "which rows
// exist" question has one home, and so the referential-stability contract (I2)
// is enforced next to the anchor logic that depends on it. The identity
// memoisation itself is in `useSubagentSyntheticRows`.

/** Synthetic row ids. Derived from the subagent's tool_use id, so they're
 *  stable across rebuilds and unique within the overlay's list. */
export const subagentPromptRowId = (toolUseId: string) => `${toolUseId}:prompt`
export const subagentResultRowId = (toolUseId: string) => `${toolUseId}:result`

/**
 * Did the SDK already echo this subagent's prompt as a child user frame?
 *
 * Tool-result-bearing child frames are excluded: a subagent's internal
 * tool_results are child user frames whose plainText is the tool output, which
 * would otherwise trip the probe and wrongly suppress the injection — leaving
 * any async subagent that uses tools with no input bubble at all.
 */
export function sdkEchoedSubagentPrompt(
  items: readonly TranscriptItem[],
  toolUseId: string,
): boolean {
  return items.some(
    (it) =>
      it.msg.parent_tool_use_id === toolUseId &&
      it.msg.type === 'user' &&
      !userMessageHasToolResult(it.msg) &&
      typeof it.plainText === 'string' &&
      it.plainText.length > 0 &&
      !it.isCompactSummary,
  )
}

/**
 * The subagent's input prompt as a synthetic leading row.
 *
 * `parent_tool_use_id` is set to the subagent's own id so MessageView renders
 * it through the subagent-internal branch (label "subagent"), identical to the
 * sync echo. A null parent would label it "you", which misrepresents the
 * message — it's the parent agent's input to the subagent, not a human turn.
 */
export function subagentPromptItem(
  toolUseId: string,
  prompt: string,
  startedAt: number | undefined,
): TranscriptItem {
  return {
    id: subagentPromptRowId(toolUseId),
    msg: {
      type: 'user',
      uuid: subagentPromptRowId(toolUseId),
      parent_tool_use_id: toolUseId,
      receivedAt: startedAt,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    } as unknown as SdkMessage,
    plainText: prompt,
    isCompactSummary: false,
    hiddenByDefault: false,
    receivedAt: startedAt,
  } as TranscriptItem
}

/**
 * Flatten a synchronous subagent's captured result to plain text, or undefined
 * when there is nothing to show (still running, async, empty, or an unexpected
 * content shape).
 *
 * Returning a STRING rather than the row itself is deliberate: `ActiveSubagent`
 * records are re-cloned on nearly every reducer pass, so callers memoise the
 * row on this primitive instead of on the record (see I2).
 */
export function subagentResultText(record: ActiveSubagent | undefined): string | undefined {
  if (!record) return undefined
  if (record.isAsync === true) return undefined
  const content = record.result?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n\n')
}

/** The subagent's reply as a synthetic trailing row. */
export function subagentResultItem(
  toolUseId: string,
  text: string,
  receivedAt: number | undefined,
): TranscriptItem {
  return {
    id: subagentResultRowId(toolUseId),
    msg: {
      type: 'assistant',
      uuid: subagentResultRowId(toolUseId),
      parent_tool_use_id: toolUseId,
      receivedAt,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    } as unknown as SdkMessage,
    plainText: text,
    isCompactSummary: false,
    hiddenByDefault: false,
    receivedAt,
  } as TranscriptItem
}

// ─── Virtuoso front anchor ──────────────────────────────────────────────
//
// Virtuoso addresses rows in an "offset space": the row at `data[0]` has index
// `firstItemIndex`. Prepending N rows therefore requires DECREASING
// firstItemIndex by exactly N in the SAME render that grows `data` at the
// front; removing N from the front requires INCREASING it by N. Get it wrong
// and Virtuoso's index-keyed size tree is shifted relative to the data, which
// paints as blank bands / overlapping rows while scrolling.
//
// The previous implementation compared the first row by `msg` OBJECT identity
// and had only two outcomes: decrement, or hard-reset to the initial anchor.
// Two consequences:
//   - Any caller that rebuilt the first row's `msg` object per flush (which
//     SubagentOverlay did, before `useSubagentSyntheticRows` stabilised it)
//     took the reset branch on EVERY message, so the prepend compensation was
//     effectively dead in the overlay.
//   - A genuine front REMOVAL — the first row being dropped by
//     `willRenderEmpty` while the rest of the list stays put — also landed on
//     the reset branch, which is a no-op whenever the anchor is already at its
//     initial value. The size tree then stayed misaligned by one row.
//
// Keying on `row.id` fixes the first, and tracking the previous id list fixes
// the second.
//
// Not one of the cases: the overlay's synthetic prompt row being superseded by
// the SDK's echo. Both happen in the same build (the echo row is what flips
// `sdkEchoedSubagentPrompt` true), so the head is REPLACED, not removed — row
// count before the head is unchanged and `firstItemIndex` genuinely shouldn't
// move. That lands on the re-anchor branch, which is the right answer.

/** Starting anchor. A large value so `loadOlder` prepends can decrement for a
 *  very long time without approaching zero (Virtuoso rejects negatives). */
export const INITIAL_FIRST_ITEM_INDEX = 1_000_000

export interface RowAnchor {
  /** Value to hand Virtuoso's `firstItemIndex`. */
  index: number
  /** Row ids from the build this anchor was computed for, in order. */
  rowIds: readonly string[]
}

export const initialRowAnchor = (): RowAnchor => ({
  index: INITIAL_FIRST_ITEM_INDEX,
  rowIds: [],
})

/**
 * Fold a fresh row list into the anchor.
 *
 * Pure, and idempotent for a given row list — folding the same rows twice does
 * not double-count a shift. Must be called during render (not in an effect) so
 * `index` and `data` commit together. Allocates a fresh `rowIds` array on every
 * non-empty call; that's O(n) alongside `buildTranscriptRows`' own O(n), and
 * it's what makes the front-removal case detectable.
 *
 * `index` only ever DECREASES on a front insert, from a starting point of 1e6,
 * so it cannot realistically reach zero (Virtuoso rejects negatives).
 */
export function advanceRowAnchor(prev: RowAnchor, rows: readonly TranscriptRow[]): RowAnchor {
  if (rows.length === 0) {
    // Empty list (session switch / cleared / replay rebuild) — re-anchor.
    if (prev.rowIds.length === 0 && prev.index === INITIAL_FIRST_ITEM_INDEX) return prev
    return initialRowAnchor()
  }

  const rowIds = rows.map((r) => r.id)

  // First build for this list — adopt the ids, leave the offset alone.
  if (prev.rowIds.length === 0) return { index: prev.index, rowIds }

  const prevFirst = prev.rowIds[0]
  if (rowIds[0] === prevFirst) {
    // Front unchanged. This is the hot path (ordinary appends, streaming
    // flushes, mid-list removals) — no offset adjustment.
    return { index: prev.index, rowIds }
  }

  const movedTo = rows.findIndex((r) => r.id === prevFirst)
  if (movedTo > 0) {
    // `movedTo` rows were inserted ahead of the previous first row.
    return { index: prev.index - movedTo, rowIds }
  }

  // The previous first row is gone. If the new first row used to sit at some
  // position k > 0, then exactly k rows were dropped off the front — the
  // mirror image of a prepend, and Virtuoso's documented "items removed from
  // the top" case.
  const removed = prev.rowIds.indexOf(rowIds[0])
  if (removed > 0) {
    return { index: prev.index + removed, rowIds }
  }

  // Neither a front insert nor a front removal — an unrelated rebuild (replay
  // replace, fork, /clear swap). Re-anchor; Virtuoso resets its size tree.
  return { index: INITIAL_FIRST_ITEM_INDEX, rowIds }
}
