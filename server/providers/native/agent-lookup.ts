// Merged read-only agent lookup (plugin parity T3).
//
// The native Agent tool and the main-thread persona path resolve agent names
// against ONE surface: the user's persisted AgentDefinitionStore plus the
// enabled plugins' agents. Plugin agents are plugin-qualified (`plugin:agent`,
// the loader's bare name may itself be multi-segment); a user definition wins
// any bare-name collision. The lookup is strictly READ-ONLY — resolution never
// upserts into the user store, so plugin agents never pollute
// agent-definitions.json.
//
// Host-free: the user store arrives as a structural read surface (the concrete
// AgentDefinitionStore satisfies it as-is), and plugin defs arrive already
// coerced + qualified from the host loader via the session's reload commit. The
// lookup reads the CURRENT plugin defs per call, so a reload reaches the next
// subagent dispatch without a respawn.

import type { StoredAgentDefinition } from '../../../shared/agent-definitions.js'
import type { PluginContributions } from './ports.js'

/** An enabled definition in the SDK `Options.agents` payload shape: the stored
 *  definition minus app bookkeeping. Expressed neutrally (no SDK import) — the
 *  host store pins compile-time lockstep between this shape and AgentDefinition. */
export type EnabledAgentDefinition = Omit<StoredAgentDefinition, 'name' | 'enabled' | 'createdAt' | 'updatedAt'>

/** The read slice of the user store the lookup wraps. Structural so the neutral
 *  core never imports the host store class; AgentDefinitionStore satisfies it
 *  as-is, and `agentUnusableReason`'s {get, has} contract is a subset. */
export interface AgentStoreReadSurface {
  get(name: string): StoredAgentDefinition | undefined
  has(name: string): boolean
  list(): StoredAgentDefinition[]
  getEnabledDefinitions(): Record<string, EnabledAgentDefinition>
}

/** Strip app bookkeeping → the enabled-definition shape. The single owner of
 *  the strip, shared by the lookup's union and the session's /agents listing. */
export function enabledAgentDefinition(def: StoredAgentDefinition): EnabledAgentDefinition {
  const { name: _n, enabled: _e, createdAt: _c, updatedAt: _u, ...rest } = def
  return rest
}

/** Project host-resolved plugin contributions into qualified stored definitions.
 *  Each agent is qualified `${pluginName}:${def.name}` (the loader's bare name
 *  may already be subdir-namespaced, so the qualified name can carry several
 *  `:`). The source def is copied, never mutated. A same-qualified-name collision
 *  across plugins is first-wins, mirroring the command catalog's dedupe; rows
 *  sort by qualified name for a deterministic listing. Coercion against the
 *  closed field set is the loader's contract (already applied upstream). */
export function pluginAgentDefs(contributions: readonly PluginContributions[]): StoredAgentDefinition[] {
  const byName = new Map<string, StoredAgentDefinition>()
  for (const contribution of contributions) {
    for (const def of contribution.agents) {
      const name = `${contribution.name}:${def.name}`
      if (!byName.has(name)) byName.set(name, { ...def, name })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The merged read-only resolution surface. `pluginDefs` is a LIVE getter over
 *  the session's current qualified plugin definitions (replaced wholesale on
 *  each command reload), so every read observes the latest committed snapshot. */
export class PluginAgentLookup implements AgentStoreReadSurface {
  constructor(
    private readonly userStore: AgentStoreReadSurface | undefined,
    private readonly pluginDefs: () => readonly StoredAgentDefinition[],
  ) {}

  /** User store first (bare names win), then the plugin-qualified set. */
  get(name: string): StoredAgentDefinition | undefined {
    const user = this.userStore?.get(name)
    if (user) return user
    return this.pluginDefs().find((def) => def.name === name)
  }

  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  /** User defs (all, including disabled) plus plugin defs whose qualified name
   *  is not already a user name — user-wins on a literal key collision. */
  list(): StoredAgentDefinition[] {
    const userDefs = this.userStore?.list() ?? []
    const userNames = new Set(userDefs.map((def) => def.name))
    return [...userDefs, ...this.pluginDefs().filter((def) => !userNames.has(def.name))]
  }

  /** Enabled user defs ∪ enabled plugin defs (bookkeeping stripped, plugin keys
   *  qualified). A user definition wins a key collision; disabled defs on either
   *  side are excluded. */
  getEnabledDefinitions(): Record<string, EnabledAgentDefinition> {
    const out: Record<string, EnabledAgentDefinition> = { ...this.userStore?.getEnabledDefinitions() }
    for (const def of this.pluginDefs()) {
      if (!def.enabled || def.name in out) continue
      out[def.name] = enabledAgentDefinition(def)
    }
    return out
  }
}