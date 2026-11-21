// Neutral agent-profile vocabulary for the native provider core: the pure
// types describing a delegated run's profile (subagent/descriptor) and the
// session's agent selection base (session/agent). Imports ONLY neutral
// shared/* refs — zero SDK or host-domain imports (the neutrality pin in
// ../host-free.test.ts covers this directory). Relocated from
// ../agent-profile.ts (which imports the host agent-definition store) per the
// vocabulary purity ruling; that module re-exports these types for
// compatibility and keeps its runtime (NATIVE_AGENT_EFFORT_LEVELS, profile
// helpers). The effort union is pinned against that runtime const there.

import type { StoredAgentDefinition } from '../../../../shared/agent-definitions.js'
import type { SessionToolProfile } from '../../../../shared/tool-profile.js'

/** Named reasoning-effort levels a native agent profile may carry. The
 *  runtime validation list (NATIVE_AGENT_EFFORT_LEVELS in ../agent-profile.ts)
 *  is compile-time lockstepped to this union in both directions. */
export type NativeAgentEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  effort?: NativeAgentEffortLevel
}

export interface NativeAgentBase {
  model: string
  permissionMode: string
  effortLevel?: string
  skillPolicy?: readonly string[] | 'all'
  toolProfile?: SessionToolProfile
}
