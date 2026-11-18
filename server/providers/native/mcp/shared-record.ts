// server/providers/native/mcp/shared-record.ts
//
// One host-global shared external MCP connection's lifecycle: connect +
// discover, tool calls, resource reads, and bounded teardown, plus the
// `sharingKey` identity the refcounted registry deduplicates on. The connect /
// discover / close core is the per-session manager's (`connections.ts`) adapted
// to a single record owned by many sessions:
//
//   - Identity is `sharingKey(config)` — command + args + ENV (unlike the
//     manager's env-excluded replace-diff identity; the two keys are distinct).
//   - One mutable `AbortController` bounds the connect task (handshake AND every
//     `listTools` page) and every in-flight call. It is replaced on each connect
//     attempt. `close()` aborts it synchronously BEFORE awaiting, so teardown
//     never waits out a hung server.
//   - Per-call signals combine as `AbortSignal.any([caller, record.abort])`, so
//     one caller's abort cancels only its own call — never a sibling's and never
//     the shared connection.
//   - A failing or timing-out connect never rejects: the client is closed (which
//     kills a stdio child) and the record turns `failed` / `needs-auth` with an
//     error message. `ready` settles when the INITIAL attempt settles, so
//     callers can await first-connect readiness without watching status.
//   - Discovery populates both `tools` (currently registered) and `cachedTools`
//     (last-good, served during an outage). The stdio child PID is captured from
//     the transport for the cleanup death gate.
//
// A crash currently leaves the record `failed` with no auto-retry; the bounded
// reconnect supervisor and the cleanup death confirmation are layered on top of
// this core.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createMcpTransport, isMcpAuthError, type McpTransportTarget } from '../../../mcp-config.js'
import { mcpToolFqn } from '../../../../shared/mcp-fqn.js'
import { createLogger } from '../../../log.js'
import type { NativeMcpServerConfig, NativeMcpStatus, NativeMcpToolInfo } from './connections.js'

const log = createLogger('native-mcp-shared')

const CLIENT_INFO = { name: 'claude-react-web-native', version: '1.0.0' }
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_TOOL_TIMEOUT_MS = 120_000
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000

/** The host-global identity of a shared stdio config: command + args + env.
 *  Env entries are sorted so insertion order does not split one server into two
 *  children. Deliberately INCLUDES env, unlike the per-session replace-diff
 *  identity in `connections.ts` (which excludes it). */
export function sharingKey(config: NativeMcpServerConfig): string {
  return JSON.stringify([
    'stdio',
    config.command ?? '',
    config.args ?? [],
    Object.entries(config.env ?? {}).sort(),
  ])
}

/** Bounded exponential-backoff reconnect budget (consumed by the supervisor). */
export interface ReconnectPolicy {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
  maxAttempts: number
}

export interface SharedRecordOptions {
  /** OAuth provider for a remote server, when the host stores credentials. */
  authFor?: (name: string) => OAuthClientProvider | undefined
  connectTimeoutMs?: number // default 10_000
  toolTimeoutMs?: number // default 120_000
  /** Default { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 }. */
  reconnect?: ReconnectPolicy
  closeTimeoutMs?: number // default 5_000
}

export class SharedRecord {
  readonly key: string
  readonly config: NativeMcpServerConfig
  /** Refcount, managed by the registry. */
  users = 0
  status: NativeMcpStatus['status'] = 'pending'
  error?: string
  serverInfo?: { name: string; version: string }
  /** Currently registered tools (emptied on give-up). */
  tools: NativeMcpToolInfo[] = []
  /** Last-good discovery, served during an outage. */
  cachedTools: NativeMcpToolInfo[] = []
  /** Bounds the connect task and all in-flight calls; replaced per attempt. */
  abort = new AbortController()
  /** Settles when the INITIAL connect attempt settles (success or failure). */
  readonly ready: Promise<void>
  /** The stdio child PID (transport.pid after start); null otherwise. */
  pid: number | null = null
  cleanupFailed = false

  private readonly authFor?: (name: string) => OAuthClientProvider | undefined
  private readonly connectTimeoutMs: number
  private readonly toolTimeoutMs: number
  private readonly closeTimeoutMs: number
  private client?: Client
  private connectTimer?: ReturnType<typeof setTimeout>
  private settleReady: () => void = noop

  constructor(key: string, config: NativeMcpServerConfig, opts: SharedRecordOptions = {}) {
    this.key = key
    this.config = config
    this.authFor = opts.authFor
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.closeTimeoutMs = opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.ready = new Promise<void>((resolve) => {
      this.settleReady = resolve
    })
  }

  /** Connect + discover tools. Never rejects: every failure is recorded on the
   *  record and its resources closed. Settles `ready` when the attempt settles. */
  async connect(): Promise<void> {
    this.abort = new AbortController()
    this.status = 'pending'
    this.error = undefined
    this.serverInfo = undefined
    this.tools = []
    this.pid = null
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    this.client = client
    try {
      await this.raceConnect(this.openConnection(client))
      const discovered = await this.discoverTools(client)
      this.tools = discovered
      this.cachedTools = discovered
      const version = client.getServerVersion()
      if (version) this.serverInfo = { name: version.name, version: version.version }
      this.status = 'connected'
      log.info(`[${this.key}] connected (${discovered.length} tools)`)
    } catch (err) {
      await this.closeResources()
      this.error = errorMessage(err)
      this.tools = []
      this.status = isMcpAuthError(err) ? 'needs-auth' : 'failed'
      log.warn(`[${this.key}] ${this.status}: ${this.error}`)
    } finally {
      // Resolving an already-settled promise is a no-op, so later attempts
      // (reconnects) leave `ready` pinned to the INITIAL settlement.
      this.settleReady()
    }
  }

  /** Invoke a tool by its bare server-side name. Fails fast when the record is
   *  not connected; the caller's signal combines with the record's so one
   *  caller's abort never tears down the shared connection or a sibling call. */
  async callTool(
    rawName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    if (this.status !== 'connected' || !this.client) {
      throw new Error('MCP_SERVER_UNAVAILABLE')
    }
    // The declared return type is the union of the parsed result and the legacy
    // compatibility shape regardless of the schema passed; asking for
    // CallToolResultSchema means the former is what actually comes back.
    return (await this.client.callTool(
      { name: rawName, arguments: args },
      CallToolResultSchema,
      { timeout: this.toolTimeoutMs, signal: AbortSignal.any([signal, this.abort.signal]) },
    )) as CallToolResult
  }

  /** Forward a resource read to the connected server, result unchanged. */
  async readResource(uri: string): Promise<unknown> {
    if (this.status !== 'connected' || !this.client) {
      throw new Error('MCP server is not connected')
    }
    return this.client.readResource({ uri })
  }

  /** Abort in-flight work, then close the client under a bounded deadline.
   *  Idempotent; never throws. Aborting BEFORE awaiting is what keeps teardown
   *  from waiting out an in-flight handshake or `listTools` page. */
  async close(): Promise<void> {
    this.abort.abort()
    await this.closeResources()
    this.tools = []
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Build the transport and run the handshake, capturing the stdio child PID. */
  private async openConnection(client: Client): Promise<void> {
    const transport = createMcpTransport(transportTarget(this.config), {
      authProvider: this.authFor?.(this.key),
      preferAuthProvider: true,
    })
    await client.connect(transport)
    if (this.config.type === 'stdio') {
      this.pid = (transport as StdioClientTransport).pid ?? null
    }
  }

  /** Race the handshake against `connectTimeoutMs` and the record's abort
   *  signal. `close()` aborts that signal synchronously, so a hung handshake is
   *  rejected immediately; the losing promise's handlers stay attached, so a
   *  late settlement is never an unhandled rejection. */
  private raceConnect(work: Promise<void>): Promise<void> {
    const signal = this.abort.signal
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (err: Error | null) => {
        if (settled) return
        settled = true
        if (this.connectTimer) clearTimeout(this.connectTimer)
        this.connectTimer = undefined
        signal.removeEventListener('abort', onAbort)
        if (err) reject(err)
        else resolve()
      }
      const onAbort = () => finish(new Error('connection closed'))
      this.connectTimer = setTimeout(
        () => finish(new Error(`connection timed out after ${this.connectTimeoutMs}ms`)),
        this.connectTimeoutMs,
      )
      signal.addEventListener('abort', onAbort, { once: true })
      work.then(
        () => finish(null),
        // Reject with the original instance: `isMcpAuthError` narrows on the
        // SDK's error classes.
        (err) => finish(err instanceof Error ? err : new Error(String(err))),
      )
    })
  }

  /** `listTools` following `nextCursor` until exhausted. Every page is bounded
   *  by the record's signal plus the connect timeout, so a server that
   *  handshakes but never lists tools cannot hold the connect open. Tools are
   *  stamped with the record's global identity (its sharing key); a per-session
   *  view re-projects the model-facing FQN under its own server name. */
  private async discoverTools(client: Client): Promise<NativeMcpToolInfo[]> {
    const out: NativeMcpToolInfo[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: this.connectTimeoutMs,
        signal: this.abort.signal,
      })
      for (const tool of page.tools) out.push(toolInfo(this.key, tool))
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return out
  }

  /** Best-effort resource teardown under `closeTimeoutMs`. Closing the client
   *  kills a stdio child; a hung close is bounded so teardown never blocks. */
  private async closeResources(): Promise<void> {
    const client = this.client
    this.client = undefined
    if (client) await this.raceClose(client)
  }

  /** Race `client.close()` against the close deadline; resolves either way so
   *  `close()` never throws or hangs on a wedged child. */
  private raceClose(client: Client): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log.warn(`[${this.key}] client close exceeded ${this.closeTimeoutMs}ms`)
        resolve()
      }, this.closeTimeoutMs)
      client.close().then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (err) => {
          clearTimeout(timer)
          log.debug(`[${this.key}] client close failed: ${errorMessage(err)}`)
          resolve()
        },
      )
    })
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function noop(): void {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
 *  JSON Schema; the `$schema` key is dropped because the Anthropic request tool
 *  schema does not carry it. */
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
