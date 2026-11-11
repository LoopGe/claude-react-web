import type { StoredAgentDefinition } from '../../agent-definition-store.js'
import type { SessionToolProfile } from '../../../shared/tool-profile.js'
import type { NativeLogEvent } from './session-log/format.js'

export const NATIVE_AGENT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export interface NativeAgentProfile {
  name: string | null
  instruction?: string
  model?: StoredAgentDefinition['model']
  tools?: StoredAgentDefinition['tools']
  disallowedTools?: StoredAgentDefinition['disallowedTools']
  mcpServers?: StoredAgentDefinition['mcpServers']
  skills?: StoredAgentDefinition['skills']
  permissionMode?: StoredAgentDefinition['permissionMode']
  maxTurns?: StoredAgentDefinition['maxTurns']
  effort?: (typeof NATIVE_AGENT_EFFORT_LEVELS)[number]
}

export interface NativeAgentBase {
  model: string
  permissionMode: string
  effortLevel?: string
  skillPolicy?: readonly string[] | 'all'
  toolProfile?: SessionToolProfile
}

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
