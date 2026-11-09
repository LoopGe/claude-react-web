// server/providers/native/session-log/format.ts
//
// The on-disk native session log is JSONL: one `session/header` line followed
// by `seq`-numbered events. This module owns the version constant, the event
// types, line validation, and the exact serialization used by the writer and
// reader. It performs no I/O.

import { NativeSessionStorageError } from './errors.js'

export const NATIVE_SESSION_LOG_VERSION = 1

export interface NativeSessionHeader {
  type: 'session/header'
  v: number
  id: string
  cwd: string
  createdAt: number
  isSeeded: boolean
  inheritedEventCount: number
}

export type NativeTurnEndReason = 'completed' | 'interrupted' | 'error' | 'forked'

export interface NativeUsage {
  input_tokens: number
  output_tokens: number
}

export interface NativeUserEvent {
  seq: number
  type: 'user'
  uuid: string
  session_id: string
  parent_tool_use_id: null
  timestamp: string
  message: { role: 'user'; content: unknown[] }
  isCompactSummary?: true
}

export interface NativeAssistantEvent {
  seq: number
  type: 'assistant'
  uuid: string
  session_id: string
  parent_tool_use_id: null
  timestamp: string
  message: {
    role: 'assistant'
    content: unknown[]
    id?: string
    model?: string
    stop_reason?: string | null
    usage?: unknown
  }
}

export interface NativeContextEvent {
  seq: number
  type: 'session/context'
  text: string
}

export interface NativeTurnEndEvent {
  seq: number
  type: 'turn/end'
  reason: NativeTurnEndReason
  usage?: NativeUsage
}

export interface NativeSeedEndEvent {
  seq: number
  type: 'session/end-seed'
}

/** Append-only compaction boundary: everything before it is superseded by
 *  `text` (the summary the model continues from). `context` is the
 *  system-reminder snapshot captured at compaction time, kept separate from
 *  the summary so replay can seed the model history with the same opening
 *  context a fresh session gets. */
export interface NativeCompactEvent {
  seq: number
  type: 'session/compact'
  text: string
  context: string
  uuid: string
  timestamp: string
}

export type NativeLogEvent =
  | NativeUserEvent
  | NativeAssistantEvent
  | NativeContextEvent
  | NativeTurnEndEvent
  | NativeSeedEndEvent
  | NativeCompactEvent

export type NativeEventInput =
  | Omit<NativeUserEvent, 'seq'>
  | Omit<NativeAssistantEvent, 'seq'>
  | Omit<NativeContextEvent, 'seq'>
  | Omit<NativeTurnEndEvent, 'seq'>
  | Omit<NativeSeedEndEvent, 'seq'>
  | Omit<NativeCompactEvent, 'seq'>

const TURN_END_REASONS: readonly NativeTurnEndReason[] = [
  'completed',
  'interrupted',
  'error',
  'forked',
]

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function corrupt(sessionId: string, path: string, message: string): never {
  throw new NativeSessionStorageError('corrupt', message, sessionId, path)
}

function requireMessage(raw: JsonObject, role: 'user' | 'assistant', sessionId: string, path: string): JsonObject {
  const message = raw.message
  if (!isObject(message)) corrupt(sessionId, path, `${raw.type} event message must be an object`)
  if (message.role !== role) corrupt(sessionId, path, `${raw.type} event message.role must be '${role}'`)
  if (!Array.isArray(message.content)) corrupt(sessionId, path, `${raw.type} event message.content must be an array`)
  return message
}

function requireString(raw: JsonObject, field: string, sessionId: string, path: string): string {
  const value = raw[field]
  if (typeof value !== 'string') corrupt(sessionId, path, `${raw.type} event ${field} must be a string`)
  return value
}

/** A compact boundary's fields are all load-bearing (replay seeds the model
 *  with `context` + `text` and the reader keys the summary line on `uuid`),
 *  so an empty string is corruption, not a value. */
function requireNonEmptyString(raw: JsonObject, field: string, sessionId: string, path: string): string {
  const value = requireString(raw, field, sessionId, path)
  if (value.length === 0) corrupt(sessionId, path, `${raw.type} event ${field} must be a non-empty string`)
  return value
}

export function parseHeaderLine(raw: unknown, sessionId: string, path: string): NativeSessionHeader {
  if (!isObject(raw)) corrupt(sessionId, path, 'session header must be an object')
  if (raw.type !== 'session/header') corrupt(sessionId, path, `expected session/header, got '${String(raw.type)}'`)
  if (typeof raw.v !== 'number') corrupt(sessionId, path, 'session header v must be a number')
  if (raw.v !== NATIVE_SESSION_LOG_VERSION) {
    throw new NativeSessionStorageError(
      'unsupported-version',
      `unsupported session log version ${raw.v} (expected ${NATIVE_SESSION_LOG_VERSION})`,
      sessionId,
      path,
    )
  }
  if (typeof raw.id !== 'string') corrupt(sessionId, path, 'session header id must be a string')
  if (typeof raw.cwd !== 'string') corrupt(sessionId, path, 'session header cwd must be a string')
  if (typeof raw.createdAt !== 'number') corrupt(sessionId, path, 'session header createdAt must be a number')
  if (typeof raw.isSeeded !== 'boolean') corrupt(sessionId, path, 'session header isSeeded must be a boolean')
  if (typeof raw.inheritedEventCount !== 'number') {
    corrupt(sessionId, path, 'session header inheritedEventCount must be a number')
  }
  return {
    type: 'session/header',
    v: raw.v,
    id: raw.id,
    cwd: raw.cwd,
    createdAt: raw.createdAt,
    isSeeded: raw.isSeeded,
    inheritedEventCount: raw.inheritedEventCount,
  }
}

export function parseEventLine(
  raw: unknown,
  expectedSeq: number,
  sessionId: string,
  path: string,
): NativeLogEvent {
  if (!isObject(raw)) corrupt(sessionId, path, 'event must be an object')
  if (typeof raw.seq !== 'number') corrupt(sessionId, path, 'event seq must be a number')
  if (raw.seq !== expectedSeq) {
    corrupt(sessionId, path, `event seq mismatch: expected ${expectedSeq}, got ${raw.seq}`)
  }
  const seq = raw.seq

  switch (raw.type) {
    case 'user': {
      if (raw.parent_tool_use_id !== null) {
        corrupt(sessionId, path, 'user event parent_tool_use_id must be null')
      }
      const message = requireMessage(raw, 'user', sessionId, path)
      const event: NativeUserEvent = {
        seq,
        type: 'user',
        uuid: requireString(raw, 'uuid', sessionId, path),
        session_id: requireString(raw, 'session_id', sessionId, path),
        parent_tool_use_id: null,
        timestamp: requireString(raw, 'timestamp', sessionId, path),
        message: message as unknown as NativeUserEvent['message'],
      }
      if (raw.isCompactSummary !== undefined) {
        if (raw.isCompactSummary !== true) corrupt(sessionId, path, 'user event isCompactSummary must be true')
        event.isCompactSummary = true
      }
      return event
    }

    case 'assistant': {
      if (raw.parent_tool_use_id !== null) {
        corrupt(sessionId, path, 'assistant event parent_tool_use_id must be null')
      }
      const message = requireMessage(raw, 'assistant', sessionId, path)
      const event: NativeAssistantEvent = {
        seq,
        type: 'assistant',
        uuid: requireString(raw, 'uuid', sessionId, path),
        session_id: requireString(raw, 'session_id', sessionId, path),
        parent_tool_use_id: null,
        timestamp: requireString(raw, 'timestamp', sessionId, path),
        message: message as unknown as NativeAssistantEvent['message'],
      }
      if (message.stop_reason !== undefined && message.stop_reason !== null && typeof message.stop_reason !== 'string') {
        corrupt(sessionId, path, 'assistant event message.stop_reason must be a string or null')
      }
      return event
    }

    case 'session/context':
      return { seq, type: 'session/context', text: requireString(raw, 'text', sessionId, path) }

    case 'turn/end': {
      if (!TURN_END_REASONS.includes(raw.reason as NativeTurnEndReason)) {
        corrupt(sessionId, path, `turn/end event reason must be one of ${TURN_END_REASONS.join(', ')}`)
      }
      const event: NativeTurnEndEvent = {
        seq,
        type: 'turn/end',
        reason: raw.reason as NativeTurnEndReason,
      }
      if (raw.usage !== undefined) {
        if (!isObject(raw.usage)) corrupt(sessionId, path, 'turn/end event usage must be an object')
        if (typeof raw.usage.input_tokens !== 'number' || typeof raw.usage.output_tokens !== 'number') {
          corrupt(sessionId, path, 'turn/end event usage must have numeric input_tokens and output_tokens')
        }
        event.usage = { input_tokens: raw.usage.input_tokens, output_tokens: raw.usage.output_tokens }
      }
      return event
    }

    case 'session/end-seed':
      return { seq, type: 'session/end-seed' }

    case 'session/compact':
      return {
        seq,
        type: 'session/compact',
        text: requireNonEmptyString(raw, 'text', sessionId, path),
        context: requireNonEmptyString(raw, 'context', sessionId, path),
        uuid: requireNonEmptyString(raw, 'uuid', sessionId, path),
        timestamp: requireNonEmptyString(raw, 'timestamp', sessionId, path),
      }

    default:
      return corrupt(sessionId, path, `unknown event type '${String(raw.type)}'`)
  }
}

export function serializeHeader(header: NativeSessionHeader): string {
  return JSON.stringify(header)
}

export function serializeEvent(event: NativeLogEvent): string {
  return JSON.stringify(event)
}