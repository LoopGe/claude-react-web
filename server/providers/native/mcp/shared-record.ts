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
//     sustained uptime past `maxDelayMs`.
//   - Cleanup is fail-closed: `close()` races `client.close()` against
//     `closeTimeoutMs`, then confirms the stdio child actually exited by
//     reading its birth-time identity under a second `closeTimeoutMs` window.
//     The identity source is capability-gated: a sticky self-PID probe decides
//     once per process whether the koffi FFI works — available reads go through
//     `processIdentity` directly (microsecond death confirmation, no
//     PowerShell on the teardown path), and only koffi-absent hosts fall back
//     to `captureBirthTime`'s PowerShell leg. The confirmation cadence follows
//     the same capability: cheap reads poll at `EXIT_POLL_MS`, while blocking
//     reads (the PowerShell leg, or an injected probe of unknown cost) take
//     one immediate read, an async sleep to the deadline, and one final read —
//     a hung close must not busy-poll a blocking spawnSync and freeze the
//     event loop. A child still alive at that deadline sets `cleanupFailed`
//     (no automatic force-kill — the gate guards replacement); the verdict is
//     sticky, so a re-close of a retained record skips re-confirmation. A
//     `cleanupFailed` record refuses manual
//     `reconnect()` until the child's death is confirmed: the
//     identity must read null, so a recycled PID (a different birth-time
//     identity) can never pass. Only an allowed reconnect clears the flag,
//     and the gate runs INSIDE the serialized mutation queue so it observes
//     an in-flight close's settled verdict. Residual degraded edge: when BOTH
//     identity sources fail on a live child the read is null and death is
//     indistinguishable from unreadable — fail-closed is not claimed there.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpTransportTarget } from '../../../../shared/mcp-transport.js'
import { mcpToolFqn } from '../../../../shared/mcp-fqn.js'
import type { NativeMcpTransportPort } from '../ports.js'
import { createLogger } from '../../../log.js'
import { captureBirthTime, processIdentity } from '../../../win32-job.js'
import type {
  NativeMcpPrompt,
  NativeMcpResourceEntry,
  NativeMcpServerConfig,
  NativeMcpStatus,
  NativeMcpToolInfo,
} from './connections.js'

const log = createLogger('native-mcp-shared')

const CLIENT_INFO = { name: 'claude-react-web-native', version: '1.0.0' }
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_TOOL_TIMEOUT_MS = 120_000
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
/** Poll cadence of the child-exit confirmation when identity reads are cheap
 *  (microsecond FFI / `kill(pid, 0)`). Blocking reads get a coarse two-read
 *  cadence instead — see `confirmChildExit`. */
const EXIT_POLL_MS = 25
const DEFAULT_RECONNECT: ReconnectPolicy = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
}

/** The host-global identity of a shared stdio config: command + args + env.
 *  Env entries are sorted BY KEY so insertion order does not split one server
 *  into two children (a coerced "k,v" pair compare can tie on comma-bearing
 *  keys and fall back to insertion order). Deliberately INCLUDES env, unlike
 *  the per-session replace-diff identity in `connections.ts` (which excludes
 *  it). */
export function sharingKey(config: NativeMcpServerConfig): string {
  return JSON.stringify([
    'stdio',
    config.command ?? '',
    config.args ?? [],
    Object.entries(config.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ])
}

/** Sticky FFI-availability capability probe: the self PID is always alive and
 *  readable when the koffi bindings work, so a non-null
 *  `processIdentity(process.pid)` proves FFI availability; null means koffi is
 *  absent. Cached for the process lifetime, mirroring the stickiness of
 *  win32-job's capability failures. */
let ffiAvailable: boolean | undefined
function ffiIdentityAvailable(): boolean {
  ffiAvailable ??= processIdentity(process.pid) !== null
  return ffiAvailable
}

/** Whether the DEFAULT identity probe reads cheaply: microsecond FFI on win32
 *  with koffi, `kill(pid, 0)` on POSIX. Only the koffi-absent win32 leg blocks
 *  the event loop (`captureBirthTime`'s synchronous PowerShell spawn,
 *  ~0.5-0.9s per read), and the exit confirmation gives blocking reads a
 *  coarse two-read cadence instead of the `EXIT_POLL_MS` poll. */
function defaultIdentityReadIsCheap(): boolean {
  return process.platform !== 'win32' || ffiIdentityAvailable()
}

/** Liveness + identity probe for one child PID, the default behind the
 *  cleanup death gate. The win32 identity source is CAPABILITY-GATED: when
 *  the sticky self-PID probe confirms the koffi FFI, reads go through
 *  `processIdentity(pid)` directly — null means dead, microsecond reads, no
 *  PowerShell on the teardown path. Only when koffi is ABSENT does the probe
 *  fall back to `captureBirthTime`'s PowerShell StartTime.ToFileTime() leg
 *  (same UTC 100ns ticks), the rescue for hosts without the optional native
 *  addon. FFI-direct loses no safety: an access-denied FFI read is
 *  access-denied to Get-Process too (same-or-stronger access rights), so the
 *  PS leg would not rescue it either — both sources fail together. A
 *  recycled PID reads a DIFFERENT identity and can never impersonate the
 *  captured child. Residual degraded edge: null when BOTH sources fail cannot
 *  distinguish a dead child from an unreadable live one — the gate then
 *  treats it as death, so fail-closed is NOT claimed for that rare case.
 *  POSIX has no birth-time identity through that win32-only check, so
 *  `kill(pid, 0)` liveness stands in with an 'alive' sentinel (null once
 *  gone; EPERM means alive-but-not-ours). PID-reuse fencing is therefore
 *  win32-only. */
export function childIdentity(pid: number): string | null {
  if (process.platform === 'win32') {
    return ffiIdentityAvailable() ? processIdentity(pid) : captureBirthTime(pid)
  }
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : null
  }
}

/** Bounded exponential-backoff reconnect budget (consumed by the supervisor). */
export interface ReconnectPolicy {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
  maxAttempts: number
}

export interface SharedRecordOptions {
  /** Host MCP transport construction + auth-failure classification. Required:
   *  shared records are stdio-only and pass no auth opts (see openConnection). */
  transportPort: NativeMcpTransportPort
  connectTimeoutMs?: number // default 10_000
  toolTimeoutMs?: number // default 120_000
  /** Default { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 }. */
  reconnect?: ReconnectPolicy
  closeTimeoutMs?: number // default 5_000
  /** Identity probe for the child-exit confirmation and the reconnect death
   *  gate; defaults to `childIdentity`. Injectable so tests can simulate PID
   *  reuse deterministically (a mismatched birth-time identity). An injected
   *  probe's read cost is unknown, so the exit confirmation treats it as
   *  BLOCKING (the coarse two-read cadence, never the fast poll). */
  identityProbe?: (pid: number) => string | null
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
  /** Discovered prompts (`prompts/list`), stamped with the sharing key. */
  prompts: NativeMcpPrompt[] = []
  /** Bounds the connect task and all in-flight calls; replaced per attempt. */
  abort = new AbortController()
  /** Settles when the INITIAL connect attempt settles (success or failure). */
  readonly ready: Promise<void>
  /** The stdio child PID (transport.pid after start); null otherwise. */
  pid: number | null = null
  /** The child's birth-time identity captured at connect (`childIdentity`);
   *  null when there is no child or the identity was unreadable. The death
   *  gate compares against it so a recycled PID cannot impersonate the child. */
  birthTime: string | null = null
  /** A close whose child was still alive at the exit-confirmation deadline.
   *  Blocks automatic replacement (the registry retains the record) and gates
   *  manual `reconnect()` on confirmed child death; only an allowed reconnect
   *  clears it. */
  cleanupFailed = false

  private readonly transportPort: NativeMcpTransportPort
  private readonly connectTimeoutMs: number
  private readonly toolTimeoutMs: number
  private readonly closeTimeoutMs: number
  private readonly policy: ReconnectPolicy
  private readonly identityProbe: (pid: number) => string | null
  /** Whether exit-confirmation reads are microsecond-cheap (the default probe
   *  on the FFI / POSIX leg). Blocking reads — the koffi-absent PowerShell
   *  fallback, or an injected probe of unknown cost — get the coarse two-read
   *  cadence so a hung close cannot freeze the event loop with a poll of
   *  synchronous spawns. */
  private readonly cheapIdentityReads: boolean
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

  constructor(key: string, config: NativeMcpServerConfig, opts: SharedRecordOptions) {
    this.key = key
    this.config = config
    this.label = `${config.command ?? 'mcp'}#${shortHash(key)}`
    this.transportPort = opts.transportPort
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.closeTimeoutMs = opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.policy = opts.reconnect ?? DEFAULT_RECONNECT
    this.identityProbe = opts.identityProbe ?? childIdentity
    this.cheapIdentityReads = opts.identityProbe === undefined && defaultIdentityReadIsCheap()
    this.ready = new Promise<void>((resolve) => {
      this.settleReady = resolve
    })
  }

  /** Connect + discover tools. Never rejects: every failure is recorded on the
   *  record and its resources closed. Settles `ready` when the attempt settles.
   *  Serialized on the mutation queue; tears down any prior live generation
   *  BEFORE spawning a replacement, so a reconnect never overlaps two children. */
  async connect(): Promise<void> {
    return this.enqueue(() => this.connectLocked())
  }

  /** The connect body. Runs INSIDE the mutation queue so a reconnect's death
   *  gate and its fresh attempt share one serialized mutation — the gate's
   *  verdict cannot be invalidated by a teardown settling between the check
   *  and the spawn. */
  private async connectLocked(): Promise<void> {
    try {
      if (this.closed) return
      const outcome = await this.runAttempt()
      if (!outcome.ok && !this.closed) this.applyTerminalFailure(outcome.err)
    } finally {
      // Resolving an already-settled promise is a no-op, so later attempts
      // (reconnects) leave `ready` pinned to the INITIAL settlement.
      this.settleReady()
    }
  }

  /** Manual reconnect: cancel any pending backoff, invalidate the supervisor's
   *  current run, and run a fresh connect (which tears down the old generation
   *  first). Revives a gave-up or closed record; a later crash re-arms the
   *  supervisor.
   *
   *  Death gate: a `cleanupFailed` record may only reconnect once its child's
   *  death is CONFIRMED — the identity probe must read null. A live child
   *  (identity matches the spawn-captured birth time) refuses, and so does a
   *  recycled PID (a different identity): fail-closed, a replacement must never
   *  overlap a possibly-live child. The refusal is a pure no-op (no state
   *  reset, no spawn); an allowed reconnect clears `cleanupFailed`.
   *
   *  The WHOLE mutation — gate, resets, connect — is enqueued as one task, so
   *  the gate observes any ahead-queued close's SETTLED verdict. Evaluating it
   *  synchronously before enqueueing would read the stale flag while a hung
   *  teardown is still polling, and the queued connect would then spawn a
   *  replacement over the live child. */
  async reconnect(): Promise<void> {
    return this.enqueue(async () => {
      if (this.cleanupFailed) {
        const pid = this.pid
        const identity = pid === null ? null : this.identityProbe(pid)
        if (identity !== null) {
          const reused = this.birthTime !== null && identity !== this.birthTime
          const reason = reused
            ? `pid ${pid} reads a different birth-time identity (PID reuse); the child's death is unconfirmed`
            : `child ${pid} is still alive`
          log.warn(`[${this.label}] reconnect refused: cleanup failed, ${reason}`)
          throw new Error(`reconnect refused: cleanup failed and ${reason}`)
        }
        this.cleanupFailed = false
      }
      this.cancelBackoff()
      this.clearUptimeTimer()
      this.supervisorRun++
      this.closed = false
      this.attempt = 0
      this.error = undefined
      await this.connectLocked()
    })
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

  /** `prompts/list` following `nextCursor` until exhausted. */
  private async discoverPrompts(client: Client): Promise<NativeMcpPrompt[]> {
    const out: NativeMcpPrompt[] = []
    let cursor: string | undefined
    do {
      const page = await client.listPrompts(cursor === undefined ? undefined : { cursor }, {
        timeout: this.connectTimeoutMs,
        signal: this.abort.signal,
      })
      for (const prompt of page.prompts) {
        out.push({
          server: this.key,
          name: prompt.name,
          ...(prompt.description !== undefined ? { description: prompt.description } : {}),
          arguments: (prompt.arguments ?? []).map((argument) => ({
            name: argument.name,
            ...(argument.description !== undefined ? { description: argument.description } : {}),
            ...(argument.required !== undefined ? { required: argument.required } : {}),
          })),
        })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return out
  }

  /** `prompts/get` over the live connection. */
  async getPrompt(promptName: string, args: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const client = this.client
    if (this.status !== 'connected' || !client) throw new Error('MCP server is not connected')
    return client.getPrompt({ name: promptName, arguments: args }, {
      timeout: this.toolTimeoutMs,
      signal: AbortSignal.any([signal, this.abort.signal]),
    })
  }

  /** Forward a resource read to the connected server, result unchanged. */
  async readResource(uri: string): Promise<unknown> {
    const client = this.client
    if (this.status !== 'connected' || !client) {
      throw new Error('MCP server is not connected')
    }
    return client.readResource({ uri })
  }

  /** The server's declared capabilities (the `resources` key gates the
   *  resource tools), or undefined while not connected. */
  serverCapabilities(): Record<string, unknown> | undefined {
    return this.client?.getServerCapabilities() as Record<string, unknown> | undefined
  }

  /** `resources/list` following `nextCursor` until exhausted, bounded by the
   *  caller's signal and this record's own abort. */
  async listResources(signal: AbortSignal): Promise<NativeMcpResourceEntry[]> {
    const client = this.client
    if (this.status !== 'connected' || !client) throw new Error('MCP server is not connected')
    const out: NativeMcpResourceEntry[] = []
    let cursor: string | undefined
    do {
      const page = await client.listResources(cursor === undefined ? undefined : { cursor }, {
        timeout: this.toolTimeoutMs,
        signal: AbortSignal.any([signal, this.abort.signal]),
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

  /** Re-read the tool list over the LIVE connection (never dials) and diff it
   *  against the currently registered set, so the caller can report additions
   *  and removals. Serialized on the mutation queue so a reconnect cannot swap
   *  the client mid-listing. */
  async refreshTools(): Promise<{ toolCount: number; added: string[]; removed: string[] }> {
    return this.enqueue(async () => {
      const client = this.client
      if (this.status !== 'connected' || !client) throw new Error('MCP server is not connected')
      const before = new Set(this.tools.map((tool) => tool.name))
      const next = this.declaresTools() ? await this.discoverTools(client) : []
      const after = new Set(next.map((tool) => tool.name))
      this.tools = next
      this.cachedTools = next
      return {
        toolCount: next.length,
        added: [...after].filter((name) => !before.has(name)),
        removed: [...before].filter((name) => !after.has(name)),
      }
    })
  }

  /** Abort in-flight work, then close the client under a bounded deadline and
   *  confirm the stdio child actually exited (a second `closeTimeoutMs`
   *  window). Idempotent; never throws. Aborting BEFORE awaiting is what keeps
   *  teardown from waiting out an in-flight handshake or `listTools` page.
   *  Cancels the reconnect supervisor so a closed record never retries. A
   *  child still alive at the confirmation deadline sets `cleanupFailed` —
   *  there is NO automatic force-kill; the death gate guards replacement. */
  async close(): Promise<void> {
    this.closed = true
    this.cancelBackoff()
    this.clearUptimeTimer()
    this.abort.abort()
    await this.enqueue(async () => {
      // Out of service from the moment teardown starts: a closed record must
      // never stay marked 'connected' (a racing acquirer would see a zombie).
      // confirmChildExit overrides to 'failed' when the child survives the
      // deadline; a revival reconnect moves it on to pending/connected. A
      // retained cleanupFailed record keeps its sticky verdict untouched —
      // no transient failed→disabled downgrade, and confirmChildExit skips
      // re-polling an outcome that cannot change.
      if (!this.cleanupFailed) {
        this.status = 'disabled'
        this.error = undefined
      }
      await this.closeResources()
      await this.confirmChildExit()
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
    // This path runs no confirmChildExit (and a child lost before the
    // handshake has no captured PID to confirm), so the no-overlap guarantee
    // leans on the SDK stdio transport's close escalation: stdin EOF, then
    // SIGTERM at ~2s, then SIGKILL at ~4s — all inside the default 5s close
    // race, and on Windows SIGTERM is already a hard TerminateProcess.
    this.abort.abort()
    await this.closeResources()
    this.abort = new AbortController()
    this.gen = { lost: false }
    this.status = 'pending'
    this.pid = null
    this.birthTime = null
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    this.client = client
    client.onclose = () => this.handleLoss(client)
    try {
      await this.raceConnect(this.openConnection(client))
      // A resource-only stdio server declares no `tools` capability; skip
      // discovery instead of failing the connection on its -32601 answer.
      const discovered = this.declaresTools() ? await this.discoverTools(client) : []
      this.tools = discovered
      this.cachedTools = discovered
      this.prompts = client.getServerCapabilities()?.prompts === undefined
        ? []
        : await this.discoverPrompts(client)
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
    this.status = this.transportPort.isAuthError(err) ? 'needs-auth' : 'failed'
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
    if (this.transportPort.isAuthError(outcome.err)) {
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

  /** Build the transport and run the handshake, capturing the stdio child PID.
   *  Shared records are stdio-only (the view gates on type), and the stdio
   *  transport takes no authProvider — OAuth belongs to the view's local
   *  sse/http entries, so there is no auth plumbing here. */
  private async openConnection(client: Client): Promise<void> {
    const transport = this.transportPort.createTransport(transportTarget(this.config))
    await client.connect(transport)
    if (this.config.type === 'stdio') {
      this.pid = (transport as StdioClientTransport).pid ?? null
      // Birth-time identity for the death gate: a recycled PID reads a
      // different identity, so it can never impersonate this child.
      this.birthTime = this.pid === null ? null : this.identityProbe(this.pid)
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
        // Reject with the original instance: the transport port's `isAuthError`
        // narrows on the SDK's error classes.
        (err) => finish(err instanceof Error ? err : new Error(String(err))),
      )
    })
  }

  /** Whether this server declared a `tools` capability. A resource-only
   *  server answers `tools/list` with -32601, so discovery must be skipped. */
  private declaresTools(): boolean {
    return this.client?.getServerCapabilities()?.tools !== undefined
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

  /** Confirm the stdio child exited after a close: read its identity until it
   *  reads null (dead) or a `closeTimeoutMs` window passes. A mismatched
   *  identity also proves exit — the PID was recycled, so the captured child
   *  is gone. Still alive at the deadline → `cleanupFailed`: no automatic
   *  force-kill, the death gate on `reconnect()` guards replacement. The flag
   *  is never cleared here — only a death-gated manual reconnect clears it, so
   *  a retained record stays blocked even if the child dies later.
   *
   *  Cadence follows the read cost: cheap reads (FFI / `kill(pid, 0)`) poll at
   *  EXIT_POLL_MS; blocking reads (the koffi-absent PowerShell leg, or an
   *  injected probe of unknown cost) take ONE immediate read, an ASYNC sleep
   *  to the deadline, and ONE final read — a healthy close confirms in the
   *  first read, and a hung close costs two blocking reads instead of a full
   *  window of them freezing the event loop. */
  private async confirmChildExit(): Promise<void> {
    const pid = this.pid
    if (pid === null) return
    // Sticky verdict: a prior close already proved the child outlived its
    // deadline. Re-polling cannot change the outcome (only a death-gated
    // reconnect clears the flag), so a re-close skips the window entirely.
    if (this.cleanupFailed) return
    const deadline = Date.now() + this.closeTimeoutMs
    // null = dead; a mismatched identity = the PID was recycled, so the
    // captured child is gone too.
    const gone = (identity: string | null): boolean =>
      identity === null || (this.birthTime !== null && identity !== this.birthTime)
    if (this.cheapIdentityReads) {
      for (;;) {
        if (gone(this.identityProbe(pid))) return
        if (Date.now() >= deadline) break
        await delay(EXIT_POLL_MS)
      }
    } else {
      if (gone(this.identityProbe(pid))) return
      await delay(Math.max(0, deadline - Date.now()))
      if (gone(this.identityProbe(pid))) return
    }
    this.cleanupFailed = true
    this.status = 'failed'
    this.error = `cleanup failed: child ${pid} still alive after the ${this.closeTimeoutMs}ms close deadline`
    log.warn(
      `[${this.label}] child ${pid} still alive after the close deadline; cleanup failed ` +
        '(automatic replacement blocked until a death-gated reconnect)',
    )
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function noop(): void {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
