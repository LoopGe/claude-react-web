// server/providers/native/session-log/format.ts
//
// The on-disk native session log is JSONL: one `session/header` line followed
// by `seq`-numbered events. This module owns the version constant, the event
// types, line validation, and the exact serialization used by the writer and
// reader. It performs no I/O.

import { NativeSessionStorageError } from './errors.js'
import { AGENT_FIELDS } from '../../../agent-definition-store.js'
import type { StoredAgentDefinition } from '../../../agent-definition-store.js'
import { isSdkAgentPermissionMode } from '../../../../shared/agent-definitions.js'
import type { SessionToolProfile } from '../../../../shared/tool-profile.js'
import { NATIVE_AGENT_EFFORT_LEVELS } from '../agent-profile.js'
import type { NativeAgentBase, NativeAgentProfile, NativeAgentSelectionEvent } from '../agent-profile.js'

export const NATIVE_SESSION_LOG_VERSION = 1

/** Execution values shared by descriptor persistence and Agent admission:
 *  only a positive integer can bound a nested run. */
export function isValidNativeMaxTurns(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

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
  /** Null for main-thread frames; the spawning `tool_use` id for a sidechain
   *  (nested runner) frame. Sidechain frames are persisted and paged for the
   *  transcript UI but never replayed into the MAIN model history. */
  parent_tool_use_id: string | null
  timestamp: string
  message: { role: 'user'; content: unknown[] }
  isCompactSummary?: true
}

export interface NativeAssistantEvent {
  seq: number
  type: 'assistant'
  uuid: string
  session_id: string
  /** See NativeUserEvent.parent_tool_use_id. */
  parent_tool_use_id: string | null
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

/** A mid-run steering supplement, persisted at the moment it is delivered to
 *  the model. `text` is the WRAPPED guidance (what the model saw), so replay
 *  can reconstruct the same history without re-wrapping. The event is not a
 *  renderable transcript line: the steered bubble lives in the sidecar. */
export interface NativeSupplementEvent {
  seq: number
  type: 'session/supplement'
  uuid: string
  text: string
  timestamp: string
}

export interface NativeSkillInvocationEvent {
  seq: number
  type: 'session/skill'
  name: string
  body: string
  timestamp: string
}

/** Durable catalog identity for one delegated run. This is metadata only: it
 *  never enters model history or the ordinary transcript stream. */
export interface NativeSubagentDescriptorEvent {
  seq: number
  type: 'subagent/descriptor'
  toolUseId: string
  parentToolUseId: string | null
  kind: 'agent' | 'skill'
  toolName: 'Agent' | 'Task' | 'Explore'
  label: string
  depth: number
  profile: NativeAgentProfile | null
  timestamp: string
}

export type NativeLogEvent =
  | NativeUserEvent
  | NativeAssistantEvent
  | NativeContextEvent
  | NativeTurnEndEvent
  | NativeSeedEndEvent
  | NativeCompactEvent
  | NativeSupplementEvent
  | NativeSkillInvocationEvent
  | NativeSubagentDescriptorEvent
  | NativeAgentSelectionEvent

export type NativeEventInput =
  | Omit<NativeUserEvent, 'seq'>
  | Omit<NativeAssistantEvent, 'seq'>
  | Omit<NativeContextEvent, 'seq'>
  | Omit<NativeTurnEndEvent, 'seq'>
  | Omit<NativeSeedEndEvent, 'seq'>
  | Omit<NativeCompactEvent, 'seq'>
  | Omit<NativeSupplementEvent, 'seq'>
  | Omit<NativeSkillInvocationEvent, 'seq'>
  | Omit<NativeSubagentDescriptorEvent, 'seq'>
  | Omit<NativeAgentSelectionEvent, 'seq'>

/** True for a sidechain (nested-runner) user/assistant frame — one carrying a
 *  non-null `parent_tool_use_id`. Works for both persisted log events and raw
 *  transcript lines. Sidechain frames are persisted and paged for the
 *  transcript UI but excluded from the main model history, the transcript seq
 *  backfill and search. */
export function isSidechainEvent(event: { type?: unknown; parent_tool_use_id?: unknown }): boolean {
  return (event.type === 'assistant' || event.type === 'user') && event.parent_tool_use_id != null
}

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

/** `parent_tool_use_id` is required and is either null (main thread) or a
 *  string (sidechain). A missing field is corruption, not "null". */
function requireParentToolUseId(raw: JsonObject, sessionId: string, path: string): string | null {
  const value = raw.parent_tool_use_id
  if (value === null) return null
  if (typeof value !== 'string') {
    corrupt(sessionId, path, `${raw.type} event parent_tool_use_id must be a string or null`)
  }
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

const AGENT_DEFINITION_KEYS = new Set<string>([
  'name',
  'enabled',
  'createdAt',
  'updatedAt',
  ...AGENT_FIELDS,
])
const AGENT_EVENT_KEYS = new Set(['seq', 'type', 'name', 'definition', 'base', 'droppedAgent', 'timestamp'])
const AGENT_BASE_KEYS = new Set(['model', 'permissionMode', 'effortLevel', 'skillPolicy', 'toolProfile'])
const TOOL_PROFILE_KEYS = new Set(['tools', 'allowedTools', 'disallowedTools', 'toolAliases', 'toolConfig'])
const AGENT_MEMORY_VALUES = ['user', 'project', 'local']
const SKILL_INVOCATION_KEYS = new Set(['seq', 'type', 'name', 'body', 'timestamp'])
const SUBAGENT_DESCRIPTOR_KEYS = new Set([
  'seq', 'type', 'toolUseId', 'parentToolUseId', 'kind', 'toolName', 'label', 'depth', 'profile', 'timestamp',
])
const SUBAGENT_TOOL_NAMES = ['Agent', 'Task', 'Explore']
const AGENT_PROFILE_KEYS = new Set([
  'name', 'instruction', 'model', 'tools', 'disallowedTools', 'mcpServers', 'skills',
  'permissionMode', 'maxTurns', 'effort',
])

function requireKnownKeys(
  raw: JsonObject,
  allowed: ReadonlySet<string>,
  label: string,
  sessionId: string,
  path: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) corrupt(sessionId, path, `${label} has unknown field '${key}'`)
  }
}

function requireSnapshotString(
  raw: JsonObject,
  field: string,
  label: string,
  sessionId: string,
  path: string,
): string {
  const value = raw[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    corrupt(sessionId, path, `${label} ${field} must be a non-empty string`)
  }
  return value
}

function requireSnapshotStringArray(
  value: unknown,
  label: string,
  sessionId: string,
  path: string,
  nonEmptyItems = true,
): string[] {
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== 'string' || (nonEmptyItems && item.trim().length === 0))) {
    corrupt(sessionId, path, `${label} must be an array of ${nonEmptyItems ? 'non-empty ' : ''}strings`)
  }
  return [...value]
}

function parseAgentToolProfile(
  raw: unknown,
  sessionId: string,
  path: string,
): SessionToolProfile {
  if (!isObject(raw)) corrupt(sessionId, path, 'session/agent event base.toolProfile must be an object')
  requireKnownKeys(raw, TOOL_PROFILE_KEYS, 'session/agent event base.toolProfile', sessionId, path)
  const profile: SessionToolProfile = {}
  for (const field of ['tools', 'allowedTools', 'disallowedTools'] as const) {
    if (raw[field] !== undefined) {
      profile[field] = requireSnapshotStringArray(
        raw[field],
        `session/agent event base.toolProfile.${field}`,
        sessionId,
        path,
        false,
      )
    }
  }
  if (raw.toolAliases !== undefined) {
    if (!isObject(raw.toolAliases) || Object.values(raw.toolAliases).some((value) => typeof value !== 'string')) {
      corrupt(sessionId, path, 'session/agent event base.toolProfile.toolAliases must map strings to strings')
    }
    profile.toolAliases = { ...raw.toolAliases } as Record<string, string>
  }
  if (raw.toolConfig !== undefined) {
    if (!isObject(raw.toolConfig)) {
      corrupt(sessionId, path, 'session/agent event base.toolProfile.toolConfig must be an object')
    }
    profile.toolConfig = { ...raw.toolConfig }
  }
  return profile
}

function parseAgentBase(raw: unknown, sessionId: string, path: string): NativeAgentBase {
  if (!isObject(raw)) corrupt(sessionId, path, 'session/agent event base must be an object')
  requireKnownKeys(raw, AGENT_BASE_KEYS, 'session/agent event base', sessionId, path)
  const base: NativeAgentBase = {
    model: requireSnapshotString(raw, 'model', 'session/agent event base', sessionId, path),
    permissionMode: requireSnapshotString(raw, 'permissionMode', 'session/agent event base', sessionId, path),
  }
  if (raw.effortLevel !== undefined) {
    base.effortLevel = requireSnapshotString(raw, 'effortLevel', 'session/agent event base', sessionId, path)
  }
  if (raw.skillPolicy !== undefined) {
    base.skillPolicy = raw.skillPolicy === 'all'
      ? 'all'
      : requireSnapshotStringArray(raw.skillPolicy, 'session/agent event base.skillPolicy', sessionId, path)
  }
  if (raw.toolProfile !== undefined) base.toolProfile = parseAgentToolProfile(raw.toolProfile, sessionId, path)
  return base
}

/** Strict counterpart of the store's request-time coercion: persisted snapshots
 *  must not lose malformed enum values or unknown fields on the way back in. */
function parseAgentDefinitionSnapshot(
  raw: unknown,
  sessionId: string,
  path: string,
): StoredAgentDefinition {
  if (!isObject(raw)) corrupt(sessionId, path, 'session/agent event definition must be an object')
  requireKnownKeys(raw, AGENT_DEFINITION_KEYS, 'session/agent event definition', sessionId, path)
  for (const field of ['name', 'description', 'prompt'] as const) {
    requireSnapshotString(raw, field, 'session/agent event definition', sessionId, path)
  }
  if (typeof raw.enabled !== 'boolean') {
    corrupt(sessionId, path, 'session/agent event definition.enabled must be a boolean')
  }
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field])) {
      corrupt(sessionId, path, `session/agent event definition.${field} must be a finite number`)
    }
  }
  for (const field of [
    'model',
    'initialPrompt',
    'observer',
    'observerMessage',
    'criticalSystemReminder_EXPERIMENTAL',
  ] as const) {
    if (raw[field] !== undefined) {
      requireSnapshotString(raw, field, 'session/agent event definition', sessionId, path)
    }
  }
  for (const field of ['tools', 'disallowedTools', 'mcpServers', 'skills'] as const) {
    if (raw[field] !== undefined) {
      requireSnapshotStringArray(raw[field], `session/agent event definition.${field}`, sessionId, path)
    }
  }
  if (raw.memory !== undefined && !AGENT_MEMORY_VALUES.includes(raw.memory as string)) {
    corrupt(sessionId, path, 'session/agent event definition.memory is invalid')
  }
  if (raw.effort !== undefined) {
    const valid = typeof raw.effort === 'number'
      ? Number.isFinite(raw.effort)
      : typeof raw.effort === 'string' &&
        (NATIVE_AGENT_EFFORT_LEVELS as readonly string[]).includes(raw.effort)
    if (!valid) corrupt(sessionId, path, 'session/agent event definition.effort is invalid')
  }
  if (raw.permissionMode !== undefined && !isSdkAgentPermissionMode(raw.permissionMode)) {
    corrupt(sessionId, path, 'session/agent event definition.permissionMode is invalid')
  }
  if (raw.maxTurns !== undefined && (typeof raw.maxTurns !== 'number' || !Number.isFinite(raw.maxTurns))) {
    corrupt(sessionId, path, 'session/agent event definition.maxTurns must be a finite number')
  }
  for (const field of ['background', 'omitClaudeMd'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
      corrupt(sessionId, path, `session/agent event definition.${field} must be a boolean`)
    }
  }
  return { ...raw } as unknown as StoredAgentDefinition
}

function parseDescriptorProfile(
  raw: unknown,
  sessionId: string,
  path: string,
): NativeAgentProfile {
  if (!isObject(raw)) corrupt(sessionId, path, 'subagent/descriptor event profile must be an object or null')
  requireKnownKeys(raw, AGENT_PROFILE_KEYS, 'subagent/descriptor event profile', sessionId, path)
  const profile: NativeAgentProfile = {
    name: raw.name === null
      ? null
      : requireSnapshotString(raw, 'name', 'subagent/descriptor event profile', sessionId, path),
  }
  for (const field of ['instruction', 'model'] as const) {
    if (raw[field] !== undefined) {
      profile[field] = requireSnapshotString(raw, field, 'subagent/descriptor event profile', sessionId, path)
    }
  }
  for (const field of ['tools', 'disallowedTools', 'mcpServers', 'skills'] as const) {
    if (raw[field] !== undefined) {
      profile[field] = requireSnapshotStringArray(
        raw[field],
        `subagent/descriptor event profile.${field}`,
        sessionId,
        path,
      )
    }
  }
  if (raw.permissionMode !== undefined) {
    if (!isSdkAgentPermissionMode(raw.permissionMode)) {
      corrupt(sessionId, path, 'subagent/descriptor event profile.permissionMode is invalid')
    }
    profile.permissionMode = raw.permissionMode
  }
  if (raw.maxTurns !== undefined) {
    if (!isValidNativeMaxTurns(raw.maxTurns)) {
      corrupt(sessionId, path, 'subagent/descriptor event profile.maxTurns must be a positive integer')
    }
    profile.maxTurns = raw.maxTurns
  }
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== 'string' || !(NATIVE_AGENT_EFFORT_LEVELS as readonly string[]).includes(raw.effort)) {
      corrupt(sessionId, path, 'subagent/descriptor event profile.effort is invalid')
    }
    profile.effort = raw.effort as NativeAgentProfile['effort']
  }
  return profile
}

function parseSubagentDescriptor(
  raw: JsonObject,
  seq: number,
  sessionId: string,
  path: string,
): NativeSubagentDescriptorEvent {
  requireKnownKeys(raw, SUBAGENT_DESCRIPTOR_KEYS, 'subagent/descriptor event', sessionId, path)
  if (raw.kind !== 'agent' && raw.kind !== 'skill') {
    corrupt(sessionId, path, 'subagent/descriptor event kind must be agent or skill')
  }
  if (typeof raw.toolName !== 'string' || !SUBAGENT_TOOL_NAMES.includes(raw.toolName)) {
    corrupt(sessionId, path, 'subagent/descriptor event toolName is invalid')
  }
  if (typeof raw.depth !== 'number' || !Number.isInteger(raw.depth) || raw.depth < 1) {
    corrupt(sessionId, path, 'subagent/descriptor event depth must be a positive integer')
  }
  const parentToolUseId = raw.parentToolUseId
  if (parentToolUseId !== null && (typeof parentToolUseId !== 'string' || parentToolUseId.length === 0)) {
    corrupt(sessionId, path, 'subagent/descriptor event parentToolUseId must be a non-empty string or null')
  }
  return {
    seq,
    type: 'subagent/descriptor',
    toolUseId: requireNonEmptyString(raw, 'toolUseId', sessionId, path),
    parentToolUseId,
    kind: raw.kind,
    toolName: raw.toolName as NativeSubagentDescriptorEvent['toolName'],
    label: requireNonEmptyString(raw, 'label', sessionId, path),
    depth: raw.depth,
    profile: raw.profile === null ? null : parseDescriptorProfile(raw.profile, sessionId, path),
    timestamp: requireNonEmptyString(raw, 'timestamp', sessionId, path),
  }
}

function parseDroppedAgent(
  raw: unknown,
  sessionId: string,
  path: string,
): NonNullable<NativeAgentSelectionEvent['droppedAgent']> {
  if (!isObject(raw)) corrupt(sessionId, path, 'session/agent event droppedAgent must be an object')
  requireKnownKeys(raw, new Set(['name', 'unsupportedFields']), 'session/agent event droppedAgent', sessionId, path)
  const name = requireSnapshotString(raw, 'name', 'session/agent event droppedAgent', sessionId, path)
  const unsupportedFields = requireSnapshotStringArray(
    raw.unsupportedFields,
    'session/agent event droppedAgent.unsupportedFields',
    sessionId,
    path,
  )
  if (unsupportedFields.length === 0) {
    corrupt(sessionId, path, 'session/agent event droppedAgent.unsupportedFields must not be empty')
  }
  return { name, unsupportedFields }
}

function parseAgentSelection(
  raw: JsonObject,
  seq: number,
  sessionId: string,
  path: string,
): NativeAgentSelectionEvent {
  requireKnownKeys(raw, AGENT_EVENT_KEYS, 'session/agent event', sessionId, path)
  const name = raw.name
  if (name !== null && (typeof name !== 'string' || name.trim().length === 0)) {
    corrupt(sessionId, path, 'session/agent event name must be a non-empty string or null')
  }
  if (name === null && raw.definition !== undefined) {
    corrupt(sessionId, path, 'session/agent event with name null must not carry a definition')
  }
  let definition: StoredAgentDefinition | undefined
  if (name !== null) {
    if (raw.definition === undefined) {
      corrupt(sessionId, path, 'session/agent event with a name requires a definition')
    }
    definition = parseAgentDefinitionSnapshot(raw.definition, sessionId, path)
    if (definition.name !== name) {
      corrupt(sessionId, path, 'session/agent event definition.name must match name')
    }
  }
  let droppedAgent: NativeAgentSelectionEvent['droppedAgent']
  if (raw.droppedAgent !== undefined) {
    if (name !== null) corrupt(sessionId, path, 'session/agent event droppedAgent requires name null')
    droppedAgent = parseDroppedAgent(raw.droppedAgent, sessionId, path)
  }
  return {
    seq,
    type: 'session/agent',
    name,
    ...(definition === undefined ? {} : { definition }),
    base: parseAgentBase(raw.base, sessionId, path),
    ...(droppedAgent === undefined ? {} : { droppedAgent }),
    timestamp: requireNonEmptyString(raw, 'timestamp', sessionId, path),
  }
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
      const parentToolUseId = requireParentToolUseId(raw, sessionId, path)
      const message = requireMessage(raw, 'user', sessionId, path)
      const event: NativeUserEvent = {
        seq,
        type: 'user',
        uuid: requireString(raw, 'uuid', sessionId, path),
        session_id: requireString(raw, 'session_id', sessionId, path),
        parent_tool_use_id: parentToolUseId,
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
      const parentToolUseId = requireParentToolUseId(raw, sessionId, path)
      const message = requireMessage(raw, 'assistant', sessionId, path)
      const event: NativeAssistantEvent = {
        seq,
        type: 'assistant',
        uuid: requireString(raw, 'uuid', sessionId, path),
        session_id: requireString(raw, 'session_id', sessionId, path),
        parent_tool_use_id: parentToolUseId,
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

    case 'session/supplement':
      return {
        seq,
        type: 'session/supplement',
        uuid: requireNonEmptyString(raw, 'uuid', sessionId, path),
        text: requireNonEmptyString(raw, 'text', sessionId, path),
        timestamp: requireNonEmptyString(raw, 'timestamp', sessionId, path),
      }

    case 'session/skill':
      requireKnownKeys(raw, SKILL_INVOCATION_KEYS, 'session/skill event', sessionId, path)
      return {
        seq,
        type: 'session/skill',
        name: requireString(raw, 'name', sessionId, path),
        body: requireString(raw, 'body', sessionId, path),
        timestamp: requireString(raw, 'timestamp', sessionId, path),
      }

    case 'session/agent':
      return parseAgentSelection(raw, seq, sessionId, path)

    case 'subagent/descriptor':
      return parseSubagentDescriptor(raw, seq, sessionId, path)

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