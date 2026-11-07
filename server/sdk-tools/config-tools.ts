// Production registration of the three first-party config tool servers
// (`skills-tools`, `mcp-tools`, `marketplace-tools`).
//
// The servers themselves own only their tool surfaces; this module builds the
// hosts they call into — the live SessionManager (session-scoped MCP attach and
// skill reload) and the two global disk stores (MCP config, plugin
// marketplaces) — using the same mcp-ops / mp-ops operations the HTTP routes
// use, so the agent and the UI cannot drift apart.
//
// Host methods read `deps.*` at call time rather than capturing the underlying
// function or store at construction, so a host stays valid when a dependency
// is swapped after registration (tests do this; nothing in production does).
//
// Registration is idempotent by server name: `FirstPartyToolRegistry.register`
// throws on a duplicate, and bootstrap may run this more than once in a
// re-entered process.

import type { SessionManager } from '../session-manager.js'
import type { McpConfigStore } from '../mcp-config.js'
import type { MpStore } from '../mp-store.js'
import type { FirstPartyToolRegistry } from './registry.js'
import { maskSecrets, testMcpConnection } from '../mcp-config.js'
import {
  createMcpServer,
  removeMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
} from '../mcp-ops.js'
import {
  addMarketplaceByUrl,
  checkMarketplaceUpdates,
  listMarketplacePlugins,
  listMarketplaces,
  setMarketplacePluginEnabled,
} from '../mp-ops.js'
import { HttpError } from '../errors.js'
import { createSkillsTools, type SkillsToolsHost } from './skills-tools.js'
import { createMcpTools, type McpToolsHost } from './mcp-tools.js'
import { createMarketplaceTools, type MarketplaceToolsHost } from './marketplace-tools.js'

export interface ConfigToolsDeps {
  registry: FirstPartyToolRegistry
  sm: SessionManager
  mcpStore: McpConfigStore
  mpStore: MpStore
}

export function registerConfigToolServers(deps: ConfigToolsDeps): void {
  const skillsHost: SkillsToolsHost = {
    reloadSkillsForCwd: (cwd) => deps.sm.reloadSkillsForCwd(cwd),
  }

  const mcpHost: McpToolsHost = {
    list: () => deps.mcpStore.list().map(maskSecrets),
    get: (name) => {
      const server = deps.mcpStore.get(name)
      return server ? maskSecrets(server) : null
    },
    create: (input) => maskSecrets(createMcpServer(deps.mcpStore, input)),
    update: (name, input) => maskSecrets(updateMcpServer(deps.mcpStore, name, input)),
    remove: (name) => removeMcpServer(deps.mcpStore, name),
    setEnabled: (name, enabled) => maskSecrets(setMcpServerEnabled(deps.mcpStore, name, enabled)),
    attach: (sessionId, name) => deps.sm.attachGlobalMcpServer(sessionId, name),
    detach: (sessionId, name) => deps.sm.detachGlobalMcpServer(sessionId, name),
    test: async (name) => {
      const server = deps.mcpStore.get(name)
      if (!server) throw new HttpError(404, `MCP server "${name}" not found`)
      return testMcpConnection(server, { includeTools: true })
    },
  }

  const marketplaceHost: MarketplaceToolsHost = {
    list: () => listMarketplaces(deps.mpStore),
    plugins: (id) => listMarketplacePlugins(deps.mpStore, id),
    add: async (url, ref) => {
      const { entry, warnings } = await addMarketplaceByUrl(deps.mpStore, { url, ref })
      return {
        id: entry.id,
        displayName: entry.displayName,
        plugins: listMarketplacePlugins(deps.mpStore, entry.id),
        warnings,
      }
    },
    checkUpdates: () => checkMarketplaceUpdates(deps.mpStore),
    setPluginEnabled: (id, plugin, enabled) =>
      setMarketplacePluginEnabled(deps.mpStore, deps.sm, id, plugin, enabled),
  }

  for (const server of [
    createSkillsTools(skillsHost),
    createMcpTools(mcpHost),
    createMarketplaceTools(marketplaceHost),
  ]) {
    if (deps.registry.get(server.name) !== undefined) continue
    deps.registry.register(server)
  }
}