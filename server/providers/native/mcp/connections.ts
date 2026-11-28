// server/providers/native/mcp/connections.ts
//
// Per-session MCP connection VIEW for the native provider. Two kinds of entry
// share one discovery / call / status surface:
//
//   - LOCAL entries (`type:'sdk'` first-party in-process servers over an
//     `InMemoryTransport` pair, and `sse`/`http` remote sockets, plus external
//     `stdio` when no registry is supplied) own a per-session `Client` and the
//     connect / discover / close lifecycle below.
//   - SHARED entries (`type:'stdio'` WITH a `SharedRegistry`) delegate to one
//     host-global `SharedRecord` per `sharingKey(config)`, refcounted across
//     sessions, so N sessions with an identical stdio config drive ONE child.
//     The view holds a ref (acquire/release) and re-projects the record's tools
//     under its own session-local server name. sdk/sse/http NEVER reach the
//     registry: sdk is cwd-bound and in-process, sse/http own a socket per
//     session, and `sharingKey` hardcodes 'stdio' (a non-stdio config would
//     collapse onto one key).
//
// Lifetime rules:
//   - Entries are FINGERPRINTED, never serialized. An `sdk` entry holds a live
//     server instance, and `JSON.stringify` on it throws on the circular refs;
//     its identity is the instance itself. A LOCAL external entry's identity is
//     the serializable fields only (headers but not env — changing an env value
//     does not reconnect, matching the replace diff's documented behavior). A
//     SHARED stdio entry's identity is the env-INCLUDED `sharingKey`, so an
//     env-only change acquires a new child and releases the old. The two keys
//     are distinct.
//   - Every `setServers` closes and reconnects all `type:'sdk'` servers: the
//     manager's `injectAll` builds fresh server instances per call, so their
//     identities differ by construction. That is correct and cheap (in-process).
//   - An unchanged server is KEPT AS IS by `setServers`, including one that is
//     already `failed` — a replace is not a retry. Use `reconnect(name)` to
//     retry a server; otherwise a permanently broken server would be
//     re-attempted on every replace.
//   - Every mutation (load / setServers / reconnect / toggle / closeAll) runs
//     serialized on one queue; `whenReady()` is that queue, so callers that
//     need discovered tools just await it.
//   - Each LOCAL record owns an `AbortController` that bounds its whole connect
//     task (handshake AND every `listTools` page) and its in-flight tool calls.
//     `closeServer` / `closeAll` abort it synchronously BEFORE awaiting, so
//     teardown never waits out a hung server. A SHARED entry owns a VIEW-level
//     `AbortController` bounding only THIS view's in-flight calls; the shared
//     record's own abort is owned by the registry (one view's teardown never
//     cancels a sibling's calls). `closeAll` aborts every view-level controller
//     synchronously, then releases shared refs / closes local records.
//   - A failing or timing-out server never rejects a mutation and never leaks
//     a child process: the client is closed (which kills a stdio child), the
//     in-process instance is closed, and the record turns `failed` /
//     `needs-auth` with an error message.
//   - Tool / status / call routing keys off the record's live STATUS
//     (`connected` → tools; otherwise empty / fail-fast), never merely its
//     `ready` promise: a revival acquirer can hold a record whose `ready` is
//     already resolved but whose status is still `pending`/`disabled`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpTransportTarget } from '../../../../shared/mcp-transport.js'
import { mcpToolFqn } from '../../../../shared/mcp-fqn.js'
import type { NativeMcpTransportPort } from '../ports.js'
import { createLogger } from '../../../log.js'
import { capToolText } from '../tools/bash.js'
import { sharingKey, type SharedRecord } from './shared-record.js'
import type { SharedRegistry } from './shared-registry.js'

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

/** One `resources/list` entry, with the shape the CLI's resource tools expose. */
export interface NativeMcpResourceEntry {
  uri: string
  name: string
  mimeType?: string
  description?: string
}

/** One server's answer to `RefreshMcpTools`: `not_connected` means the tool
 *  never dials — it only re-reads an existing connection. */
export interface NativeMcpRefreshResult {
  server: string
  status: 'refreshed' | 'not_connected'
  toolCount: number
  added: string[]
  removed: string[]
}

export interface NativeMcpStatus {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  serverInfo?: { name: string; version: string }
  error?: string
  /** Never carries `env` or `headers`; `args` is included deliberately. */
  config?: { type: string; command?: string; args?: string[]; url?: string }
  /** `global` for a shared stdio record (host-wide), `session` for a local one. */
  scope: 'session' | 'global'
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
  /** Host MCP transport construction + auth-failure classification. Required:
   *  the native provider owns no transport implementation of its own. */
  transportPort: NativeMcpTransportPort
  /** OAuth provider for a remote server, when the host stores credentials. */
  authFor?: (name: string) => OAuthClientProvider | undefined
  connectTimeoutMs?: number
  toolTimeoutMs?: number
  /** Host-global shared registry for external stdio entries. Absent → legacy
   *  per-session behavior (every entry local), so standalone tests still work. */
  registry?: SharedRegistry
}

/** A per-session connection (sdk / sse / http, and stdio without a registry). */
interface ServerRecord {
  kind: 'local'
  name: string
  config: NativeMcpServerConfig
  /** Replace-diff identity: the live instance for `type:'sdk'`, a JSON
   *  fingerprint of the serializable fields otherwise (env excluded). */
  identity: unknown
  client?: Client
  connectTimer?: ReturnType<typeof setTimeout>
  /** Bounds this record's connect task (handshake + tool discovery) and its
   *  in-flight tool calls. Replaced on every connect attempt. */
  abort: AbortController
  status: NativeMcpStatus['status']
  serverInfo?: { name: string; version: string }
  error?: string
  tools: NativeMcpToolInfo[]
}

/** A view over one host-global shared stdio record. `enabled` tracks whether
 *  THIS view currently holds a ref: toggle(false) releases it (enabled false),
 *  toggle(true) re-acquires. closeAll skips an already-released entry, so a
 *  toggle-off followed by closeAll never double-releases. */
interface SharedEntry {
  kind: 'shared'
  name: string
  config: NativeMcpServerConfig
  /** Replace-diff identity: the env-INCLUDED sharing key (registry dedup). */
  identity: string
  record: SharedRecord
  enabled: boolean
  /** Bounds THIS view's in-flight calls only; aborted on toggle-off / closeAll
   *  so one view's teardown never cancels a sibling's calls on the record. */
  abort: AbortController
}

type Entry = ServerRecord | SharedEntry

export class NativeMcpConnections {
  private readonly transportPort: NativeMcpTransportPort
  private readonly authFor?: (name: string) => OAuthClientProvider | undefined
  private readonly connectTimeoutMs: number
  private readonly toolTimeoutMs: number
  private readonly registry?: SharedRegistry

  private readonly records = new Map<string, Entry>()
  private queue: Promise<void> = Promise.resolve()
  private closing = false

  constructor(opts: NativeMcpConnectionsOptions) {
    this.transportPort = opts.transportPort
    this.authFor = opts.authFor
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.registry = opts.registry
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
      .map((entry) => (entry.kind === 'local' ? this.localStatus(entry) : this.sharedStatus(entry)))
  }

  /** Discovered tools of every connected server, in status (name) order. Each
   *  entry is copied so a consumer cannot mutate the stored tool list the next
   *  `call` resolves against. Shared tools are re-projected under this view's
   *  session-local server name (the record stamps them with the raw env-bearing
   *  sharing key, which must never reach a client / model / log surface). */
  tools(): NativeMcpToolInfo[] {
    const out: NativeMcpToolInfo[] = []
    for (const entry of [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.kind === 'local') {
        if (entry.status === 'connected') for (const tool of entry.tools) out.push({ ...tool })
      } else if (entry.enabled && entry.record.status === 'connected') {
        out.push(...this.sharedToolInfos(entry))
      }
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
    const { entry, tool } = found
    // The caller's signal combines with the entry's view-level abort (and, for
    // a shared record, the record's own abort inside `callTool`), so one view's
    // teardown cancels its own in-flight call without touching a sibling's.
    const callSignal = AbortSignal.any([signal, entry.abort.signal])
    const result = entry.kind === 'local'
      // The declared return type is the union of the parsed result and the
      // legacy compatibility shape regardless of the schema passed; asking for
      // CallToolResultSchema means the former is what actually comes back.
      ? ((await entry.client!.callTool(
          { name: tool.rawName, arguments: args },
          CallToolResultSchema,
          { timeout: this.toolTimeoutMs, signal: callSignal },
        )) as CallToolResult)
      : await entry.record.callTool(tool.rawName, args, callSignal)
    const parts: string[] = []
    for (const block of result.content) {
      // Text blocks are the payload; anything else (image / audio / embedded
      // resource) is preserved verbatim so the model sees its structure.
      if (block.type === 'text') parts.push(block.text)
      else parts.push(JSON.stringify(block))
    }
    const out: { text: string; isError?: boolean } = { text: capToolText(textOf(result, parts)) }
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
      const entry = this.requireEntry(name)
      if (entry.kind === 'local') {
        await this.closeServer(entry)
        await this.connectRecord(entry)
        return
      }
      // A disabled shared entry holds NO ref; reconnecting the record at users 0
      // would revive an UNOWNED connected child. Re-acquire ownership instead
      // (the acquire connects a fresh record, or joins a retained blocked one).
      if (!entry.enabled) {
        await this.acquireShared(entry)
        return
      }
      await entry.record.reconnect()
    })
  }

  /** Disable a server (hide tools + drop the ref / close) or connect it again. */
  async toggle(name: string, enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.requireEntry(name)
      if (entry.kind === 'local') {
        if (enabled) {
          if (entry.status === 'connected') return
          await this.closeServer(entry)
          await this.connectRecord(entry)
          return
        }
        await this.closeServer(entry)
        entry.status = 'disabled'
        entry.error = undefined
        entry.serverInfo = undefined
        entry.tools = []
        return
      }
      if (enabled) {
        if (entry.enabled && entry.record.status === 'connected') return
        if (entry.enabled) {
          // Enabled but not connected (failed / outage): a global retry.
          await entry.record.reconnect()
          return
        }
        await this.acquireShared(entry)
        return
      }
      await this.releaseShared(entry)
    })
  }

  /** Every configured server name, in status (name) order. */
  serverNames(): string[] {
    return [...this.records.keys()].sort((a, b) => a.localeCompare(b))
  }

  /** The server's declared capabilities, or undefined while it is not
   *  connected. The `resources` key is the CLI's gate for resource listing. */
  capabilities(name: string): Record<string, unknown> | undefined {
    const entry = this.records.get(name)
    if (!entry) return undefined
    if (entry.kind === 'local') {
      return entry.status === 'connected'
        ? (entry.client?.getServerCapabilities() as Record<string, unknown> | undefined)
        : undefined
    }
    if (!entry.enabled || entry.record.status !== 'connected') return undefined
    return entry.record.serverCapabilities()
  }

  /** `resources/list` for one connected server, following `nextCursor` until
   *  exhausted. Throws when the server is unknown or not connected; returns
   *  `[]` for a connected server that advertises no resource support. */
  async listResources(name: string, signal: AbortSignal): Promise<NativeMcpResourceEntry[]> {
    await this.queue
    const entry = this.records.get(name)
    if (!entry) throw new Error(`unknown MCP server: ${name}`)
    if (!(this.capabilities(name)?.resources)) return []
    if (entry.kind === 'local') {
      const client = entry.client
      if (entry.status !== 'connected' || !client) throw new Error(`MCP server "${name}" is not connected`)
      const out: NativeMcpResourceEntry[] = []
      let cursor: string | undefined
      do {
        const page = await client.listResources(cursor === undefined ? undefined : { cursor }, {
          timeout: this.toolTimeoutMs,
          signal: AbortSignal.any([signal, entry.abort.signal]),
        })
        for (const resource of page.resources) {
          out.push({
            uri: resource.uri,
            name: resource.name,
            ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
            ...(resource.description !== undefined ? { description: resource.description } : {}),
          })
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return out
    }
    if (!entry.enabled || entry.record.status !== 'connected') {
      throw new Error(`MCP server "${name}" is not connected`)
    }
    return entry.record.listResources(signal)
  }

  /** Re-read the tool list of one (or every) CONNECTED server over the live
   *  connection and report which names appeared or disappeared. Never dials:
   *  a server that is not connected comes back `not_connected`. Serialized on
   *  the mutation queue so a reconnect cannot swap a client mid-listing. */
  async refreshTools(name: string | undefined, signal: AbortSignal): Promise<NativeMcpRefreshResult[]> {
    return this.enqueue(async () => {
      const targets = name === undefined
        ? [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name))
        : [this.requireEntry(name)]
      const out: NativeMcpRefreshResult[] = []
      for (const entry of targets) {
        const connected = entry.kind === 'local'
          ? entry.status === 'connected' && entry.client !== undefined
          : entry.enabled && entry.record.status === 'connected'
        if (!connected) {
          out.push({ server: entry.name, status: 'not_connected', toolCount: 0, added: [], removed: [] })
          continue
        }
        if (entry.kind === 'local') {
          const before = new Set(entry.tools.map((tool) => tool.name))
          const client = entry.client!
          const next = client.getServerCapabilities()?.tools === undefined
            ? []
            : await this.discoverTools(entry, client, signal)
          const after = new Set(next.map((tool) => tool.name))
          entry.tools = next
          out.push({
            server: entry.name,
            status: 'refreshed',
            toolCount: next.length,
            added: [...after].filter((toolName) => !before.has(toolName)),
            removed: [...before].filter((toolName) => !after.has(toolName)),
          })
          continue
        }
        const result = await entry.record.refreshTools()
        out.push({ server: entry.name, status: 'refreshed', ...result })
      }
      return out
    })
  }

  /** Forward a resource read to a connected server, result unchanged. */
  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<unknown> {
    await this.queue
    const entry = this.records.get(name)
    if (!entry) throw new Error(`unknown MCP server: ${name}`)
    if (entry.kind === 'local') {
      if (entry.status !== 'connected' || !entry.client) {
        throw new Error(`MCP server "${name}" is not connected`)
      }
      const callSignal = signal === undefined ? entry.abort.signal : AbortSignal.any([signal, entry.abort.signal])
      return entry.client.readResource({ uri }, { signal: callSignal })
    }
    if (!entry.enabled || entry.record.status !== 'connected') {
      throw new Error(`MCP server "${name}" is not connected`)
    }
    return entry.record.readResource(uri)
  }

  /** Close every local client / in-process instance and release every shared
   *  ref, then clear the map. Idempotent; never throws. */
  async closeAll(): Promise<void> {
    this.closing = true
    // Abort in-flight work synchronously so this does not wait out a hanging
    // handshake or tool listing; the queue then drains with those attempts
    // settled. For shared entries this aborts only the VIEW's call signal — the
    // registry's release owns the record's own abort at users 0.
    for (const entry of this.records.values()) entry.abort.abort()
    await this.enqueue(async () => {
      const entries = [...this.records.values()]
      this.records.clear()
      await Promise.all(entries.map((entry) => (
        entry.kind === 'local' ? this.closeResources(entry) : this.releaseShared(entry)
      )))
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
    for (const [name, raw] of Object.entries(servers ?? {})) next.set(name, this.entryOf(raw))

    // Removed and changed: close first so a changed name never holds two live
    // connections (and so a freed stdio child is gone before its replacement
    // spawns). For a shared entry this awaits the registry release (full
    // teardown at users 0) BEFORE the add loop acquires the replacement.
    for (const [name, entry] of [...this.records]) {
      const entryNext = next.get(name)
      if (entryNext && Object.is(entryNext.identity, entry.identity)) continue
      this.records.delete(name)
      await this.closeEntry(entry)
      result.removed.push(name)
    }

    const connecting: Promise<void>[] = []
    for (const [name, entry] of next) {
      if (this.records.has(name)) continue
      // STDIO-ONLY gate: only external stdio with a registry goes shared; sdk /
      // sse / http (and stdio without a registry) stay local.
      if (this.registry && entry.config.type === 'stdio') {
        const shared: SharedEntry = {
          kind: 'shared',
          name,
          config: entry.config,
          identity: entry.identity as string,
          record: this.registry.acquire(entry.config),
          enabled: true,
          abort: new AbortController(),
        }
        this.records.set(name, shared)
        result.added.push(name)
        connecting.push(shared.record.ready.then(() => {
          if (shared.enabled && (shared.record.status === 'failed' || shared.record.status === 'needs-auth')) {
            result.errors[name] = shared.record.error ?? shared.record.status
          }
        }))
        continue
      }
      const rec: ServerRecord = {
        kind: 'local',
        name,
        config: entry.config,
        identity: entry.identity,
        abort: new AbortController(),
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

  /** Read one manager-resolved entry into a config plus its diff identity.
   *  Never serializes an `sdk` entry: its identity is the live instance. A
   *  shared stdio entry's identity is the env-INCLUDED sharing key; every other
   *  entry keeps the env-EXCLUDED replace-diff fingerprint. */
  private entryOf(raw: unknown): { config: NativeMcpServerConfig; identity: unknown } {
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
    if (this.registry && type === 'stdio') return { config, identity: sharingKey(config) }
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

  /** Acquire (or re-acquire) a shared ref for the entry and await its initial
   *  connect. Used by toggle(true) / reconnect on a disabled entry. */
  private async acquireShared(entry: SharedEntry): Promise<void> {
    entry.abort = new AbortController()
    entry.record = this.registry!.acquire(entry.config)
    entry.enabled = true
    await entry.record.ready
  }

  /** Release this view's shared ref (no-op if already released). Aborts the
   *  view's call signal first; the registry owns the record's teardown at 0. */
  private async releaseShared(entry: SharedEntry): Promise<void> {
    if (!entry.enabled) return
    entry.enabled = false
    entry.abort.abort()
    await this.registry!.release(entry.record)
  }

  private async closeEntry(entry: Entry): Promise<void> {
    if (entry.kind === 'local') {
      await this.closeServer(entry)
      return
    }
    await this.releaseShared(entry)
  }

  /** Re-project a shared record's tools under this view's session-local name.
   *  The record stamps `server`/`fqn` with the raw env-bearing sharing key; the
   *  view replaces both so the key never reaches a client / model / log surface.
   *  `rawName` is preserved so `callTool` still addresses the server-side name. */
  private sharedToolInfos(entry: SharedEntry): NativeMcpToolInfo[] {
    return entry.record.tools.map((tool) => ({
      ...tool,
      server: entry.name,
      fqn: mcpToolFqn(entry.name, tool.rawName),
    }))
  }

  private localStatus(rec: ServerRecord): NativeMcpStatus {
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
  }

  private sharedStatus(entry: SharedEntry): NativeMcpStatus {
    const rec = entry.record
    const connected = entry.enabled && rec.status === 'connected'
    const status: NativeMcpStatus = {
      name: entry.name,
      status: entry.enabled ? rec.status : 'disabled',
      scope: 'global',
      config: configOf(entry.config),
      tools: connected ? this.sharedToolInfos(entry).map(statusTool) : [],
    }
    if (entry.enabled && rec.serverInfo) status.serverInfo = rec.serverInfo
    if (entry.enabled && rec.error) status.error = rec.error
    return status
  }

  /** Connect + discover tools for one local record. Never rejects: every failure
   *  is recorded on the record and its resources are closed. */
  private async connectRecord(rec: ServerRecord): Promise<void> {
    rec.abort = new AbortController()
    rec.status = 'pending'
    rec.error = undefined
    rec.serverInfo = undefined
    rec.tools = []
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    rec.client = client
    try {
      await this.raceConnect(rec, this.openConnection(rec, client))
      // A resource-only server advertises NO `tools` capability, and asking
      // `tools/list` anyway answers -32601 Method not found — which used to fail
      // the whole connection. Discovery follows the declared capability.
      rec.tools = client.getServerCapabilities()?.tools === undefined
        ? []
        : await this.discoverTools(rec, client)
      const version = client.getServerVersion()
      if (version) rec.serverInfo = { name: version.name, version: version.version }
      rec.status = 'connected'
      log.info(`[${rec.name}] connected (${rec.tools.length} tools)`)
    } catch (err) {
      await this.closeResources(rec)
      if (this.closing) return
      rec.error = errorMessage(err)
      rec.tools = []
      rec.status = this.transportPort.isAuthError(err) ? 'needs-auth' : 'failed'
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
    const transport = this.transportPort.createTransport(transportTarget(rec.config), {
      authProvider: this.authFor?.(rec.name),
      preferAuthProvider: true,
    })
    await client.connect(transport)
  }

  /** Race the handshake against `connectTimeoutMs` and the record's abort
   *  signal. `closeAll` / `closeServer` abort that signal synchronously, so a
   *  hung handshake is rejected immediately; the losing promise's handlers stay
   *  attached, so a late settlement is never an unhandled rejection. */
  private raceConnect(rec: ServerRecord, work: Promise<void>): Promise<void> {
    const signal = rec.abort.signal
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (err: Error | null) => {
        if (settled) return
        settled = true
        if (rec.connectTimer) clearTimeout(rec.connectTimer)
        rec.connectTimer = undefined
        signal.removeEventListener('abort', onAbort)
        if (err) reject(err)
        else resolve()
      }
      const onAbort = () => finish(new Error('connection closed'))
      rec.connectTimer = setTimeout(
        () => finish(new Error(`connection timed out after ${this.connectTimeoutMs}ms`)),
        this.connectTimeoutMs,
      )
      signal.addEventListener('abort', onAbort, { once: true })
      work.then(
        () => finish(null),
        // Reject with the original instance: the transport port's `isAuthError`
        // narrows on the SDK's error classes.
        (err) => finish(err instanceof Error ? err : new Error(String(err))),
      )
    })
  }

  /** `listTools` following `nextCursor` until exhausted. Every page is bounded
   *  by the record's signal plus the connect timeout, so a server that
   *  handshakes but never lists tools cannot hold `whenReady()` open. */
  private async discoverTools(
    rec: ServerRecord,
    client: Client,
    signal?: AbortSignal,
  ): Promise<NativeMcpToolInfo[]> {
    const out: NativeMcpToolInfo[] = []
    const callSignal = signal === undefined ? rec.abort.signal : AbortSignal.any([signal, rec.abort.signal])
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: this.connectTimeoutMs,
        signal: callSignal,
      })
      for (const tool of page.tools) out.push(toolInfo(rec.name, tool))
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return out
  }

  /** Close a local record's connection and drop its state; keeps the record
   *  itself (status is set by the caller). Aborting BEFORE awaiting is what
   *  keeps teardown from waiting out an in-flight handshake or `listTools` page. */
  private async closeServer(rec: ServerRecord): Promise<void> {
    rec.abort.abort()
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

  private requireEntry(name: string): Entry {
    const entry = this.records.get(name)
    if (!entry) throw new Error(`unknown MCP server: ${name}`)
    return entry
  }

  private findTool(fqn: string): { entry: Entry; tool: NativeMcpToolInfo } | undefined {
    for (const entry of this.records.values()) {
      if (entry.kind === 'local') {
        if (entry.status !== 'connected') continue
        const tool = entry.tools.find((t) => t.fqn === fqn)
        if (tool) return { entry, tool }
      } else {
        if (!entry.enabled || entry.record.status !== 'connected') continue
        const tool = this.sharedToolInfos(entry).find((t) => t.fqn === fqn)
        if (tool) return { entry, tool }
      }
    }
    return undefined
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function noop(): void {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The text a tool result contributes to the conversation. A legal empty
 *  `content: []` (or a structured-content-only result) would otherwise produce
 *  an empty text block, which the Messages API rejects on the NEXT round. */
function textOf(result: CallToolResult, parts: string[]): string {
  const joined = parts.join('\n')
  if (joined !== '') return joined
  if (result.structuredContent !== undefined) {
    const json = JSON.stringify(result.structuredContent)
    if (json !== '') return json
  }
  return '(no output)'
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object') return false
  return Object.values(v).every((val) => typeof val === 'string')
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

/** The API-facing status of one server's config: never env/headers. Returns a
 *  fresh object with a copied `args`, so a caller editing the status cannot
 *  change the stored config the next reconnect uses. */
function configOf(config: NativeMcpServerConfig): NonNullable<NativeMcpStatus['config']> {
  const out: NonNullable<NativeMcpStatus['config']> = { type: config.type }
  if (config.command !== undefined) out.command = config.command
  if (config.args !== undefined) out.args = [...config.args]
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
