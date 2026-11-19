// Neutral transcript-format contract: the SDK-free structural shapes of a
// raw transcript line and the history read surfaces, the renderability
// predicates that decide which frames belong in the durable transcript, the
// session-id safety guard, and the default state-directory name. The only
// import is node:path (a Node builtin, not a host-domain module), so this is
// safe to import from both host and host-free code.

import path from 'node:path'

export interface HistoryPage {
  /** Renderable messages in chronological order, normalized to the live
   *  SDKMessage wire shape. */
  messages: unknown[]
  /** Total number of renderable messages in the transcript. */
  totalCount: number
  /** Disk index of the first message in `messages` (0-based). */
  startIndex: number
  /** True when there are older messages before `startIndex`. */
  hasMore: boolean
}

export interface HistoryEntry {
  /** Renderable-message index in chronological order after clear-boundary filtering. */
  index: number
  /** 0-based RAW log line / native event ordinal BEFORE afterUuid/renderability
   *  filtering (spec §4). Stable identity for UUID-less provider rows; filtering
   *  must never renumber it. */
  sourceOrdinal: number
  message: unknown
}

/** Ordered-reconcile history read (spec §7.1). `missing` is only ENOENT/no
 *  transcript; permission/IO/mid-parse errors throw. `boundary-not-found` means
 *  an explicit afterUuid was absent. `tornTail` marks a crash-torn final line
 *  whose verified prefix is returned. */
export interface HistoryReadResult {
  status: 'ok' | 'missing' | 'boundary-not-found'
  entries: HistoryEntry[]
  tornTail?: boolean
}

export interface RawLine {
  type?: string
  subtype?: string
  uuid?: string
  sessionId?: string
  session_id?: string
  isMeta?: boolean
  isSidechain?: boolean
  /** CLI compaction-summary frame — not a user prompt. */
  isCompactSummary?: boolean
  message?: { role?: string; content?: unknown }
  [k: string]: unknown
}

export function isSafeSessionId(sessionId: string): boolean {
  const safeSessionId = path.basename(sessionId)
  return Boolean(safeSessionId) && safeSessionId === sessionId && safeSessionId !== '.' && safeSessionId !== '..'
}

export const DEFAULT_DIR_NAME = '.claude-react-web'

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
  'plugin_install',
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
  // The primary model refused (stop_reason "refusal") and NO retry ran — no
  // fallback is configured, or per-category routing declined the retry. There
  // is no retracted leg (nothing was re-run), but the user must see WHY the
  // turn ended: this renders as a refusal notice card.
  'model_refusal_no_fallback',
])

// ---------------------------------------------------------------------------
// isRenderableSdkMessage — the shared "belongs in the durable transcript"
// predicate. Lives HERE because three consumers need the identical judgment:
//   1. history-reader.isRenderable — which raw JSONL lines render on disk
//      pages (resume seed, lazy-load, search);
//   2. the transcript seq store's ingest gate (transcript-sidecar's
//      recordTranscriptMessage) — which live messages get a seq;
//   3. (via 2) the reconcile back-fill, so a cold rebuild from the JSONL
//      assigns the same seq space the live path did.
// One predicate instead of two near-copies is what keeps live-assigned seqs
// and disk-rebuilt seqs aligned: any drift would shift every later seq.
// ---------------------------------------------------------------------------

/** SDK interrupt placeholder. When the user interrupts a turn, the CLI
 *  writes a synthetic `user` text message into the transcript, e.g.
 *  "[Request interrupted by user]" or "[Request interrupted by user for
 *  tool use]". It renders as a bare user bubble on both the live and disk
 *  paths, so both exclude it. Mirrors the SDK's own pattern: anchored at
 *  line start, optional trailing text inside the brackets. */
const INTERRUPT_PLACEHOLDER_RE = /^\s*\[Request interrupted by user[^\]]*\]\s*$/

/** True when a user message's content is *only* the SDK interrupt
 *  placeholder text. Handles both string content and the text-block array
 *  shape; any non-text/tool_result block or extra text means it's a real
 *  message and we keep it. */
export function isInterruptPlaceholder(content: unknown): boolean {
  if (typeof content === 'string') return INTERRUPT_PLACEHOLDER_RE.test(content)
  if (!Array.isArray(content)) return false
  let sawText = false
  for (const block of content) {
    if (!block || typeof block !== 'object') return false
    const b = block as { type?: unknown; text?: unknown }
    if (b.type !== 'text' || typeof b.text !== 'string') return false
    if (!INTERRUPT_PLACEHOLDER_RE.test(b.text)) return false
    sawText = true
  }
  return sawText
}

/** True when a message belongs in the durable transcript — the set the
 *  client renders as top-level rows. Accepts both shapes that carry the
 *  decision fields: a live SDKMessage (sidechain marked by
 *  `parent_tool_use_id`) and a raw disk JSONL line (sidechain marked by
 *  `isSidechain`; `parent_tool_use_id` absent → the nullish check passes).
 *  `result` frames have no on-disk lines (the SDK doesn't persist them) but
 *  ARE part of the rendered transcript (per-turn result summaries), so they
 *  pass here and are re-attached on the disk side by mergeResultFrames. */
export function isRenderableSdkMessage(msg: {
  type?: string
  subtype?: string
  message?: { content?: unknown }
  parent_tool_use_id?: string | null
  isMeta?: boolean
  isSidechain?: boolean
}): boolean {
  if (msg.isMeta || msg.isSidechain) return false
  if (msg.parent_tool_use_id != null) return false // subagent inner stream
  if (msg.type === 'user') {
    return !isInterruptPlaceholder(msg.message?.content)
  }
  if (msg.type === 'assistant' || msg.type === 'result' || msg.type === 'tool_use_summary') {
    return true
  }
  if (msg.type === 'system') {
    return BROADCAST_SYSTEM_SUBTYPES.has(msg.subtype ?? '')
  }
  return false
}
