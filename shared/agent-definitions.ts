// Agent-definition vocabulary. Permission modes are re-exported from
// shared/permission-modes.ts (the canonical list) so the agent form and the
// session pickers cannot diverge.

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
