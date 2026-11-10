// server/providers/native/session-log/replay.ts
//
// Pure replay helpers over the native session log: rebuild the Anthropic-shaped
// model history from persisted events, and repair a turn that was cut short by
// a crash (every `tool_use` needs a matching `tool_result`, or the next request
// is rejected as invalid history).
//
// No I/O and no logging here. `randomUUID` from node:crypto is the only
// dependency, used to mint synthetic event identities.

import { randomUUID } from 'node:crypto'
import type { RawLine } from '../../../history-reader.js'
import type { NativeCompactEvent, NativeLogEvent, NativeUserEvent } from './format.js'

/** The error text a repaired tool_result carries — mirrors the live loop's
 *  synthetic abort result, worded for a crash rather than a user interrupt. */
const MISSING_TOOL_RESULT_TEXT = 'tool result missing (session interrupted)'

/** A synthetic user event is a log INPUT: the caller appends it and the log
 *  assigns `seq`, so it deliberately carries no seq of its own. */
export type SyntheticUserEvent = Omit<NativeUserEvent, 'seq'>

export interface RepairResult {
  synthetic: SyntheticUserEvent[]
}

/** Index of the last compact boundary, or -1 when the log has none. */
function lastCompactIndex(events: readonly NativeLogEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'session/compact') return i
  }
  return -1
}

interface BlockLike {
  type?: unknown
  id?: unknown
  tool_use_id?: unknown
}

/** A user event is a tool-result event when its first content block is a
 *  tool_result — the same discriminator the live loop relies on. */
function blocksOf(content: unknown): BlockLike[] {
  return Array.isArray(content) ? (content as BlockLike[]) : []
}

function isToolResultUser(content: unknown): boolean {
  const blocks = blocksOf(content)
  return blocks.length > 0 && blocks[0].type === 'tool_result'
}

function isThinkingBlock(block: BlockLike): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

/** `<system-reminder>` context line shared by fresh, resumed and forked
 *  sessions, so a session's opening context looks identical on every path. */
export function contextSnapshot(cwd: string): string {
  return `<system-reminder>Working directory: ${cwd}\nCurrent time: ${new Date().toISOString()}</system-reminder>`
}

/**
 * Rebuild the `messages` array sent to the API from a persisted event stream.
 *
 * - `session/context` becomes a user text message.
 * - assistant/user events keep their content; thinking blocks are stripped
 *   from assistant content (the API rejects unsigned thinking on replay, and
 *   the native provider never persists signatures).
 * - a run of consecutive tool-result user events is concatenated into ONE
 *   user message — the API requires every tool_result for an assistant turn
 *   in a single user message.
 * - `turn/end` and `session/end-seed` are log bookkeeping, not model messages.
 * - a `session/compact` event is a floor: everything before the LAST one is
 *   superseded by the captured context snapshot and the summary, so replay
 *   starts there instead of rebuilding the pre-compact conversation.
 */
export function historyFromEvents(events: readonly NativeLogEvent[]): unknown[] {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  // The open tool-result group: consecutive tool-result user events append
  // their blocks here instead of starting a new message.
  let openResults: { role: 'user'; content: unknown[] } | null = null

  const compactIndex = lastCompactIndex(events)
  let start = 0
  if (compactIndex !== -1) {
    const compact = events[compactIndex] as NativeCompactEvent
    messages.push({ role: 'user', content: [{ type: 'text', text: compact.context }] })
    messages.push({ role: 'user', content: [{ type: 'text', text: compact.text }] })
    start = compactIndex + 1
  }

  for (let i = start; i < events.length; i++) {
    const event = events[i]
    switch (event.type) {
      case 'session/context':
        messages.push({ role: 'user', content: [{ type: 'text', text: event.text }] })
        openResults = null
        break
      case 'assistant':
        // Sidechain (nested-runner) frames belong to the transcript UI, not
        // the MAIN conversation the model continues from.
        if (event.parent_tool_use_id != null) break
        messages.push({
          role: 'assistant',
          content: blocksOf(event.message.content).filter((block) => !isThinkingBlock(block)),
        })
        openResults = null
        break
      case 'user':
        // Skipping a sidechain frame must NOT close the open tool-result
        // group: the sidechain interleaves with the parent's tool calls, and
        // the parent's results still have to merge into one user message.
        if (event.parent_tool_use_id != null) break
        if (isToolResultUser(event.message.content)) {
          if (openResults) {
            openResults.content.push(...blocksOf(event.message.content))
          } else {
            openResults = { role: 'user', content: [...blocksOf(event.message.content)] }
            messages.push(openResults)
          }
        } else {
          messages.push({ role: 'user', content: [...blocksOf(event.message.content)] })
          openResults = null
        }
        break
      default:
        break
    }
  }

  return messages
}

interface OpenToolUse {
  id: string
  sessionId: string
}

function collectOpenToolUses(
  events: readonly NativeLogEvent[],
): OpenToolUse[] {
  const open: OpenToolUse[] = []
  // The repair scope must match the replay/reader floor. A tool_use before the
  // last compact is superseded along with the rest of the pre-compact
  // conversation; appending its synthetic tool_result after the boundary would
  // inject an ORPHAN tool_result into a history that no longer contains the
  // tool_use, which the API rejects.
  for (let i = lastCompactIndex(events) + 1; i < events.length; i++) {
    const event = events[i]
    // Sidechain events are excluded from the main history, so their tool_use
    // ids are not the main history's to repair (a synthetic result for one
    // would be an orphan block in a conversation that never contained it).
    if (event.type === 'assistant') {
      if (event.parent_tool_use_id != null) continue
      for (const block of blocksOf(event.message.content)) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          open.push({ id: block.id, sessionId: event.session_id })
        }
      }
    } else if (event.type === 'user') {
      if (event.parent_tool_use_id != null) continue
      answerToolUses(open, event.message.content)
    }
  }
  return open
}

/** Drop ids answered by any tool_result block in a user message. */
function answerToolUses(open: OpenToolUse[], content: unknown): void {
  for (const block of blocksOf(content)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const index = open.findIndex((entry) => entry.id === block.tool_use_id)
    if (index !== -1) open.splice(index, 1)
  }
}

function missingResult(toolUseId: string): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text: MISSING_TOOL_RESULT_TEXT }],
    is_error: true,
  }
}

function syntheticUserEvent(id: string, sessionId: string, timestamp: string): SyntheticUserEvent {
  return {
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    timestamp,
    message: { role: 'user', content: [missingResult(id)] },
  }
}

/**
 * Scan a persisted event stream for `tool_use` ids left without a matching
 * `tool_result` (a crash mid-turn) and return one synthetic user event per
 * unanswered id. The caller appends these to the log (which assigns `seq`)
 * and then rebuilds history from events + synthetic.
 */
export function repairInterruptedTurn(
  events: readonly NativeLogEvent[],
  opts?: { now?: () => Date },
): RepairResult {
  const timestamp = (opts?.now?.() ?? new Date()).toISOString()
  return {
    synthetic: collectOpenToolUses(events).map((open) =>
      syntheticUserEvent(open.id, open.sessionId, timestamp),
    ),
  }
}

/**
 * The reader-facing twin of `repairInterruptedTurn`: scan raw transcript lines
 * for unanswered `tool_use` ids and return synthetic user tool_result lines.
 * The reader concatenates these after the persisted lines so a crashed turn
 * renders (and pages) as complete without rewriting the log.
 */
export function repairRenderableLines(
  lines: readonly RawLine[],
  opts?: { now?: () => Date },
): RawLine[] {
  const timestamp = (opts?.now?.() ?? new Date()).toISOString()
  const open: OpenToolUse[] = []
  for (const line of lines) {
    // Mirror the replay floor: sidechain lines are UI-only, so neither their
    // tool_use ids nor their results participate in the main-turn repair.
    if (line.parent_tool_use_id != null) continue
    if (line.type === 'assistant') {
      for (const block of blocksOf(line.message?.content)) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          open.push({ id: block.id, sessionId: rawLineSessionId(line) })
        }
      }
    } else if (line.type === 'user') {
      answerToolUses(open, line.message?.content)
    }
  }
  return open.map((entry) => syntheticUserEvent(entry.id, entry.sessionId, timestamp))
}

/** Native log lines are written with the snake_case `session_id`; older SDK
 *  transcript lines use camelCase `sessionId`. */
function rawLineSessionId(line: RawLine): string {
  return line.session_id ?? line.sessionId ?? ''
}
