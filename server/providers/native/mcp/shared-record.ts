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
//   - A bounded-backoff reconnect supervisor watches the live client's `onclose`.
//     An unexpected loss aborts the current generation (in-flight calls reject
//     `MCP_CONNECTION_CLOSED`), keeps `tools = cachedTools` registered with
//     `status:'pending'`, and retries with a fresh `Client` + transport per
//     attempt (`error` carries `reconnecting (attempt n/N)`). During the retry
//     window new calls fail fast (`MCP_SERVER_UNAVAILABLE`); on give-up
//     (attempt > maxAttempts) `tools` empties and `status:'failed'` until a
//     manual `reconnect()`. `cachedTools` is retained throughout. A `needs-auth`
//     failure does not auto-retry. The attempt budget resets only after
//     sustained uptime past `maxDelayMs`. The cleanup death confirmation is
//     layered on top of this core (Task 4).

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
const DEFAULT_RECONNECT: ReconnectPolicy = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
}

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
  private readonly policy: ReconnectPolicy
  /** Reconnect attempt count within the active outage. Reset ONLY by sustained
   *  uptime past `maxDelayMs` or a manual `reconnect()` — never by a new loss,
   *  so a flapping server still burns its budget and gives up. */
  private attempt = 0
  /** Set by `close()`; suppresses the supervisor so a closed record never retries. */
  private closed = false
  private backoffTimer?: ReturnType<typeof setTimeout>
  private uptimeTimer?: ReturnType<typeof setTimeout>
  /** Bumped by `reconnect()`; a supervisor attempt whose run token is stale
   *  stands down instead of scheduling over the manual reconnect. */
  private supervisorRun = 0
  /** Per-generation identity + loss marker, replaced on every connect attempt.
   *  `callTool` captures it so an in-flight call rejects `MCP_CONNECTION_CLOSED`
   *  when ITS generation is lost, and a stale backoff timer recognizes that a
   *  newer generation has taken over. */
  private gen = { lost: false }
  /** Serializes connect / reconnect / supervisor attempts / close teardown so
   *  two attempts never overlap (the `enqueue` pattern from `connections.ts`).
   *  `close()` still aborts synchronously BEFORE awaiting, so teardown never
   *  waits out a hung handshake. */
  private queue: Promise<void> = Promise.resolve()
  /** Non-secret diagnostic tag. The sharing `key` embeds env values (API keys),
   *  so it must never reach a log; this label carries only the command plus a
   *  one-way hash of the key, which keeps distinct configs — including ones that
   *  differ only in env — distinguishable without revealing any secret. */
  private readonly label: string
  private client?: Client
  private connectTimer?: ReturnType<typeof setTimeout>
  private settleReady: () => void = noop

  constructor(key: string, config: NativeMcpServerConfig, opts: SharedRecordOptions = {}) {
    this.key = key
    this.config = config
    this.label = `${config.command ?? 'mcp'}#${shortHash(key)}`
    this.authFor = opts.authFor
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.closeTimeoutMs = opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.policy = opts.reconnect ?? DEFAULT_RECONNECT
    this.ready = new Promise<void>((resolve) => {
      this.settleReady = resolve
    })
  }

  /** Connect + discover tools. Never rejects: every failure is recorded on the
   *  record and its resources closed. Settles `ready` when the attempt settles.
   *  Serialized on the mutation queue; tears down any prior live generation
   *  BEFORE spawning a replacement, so a reconnect never overlaps two children. */
  async connect(): Promise<void> {
    return this.enqueue(async () => {
      try {
        if (this.closed) return
        const outcome = await this.runAttempt()
        if (!outcome.ok && !this.closed) this.applyTerminalFailure(outcome.err)
      } finally {
        // Resolving an already-settled promise is a no-op, so later attempts
        // (reconnects) leave `ready` pinned to the INITIAL settlement.
        this.settleReady()
      }
    })
  }

  /** Manual reconnect: cancel any pending backoff, invalidate the supervisor's
   *  current run, and run a fresh connect (which tears down the old generation
   *  first). Revives a gave-up record; a later crash re-arms the supervisor.
   *  Task 4 adds the cleanup death gate. */
  async reconnect(): Promise<void> {
    this.cancelBackoff()
    this.clearUptimeTimer()
    this.supervisorRun++
    this.closed = false
    this.attempt = 0
    this.error = undefined
    await this.connect()
  }

  /** Invoke a tool by its bare server-side name. Fails fast when the record is
   *  not connected; the caller's signal combines with the record's so one
   *  caller's abort never tears down the shared connection or a sibling call. */
  async callTool(
    rawName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const client = this.client
    if (this.status !== 'connected' || !client) {
      throw new Error('MCP_SERVER_UNAVAILABLE')
    }
    const gen = this.gen
    try {
      // The declared return type is the union of the parsed result and the legacy
      // compatibility shape regardless of the schema passed; asking for
      // CallToolResultSchema means the former is what actually comes back.
      return (await client.callTool(
        { name: rawName, arguments: args },
        CallToolResultSchema,
        { timeout: this.toolTimeoutMs, signal: AbortSignal.any([signal, this.abort.signal]) },
      )) as CallToolResult
    } catch (err) {
      // The caller's own abort stays local (sibling-safe). Otherwise, if THIS
      // call's generation was lost, surface MCP_CONNECTION_CLOSED regardless of
      // which SDK path rejected first (the transport-close handler or the
      // generation abort).
      if (!signal.aborted && gen.lost) {
        throw new Error('MCP_CONNECTION_CLOSED', { cause: err })
      }
      throw err
    }
  }

  /** Forward a resource read to the connected server, result unchanged. */
  async readResource(uri: string): Promise<unknown> {
    const client = this.client
    if (this.status !== 'connected' || !client) {
      throw new Error('MCP server is not connected')
    }
    return client.readResource({ uri })
  }

  /** Abort in-flight work, then close the client under a bounded deadline.
   *  Idempotent; never throws. Aborting BEFORE awaiting is what keeps teardown
   *  from waiting out an in-flight handshake or `listTools` page. Cancels the
   *  reconnect supervisor so a closed record never retries. */
  async close(): Promise<void> {
    this.closed = true
    this.cancelBackoff()
    this.clearUptimeTimer()
    this.abort.abort()
    await this.enqueue(async () => {
      await this.closeResources()
      this.tools = []
    })
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Run `task` after every earlier mutation has settled. The returned promise
   *  carries the task's rejection to its caller, but the queue itself never
   *  rejects, so one failed task cannot poison the next. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(noop, noop)
    return run
  }

  /** One fresh-generation connect attempt: tear down the previous generation,
   *  then handshake + discover. Never rejects; returns the error on failure for
   *  the caller to apply its status policy (terminal vs outage). Does NOT clear
   *  `tools`/`error` at start, so cached tools stay registered and the attempt
   *  count stays visible throughout a reconnect attempt. */
  private async runAttempt(): Promise<{ ok: true } | { ok: false; err: unknown }> {
    // Tear down the previous generation BEFORE spawning a replacement so a
    // reconnect never overlaps two children (and a freed child is gone first).
    this.abort.abort()
    await this.closeResources()
    this.abort = new AbortController()
    this.gen = { lost: false }
    this.status = 'pending'
    this.pid = null
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    this.client = client
    client.onclose = () => this.handleLoss(client)
    try {
      await this.raceConnect(this.openConnection(client))
      const discovered = await this.discoverTools(client)
      this.tools = discovered
      this.cachedTools = discovered
      const version = client.getServerVersion()
      if (version) this.serverInfo = { name: version.name, version: version.version }
      this.status = 'connected'
      this.error = undefined
      this.armUptimeReset()
      log.info(`[${this.label}] connected (${discovered.length} tools)`)
      return { ok: true }
    } catch (err) {
      await this.closeResources()
      return { ok: false, err }
    }
  }

  /** Terminal failure policy: unregister tools and record failed / needs-auth. */
  private applyTerminalFailure(err: unknown): void {
    this.error = errorMessage(err)
    this.tools = []
    this.status = isMcpAuthError(err) ? 'needs-auth' : 'failed'
    log.warn(`[${this.label}] ${this.status}: ${this.error}`)
  }

  /** The live client closed. Only an UNEXPECTED loss of a connected generation
   *  enters the outage: a stale generation (already replaced / deliberately
   *  disposed) or a loss during an in-flight attempt is ignored — the attempt's
   *  own failure path owns that retry. */
  private handleLoss(client: Client): void {
    if (this.client !== client || this.closed) return
    if (this.status !== 'connected') return
    this.gen.lost = true
    // Abort synchronously so in-flight calls reject NOW (callTool translates to
    // MCP_CONNECTION_CLOSED), not after the backoff delay.
    this.abort.abort()
    this.clearUptimeTimer()
    log.warn(`[${this.label}] connection lost; entering reconnect outage`)
    this.scheduleReconnect(new Error('connection lost'))
  }

  /** Schedule the next bounded-backoff reconnect attempt, or give up when the
   *  budget is exhausted. Keeps cached tools registered during the retry window. */
  private scheduleReconnect(lastErr: unknown): void {
    this.cancelBackoff()
    if (!this.policy.enabled) {
      this.applyTerminalFailure(lastErr)
      return
    }
    this.attempt++
    if (this.attempt > this.policy.maxAttempts) {
      this.tools = []
      this.status = 'failed'
      this.error = `reconnect gave up after ${this.policy.maxAttempts} attempts: ${errorMessage(lastErr)}`
      log.warn(`[${this.label}] reconnect gave up after ${this.policy.maxAttempts} attempts`)
      return
    }
    const delay = Math.min(this.policy.maxDelayMs, this.policy.initialDelayMs * 2 ** (this.attempt - 1))
    this.status = 'pending'
    this.tools = this.cachedTools
    this.error = `reconnecting (attempt ${this.attempt}/${this.policy.maxAttempts})`
    log.info(`[${this.label}] ${this.error} in ${delay}ms`)
    const gen = this.gen
    const run = this.supervisorRun
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = undefined
      // Stand down if closed, superseded by a manual reconnect, or a newer
      // generation has taken over since this timer was armed.
      if (this.closed || run !== this.supervisorRun || this.gen !== gen) return
      void this.enqueue(() => this.runReconnectAttempt(run))
    }, delay)
  }

  /** One supervisor reconnect attempt. On success the uptime reset is armed by
   *  runAttempt; on a non-auth failure schedule the next backoff (or give up).
   *  needs-auth does not auto-retry. */
  private async runReconnectAttempt(run: number): Promise<void> {
    if (this.closed || run !== this.supervisorRun) return
    const outcome = await this.runAttempt()
    if (this.closed || run !== this.supervisorRun) return
    if (outcome.ok) return
    if (isMcpAuthError(outcome.err)) {
      this.applyTerminalFailure(outcome.err)
      return
    }
    this.scheduleReconnect(outcome.err)
  }

  /** Reset the attempt budget only after the connection has stayed up past
   *  maxDelayMs, so a server that flaps faster than that still burns its budget. */
  private armUptimeReset(): void {
    this.clearUptimeTimer()
    if (!this.policy.enabled) return
    this.uptimeTimer = setTimeout(() => {
      this.uptimeTimer = undefined
      if (this.status === 'connected') this.attempt = 0
    }, this.policy.maxDelayMs)
  }

  private cancelBackoff(): void {
    if (this.backoffTimer) clearTimeout(this.backoffTimer)
    this.backoffTimer = undefined
  }

  private clearUptimeTimer(): void {
    if (this.uptimeTimer) clearTimeout(this.uptimeTimer)
    this.uptimeTimer = undefined
  }

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
        log.warn(`[${this.label}] client close exceeded ${this.closeTimeoutMs}ms`)
        resolve()
      }, this.closeTimeoutMs)
      client.close().then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (err) => {
          clearTimeout(timer)
          log.debug(`[${this.label}] client close failed: ${errorMessage(err)}`)
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

/** Stable 8-hex FNV-1a hash (same algorithm as `shared/mcp-fqn.ts`). One-way, so
 *  hashing the env-bearing sharing key yields a distinguishable log tag without
 *  exposing the env values it embeds. */
function shortHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
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
