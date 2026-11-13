// First-party `marketplace-tools` in-process MCP server (SDK createSdkMcpServer).
//
// Exposes the Claude Plugin Marketplace (the git-repo marketplace, `mp-store`)
// to the agent as `mcp__marketplace-tools__*`: list marketplaces, list a
// marketplace's plugins, add a marketplace by URL, check upstream updates,
// enable/disable a plugin and hard-remove a marketplace. The host owns the
// store, the clone/parse/refresh/remove semantics (`mp-ops`) and the DTO
// shapes, so this module holds no policy of its own — it only shapes the tool
// surface and the read-only set.
//
// `add` clones and parses a repo; `set_plugin_enabled` writes the enabled
// map; `remove` drops the whole entry and is refused without an explicit
// `confirm: true` (same gate as the REST DELETE route). A host failure
// (rejected URL, unknown marketplace/plugin, parse error) arrives as a
// rejected promise and `guard` turns it into the `isError` text result the
// model reads, never a rejected MCP call.

import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { FirstPartyToolServer } from './types.js'
import { guard, json } from './call-result.js'
import type { MpListItem, MpUpdateStatusItem, PluginListItem } from '../mp-ops.js'

/** Server name — tool FQN is `mcp__marketplace-tools__{name}`. */
export const MARKETPLACE_TOOLS_SERVER_NAME = 'marketplace-tools'

/** Bare read-only tool names — permission-broker exemption via the registry.
 *  `add` and `set_plugin_enabled` are absent: they clone and write. */
export const MARKETPLACE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['list', 'plugins', 'check_updates'])

/** What a successful `add` reports back: the new marketplace's identity, its
 *  plugins and any manifest parse warnings (a plugin that could not be read). */
export interface MarketplaceAddResult {
  id: string
  displayName: string
  plugins: PluginListItem[]
  warnings: Array<{ kind: string; detail: string }>
}

/** Structural slice of the host the marketplace tools need — declared locally
 *  so this module stays free of stores and session internals and tests can
 *  pass a fake. */
export interface MarketplaceToolsHost {
  list(): MpListItem[]
  plugins(id: string): PluginListItem[]
  add(url: string, ref?: string): Promise<MarketplaceAddResult>
  checkUpdates(): Promise<MpUpdateStatusItem[]>
  setPluginEnabled(id: string, plugin: string, enabled: boolean): Promise<PluginListItem>
  remove(id: string): Promise<void>
}

/** The tool definitions for the marketplace-tools server bound to the host.
 *  Exported separately from the server builder so tests can assert the tool
 *  set / annotations and invoke handlers without owning an McpServer. */
export function buildMarketplaceTools(host: MarketplaceToolsHost): SdkMcpToolDefinition<any>[] {
  const readOnly = { readOnlyHint: true }

  return [
    tool(
      'list',
      "List the installed plugin marketplaces with their source URL, plugin counts and last-refreshed metadata. Enabling a plugin IS installing it, so enabledCount is how many of the marketplace's plugins are installed.",
      {},
      async () => guard(async () => json({ marketplaces: host.list() })),
      { annotations: readOnly },
    ),
    tool(
      'plugins',
      "List one marketplace's plugins with their description, version, author, category, tags and whether each is enabled (installed). id is the marketplace id from list.",
      { id: z.string().describe('marketplace id (from list)') },
      async (a) => guard(async () => json({ plugins: host.plugins(a.id) })),
      { annotations: readOnly },
    ),
    tool(
      'add',
      'Install a plugin marketplace by cloning its git repository and parsing the manifest. url must be an HTTPS git URL; ref is an optional branch/tag. Returns the new marketplace id, its plugins and any manifest parse warnings.',
      {
        url: z.string().describe('HTTPS git URL of the marketplace repo'),
        ref: z.string().optional().describe('branch or tag to clone; defaults to the remote default branch'),
      },
      async (a) => guard(async () => json(await host.add(a.url, a.ref))),
    ),
    tool(
      'check_updates',
      'Check every marketplace upstream for new commits (git ls-remote against the stored SHA). Per-marketplace failures are isolated and reported on that entry. Read-only: no store or disk writes; only `git ls-remote`.',
      {},
      async () => guard(async () => json({ updates: await host.checkUpdates() })),
      { annotations: readOnly },
    ),
    tool(
      'set_plugin_enabled',
      "Enable or disable a plugin in a marketplace. Enabling installs it for subsequent sessions; disabling removes it. Returns the plugin's updated record.",
      {
        id: z.string().describe('marketplace id (from list)'),
        plugin: z.string().describe('plugin name (from plugins)'),
        enabled: z.boolean(),
      },
      async (a) => guard(async () => json({ plugin: await host.setPluginEnabled(a.id, a.plugin, a.enabled) })),
    ),
    tool(
      'remove',
      'Hard-remove a plugin marketplace: disables its enabled plugins on every live session, then deletes the entry, its enabled-plugin flags and its clone directory. Destructive — requires confirm: true.',
      {
        id: z.string().describe('marketplace id (from list)'),
        confirm: z.boolean().optional().describe('must be true; the call is refused otherwise'),
      },
      async (a) =>
        guard(async () => {
          if (a.confirm !== true) throw new Error('confirm: true required for destructive remove')
          await host.remove(a.id)
          return json({ ok: true })
        }),
    ),
  ]
}

/** Build the marketplace-tools first-party server bound to a host. requiresCwd
 *  is false — the marketplace store is global, not project-scoped. */
export function createMarketplaceTools(host: MarketplaceToolsHost): FirstPartyToolServer {
  return {
    name: MARKETPLACE_TOOLS_SERVER_NAME,
    description: 'List, add, inspect and remove plugin marketplaces and enable or disable their plugins',
    defaultEnabled: true,
    requiresCwd: false,
    buildTools: () => buildMarketplaceTools(host),
    readOnlyToolNames: MARKETPLACE_READ_ONLY_TOOLS,
  }
}
