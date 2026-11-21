// server/providers/native/session-log/replay.ts
//
// Pure NEUTRAL replay over the native session log (design R1/R3, Task 13):
// fold the durable neutral event stream (vocabulary NativeSessionEvent) into
// the NEUTRAL model history (RequestMessage[]) the turn loop sends, and repair
// a turn a crash cut short (every tool-call needs a matching first-class tool
// result, or the next request is rejected as invalid history).
//
// Ownership split vs the wire adapter (wire/wire-projection.ts): replay owns
// the EVENT-level semantics — compact floor, sidechain skip, supplement dedup,
// skill body verbatim, the signed-thinking retention filter — and keeps tool
// results FIRST-CLASS (role-'tool' messages, ungrouped). The wire adapter owns
// the API-level semantics: grouping consecutive tool results into one user
// message, parsing raw-JSON tool-call arguments, and file/PDF projection.
//
// `repairRenderableLines` is the reader-facing twin: it operates on the
// adapter-projected SDK RawLines (the host history read path) and mints
// synthetic SDK tool_result lines, so a crashed turn renders (and pages) as
// complete without rewriting the log.
//
// No I/O and no logging here. `randomUUID` from node:crypto is the only
// non-vocabulary dependency, used to mint synthetic event identities.

import { randomUUID } from 'node:crypto'
import type { RawLine } from '../../../../shared/transcript-format.js'
import { isRetainedThinkingBlock } from '../vocabulary/types.js'
import { isSidechainEvent } from '../vocabulary/session-event.js'
import type { NativeSessionEvent, SessionEvent } from '../vocabulary/session-event.js'
import {
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
  type RequestMessage,
} from '../vocabulary/message.js'
import { brandString } from '../vocabulary/brand.js'
import { isSidechainEvent as isSidechainLine } from './format.js'

/** The error text a repaired tool result carries — mirrors the live loop's
 *  synthetic abort result, worded for a crash rather than a user interrupt. */
const MISSING_TOOL_RESULT_TEXT = 'tool result missing (session interrupted)'

/** A synthetic neutral tool/result event is a log INPUT: the caller appends it
 *  and the log assigns `seq`, so it deliberately carries no seq of its own. */
export type SyntheticToolResultEvent = Omit<SessionEvent<'tool/result'>, 'seq'>

export interface RepairResult {
  synthetic: SyntheticToolResultEvent[]
}

/** Index of the last compact boundary, or -1 when the log has none. */
function lastCompactIndex(events: readonly NativeSessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'session/compact') return i
  }
  return -1
}

/** `<system-reminder>` context line shared by fresh, resumed and forked
 *  sessions, so a session's opening context looks identical on every path. */
export function contextSnapshot(cwd: string): string {
  return `<system-reminder>Working directory: ${cwd}\nCurrent time: ${new Date().toISOString()}</system-reminder>`
}

/** One neutral user text message (compact seed, context, skill body,
 *  supplement). Identified + frozen like every published vocabulary message;
 *  the wire projection reads role/content only, never the minted id. */
function userText(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * Rebuild the NEUTRAL model history (`RequestMessage[]`) from a persisted
 * neutral event stream. The wire adapter projects this to the API request.
 *
 * - `session/context` becomes a user text message.
 * - `assistant/message` keeps its settled message (id/source preserved); a
 *   reasoning block survives only when signed (non-empty `signature`) or
 *   redacted (non-empty `data`) — the API rejects unsigned thinking on replay.
 * - `tool/result` is a FIRST-CLASS role-tool message, kept UNGROUPED — the
 *   wire adapter merges consecutive ones into the single user message the API
 *   requires per assistant turn.
 * - `user/message` keeps its content (text / image / structured file with the
 *   FULL resolved attachment — modelForm is per-occurrence, so the catalog
 *   alone cannot recover it).
 * - `turn/end` and `session/end-seed` are log bookkeeping, not model messages.
 * - `session/agent`, `session/attachments` and `subagent/descriptor` are
 *   history-only metadata, not model messages.
 * - a `session/compact` event is a floor: everything before the LAST one is
 *   superseded by the captured context snapshot and the summary, so replay
 *   starts there instead of rebuilding the pre-compact conversation.
 * - a `session/skill` event is the canonical instruction body captured for the
 *   raw user invocation immediately before it. Replay inserts that stored body
 *   verbatim as a genuine user text message; it never consults the current
 *   skill catalog.
 * - a `session/supplement` event is a user message carrying the ALREADY
 *   WRAPPED guidance, inserted at its log position. If the same uuid also
 *   appears as a main-thread user/message event (the requeue after a failed
 *   delivery), the supplement is dropped: the plain prompt is the message the
 *   model actually received.
 * - sidechain (nested-runner) message events belong to the transcript UI, not
 *   the MAIN conversation the model continues from, and are skipped.
 */
export function historyFromEvents(events: readonly NativeSessionEvent[]): RequestMessage[] {
  const messages: RequestMessage[] = []

  const compactIndex = lastCompactIndex(events)
  let start = 0
  if (compactIndex !== -1) {
    const compact = events[compactIndex] as Extract<NativeSessionEvent, { type: 'session/compact' }>
    messages.push(userText(compact.data.context))
    messages.push(userText(compact.data.text))
    start = compactIndex + 1
  }

  // A supplement appended by a round whose flush then failed (or whose turn
  // was interrupted mid-flush) is still persisted by the turn/end flush, even
  // though the model never saw it. The manager requeues that message as an
  // ordinary prompt, which persists a user/message event with the SAME uuid
  // later. Replaying both would duplicate the guidance, so a supplement whose
  // uuid also appears as a main-thread user event in this window is dropped
  // and the plain prompt wins. A delivered supplement (no same-uuid user
  // event) still replays as-is.
  const userUuids = new Set<string>()
  for (let i = start; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'user/message' && !isSidechainEvent(event)) userUuids.add(event.data.id)
  }

  for (let i = start; i < events.length; i++) {
    const event = events[i]
    switch (event.type) {
      case 'session/context':
        messages.push(userText(event.data.text))
        break
      case 'assistant/message':
        if (isSidechainEvent(event)) break
        messages.push(freezeMessage({
          ...event.data.message,
          content: event.data.message.content.filter(isRetainedThinkingBlock),
        }))
        break
      case 'user/message':
        if (isSidechainEvent(event)) break
        // The event-level isCompactSummary marker is durable metadata, not a
        // model-message field; the clean UserMessage carries role/id/content/
        // source only.
        messages.push(freezeMessage({
          role: 'user',
          id: event.data.id,
          content: event.data.content,
          source: event.data.source,
        }))
        break
      case 'tool/result':
        if (isSidechainEvent(event)) break
        messages.push(freezeMessage(event.data.message))
        break
      case 'session/skill':
        messages.push(userText(event.data.body))
        break
      case 'session/supplement':
        if (userUuids.has(event.data.uuid)) break
        messages.push(userText(event.data.text))
        break
      default:
        break
    }
  }

  return messages
}

interface OpenToolUse {
  id: string
}

/** Scan the post-compact neutral stream for main-thread tool-call ids left
 *  unanswered by a first-class tool/result. */
function collectOpenToolUses(events: readonly NativeSessionEvent[]): OpenToolUse[] {
  const open: OpenToolUse[] = []
  // The repair scope must match the replay/reader floor. A tool-call before the
  // last compact is superseded along with the rest of the pre-compact
  // conversation; appending its synthetic result after the boundary would
  // inject an ORPHAN tool_result into a history that no longer contains the
  // tool-call, which the API rejects.
  for (let i = lastCompactIndex(events) + 1; i < events.length; i++) {
    const event = events[i]
    // Sidechain events are excluded from the main history, so their tool-call
    // ids are not the main history's to repair (a synthetic result for one
    // would be an orphan block in a conversation that never contained it).
    if (event.type === 'assistant/message') {
      if (isSidechainEvent(event)) continue
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') open.push({ id: block.id })
      }
    } else if (event.type === 'tool/result') {
      if (isSidechainEvent(event)) continue
      const callId = event.data.message.toolCallId
      const index = open.findIndex((entry) => entry.id === callId)
      if (index !== -1) open.splice(index, 1)
    }
  }
  return open
}

/**
 * Scan a persisted neutral event stream for tool-call ids left without a
 * matching first-class tool/result (a crash mid-turn) and return one synthetic
 * neutral tool/result event input per unanswered id. The caller appends these
 * to the log (which assigns `seq`) and then rebuilds history from events +
 * synthetic. The synthetic message's minted id IS the durable uuid the legacy
 * projection stamps, so live emission, disk replay and the seq store share one
 * identity.
 */
export function repairInterruptedTurn(
  events: readonly NativeSessionEvent[],
  opts?: { now?: () => Date },
): RepairResult {
  const time = (opts?.now?.() ?? new Date()).getTime()
  return {
    synthetic: collectOpenToolUses(events).map((open) => {
      const callId = brandString<'ToolCallId'>(open.id)
      return {
        type: 'tool/result',
        time,
        parentToolUseId: null,
        data: {
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: MISSING_TOOL_RESULT_TEXT }],
            isError: true,
          }),
        },
      }
    }),
  }
}

// ── reader-facing repair over adapter-projected SDK RawLines ───────────────

interface BlockLike {
  type?: unknown
  id?: unknown
  tool_use_id?: unknown
}

function blocksOf(content: unknown): BlockLike[] {
  return Array.isArray(content) ? (content as BlockLike[]) : []
}

function missingResult(toolUseId: string): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text: MISSING_TOOL_RESULT_TEXT }],
    is_error: true,
  }
}

/** Native log lines are written with the snake_case `session_id`; older SDK
 *  transcript lines use camelCase `sessionId`. */
function rawLineSessionId(line: RawLine): string {
  return line.session_id ?? line.sessionId ?? ''
}

/** Drop ids answered by any tool_result block in a user line. */
function answerToolUses(open: Array<{ id: string; sessionId: string }>, content: unknown): void {
  for (const block of blocksOf(content)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const index = open.findIndex((entry) => entry.id === block.tool_use_id)
    if (index !== -1) open.splice(index, 1)
  }
}

/**
 * The reader-facing twin of `repairInterruptedTurn`: scan the adapter-projected
 * SDK transcript lines for unanswered `tool_use` ids and return synthetic user
 * tool_result lines. The reader concatenates these after the persisted lines so
 * a crashed turn renders (and pages) as complete without rewriting the log.
 */
export function repairRenderableLines(
  lines: readonly RawLine[],
  opts?: { now?: () => Date },
): RawLine[] {
  const timestamp = (opts?.now?.() ?? new Date()).toISOString()
  const open: Array<{ id: string; sessionId: string }> = []
  for (const line of lines) {
    // Mirror the replay floor: sidechain lines are UI-only, so neither their
    // tool_use ids nor their results participate in the main-turn repair.
    if (isSidechainLine(line)) continue
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
  return open.map((entry) => ({
    type: 'user',
    uuid: randomUUID(),
    session_id: entry.sessionId,
    parent_tool_use_id: null,
    timestamp,
    message: { role: 'user', content: [missingResult(entry.id)] },
  }))
}