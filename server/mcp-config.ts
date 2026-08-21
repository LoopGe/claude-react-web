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
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
} from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  UnauthorizedError,
  discoverOAuthServerInfo,
  refreshAuthorization,
  selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import type { JsonFileStoreOptions } from './json-file-store.js'
import { createLogger } from './log.js'

const log = createLogger('mcp-config')

// ---------------------------------------------------------------------------
// Command allowlist
// ---------------------------------------------------------------------------

/** Binaries allowed in the `command` field of stdio MCP servers. Any other
 *  value is rejected to prevent arbitrary code execution. Names are matched
 *  case-insensitively against the basename of the command (without extension)
 *  so both `node` and `node.exe` pass. */
const ALLOWED_MCP_COMMANDS = new Set([
  'node', 'npx', 'npm', 'bun', 'deno',
  'python', 'python3', 'uvx', 'uv',
  'java',
  'docker',
  'dotnet',
  'ruby', 'perl',
])

function validateCommand(command: string): string | null {
  const base = path.basename(command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  if (!ALLOWED_MCP_COMMANDS.has(base)) {
    return `command '${command}' is not in the allowlist (allowed: ${[...ALLOWED_MCP_COMMANDS].join(', ')})`
  }
  return null
}

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
  /** Remote MCP OAuth state. Contains secrets and is never returned raw. */
  oauth?: StoredMcpOAuthState
  createdAt: number
  updatedAt: number
}

export interface StoredMcpOAuthState {
  tokens?: OAuthTokens
  clientInformation?: OAuthClientInformationMixed
  codeVerifier?: string
  state?: string
  discoveryState?: OAuthDiscoveryState
  redirectUrl?: string
  lastAuthorizedAt?: number
}

/** The on-disk shape: a keyed object. Keys match `name`. */
export type McpConfigFile = Record<string, StoredMcpServer>

export type { McpServerInput } from '../shared/mcp-types'
import type { McpExportFile, McpExportServer } from '../shared/mcp-types'

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
  /** True when OAuth tokens are stored for this remote server. */
  oauthAuthorized?: boolean
  /** Last successful OAuth token exchange timestamp. */
  oauthLastAuthorizedAt?: number
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
      log.warn(`${this.onDiskFile} is not an object; ignoring`)
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
      log.warn(`failed to read ${this.file}: ${e.message}`)
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

  /** Return the SDK config for a single named server, **ignoring its
   *  `enabled` flag**. Returns null if no server with that name exists.
   *
   *  Use this when a caller has explicitly requested a server by name
   *  (e.g. the new-session dialog's checked list) and the global `enabled`
   *  default must not gate it — `enabled` only controls the *default*
   *  pre-selection, not whether an explicitly-chosen server can be used.
   *  For the "all enabled servers" map, keep using {@link toSdkConfig}. */
  getSdkServerConfig(name: string): McpServerConfig | null {
    const server = this.index.get(name)
    return server ? toSdkServerConfig(server) : null
  }

  /** Refresh stored OAuth tokens before serialising configs for real SDK sessions. */
  async refreshOAuthTokens(names?: Iterable<string>): Promise<void> {
    const selected = names ? new Set(Array.from(names).filter((name): name is string => typeof name === 'string')) : undefined
    let changed = false
    for (const [name, server] of this.index) {
      // An explicitly-requested name overrides the global `enabled` flag —
      // a globally-disabled server can still be opted into a session by
      // name, and its OAuth tokens must be refreshed before serialising.
      // Only the "refresh all" path (no `names` arg) honours `enabled`.
      if (selected) {
        if (!selected.has(name)) continue
      } else if (server.enabled === false) {
        continue
      }
      const before = JSON.stringify(server.oauth ?? null)
      try {
        await refreshMcpOAuth(server)
      } catch (err) {
        log.warn(`OAuth refresh failed for ${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (JSON.stringify(server.oauth ?? null) !== before) {
        server.updatedAt = Date.now()
        this.upsert(server)
        changed = true
      }
    }
    if (changed) await this.flush()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip secrets from a StoredMcpServer for API responses. */
export function maskSecrets(server: StoredMcpServer): MaskedMcpServer {
  const { env, headers, oauth, ...rest } = server
  const masked: MaskedMcpServer = { ...rest }
  if (env && Object.keys(env).length > 0) masked.envKeys = Object.keys(env)
  if (headers && Object.keys(headers).length > 0) masked.headerKeys = Object.keys(headers)
  if (oauth?.tokens?.access_token) masked.oauthAuthorized = true
  if (typeof oauth?.lastAuthorizedAt === 'number') masked.oauthLastAuthorizedAt = oauth.lastAuthorizedAt
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
  if (isOAuthState(r.oauth)) server.oauth = r.oauth as StoredMcpOAuthState
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
    if (!server.command || !server.command.trim()) {
      errors.push('command is required for stdio type')
    } else {
      const cmdErr = validateCommand(server.command.trim())
      if (cmdErr) errors.push(cmdErr)
    }
  } else {
    if (!server.url || !server.url.trim()) errors.push(`url is required for ${type} type`)
  }
  if (server.args !== undefined && !Array.isArray(server.args)) errors.push('args must be an array')
  if (server.env !== undefined && !isStringRecord(server.env)) errors.push('env must be a record of strings')
  if (server.headers !== undefined && !isStringRecord(server.headers)) errors.push('headers must be a record of strings')
  return errors
}

/** Coerce + validate a raw import entry into a StoredMcpServer ready to
 *  store. Preserves empty-string env/header values as sentinels so that
 *  {@link applyImportedOverwrite} can distinguish "not in file" from
 *  "explicitly empty (masked)" — callers creating NEW servers should
 *  strip empties from the result before upserting. */
export function coerceImportServer(
  raw: unknown,
  fallbackName?: string,
): { server: StoredMcpServer } | { error: string } {
  const server = coerceStoredMcpServer(raw, fallbackName)
  if (!server) return { error: 'could not parse server entry' }
  const errors = validateMcpServer(server)
  if (errors.length > 0) return { error: errors.join('; ') }
  return { server }
}

/** Apply an imported server onto an existing stored server for overwrite.
 *  Scalar fields are replaced; env/headers merge — non-empty incoming values
 *  win, empty-string values (masked exports) fall back to existing values,
 *  and existing keys not present in the incoming file are dropped.
 *  createdAt preserved; updatedAt bumped. */
export function applyImportedOverwrite(existing: StoredMcpServer, incoming: StoredMcpServer): StoredMcpServer {
  const merged: StoredMcpServer = {
    ...existing,
    type: incoming.type,
    updatedAt: Date.now(),
  }
  if (incoming.command !== undefined) merged.command = incoming.command
  if (incoming.args !== undefined) merged.args = incoming.args
  if (incoming.url !== undefined) merged.url = incoming.url
  if (incoming.alwaysLoad !== undefined) merged.alwaysLoad = incoming.alwaysLoad
  if (incoming.enabled !== undefined) merged.enabled = incoming.enabled
  if (incoming.env) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(incoming.env)) {
      if (v !== '') env[k] = v
      else if (existing.env?.[k]) env[k] = existing.env[k]
    }
    merged.env = Object.keys(env).length > 0 ? env : undefined
  }
  if (incoming.headers) {
    const hdrs: Record<string, string> = {}
    for (const [k, v] of Object.entries(incoming.headers)) {
      if (v !== '') hdrs[k] = v
      else if (existing.headers?.[k]) hdrs[k] = existing.headers[k]
    }
    merged.headers = Object.keys(hdrs).length > 0 ? hdrs : undefined
  }
  return merged
}

/** Serialize stored servers into export entries. In masked mode every
 *  env/header value becomes ''; oauth and timestamps are never included. */
export function toExportServers(servers: StoredMcpServer[], includeSecrets: boolean): McpExportServer[] {
  return servers.map((s) => {
    const out: McpExportServer = { name: s.name, type: s.type }
    if (s.command !== undefined) out.command = s.command
    if (s.args !== undefined) out.args = s.args
    if (s.url !== undefined) out.url = s.url
    if (s.alwaysLoad !== undefined) out.alwaysLoad = s.alwaysLoad
    if (s.enabled !== undefined) out.enabled = s.enabled
    if (s.env && Object.keys(s.env).length > 0) {
      out.env = includeSecrets ? { ...s.env } : Object.fromEntries(Object.keys(s.env).map((k) => [k, '']))
    }
    if (s.headers && Object.keys(s.headers).length > 0) {
      out.headers = includeSecrets ? { ...s.headers } : Object.fromEntries(Object.keys(s.headers).map((k) => [k, '']))
    }
    return out
  })
}

/** Build a versioned export file envelope from stored servers. */
export function buildExportFile(servers: StoredMcpServer[], includeSecrets: boolean): McpExportFile {
  return {
    format: 'claude-react-web-mcp',
    version: 1,
    exportedAt: Date.now(),
    secretScope: includeSecrets ? 'full' : 'masked',
    servers: toExportServers(servers, includeSecrets),
  }
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export interface TestConnectionResult {
  success: boolean
  status: 'connected' | 'failed' | 'needs-auth'
  serverInfo?: { name?: string; version?: string }
  toolCount?: number
  tools?: McpConnectionTool[]
  authRequired?: boolean
  error?: string
}

export interface TestConnectionOptions {
  includeTools?: boolean
}

export interface McpConnectionTool {
  name: string
  description?: string
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean }
}

export interface StartMcpOAuthResult {
  authorizationUrl: string
}

const CONNECT_TIMEOUT_MS = 10_000

/** Probe an MCP server by opening a real connection, performing the
 *  initialize handshake, and optionally listing tools. Returns a result
 *  object (never throws). The spawned child process (stdio) or network
 *  resources (sse/http) are always cleaned up. */
export async function testMcpConnection(
  server: StoredMcpServer,
  options: TestConnectionOptions = {},
): Promise<TestConnectionResult> {
  const client = new Client(
    { name: 'claude-react-web-test', version: '1.0.0' },
    { capabilities: {} },
  )
  let transport: Awaited<ReturnType<typeof createTransport>> | null = null
  try {
    const authProvider = server.type !== 'stdio' && server.oauth?.tokens
      ? new StoredMcpOAuthProvider(server, server.oauth.redirectUrl ?? 'http://127.0.0.1/')
      : undefined
    transport = await createTransport(server, authProvider)
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS)
    let tools: McpConnectionTool[] | undefined
    if (options.includeTools) {
      tools = []
      try {
        const result = await client.listTools()
        tools = result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          annotations: normalizeToolAnnotations(tool.annotations),
        }))
      } catch {
        // listTools is optional; some servers don't support it.
      }
    }
    const serverInfo = client.getServerVersion()
    return {
      success: true,
      status: 'connected',
      serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
      toolCount: tools?.length,
      tools,
    }
  } catch (err) {
    const authRequired = isMcpAuthError(err)
    return {
      success: false,
      status: authRequired ? 'needs-auth' : 'failed',
      authRequired,
      error: (err as Error).message ?? String(err),
    }
  } finally {
    try { await client.close() } catch { /* best-effort */ }
    // For stdio, closing the client kills the child process. For network
    // transports, close() releases the underlying connection.
  }
}

/** Start a remote MCP OAuth authorization flow. The returned URL should be
 * opened by the browser; the OAuth provider state is persisted on `server`. */
export async function startMcpOAuth(server: StoredMcpServer, redirectUrl: string): Promise<StartMcpOAuthResult> {
  if (server.type === 'stdio') throw new Error('OAuth auth is only available for remote MCP servers')
  let authorizationUrl = ''
  const oauth = { ...(server.oauth ?? {}), redirectUrl, state: randomUUID() }
  delete oauth.tokens
  delete oauth.codeVerifier
  server.oauth = oauth
  const provider = new StoredMcpOAuthProvider(server, redirectUrl, (url) => { authorizationUrl = url.toString() })
  const transport = createTransport(server, provider)
  const client = new Client({ name: 'claude-react-web-auth', version: '1.0.0' }, { capabilities: {} })
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS)
  } catch (err) {
    if (!authorizationUrl && !isMcpAuthError(err)) throw err
  } finally {
    try { await client.close() } catch { /* best-effort */ }
  }
  if (!authorizationUrl) throw new Error('MCP server did not provide an OAuth authorization URL')
  return { authorizationUrl }
}

/** Complete a remote MCP OAuth flow and store the resulting tokens. */
export async function finishMcpOAuth(server: StoredMcpServer, code: string, redirectUrl: string): Promise<void> {
  if (server.type === 'stdio') throw new Error('OAuth auth is only available for remote MCP servers')
  const provider = new StoredMcpOAuthProvider(server, redirectUrl)
  const transport = createTransport(server, provider)
  try {
    if ('finishAuth' in transport && typeof transport.finishAuth === 'function') {
      await withTimeout(transport.finishAuth(code), CONNECT_TIMEOUT_MS)
    } else {
      throw new Error('transport does not support OAuth finishAuth')
    }
    server.oauth = { ...(server.oauth ?? {}), redirectUrl, lastAuthorizedAt: Date.now() }
    delete server.oauth.codeVerifier
    delete server.oauth.state
  } finally {
    try { await transport.close?.() } catch { /* best-effort */ }
  }
}

export function clearMcpOAuth(server: StoredMcpServer): void {
  if (server.oauth) delete server.oauth
}

export async function refreshMcpOAuth(server: StoredMcpServer): Promise<boolean> {
  if (server.type === 'stdio' || !server.url) return false
  const refreshToken = server.oauth?.tokens?.refresh_token
  const clientInformation = server.oauth?.clientInformation
  if (!refreshToken || !clientInformation) return false

  const provider = new StoredMcpOAuthProvider(server, server.oauth?.redirectUrl ?? 'http://127.0.0.1/')
  try {
    const cachedState = provider.discoveryState()
    const serverInfo = cachedState?.authorizationServerUrl
      ? cachedState
      : await withTimeout(discoverOAuthServerInfo(server.url), CONNECT_TIMEOUT_MS)
    if (!cachedState?.authorizationServerUrl) {
      provider.saveDiscoveryState({
        authorizationServerUrl: serverInfo.authorizationServerUrl,
        authorizationServerMetadata: serverInfo.authorizationServerMetadata,
        resourceMetadata: serverInfo.resourceMetadata,
      })
    }
    const resource = await selectResourceURL(server.url, provider, serverInfo.resourceMetadata)
    const tokens = await withTimeout(
      refreshAuthorization(serverInfo.authorizationServerUrl, {
        metadata: serverInfo.authorizationServerMetadata,
        clientInformation,
        refreshToken,
        resource,
      }),
      CONNECT_TIMEOUT_MS,
    )
    provider.saveTokens(tokens)
    return true
  } catch (err) {
    if (clearInvalidOAuthCredentials(server, err)) {
      return true
    }
    throw err
  }
}

function normalizeToolAnnotations(annotations: unknown): McpConnectionTool['annotations'] | undefined {
  if (!annotations || typeof annotations !== 'object') return undefined
  const record = annotations as Record<string, unknown>
  const normalized = {
    readOnly: record.readOnlyHint === true || record.readOnly === true,
    destructive: record.destructiveHint === true || record.destructive === true,
    openWorld: record.openWorldHint === true || record.openWorld === true,
  }
  return normalized.readOnly || normalized.destructive || normalized.openWorld ? normalized : undefined
}

function isMcpAuthError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  if (err instanceof StreamableHTTPError && err.code === 401) return true
  const maybe = err as { code?: unknown; message?: unknown }
  const message = typeof maybe.message === 'string' ? maybe.message.toLowerCase() : ''
  return maybe.code === 401 || message.includes('unauthorized') || message.includes('401') || message.includes('auth')
}

function isOAuthCredentialsInvalid(err: unknown): boolean {
  return err instanceof InvalidGrantError || err instanceof InvalidClientError || err instanceof UnauthorizedClientError
}

function clearInvalidOAuthCredentials(server: StoredMcpServer, err: unknown): boolean {
  if (!isOAuthCredentialsInvalid(err) || !server.oauth) return false
  if (err instanceof InvalidClientError || err instanceof UnauthorizedClientError) {
    delete server.oauth.clientInformation
  }
  if (server.oauth.tokens) delete server.oauth.tokens
  return true
}

function createTransport(server: StoredMcpServer, authProvider?: OAuthClientProvider) {
  const type = server.type ?? 'stdio'
  if (type === 'stdio') {
    if (!server.command) throw new Error('command is required for stdio')
    // Defense-in-depth: validate against allowlist even for pre-existing configs.
    const cmdErr = validateCommand(server.command)
    if (cmdErr) throw new Error(cmdErr)
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
      authProvider,
      requestInit: server.headers ? { headers: server.headers } : undefined,
    })
  }
  if (type === 'http') {
    if (!server.url) throw new Error('url is required for http')
    const url = new URL(server.url)
    return new StreamableHTTPClientTransport(url, {
      authProvider,
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

class StoredMcpOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly server: StoredMcpServer,
    private readonly callbackUrl: string,
    private readonly onRedirect?: (url: URL) => void,
  ) {}

  get redirectUrl(): string {
    return this.callbackUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.callbackUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'claude-react-web',
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.server.oauth?.clientInformation
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.ensureState().clientInformation = clientInformation
  }

  tokens(): OAuthTokens | undefined {
    return this.server.oauth?.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    const state = this.ensureState()
    state.tokens = tokens
    state.lastAuthorizedAt = Date.now()
  }

  state(): string {
    const state = this.ensureState()
    state.state ??= randomUUID()
    return state.state
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onRedirect?.(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.ensureState().codeVerifier = codeVerifier
  }

  codeVerifier(): string {
    const codeVerifier = this.server.oauth?.codeVerifier
    if (!codeVerifier) throw new Error('missing OAuth code verifier; start auth again')
    return codeVerifier
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.ensureState().discoveryState = discoveryState
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.server.oauth?.discoveryState
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (!this.server.oauth) return
    if (scope === 'all') {
      delete this.server.oauth
      return
    }
    if (scope === 'client') delete this.server.oauth.clientInformation
    if (scope === 'tokens') delete this.server.oauth.tokens
    if (scope === 'verifier') delete this.server.oauth.codeVerifier
    if (scope === 'discovery') delete this.server.oauth.discoveryState
  }

  private ensureState(): StoredMcpOAuthState {
    this.server.oauth ??= {}
    this.server.oauth.redirectUrl = this.callbackUrl
    return this.server.oauth
  }
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
    const headers = headersWithOAuth(server)
    if (Object.keys(headers).length > 0) cfg.headers = headers
    if (server.alwaysLoad) cfg.alwaysLoad = true
    return cfg
  }
  if (server.type === 'http') {
    if (!server.url) return null
    const cfg: McpHttpServerConfig = { type: 'http', url: server.url }
    const headers = headersWithOAuth(server)
    if (Object.keys(headers).length > 0) cfg.headers = headers
    if (server.alwaysLoad) cfg.alwaysLoad = true
    return cfg
  }
  return null
}

function headersWithOAuth(server: StoredMcpServer): Record<string, string> {
  const headers = { ...(server.headers ?? {}) }
  const accessToken = server.oauth?.tokens?.access_token
  if (accessToken && !hasAuthorizationHeader(headers)) {
    headers.Authorization = `Bearer ${accessToken}`
  }
  return headers
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
}

function isStringRecord(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  return Object.values(v).every((val) => typeof val === 'string')
}

function isOAuthState(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const state = v as Record<string, unknown>
  return (
    (state.tokens === undefined || (typeof state.tokens === 'object' && state.tokens !== null)) &&
    (state.clientInformation === undefined || (typeof state.clientInformation === 'object' && state.clientInformation !== null)) &&
    (state.codeVerifier === undefined || typeof state.codeVerifier === 'string') &&
    (state.state === undefined || typeof state.state === 'string') &&
    (state.discoveryState === undefined || (typeof state.discoveryState === 'object' && state.discoveryState !== null)) &&
    (state.redirectUrl === undefined || typeof state.redirectUrl === 'string') &&
    (state.lastAuthorizedAt === undefined || typeof state.lastAuthorizedAt === 'number')
  )
}
