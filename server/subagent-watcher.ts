// Background-subagent completion detection via the subagent's own on-disk
// transcript.
//
// PROBLEM: the CLI does not reliably emit a `system`/`task_notification`
// frame for Agent-launched background subagents (verified: across multiple
// background Agent dispatches the parent stream receives zero task_*
// frames). So the client reducer's completion branch never fires, the
// `background` record never flips to `done`, and its WorkingBubble chip
// reappears on every subsequent parent turn.
//
// PRIMARY PATH (added later, probe-verified on SDK 0.3.252 / CLI 2.1.252): the
// CLI's `SubagentStop` hook fires with `agent_id` + `agent_transcript_path` the
// moment an agent stops — BEFORE any task_* frame it may emit. HOWEVER, the
// hook is NOT a final-completion edge: it fires at BOTH kinds of stop — the
// final one AND a pause where the subagent still has live background work of
// its own — and the hook's `background_tasks` list is the PARENT session's
// in-flight set that LAGS the stop edge (probe-verified: at a subagent's own
// final stop, its own entry still reads 'running'), so it cannot discriminate
// either. Both probe results live in server/subagent-watcher.test.ts.
//
// Therefore the resolution model is:
//   - SubagentStop with `background_tasks` PRESENT → hold the watcher (do not
//     settle, suppress the poll's transcript path — the pause writes a
//     terminal-shaped line too). The authoritative finality signal is the
//     parent Stop hook's in-flight list: `BackgroundWatcherRegistry
//     .settleUnlisted` (called from the Stop-hook reconcile) settles watchers
//     whose agent LEFT the list, with the transcript's real final text.
//   - SubagentStop with `background_tasks` ABSENT (old CLI) → settle
//     immediately (legacy behaviour; the poll's transcript path stays active).
//   - maxMs backstop → synthesize `stopped` (never-strand guarantee; also the
//     last resort for a held watcher that never gets swept).
//
// The sidebar's backgroundSubagentCount derives from the folded task map (CLI
// task-list liveness), not from this registry — see SessionManager.info().
//
// The polling described below is the FALLBACK for what the hook cannot cover:
// a CLI too old to deliver the hook, or a hook that never arrives. Whichever
// path resolves first deletes the watcher entry, so the others become no-ops.
// Because it is only a fallback it polls slowly (every 2 s for the first 30 s,
// then every 15 s, 2 h backstop) and reads incrementally: each watcher owns a
// TranscriptTail that async-reads only the bytes appended since its last read
// and feeds them line by line to a stateful parser, so a long transcript is
// never re-read or re-parsed and no poll blocks the event loop. Completions
// resolve the session BY ID at completion time (a resume can replace the
// Session object a watcher was armed against).
//
// SOLUTION (fallback): the CLI DOES write the subagent's transcript to
//   <cliHome>/projects/<encodedCwd>/<sessionId>/subagents/agent-<agentId>.jsonl
// and appends a final assistant message with `message.stop_reason` when the
// subagent settles. The launch ack carries the `agentId`, so we can locate
// the transcript, poll it, and synthesize a `system`/`task_notification`
// frame for the client when the subagent completes — feeding the reducer's
// existing completion branch.
//
// FRAGILITY: this reads the CLI's on-disk layout directly (the SDK exposes
// no subagent-transcript API), so it depends on the CLI's project-dir
// encoding and the `subagents/agent-<id>.jsonl` path. If the CLI changes
// either, real completion is never detected and only the maxMs backstop (a
// synthesized `stopped`) eventually clears the record — no crash, no false
// `completed`. The previous design's "fall back to the turn-end sweep" was
// a no-op once the parent turn had ended (the record was already `pending`),
// so it is no longer relied upon: the maxMs backstop synthesizes a frame so
// the record can never strand.

import { cp, mkdir, open, readdir, type FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { claudeConfigDir } from './claude-config-dir.js'
import { createLogger } from './log.js'
import type { Session, GlobalSessionEvent, SessionInfo } from './session-types.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { pushBounded, stampReceivedAt } from './history-utils.js'
import { isTerminalTaskStatus } from '../shared/tasks.js'

const log = createLogger('subagent-watcher')

/** Poll cadence while a watcher is hold-latched (SubagentStop reported the
 *  subagent paused with in-flight work of its own). The transcript path is
 *  dead while latched, so the tick only services the maxMs backstop — no
 *  point burning the fast/steady cadence on it. */
const SUPPRESSED_POLL_INTERVAL_MS = 30_000

/** The CLI encodes a cwd into a project-dir segment by replacing drive / path
 *  separators with '-': "D:/codes/x" -> "D--codes-x". Replicated here because
 *  the SDK doesn't expose subagent transcript access — we read the file the
 *  CLI writes, whose path uses this encoding.
 *
 *  Trailing separators are stripped BEFORE encoding so "D:/codes/x/" encodes
 *  to "D--codes-x" (not "D--codes-x-"), matching the CLI which resolves the
 *  cwd to a canonical path before encoding. Without this, a trailing separator
 *  produces a mismatched project-dir segment and the watcher never finds the
 *  transcript. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\]+$/, '').replace(/[:\\/]/g, '-')
}

/** Path of a background subagent's own transcript. */
export function subagentTranscriptPath(cwd: string, sessionId: string, agentId: string): string {
  return path.join(claudeConfigDir(), 'projects', encodeCwd(cwd), sessionId, 'subagents', `agent-${agentId}.jsonl`)
}

/** Parse the agentId out of an async launch-ack tool_result body. The ack
 *  text looks like "Async agent launched successfully. ... agentId: <id> ...
 *  ". Returns null when no agentId is present (e.g. a synchronous subagent's
 *  real tool_result, which never carries this marker). */
export function parseAckAgentId(ackText: unknown): string | null {
  const text = typeof ackText === 'string' ? ackText : ''
  if (!text) return null
  const m = text.match(/agentId:\s*([A-Za-z0-9_-]+)/)
  return m ? m[1] : null
}

export interface SubagentCompletion {
  status: 'completed' | 'stopped'
  /** The subagent's final assistant text (joined text blocks), used as the
   *  synthesized task_notification's summary so the reducer merges it as the
   *  subagent's result. Empty if the subagent ended with no text. */
  summary: string
}

/** The shared "no completion evidence" outcome: the subagent died with its
 *  host process (or its sidecar transcript is missing/unreadable), so it can
 *  never produce a terminal frame. One home for the semantic decision
 *  "missing evidence settles STOPPED, never completed" — the watcher's
 *  process-exit path, the in-flight-list sweep, and the resume seed's
 *  completion backfill all mean exactly this when they reach for it. */
export const STOPPED_SUBAGENT_COMPLETION: SubagentCompletion = Object.freeze({
  status: 'stopped',
  summary: '',
}) as SubagentCompletion

/** Build the `system`/`task_notification` frame announcing one settled
 *  background subagent. The SINGLE shape both delivery paths use — the
 *  registry's live broadcast (BackgroundWatcherRegistry) and the resume
 *  seed's backfill (SessionManager.backfillSubagentCompletions) — so the two
 *  can never drift on the wire shape the client reducer's completion branch
 *  matches against (`tool_use_id` + `status` + `summary`). */
export function buildTaskNotificationFrame(opts: {
  sessionId: string
  toolUseId: string
  agentId: string
  completion: SubagentCompletion
}): SDKMessage {
  const msg: SDKMessage = {
    type: 'system',
    subtype: 'task_notification',
    task_id: opts.agentId,
    tool_use_id: opts.toolUseId,
    status: opts.completion.status,
    summary: opts.completion.summary,
    output_file: '',
    uuid: randomUUID(),
    session_id: opts.sessionId,
  } as unknown as SDKMessage
  // receivedAt is left ABSENT here on purpose: stampReceivedAt is
  // set-only-if-absent AND monotonic — a hand-set Date.now() would defeat the
  // monotonic half and could sort a synthesized frame BEFORE same-ms frames
  // that arrived earlier (mergedHistory's total-order contract).
  stampReceivedAt(msg)
  return msg
}

/** Flatten a message `content` payload (string | array of blocks) to its
 *  joined text. Local to the watcher. */
function extractTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content as Array<{ type?: string; text?: unknown }>) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/** stop_reason values that mean the subagent is STILL RUNNING (will emit more
 *  after the tool result / pause resolves). 'tool_use' is set on every
 *  completed tool-calling assistant response — treating it as completion
 *  false-completes any tool-using subagent within seconds of launch (the
 *  common case). 'pause_turn' is a mid-flight pause (the subagent will
 *  resume) and must likewise NOT be treated as completion. Any OTHER
 *  stop_reason (end_turn, max_tokens, max_turns, stop_sequence, refusal, …)
 *  means the subagent has stopped producing → terminal. We use a denylist of
 *  the known non-terminal reasons rather than an allowlist so that a
 *  terminal-but-unfamiliar reason (e.g. a CLI-specific 'max_turns') still
 *  completes instead of polling until the maxMs fallback.
 *
 *  Hoisted to module scope: it is a constant, and readSubagentCompletion runs
 *  once per poll per watcher, so a per-call allocation would churn GC over a
 *  long backstop window. */
const NON_TERMINAL_STOP_REASONS = new Set(['tool_use', 'pause_turn'])

/** The CLI assigns `stop_sequence` to a response the API cut off mid-stream
 *  — the assistant message carries an error notice like "API Error: Connection
 *  lost mid-response. The response above may be incomplete." The subagent then
 *  recovers and keeps producing on its next turn, so this is NOT a completion.
 *  A genuine stop_sequence (the model hit a configured stop sequence and
 *  returned its final output) does NOT carry this marker — its text is the
 *  real final answer. We match the marker against the assistant message's full
 *  text, so the two are distinguished precisely. */
const API_ERROR_TRUNCATION_RE = /API Error: .*mid-response/i

/** Classify one transcript line: the final text when it is a TERMINAL
 *  assistant message, else null (blank, malformed/partial, non-assistant,
 *  non-terminal stop_reason, or an API-error truncation). */
function terminalTextOf(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let obj: { type?: string; message?: { stop_reason?: unknown; content?: unknown } }
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null // partial line (file mid-write) — skip, retry next poll
  }
  if (!obj || obj.type !== 'assistant' || !obj.message) return null
  const sr = obj.message.stop_reason
  if (typeof sr !== 'string') return null
  if (NON_TERMINAL_STOP_REASONS.has(sr)) return null // mid-tool-call — keep polling
  // A response truncated by a transient API/connection error is NOT a
  // completion — the subagent recovers and keeps producing on its next
  // turn. The CLI writes the error notice as the whole text of the
  // stop_sequence message, so a text match distinguishes it from a genuine
  // stop_sequence (the model hit a configured stop sequence and returned
  // its final output), which stays a normal completion.
  const blockText = extractTextBlocks(obj.message.content)
  if (API_ERROR_TRUNCATION_RE.test(blockText)) return null // transient error — keep polling
  return blockText
}

/** Stateful, line-at-a-time form of the transcript completion grammar, so a
 *  tail can feed only the lines appended since its last read. The last
 *  terminal assistant message wins (a later one overwrites an earlier one).
 *
 *  Any terminal stop_reason means the subagent stopped producing and
 *  returned its final text — a normal completion. stop_sequence / max_turns /
 *  max_tokens are NOT errors: the subagent ran within its bounds and returned
 *  output, exactly like end_turn. Mapping them to 'stopped' (which the reducer
 *  renders as the interrupted/error state → exclamation icon) was a false
 *  positive for subagents ending on a non-end_turn terminal reason. Only the
 *  maxMs backstop (no terminal frame at all — the subagent was killed /
 *  stranded mid-work) synthesizes 'stopped'; a real terminal frame is always
 *  'completed'. */
export class SubagentCompletionParser {
  private lastText: string | null = null

  feedLine(line: string): void {
    const text = terminalTextOf(line)
    if (text !== null) this.lastText = text
  }

  /** The completion so far. `trailingPartial` (the bytes after the last
   *  newline) is parsed speculatively WITHOUT committing it: a final line with
   *  no trailing newline is a complete record more often than not (the old
   *  whole-file parse accepted it), but if it later turns out to be the head
   *  of a longer line the committed state must not have absorbed it. */
  result(trailingPartial?: string): SubagentCompletion | null {
    const speculative = trailingPartial ? terminalTextOf(trailingPartial) : null
    const text = speculative ?? this.lastText
    if (text === null) return null
    return { status: 'completed', summary: text }
  }

  reset(): void {
    this.lastText = null
  }
}

/** Upper bound for one read() call into a transcript, so a large first read
 *  (a long-running subagent the watcher armed late) is streamed through the
 *  decoder in bounded chunks instead of one giant buffer. */
const TAIL_CHUNK_BYTES = 1024 * 1024

/** Incremental async reader of one subagent transcript. Each `read()` reads
 *  only the bytes appended since the previous read, decodes them through a
 *  persistent UTF-8 decoder (a multi-byte character can straddle two reads),
 *  feeds the complete lines to a {@link SubagentCompletionParser}, and keeps
 *  the unterminated tail for the next read. A file that SHRANK since the last
 *  read was rewritten — the state resets and the new content is re-parsed.
 *
 *  Never throws: a missing file (ENOENT — the subagent hasn't written yet) or
 *  any other read error resolves to the completion parsed so far (null for a
 *  fresh tail), i.e. "not done yet".
 *
 *  Reads never overlap (they share offset/decoder/parser state): a `read()`
 *  issued while one is in flight is queued behind it, and every caller queued
 *  during the same in-flight read shares that one follow-up read. Queuing
 *  rather than returning the in-flight promise means a settle path that reads
 *  the poller's tail always sees bytes written before its own call. */
export class TranscriptTail {
  private offset = 0
  private partial = ''
  private decoder = new StringDecoder('utf8')
  private readonly parser = new SubagentCompletionParser()
  private running: Promise<SubagentCompletion | null> | null = null
  private queued: Promise<SubagentCompletion | null> | null = null

  constructor(readonly filePath: string) {}

  /** Bytes consumed so far (test observability). */
  get consumedBytes(): number {
    return this.offset
  }

  read(): Promise<SubagentCompletion | null> {
    if (!this.running) return this.startRead()
    if (!this.queued) {
      this.queued = this.running.then(() => {
        this.queued = null
        return this.startRead()
      })
    }
    return this.queued
  }

  private startRead(): Promise<SubagentCompletion | null> {
    const p = this.readOnce().finally(() => {
      if (this.running === p) this.running = null
    })
    this.running = p
    return p
  }

  private reset(): void {
    this.offset = 0
    this.partial = ''
    this.decoder = new StringDecoder('utf8')
    this.parser.reset()
  }

  private consume(text: string): void {
    if (!text) return
    const pieces = (this.partial + text).split('\n')
    this.partial = pieces.pop() ?? ''
    for (const line of pieces) this.parser.feedLine(line)
  }

  private async readOnce(): Promise<SubagentCompletion | null> {
    let fh: FileHandle | undefined
    try {
      fh = await open(this.filePath, 'r')
      const { size } = await fh.stat()
      if (size < this.offset) this.reset()
      if (size > this.offset) {
        const buf = Buffer.allocUnsafe(Math.min(TAIL_CHUNK_BYTES, size - this.offset))
        while (this.offset < size) {
          const len = Math.min(buf.length, size - this.offset)
          const { bytesRead } = await fh.read(buf, 0, len, this.offset)
          if (bytesRead === 0) break
          this.offset += bytesRead
          this.consume(this.decoder.write(buf.subarray(0, bytesRead)))
        }
      }
    } catch {
      // ENOENT (not written yet) or a transient read error: report what has
      // been parsed so far and retry on the next read.
    } finally {
      if (fh) await fh.close().catch(() => { /* ignore */ })
    }
    return this.parser.result(this.partial)
  }
}

/** Read the subagent's transcript once and, if it contains a final assistant
 *  message (one with a terminal `message.stop_reason`), return the completion.
 *  Returns null if the transcript doesn't exist yet, is mid-write, or hasn't
 *  reached a terminal assistant message. Never rejects — malformed/partial
 *  lines are skipped, read errors resolve null (treated as "not done yet"). */
export function readSubagentCompletion(filePath: string): Promise<SubagentCompletion | null> {
  return new TranscriptTail(filePath).read()
}

/** Parse a subagent transcript's raw JSONL text for its completion — the
 *  same grammar {@link TranscriptTail} applies incrementally, for callers that
 *  already hold the whole text (the resume seed's backfill reads the files
 *  itself, off the hot path). */
export function parseSubagentCompletion(text: string): SubagentCompletion | null {
  const parser = new SubagentCompletionParser()
  for (const line of text.split('\n')) parser.feedLine(line)
  return parser.result()
}

/** Copy a session's subagent sidecar transcripts to another session's
 *  sidecar dir (same project cwd). Used by discard(): the fork's seed
 *  backfills agent completions from the SOURCE session's sidecars, but the
 *  sidecars stay keyed under the source session id — without the copy, the
 *  fork's own next resume would find no transcripts and degrade every healed
 *  outcome to 'stopped' (the turn-anchor / result-frame sidecars already
 *  follow the fork; this one was missing).
 *
 *  Best-effort: a missing source dir or a copy failure logs a warning and
 *  returns 0 — the fork then behaves exactly as before this feature, never
 *  failing the fork itself. Agent ids are globally unique, so the copy can
 *  never collide with the destination session's own agents. */
export async function copySubagentTranscripts(
  cwd: string,
  fromSessionId: string,
  toSessionId: string,
): Promise<number> {
  const srcDir = path.dirname(subagentTranscriptPath(cwd, fromSessionId, 'probe'))
  const dstDir = path.dirname(subagentTranscriptPath(cwd, toSessionId, 'probe'))
  try {
    const entries = await readdir(srcDir)
    if (entries.length === 0) return 0
    await mkdir(dstDir, { recursive: true })
    await cp(srcDir, dstDir, { recursive: true })
    log.info(
      `[${fromSessionId} → ${toSessionId}] copied ${entries.length} subagent sidecar transcript(s) to the fork`,
    )
    return entries.length
  } catch (err) {
    log.warn(
      `[${fromSessionId} → ${toSessionId}] subagent sidecar copy failed (fork resumes without healed completions):`,
      err,
    )
    return 0
  }
}

export interface WatchOptions {
  cwd: string
  sessionId: string
  agentId: string
  toolUseId: string
  onCompleted: (completion: SubagentCompletion) => void
  /** The incremental reader to poll. The registry passes the one it shares
   *  with its settle paths (so a settle reads only the bytes since the last
   *  poll); when omitted the watcher creates its own for the transcript path. */
  tail?: TranscriptTail
  /** Steady-state poll interval, in ms (default 15000). Used after the fast
   *  phase (see fastPhaseMs) elapses. Polling is only the FALLBACK settle path
   *  (the SubagentStop hook and the Stop-hook list sweep settle first on any
   *  CLI that delivers them), so a long-running subagent can afford a relaxed
   *  cadence over the multi-hour backstop window. */
  intervalMs?: number
  /** Fast-phase poll interval, in ms (default 2000). Applied for the first
   *  `fastPhaseMs` after launch, when a SHORT subagent (the common case) is
   *  most likely to finish — bounds the fallback's completion latency for a
   *  CLI whose hooks never arrive, without paying it over a long run. */
  fastIntervalMs?: number
  /** How long the fast phase lasts, in ms (default 30000). After this much
   *  wall-clock time the watcher drops to `intervalMs`. Chosen so the vast
   *  majority of short subagents (which finish within seconds) get the tighter
   *  cadence, while genuinely long ones pay it for only their first 30 s. */
  fastPhaseMs?: number
  /** Absolute backstop, in ms (default 2 h). If the watcher reaches this
   *  without detecting a terminal `stop_reason`, it synthesizes a `stopped`
   *  completion so the record can never strand indefinitely. High by design:
   *  a legitimately long background subagent (the common case that previously
   *  false-timed-out at 10 min) is polled until its real `end_turn`, not cut
   *  off. This only resolves the rare subagent whose transcript never gets a
   *  terminal frame (the CLI died / ended via a non-standard path); a real
   *  `completed` always wins first. */
  maxMs?: number
  /** Test-only observability seam. Called immediately after each non-terminal
   *  poll arms the next timer, with the tick index (1-based) and the delay
   *  that was just chosen for the NEXT poll. Lets tests assert the adaptive
   *  cadence actually crossed the fast→steady boundary (a delay === intervalMs
   *  can only be scheduled after fastPhaseMs elapsed), which a completion-only
   *  assertion cannot distinguish from a watcher stuck at the fast cadence.
   *  Never set in production. */
  onPoll?: (info: { pollCount: number; delayMs: number }) => void
  /** Hold the transcript-completion path open (the maxMs backstop is NOT
   *  suppressed). Latched by the registry after a SubagentStop hook reported
   *  in-flight background work — see the module header for why the hook
   *  cannot act as a completion edge, and settleByAgentId for the latch. */
  isSettleSuppressed?: () => boolean
}

/** Poll a background subagent's transcript until it reaches completion, then
 *  call `onCompleted`. Two resolution paths, BOTH funnel through `onCompleted`
 *  so the owning record always leaves its `pending`/`background` state:
 *
 *    1. Real terminal `stop_reason` (end_turn / max_turns / stop_sequence / …)
 *       → the subagent's own final text, status `completed`. Any terminal
 *       reason is a normal completion (the subagent stopped producing and
 *       returned output); non-end_turn reasons are NOT errors.
 *    2. `maxMs` backstop → synthesize `stopped`.
 *
 *  The previous design gave up silently at 10 min (`onTimeout`, no frame) and
 *  relied on the client reducer's turn-end sweep to clear the record — but
 *  that sweep is a no-op once the parent turn has ended (the record is already
 *  `pending`), so a subagent that finished even seconds after the 10-min cap
 *  stranded forever (verified in production logs: ~11 of 40 background
 *  subagents timed out, most finishing 39s–7min AFTER the cap). Raising the
 *  cap to 2h lets those finish for real, and synthesizing a frame on the
 *  backstop guarantees the rare no-terminal-frame case still clears.
 *
 *  There is intentionally NO staleness heuristic: the CLI writes one JSON line
 *  per COMPLETE assistant message, so a subagent mid-inference (or a long
 *  tool) is legitimately transcript-quiet for minutes. A staleness threshold
 *  could not reliably tell "stuck" from "thinking" and risked false-stopping a
 *  running subagent. A false stop is recoverable (the reducer's task_notification
 *  branch accepts `interrupted` and lets a late real completion override), but
 *  the transient wrong status is still user-visible, so the watcher avoids
 *  synthesizing anything but a real terminal frame or the maxMs backstop. The
 *  maxMs backstop is the only synthesized path.
 *
 *  Returns a `stop()` to cancel early (called on session unload so a watcher
 *  can't fire into a dead session). */
export function watchBackgroundSubagent(opts: WatchOptions): () => void {
  const intervalMs = opts.intervalMs ?? 15_000
  const fastIntervalMs = opts.fastIntervalMs ?? 2000
  const fastPhaseMs = opts.fastPhaseMs ?? 30_000
  const maxMs = opts.maxMs ?? 2 * 60 * 60 * 1000
  const tail = opts.tail ?? new TranscriptTail(subagentTranscriptPath(opts.cwd, opts.sessionId, opts.agentId))
  // Wall-clock for the backstop (not an `elapsed += intervalMs` counter, which
  // undercounts real time when the event loop delays ticks).
  const startMs = Date.now()
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pollCount = 0

  // Adaptive cadence: poll more often (fastIntervalMs) for the first
  // fastPhaseMs — short subagents (the common case) finish here — then relax
  // to intervalMs for the long tail, so a multi-hour backstop window doesn't
  // pay the early cadence.
  const nextDelay = (): number =>
    Date.now() - startMs < fastPhaseMs ? fastIntervalMs : intervalMs

  const finish = (completion: SubagentCompletion, level: 'info' | 'warn', reason: string) => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    log[level](
      `[${opts.sessionId}] background subagent agentId=${opts.agentId} ` +
      `toolUseId=${opts.toolUseId} ${reason} (status=${completion.status})`,
    )
    opts.onCompleted(completion)
  }

  // Timer / microtask entry point: the tick is async (it awaits the tail
  // read), so surface an unexpected throw from onCompleted as a log line
  // instead of an unhandled rejection.
  const runTick = () => {
    tick().catch((err) => {
      log.warn(`[${opts.sessionId}] background subagent watcher tick failed (agentId=${opts.agentId}):`, err)
    })
  }

  const tick = async (): Promise<void> => {
    if (done) return
    // The never-strand guarantee, shared by both branches below.
    const backstopFinish = () =>
      finish(
        { status: 'stopped', summary: '' },
        'warn',
        `reached ${maxMs}ms backstop with no completion; synthesizing stopped`,
      )
    // While the hold is latched the poll cannot settle anything: the pause
    // writes a terminal stop_reason into the transcript, indistinguishable on
    // disk from the final stop, so any read's result is dead weight — the
    // watcher resolves via the Stop-hook list sweep (settleUnlisted) or the
    // backstop below. Skip the read entirely and relax the cadence: the only
    // job left here is backstop bookkeeping. (The latch is never cleared by
    // design — a resumed-and-finished subagent is resolved by the sweep, and
    // the poller is stopped with it.)
    if (opts.isSettleSuppressed?.()) {
      const remaining = maxMs - (Date.now() - startMs)
      if (remaining <= 0) {
        backstopFinish()
        return
      }
      // Cap at the remaining backstop budget so the deadline stays precise.
      timer = setTimeout(runTick, Math.min(Math.max(nextDelay(), SUPPRESSED_POLL_INTERVAL_MS), remaining))
      return
    }
    // 1. Real terminal completion? (Incremental: only the bytes appended since
    // the previous read.) Re-check `done` after the await — stop() or a
    // settle path may have claimed this watcher while the read was in flight.
    const completion = await tail.read()
    if (done) return
    if (completion) {
      finish(completion, 'info', 'completed (terminal stop_reason)')
      return
    }
    // 2. Hard backstop (wall-clock).
    if (Date.now() - startMs >= maxMs) {
      backstopFinish()
      return
    }
    // Not done — reschedule at the current adaptive cadence. A
    // self-rescheduling setTimeout (rather than a fixed setInterval) is what
    // lets the delay shrink/grow across the fast-phase boundary, and it also
    // guarantees no re-entrancy: the next poll is only armed after this one's
    // read has resolved, so a slow read can't stack overlapping ticks.
    const delayMs = nextDelay()
    pollCount += 1
    timer = setTimeout(runTick, delayMs)
    opts.onPoll?.({ pollCount, delayMs })
  }
  // The subagent may have already finished by the time the ack reaches us —
  // check once immediately rather than waiting a full interval. Deferred to
  // a microtask so onCompleted can NEVER fire synchronously before the caller
  // has registered the watcher entry: startBackgroundSubagentWatcher sets the
  // map entry AFTER watchBackgroundSubagent returns, and a synchronous
  // completion would delete a not-yet-present entry and then re-add a stale
  // one behind it (its timer is already cleared, so nothing would ever clean
  // it up — backgroundSubagentCount would stick at 1 forever). A microtask
  // runs after the current synchronous stack, so the entry is guaranteed
  // present when the first poll fires; the `done` flag still lets stop()
  // (session unload) cancel the poll before it runs. The first tick also arms
  // the recurring timer via its own reschedule tail.
  queueMicrotask(runTick)
  return () => {
    done = true
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// BackgroundWatcherRegistry — per-session orchestration of the pollers above.
//
// Extracted from session-manager.ts for modularity: the polling itself
// (watchBackgroundSubagent) already lived here, but the Map<sessionId,
// Map<toolUseId, stop>> bookkeeping, TaskRecord seeding, and synthesized
// task_notification broadcast were still inline SessionManager methods. This
// class owns that orchestration; SessionManager keeps thin proxy methods
// (startBackgroundSubagentWatcher / cancelBackgroundWatcher /
// stopBackgroundSubagentWatchers / backgroundSubagentCount) so callers see
// no change.
//
// `applyTaskEvent` is injected (not imported) because it lives in
// session-pump.ts, which itself imports from this module (parseAckAgentId) —
// a direct import here would create a cycle.

export interface BackgroundWatcherRegistryDeps {
  /** Fold a synthesized system/task_notification frame into the session's
   *  task-state cache (session-pump.ts's applyTaskEvent). Injected to avoid
   *  a circular import (session-pump.ts imports from this module). */
  applyTaskEvent(session: Session, msg: SDKMessage): void
  /** Broadcast a global session-info update (sidebar status dot). */
  broadcastGlobal(ev: GlobalSessionEvent): void
  /** Project a live session into its public SessionInfo shape. */
  info(s: Session): SessionInfo
  /** History ring cap, used when pushing the synthesized frame into
   *  session.history (mirrors every other history-ring write). */
  historyCap: number
  /** The CURRENT live Session for an id (undefined once unloaded). Every
   *  completion resolves its target through this AT COMPLETION TIME rather
   *  than writing into the object captured at start(): a resume replaces the
   *  Session object under the same id, and a late completion must land in the
   *  one subscribers are actually attached to — or nowhere, when the session
   *  was unloaded between dispatch and completion. */
  getSession(sessionId: string): Session | undefined
}

/** One armed watcher's runtime handle. `stop()` cancels its poller; `agentId`
 *  is retained so the hook / sweep / process-exit settles can match it (the
 *  transcript is keyed by agentId, not toolUseId). `tail` is the transcript
 *  reader shared by the poller and every settle path, so a settle reads only
 *  the bytes appended since the last poll. `settleGate.paused` latches the
 *  poller's transcript path while the subagent is pause-held — see the module
 *  header; resolution comes from settleUnlisted / the backstop / stop(). */
interface WatcherEntry {
  stop: () => void
  agentId: string
  tail: TranscriptTail
  settleGate: { paused: boolean }
}

export class BackgroundWatcherRegistry {
  /** sessionId -> toolUseId -> WatcherEntry. One watcher per (session,
   *  toolUseId); a duplicate launch ack (replay, re-broadcast) must not stack
   *  a second poller on the same transcript. */
  private watchers = new Map<string, Map<string, WatcherEntry>>()

  constructor(private deps: BackgroundWatcherRegistryDeps) {}

  /** Number of background subagents currently being watched for a session.
   *  OBSERVABILITY ONLY — the sidebar's backgroundSubagentCount and phaseOf
   *  derive from the folded task map instead (SessionManager.backgroundSubagent
   *  Count): the registry's entry lifetime tracks the watcher (held through
   *  pauses, settled by the list sweep), not the subagent's visible liveness.
   *  Do NOT wire new UI/state gates to this — a registry entry can outlive the
   *  subagent's completion or vice versa. */
  count(sessionId: string): number {
    return this.watchers.get(sessionId)?.size ?? 0
  }

  /** Begin polling a background subagent's own transcript for completion.
   *  Called by the pump when it sees an async launch ack. On completion,
   *  synthesizes a `system`/`task_notification` frame (the CLI doesn't emit
   *  one reliably) and feeds it back through the normal broadcast path so
   *  the client reducer's completion branch flips the `background` record to
   *  `done` with the subagent's real output. */
  start(session: Session, toolUseId: string, agentId: string): void {
    const sessionId = session.id
    // One watcher per (session, toolUseId). A duplicate launch ack (replay,
    // re-broadcast) must not stack a second poller on the same transcript.
    let perSession = this.watchers.get(sessionId)
    if (!perSession) {
      perSession = new Map()
      this.watchers.set(sessionId, perSession)
    }
    if (perSession.has(toolUseId)) return
    if (!session.cwd) return // without a cwd the subagent transcript path can't be computed
    const settleGate = { paused: false }
    const tail = new TranscriptTail(subagentTranscriptPath(session.cwd, sessionId, agentId))
    const stop = watchBackgroundSubagent({
      cwd: session.cwd,
      sessionId,
      agentId,
      toolUseId,
      tail,
      isSettleSuppressed: () => settleGate.paused,
      onCompleted: (completion) => {
        // Claim the watcher entry before broadcasting. onCompleted fires on
        // EVERY poller resolution path (real completion / maxMs backstop), so
        // the entry is always cleared here — a later re-arm (e.g. an
        // autoResume re-seeing the launch ack) is never blocked by a stale
        // entry. Identity-checked: if a settle path already claimed it (and a
        // re-arm put a fresh entry under the same toolUseId), this poller has
        // lost the race and must not touch the new entry or re-broadcast.
        const current = this.watchers.get(sessionId)
        if (current?.get(toolUseId) !== entry) return
        current.delete(toolUseId)
        // The sidebar reads `backgroundSubagentCount` for its status dot;
        // broadcast the updated info so it flips out of 'waiting' the moment
        // the subagent settles (skipped when the session was unloaded mid-poll).
        this.broadcastInfo(sessionId)
        this.broadcastSynthesizedTaskNotification(sessionId, toolUseId, agentId, completion)
      },
    })
    const entry: WatcherEntry = { stop, agentId, tail, settleGate }
    perSession.set(toolUseId, entry)
    // Seed a TaskRecord for this watcher-tracked subagent. CLI versions that
    // emit no task_* frames for background Agent dispatches (the watcher's
    // reason to exist) would otherwise never surface in session.tasks /
    // the TasksPanel. A real task_started arriving later overwrites the seed
    // via applyTaskEvent's upsert; the watcher's own synthesized completion
    // settles it otherwise.
    const now = Date.now()
    const seeded = session.tasks.get(agentId)
    if (!seeded) {
      session.tasks.set(agentId, {
        taskId: agentId,
        toolUseId,
        description: 'Background subagent',
        taskType: 'subagent',
        status: 'running',
        isBackgrounded: true,
        startedAt: now,
        updatedAt: now,
      })
      const snapshot = Array.from(session.tasks.values())
      for (const sub of session.taskSubscribers) {
        try { sub.push(snapshot) } catch { /* subscriber dead — skip */ }
      }
    }
    // A new background subagent just launched — broadcast the updated count
    // so the sidebar can switch this session away from a plain 'live' dot
    // (the parent turn is still running right now; the `result` frame that
    // ends it re-broadcasts info via persist(), carrying the same count).
    this.broadcastInfo(sessionId)
  }

  /** Re-broadcast the sidebar info frame for the CURRENT session under `id`
   *  (no-op once it was unloaded). */
  private broadcastInfo(sessionId: string): void {
    const s = this.deps.getSession(sessionId)
    if (s) this.deps.broadcastGlobal({ kind: 'update', session: this.deps.info(s) })
  }

  /** Cancel the subagent watcher for a (session, toolUseId) when a REAL SDK
   *  task_notification arrives for the same tool call — the true completion
   *  already carries the result, so the watcher's synthesized notification
   *  would be a duplicate (and its maxMs backstop could later flip a
   *  legitimately-done record back to 'stopped'). No-op when no watcher is
   *  armed. `session` may be undefined (the pump's caller looks it up by id
   *  and may find it already unloaded) — the stop() still fires, but task-
   *  cleanup and the re-broadcast are skipped, mirroring the pre-extraction
   *  behaviour. */
  cancel(sessionId: string, toolUseId: string, session: Session | undefined): void {
    const perSession = this.watchers.get(sessionId)
    const entry = perSession?.get(toolUseId)
    if (!entry) return
    try { entry.stop() } catch { /* ignore */ }
    perSession!.delete(toolUseId)
    // The pump folds the REAL notification (keyed by its task_id) BEFORE
    // calling this. Nothing ties that task_id to the agentId the launch ack
    // carried, so when they differ the watcher's seed record is a duplicate
    // still stuck on 'running' — the real record under the frame's task_id is
    // the authoritative one, so drop the seed (a matched task_id means the
    // fold already settled the seed itself and it is left intact).
    if (session) {
      let removed = false
      for (const [taskId, rec] of session.tasks) {
        if (rec.toolUseId === toolUseId && !isTerminalTaskStatus(rec.status)) {
          session.tasks.delete(taskId)
          removed = true
        }
      }
      if (removed) {
        const snapshot = Array.from(session.tasks.values())
        for (const sub of session.taskSubscribers) {
          try { sub.push(snapshot) } catch { /* subscriber dead — skip */ }
        }
      }
      // The watcher count feeds the sidebar's 'waiting' dot; re-broadcast so
      // it reflects the cancelled watcher immediately.
      this.deps.broadcastGlobal({ kind: 'update', session: this.deps.info(session) })
    }
    log.info(`[session ${sessionId}] real task_notification for toolUseId=${toolUseId} — watcher cancelled`)
  }

  /** Synthesize a `system`/`task_notification` frame for a completed
   *  background subagent and feed it through the SAME path real messages
   *  take (history ring + live subscribers), so it survives replay and
   *  reaches the client reducer's completion branch. The reducer matches by
   *  `tool_use_id` and flips the `background` record to `done` (or
   *  `interrupted` for a non-completed status), capturing the subagent's
   *  final text as the merged result. */
  private broadcastSynthesizedTaskNotification(
    sessionId: string,
    toolUseId: string,
    agentId: string,
    completion: SubagentCompletion,
  ): void {
    // Resolve the session BY ID now, not the object the watcher was armed
    // against: a resume may have replaced it, and a frame pushed into the old
    // object would reach no subscriber and no replay. Drop the frame if the
    // session was unloaded between dispatch and completion — no subscribers
    // to push to, and persisting would race unload's terminal write.
    const session = this.deps.getSession(sessionId)
    if (!session) return
    const msg = buildTaskNotificationFrame({
      sessionId: session.id,
      toolUseId,
      agentId,
      completion,
    })
    pushBounded(session.history, msg, this.deps.historyCap)
    for (const sub of session.subscribers.values()) {
      try { sub.push(msg) } catch { /* subscriber dead — skip */ }
    }
    // Fold the same notification into the task-state cache so the seeded
    // watcher record settles to a terminal status in the TasksPanel. The
    // synthesized frame never passes through the pump (it bypasses the SDK
    // stream), so the normal fold path doesn't see it — fold it here.
    this.deps.applyTaskEvent(session, msg)
  }

  /** Settle one armed watcher because the CLI's `SubagentStop` hook just fired
   *  for its agent — the authoritative, immediate completion edge, as opposed
   *  to the transcript poll that has to infer completion from a terminal
   *  `stop_reason`. Probe-verified (SDK 0.3.252 / CLI 2.1.252): the hook fires
   *  BEFORE the CLI's own `task_updated` / `task_notification` frames, so this
   *  is the earliest signal available and it removes the poll latency entirely.
   *
   *  Lookup is by agentId, not toolUseId: the hook only knows the agent. A
   *  hook firing with no armed watcher is a no-op by design — a synchronous
   *  subagent, a nested (spawn_depth > 1) agent, or one this registry already
   *  settled all land here.
   *
   *  Polling is deliberately NOT removed: the hook cannot cover an agent killed
   *  with its host process, a CLI too old to deliver it, or a hook that never
   *  arrives. The poller stays armed until one of the two paths wins, and
   *  whichever gets there first deletes the entry so the other becomes a no-op.
   *
   *  `transcriptPath` comes from the hook (`agent_transcript_path`) and is
   *  preferred over our own reconstruction of the CLI's on-disk layout — the
   *  fragility this module's header warns about. It is only used to recover the
   *  subagent's final text; when the file isn't readable/terminal yet, the
   *  hook's own `last_assistant_message` is the fallback, so a settle never
   *  depends on the filesystem.
   *
   *  The CLAIM (stop the poller + delete the entry) happens synchronously,
   *  before the async transcript read, so a poll tick or another settle path
   *  that runs while the read is in flight finds no entry. Resolves true when
   *  this call settled the watcher. */
  async settleByAgentId(
    session: Session,
    agentId: string,
    opts: {
      transcriptPath?: string
      lastAssistantMessage?: string
      /** The hook input's `background_tasks`: non-empty = hold (the list is
       *  the parent session's in-flight set and lags the stop edge, so this
       *  stop may be a pause); `[]` = the CLI positively reports nothing in
       *  flight — settle; `undefined` = field absent (older CLI) — legacy
       *  settle-on-hook behaviour. */
      backgroundTasks?: Array<{ id: string; status?: string }>
    } = {},
  ): Promise<boolean> {
    const perSession = this.watchers.get(session.id)
    if (!perSession) return false
    let match: { toolUseId: string; entry: WatcherEntry } | undefined
    for (const [toolUseId, entry] of perSession) {
      if (entry.agentId === agentId) { match = { toolUseId, entry }; break }
    }
    if (!match) return false
    // HOLD, not completion: the list is the parent session's in-flight set and
    // lags the stop edge (probe-verified: a subagent's own entry still reads
    // 'running' at its FINAL stop), so it cannot discriminate pause from
    // final — but either way this hook is not a settle edge when the field is
    // present. Latch the poller's transcript path too (the pause writes a
    // terminal-shaped line) and let settleUnlisted / the backstop resolve.
    if (opts.backgroundTasks !== undefined && opts.backgroundTasks.length > 0) {
      match.entry.settleGate.paused = true
      log.info(
        `[${session.id}] background subagent agentId=${agentId} toolUseId=${match.toolUseId} ` +
        `stop held open — in-flight list non-empty [${opts.backgroundTasks.map((t) => t.id).join(', ')}]`,
      )
      return false
    }
    // Claim synchronously, before the first await.
    const sessionId = session.id
    const { toolUseId, entry } = match
    try { entry.stop() } catch { /* ignore */ }
    perSession.delete(toolUseId)
    // Prefer the transcript's own final text (same source the poll path uses,
    // so a hook-settled record and a poll-settled one read identically), then
    // the hook's last_assistant_message, then empty. Without a hook path the
    // entry's own tail (our reconstruction of the CLI layout) is read — only
    // the bytes since the last poll.
    const fromDisk = opts.transcriptPath
      ? await readSubagentCompletion(opts.transcriptPath)
      : await entry.tail.read()
    const summary = fromDisk?.summary || opts.lastAssistantMessage?.trim() || ''
    log.info(
      `[${sessionId}] background subagent agentId=${agentId} toolUseId=${toolUseId} ` +
      `settled by SubagentStop hook (summary ${fromDisk?.summary ? 'from transcript' : opts.lastAssistantMessage ? 'from hook' : 'empty'})`,
    )
    // SubagentStop only fires when the agent stopped of its own accord, so this
    // is always a normal completion — never the synthesized 'stopped' the maxMs
    // backstop and the process-exit path use.
    this.broadcastInfo(sessionId)
    this.broadcastSynthesizedTaskNotification(sessionId, toolUseId, agentId, {
      status: 'completed',
      summary,
    })
    return true
  }

  /** Stop all background-subagent watchers for a session (called on unload
   *  so a late completion can't broadcast into a dead session). */
  stopAll(sessionId: string): void {
    const perSession = this.watchers.get(sessionId)
    if (!perSession) return
    for (const entry of perSession.values()) {
      try { entry.stop() } catch { /* ignore */ }
    }
    perSession.clear()
    this.watchers.delete(sessionId)
  }

  /** Settle every armed watcher whose agent has LEFT the CLI's authoritative
   *  in-flight list (the parent Stop hook's `background_tasks`). This is the
   *  finality signal for async subagents on CLIs that deliver the hook: the
   *  SubagentStop hook itself also fires at pauses (where the agent stays
   *  listed), so it cannot be trusted as a completion edge — but list
   *  membership can. Called from the Stop-hook reconcile before the generic
   *  sweep, so the synthesized 'completed' (with the transcript's real final
   *  text) lands before the sweep would have marked the record 'stopped'.
   *  Watchers whose agent is still listed stay armed (the subagent merely
   *  paused, or is mid-run). Does NOT broadcast the sidebar info frame itself —
   *  the caller (the Stop-hook reconcile) broadcasts once after both the
   *  settlement and the sweep have touched the task map. Resolves true when
   *  anything was settled.
   *
   *  Every unlisted entry is CLAIMED synchronously before the transcript
   *  reads are awaited, so a concurrent poll tick / hook settle is a no-op;
   *  the caller awaits this before running the generic sweep. */
  async settleUnlisted(session: Session, live: Set<string>): Promise<boolean> {
    const perSession = this.watchers.get(session.id)
    if (!perSession || perSession.size === 0) return false
    // Id-space guard, mirroring the generic sweep's bail (session-pump.ts):
    // a non-empty list that matches NO known task record is more likely an
    // id-space mismatch than ground truth — acting on it would kill running
    // watchers. Matching a record (any task, not just a watcher's) proves the
    // list shares our id space, so zero watcher-matches then legitimately
    // means "those agents left the in-flight set". An empty list needs no such
    // guard ("nothing is in flight" is id-space independent).
    if (live.size > 0) {
      let anyKnown = false
      for (const id of live) {
        if (session.tasks.has(id)) { anyKnown = true; break }
      }
      if (!anyKnown) {
        for (const entry of perSession.values()) {
          if (live.has(entry.agentId)) { anyKnown = true; break }
        }
      }
      if (!anyKnown) {
        log.warn(`[session ${session.id}] in-flight list matches no known task record — skipping watcher sweep (id-space mismatch?)`)
        return false
      }
    }
    const sessionId = session.id
    const claimed: Array<[string, WatcherEntry]> = []
    for (const [toolUseId, entry] of Array.from(perSession.entries())) {
      if (live.has(entry.agentId)) continue
      try { entry.stop() } catch { /* ignore */ }
      perSession.delete(toolUseId)
      claimed.push([toolUseId, entry])
    }
    if (claimed.length === 0) return false
    const completions = await Promise.all(claimed.map(([, entry]) => entry.tail.read()))
    claimed.forEach(([toolUseId, entry], i) => {
      const completion: SubagentCompletion = completions[i] ?? STOPPED_SUBAGENT_COMPLETION
      log.info(
        `[${sessionId}] background subagent agentId=${entry.agentId} toolUseId=${toolUseId} ` +
        `left the CLI's in-flight list (status=${completion.status})`,
      )
      this.broadcastSynthesizedTaskNotification(sessionId, toolUseId, entry.agentId, completion)
    })
    return true
  }

  /** Settle every armed watcher for a session because its CLI subprocess just
   *  exited (crash / kill / unexpected exit — detected by ProcessMonitor in
   *  ms). This is the CERTAIN completion signal the transcript-poll fallback
   *  otherwise lacks: a background subagent runs INSIDE the parent CLI
   *  subprocess, so once that process is gone the subagent can never write
   *  another transcript line — waiting out the 2 h maxMs backstop would strand
   *  its chip for hours. We resolve each watcher immediately instead:
   *
   *    1. If the subagent's transcript already holds a terminal `stop_reason`
   *       (it finished right before the crash), honour it — status `completed`
   *       with the real final text.
   *    2. Otherwise synthesize `stopped` (the subagent died mid-work with the
   *       host process).
   *
   *  Both funnel through the same broadcast path as a normal completion, so
   *  the client reducer flips the `background`/`pending` record to done /
   *  interrupted. Called BEFORE the crash-recovery ladder or termination runs.
   *  The frame lands once the (incremental) transcript read resolves, in
   *  whatever Session is live under the id by then: on the recovery path the
   *  same object with its subscribers still attached; after an immediate
   *  termination the history ring only (subscribers were already ended, the
   *  replay carries it); after an unload, nowhere. A subsequent in-place
   *  recovery that re-sees the launch ack simply re-arms a fresh watcher (per-toolUseId dedup makes that
   *  safe), and a late real completion still overrides an over-eager `stopped`
   *  (the reducer accepts a later terminal frame). No-op when the session has
   *  no armed watchers.
   *
   *  Every entry is CLAIMED synchronously (the map is empty and count() reads
   *  0 when this returns); the transcript reads and broadcasts complete in
   *  `done`. `claimedTaskIds` are the task-record ids (the agentIds) whose
   *  synthesized notification `done` will fold — the caller's synchronous
   *  process-exit sweep must skip them so they don't flash to `stopped` before
   *  their real (possibly `completed`) outcome lands. */
  settleAllOnProcessExit(session: Session): { claimedTaskIds: Set<string>; done: Promise<void> } {
    const sessionId = session.id
    const perSession = this.watchers.get(sessionId)
    if (!perSession || perSession.size === 0) {
      return { claimedTaskIds: new Set(), done: Promise.resolve() }
    }
    const entries = Array.from(perSession.entries())
    for (const [, entry] of entries) {
      try { entry.stop() } catch { /* ignore */ }
    }
    // The map for this session is now empty; drop it so count() reads 0.
    perSession.clear()
    this.watchers.delete(sessionId)
    const claimedTaskIds = new Set(entries.map(([, entry]) => entry.agentId))
    const done = (async () => {
      // Path 1: the subagent may have finished a terminal frame just before
      // the crash — prefer its real output over a synthesized `stopped`.
      // EXCEPT for a latched (pause-held) watcher: its transcript's terminal
      // line is the PAUSE narration, not a result, and with the host process
      // gone the subagent can never resume to produce a real one — so its
      // read is skipped entirely.
      const completions = await Promise.all(
        entries.map(([, entry]) => (entry.settleGate.paused ? null : entry.tail.read())),
      )
      entries.forEach(([toolUseId, entry], i) => {
        const completion: SubagentCompletion = completions[i] ?? STOPPED_SUBAGENT_COMPLETION
        log.info(
          `[${sessionId}] settling background subagent agentId=${entry.agentId} ` +
          `toolUseId=${toolUseId} on process exit (status=${completion.status})`,
        )
        this.broadcastSynthesizedTaskNotification(sessionId, toolUseId, entry.agentId, completion)
      })
      // Refresh the sidebar dot (waiting → whatever the exit path lands on).
      this.broadcastInfo(sessionId)
    })()
    return { claimedTaskIds, done }
  }
}
