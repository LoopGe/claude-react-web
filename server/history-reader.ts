// Reads a session's FULL historical transcript from the SDK's on-disk JSONL
// file and serves it back in offset-paginated pages so the frontend can
// lazy-load messages that have already been evicted from the in-memory ring
// (see session-manager.ts HISTORY_CAP).
//
// Why we parse the JSONL ourselves instead of using the SDK's
// `getSessionMessages()`:
//   That helper reconstructs the conversation by walking the parentUuid
//   chain backwards from a single leaf. Real transcripts have FRACTURED
//   chains (compaction / resume insert new roots), so it returns only the
//   last connected segment ?empirically 4 of 1439 messages on a long
//   session. The raw file, by contrast, is append-only and already in
//   chronological order, which is exactly the order we render in. So we
//   read lines in file order and filter to the renderable subset.
//
// Normalization contract — the page we return must be shape-compatible with
// the SDKMessage objects the live pump broadcasts, because the frontend
// renders both through the same path:
//   - keep:   user / assistant (not isMeta, not isSidechain) and
//             system with subtype error|compact_boundary|api_retry
//   - drop:   attachment / last-prompt / ai-title / queue-operation /
//             isMeta / isSidechain (subagent inner stream) / everything else
//   - parent_tool_use_id: disk lines DON'T carry this field, but the
//             frontend's main-view filter (MessageList) hides any message
//             whose parent_tool_use_id != null (tool_result content is
//             surfaced via ToolCard, not as a raw bubble). So we replicate
//             the live shape: a user line containing a tool_result block
//             gets parent_tool_use_id = that tool_use_id; real prompts and
//             assistant messages get null.
//   - receivedAt: carried from the SDK's on-disk `timestamp` (ISO) as epoch
//             ms, so disk-restored history shows its original wall-clock time
//             instead of a blank timestamp header. A top-level user prompt on
//             disk was already consumed by the SDK (it's part of the persisted
//             transcript), so we also stamp `consumedAt` — otherwise
//             deriveDeliveryStatus would flag every historical prompt as
//             'queued'. tool_result-bearing user frames are never queued
//             (parent != null), so they only get receivedAt.

import { readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { glob } from 'node:fs/promises'
import { BROADCAST_SYSTEM_SUBTYPES } from './history-utils.js'
import { createLogger } from './log.js'

const log = createLogger('history')

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
  message: unknown
}

interface RawLine {
  type: string
  subtype: string
  uuid: string
  sessionId: string
  session_id: string
  isMetad: boolean
  isSidechaind: boolean
  message: { roled: string; content: unknown }
  [k: string]: unknown
}

/** SDK interrupt placeholder. When the user interrupts a turn, the CLI
 *  writes a synthetic `user` text message into the transcript ?e.g.
 *  "[Request interrupted by user]" or "[Request interrupted by user for
 *  tool use]". The live pump never surfaces it (it's a null-parent user
 *  frame with no tool_result, so the echo-drop filter in session-pump.ts
 *  removes it), and the SDK itself skips it when deriving session titles
 *  (regex `wk` in sdk.mjs). The disk-history path must filter it too, or
 *  resume / lazy-load would render it as a bare user bubble. Mirrors the
 *  SDK's own pattern: anchored at line start, optional trailing text
 *  inside the brackets. */
const INTERRUPT_PLACEHOLDER_RE = /^\s*\[Request interrupted by user[^\]]*\]\s*$/

/** True when a user message's content is *only* the SDK interrupt
 *  placeholder text. Handles both string content and the text-block array
 *  shape; any non-text/tool_result block or extra text means it's a real
 *  message and we keep it. */
function isInterruptPlaceholder(content: unknown): boolean {
  if (typeof content === 'string') return INTERRUPT_PLACEHOLDER_RE.test(content)
  if (!Array.isArray(content)) return false
  let sawText = false
  for (const block of content) {
    if (!block || typeof block !== 'object') return false
    const b = block as { type: unknown; text?: unknown }
    if (b.type !== 'text' || typeof b.text !== 'string') return false
    if (!INTERRUPT_PLACEHOLDER_RE.test(b.text)) return false
    sawText = true
  }
  return sawText
}

/** Locate the transcript file for a session id. Session ids are globally
 *  unique UUIDs, so we glob across all project dirs rather than recreating
 *  the SDK's cwd→dirname encoding ourselves. Returns null if no file exists. Returns null if no file exists. */
async function findTranscriptFile(sessionId: string): Promise<string | null> {
  const pattern = path
    .join(homedir(), '.claude', 'projects', '*', `${sessionId}.jsonl`)
    .replace(/\\/g, '/')
  try {
    for await (const match of glob(pattern)) {
      return match // first hit ?ids are unique
    }
  } catch (err) {
    log.warn(`findTranscriptFile glob error session=${sessionId}: ${(err as Error).message ?? err}`)
  }
  return null
}

/** Delete the on-disk transcript `.jsonl` for a session id. No-op (returns
 *  false) when no transcript file exists.
 *
 *  Required by SessionManager.clear(): the `claude` CLI refuses to start a
 *  FRESH (non-resume) session whose transcript file already exists — its
 *  `iFt(sessionId)` "in use" check is `fs.statSync(<projectsDir>/<id>.jsonl)`
 *  succeeding. clear() respawns the same session-id without `--resume`, so
 *  the prior run's transcript would trip that guard ("Session ID already in
 *  use"). Deleting the file lets the fresh spawn proceed; the new process
 *  writes a brand-new transcript under the same id.
 *
 *  MUST be called AFTER the old CLI process has exited: on Windows a file
 *  held open by the dying child can't be unlinked (EPERM/EBUSY). clear()
 *  awaits the old process's exit (via the handle's processExited promise)
 *  before calling this. A failed unlink (still locked, permissions, etc.)
 *  is logged and swallowed so clear() can still attempt the respawn — but
 *  the respawn will then fail with "already in use", surfacing the problem.
 *
 *  Returns true when a file was found and removed. */
export async function deleteTranscriptFile(sessionId: string): Promise<boolean> {
  const file = await findTranscriptFile(sessionId)
  if (!file) return false
  try {
    await unlink(file)
    log.info(`deleteTranscriptFile: removed ${file}`)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    log.warn(`deleteTranscriptFile: unlink failed for ${file} (code=${code ?? 'unknown'}): ${(err as Error).message ?? err}`)
    return false
  }
}

/** Extract the tool_use_id from a user message whose content carries a
 *  tool_result block. Returns null for real user prompts. */
function toolResultParentId(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = block as { type?: string; tool_use_id?: unknown }
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      return b.tool_use_id
    }
  }
  return null
}

/** True if a raw JSONL line should appear in the rendered transcript. */
function isRenderable(o: RawLine): boolean {
  if (o.isMeta || o.isSidechain) return false
  if (o.type === 'user') {
    // Drop the SDK's interrupt placeholder (see INTERRUPT_PLACEHOLDER_RE).
    // The live pump already filters it; mirror that here so resume /
    // lazy-load don't render it as a stray user bubble.
    return !isInterruptPlaceholder(o.message?.content)
  }
  if (o.type === 'assistant') return true
  if (o.type === 'system' && typeof o.subtype === 'string' && BROADCAST_SYSTEM_SUBTYPES.has(o.subtype)) {
    return true
  }
  return false
}

/** Normalize a raw JSONL line into the live SDKMessage wire shape. */
function normalize(o: RawLine, sessionId: string): unknown {
  const parent = o.type === 'user' ? toolResultParentId(o.message?.content) : null
  // The SDK writes an ISO `timestamp` on every persisted line. Carry it as
  // receivedAt (epoch ms) so disk-restored history (resume historySeed +
  // scroll-up loadOlder) shows its original wall-clock time. NaN for
  // corrupt/old lines that lack it — those keep the old "no timestamp"
  // rendering via toTranscriptItem's undefined fallback.
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  const hasTs = Number.isFinite(ts)
  return {
    type: o.type,
    ...(typeof o.subtype === 'string' ? { subtype: o.subtype } : {}),
    uuid: o.uuid,
    session_id: o.session_id ?? sessionId,
    message: o.message,
    parent_tool_use_id: parent,
    // Explicit provenance for the client replay reducer. A resumed session's
    // history ring can contain a disk-restored prefix followed by live messages;
    // timestamps cannot distinguish those sources because both have receivedAt.
    restoredFromDisk: true,
    ...(hasTs ? { receivedAt: ts } : {}),
    // A top-level prompt on disk was already consumed by the SDK; stamp
    // consumedAt so it isn't mislabelled 'queued' by deriveDeliveryStatus.
    ...(hasTs && parent == null && o.type === 'user' ? { consumedAt: ts } : {}),
    // System task_notification frames carry tool_use_id/status/summary at the
    // TOP LEVEL (not inside `message`). Without carrying them through, a
    // disk-loaded frame (resume/scroll-up) reaches the client missing the
    // fields the reducer's completion branch needs (parseTaskNotification
    // returns null for missing tool_use_id) — background subagents never
    // flip to done on resume.
    ...(o.type === 'system' && o.subtype === 'task_notification' ? {
      ...(typeof o.tool_use_id === 'string' ? { tool_use_id: o.tool_use_id } : {}),
      ...(typeof o.status === 'string' ? { status: o.status } : {}),
      ...(typeof o.summary === 'string' ? { summary: o.summary } : {}),
      ...(typeof o.task_id === 'string' ? { task_id: o.task_id } : {}),
      ...(typeof o.output_file === 'string' ? { output_file: o.output_file } : {}),
    } : {}),
  }
}

/**
 * Read a page of historical messages from disk.
 *
 * Offset semantics: the renderable messages form a chronological array of
 * length `totalCount` (index 0 = oldest). We return the `limit` messages
 * ending just before the resolved end index:  slice[max(0, end-limit), end).
 *
 * The end index is resolved in priority order:
 *   1. `beforeUuid` ?find that uuid's disk index and page strictly before
 *      it. Used for the FIRST page: the frontend passes the oldest message
 *      currently on screen that has a disk-stable uuid (assistant /
 *      system / tool_result-bearing user). User PROMPT uuids are minted
 *      server-side at send() time and never match disk, which is why we
 *      anchor on a disk-stable type. If the uuid isn't found, fall through
 *      to the newest page.
 *   2. `before` — an explicit disk index (used for subsequent pages: pass
 *      the previous response's `startIndex`).
 *   3. neither ?`totalCount` (newest page).
 *
 * Returns an empty page (totalCount 0) when the transcript file doesn't
 * exist yet ?e.g. a session that never completed a turn.
 */
export async function readHistoryPage(
  sessionId: string,
  opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
): Promise<HistoryPage> {
  const file = await findTranscriptFile(sessionId)
  if (!file) {
    return { messages: [], totalCount: 0, startIndex: 0, hasMore: false }
  }

  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    log.warn(`readHistoryPage readFile error session=${sessionId}: ${(err as Error).message ?? err}`)
    return { messages: [], totalCount: 0, startIndex: 0, hasMore: false }
  }

  return paginateJsonl(raw, sessionId, opts)
}

/** Read every renderable historical message from disk. Used by server-side
 *  search so it can scan a transcript without resuming the SDK Query. */
export async function readHistoryEntries(
  sessionId: string,
  opts: { afterUuid?: string } = {},
): Promise<HistoryEntry[]> {
  const file = await findTranscriptFile(sessionId)
  if (!file) return []

  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    log.warn(`readHistoryEntries readFile error session=${sessionId}: ${(err as Error).message ?? err}`)
    return []
  }

  return historyEntriesFromJsonl(raw, sessionId, opts)
}

/** Pure core of readHistoryPage: parse JSONL text, filter to the renderable
 *  subset, and paginate. Exported for unit testing without touching the
 *  filesystem. */
export function paginateJsonl(
  raw: string,
  sessionId: string,
  opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
): HistoryPage {
  const renderable = parseRenderable(raw, opts)
  const total = renderable.length
  const limit = Math.max(1, Math.min(opts.limit, 1000))

  let end = total
  if (opts.beforeUuid) {
    const idx = renderable.findIndex((o) => o.uuid === opts.beforeUuid)
    // Found ?page strictly before it. Not found ?newest page (default).
    if (idx >= 0) end = idx
  } else if (opts.before != null) {
    end = Math.max(0, Math.min(opts.before, total))
  }

  const start = Math.max(0, end - limit)
  const slice = renderable.slice(start, end)

  return {
    messages: slice.map((o) => normalize(o, sessionId)),
    totalCount: total,
    startIndex: start,
    hasMore: start > 0,
  }
}

export function historyEntriesFromJsonl(
  raw: string,
  sessionId: string,
  opts: { afterUuid?: string } = {},
): HistoryEntry[] {
  return parseRenderable(raw, opts).map((message, index) => ({
    index,
    message: normalize(message, sessionId),
  }))
}

function parseRenderable(raw: string, opts: { afterUuid?: string }): RawLine[] {
  const renderable: RawLine[] = []
  let pastBoundary = !opts.afterUuid
  for (const line of raw.split('\n')) {
    if (!line) continue
    let parsed: RawLine
    try {
      parsed = JSON.parse(line) as RawLine
    } catch {
      continue // tolerate a torn final line / corrupt row
    }
    if (!pastBoundary) {
      if (parsed.uuid === opts.afterUuid) pastBoundary = true
      continue
    }
    if (isRenderable(parsed)) renderable.push(parsed)
  }
  return renderable
}
