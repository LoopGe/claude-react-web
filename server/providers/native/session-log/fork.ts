// server/providers/native/session-log/fork.ts
//
// Fork seed builder: take a source session log's snapshot and produce the
// NEUTRAL event stream a child log starts with. The cut is inclusive of the
// assistant turn anchor named by `resumeSessionAt` (or the whole log when no
// boundary is given); `seq` is renumbered to the child's own 0..n-1 range, a
// `session/end-seed` marker closes the inherited prefix, any tool_use left
// unanswered at the cut gets a synthetic neutral error result, `turn/end
// { forked }` closes the inherited turn, and a `session/context` event carries
// the child's cwd.
//
// Session identity: the neutral envelope carries NO session_id (the durable
// vocabulary has no such field) — the child log's header id owns the identity
// and stamps it at the SDK-seam / v1-v2 compat projection. So a fork "rewrites
// session_id" structurally: the copied neutral events carry no source
// session_id, and `NativeSessionLog.open` stamps the child id. The seed is
// always neutral v3; a v1/v2 source is migrated to neutral in memory first
// (neutralEventsOf), so the child never inherits a legacy version.
//
// Pure: no I/O and no logging.

import { NativeSessionStorageError } from './errors.js'
import { NATIVE_SESSION_LOG_V3 } from './format.js'
import type { NativeSessionLogSnapshot, NativeNeutralEventInput } from './log.js'
import { neutralEventsOf } from './neutral-read.js'
import { contextSnapshot, repairInterruptedTurn } from './replay.js'
import type { NativeSessionEvent, SessionEvent } from '../vocabulary/session-event.js'

export interface BuildForkSeedOptions {
  source: NativeSessionLogSnapshot
  sourceId: string
  cwd: string
  resumeSessionAt?: string
  now?: () => Date
}

export interface NativeForkSeed {
  events: NativeSessionEvent[]
  inheritedEventCount: number
  isSeeded: true
  version: number
}

/** `/name args` — the same whole-text grammar used by live slash expansion. */
const SKILL_COMMAND_RE = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\s+([\s\S]*))?$/

/** The durable uuid of a neutral event, or undefined for an operational event
 *  that carries none. Mirrors the legacy top-level `uuid` field: user /
 *  assistant / tool-result message ids and the compact / supplement uuids are
 *  the fork-boundary anchors. */
function eventUuidOf(event: NativeSessionEvent): string | undefined {
  switch (event.type) {
    case 'user/message': return event.data.id
    case 'assistant/message': return event.data.message.id
    case 'tool/result': return event.data.message.id
    case 'session/compact': return event.data.uuid
    case 'session/supplement': return event.data.uuid
    default: return undefined
  }
}

/** True only for the main-thread raw invocation whose FIRST text block names
 *  this instruction's skill. Other user events never claim an adjacent body. */
export function isSkillInstructionForRawUser(
  user: NativeSessionEvent,
  instruction: SessionEvent<'session/skill'>,
): boolean {
  if (user.type !== 'user/message' || user.parentToolUseId !== null) return false
  const block = user.data.content.find((candidate) => candidate.type === 'text')
  if (!block || block.type !== 'text') return false
  return SKILL_COMMAND_RE.exec(block.text)?.[1] === instruction.data.name
}

export function buildForkSeed(opts: BuildForkSeedOptions): NativeForkSeed {
  const { source, sourceId, cwd, resumeSessionAt } = opts
  // Canonical neutral events: the v3 baseline by reference, or the lossless
  // in-memory migration of a v1/v2 source. Never mutated — the prefix is copied
  // into fresh envelopes below (the source's data payloads are shared read-only).
  const sourceEvents = neutralEventsOf(source)

  let prefix: NativeSessionEvent[]
  if (resumeSessionAt === undefined) {
    prefix = [...sourceEvents]
  } else {
    const cut = sourceEvents.findIndex((event) => eventUuidOf(event) === resumeSessionAt)
    if (cut === -1) {
      throw new NativeSessionStorageError(
        'fork-boundary',
        `fork boundary ${resumeSessionAt} not found in source session ${sourceId}`,
        sourceId,
        source.path,
      )
    }
    let end = cut + 1
    // A raw skill prompt and its captured instruction are one replay group.
    // Only an immediately adjacent event is paired: a crash prefix that never
    // persisted the instruction stays raw-only, and assistant cuts are exact.
    const next = sourceEvents[end]
    if (next?.type === 'session/skill' && isSkillInstructionForRawUser(sourceEvents[cut], next)) end++
    prefix = sourceEvents.slice(0, end)
  }

  // Copied events belong to the CHILD session: renumber `seq` into the child's
  // range. The neutral envelope carries no session_id (the child log's header
  // id owns it — see the module header), so there is nothing to rewrite here.
  // Fresh envelopes; the source baseline is never mutated.
  const copied: NativeSessionEvent[] = prefix.map((event, index) => ({ ...event, seq: index }))
  const events: NativeSessionEvent[] = [...copied]
  const append = (event: NativeNeutralEventInput): void => {
    events.push({ ...event, seq: events.length } as NativeSessionEvent)
  }

  append({ type: 'session/end-seed', time: 0, data: {} })
  // Repair runs over the NEUTRAL copied prefix directly; the synthetic results
  // are neutral tool/result events appended verbatim (no legacy projection).
  const { synthetic } = repairInterruptedTurn(copied, { now: opts.now })
  for (const event of synthetic) {
    events.push({ ...event, seq: events.length })
  }
  append({ type: 'turn/end', time: 0, data: { reason: 'forked' } })
  append({ type: 'session/context', time: 0, data: { text: contextSnapshot(cwd) } })

  return { events, inheritedEventCount: copied.length, isSeeded: true, version: NATIVE_SESSION_LOG_V3 }
}
