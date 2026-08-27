import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Push an item into a bounded array, evicting the oldest entry when the
 * cap is exceeded. This is the single implementation used by the session
 * pump, pushToSession, and appendRecap so any future buffer-strategy
 * change (e.g. ring buffer) only needs one edit.
 */
export function pushBounded<T>(arr: T[], item: T, cap: number): void {
  arr.push(item)
  if (arr.length > cap) {
    // In-place copy avoids the throwaway removed-elements array that
    // splice() allocates in its return value.
    const excess = arr.length - cap
    for (let i = excess; i < arr.length; i++) arr[i - excess] = arr[i]
    arr.length = cap
  }
}

/**
 * Stamp the wall-clock time the server first observed a message, in place.
 *
 * The SDK's message type has no timestamp, so the client can't tell when a
 * message arrived — and stamping it client-side would mislabel replayed
 * history as "now". We stamp here, once, before the message enters the
 * history ring; because the ring and the live subscriber broadcast share the
 * same object reference, the value rides along on both the replay and live
 * paths with no extra plumbing.
 *
 * `receivedAt` is added defensively (only when absent) so a message that
 * somehow flows through twice keeps its original time. Typed loosely because
 * the field isn't part of the upstream SDKMessage shape.
 *
 * Stamps are MONOTONIC across the process: when the wall clock hasn't ticked
 * since the previous stamp (frames of one burst routinely land in the same
 * millisecond), the value is last+1. This keeps `receivedAt` order strictly
 * equal to arrival order, which mergedHistory() relies on — a plain
 * Date.now() would tie a subagent frame with the main-thread frames around
 * it, and the merge sort (stable, over `[...main, ...sub]`) would then float
 * the subagent frame after every same-ms main frame, corrupting the
 * single-ring arrival-order contract that replay, discard seeds, and the
 * client's uuid-anchored dedup all assume. The counter only ever leads the
 * wall clock by the size of a same-ms burst (a few ms), so the value stays a
 * faithful "when received" timestamp for display.
 */
let lastReceivedAtStamp = 0

export function stampReceivedAt(msg: unknown): void {
  if (msg && typeof msg === 'object' && (msg as { receivedAt?: number }).receivedAt == null) {
    const now = Date.now()
    lastReceivedAtStamp = now > lastReceivedAtStamp ? now : lastReceivedAtStamp + 1
    ;(msg as { receivedAt?: number }).receivedAt = lastReceivedAtStamp
  }
}

/**
 * Stamp the wall-clock time the SDK actually CONSUMED a user message off the
 * input queue (as opposed to `receivedAt`, which is when the server first
 * accepted it from the HTTP layer). The gap between the two is exactly how
 * long the message sat queued behind an in-flight turn.
 *
 * Stamped in place on the same object that lives in the history ring, so the
 * "consumed" state rides along on replay for free — a reconnecting client
 * sees `consumedAt` already set on historical messages and renders them as
 * delivered without needing the live `message-consumed` frame. Added only
 * when absent so a message that somehow flows through twice keeps its first
 * consumption time. Returns the stamped value so the caller can broadcast it
 * without re-reading.
 */
export function stampConsumedAt(msg: unknown): number {
  const m = msg as { consumedAt?: number }
  if (m && typeof m === 'object' && m.consumedAt == null) {
    m.consumedAt = Date.now()
  }
  return (m as { consumedAt?: number }).consumedAt ?? Date.now()
}

/** System subtypes that should be broadcast to clients and persisted in
 *  history. Other system frames (init, status, …) are kept in history for
 *  fastModeState extraction and /clear signaling, but skipped in broadcasts
 *  to save bandwidth and client memory. Matches history-reader.ts
 *  KEEP_SYSTEM_SUBTYPES.
 *
 *  `task_notification` MUST be broadcast: it is the SDK's background-task
 *  completion signal. The client reducer's async-subagent completion branch
 *  fires on it to flip a `background` subagent to `done` (clearing its
 *  WorkingBubble chip); without the broadcast the frame never reaches the
 *  reducer and the chip stays forever. */
export const BROADCAST_SYSTEM_SUBTYPES = new Set([
  'error',
  'compact_boundary',
  'api_retry',
  'task_notification',
  // SDK signal that an MCP URL-mode elicitation completed (the user
  // finished auth in the browser). Surfacing it lets the transcript show
  // the auth round-trip instead of silently resuming.
  'elicitation_complete',
  // Text output of CLI-local commands (/usage, /voice, …). Without this the
  // pump drops the frame and the user sees nothing after running the command.
  'local_command_output',
  // Auto-memory recall: the memory supervisor surfaced memories into the
  // turn. Renders as a "Recalled from memory" card; without the broadcast
  // the frame never reaches the client and the user can't see what context
  // was injected.
  'memory_recall',
  // A tool call was auto-denied WITHOUT an interactive permission prompt
  // (dontAsk/auto-mode classifier, deny rules, headless auto-deny). The
  // interactive 'ask' path surfaces via permission-request frames; without
  // this broadcast the non-interactive deny path is invisible — the user
  // only sees an is_error tool_result with no explanation of WHY.
  'permission_denied',
  // Generic text banners from the loop (hook block reasons, slash-command
  // output, non-error status lines). Rendered at the frame's `level` —
  // warnings/suggestions deserve transcript visibility; `info` level
  // renders muted.
  'informational',
  // The primary model refused and the turn was retried once on the fallback
  // model (made persistent for the session). The refused leg's partial
  // messages were already streamed to the client and are retracted via
  // `retracted_message_uuids` — the client must see this frame to render
  // the fallback notice AND evict the retracted uuids.
  'model_refusal_fallback',
])

/** Check if a message should be broadcast to frontend clients.
 *  Returns true for all non-system messages, and for system messages with
 *  subtypes in BROADCAST_SYSTEM_SUBTYPES.
 *  System init/status messages return false. */
export function shouldBroadcastMessage(msg: { type?: string; subtype?: string }): boolean {
  if (msg.type !== 'system') return true
  return BROADCAST_SYSTEM_SUBTYPES.has(msg.subtype ?? '')
}

/** A message that belongs in the durable history ring (and therefore the
 *  WS full-replay surface). Ephemeral `stream_event` deltas are excluded:
 *  they are live-streaming fragments (one per content delta — hundreds per
 *  heavy turn) that the SDK never persists to the on-disk transcript and the
 *  client never renders as items (toTranscriptItem returns null). Keeping
 *  them in the 500-cap ring let a streaming turn evict durable content — a
 *  just-sent user message, an assistant message, a tool result — from the
 *  replay surface within seconds, so a reload during/after the flood lost
 *  recent durable messages. Everything the transcript model actually
 *  represents (user / assistant / result / system frames) is retained. */
export function isTranscriptMessage(msg: { type?: string }): boolean {
  return msg.type !== 'stream_event'
}

// ---------------------------------------------------------------------------
// trimLargeToolResults — cap oversized tool_result content.
//
// Lives HERE (not in session-pump.ts) because TWO consumers need it:
//   1. the live pump, before a message enters the history ring / WS broadcast;
//   2. history-reader.normalize(), so disk-restored history (resume seed,
//      lazy-load pages, search) is capped the same way — otherwise a resumed
//      session replays an untrimmed multi-MB tool_result over WS and blows
//      WsWriteQueue.MAX_QUEUE_CHARS, the "Stream reconnecting…" loop.
// ---------------------------------------------------------------------------

/** Maximum characters kept in a single `tool_result` content block.
 *  ~50K chars ≈ 12K tokens — comfortably under the SDK's own 25K-token
 *  MCP output cap while leaving room for other context.  The head+tail
 *  strategy preserves the beginning (usually the most useful part) and
 *  the end (often contains summary / error info). */
const MAX_TOOL_RESULT_CHARS = 50_000

/** Maximum base64 chars kept in a single `tool_result` IMAGE block.
 *  Base64 is ~4/3× binary size, so 2M chars ≈ 1.5MB binary — above a typical
 *  viewport screenshot while keeping any single image well under the WS
 *  write-queue overflow ceiling (WsWriteQueue.MAX_QUEUE_CHARS = 8M) that
 *  caused the "Stream reconnecting…" loop. Oversized images are REPLACED with
 *  a text marker rather than truncated: a cut base64 string decode-fails and
 *  renders as a broken <img> in the client (imageBlockToDataUrl), while a
 *  marker renders as honest text. */
const MAX_TOOL_RESULT_IMAGE_CHARS = 2_000_000

/** Maximum TOTAL base64 chars of image data kept across all tool_result
 *  blocks in ONE user message. The per-image cap alone doesn't bound a
 *  message's serialized size — a gallery result with several images each
 *  under MAX_TOOL_RESULT_IMAGE_CHARS could still sum past 8M. This budget
 *  caps the message-wide image contribution (4M ≈ 3MB binary) so a single
 *  WS frame stays comfortably under the queue ceiling; beyond it, further
 *  images are replaced with the marker. */
const MAX_TOOL_RESULT_TOTAL_IMAGE_CHARS = 4_000_000

/** Text marker substituted for an oversized tool_result image block. Kept
 *  terse and honest. NOTE: deliberately different wording from the client's
 *  IMAGE_MARKER (`[image omitted — reload to view]` in src/session-store/
 *  project.ts): that one is a cold-load localStorage placeholder that replay
 *  RESTORES within seconds, whereas this one means the image was dropped at
 *  the source (live pump / disk read) and is gone from the ring and wire for
 *  good — "reload to view" would be a lie here. */
const TOOL_RESULT_IMAGE_OMITTED_MARKER = '[image omitted — too large to sync]'

/** Base64 data length of an image content block, or 0 when it isn't an image
 *  with a base64 source (URL-source images carry no inline bytes and are left
 *  alone). */
function base64ImageDataLen(it: { type?: unknown; source?: unknown }): number {
  if (!it || typeof it !== 'object') return 0
  if (it.type !== 'image') return 0
  const src = it.source
  if (!src || typeof src !== 'object') return 0
  const s = src as { type?: unknown; data?: unknown }
  return s.type === 'base64' && typeof s.data === 'string' ? s.data.length : 0
}

/** Head+tail truncation with an elision marker. Keeps the first `headChars`
 *  and last `tailChars` characters of `value`, splicing
 *  `[... N chars omitted ...]` between them. Shared by the tool_result text
 *  trimming below and by session-pump's hook-output trimmer, so the omission
 *  marker wording and slice shape stay consistent across both surfaces.
 *  Callers decide the cap (when to truncate) — this helper only shapes an
 *  already-oversized value. */
export function truncateMiddle(value: string, headChars: number, tailChars: number): string {
  const head = value.slice(0, headChars)
  const tail = value.slice(value.length - tailChars)
  const omitted = value.length - head.length - tail.length
  return `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`
}

/** Trim one `tool_result` CONTENT ITEM in place: head+tail truncate long
 *  text; replace an oversized base64 image (over the per-image cap, or over
 *  the message-wide total image budget carried in `retainedSoFar`) with a
 *  text marker. Shared by the array and bare-single-object branches of
 *  trimLargeToolResultBlock so both content shapes get identical caps.
 *
 *  Returns the content to keep (a marker replacement when the image was
 *  dropped — the caller writes it back) and the number of base64 image chars
 *  RETAINED, so callers can enforce the cumulative budget across blocks and
 *  items. The returned `content` is the SAME reference as `item` unless it was
 *  replaced, so callers can write back with `if (content !== item)`. */
function trimToolResultItem(
  item: unknown,
  retainedSoFar: number,
): { content: unknown; retained: number } {
  if (!item || typeof item !== 'object') return { content: item, retained: 0 }
  const it = item as { type?: unknown; text?: unknown }
  if (it.type === 'text' && typeof it.text === 'string') {
    if (it.text.length > MAX_TOOL_RESULT_CHARS) {
      it.text = truncateMiddle(it.text, 30_000, 15_000)
    }
    return { content: it, retained: 0 }
  }
  if (it.type === 'image') {
    const dataLen = base64ImageDataLen(it)
    if (dataLen > 0) {
      if (dataLen > MAX_TOOL_RESULT_IMAGE_CHARS || retainedSoFar + dataLen > MAX_TOOL_RESULT_TOTAL_IMAGE_CHARS) {
        // Replace the whole block with a text marker. Truncating the
        // base64 string would decode-fail and render as a broken <img>
        // client-side; an explicit marker renders as honest text and
        // keeps the content non-empty (an image-only result still shows
        // something).
        return { content: { type: 'text', text: TOOL_RESULT_IMAGE_OMITTED_MARKER }, retained: 0 }
      }
      return { content: it, retained: dataLen }
    }
  }
  return { content: it, retained: 0 }
}

/** Trim one `tool_result` block's oversized content in place: head+tail
 *  truncate long text; replace oversized base64 images (over the per-image
 *  cap, or over the message-wide total image budget carried in
 *  `retainedSoFar`) with a text marker. Returns the number of image base64
 *  chars RETAINED by this block, so the caller can enforce the cumulative
 *  budget across multiple tool_result blocks in one user message. Returns 0
 *  for non-tool_result blocks and for string / text-only content. */
function trimLargeToolResultBlock(
  block: { type: unknown; content?: unknown },
  retainedSoFar: number,
): number {
  if (block.type !== 'tool_result') return 0
  const c = (block as { content?: unknown }).content
  if (typeof c === 'string') {
    if (c.length > MAX_TOOL_RESULT_CHARS) {
      ;(block as { content: string }).content = truncateMiddle(c, 30_000, 15_000)
    }
    return 0
  }
  // Bare single-block content (the SDK can emit a lone text or image block as
  // tool_result content, and the client renders it): apply the same caps via
  // the shared item trimmer, writing back only when it produced a replacement
  // (a marker object) — an in-place text truncation already propagated.
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const { content, retained } = trimToolResultItem(c, retainedSoFar)
    if (content !== c) (block as { content: unknown }).content = content
    return retained
  }
  if (Array.isArray(c)) {
    let retained = 0
    for (let i = 0; i < c.length; i++) {
      const { content, retained: r } = trimToolResultItem(c[i], retainedSoFar + retained)
      if (content !== c[i]) c[i] = content
      retained += r
    }
    return retained
  }
  return 0
}

/** Mutate `msg` in-place: trim any oversized `tool_result` content blocks
 *  inside user messages (long text is head+tail truncated; oversized base64
 *  images are replaced with a text marker), and drop the redundant top-level
 *  `tool_use_result` field the SDK attaches to the same frame.  Called by the
 *  live pump before ring insertion/broadcast AND by history-reader.normalize()
 *  on disk reads, so every downstream consumer (replay, WS push, localStorage,
 *  render) sees the trimmed version regardless of source. */
export function trimLargeToolResults(msg: SDKMessage): void {
  if (msg.type !== 'user') return
  // The SDK ALSO stores the full tool output at the TOP LEVEL of the user
  // frame (`tool_use_result`) — separate from the `message.content` tool_result
  // block, which trimLargeToolResultBlock handles above. Nothing in the app
  // reads `tool_use_result` (it duplicates content), but a large one (e.g. a
  // multi-MB WebFetch page) would otherwise ride into the history ring and WS
  // replay in full, blowing past MAX_QUEUE_CHARS on every subscribe and
  // force-closing the socket (the "Stream reconnecting…" loop). Drop it here
  // so the ring and the wire stay small. (The CLI's on-disk JSONL spells this
  // same field `toolUseResult`; history-reader.normalize() already drops that
  // by omission, so only the live snake_case variant needs handling here.)
  delete (msg as { tool_use_result?: unknown }).tool_use_result
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return
  let retainedImageChars = 0
  for (const block of content) {
    if (block && typeof block === 'object') {
      retainedImageChars += trimLargeToolResultBlock(block, retainedImageChars)
    }
  }
}
