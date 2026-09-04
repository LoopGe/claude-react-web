import { MpStore } from '../mp-store.js'
import { addMarketplaceByUrl } from '../mp-ops.js'
import { CliContext, CliError, CliGroup } from './types.js'
import { ParsedOptions } from './parser.js'
import { table } from './render.js'

async function loadStore(ctx: CliContext): Promise<MpStore> {
  const store = new MpStore({ stateDir: ctx.stateDir })
  await store.load()
  return store
}

function resolveId(store: MpStore, arg: string): string {
  if (store.has(arg)) return arg
  const byUrl = store.list().find((e) => e.source.url === arg)
  if (byUrl) return byUrl.id
  throw new CliError(`marketplace not found: ${arg}`, 1)
}

async function add(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const store = await loadStore(ctx)
  const url = p.positionals[0]
  const ref = typeof p.values.ref === 'string' ? p.values.ref : undefined
  const { entry, warnings } = await addMarketplaceByUrl(store, { url, ref })
  return { ok: true, id: entry.id, displayName: entry.displayName, pluginCount: entry.manifest.plugins.length, warnings }
}

async function list(ctx: CliContext): Promise<unknown> {
  const store = await loadStore(ctx)
  const marketplaces = store.list().map((e) => {
    const enabledMap = store.enabledMapFor(e.id)
    return {
      id: e.id,
      displayName: e.displayName,
      url: e.source.url,
      pluginCount: e.manifest.plugins.length,
      enabledCount: Object.values(enabledMap).filter(Boolean).length,
      lastRefreshedAt: e.lastRefreshedAt,
    }
  })
  marketplaces.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return { marketplaces }
}

async function remove(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  if (!p.yes) throw new CliError(`destructive: pass --yes to remove ${p.positionals[0]}`, 2)
  const store = await loadStore(ctx)
  const id = resolveId(store, p.positionals[0])
  await store.removeEntry(id)
  return { ok: true, removed: id }
}

interface MarketplaceShape {
  id: string
  displayName: string
  pluginCount: number
  enabledCount: number
}

export const marketplaceGroup: CliGroup = {
  name: 'marketplace',
  summary: 'Manage agent-plugin marketplaces (git-repo .claude-plugin sources)',
  subcommands: [
    {
      name: 'add',
      usage: 'marketplace add <url> [--ref <ref>]',
      description: 'Add a plugin marketplace by https git URL.',
      parseSpec: { string: ['ref'], minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => add(ctx, p),
      render: (d) => {
        const r = d as { id: string; displayName: string; pluginCount: number }
        return `added marketplace ${r.id} (${r.displayName}, ${r.pluginCount} plugins)`
      },
    },
    {
      name: 'list',
      usage: 'marketplace list',
      description: 'List added marketplaces.',
      parseSpec: {},
      run: (ctx) => list(ctx),
      render: (d) => {
        const r = d as { marketplaces: MarketplaceShape[] }
        return table(['id', 'name', 'plugins', 'enabled'],
          r.marketplaces.map((m) => [m.id, m.displayName, String(m.pluginCount), String(m.enabledCount)]))
      },
    },
    {
      name: 'remove',
      usage: 'marketplace remove <id-or-url> --yes',
      description: 'Remove a marketplace and its clone.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => remove(ctx, p),
      render: (d) => `removed marketplace ${(d as { removed: string }).removed}`,
    },
  ],
}
