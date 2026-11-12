// Pure subagent-catalog projection over native log events. The public catalog
// carries the recoverable identity/metadata; a non-enumerable fold state lets
// append-only cache entries incorporate late sidechain evidence and origins
// without retaining or reparsing the renderable transcript.

import type { NativeAgentProfile } from '../agent-profile.js'
import { NativeSessionStorageError } from './errors.js'
import type {
  NativeAssistantEvent,
  NativeLogEvent,
  NativeSubagentDescriptorEvent,
} from './format.js'

export interface NativeSubagentCatalogEntry {
  agentId: string
  parentToolUseId: string | null
  toolName: NativeSubagentDescriptorEvent['toolName']
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

type SubagentToolName = NativeSubagentDescriptorEvent['toolName']

interface OriginRecord {
  agentId: string
  parentToolUseId: string | null
  toolName: SubagentToolName
  label: string
  prompt?: string
  timestamp: string
  sessionId: string
  seq: number
  blockIndex: number
}

interface FoldState {
  origins: Map<string, OriginRecord>
  descriptors: Map<string, NativeSubagentDescriptorEvent>
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

function emptyState(): FoldState {
  return { origins: new Map(), descriptors: new Map(), evidence: new Set() }
}

function copyState(state: FoldState): FoldState {
  return {
    origins: new Map(state.origins),
    descriptors: new Map(state.descriptors),
    evidence: new Set(state.evidence),
  }
}

function readOrigin(event: NativeAssistantEvent, block: Record<string, unknown>, blockIndex: number): OriginRecord | null {
  if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') {
    return null
  }
  if (!SUBAGENT_TOOL_NAMES.has(block.name as SubagentToolName)) return null
  const input = isObject(block.input) ? block.input : undefined
  const description = typeof input?.description === 'string' ? input.description.trim() : ''
  return {
    agentId: block.id,
    parentToolUseId: event.parent_tool_use_id,
    toolName: block.name as SubagentToolName,
    label: description || 'Subagent',
    ...(typeof input?.prompt === 'string' ? { prompt: input.prompt } : {}),
    timestamp: event.timestamp,
    sessionId: event.session_id,
    seq: event.seq,
    blockIndex,
  }
}

function foldEvents(state: FoldState, events: readonly NativeLogEvent[]): void {
  for (const event of events) {
    if (event.type === 'subagent/descriptor') {
      state.descriptors.set(event.toolUseId, event)
      continue
    }
    if (event.type !== 'user' && event.type !== 'assistant') continue
    if (event.parent_tool_use_id !== null) state.evidence.add(event.parent_tool_use_id)
    if (event.type !== 'assistant') continue
    for (const [blockIndex, value] of event.message.content.entries()) {
      if (!isObject(value)) continue
      const origin = readOrigin(event, value, blockIndex)
      if (origin) state.origins.set(origin.agentId, origin)
    }
  }
}

function assertMatchingOrigin(
  descriptor: NativeSubagentDescriptorEvent,
  origin: OriginRecord | undefined,
): void {
  if (!origin || origin.toolName === descriptor.toolName) return
  // The pure projection has the originating session id but not the log path.
  throw new NativeSessionStorageError(
    'corrupt',
    `subagent descriptor toolName mismatch for ${descriptor.toolUseId}: ` +
      `descriptor is ${descriptor.toolName}, originating tool_use is ${origin.toolName}`,
    origin.sessionId,
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
    const origin = state.origins.get(descriptor.toolUseId)
    assertMatchingOrigin(descriptor, origin)
    ordered.push({
      seq: descriptor.seq,
      blockIndex: 0,
      entry: {
        agentId: descriptor.toolUseId,
        parentToolUseId: descriptor.parentToolUseId,
        toolName: descriptor.toolName,
        label: descriptor.label,
        depth: descriptor.depth,
        profile: descriptor.profile,
        metadataComplete: true,
        ...(origin?.prompt !== undefined ? { prompt: origin.prompt } : {}),
        timestamp: descriptor.timestamp,
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
  events: readonly NativeLogEvent[],
): NativeSubagentCatalog {
  const state = emptyState()
  foldEvents(state, events)
  return materialize(state)
}

export function extendNativeSubagentCatalog(
  previous: NativeSubagentCatalog,
  appended: readonly NativeLogEvent[],
): NativeSubagentCatalog {
  const state = copyState((previous as StatefulCatalog)[CATALOG_STATE])
  foldEvents(state, appended)
  return materialize(state)
}
