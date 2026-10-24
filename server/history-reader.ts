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

import { open, readFile, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { claudeConfigDir } from './claude-config-dir.js'
import { isRenderableSdkMessage, trimLargeToolResults } from './history-utils.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from './log.js'
import { condensePromptPreview } from '../shared/prompt-preview.js'

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

export interface TranscriptFile {
  path: string
  mtimeMs: number
  size: number
}

/** Locate the transcript file for a session id. Session ids are globally
 *  unique UUIDs, so we scan every project dir rather than recreating the SDK's
 *  cwd→dirname encoding ourselves. Returns null if no file exists.
 *
 *  A flat readdir rather than a glob: the config dir is an arbitrary
 *  user-chosen path (CLAUDE_CONFIG_DIR), so metacharacters in it — "cfg[1]",
 *  "a*b" — would change a pattern's meaning and silently match nothing. */
export async function findTranscriptFile(sessionId: string): Promise<TranscriptFile | null> {
  const projectsDir = path.join(claudeConfigDir(), 'projects')
  // basename() so a caller-supplied id can never traverse out of the projects
  // tree — the id lands in a join() that is both read and unlinked. Session ids
  // are UUIDs, so this is a no-op for every real caller.
  const fileName = `${path.basename(sessionId)}.jsonl`
  try {
    // withFileTypes so a stray FILE dropped in projects/ (a .DS_Store, a
    // README) is skipped rather than stats'd: on POSIX that stat fails with
    // ENOTDIR, which is the ordinary "not a project dir" case, not an anomaly
    // worth logging on every lookup.
    for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
      // isDirectory() is false for a SYMLINK, and pointing a project dir at
      // another volume is a normal way to move bulk data — so follow those
      // too, or the transcript silently stops being found.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const candidate = path.join(projectsDir, entry.name, fileName)
      try {
        const s = await stat(candidate)
        return { path: candidate, mtimeMs: s.mtimeMs, size: s.size } // first hit — ids are unique
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        // Not in this project dir is the normal case (ENOENT), as is a
        // symlink that points at a file (ENOTDIR). Anything else
        // (permissions, a looping symlink) means a transcript may exist but be
        // unreadable — silently returning null would present that as "no
        // history" with nothing in the logs.
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
          log.warn(`findTranscriptFile stat failed for ${candidate}: ${e.message ?? err}`)
        }
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    // A missing projects dir is the ordinary "no transcript" case, not an
    // error: the CLI only creates it once it has written something, so a
    // fresh install (or any unknown session id) hits this on every lazy-load.
    if (e.code !== 'ENOENT') {
      log.warn(`findTranscriptFile scan error session=${sessionId}: ${e.message ?? err}`)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Last-user-prompt preview (for the /resume picker's per-row previews).
//
// The CLI appends a `{"type":"last-prompt","lastPrompt":"…"}` entry to the
// transcript around every turn, so the session's latest prompt sits at the
// very end of the file. Reading a small tail window (instead of parsing the
// whole transcript through the page cache) keeps the picker's per-row cost
// flat — "All projects" mode lists every transcript on disk.

/** How much of the file tail to read per row. Large enough to cover the
 *  newest turn's entries (last-prompt / custom-title / mode / attachments)
 *  AND to keep the torn-line edge rare: a `last-prompt` line longer than the
 *  window would be torn mid-prefix (where the prompt text lives) and lost —
 *  64 KB swallows every realistic prompt line. Still cheap per row, and the
 *  result is cached. */
const LAST_PROMPT_TAIL_BYTES = 64 * 1024

/** Single-line preview cap + condense rule come from shared/prompt-preview —
 *  shared with the client so the picker's duplicate-line dedup (server-side,
 *  in claude-provider) can never drift between the wire value and the raw
 *  firstPrompt it is compared against. */

interface LastPromptCacheEntry {
  /** Resolved transcript path; null = "no transcript exists for this id"
   *  (tombstone — e.g. clear() deleted it, the id is retired). */
  path: string | null
  size: number
  mtimeMs: number
  text: string | undefined
}

/** Keyed by SESSION id (not path), storing the resolved location: on a hit
 *  a single stat of the cached path verifies freshness (same (size, mtime)
 *  key the jsonl page cache uses) instead of re-running findTranscriptFile's
 *  full projects/ tree scan — the picker lists every transcript on disk, so
 *  an O(rows × project-dirs) locate per open would dominate the cost the
 *  tail read was meant to keep flat. Missing transcripts tombstone as
 *  path:null so a deleted-transcript row doesn't re-scan every open.
 *  Bounded LRU. */
const lastPromptCache = new Map<string, LastPromptCacheEntry>()
/** Sized to cover "All projects" mode's row count (the picker lists every
 *  transcript on disk) so a warm open is O(rows) single stats, not re-locates.
 *  Entries are tiny (path + numbers + one short string). */
const LAST_PROMPT_CACHE_CAP = 512

/** CLI-synthetic user frames (command expansions, bash echoes) start with one
 *  of these literal tags — the same narrow family the SDK's own firstPrompt
 *  derivation skips. A user prompt that merely BEGINS with '<' (pasted HTML,
 *  "<label> should be red") must still qualify, so this is deliberately NOT
 *  a broad any-XML-tag rule. */
const SYNTHETIC_FRAME_PREFIX_RE =
  /^\s*<(command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>/

/** The SDK's interrupt placeholder text ("[Request interrupted by user…]") is
 *  a user-role frame the CLI writes for an aborted turn — not a real prompt
 *  (it has no matching user echo the pump could pair, and the result-frame
 *  with no tool_result, so the echo-drop filter in session-pump.ts
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
    const b = block as { type?: unknown; text?: unknown }
    if (b.type !== 'text' || typeof b.text !== 'string') return false
    if (!INTERRUPT_PLACEHOLDER_RE.test(b.text)) return false
    sawText = true
  }
  return sawText
}

/** Parse a transcript tail window into the session's last user prompt.
 *
 *  The window may start mid-line (a tail read lands wherever the math puts
 *  it, possibly inside a huge line or a multi-byte char). There is no reliable
 *  way to tell a torn first segment from a complete one — when the window
 *  starts at a line boundary the first segment IS the complete line — so no
 *  segment is pre-emptively discarded: a torn first line fails JSON.parse
 *  (a JSON-object suffix is never valid JSON with a `type` field) and is
 *  skipped by the same corrupt-row tolerance as any other bad row.
 *
 *  Lines are scanned BACKWARD, tracking the newest candidate of EACH kind
 *  rather than returning on the first hit: `last-prompt` entries are written
 *  around turn bookkeeping, so a mid-turn tail can contain a last-prompt for
 *  the PREVIOUS turn positioned BEFORE a newer raw user message — recency is
 *  decided by file position, not entry kind. A top-level user message
 *  qualifies via a plain-string content or a content array of text (and
 *  image) blocks; tool_result frames, isMeta / isCompactSummary /
 *  isSidechain lines, interrupt placeholders, and CLI-synthetic markup frames
 *  (command expansions etc. — anything starting with an XML tag, mirroring
 *  the SDK's own firstPrompt derivation) are skipped, matching the
 *  renderable-subset rules above. Corrupt rows are skipped. */
export function parseLastUserPrompt(tail: string): string | undefined {
  if (!tail.trim()) return undefined
  let lastPromptHit: { index: number; text: string | undefined } | undefined
  let userHit: { index: number; text: string } | undefined
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    // Both newest-of-kind candidates resolved — older lines can't change
    // either, so stop.
    if (lastPromptHit && userHit) break
    const line = lines[i].trim()
    if (!line) continue
    let o: RawLine
    try {
      o = JSON.parse(line) as RawLine
    } catch {
      continue
    }
    if (o.type === 'last-prompt' && !lastPromptHit) {
      // A BLANK value is still a verdict: the CLI records "the last prompt is
      // empty" (fresh/failed turn, post-clear bookkeeping). Recording it —
      // instead of skipping to an older user message — keeps the reader's
      // recency-by-file-position rule honest. text may be undefined here.
      const raw = typeof o.lastPrompt === 'string' ? condensePromptPreview(o.lastPrompt) : undefined
      lastPromptHit = { index: i, text: raw || undefined }
      continue
    }
    if (!userHit && o.type === 'user' && !o.isMeta && !o.isSidechain && !o.isCompactSummary) {
      const content = o.message?.content
      if (typeof content === 'string') {
        if (!isInterruptPlaceholder(content) && !SYNTHETIC_FRAME_PREFIX_RE.test(content)) {
          const text = condensePromptPreview(content)
          if (text) userHit = { index: i, text }
        }
        continue
      }
      // Array content: a real prompt's blocks are text/image; a tool_result
      // frame carries a tool_result block and never qualifies. The array
      // shape of the interrupt placeholder and of the CLI-synthetic markup
      // frames (same predicate as the string branch) are skipped as well.
      if (Array.isArray(content) && !isInterruptPlaceholder(content)) {
        let hasToolResult = false
        const texts: string[] = []
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as { type?: unknown; text?: unknown }
          if (b.type === 'tool_result') hasToolResult = true
          else if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
        }
        const joined = texts.join(' ')
        if (!hasToolResult && joined && !SYNTHETIC_FRAME_PREFIX_RE.test(joined)) {
          const text = condensePromptPreview(joined)
          if (text) userHit = { index: i, text }
        }
      }
    }
  }
  if (lastPromptHit && (!userHit || lastPromptHit.index > userHit.index)) return lastPromptHit.text
  return userHit?.text
}

/** Read a session's last user prompt from its on-disk transcript (tail read,
 *  cached). Returns undefined when no transcript exists or nothing prompt-
 *  like is found in the tail — callers treat that as "no preview". */
export async function readLastUserPrompt(sessionId: string): Promise<string | undefined> {
  // Fast path: one stat against the cached location. Size+mtime unchanged →
  // the tail (and the verdict "no prompt") is still valid.
  const cached = lastPromptCache.get(sessionId)
  if (cached) {
    if (cached.path === null) {
      // Tombstone: no transcript for this id. Refresh LRU position.
      lastPromptCache.delete(sessionId)
      lastPromptCache.set(sessionId, cached)
      return undefined
    }
    try {
      const s = await stat(cached.path)
      if (s.size === cached.size && s.mtimeMs === cached.mtimeMs) {
        // Refresh LRU position on hit.
        lastPromptCache.delete(sessionId)
        lastPromptCache.set(sessionId, cached)
        return cached.text
      }
    } catch {
      // File gone / moved — fall through to a fresh locate.
    }
  }
  const file = await findTranscriptFile(sessionId)
  if (!file) {
    // Tombstone the negative verdict (display-only feature; the usual
    // producers of a permanently-missing transcript are clear() / delete,
    // where the id is retired) so this row stops re-scanning the tree.
    lastPromptCache.delete(sessionId)
    lastPromptCache.set(sessionId, { path: null, size: 0, mtimeMs: 0, text: undefined })
    if (lastPromptCache.size > LAST_PROMPT_CACHE_CAP) {
      const oldest = lastPromptCache.keys().next().value
      if (oldest !== undefined) lastPromptCache.delete(oldest)
    }
    return undefined
  }
  let text: string | undefined
  try {
    const start = Math.max(0, file.size - LAST_PROMPT_TAIL_BYTES)
    const length = file.size - start
    const buf = Buffer.alloc(length)
    const fh = await open(file.path, 'r')
    try {
      await fh.read(buf, 0, length, start)
    } finally {
      await fh.close()
    }
    text = parseLastUserPrompt(buf.toString('utf8'))
  } catch (err) {
    // Unreadable transcript → no preview for this row, same fail-soft as
    // findTranscriptFile. NOT cached: a transient failure (Windows EBUSY /
    // antivirus / the CLI still holding the file) must not pin "no preview"
    // for the process lifetime on a session whose transcript never changes
    // again — the next picker open retries.
    log.warn(`readLastUserPrompt failed session=${sessionId}: ${(err as Error).message ?? err}`)
    return undefined
  }
  lastPromptCache.delete(sessionId)
  lastPromptCache.set(sessionId, { path: file.path, size: file.size, mtimeMs: file.mtimeMs, text })
  if (lastPromptCache.size > LAST_PROMPT_CACHE_CAP) {
    const oldest = lastPromptCache.keys().next().value
    if (oldest !== undefined) lastPromptCache.delete(oldest)
  }
  return text
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
    await unlink(file.path)
    log.info(`deleteTranscriptFile: removed ${file.path}`)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    log.warn(`deleteTranscriptFile: unlink failed for ${file.path} (code=${code ?? 'unknown'}): ${(err as Error).message ?? err}`)
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

/** True if a raw JSONL line should appear in the rendered transcript.
 *  Delegates to the shared isRenderableSdkMessage predicate in
 *  history-utils.ts (BROADCAST_SYSTEM_SUBTYPES + tool_use_summary +
 *  interrupt-placeholder + isMeta/isSidechain gates) — the SAME judgment the
 *  live seq-store ingest uses, so disk pages and the seq window can't drift
 *  apart. `result` lines don't exist on disk (the SDK never writes them);
 *  they re-enter the transcript via mergeResultFrames. */
function isRenderable(o: RawLine): boolean {
  return isRenderableSdkMessage(o)
}

/** Copy whitelisted TOP-LEVEL fields from a raw line through to the wire
 *  shape, keeping only primitive / string-array values. Several frames carry
 *  their payload at the top level (NOT inside `message`); normalize()'s base
 *  object drops those, so disk-loaded frames would reach the client missing
 *  the fields the renderer / eviction logic needs. Fields absent or of an
 *  unexpected shape are skipped — defensive against SDK drift. */
function pickTopLevel(o: RawLine, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const raw = o as Record<string, unknown>
  for (const f of fields) {
    const v = raw[f]
    if (
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ||
      (Array.isArray(v) && v.every((x) => typeof x === 'string'))
    ) {
      out[f] = v
    }
  }
  return out
}

/** Pick the known scalar fields of a `compact_metadata` object (the only
 *  nested object a renderable system frame carries at the top level).
 *  Returns `{}` when nothing of the right shape is present. */
function pickCompactMetadata(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {}
  const m = meta as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  if (typeof m.trigger === 'string') picked.trigger = m.trigger
  if (typeof m.pre_tokens === 'number') picked.pre_tokens = m.pre_tokens
  if (typeof m.post_tokens === 'number') picked.post_tokens = m.post_tokens
  if (typeof m.duration_ms === 'number') picked.duration_ms = m.duration_ms
  return Object.keys(picked).length > 0 ? { compact_metadata: picked } : {}
}

/** Normalize a raw JSONL line into the live SDKMessage wire shape.
 *  `trim` applies the same oversized tool_result cap the live pump does
 *  (see trimLargeToolResults). The render/replay paths (paginateJsonl —
 *  resume seed, lazy-load, WS replay) MUST trim so a multi-MB tool_result
 *  can't blow WsWriteQueue.MAX_QUEUE_CHARS. The search/index path
 *  (historyEntriesFromJsonl) reads content only to extract plain text and
 *  build small snippets — it never ships the full message over WS — so it
 *  passes `trim: false` to keep full recall on the on-disk text. */
export function normalize(o: RawLine, sessionId: string, trim: boolean): unknown {
  const parent = o.type === 'user' ? toolResultParentId(o.message?.content) : null
  // The SDK writes an ISO `timestamp` on every persisted line. Carry it as
  // receivedAt (epoch ms) so disk-restored history (resume historySeed +
  // scroll-up loadOlder) shows its original wall-clock time. NaN for
  // corrupt/old lines that lack it — those keep the old "no timestamp"
  // rendering via toTranscriptItem's undefined fallback.
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  const hasTs = Number.isFinite(ts)
  const out = {
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
    // permission_denied / informational / model_refusal_fallback frames carry
    // their payloads at the TOP LEVEL (`message` on permission_denied already
    // flows via the generic `message: o.message` passthrough above — it is a
    // plain string there, which the client renders defensively).
    ...(o.type === 'system' && o.subtype === 'permission_denied'
      ? pickTopLevel(o, ['tool_name', 'tool_use_id', 'agent_id', 'decision_reason_type', 'decision_reason'])
      : {}),
    ...(o.type === 'system' && o.subtype === 'informational'
      ? pickTopLevel(o, ['content', 'level', 'tool_use_id', 'prevent_continuation'])
      : {}),
    ...(o.type === 'system' && o.subtype === 'model_refusal_fallback'
      ? pickTopLevel(o, [
        'trigger', 'direction', 'original_model', 'fallback_model',
        'api_refusal_category', 'api_refusal_explanation', 'content',
        'retracted_message_uuids',
      ])
      : {}),
    // model_refusal_no_fallback carries its payload at the TOP LEVEL (the
    // `content` banner + original_model + refusal metadata). Without carrying
    // them through, a disk-loaded frame (resume / scroll-up) reaches the client
    // with only `message` — the refusal notice card would render empty.
    ...(o.type === 'system' && o.subtype === 'model_refusal_no_fallback'
      ? pickTopLevel(o, [
        'original_model', 'request_id', 'api_refusal_category',
        'api_refusal_explanation', 'refused_user_message_uuid', 'content',
      ])
      : {}),
    // plugin_install carries its lifecycle state at the TOP LEVEL
    // (status/name/error, per SDKPluginInstallMessage). Without carrying them
    // through, a disk-loaded frame (resume / scroll-up) reaches the client with
    // only `message`, so a persistent PluginInstall card would render empty.
    ...(o.type === 'system' && o.subtype === 'plugin_install'
      ? pickTopLevel(o, ['status', 'name', 'error'])
      : {}),
    // The refusal-fallback supersede list on assistant frames: evict-on-arrival
    // uuids for the refused leg. Needed so a disk-replayed transcript applies
    // the same eviction the live path does (evictMessages is idempotent).
    ...(o.type === 'assistant' ? pickTopLevel(o, ['supersedes']) : {}),
    // tool_use_summary carries its whole payload at the top level.
    ...(o.type === 'tool_use_summary'
      ? pickTopLevel(o, ['summary', 'preceding_tool_use_ids'])
      : {}),
    // compact_boundary carries its identity at the TOP LEVEL: the app-level
    // `handoff` flag (only on the /handoff synthetic boundary) plus
    // `compact_metadata` (trigger/pre_tokens/post_tokens/duration_ms — from
    // the CLI's own compaction or the synthetic one). Without carrying them
    // through, a disk-loaded boundary (resume / scroll-up) reaches the client
    // with only `message`, so CompactBoundary falls back to the generic
    // "compacted to fit the context window" copy and loses the Handoff
    // variant entirely. compact_metadata is a nested object, so it needs its
    // own field-pick (pickTopLevel only allows primitives / string[]).
    //
    // Reachability note: the `handoff` half only fires if a synthetic handoff
    // boundary is ever routed through normalize(). Today the synthetic
    // boundary (seedCompactSummary) is "client-only — the SDK never sees it":
    // it lives in the history ring + transcript sidecar (already-normalized
    // shape) and never appears in the SDK JSONL this reader parses. The
    // `compact_metadata` half IS live — CLI-native boundaries are in the
    // JSONL and lose their token counts otherwise.
    ...(o.type === 'system' && o.subtype === 'compact_boundary'
      ? {
        ...pickTopLevel(o, ['handoff']),
        ...pickCompactMetadata(o.compact_metadata),
      }
      : {}),
  }
  // Apply the same oversized tool_result cap the live pump does. Disk lines
  // pass `message.content` through verbatim, so without this a resumed seed /
  // lazy-load page could replay a multi-MB tool_result over WS and trip
  // WsWriteQueue.MAX_QUEUE_CHARS (the "Stream reconnecting…" loop).
  // trimLargeToolResults is a no-op for non-user frames and the on-disk
  // camelCase `toolUseResult` top-level field is already dropped above by
  // omission, so only the content blocks are touched here.
  if (trim) trimLargeToolResults(out as SDKMessage)
  return out
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
    raw = await readFile(file.path, 'utf8')
  } catch (err) {
    log.warn(`readHistoryEntries readFile error session=${sessionId}: ${(err as Error).message ?? err}`)
    return []
  }

  return historyEntriesFromJsonl(raw, sessionId, opts)
}

/** Backfill turn anchors from the on-disk transcript for sessions whose
 *  turns completed BEFORE the turn-anchor sidecar existed (i.e. before the
 *  "discard from here" feature shipped). The sidecar is only populated by
 *  the pump on NEW success results, so without this a long-lived session
 *  has zero legal cut points even though it has hundreds of completed turns.
 *
 *  A turn's LAST main-thread assistant frame is identified by
 *  `message.stop_reason !== 'tool_use'` — `tool_use` means the turn is
 *  mid-flight (calling a tool, expecting a tool_result to continue), so
 *  cutting there would orphan the result. Frames with `error` /
 *  `isApiErrorMessage` are excluded (failed turns are indeterminate, mirroring
 *  the pump's `lastSafeResumeUuid` which is promoted only on
 *  `result.subtype === 'success'`). `result` frames are NOT on disk, so
 *  `stop_reason` + `error` are the available success signals.
 *
 *  Returns anchors in chronological (file) order with `completedAt` from the
 *  line's `timestamp`. Used by SessionManager.listDiscardAnchors / discard
 *  to seed the sidecar when it's empty — after the first call the sidecar
 *  holds the backfill and subsequent calls read it directly. */
export async function readTurnAnchorsFromDisk(
  sessionId: string,
): Promise<Array<{ assistantUuid: string; completedAt: number }>> {
  const file = await findTranscriptFile(sessionId)
  if (!file) return []
  let raw: string
  try {
    raw = await readFile(file.path, 'utf8')
  } catch (err) {
    log.warn(`readTurnAnchorsFromDisk readFile error session=${sessionId}: ${(err as Error).message ?? err}`)
    return []
  }
  return turnAnchorsFromJsonl(raw)
}

/** True when an assistant message's content is ONLY tool_use blocks (no
 *  text/thinking) — i.e. a mid-turn tool call, not a turn-ending reply.
 *  Used as a fallback for older SDK transcripts whose tool-call frames
 *  don't carry `stop_reason: 'tool_use'`. */
function isToolUseOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false
  let sawToolUse = false
  for (const block of content) {
    if (!block || typeof block !== 'object') return false
    const b = block as { type?: string }
    if (b.type === 'tool_use') {
      sawToolUse = true
    } else if (b.type === 'text' || b.type === 'thinking') {
      // Has a renderable non-tool block → not tool-only (could be a mixed
      // turn-end frame with text + trailing tool_use). Keep it.
      return false
    }
    // Other block types (e.g. redacted_thinking) don't disqualify either way.
  }
  return sawToolUse
}

/** Pure core of readTurnAnchorsFromDisk: parse JSONL text and derive
 *  success-turn anchors. Exported for unit testing without touching the
 *  filesystem. See readTurnAnchorsFromDisk for the selection rationale. */
export function turnAnchorsFromJsonl(
  raw: string,
): Array<{ assistantUuid: string; completedAt: number }> {
  const anchors: Array<{ assistantUuid: string; completedAt: number }> = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let parsed: RawLine
    try {
      parsed = JSON.parse(line) as RawLine
    } catch {
      continue
    }
    // Main-thread assistant frames only (sidechain = subagent inner stream).
    if (parsed.type !== 'assistant' || parsed.isSidechain) continue
    const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : undefined
    if (!uuid) continue
    const msg = parsed.message as { stop_reason?: unknown; content?: unknown }
    // A turn's LAST assistant frame is the cut point. Identify it:
    //   - stop_reason === 'tool_use' → mid-turn tool call (expects a
    //     tool_result to continue) → NOT a turn end, always exclude.
    //   - stop_reason === 'end_turn' / 'stop_sequence' → explicit turn end.
    //   - stop_reason missing (older SDK versions didn't write it) → fall
    //     back to content shape: a frame whose content is ONLY tool_use
    //     blocks (no text/thinking) is a mid-turn tool call, not a turn end.
    //     This catches the 95/107 `(none)` frames on real transcripts that
    //     are mid-turn tool calls the old SDK just didn't tag.
    if (msg.stop_reason === 'tool_use') continue
    if (
      (msg.stop_reason === undefined || msg.stop_reason === null || msg.stop_reason === '') &&
      isToolUseOnlyContent(msg.content)
    ) continue
    // Failed turns (API error / explicit error) are indeterminate — skip,
    // mirroring the pump's success-only lastSafeResumeUuid promotion.
    if (parsed.error || parsed.isApiErrorMessage) continue
    const ts = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN
    anchors.push({ assistantUuid: uuid, completedAt: Number.isFinite(ts) ? ts : Date.now() })
  }
  return anchors
}

/** Pure window computation shared by the raw-string and cached pagination
 *  paths. `beforeUuid` needs the caller's uuid accessor because the two
 *  callers store uuids differently (renderable lines vs a parallel array).
 *  The window is [start, end): the `limit` messages ending just before the
 *  resolved end index. Resolution order: beforeUuid → before → newest. */
export function sliceWindow(
  total: number,
  opts: {
    before?: number
    beforeUuid?: string
    limit: number
    uuidAt: (index: number) => string | undefined
  },
): { start: number; end: number } {
  const limit = Math.max(1, Math.min(opts.limit, 1000))
  let end = total
  if (opts.beforeUuid) {
    for (let i = 0; i < total; i++) {
      if (opts.uuidAt(i) === opts.beforeUuid) {
        end = i
        break
      }
    }
  } else if (opts.before != null) {
    end = Math.max(0, Math.min(opts.before, total))
  }
  return { start: Math.max(0, end - limit), end }
}

/** Slice pre-parsed renderable lines into a page. Used by `paginateJsonl`
 *  (parse-then-serve) and by the JSONL page cache, which holds the same
 *  renderable lines already normalized. */
export function paginateRenderable(
  renderable: RawLine[],
  sessionId: string,
  opts: { before?: number; beforeUuid?: string; limit: number },
): HistoryPage {
  const total = renderable.length
  const { start, end } = sliceWindow(total, {
    before: opts.before,
    beforeUuid: opts.beforeUuid,
    limit: opts.limit,
    uuidAt: (i) => renderable[i]?.uuid,
  })
  const slice = renderable.slice(start, end)
  return {
    messages: slice.map((o) => normalize(o, sessionId, true)),
    totalCount: total,
    startIndex: start,
    hasMore: start > 0,
  }
}

/** Read a page from a raw JSONL transcript string. Kept as the pure
 *  (filesystem-free) reference implementation; the cached path lives in
 *  jsonl-cache.ts and must produce identical pages. */
export function paginateJsonl(
  raw: string,
  sessionId: string,
  opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
): HistoryPage {
  return paginateRenderable(parseRenderable(raw, opts), sessionId, opts)
}

export function historyEntriesFromJsonl(
  raw: string,
  sessionId: string,
  opts: { afterUuid?: string } = {},
): HistoryEntry[] {
  return parseRenderable(raw, opts).map((message, index) => ({
    index,
    // No trim: this path feeds search (extractMessagePlainText) and discard
    // anchor previews (assistant text), which read content to build snippets /
    // previews and never ship the full message over WS. Trimming here would
    // only destroy on-disk search recall.
    message: normalize(message, sessionId, false),
  }))
}

export function parseRenderable(raw: string, opts: { afterUuid?: string }): RawLine[] {
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
