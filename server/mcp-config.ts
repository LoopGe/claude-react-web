// Global MCP server configuration persistence.
//
// Stores user-defined MCP server configs in <stateDir>/mcp-config.json so
// they survive across sessions. Each server entry mirrors the SDK's
// McpServerConfig union but is serialisable (no live instances).
//
// Storage is a keyed JSON object (not an array) for O(1) lookup by name.
// Writes are atomic (tmp + rename) and debounced, same as persistence.ts.
// The file is written with mode 0o600 because it may contain secrets
// (env vars, API tokens, auth headers).

import { promises as fs } from 'node:fs'
import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
} from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import type { JsonFileStoreOptions } from './json-file-store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VALID_TYPES = ['stdio', 'sse', 'http'] as const

/** Serializable MCP server config stored on disk. */
export interface StoredMcpServer {
  name: string
  type: 'stdio' | 'sse' | 'http'
  /** stdio: command to spawn */
  command?: string
  /** stdio: arguments array */
  args?: string[]
  /** stdio: environment variables (may contain secrets) */
  env?: Record<string, string>
  /** sse / http: server URL */
  url?: string
  /** sse / http: request headers (may contain secrets) */
  headers?: Record<string, string>
  /** When true, tools from this server are always included in the prompt */
  alwaysLoad?: boolean
  /** User can disable without deleting */
  enabled?: boolean
  createdAt: number
  updatedAt: number
}

/** The on-disk shape: a keyed object. Keys match `name`. */
export type McpConfigFile = Record<string, StoredMcpServer>

/** Input for creating/updating a global MCP server via the API. */
export interface McpServerInput {
  name: string
  type?: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  alwaysLoad?: boolean
  enabled?: boolean
}

/** API-safe version of StoredMcpServer with secrets stripped. */
export interface MaskedMcpServer {
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  alwaysLoad?: boolean
  enabled?: boolean
  createdAt: number
  updatedAt: number
  /** Environment variable keys (values hidden) */
  envKeys?: string[]
  /** Header keys (values hidden) */
  headerKeys?: string[]
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type McpConfigStoreOptions = JsonFileStoreOptions

/**
 * McpConfigStore — CRUD store for global MCP server configs.
 *
 * Usage:
 *   const store = new McpConfigStore({ stateDir })
 *   await store.load()
 *   store.upsert(server)
 *   store.remove(name)
 *   await store.flush()
 */
export class McpConfigStore extends JsonFileStore<StoredMcpServer> {
  private readonly onDiskFile: string

  constructor(opts: McpConfigStoreOptions = {}) {
    super(opts, 'mcp-config.json', DEFAULT_DIR_NAME, 'mcp-config')
    // `file` is the resolved full path from the base class. We need
    // the relative name for the parseItems warn message — but we can
    // just use `this.file` (base class already has it).
    this.onDiskFile = this.file
  }

  protected getKey(server: StoredMcpServer): string {
    return server.name
  }

  /** Parse the on-disk keyed-object format into StoredMcpServer entries. */
  protected parseItems(raw: string): StoredMcpServer[] {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[mcp-config] ${this.onDiskFile} is not an object; ignoring`)
      return []
    }
    const entries: StoredMcpServer[] = []
    for (const [key, value] of Object.entries(parsed as McpConfigFile)) {
      const server = coerceStoredMcpServer(value, key)
      if (server) entries.push(server)
    }
    return entries
  }

  /** McpConfigFile serialises as a keyed record (not an array). */
  protected serializeForWrite(items: StoredMcpServer[]): unknown {
    const record: McpConfigFile = {}
    for (const server of items) {
      record[server.name] = server
    }
    return record
  }

  /** Load configs from disk. Missing or corrupt file → empty store. */
  async load(): Promise<StoredMcpServer[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const entries = this.parseItems(raw)
      this.initEntries(entries)
      return entries
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      console.warn(`[mcp-config] failed to read ${this.file}: ${e.message}`)
      return []
    }
  }

  /** Return configs as a Record suitable for SDK Options.mcpServers.
   *  Only includes enabled servers. Strips metadata fields. */
  toSdkConfig(): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {}
    for (const [name, server] of this.index) {
      if (server.enabled === false) continue
      const cfg = toSdkServerConfig(server)
      if (cfg) result[name] = cfg
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip secrets from a StoredMcpServer for API responses. */
export function maskSecrets(server: StoredMcpServer): MaskedMcpServer {
  const { env, headers, ...rest } = server
  const masked: MaskedMcpServer = { ...rest }
  if (env && Object.keys(env).length > 0) masked.envKeys = Object.keys(env)
  if (headers && Object.keys(headers).length > 0) masked.headerKeys = Object.keys(headers)
  return masked
}

/** Validate and normalise raw JSON into a StoredMcpServer. Returns null if unusable. */
export function coerceStoredMcpServer(raw: unknown, fallbackName?: string): StoredMcpServer | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim()
    : typeof fallbackName === 'string' && fallbackName.trim() ? fallbackName.trim()
    : null
  if (!name) return null
  const rawType = typeof r.type === 'string' ? r.type : 'stdio'
  const type = (VALID_TYPES as readonly string[]).includes(rawType) ? rawType as StoredMcpServer['type'] : 'stdio'
  const now = Date.now()
  const server: StoredMcpServer = {
    name,
    type,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
  }
  if (typeof r.command === 'string') server.command = r.command
  if (Array.isArray(r.args) && r.args.every((a: unknown) => typeof a === 'string')) server.args = r.args as string[]
  if (isStringRecord(r.env)) server.env = r.env as Record<string, string>
  if (typeof r.url === 'string') server.url = r.url
  if (isStringRecord(r.headers)) server.headers = r.headers as Record<string, string>
  if (typeof r.alwaysLoad === 'boolean') server.alwaysLoad = r.alwaysLoad
  if (typeof r.enabled === 'boolean') server.enabled = r.enabled
  return server
}

/** Validate a StoredMcpServer and return error messages, or empty array if valid. */
export function validateMcpServer(server: Partial<StoredMcpServer>): string[] {
  const errors: string[] = []
  if (!server.name || !server.name.trim()) errors.push('name is required')
  const type = server.type ?? 'stdio'
  if (type === 'stdio') {
    if (!server.command || !server.command.trim()) errors.push('command is required for stdio type')
  } else {
    if (!server.url || !server.url.trim()) errors.push(`url is required for ${type} type`)
  }
  if (server.args !== undefined && !Array.isArray(server.args)) errors.push('args must be an array')
  if (server.env !== undefined && !isStringRecord(server.env)) errors.push('env must be a record of strings')
  if (server.headers !== undefined && !isStringRecord(server.headers)) errors.push('headers must be a record of strings')
  return errors
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export interface TestConnectionResult {
  success: boolean
  serverInfo?: { name?: string; version?: string }
  toolCount?: number
  error?: string
}

const CONNECT_TIMEOUT_MS = 10_000

/** Probe an MCP server by opening a real connection, performing the
 *  initialize handshake, and optionally listing tools. Returns a result
 *  object (never throws). The spawned child process (stdio) or network
 *  resources (sse/http) are always cleaned up. */
export async function testMcpConnection(server: StoredMcpServer): Promise<TestConnectionResult> {
  const client = new Client(
    { name: 'claude-react-web-test', version: '1.0.0' },
    { capabilities: {} },
  )
  let transport: Awaited<ReturnType<typeof createTransport>> | null = null
  try {
    transport = await createTransport(server)
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS)
    let toolCount = 0
    try {
      const { tools } = await client.listTools()
      toolCount = tools.length
    } catch {
      // listTools is optional — some servers don't support it
    }
    const serverInfo = client.getServerVersion()
    return {
      success: true,
      serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
      toolCount,
    }
  } catch (err) {
    return { success: false, error: (err as Error).message ?? String(err) }
  } finally {
    try { await client.close() } catch { /* best-effort */ }
    // For stdio, closing the client kills the child process. For network
    // transports, close() releases the underlying connection.
  }
}

function createTransport(server: StoredMcpServer) {
  const type = server.type ?? 'stdio'
  if (type === 'stdio') {
    if (!server.command) throw new Error('command is required for stdio')
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env
        ? { ...process.env, ...Object.fromEntries(Object.entries(server.env).filter(([, v]) => v != null)) } as Record<string, string>
        : undefined,
    })
  }
  if (type === 'sse') {
    if (!server.url) throw new Error('url is required for sse')
    const url = new URL(server.url)
    return new SSEClientTransport(url, {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    })
  }
  if (type === 'http') {
    if (!server.url) throw new Error('url is required for http')
    const url = new URL(server.url)
    return new StreamableHTTPClientTransport(url, {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    })
  }
  throw new Error(`unknown transport type: ${type}`)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Connection timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** Convert a StoredMcpServer to the SDK config shape. */
function toSdkServerConfig(server: StoredMcpServer): McpServerConfig | null {
  if (server.type === 'stdio') {
    if (!server.command) return null
    const cfg: McpStdioServerConfig = { type: 'stdio', command: server.command }
    if (server.args && server.args.length > 0) cfg.args = server.args
    if (server.env && Object.keys(server.env).length > 0) cfg.env = server.env
    if (server.alwaysLoad) cfg.alwaysLoad = true
    return cfg
  }
  if (server.type === 'sse') {
    if (!server.url) return null
    const cfg: McpSSEServerConfig = { type: 'sse', url: server.url }
    if (server.headers && Object.keys(server.headers).length > 0) cfg.headers = server.headers
    if (server.alwaysLoad) cfg.alwaysLoad = true
    return cfg
  }
  if (server.type === 'http') {
    if (!server.url) return null
    const cfg: McpHttpServerConfig = { type: 'http', url: server.url }
    if (server.headers && Object.keys(server.headers).length > 0) cfg.headers = server.headers
    if (server.alwaysLoad) cfg.alwaysLoad = true
    return cfg
  }
  return null
}

function isStringRecord(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  return Object.values(v).every((val) => typeof val === 'string')
}
