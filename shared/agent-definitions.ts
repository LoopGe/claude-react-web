// Agent-definition vocabulary. Permission modes are re-exported from
// shared/permission-modes.ts (the canonical list) so the agent form and the
// session pickers cannot diverge.

import type { SdkAgentPermissionMode } from './permission-modes.js'

export {
  USER_SELECTABLE_PERMISSION_MODES as SDK_AGENT_PERMISSION_MODES,
  isUserSelectablePermissionMode as isSdkAgentPermissionMode,
  permissionModeList,
  type SdkAgentPermissionMode,
} from './permission-modes.js'

/**
 * Historical value this host used to accept by mistake on agent definitions.
 * Load-time migration strips it (never drops the whole agent) so old on-disk
 * definitions keep working with the session default permission mode.
 *
 * `'disabled'` was never an SDK PermissionMode — the app-level on/off switch
 * is the separate `enabled` boolean on StoredAgentDefinition.
 */
export const LEGACY_INVALID_PERMISSION_MODE = 'disabled'

/** Fields that make up an SDK AgentDefinition, in Options.agents payload shape. */
export const AGENT_FIELDS = [
  'description', 'prompt', 'tools', 'disallowedTools', 'model', 'mcpServers',
  'skills', 'memory', 'effort', 'permissionMode', 'maxTurns', 'background',
  'initialPrompt', 'observer', 'observerMessage', 'criticalSystemReminder_EXPERIMENTAL',
  'omitClaudeMd',
] as const

export type AgentField = (typeof AGENT_FIELDS)[number]

/** The read slice of an agent-definition store that `agentUnusableReason`
 *  consults. Structural so this neutral module never imports the host store
 *  class; the host store (and any injected lookup) satisfies it as-is. */
export interface AgentDefinitionLookup {
  get(name: string): { enabled?: boolean } | undefined
  has(name: string): boolean
}

/** Why `name` can't be used as a main-thread agent, or null when it can.
 *
 *  Both write edges that accept an agent NAME share this: `POST /sessions`
 *  (start-as, → `Options.agent`) and `POST /sessions/:id/agent` (mid-session
 *  switch, → `applyFlagSettings({ agent })`). Only ENABLED definitions pass —
 *  a disabled or unknown name would leave the CLI resolving an agent that
 *  isn't in the spawn's `Options.agents`, so we reject rather than spin the
 *  session under a persona we can't honour. A missing store rejects every
 *  name for the same reason.
 *
 *  Returns a reason STRING rather than throwing so each caller maps it to its
 *  own transport (a Hono 400 at the route, an HttpError in the manager)
 *  without this module knowing about HTTP. */
export function agentUnusableReason(
  store: AgentDefinitionLookup | undefined,
  name: string,
): string | null {
  if (store?.get(name)?.enabled === true) return null
  const why = store?.has(name) ? 'is disabled' : 'is not defined'
  return `agent "${name}" ${why}`
}

/** Neutral structural mirror of the SDK's per-tool MCP permission policy
 *  (`McpServerToolPolicy`). Kept field-identical so the stored-definition
 *  mirror below stays assignable to the SDK `AgentDefinition` in both
 *  directions; the host store pins that lockstep at compile time. */
export interface AgentMcpToolPolicy {
  name: string
  permission_policy?: 'always_allow' | 'always_ask' | 'always_deny'
  org_max_permission?: 'allow' | 'ask' | 'blocked'
}

/** Neutral structural mirror of the SDK's serializable MCP server configs
 *  (`McpServerConfigForProcessTransport` = stdio | sse | http | sdk, WITHOUT
 *  the live-instance variant). Field-identical for the same lockstep reason
 *  as AgentMcpToolPolicy. */
export type AgentMcpProcessServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; timeout?: number; alwaysLoad?: boolean }
  | { type: 'sse'; url: string; headers?: Record<string, string>; tools?: AgentMcpToolPolicy[]; timeout?: number; alwaysLoad?: boolean }
  | { type: 'http'; url: string; headers?: Record<string, string>; tools?: AgentMcpToolPolicy[]; timeout?: number; alwaysLoad?: boolean }
  | { type: 'sdk'; name: string; timeout?: number; tools?: AgentMcpToolPolicy[] }

/** Neutral structural mirror of the SDK's `AgentMcpServerSpec`: a server
 *  name (resolved against the global MCP config at spawn) or an inline
 *  name→config map. */
export type AgentMcpServerSpec = string | Record<string, AgentMcpProcessServerConfig>

/** A stored agent definition: the SDK `AgentDefinition` field surface plus
 *  app bookkeeping, expressed WITHOUT the SDK import so host-free code (the
 *  native vocabulary, the session log) can speak it. The host store
 *  (server/agent-definition-store.ts) re-exports this type as its canonical
 *  `StoredAgentDefinition` and pins compile-time lockstep with the SDK
 *  `AgentDefinition` (mutual assignability + key-set equality), so an SDK
 *  field change fails typecheck here instead of silently drifting.
 *  `permissionMode` uses the canonical SdkAgentPermissionMode union (itself
 *  SDK-lockstepped in shared/permission-modes.ts). */
export interface StoredAgentDefinition {
  name: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  mcpServers?: AgentMcpServerSpec[]
  criticalSystemReminder_EXPERIMENTAL?: string
  skills?: string[]
  initialPrompt?: string
  maxTurns?: number
  autoCompactWindow?: number
  background?: boolean
  omitClaudeMd?: boolean
  memory?: 'user' | 'project' | 'local'
  effort?: ('low' | 'medium' | 'high' | 'xhigh' | 'max') | number
  permissionMode?: SdkAgentPermissionMode
  observer?: string
  observerMessage?: string
}
