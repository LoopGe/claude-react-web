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
// SOLUTION: the CLI DOES write the subagent's transcript to
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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from './log.js'

const log = createLogger('subagent-watcher')

/** The CLI's config dir: $CLAUDE_CONFIG_DIR if set, else ~/.claude. The CLI
 *  stores transcripts under <cliHome>/projects/. */
export function cliHomeDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude')
}

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
  return path.join(cliHomeDir(), 'projects', encodeCwd(cwd), sessionId, 'subagents', `agent-${agentId}.jsonl`)
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

/** Read the subagent's transcript and, if it contains a final assistant
 *  message (one with a terminal `message.stop_reason`), return the completion.
 *  Returns null if the transcript doesn't exist yet, is mid-write, or hasn't
 *  reached a terminal assistant message. Never throws — malformed/partial
 *  lines are skipped, read errors return null (treated as "not done yet"). */
export function readSubagentCompletion(filePath: string): SubagentCompletion | null {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  let lastStopReason: string | null = null
  let lastText = ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: { type?: string; message?: { stop_reason?: unknown; content?: unknown } }
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue // partial line (file mid-write) — skip, retry next poll
    }
    if (obj.type !== 'assistant' || !obj.message) continue
    const sr = obj.message.stop_reason
    if (typeof sr !== 'string') continue
    if (NON_TERMINAL_STOP_REASONS.has(sr)) continue // mid-tool-call — keep polling
    // The last terminal assistant message is the subagent's final response.
    // A later one (if any) overwrites.
    lastStopReason = sr
    lastText = extractTextBlocks(obj.message.content)
  }
  if (lastStopReason === null) return null
  return {
    status: lastStopReason === 'end_turn' ? 'completed' : 'stopped',
    summary: lastText,
  }
}

export interface WatchOptions {
  cwd: string
  sessionId: string
  agentId: string
  toolUseId: string
  onCompleted: (completion: SubagentCompletion) => void
  intervalMs?: number
  /** Absolute backstop, in ms (default 2 h). If the watcher reaches this
   *  without detecting a terminal `stop_reason`, it synthesizes a `stopped`
   *  completion so the record can never strand indefinitely. High by design:
   *  a legitimately long background subagent (the common case that previously
   *  false-timed-out at 10 min) is polled until its real `end_turn`, not cut
   *  off. This only resolves the rare subagent whose transcript never gets a
   *  terminal frame (the CLI died / ended via a non-standard path); a real
   *  `completed` always wins first. */
  maxMs?: number
}

/** Poll a background subagent's transcript until it reaches completion, then
 *  call `onCompleted`. Two resolution paths, BOTH funnel through `onCompleted`
 *  so the owning record always leaves its `pending`/`background` state:
 *
 *    1. Real terminal `stop_reason` (end_turn / max_turns / …) → the
 *       subagent's own final text, status `completed`/`stopped`.
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
  const intervalMs = opts.intervalMs ?? 2000
  const maxMs = opts.maxMs ?? 2 * 60 * 60 * 1000
  const filePath = subagentTranscriptPath(opts.cwd, opts.sessionId, opts.agentId)
  // Wall-clock for the backstop (not an `elapsed += intervalMs` counter, which
  // undercounts real time when the event loop delays ticks).
  const startMs = Date.now()
  let done = false

  const finish = (completion: SubagentCompletion, level: 'info' | 'warn', reason: string) => {
    if (done) return
    done = true
    clearInterval(timer)
    log[level](
      `[${opts.sessionId}] background subagent agentId=${opts.agentId} ` +
      `toolUseId=${opts.toolUseId} ${reason} (status=${completion.status})`,
    )
    opts.onCompleted(completion)
  }

  const tick = () => {
    if (done) return
    // 1. Real terminal completion?
    const completion = readSubagentCompletion(filePath)
    if (completion) {
      finish(completion, 'info', 'completed (terminal stop_reason)')
      return
    }
    // 2. Hard backstop (wall-clock).
    if (Date.now() - startMs >= maxMs) {
      finish(
        { status: 'stopped', summary: '' },
        'warn',
        `reached ${maxMs}ms backstop with no completion; synthesizing stopped`,
      )
      return
    }
  }
  const timer = setInterval(tick, intervalMs)
  // The subagent may have already finished by the time the ack reaches us —
  // check once immediately rather than waiting a full interval.
  tick()
  return () => {
    done = true
    clearInterval(timer)
  }
}
