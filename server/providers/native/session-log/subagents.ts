// Pure subagent-catalog projection over NEUTRAL v3 native log events (T15).
// The public catalog carries the recoverable identity/metadata; a non-enumerable
// fold state lets append-only cache entries incorporate late sidechain evidence
// and origins without retaining or reparsing the renderable transcript.
//
// The fold reads the neutral vocabulary natively: assistant origins are
// `assistant/message` events whose tool-call blocks carry RAW-JSON arguments
// (parsed here for the description/prompt), sidechain evidence is any message
// event (`user/message` / `assistant/message` / `tool/result`) with a non-null
// envelope parent, and a descriptor is a `subagent/descriptor` event whose
// identity rides `data`. Neutral events carry no session_id, so the originating
// session id is supplied once at build time for the corruption diagnostics.

import type { NativeAgentProfile } from '../agent-profile.js'
import type { NativeSessionEvent, SessionEvent } from '../vocabulary/session-event.js'
import { parseToolInput } from '../vocabulary/types.js'
import { NativeSessionStorageError } from './errors.js'

/** The admitted launching-tool names (the v3 descriptor parser validates the
 *  same set). The neutral descriptor payload types `toolName` as a plain string;
 *  the catalog narrows it to this closed union once validated. */
type SubagentToolName = 'Agent' | 'Task' | 'Explore'

export interface NativeSubagentCatalogEntry {
  agentId: string
  parentToolUseId: string | null
  toolName: SubagentToolName
  label: string
  depth: number
  profile: NativeAgentProfile | null
  metadataComplete: boolean
  /** Originating tool_use input, retained for standalone prompt projection. */
  prompt?: string
  timestamp: string
}

export interface NativeSubagentCatalog {
  entries: readonly NativeSubagentCatalogEntry[]
  byId: ReadonlyMap<string, NativeSubagentCatalogEntry>
}

interface OriginRecord {
  agentId: string
  parentToolUseId: string | null
  toolName: SubagentToolName
  label: string
  prompt?: string
  timestamp: string
  seq: number
  blockIndex: number
}

interface ToolUseRecord {
  agentId: string
  toolName: string
}

interface FoldState {
  sessionId: string
  origins: Map<string, OriginRecord>
  toolUses: Map<string, ToolUseRecord>
  descriptors: Map<string, SessionEvent<'subagent/descriptor'>>
  evidence: Set<string>
}

const CATALOG_STATE = Symbol('nativeSubagentCatalogState')
const SUBAGENT_TOOL_NAMES = new Set<SubagentToolName>(['Agent', 'Task', 'Explore'])

type StatefulCatalog = NativeSubagentCatalog & {
  readonly [CATALOG_STATE]: FoldState
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyState(sessionId: string): FoldState {
  return { sessionId, origins: new Map(), toolUses: new Map(), descriptors: new Map(), evidence: new Set() }
}

function copyState(state: FoldState): FoldState {
  return {
    sessionId: state.sessionId,
    origins: new Map(state.origins),
    toolUses: new Map(state.toolUses),
    descriptors: new Map(state.descriptors),
    evidence: new Set(state.evidence),
  }
}

function readToolUse(block: Record<string, unknown>): ToolUseRecord | null {
  if (block.type !== 'tool-call' || typeof block.id !== 'string' || typeof block.name !== 'string') {
    return null
  }
  return { agentId: block.id, toolName: block.name }
}

function readOrigin(
  event: SessionEvent<'assistant/message'>,
  block: Record<string, unknown>,
  blockIndex: number,
): OriginRecord | null {
  if (block.type !== 'tool-call' || typeof block.id !== 'string' || typeof block.name !== 'string') {
    return null
  }
  if (!SUBAGENT_TOOL_NAMES.has(block.name as SubagentToolName)) return null
  const input = parseToolInput(typeof block.arguments === 'string' ? block.arguments : '')
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  return {
    agentId: block.id,
    parentToolUseId: event.parentToolUseId ?? null,
    toolName: block.name as SubagentToolName,
    label: description || 'Subagent',
    ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    timestamp: new Date(event.time).toISOString(),
    seq: event.seq,
    blockIndex,
  }
}

function foldEvents(state: FoldState, events: readonly NativeSessionEvent[]): void {
  for (const event of events) {
    if (event.type === 'subagent/descriptor') {
      state.descriptors.set(event.data.toolUseId, event)
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    if (event.parentToolUseId != null) state.evidence.add(event.parentToolUseId)
    if (event.type !== 'assistant/message') continue
    for (const [blockIndex, value] of event.data.message.content.entries()) {
      if (!isObject(value)) continue
      const toolUse = readToolUse(value)
      if (toolUse) state.toolUses.set(toolUse.agentId, toolUse)
      const origin = readOrigin(event, value, blockIndex)
      if (origin) state.origins.set(origin.agentId, origin)
    }
  }
}

function assertMatchingToolUse(
  state: FoldState,
  descriptor: SessionEvent<'subagent/descriptor'>,
  toolUse: ToolUseRecord | undefined,
): void {
  if (!toolUse || toolUse.toolName === descriptor.data.toolName) return
  // The pure projection has the originating session id but not the log path.
  throw new NativeSessionStorageError(
    'corrupt',
    `subagent descriptor toolName mismatch for ${descriptor.data.toolUseId}: ` +
      `descriptor is ${descriptor.data.toolName}, originating tool_use is ${toolUse.toolName}`,
    state.sessionId,
    '',
  )
}

/** Resolve the complete chain on every call. A missing link or a revisit makes
 *  the depth unknowable, so the entry falls back to 1 instead of treating a
 *  partial chain as evidence of a deeper nesting level. */
function legacyDepth(agentId: string, origins: ReadonlyMap<string, OriginRecord>): number {
  const seen = new Set<string>()
  let current = agentId
  let depth = 1
  while (!seen.has(current)) {
    seen.add(current)
    const origin = origins.get(current)
    if (!origin) return 1
    if (origin.parentToolUseId === null) return depth
    depth++
    current = origin.parentToolUseId
  }
  return 1
}

interface OrderedEntry {
  entry: NativeSubagentCatalogEntry
  seq: number
  blockIndex: number
}

function materialize(state: FoldState): NativeSubagentCatalog {
  const ordered: OrderedEntry[] = []
  for (const descriptor of state.descriptors.values()) {
    const origin = state.origins.get(descriptor.data.toolUseId)
    assertMatchingToolUse(state, descriptor, state.toolUses.get(descriptor.data.toolUseId))
    ordered.push({
      seq: descriptor.seq,
      blockIndex: 0,
      entry: {
        agentId: descriptor.data.toolUseId,
        parentToolUseId: descriptor.data.parentToolUseId,
        toolName: descriptor.data.toolName as SubagentToolName,
        label: descriptor.data.label,
        depth: descriptor.data.depth,
        profile: descriptor.data.profile,
        metadataComplete: true,
        ...(origin?.prompt !== undefined ? { prompt: origin.prompt } : {}),
        timestamp: descriptor.data.timestamp,
      },
    })
  }
  for (const origin of state.origins.values()) {
    if (state.descriptors.has(origin.agentId) || !state.evidence.has(origin.agentId)) continue
    ordered.push({
      seq: origin.seq,
      blockIndex: origin.blockIndex,
      entry: {
        agentId: origin.agentId,
        parentToolUseId: origin.parentToolUseId,
        toolName: origin.toolName,
        label: origin.label,
        depth: legacyDepth(origin.agentId, state.origins),
        profile: null,
        metadataComplete: false,
        ...(origin.prompt !== undefined ? { prompt: origin.prompt } : {}),
        timestamp: origin.timestamp,
      },
    })
  }
  ordered.sort((a, b) =>
    a.seq - b.seq || a.blockIndex - b.blockIndex || a.entry.agentId.localeCompare(b.entry.agentId))

  const entries = ordered.map(({ entry }) => entry)
  const byId = new Map(entries.map((entry) => [entry.agentId, entry]))
  const catalog = { entries, byId } satisfies NativeSubagentCatalog
  Object.defineProperty(catalog, CATALOG_STATE, { value: state, enumerable: false })
  return catalog
}

export function buildNativeSubagentCatalog(
  events: readonly NativeSessionEvent[],
  sessionId: string,
): NativeSubagentCatalog {
  const state = emptyState(sessionId)
  foldEvents(state, events)
  return materialize(state)
}

export function extendNativeSubagentCatalog(
  previous: NativeSubagentCatalog,
  appended: readonly NativeSessionEvent[],
): NativeSubagentCatalog {
  const state = copyState((previous as StatefulCatalog)[CATALOG_STATE])
  foldEvents(state, appended)
  return materialize(state)
}
