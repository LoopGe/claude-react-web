import { McpConfigStore, maskSecrets, validateMcpServer, testMcpConnection } from '../mcp-config.js'
import type { StoredMcpServer } from '../mcp-config.js'
import { CliContext, CliError, CliGroup } from './types.js'
import { ParsedOptions, scalar, list as listValues } from './parser.js'
import { table } from './render.js'

const MCP_FLAGS = {
  string: ['type', 'command', 'args', 'url'],
  repeatable: ['env', 'headers'],
  boolean: ['always-load', 'disabled'],
  minPositional: 1,
  maxPositional: 1,
} as const

function parsePairs(entries: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const eq = entry.indexOf('=')
    if (eq <= 0) throw new CliError(`--${flag} expects KEY=VALUE, got: ${entry}`, 2)
    out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

function parseArgsJson(raw: string | undefined, flag: string): string[] | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new CliError(`--${flag} must be a JSON array`, 2) }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    throw new CliError(`--${flag} must be a JSON array of strings`, 2)
  }
  return parsed as string[]
}

function buildServer(name: string, p: ParsedOptions, partial: boolean, existing?: StoredMcpServer): StoredMcpServer {
  const now = Date.now()
  const type = scalar(p, 'type') ?? existing?.type ?? 'stdio'
  if (type !== 'stdio' && type !== 'sse' && type !== 'http') throw new CliError(`invalid type: ${type}`, 2)
  const base: StoredMcpServer = partial && existing
    ? { ...existing, updatedAt: now }
    : { name, type, createdAt: now, updatedAt: now }
  base.type = type
  const command = scalar(p, 'command')
  const url = scalar(p, 'url')
  if (command !== undefined) base.command = command
  if (url !== undefined) base.url = url
  const args = parseArgsJson(scalar(p, 'args'), 'args')
  if (args !== undefined) base.args = args
  const env = parsePairs(listValues(p, 'env'), 'env')
  if (Object.keys(env).length > 0) base.env = partial && existing?.env ? { ...existing.env, ...env } : env
  const headers = parsePairs(listValues(p, 'headers'), 'headers')
  if (Object.keys(headers).length > 0) base.headers = partial && existing?.headers ? { ...existing.headers, ...headers } : headers
  if (p.bools['always-load']) base.alwaysLoad = true
  if ('disabled' in p.bools) {
    base.enabled = p.bools.disabled ? false : partial && existing ? existing.enabled !== false : true
  }
  return base
}

async function loadStore(ctx: CliContext): Promise<McpConfigStore> {
  const store = new McpConfigStore({ stateDir: ctx.stateDir })
  await store.load()
  return store
}

async function add(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const store = await loadStore(ctx)
  const name = p.positionals[0]
  if (store.has(name)) throw new CliError(`server ${name} already exists`, 1)
  const server = buildServer(name, p, false)
  const errors = validateMcpServer(server)
  if (errors.length > 0) throw new CliError(errors.join('; '), 1)
  store.upsert(server)
  await store.flush()
  return { ok: true, name, server: maskSecrets(server) }
}

async function update(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const store = await loadStore(ctx)
  const name = p.positionals[0]
  const existing = store.get(name)
  if (!existing) throw new CliError(`server ${name} not found`, 1)
  const server = buildServer(name, p, true, existing)
  const errors = validateMcpServer(server)
  if (errors.length > 0) throw new CliError(errors.join('; '), 1)
  store.upsert(server)
  await store.flush()
  return { ok: true, name, server: maskSecrets(server) }
}

async function list(ctx: CliContext): Promise<unknown> {
  const store = await loadStore(ctx)
  return { servers: store.list().map(maskSecrets) }
}

async function remove(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const name = p.positionals[0]
  if (!p.yes) throw new CliError(`destructive: pass --yes to remove ${name}`, 2)
  const store = await loadStore(ctx)
  if (!store.has(name)) throw new CliError(`server ${name} not found`, 1)
  store.remove(name)
  await store.flush()
  return { ok: true, removed: name }
}

async function setEnabled(ctx: CliContext, p: ParsedOptions, enabled: boolean): Promise<unknown> {
  const store = await loadStore(ctx)
  const name = p.positionals[0]
  const existing = store.get(name)
  if (!existing) throw new CliError(`server ${name} not found`, 1)
  store.upsert({ ...existing, enabled, updatedAt: Date.now() })
  await store.flush()
  return { ok: true, name, enabled }
}

async function test(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const store = await loadStore(ctx)
  const name = p.positionals[0]
  const existing = store.get(name)
  if (!existing) throw new CliError(`server ${name} not found`, 1)
  const result = await testMcpConnection(existing)
  if (result.status === 'needs-auth') {
    result.error = (result.error ? result.error + '; ' : '') + 'authorize this server in the Web UI (MCP settings).'
  }
  return result
}

interface ListServerShape {
  name: string
  type: string
  command?: string
  url?: string
  enabled?: boolean
  alwaysLoad?: boolean
  envKeys?: string[]
}

export const mcpGroup: CliGroup = {
  name: 'mcp',
  summary: 'Manage global MCP servers (mcp-config.json)',
  subcommands: [
    {
      name: 'list',
      usage: 'mcp list',
      description: 'List configured MCP servers (secrets masked).',
      parseSpec: {},
      run: (ctx) => list(ctx),
      render: (d) => {
        const r = d as { servers: ListServerShape[] }
        return table(['name', 'type', 'command/url', 'enabled', 'always', 'env'],
          r.servers.map((s) => [s.name, s.type, s.command ?? s.url ?? '', s.enabled === false ? 'no' : 'yes', s.alwaysLoad ? 'yes' : '', (s.envKeys ?? []).join(',')]))
      },
    },
    {
      name: 'add',
      usage: 'mcp add <name> [--type stdio|sse|http] [--command <cmd>] [--args <json>] [--env K=V]… [--url <url>] [--headers K=V]… [--always-load] [--disabled]',
      description: 'Add an MCP server to the global config.',
      parseSpec: MCP_FLAGS,
      run: (ctx, p) => add(ctx, p),
      render: (d) => `added MCP server ${(d as { name: string }).name}`,
    },
    {
      name: 'update',
      usage: 'mcp update <name> [same flags as add]',
      description: 'Update an MCP server (env/headers merge).',
      parseSpec: MCP_FLAGS,
      run: (ctx, p) => update(ctx, p),
      render: (d) => `updated MCP server ${(d as { name: string }).name}`,
    },
    {
      name: 'remove',
      usage: 'mcp remove <name> --yes',
      description: 'Remove an MCP server.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => remove(ctx, p),
      render: (d) => `removed MCP server ${(d as { removed: string }).removed}`,
    },
    {
      name: 'enable',
      usage: 'mcp enable <name>',
      description: 'Enable a server.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => setEnabled(ctx, p, true),
      render: (d) => `enabled MCP server ${(d as { name: string }).name}`,
    },
    {
      name: 'disable',
      usage: 'mcp disable <name>',
      description: 'Disable a server.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => setEnabled(ctx, p, false),
      render: (d) => `disabled MCP server ${(d as { name: string }).name}`,
    },
    {
      name: 'test',
      usage: 'mcp test <name>',
      description: 'Probe an MCP server connection.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => test(ctx, p),
      render: (d) => {
        const r = d as { status: string; error?: string; serverInfo?: { name?: string; version?: string }; toolCount?: number }
        return r.status === 'connected'
          ? `connected${r.serverInfo?.name ? ` (${r.serverInfo.name} ${r.serverInfo.version ?? ''})` : ''}${r.toolCount !== undefined ? ` · ${r.toolCount} tools` : ''}`
          : `not connected: ${r.error ?? r.status}`
      },
      exitCode: (d) => ((d as { status: string }).status === 'connected' ? 0 : 1),
    },
  ],
}
