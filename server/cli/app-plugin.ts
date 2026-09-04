import { CliContext, CliError, CliGroup } from './types.js'
import { ParsedOptions } from './parser.js'
import { table } from './render.js'
import { loadAppPluginContext } from './context.js'
import { addAppPluginMarketplaceByUrl } from '../app-plugins/marketplace-ops.js'

const MARKETPLACE_SPEC = { string: ['ref', 'subdir'], minPositional: 1 } as const

async function marketplaceRun(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const verb = p.positionals[0]
  if (verb === 'add') {
    const url = p.positionals[1]
    if (!url) throw new CliError('app-plugin marketplace add <url> requires a url', 2)
    const { marketplaceStore } = await loadAppPluginContext(ctx.stateDir)
    const { record } = await addAppPluginMarketplaceByUrl(marketplaceStore, {
      url,
      ref: typeof p.values.ref === 'string' ? p.values.ref : undefined,
      subdir: typeof p.values.subdir === 'string' ? p.values.subdir : undefined,
    })
    return { action: 'add', id: record.id, displayName: record.displayName, pluginCount: record.manifest.plugins.length }
  }
  if (verb === 'list') {
    const { marketplaceStore } = await loadAppPluginContext(ctx.stateDir)
    return {
      action: 'list',
      marketplaces: marketplaceStore.list().map((r) => ({ id: r.id, displayName: r.displayName, pluginCount: r.manifest.plugins.length })),
    }
  }
  if (verb === 'remove') {
    if (!p.yes) throw new CliError('destructive: pass --yes to remove marketplace', 2)
    const id = p.positionals[1]
    if (!id) throw new CliError('app-plugin marketplace remove <id> requires an id', 2)
    const { manager, marketplaceStore } = await loadAppPluginContext(ctx.stateDir)
    if (!marketplaceStore.has(id)) throw new CliError(`marketplace not found: ${id}`, 1)
    for (const pluginRecord of manager.recordsForMarketplace(id)) {
      await manager.uninstall(pluginRecord.id, { deleteData: false })
    }
    await marketplaceStore.removeEntry(id)
    return { action: 'remove', removed: id }
  }
  throw new CliError(`unknown app-plugin marketplace verb: ${verb}`, 2)
}

interface MarketplaceAction {
  action: string
  marketplaces?: Array<{ id: string; displayName: string; pluginCount: number }>
  id?: string
  displayName?: string
  pluginCount?: number
  removed?: string
}

function marketplaceRender(d: unknown): string {
  const r = d as MarketplaceAction
  if (r.action === 'list') {
    return table(['id', 'name', 'plugins'], (r.marketplaces ?? []).map((m) => [m.id, m.displayName, String(m.pluginCount)]))
  }
  if (r.action === 'add') return `added app-plugin marketplace ${r.id} (${r.displayName}, ${r.pluginCount} plugins)`
  return `removed app-plugin marketplace ${r.removed}`
}

interface PluginShape {
  id: string
  marketplace: string
  version: string
  enabled: boolean
  runtimeState: string
}

async function listPlugins(ctx: CliContext): Promise<unknown> {
  const { appPluginStore } = await loadAppPluginContext(ctx.stateDir)
  const plugins: PluginShape[] = appPluginStore.list().map((r) => ({
    id: r.id,
    marketplace: r.source.type === 'marketplace' ? r.source.marketplaceId : r.source.type,
    version: r.installedVersion,
    enabled: r.enabled,
    runtimeState: r.runtimeState,
  }))
  plugins.sort((a, b) => a.id.localeCompare(b.id))
  return { plugins }
}

async function installPlugin(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const key = p.positionals[0]
  const colon = key.indexOf(':')
  if (colon <= 0) throw new CliError('install expects <marketplaceId>:<pluginName>', 2)
  const marketplaceId = key.slice(0, colon)
  const pluginName = key.slice(colon + 1)
  const { manager } = await loadAppPluginContext(ctx.stateDir)
  const result = await manager.install({ type: 'marketplace', marketplaceId, pluginName })
  return { ok: true, id: result.id, version: result.version, permissionRequired: result.permissionRequired }
}

async function uninstallPlugin(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const id = p.positionals[0]
  if (!p.yes) throw new CliError(`destructive: pass --yes to uninstall ${id}`, 2)
  const { manager } = await loadAppPluginContext(ctx.stateDir)
  await manager.uninstall(id, { deleteData: false })
  return { ok: true, uninstalled: id }
}

export const appPluginGroup: CliGroup = {
  name: 'app-plugin',
  summary: 'Manage App Plugin marketplaces and installed App Plugins',
  subcommands: [
    {
      name: 'marketplace',
      usage: 'app-plugin marketplace <add <url> | list | remove <id> --yes> [--ref <ref>] [--subdir <dir>]',
      description: 'Manage App Plugin marketplaces (clone https git repos).',
      parseSpec: MARKETPLACE_SPEC,
      run: marketplaceRun,
      render: marketplaceRender,
    },
    {
      name: 'list',
      usage: 'app-plugin list',
      description: 'List installed App Plugins.',
      parseSpec: {},
      run: (ctx) => listPlugins(ctx),
      render: (d) => {
        const r = d as { plugins: PluginShape[] }
        return table(['id', 'marketplace', 'version', 'enabled', 'state'],
          r.plugins.map((p) => [p.id, p.marketplace, p.version, p.enabled ? 'yes' : 'no', p.runtimeState]))
      },
    },
    {
      name: 'install',
      usage: 'app-plugin install <marketplaceId>:<pluginName>',
      description: 'Install an App Plugin from an already-added marketplace.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => installPlugin(ctx, p),
      render: (d) => {
        const r = d as { id: string; version: string; permissionRequired: boolean }
        return `installed ${r.id}@${r.version}${r.permissionRequired ? ' (permission required before enable)' : ''}`
      },
    },
    {
      name: 'uninstall',
      usage: 'app-plugin uninstall <id> --yes',
      description: 'Uninstall an App Plugin (keeps its data).',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => uninstallPlugin(ctx, p),
      render: (d) => `uninstalled app-plugin ${(d as { uninstalled: string }).uninstalled}`,
    },
  ],
}
