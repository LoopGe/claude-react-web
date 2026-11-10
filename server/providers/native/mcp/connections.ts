// server/providers/native/mcp/connections.ts
//
// Per-session MCP connection manager for the native provider. One
// `@modelcontextprotocol/sdk` `Client` per entry of the manager-resolved
// `mcpServers` map: external servers over the shared transports
// (`createMcpTransport`) and first-party in-process servers (`type: 'sdk'`)
// over an `InMemoryTransport` pair, so both kinds share one discovery / call /
// status path.
//
// Lifetime rules:
//   - Entries are FINGERPRINTED, never serialized. An `sdk` entry holds a live
//     server instance, and `JSON.stringify` on it throws on the circular refs;
//     its identity is the instance itself. An external entry's identity is the
//     serializable fields only (headers but not env — changing an env value
//     does not reconnect, matching the replace diff's documented behavior).
//   - Every mutation (load / setServers / reconnect / toggle / closeAll) runs
//     serialized on one queue; `whenReady()` is that queue, so callers that
//     need discovered tools just await it.
//   - A failing or timing-out server never rejects a mutation and never leaks
//     a child process: the client is closed (which kills a stdio child), the
//     in-process instance is closed, and the record turns `failed` /
//     `needs-auth` with an error message.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createMcpTransport, isMcpAuthError, type McpTransportTarget } from '../../../mcp-config.js'
import { mcpToolFqn } from '../../../../shared/mcp-fqn.js'
import { createLogger } from '../../../log.js'
import { capToolText } from '../tools/bash.js'

const log = createLogger('native-mcp')

const CLIENT_INFO = { name: 'claude-react-web-native', version: '1.0.0' }
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_TOOL_TIMEOUT_MS = 120_000

/** An in-process MCP server (`createSdkMcpServer().instance`). */
export interface NativeMcpServerInstance {
  connect(transport: Transport): Promise<void>
  close(): Promise<void>
}

export interface NativeMcpServerConfig {
  type: 'stdio' | 'sse' | 'http' | 'sdk'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  instance?: NativeMcpServerInstance
}

export interface NativeMcpToolInfo {
  /** The server this tool came from. */
  server: string
  /** Bare server-side name (for status / tools display). */
  name: string
  /** The model- and permission-facing name, `mcpToolFqn(server, name)`. */
  fqn: string
  /** The name `callTool` sends. */
  rawName: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  meta?: Record<string, unknown>
}

export interface NativeMcpStatus {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  serverInfo?: { name: string; version: string }
  error?: string
  /** Never carries `env` or `headers`; `args` is included deliberately. */
  config?: { type: string; command?: string; args?: string[]; url?: string }
  scope: 'session'
  source?: 'sdk'
  tools?: Array<{
    name: string
    description?: string
    annotations?: Record<string, unknown>
    _meta?: Record<string, unknown>
  }>
}

export type NativeMcpSetServersResult = {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

export interface NativeMcpConnectionsOptions {
  /** OAuth provider for a remote server, when the host stores credentials. */
  authFor?: (name: string) => OAuthClientProvider | undefined
  connectTimeoutMs?: number
  toolTimeoutMs?: number
}

interface ServerRecord {
  name: string
  config: NativeMcpServerConfig
  /** Replace-diff identity: the live instance for `type:'sdk'`, a JSON
   *  fingerprint of the serializable fields otherwise. */
  identity: unknown
  client?: Client
  connectTimer?: ReturnType<typeof setTimeout>
  /** Rejects an in-flight connect race early (closeAll). */
  cancelConnect?: () => void
  status: NativeMcpStatus['status']
  serverInfo?: { name: string; version: string }
  error?: string
  tools: NativeMcpToolInfo[]
}

export class NativeMcpConnections {
  private readonly authFor?: (name: string) => OAuthClientProvider | undefined
  private readonly connectTimeoutMs: number
  private readonly toolTimeoutMs: number

  private readonly records = new Map<string, ServerRecord>()
  private queue: Promise<void> = Promise.resolve()
  private closing = false

  constructor(opts: NativeMcpConnectionsOptions = {}) {
    this.authFor = opts.authFor
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  }

  /** Start connecting the map. Returns immediately; the connects run on the
   *  mutation queue (`whenReady()` waits for them). */
  load(servers: Record<string, unknown> | undefined): void {
    void this.enqueue(() => this.replaceAll(servers)).catch((err) => {
      // `load` is fire-and-forget: an unexpected throw must not surface as an
      // unhandled rejection. Per-server failures are already contained.
      log.error(`initial connect pass failed: ${errorMessage(err)}`)
    })
  }

  /** Resolves once the mutation queue (including in-flight connects) drains. */
  async whenReady(): Promise<void> {
    await this.queue
  }

  /** Server statuses, sorted by name. */
  statuses(): NativeMcpStatus[] {
    return [...this.records.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((rec) => {
        const status: NativeMcpStatus = {
          name: rec.name,
          status: rec.status,
          scope: 'session',
          config: configOf(rec.config),
          tools: rec.status === 'connected' ? rec.tools.map(statusTool) : [],
        }
        if (rec.serverInfo) status.serverInfo = rec.serverInfo
        if (rec.error) status.error = rec.error
        if (rec.config.type === 'sdk') status.source = 'sdk'
        return status
      })
  }

  /** Discovered tools of every connected server, in status (name) order. */
  tools(): NativeMcpToolInfo[] {
    const out: NativeMcpToolInfo[] = []
    for (const rec of [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (rec.status === 'connected') out.push(...rec.tools)
    }
    return out
  }

  /** Invoke a tool by its model-facing FQN. A transport throw propagates — the
   *  loop turns it into an error tool_result. */
  async call(
    fqn: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ text: string; isError?: boolean }> {
    await this.queue
    const found = this.findTool(fqn)
    if (!found) throw new Error(`unknown MCP tool: ${fqn}`)
    // The declared return type is the union of the parsed result and the
    // legacy compatibility shape regardless of the schema passed; asking for
    // CallToolResultSchema means the former is what actually comes back.
    const result = (await found.rec.client!.callTool(
      { name: found.tool.rawName, arguments: args },
      CallToolResultSchema,
      { timeout: this.toolTimeoutMs, signal },
    )) as CallToolResult
    const parts: string[] = []
    for (const block of result.content) {
      // Text blocks are the payload; anything else (image / audio / embedded
      // resource) is preserved verbatim so the model sees its structure.
      if (block.type === 'text') parts.push(block.text)
      else parts.push(JSON.stringify(block))
    }
    const out: { text: string; isError?: boolean } = { text: capToolText(parts.join('\n')) }
    if (result.isError === true) out.isError = true
    return out
  }

  /** Replace the dynamic server set (the `setMcpServers` semantics). */
  async setServers(servers: Record<string, unknown> | undefined): Promise<NativeMcpSetServersResult> {
    return this.enqueue(() => this.replaceAll(servers))
  }

  /** Drop the current connection and connect again from the stored config. */
  async reconnect(name: string): Promise<void> {
    return this.enqueue(async () => {
      const rec = this.requireRecord(name)
      await this.closeServer(rec)
      await this.connectRecord(rec)
    })
  }

  /** Disable a server (close + empty tools) or connect it again. */
  async toggle(name: string, enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      const rec = this.requireRecord(name)
      if (enabled) {
        if (rec.status === 'connected') return
        await this.closeServer(rec)
        await this.connectRecord(rec)
        return
      }
      await this.closeServer(rec)
      rec.status = 'disabled'
      rec.error = undefined
      rec.tools = []
    })
  }

  /** Forward a resource read to a connected server, result unchanged. */
  async readResource(name: string, uri: string): Promise<unknown> {
    await this.queue
    const rec = this.records.get(name)
    if (!rec || rec.status !== 'connected' || !rec.client) {
      throw new Error(`unknown MCP server: ${name}`)
    }
    return rec.client.readResource({ uri })
  }

  /** Close every client and in-process instance and clear the map. Idempotent;
   *  never throws. */
  async closeAll(): Promise<void> {
    this.closing = true
    // Cancel in-flight connects synchronously so this does not wait out a
    // hanging handshake; the queue then drains with those attempts settled.
    for (const rec of this.records.values()) rec.cancelConnect?.()
    await this.enqueue(async () => {
      const records = [...this.records.values()]
      this.records.clear()
      await Promise.all(records.map((rec) => this.closeResources(rec)))
    })
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Run `task` after every earlier mutation has settled. The returned promise
   *  carries the task's rejection to its caller, but the queue itself never
   *  rejects, so one failed mutation cannot poison the next. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(noop, noop)
    return run
  }

  private async replaceAll(
    servers: Record<string, unknown> | undefined,
  ): Promise<NativeMcpSetServersResult> {
    this.closing = false
    const result: NativeMcpSetServersResult = { added: [], removed: [], errors: {} }
    const next = new Map<string, { config: NativeMcpServerConfig; identity: unknown }>()
    for (const [name, raw] of Object.entries(servers ?? {})) next.set(name, entryOf(raw))

    // Removed and changed: close first so a changed name never holds two live
    // connections (and so a freed stdio child is gone before its replacement
    // spawns).
    for (const [name, rec] of [...this.records]) {
      const entry = next.get(name)
      if (entry && Object.is(entry.identity, rec.identity)) continue
      this.records.delete(name)
      await this.closeServer(rec)
      result.removed.push(name)
    }

    const connecting: Promise<void>[] = []
    for (const [name, entry] of next) {
      if (this.records.has(name)) continue
      const rec: ServerRecord = {
        name,
        config: entry.config,
        identity: entry.identity,
        status: 'pending',
        tools: [],
      }
      this.records.set(name, rec)
      result.added.push(name)
      connecting.push(
        this.connectRecord(rec).then(() => {
          if (rec.status === 'failed' || rec.status === 'needs-auth') {
            result.errors[name] = rec.error ?? rec.status
          }
        }),
      )
    }
    await Promise.all(connecting)
    return result
  }

  /** Connect + discover tools for one record. Never rejects: every failure is
   *  recorded on the record and its resources are closed. */
  private async connectRecord(rec: ServerRecord): Promise<void> {
    rec.status = 'pending'
    rec.error = undefined
    rec.serverInfo = undefined
    rec.tools = []
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    rec.client = client
    try {
      await this.raceConnect(rec, this.openConnection(rec, client))
      rec.tools = await this.discoverTools(rec, client)
      const version = client.getServerVersion()
      if (version) rec.serverInfo = { name: version.name, version: version.version }
      rec.status = 'connected'
      log.info(`[${rec.name}] connected (${rec.tools.length} tools)`)
    } catch (err) {
      await this.closeResources(rec)
      if (this.closing) return
      rec.error = errorMessage(err)
      rec.tools = []
      rec.status = isMcpAuthError(err) ? 'needs-auth' : 'failed'
      log.warn(`[${rec.name}] ${rec.status}: ${rec.error}`)
    }
  }

  /** Build the transport (or wire the in-memory pair) and run the handshake. */
  private async openConnection(rec: ServerRecord, client: Client): Promise<void> {
    if (rec.config.type === 'sdk') {
      const instance = rec.config.instance
      if (!instance) throw new Error('sdk entry has no server instance')
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
      await instance.connect(serverSide)
      await client.connect(clientSide)
      return
    }
    const transport = createMcpTransport(transportTarget(rec.config), {
      authProvider: this.authFor?.(rec.name),
      preferAuthProvider: true,
    })
    await client.connect(transport)
  }

  /** Race the handshake against `connectTimeoutMs`. `cancelConnect` lets
   *  closeAll reject it immediately; the losing promise's handlers stay
   *  attached, so a late settlement is never an unhandled rejection. */
  private raceConnect(rec: ServerRecord, work: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        if (rec.connectTimer) clearTimeout(rec.connectTimer)
        rec.connectTimer = undefined
        rec.cancelConnect = undefined
      }
      rec.connectTimer = setTimeout(() => {
        settle()
        reject(new Error(`connection timed out after ${this.connectTimeoutMs}ms`))
      }, this.connectTimeoutMs)
      rec.cancelConnect = () => {
        settle()
        reject(new Error('connection cancelled'))
      }
      work.then(
        () => { settle(); resolve() },
        (err) => { settle(); reject(err) },
      )
    })
  }

  /** `listTools` following `nextCursor` until exhausted. The request timeout
   *  is the connect timeout so a server that handshakes but never lists tools
   *  cannot hold `whenReady()` open. */
  private async discoverTools(rec: ServerRecord, client: Client): Promise<NativeMcpToolInfo[]> {
    const out: NativeMcpToolInfo[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: this.connectTimeoutMs,
      })
      for (const tool of page.tools) out.push(toolInfo(rec.name, tool))
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return out
  }

  /** Close a record's connection and drop its state; keeps the record itself
   *  (status is set by the caller). */
  private async closeServer(rec: ServerRecord): Promise<void> {
    rec.cancelConnect?.()
    await this.closeResources(rec)
    rec.tools = []
  }

  /** Best-effort resource teardown. Closing the client kills a stdio child. */
  private async closeResources(rec: ServerRecord): Promise<void> {
    const client = rec.client
    rec.client = undefined
    if (client) {
      try {
        await client.close()
      } catch (err) {
        log.debug(`[${rec.name}] client close failed: ${errorMessage(err)}`)
      }
    }
    const instance = rec.config.instance
    if (instance) {
      try {
        await instance.close()
      } catch (err) {
        log.debug(`[${rec.name}] instance close failed: ${errorMessage(err)}`)
      }
    }
  }

  private requireRecord(name: string): ServerRecord {
    const rec = this.records.get(name)
    if (!rec) throw new Error(`unknown MCP server: ${name}`)
    return rec
  }

  private findTool(fqn: string): { rec: ServerRecord; tool: NativeMcpToolInfo } | undefined {
    for (const rec of this.records.values()) {
      if (rec.status !== 'connected') continue
      const tool = rec.tools.find((t) => t.fqn === fqn)
      if (tool) return { rec, tool }
    }
    return undefined
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function noop(): void {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object') return false
  return Object.values(v).every((val) => typeof val === 'string')
}

/** Read one manager-resolved entry into a config plus its diff identity.
 *  Never serializes an `sdk` entry: its identity is the live instance. */
function entryOf(raw: unknown): { config: NativeMcpServerConfig; identity: unknown } {
  const r = (raw ?? {}) as Record<string, unknown>
  const type = r.type === 'sdk' || r.type === 'sse' || r.type === 'http' ? r.type : 'stdio'
  const config: NativeMcpServerConfig = { type }
  if (typeof r.command === 'string') config.command = r.command
  if (Array.isArray(r.args)) config.args = r.args.filter((a): a is string => typeof a === 'string')
  if (isStringRecord(r.env)) config.env = r.env
  if (typeof r.url === 'string') config.url = r.url
  if (isStringRecord(r.headers)) config.headers = r.headers
  if (type === 'sdk') {
    config.instance = r.instance as NativeMcpServerInstance | undefined
    return { config, identity: config.instance }
  }
  return {
    config,
    identity: JSON.stringify([
      config.type,
      config.command ?? '',
      config.args ?? [],
      config.url ?? '',
      Object.entries(config.headers ?? {}).sort(),
    ]),
  }
}

function transportTarget(config: NativeMcpServerConfig): McpTransportTarget {
  if (config.type === 'sdk') throw new Error('sdk entries do not use an MCP transport')
  const type = config.type
  return {
    type,
    command: config.command,
    args: config.args,
    env: config.env,
    url: config.url,
    headers: config.headers,
  }
}

/** Map one listed tool onto the manager's info shape. `inputSchema` is already
 *  JSON Schema; the `$schema` key is dropped because the Anthropic request
 *  tool schema does not carry it. */
function toolInfo(
  server: string,
  tool: {
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    annotations?: unknown
    _meta?: Record<string, unknown>
  },
): NativeMcpToolInfo {
  const inputSchema = { ...tool.inputSchema }
  delete inputSchema.$schema
  const info: NativeMcpToolInfo = {
    server,
    name: tool.name,
    fqn: mcpToolFqn(server, tool.name),
    rawName: tool.name,
    description: tool.description ?? '',
    inputSchema,
  }
  if (tool.annotations) info.annotations = tool.annotations as Record<string, unknown>
  if (tool._meta) info.meta = tool._meta
  return info
}

/** The API-facing status of one server's config: never env/headers. */
function configOf(config: NativeMcpServerConfig): NonNullable<NativeMcpStatus['config']> {
  const out: NonNullable<NativeMcpStatus['config']> = { type: config.type }
  if (config.command !== undefined) out.command = config.command
  if (config.args !== undefined) out.args = config.args
  if (config.url !== undefined) out.url = config.url
  return out
}

function statusTool(tool: NativeMcpToolInfo): NonNullable<NativeMcpStatus['tools']>[number] {
  const out: NonNullable<NativeMcpStatus['tools']>[number] = { name: tool.name }
  if (tool.description) out.description = tool.description
  if (tool.annotations) out.annotations = tool.annotations
  if (tool.meta) out._meta = tool.meta
  return out
}