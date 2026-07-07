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
// either, the watcher silently finds nothing and the turn-end sweep
// (reducer) remains the fallback. No crash, no false completion.

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
 *  CLI writes, whose path uses this encoding. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-')
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

/** Read the subagent's transcript and, if it contains a final assistant
 *  message (one with `message.stop_reason`), return the completion. Returns
 *  null if the transcript doesn't exist yet, is mid-write, or hasn't reached
 *  a terminal assistant message. Never throws — malformed/partial lines are
 *  skipped, read errors return null (treated as "not done yet"). */
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
    // The last assistant message carrying a stop_reason is the subagent's
    // final response. A later one (if any) overwrites.
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
  maxMs?: number
}

/** Poll a background subagent's transcript until it reaches completion (a
 *  final assistant message with stop_reason), then call `onCompleted`. Caps
 *  at `maxMs`; if no completion by then, stops silently — the reducer's
 *  turn-end sweep is the fallback. Returns a `stop()` to cancel early
 *  (called on session unload so a watcher can't fire into a dead session). */
export function watchBackgroundSubagent(opts: WatchOptions): () => void {
  const intervalMs = opts.intervalMs ?? 2000
  const maxMs = opts.maxMs ?? 10 * 60 * 1000
  const filePath = subagentTranscriptPath(opts.cwd, opts.sessionId, opts.agentId)
  let elapsed = 0
  let done = false
  const tick = () => {
    if (done) return
    const completion = readSubagentCompletion(filePath)
    if (completion) {
      done = true
      clearInterval(timer)
      log.info(
        `[${opts.sessionId}] background subagent agentId=${opts.agentId} ` +
        `toolUseId=${opts.toolUseId} completed (status=${completion.status})`,
      )
      opts.onCompleted(completion)
      return
    }
    elapsed += intervalMs
    if (elapsed >= maxMs) {
      done = true
      clearInterval(timer)
      log.warn(
        `[${opts.sessionId}] background subagent agentId=${opts.agentId} ` +
        `watcher timed out after ${maxMs}ms with no completion; falling back to the turn-end sweep`,
      )
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
