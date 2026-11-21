// Neutral durable session-event vocabulary for the native provider core: the
// v3 native log language. Imports ONLY neutral shared/* refs + sibling
// vocabulary modules — zero SDK or host-domain imports (the neutrality pin in
// ../host-free.test.ts covers this directory).
//
// Scope (design resolution R6): SessionEventMap holds the durable counterparts
// of TODAY's 11-event v1/v2 union (session-log/format.ts), with tool results
// split out of user content into their own first-class event (12 keys).
// Live-only operational frames (init, api_retry, informational, task_*,
// result, stream_event) are NOT durable events — they live in ./stream.ts's
// live-frame union and are never persisted.
//
// Sidechain parent placement: `parentToolUseId` rides on the event ENVELOPE,
// mirroring v1/v2 where parent_tool_use_id is an event-level field, not part
// of the message. null = main thread; a string = the spawning tool_use id
// (sidechain / nested runner); absent = an operational event with no parent
// axis. Persisted message events (user/assistant/tool) always carry null or a
// string — the v3 parser must reject a missing field on them exactly as
// format.ts's requireParentToolUseId does for v1/v2, and migration (v1/v2→v3)
// maps the field one-to-one, preserving the null-vs-string distinction.
// Message sources (./source.ts) stay untouched: provenance there is about the
// producer, while the parent is a fact about the run that emitted the event.

import type { ToolCallId } from './brand.js'
import type { AssistantMessage, ToolResultMessage, UserMessage } from './message.js'
import type { StreamChunk } from './stream.js'
import type { TokenUsage } from './types.js'
import type { NativeAgentBase, NativeAgentProfile } from './agent-profile.js'
import type { StoredAgentDefinition } from '../../../../shared/agent-definitions.js'
import type { NativeFileAttachment } from '../../../../shared/attachment-types.js'

/** Position of an event in the session log; contiguous from 0 (the header
 *  line is not numbered). */
export type SessionSeq = number

/** A plain JSON value — the neutral shape for adapter-owned opaque metadata
 *  (tool/result meta). Undefined, functions and class instances are not JSON
 *  and deliberately do not belong here. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Why a turn ended. The SINGLE definition (T11 consolidation): the v1/v2 log
 *  format (session-log/format.ts) imports and re-exports this type rather than
 *  keeping its own copy. */
export type NativeTurnEndReason = 'completed' | 'interrupted' | 'error' | 'forked'

/** Packed timed runs of assistant streaming chunks, persisted alongside the
 *  settled message so replay can re-emit the original cadence without storing
 *  one envelope per delta.
 *
 *  Timing convention: `time0` is the run's first-chunk time (ms epoch, same
 *  clock as the event envelope's `time`); `dt[i]` is the inter-arrival delta
 *  in ms before chunk i, with dt[0] === 0 — chunk i lands at
 *  time0 + sum(dt[0..i]). `texts`/`args` align 1:1 with `dt`. `index` is the
 *  assembler block index the run belongs to. The single-chunk `chunk` variant
 *  is the escape hatch for any StreamChunk that does not pack into a run
 *  (block boundaries, usage, finish), carried verbatim at its absolute time. */
export type AssistantStreamRecord =
  | { type: 'text-chunks'; time0: number; index: number; dt: readonly number[]; texts: readonly string[] }
  | { type: 'reasoning-chunks'; time0: number; index: number; dt: readonly number[]; texts: readonly string[] }
  | { type: 'tool-call-chunks'; time0: number; index: number; dt: readonly number[]; id: ToolCallId; name?: string; args: readonly string[] }
  | { type: 'chunk'; time: number; chunk: StreamChunk }

/** The durable event language, keyed by event type. Merge-extensible
 *  (declaration merging) like ContentBlockMap / MessageSourceMap: an
 *  extension adds a key here and NativeSessionEvent widens automatically.
 *  Field shapes mirror session-log/format.ts's v1/v2 events (neutral names,
 *  neutral payload types); the envelope below carries what v1/v2 stamped at
 *  the top level (seq, and the parent axis). */
export interface SessionEventMap {
  /** One user turn (v1/v2 `user` event). Sidechain user frames carry a
   *  string parent on the envelope. */
  'user/message': UserMessage
  /** One settled assistant message plus its packed streaming history
   *  (v1/v2 `assistant` event). `interrupted` marks a partial turn. */
  'assistant/message': { message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true }
  /** A first-class tool result (v1/v2 persisted these as tool_result blocks
   *  inside user content). `error` names a structured tool failure; `meta`
   *  is adapter-owned opaque JSON (SDK-only representation lives here, never
   *  in the message). */
  'tool/result': { message: ToolResultMessage; error?: { name: string; code: string; reason?: string }; meta?: JsonValue }
  /** Opening/refreshed session context text (v1/v2 `session/context`). */
  'session/context': { text: string }
  /** Turn boundary (v1/v2 `turn/end`). */
  'turn/end': { reason: NativeTurnEndReason; usage?: TokenUsage }
  /** End of the seeded (inherited) prefix (v1/v2 `session/end-seed`). */
  'session/end-seed': { inherited?: true }
  /** Append-only compaction boundary (v1/v2 `session/compact`): `text` is
   *  the summary the model continues from, `context` the system-reminder
   *  snapshot captured at compaction time. */
  'session/compact': { text: string; context: string; uuid: string; timestamp: string }
  /** A mid-run steering supplement, persisted as the WRAPPED guidance the
   *  model saw (v1/v2 `session/supplement`). */
  'session/supplement': { uuid: string; text: string; timestamp: string }
  /** A skill invocation's loaded body (v1/v2 `session/skill`). */
  'session/skill': { name: string; body: string; timestamp: string }
  /** Durable catalog identity for one delegated run (v1/v2
   *  `subagent/descriptor`). Metadata only — never model history. `toolName`
   *  is the launching tool's name; the v3 parser validates the admitted set
   *  (Agent/Task/Explore) exactly as format.ts does. */
  'subagent/descriptor': {
    toolUseId: string
    parentToolUseId: string | null
    kind: 'agent' | 'skill'
    toolName: string
    label: string
    depth: number
    profile: NativeAgentProfile | null
    timestamp: string
  }
  /** Hidden authorization catalog (v1/v2 `session/attachments`): never model
   *  history, renderable transcript, search, or the seq backfill. */
  'session/attachments': { attachments: NativeFileAttachment[]; timestamp: string }
  /** History-only agent selection state (v1/v2 `session/agent`): the persona
   *  and base configuration used to restore the next turn. `name: null`
   *  clears the persona; `droppedAgent` records an unsupported selection that
   *  was refused. */
  'session/agent': {
    name: string | null
    definition?: StoredAgentDefinition
    base: NativeAgentBase
    droppedAgent?: { name: string; unsupportedFields: string[] }
    timestamp: string
  }
}

/** One durable event envelope. `time` is ms epoch; `seq` is the log position;
 *  `ignorable` marks an event a reader may skip without breaking replay;
 *  `parentToolUseId` is the sidechain axis (see the module header — null vs
 *  string is load-bearing and must survive migration). */
export type SessionEvent<T extends keyof SessionEventMap> = {
  type: T
  seq: SessionSeq
  time: number
  data: SessionEventMap[T]
  ignorable?: true
  parentToolUseId?: string | null
}

/** Any durable event, as a MAPPED discriminated union: instantiating
 *  SessionEvent with the whole key union would correlate neither `type` nor
 *  `data`, so the map is projected key-by-key first. Narrowing on `type`
 *  narrows `data` to that key's payload. */
export type NativeSessionEvent = { [T in keyof SessionEventMap]: SessionEvent<T> }[keyof SessionEventMap]

/** The v3 log header line. `v` is the literal format version (3);
 *  `inheritedEventCount` counts the seeded prefix events a fork/resume
 *  inherited before this log's own first event. */
export interface NativeSessionHeader {
  type: 'session/header'
  v: 3
  id: string
  cwd: string
  createdAt: number
  isSeeded: boolean
  inheritedEventCount: number
}

/** True for a sidechain (nested-runner) message event — one carrying a
 *  non-null string `parentToolUseId`. Structural parameter so it also works
 *  on raw parsed lines before full validation (mirrors format.ts's
 *  isSidechainEvent). Sidechain events are persisted and paged for the
 *  transcript UI but excluded from the main model history, the transcript seq
 *  backfill and search. A null parent (main thread) and an absent parent
 *  (operational event) are both non-sidechain; the null-vs-string distinction
 *  itself is preserved on the envelope, never collapsed. */
export function isSidechainEvent(event: { type?: unknown; parentToolUseId?: unknown }): boolean {
  return (
    (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') &&
    event.parentToolUseId != null
  )
}

/** True when the events' seq values form the gapless run
 *  startSeq, startSeq+1, … (the log reader's contiguity contract — v1/v2's
 *  parseEventLine enforces it per line against an expected seq). */
export function hasContiguousSeq(events: readonly { seq: SessionSeq }[], startSeq: SessionSeq = 0): boolean {
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== startSeq + i) return false
  }
  return true
}
