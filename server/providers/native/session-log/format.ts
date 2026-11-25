// server/providers/native/session-log/format.ts
//
// The on-disk native session log is JSONL: one `session/header` line followed
// by `seq`-numbered events. This module owns the version constant, the event
// types, line validation, and the exact serialization used by the writer and
// reader. It performs no I/O.

import { NativeSessionStorageError } from './errors.js'
import type { StoredAgentDefinition } from '../../../agent-definition-store.js'
import { AGENT_FIELDS, isSdkAgentPermissionMode } from '../../../../shared/agent-definitions.js'
import type { SessionToolProfile } from '../../../../shared/tool-profile.js'
import { NATIVE_AGENT_EFFORT_LEVELS } from '../agent-profile.js'
import type { NativeAgentBase, NativeAgentProfile, NativeAgentSelectionEvent } from '../agent-profile.js'
import type { NativeFileAttachment, NativeFileBlock } from '../../attachment-types.js'
import type {
  AssistantStreamRecord,
  NativeSessionEvent,
  SessionEventMap,
} from '../vocabulary/session-event.js'
import { parseToolInput, type ContentBlock, type TokenUsage } from '../vocabulary/types.js'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '../vocabulary/message.js'

export const NATIVE_SESSION_LOG_VERSION = 1
export const NATIVE_SESSION_LOG_V2 = 2
export const NATIVE_SESSION_LOG_V3 = 3
const SUPPORTED_NATIVE_SESSION_LOG_VERSIONS = [
  NATIVE_SESSION_LOG_VERSION,
  NATIVE_SESSION_LOG_V2,
  NATIVE_SESSION_LOG_V3,
] as const

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

/** Consolidated in the neutral vocabulary (T11): the v1/v2 log and the v3
 *  neutral events share ONE definition. Re-exported here so existing
 *  `session-log/format.js` importers keep resolving the same type. */
export type { NativeTurnEndReason } from '../vocabulary/session-event.js'
import type { NativeTurnEndReason } from '../vocabulary/session-event.js'

export interface NativeUsage {
  input_tokens: number
  output_tokens: number
  /** Cache buckets are preserved verbatim when present so v1/v2→v3 migration
   *  carries the full turn-end usage (the disjoint neutral TokenUsage keeps
   *  them separate). Readers that only sum the counter pair ignore these. */
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type { NativeFileAttachment, NativeFileBlock } from '../../attachment-types.js'

/** Hidden authorization catalog. It never enters model history, renderable
 *  transcript lines, search, or the transcript seq backfill. */
export interface NativeAttachmentCatalogEvent {
  seq: number
  type: 'session/attachments'
  attachments: NativeFileAttachment[]
  timestamp: string
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
  | NativeAttachmentCatalogEvent
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
  | Omit<NativeAttachmentCatalogEvent, 'seq'>
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
const ATTACHMENT_CATALOG_KEYS = new Set(['seq', 'type', 'attachments', 'timestamp'])
const NATIVE_FILE_KEYS = new Set(['type', 'attachment'])
const NATIVE_ATTACHMENT_KEYS = new Set(['id', 'name', 'size', 'digest', 'path', 'mediaType', 'modelForm'])
const SHA256_PATTERN = /^[a-f0-9]{64}$/
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

function parseNativeAttachment(
  raw: unknown,
  sessionId: string,
  path: string,
): NativeFileAttachment {
  if (!isObject(raw)) corrupt(sessionId, path, 'native file attachment must be an object')
  requireKnownKeys(raw, NATIVE_ATTACHMENT_KEYS, 'native file attachment', sessionId, path)
  for (const field of ['id', 'name', 'path'] as const) {
    if (typeof raw[field] !== 'string' || raw[field].trim().length === 0) {
      corrupt(sessionId, path, `native file attachment ${field} must be a non-empty string`)
    }
  }
  if (typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0) {
    corrupt(sessionId, path, 'native file attachment size must be a non-negative safe integer')
  }
  if (typeof raw.digest !== 'string' || !SHA256_PATTERN.test(raw.digest)) {
    corrupt(sessionId, path, 'native file attachment digest must be a lowercase sha256')
  }
  if (raw.mediaType !== undefined && (typeof raw.mediaType !== 'string' || raw.mediaType.trim().length === 0)) {
    corrupt(sessionId, path, 'native file attachment mediaType must be a non-empty string')
  }
  if (raw.modelForm !== 'handle' && raw.modelForm !== 'pdf-document') {
    corrupt(sessionId, path, 'native file attachment modelForm must be handle or pdf-document')
  }
  if (raw.modelForm === 'pdf-document' && raw.mediaType !== 'application/pdf') {
    corrupt(sessionId, path, 'pdf-document attachment requires application/pdf mediaType')
  }
  return {
    id: raw.id as string,
    name: raw.name as string,
    size: raw.size,
    digest: raw.digest,
    path: raw.path as string,
    ...(raw.mediaType === undefined ? {} : { mediaType: raw.mediaType as string }),
    modelForm: raw.modelForm,
  }
}

function parseNativeFileBlock(raw: JsonObject, sessionId: string, path: string): NativeFileBlock {
  requireKnownKeys(raw, NATIVE_FILE_KEYS, 'native file block', sessionId, path)
  return { type: 'file', attachment: parseNativeAttachment(raw.attachment, sessionId, path) }
}

/** Native files are legal only in a user event's direct content or one level
 *  inside a tool_result. Other content blocks retain their existing opaque
 *  SDK-compatible shape. */
function parseUserContent(
  content: unknown[],
  version: number,
  sessionId: string,
  path: string,
): unknown[] {
  const parseFile = (block: JsonObject): NativeFileBlock => {
    if (version === NATIVE_SESSION_LOG_VERSION) {
      corrupt(sessionId, path, 'v1 user event cannot contain a structured file block')
    }
    return parseNativeFileBlock(block, sessionId, path)
  }
  const rejectDeeperFiles = (blocks: unknown[]): void => {
    for (const block of blocks) {
      if (!isObject(block)) continue
      if (block.type === 'file') {
        corrupt(sessionId, path, 'native file block exceeds the supported tool_result depth')
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) rejectDeeperFiles(block.content)
    }
  }
  const parseToolResultBlock = (block: unknown): unknown => {
    if (!isObject(block)) return block
    if (block.type === 'file') return parseFile(block)
    if (block.type === 'tool_result' && Array.isArray(block.content)) rejectDeeperFiles(block.content)
    return block
  }
  const parseDirectBlock = (block: unknown): unknown => {
    if (!isObject(block)) return block
    if (block.type === 'file') return parseFile(block)
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return { ...block, content: block.content.map(parseToolResultBlock) }
    }
    return block
  }
  return content.map(parseDirectBlock)
}

function parseAttachmentCatalog(
  raw: JsonObject,
  seq: number,
  version: number,
  sessionId: string,
  path: string,
): NativeAttachmentCatalogEvent {
  if (version === NATIVE_SESSION_LOG_VERSION) {
    corrupt(sessionId, path, 'v1 log cannot contain a session/attachments event')
  }
  requireKnownKeys(raw, ATTACHMENT_CATALOG_KEYS, 'session/attachments event', sessionId, path)
  if (!Array.isArray(raw.attachments)) {
    corrupt(sessionId, path, 'session/attachments event attachments must be an array')
  }
  return {
    seq,
    type: 'session/attachments',
    attachments: raw.attachments.map((attachment) => parseNativeAttachment(attachment, sessionId, path)),
    timestamp: requireNonEmptyString(raw, 'timestamp', sessionId, path),
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

export function parseHeaderLine(
  raw: unknown,
  sessionId: string,
  path: string,
  acceptedVersions: readonly number[] = SUPPORTED_NATIVE_SESSION_LOG_VERSIONS,
): NativeSessionHeader {
  if (!isObject(raw)) corrupt(sessionId, path, 'session header must be an object')
  if (raw.type !== 'session/header') corrupt(sessionId, path, `expected session/header, got '${String(raw.type)}'`)
  if (typeof raw.v !== 'number') corrupt(sessionId, path, 'session header v must be a number')
  if (!acceptedVersions.includes(raw.v)) {
    throw new NativeSessionStorageError(
      'unsupported-version',
      `unsupported session log version ${raw.v} (expected ${acceptedVersions.join(' or ')})`,
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
  version: number = NATIVE_SESSION_LOG_VERSION,
): NativeLogEvent {
  // v1/v2 legacy parser only. v3 lines are neutral NativeSessionEvents parsed
  // by `parseEventLineV3`; the host history read path projects them to SDK
  // lines through the adapter seam (T13 removed the transitional v3→legacy
  // dispatch that used to live here).
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
        message: {
          ...message,
          content: parseUserContent(message.content as unknown[], version, sessionId, path),
        } as unknown as NativeUserEvent['message'],
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
        event.usage = {
          input_tokens: raw.usage.input_tokens,
          output_tokens: raw.usage.output_tokens,
          ...(typeof raw.usage.cache_read_input_tokens === 'number' ? { cache_read_input_tokens: raw.usage.cache_read_input_tokens } : {}),
          ...(typeof raw.usage.cache_creation_input_tokens === 'number' ? { cache_creation_input_tokens: raw.usage.cache_creation_input_tokens } : {}),
        }
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
        body: requireNonEmptyString(raw, 'body', sessionId, path),
        timestamp: requireString(raw, 'timestamp', sessionId, path),
      }

    case 'session/attachments':
      return parseAttachmentCatalog(raw, seq, version, sessionId, path)

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

/** Lossless JSONL serialization for both the legacy v1/v2 event union and the
 *  neutral v3 NativeSessionEvent. JSON.stringify preserves every field of
 *  either shape verbatim (the round-trip contract). */
export function serializeEvent(event: NativeLogEvent | NativeSessionEvent): string {
  return JSON.stringify(event)
}

/** The v3 header line type (literal `v: 3`), owned by the neutral vocabulary. */
export type { NativeSessionHeader as NativeSessionHeaderV3 } from '../vocabulary/session-event.js'

// ── v3: the neutral durable event language ──────────────────────────────────
// v3 stores the vocabulary's NativeSessionEvent (envelope: seq/time/data, plus
// the sidechain parentToolUseId axis and an optional ignorable flag). The
// SessionEventMap keys are the durable counterparts of the v1/v2 union plus
// the log-only `session/title`, with tool results split into a first-class
// `tool/result` event. Live-only frames (init / api_retry / informational /
// task_* / result / stream_event) are NOT durable and never appear here
// (design R6).

/** Envelope keys every v3 event may carry. Anything else is corruption. */
const V3_ENVELOPE_KEYS = new Set(['seq', 'type', 'time', 'data', 'ignorable', 'parentToolUseId'])
/** Message events MUST carry parentToolUseId (null = main thread, string =
 *  sidechain). A missing field is corruption, not "null" — the same contract
 *  requireParentToolUseId enforces for v1/v2 (T5 carried pointer). */
const V3_MESSAGE_TYPES = new Set<keyof SessionEventMap>(['user/message', 'assistant/message', 'tool/result'])
const V3_EVENT_TYPES = new Set<keyof SessionEventMap>([
  'user/message', 'assistant/message', 'tool/result', 'session/context', 'turn/end',
  'session/end-seed', 'session/compact', 'session/supplement', 'session/skill',
  'subagent/descriptor', 'session/attachments', 'session/agent', 'session/title',
])
const V3_TITLE_DATA_KEYS = new Set(['title'])

function requireV3Parent(raw: JsonObject, type: keyof SessionEventMap, sessionId: string, path: string): string | null | undefined {
  const value = raw.parentToolUseId
  if (value === undefined) {
    if (V3_MESSAGE_TYPES.has(type)) {
      corrupt(sessionId, path, `${type} event parentToolUseId is required (null or a string)`)
    }
    return undefined
  }
  if (value === null) return null
  if (typeof value !== 'string') corrupt(sessionId, path, `${type} event parentToolUseId must be a string or null`)
  return value
}

function requireV3String(data: JsonObject, field: string, type: string, sessionId: string, path: string): string {
  const value = data[field]
  if (typeof value !== 'string') corrupt(sessionId, path, `${type} data.${field} must be a string`)
  return value
}

function requireV3NonEmptyString(data: JsonObject, field: string, type: string, sessionId: string, path: string): string {
  const value = requireV3String(data, field, type, sessionId, path)
  if (value.length === 0) corrupt(sessionId, path, `${type} data.${field} must be a non-empty string`)
  return value
}

function requireV3Message(data: JsonObject, role: string, type: string, sessionId: string, path: string): void {
  if (data.role !== role) corrupt(sessionId, path, `${type} data.role must be '${role}'`)
  requireV3String(data, 'id', type, sessionId, path)
  if (!Array.isArray(data.content)) corrupt(sessionId, path, `${type} data.content must be an array`)
  if (!isObject(data.source)) corrupt(sessionId, path, `${type} data.source must be an object`)
}

function requireV3Usage(value: unknown, type: string, sessionId: string, path: string): TokenUsage {
  if (!isObject(value)) corrupt(sessionId, path, `${type} data.usage must be an object`)
  if (typeof value.inputTokens !== 'number' || typeof value.outputTokens !== 'number') {
    corrupt(sessionId, path, `${type} data.usage must have numeric inputTokens and outputTokens`)
  }
  return value as unknown as TokenUsage
}

/** Validate one packed AssistantStreamRecord. Run records honor the inter-arrival
 *  convention dt[0] === 0 (chunk i lands at time0 + sum(dt[0..i])); texts/args
 *  align 1:1 with dt. The single-chunk `chunk` variant carries a StreamChunk
 *  verbatim at its absolute time. */
function requireV3StreamRecord(raw: unknown, sessionId: string, path: string): AssistantStreamRecord {
  if (!isObject(raw)) corrupt(sessionId, path, 'assistant stream record must be an object')
  const type = raw.type
  if (type === 'chunk') {
    if (typeof raw.time !== 'number') corrupt(sessionId, path, 'stream chunk record time must be a number')
    if (!isObject(raw.chunk) || typeof raw.chunk.type !== 'string') {
      corrupt(sessionId, path, 'stream chunk record chunk must be a StreamChunk object')
    }
    return raw as unknown as AssistantStreamRecord
  }
  if (type !== 'text-chunks' && type !== 'reasoning-chunks' && type !== 'tool-call-chunks') {
    corrupt(sessionId, path, `unknown assistant stream record type '${String(type)}'`)
  }
  if (typeof raw.time0 !== 'number') corrupt(sessionId, path, `${type} record time0 must be a number`)
  if (typeof raw.index !== 'number') corrupt(sessionId, path, `${type} record index must be a number`)
  if (!Array.isArray(raw.dt) || raw.dt.length === 0 || raw.dt.some((d) => typeof d !== 'number')) {
    corrupt(sessionId, path, `${type} record dt must be a non-empty array of numbers`)
  }
  if (raw.dt[0] !== 0) corrupt(sessionId, path, `${type} record dt[0] must be 0 (inter-arrival convention)`)
  const items = type === 'tool-call-chunks' ? raw.args : raw.texts
  if (!Array.isArray(items) || items.length !== raw.dt.length || items.some((t) => typeof t !== 'string')) {
    corrupt(sessionId, path, `${type} record ${type === 'tool-call-chunks' ? 'args' : 'texts'} must align 1:1 with dt`)
  }
  if (type === 'tool-call-chunks') {
    requireV3String(raw, 'id', type, sessionId, path)
    if (raw.name !== undefined && typeof raw.name !== 'string') {
      corrupt(sessionId, path, 'tool-call-chunks record name must be a string')
    }
  }
  return raw as unknown as AssistantStreamRecord
}

function parseV3AssistantMessage(data: JsonObject, sessionId: string, path: string): SessionEventMap['assistant/message'] {
  if (!isObject(data.message)) corrupt(sessionId, path, 'assistant/message data.message must be an object')
  requireV3Message(data.message, 'assistant', 'assistant/message', sessionId, path)
  if (!Array.isArray(data.stream)) corrupt(sessionId, path, 'assistant/message data.stream must be an array')
  const stream = data.stream.map((record) => requireV3StreamRecord(record, sessionId, path))
  const out: SessionEventMap['assistant/message'] = {
    message: data.message as unknown as AssistantMessage,
    stream,
  }
  if (data.usage !== undefined) out.usage = requireV3Usage(data.usage, 'assistant/message', sessionId, path)
  if (data.interrupted !== undefined) {
    if (data.interrupted !== true) corrupt(sessionId, path, 'assistant/message data.interrupted must be true')
    out.interrupted = true
  }
  if (data.rawStopReason !== undefined) {
    if (typeof data.rawStopReason !== 'string') corrupt(sessionId, path, 'assistant/message data.rawStopReason must be a string')
    out.rawStopReason = data.rawStopReason
  }
  if (data.meta !== undefined) out.meta = data.meta as SessionEventMap['assistant/message']['meta']
  return out
}

function parseV3ToolResult(data: JsonObject, sessionId: string, path: string): SessionEventMap['tool/result'] {
  if (!isObject(data.message)) corrupt(sessionId, path, 'tool/result data.message must be an object')
  requireV3Message(data.message, 'tool', 'tool/result', sessionId, path)
  requireV3String(data.message, 'toolCallId', 'tool/result', sessionId, path)
  const out: SessionEventMap['tool/result'] = { message: data.message as unknown as ToolResultMessage }
  if (data.error !== undefined) {
    if (!isObject(data.error)) corrupt(sessionId, path, 'tool/result data.error must be an object')
    requireV3String(data.error, 'name', 'tool/result error', sessionId, path)
    requireV3String(data.error, 'code', 'tool/result error', sessionId, path)
    if (data.error.reason !== undefined && typeof data.error.reason !== 'string') {
      corrupt(sessionId, path, 'tool/result data.error.reason must be a string')
    }
    out.error = data.error as { name: string; code: string; reason?: string }
  }
  if (data.meta !== undefined) out.meta = data.meta as SessionEventMap['tool/result']['meta']
  return out
}

/** Parse one v3 line into the canonical neutral NativeSessionEvent. Enforces
 *  contiguous seq, the parent null-vs-string contract on message events, and
 *  rejects unknown event types / envelope keys as corruption. */
export function parseEventLineV3(
  raw: unknown,
  expectedSeq: number,
  sessionId: string,
  path: string,
): NativeSessionEvent {
  if (!isObject(raw)) corrupt(sessionId, path, 'event must be an object')
  if (typeof raw.seq !== 'number') corrupt(sessionId, path, 'event seq must be a number')
  if (raw.seq !== expectedSeq) corrupt(sessionId, path, `event seq mismatch: expected ${expectedSeq}, got ${raw.seq}`)
  if (typeof raw.type !== 'string' || !V3_EVENT_TYPES.has(raw.type as keyof SessionEventMap)) {
    corrupt(sessionId, path, `unknown event type '${String(raw.type)}'`)
  }
  const type = raw.type as keyof SessionEventMap
  if (typeof raw.time !== 'number' || !Number.isFinite(raw.time)) {
    corrupt(sessionId, path, `${type} event time must be a finite number`)
  }
  if (!isObject(raw.data)) corrupt(sessionId, path, `${type} event data must be an object`)
  for (const key of Object.keys(raw)) {
    if (!V3_ENVELOPE_KEYS.has(key)) corrupt(sessionId, path, `${type} event has unknown field '${key}'`)
  }
  if (raw.ignorable !== undefined && raw.ignorable !== true) {
    corrupt(sessionId, path, `${type} event ignorable must be true`)
  }
  const parentToolUseId = requireV3Parent(raw, type, sessionId, path)
  const data = raw.data
  const envelope = {
    seq: raw.seq,
    time: raw.time,
    ...(raw.ignorable === true ? { ignorable: true as const } : {}),
    ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
  }

  switch (type) {
    case 'user/message':
      requireV3Message(data, 'user', type, sessionId, path)
      return { type, ...envelope, data: data as unknown as UserMessage } as NativeSessionEvent
    case 'assistant/message':
      return { type, ...envelope, data: parseV3AssistantMessage(data, sessionId, path) } as NativeSessionEvent
    case 'tool/result':
      return { type, ...envelope, data: parseV3ToolResult(data, sessionId, path) } as NativeSessionEvent
    case 'session/context':
      requireV3String(data, 'text', type, sessionId, path)
      return { type, ...envelope, data: { text: data.text as string } } as NativeSessionEvent
    case 'turn/end': {
      if (!TURN_END_REASONS.includes(data.reason as NativeTurnEndReason)) {
        corrupt(sessionId, path, `turn/end data.reason must be one of ${TURN_END_REASONS.join(', ')}`)
      }
      const payload: SessionEventMap['turn/end'] = { reason: data.reason as NativeTurnEndReason }
      if (data.usage !== undefined) payload.usage = requireV3Usage(data.usage, type, sessionId, path)
      return { type, ...envelope, data: payload } as NativeSessionEvent
    }
    case 'session/end-seed': {
      const payload: SessionEventMap['session/end-seed'] = {}
      if (data.inherited !== undefined) {
        if (data.inherited !== true) corrupt(sessionId, path, 'session/end-seed data.inherited must be true')
        payload.inherited = true
      }
      return { type, ...envelope, data: payload } as NativeSessionEvent
    }
    case 'session/compact':
      return {
        type, ...envelope,
        data: {
          text: requireV3NonEmptyString(data, 'text', type, sessionId, path),
          context: requireV3NonEmptyString(data, 'context', type, sessionId, path),
          uuid: requireV3NonEmptyString(data, 'uuid', type, sessionId, path),
          timestamp: requireV3NonEmptyString(data, 'timestamp', type, sessionId, path),
        },
      } as NativeSessionEvent
    case 'session/supplement':
      return {
        type, ...envelope,
        data: {
          uuid: requireV3NonEmptyString(data, 'uuid', type, sessionId, path),
          text: requireV3NonEmptyString(data, 'text', type, sessionId, path),
          timestamp: requireV3NonEmptyString(data, 'timestamp', type, sessionId, path),
        },
      } as NativeSessionEvent
    case 'session/skill':
      return {
        type, ...envelope,
        data: {
          name: requireV3String(data, 'name', type, sessionId, path),
          body: requireV3NonEmptyString(data, 'body', type, sessionId, path),
          timestamp: requireV3String(data, 'timestamp', type, sessionId, path),
        },
      } as NativeSessionEvent
    case 'subagent/descriptor': {
      // Reuse the strict v1/v2 descriptor validator (identical field rules).
      const legacy = parseSubagentDescriptor({ ...data, seq: raw.seq, type }, raw.seq, sessionId, path)
      return {
        type, ...envelope,
        data: {
          toolUseId: legacy.toolUseId, parentToolUseId: legacy.parentToolUseId, kind: legacy.kind,
          toolName: legacy.toolName, label: legacy.label, depth: legacy.depth,
          profile: legacy.profile, timestamp: legacy.timestamp,
        },
      } as NativeSessionEvent
    }
    case 'session/attachments': {
      const legacy = parseAttachmentCatalog({ ...data, seq: raw.seq, type }, raw.seq, NATIVE_SESSION_LOG_V2, sessionId, path)
      return { type, ...envelope, data: { attachments: legacy.attachments, timestamp: legacy.timestamp } } as NativeSessionEvent
    }
    case 'session/agent': {
      const legacy = parseAgentSelection({ ...data, seq: raw.seq, type }, raw.seq, sessionId, path)
      return {
        type, ...envelope,
        data: {
          name: legacy.name,
          ...(legacy.definition === undefined ? {} : { definition: legacy.definition }),
          base: legacy.base,
          ...(legacy.droppedAgent === undefined ? {} : { droppedAgent: legacy.droppedAgent }),
          timestamp: legacy.timestamp,
        },
      } as NativeSessionEvent
    }
    case 'session/title':
      requireKnownKeys(data, V3_TITLE_DATA_KEYS, 'session/title data', sessionId, path)
      return { type, ...envelope, data: { title: requireV3NonEmptyString(data, 'title', type, sessionId, path) } } as NativeSessionEvent
    default:
      return corrupt(sessionId, path, `unknown event type '${String(type)}'`)
  }
}

/** True when a neutral event carries facts only v3 can store losslessly (packed
 *  assistant stream records, a structured tool error / opaque meta, the
 *  inherited end-seed marker, an ignorable flag, or the log-only session/title).
 *  The v1/v2 compat projection drops the lossy facts and has no legacy shape for
 *  session/title (it throws); T12's eager-at-open migrateToV3 uses this detector
 *  to upgrade a log before such an event is appended. */
export function eventRequiresV3(event: NativeSessionEvent): boolean {
  if (event.ignorable === true) return true
  switch (event.type) {
    case 'assistant/message': return event.data.stream.length > 0 || event.data.interrupted === true
    case 'tool/result': return event.data.error !== undefined || event.data.meta !== undefined
    case 'session/end-seed': return event.data.inherited === true
    case 'session/title': return true
    default: return false
  }
}

// ── neutral → legacy projection (v1/v2 write compat + the SDK-line shape) ───
// A neutral event appended to a not-yet-migrated v1/v2 log is projected to the
// legacy event shape here (the session-log layer owns version compat — the CORE
// no longer projects). v3-only facts (stream records, tool error/meta) are
// dropped by this projection; the assistant stop_reason is reconstructed from
// the verbatim rawStopReason (or the packed finish record) so the legacy
// turn-boundary signal survives. This is also the lossless inverse the host
// adapter's history-read seam (projectNativeEventToSdkLine) reuses to project
// the three durable message events to SDK RawLines, and the migration
// round-trip pin's inverse. The core read consumers (usage / agent selection /
// attachment index / subagent catalog) read the canonical NEUTRAL events, not
// a projected legacy view (T6 read-side shrink).

function sdkUsageOf(usage: TokenUsage): NativeUsage & { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  }
}

function neutralAssistantBlockToSdk(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning':
      if (block.redacted === true) return { type: 'redacted_thinking', data: block.data }
      return {
        type: 'thinking',
        thinking: block.text,
        ...(typeof block.signature === 'string' && block.signature !== '' ? { signature: block.signature } : {}),
      }
    case 'tool-call': return { type: 'tool_use', id: block.id, name: block.name, input: parseToolInput(block.arguments) }
    default: throw new Error(`native v3 compat: block kind "${(block as { type: string }).type}" is not an assistant emission`)
  }
}

function neutralInputBlockToSdk(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text }
    case 'image': return 'attachment' in block ? { type: 'image', attachment: block.attachment } : { type: 'image', source: block.source }
    case 'file': return { type: 'file', attachment: block.attachment }
    default: throw new Error(`native v3 compat: block kind "${(block as { type: string }).type}" is not input content`)
  }
}

/** Reconstruct the legacy assistant stop_reason from the packed finish record.
 *  The neutral durable event carries the finish reason as a stream `chunk`
 *  (FinishReason), not a raw string; the common API reasons round-trip exactly
 *  (end_turn / tool_use / max_tokens). No finish record = an interrupted turn
 *  (null), matching the live AssistantFrame.stopReason. */
function stopReasonOfStream(stream: readonly AssistantStreamRecord[]): string | null {
  for (const record of stream) {
    if (record.type !== 'chunk') continue
    const chunk = record.chunk as { type?: unknown; reason?: { kind?: unknown } }
    if (chunk.type !== 'finish') continue
    switch (chunk.reason?.kind) {
      case 'tool-calls': return 'tool_use'
      case 'max-tokens': return 'max_tokens'
      case 'stop': return 'end_turn'
      default: return null
    }
  }
  return null
}

/** Project a neutral v3 event to the legacy v1/v2 NativeLogEvent shape. Used
 *  to write neutral appends into a not-yet-migrated v1/v2 log (the writer's
 *  v1/v2 write-compat), as the migration round-trip pin's inverse, and (for the
 *  three message events) by the host adapter's history-read seam as the SDK
 *  RawLine shape. It is NOT a live read view: core consumers read the canonical
 *  neutral events (T6 read-side shrink). `sessionId` stamps the legacy
 *  event-level session_id. */
export function projectNeutralEventToLegacy(event: NativeSessionEvent, sessionId: string): NativeLogEvent {
  const seq = event.seq
  const timestamp = new Date(event.time).toISOString()
  const parent = event.parentToolUseId ?? null
  switch (event.type) {
    case 'user/message':
      return {
        seq, type: 'user', uuid: event.data.id, session_id: sessionId,
        parent_tool_use_id: parent, timestamp,
        message: { role: 'user', content: event.data.content.map(neutralInputBlockToSdk) },
        ...(event.data.isCompactSummary === true ? { isCompactSummary: true as const } : {}),
      }
    case 'assistant/message': {
      const message = event.data.message
      // A migrated old log carries its ORIGINAL SDK message.id in meta — it is
      // independent of the event uuid (`msg_<M>`, M ≠ uuid). Reconstruct it
      // verbatim; a new neutral-core log (no meta) uses the `msg_<uuid>` convention.
      const legacyMessageId = (event.data.meta as { legacyMessageId?: unknown } | undefined)?.legacyMessageId
      return {
        seq, type: 'assistant', uuid: message.id, session_id: sessionId,
        parent_tool_use_id: parent, timestamp,
        message: {
          // `type` mirrors the live SDK assistant message (frames.ts / host
          // adapter) and the former core bridge, keeping the persisted line
          // byte-compatible.
          type: 'assistant',
          role: 'assistant',
          content: message.content.map(neutralAssistantBlockToSdk),
          id: typeof legacyMessageId === 'string' ? legacyMessageId : `msg_${message.id}`,
          model: message.source.model,
          // The verbatim raw stop reason wins when carried (migration preserves
          // rare API reasons the closed FinishReason union cannot express);
          // otherwise reconstruct from the packed finish record.
          stop_reason: event.data.rawStopReason ?? stopReasonOfStream(event.data.stream),
          ...(event.data.usage !== undefined ? { usage: sdkUsageOf(event.data.usage) } : {}),
        } as NativeAssistantEvent['message'],
      }
    }
    case 'tool/result': {
      const message = event.data.message
      // A migrated legacy tool_result whose content was a bare string carries
      // that verbatim form in meta (the neutral message content is block array);
      // reconstruct the string so the parsed legacy line is byte-identical.
      const legacyString = (event.data.meta as { legacyStringContent?: unknown } | undefined)?.legacyStringContent
      return {
        seq, type: 'user', uuid: message.id, session_id: sessionId,
        parent_tool_use_id: parent, timestamp,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: typeof legacyString === 'string' ? legacyString : message.content.map(neutralInputBlockToSdk),
            is_error: message.isError ?? false,
          }],
        },
      }
    }
    case 'session/context':
      return { seq, type: 'session/context', text: event.data.text }
    case 'turn/end':
      return {
        seq, type: 'turn/end', reason: event.data.reason,
        ...(event.data.usage !== undefined ? { usage: sdkUsageOf(event.data.usage) } : {}),
      }
    case 'session/end-seed':
      return { seq, type: 'session/end-seed' }
    case 'session/compact':
      return { seq, type: 'session/compact', ...event.data }
    case 'session/supplement':
      return { seq, type: 'session/supplement', ...event.data }
    case 'session/skill':
      return { seq, type: 'session/skill', ...event.data }
    case 'subagent/descriptor':
      return {
        seq, type: 'subagent/descriptor', ...event.data,
        toolName: event.data.toolName as NativeSubagentDescriptorEvent['toolName'],
      }
    case 'session/attachments':
      return { seq, type: 'session/attachments', ...event.data }
    case 'session/agent':
      return { seq, type: 'session/agent', ...event.data }
    default:
      throw new Error(`native v3 compat: unknown neutral event type '${(event as { type: string }).type}'`)
  }
}