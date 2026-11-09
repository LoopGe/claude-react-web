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
import type { NativeLogEvent, NativeUserEvent } from './format.js'

/** The error text a repaired tool_result carries — mirrors the live loop's
 *  synthetic abort result, worded for a crash rather than a user interrupt. */
const MISSING_TOOL_RESULT_TEXT = 'tool result missing (session interrupted)'

/** A synthetic user event is a log INPUT: the caller appends it and the log
 *  assigns `seq`, so it deliberately carries no seq of its own. */
export type SyntheticUserEvent = Omit<NativeUserEvent, 'seq'>

export interface RepairResult {
  synthetic: SyntheticUserEvent[]
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
 */
export function historyFromEvents(events: readonly NativeLogEvent[]): unknown[] {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  // The open tool-result group: consecutive tool-result user events append
  // their blocks here instead of starting a new message.
  let openResults: { role: 'user'; content: unknown[] } | null = null

  for (const event of events) {
    switch (event.type) {
      case 'session/context':
        messages.push({ role: 'user', content: [{ type: 'text', text: event.text }] })
        openResults = null
        break
      case 'assistant':
        messages.push({
          role: 'assistant',
          content: blocksOf(event.message.content).filter((block) => !isThinkingBlock(block)),
        })
        openResults = null
        break
      case 'user':
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
  for (const event of events) {
    if (event.type === 'assistant') {
      for (const block of blocksOf(event.message.content)) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          open.push({ id: block.id, sessionId: event.session_id })
        }
      }
    } else if (event.type === 'user') {
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