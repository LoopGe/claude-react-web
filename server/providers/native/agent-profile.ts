import type { StoredAgentDefinition } from '../../agent-definition-store.js'
import type { NativeLogEvent } from './session-log/format.js'
import type { NativeAgentBase, NativeAgentEffortLevel, NativeAgentProfile } from './vocabulary/agent-profile.js'

// The pure profile types live in the neutral vocabulary (host-free) so the
// durable SessionEvent language can speak them without a host import; this
// module re-exports them so existing consumers keep their import path.
export type { NativeAgentBase, NativeAgentProfile, NativeAgentEffortLevel } from './vocabulary/agent-profile.js'

export const NATIVE_AGENT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly NativeAgentEffortLevel[]

// Reverse lockstep: every level the neutral vocabulary may persist must be
// accepted by the runtime validation list above (the `satisfies` covers the
// other direction), so the parser and the vocabulary cannot diverge.
// Type-only pin; exported so it is a used declaration (drift breaks the
// Assert constraint here, loudly).
type Assert<T extends true> = T
export type NativeAgentEffortLevelsCovered = Assert<
  NativeAgentEffortLevel extends (typeof NATIVE_AGENT_EFFORT_LEVELS)[number] ? true : false
>

/** History-only state: the agent and base configuration used to restore the
 *  next turn. It is deliberately not a model or transcript message. */
export interface NativeAgentSelectionEvent {
  seq: number
  type: 'session/agent'
  name: string | null
  definition?: StoredAgentDefinition
  base: NativeAgentBase
  droppedAgent?: {
    name: string
    unsupportedFields: string[]
  }
  timestamp: string
}

const UNSUPPORTED_FIELDS = [
  'background',
  'initialPrompt',
  'memory',
  'observer',
  'observerMessage',
  'criticalSystemReminder_EXPERIMENTAL',
  'omitClaudeMd',
] as const

const SUPPORTED_FIELDS = 'prompt, model, tools, disallowedTools, mcpServers, skills, permissionMode, maxTurns, effort (string)'

export function unsupportedAgentFields(def: StoredAgentDefinition): string[] {
  const fields = UNSUPPORTED_FIELDS.filter((field) => def[field] !== undefined) as string[]
  if (typeof def.effort === 'number') fields.push('effort')
  return fields
}

export function assertAgentProfileSupported(def: StoredAgentDefinition): void {
  const fields = unsupportedAgentFields(def)
  if (fields.length === 0) return
  throw new Error(
    `agent "${def.name}" has fields unsupported by the native provider: ${fields.join(', ')}. ` +
      `Supported fields: ${SUPPORTED_FIELDS}`,
  )
}

export function profileFromDefinition(def: StoredAgentDefinition): NativeAgentProfile {
  assertAgentProfileSupported(def)
  return {
    name: def.name,
    instruction: def.prompt,
    ...(def.model !== undefined ? { model: def.model } : {}),
    ...(def.tools !== undefined ? { tools: [...def.tools] } : {}),
    ...(def.disallowedTools !== undefined ? { disallowedTools: [...def.disallowedTools] } : {}),
    ...(def.mcpServers !== undefined ? { mcpServers: [...def.mcpServers] } : {}),
    ...(def.skills !== undefined ? { skills: [...def.skills] } : {}),
    ...(def.permissionMode !== undefined ? { permissionMode: def.permissionMode } : {}),
    ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
    ...(typeof def.effort === 'string' ? { effort: def.effort } : {}),
  }
}

/** Compact bounds conversation messages, not session configuration, so the
 *  latest selection is found across the entire event stream. */
export function agentSelectionFromEvents(
  events: readonly NativeLogEvent[],
): NativeAgentSelectionEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'session/agent') return event
  }
  return undefined
}
