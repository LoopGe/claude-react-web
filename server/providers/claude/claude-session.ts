import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentMessage, AgentUserMessage } from '../../agent-message.js'
import type { Pushable } from '../../pushable.js'
import type { ProviderInterruptReceipt, ProviderSessionHandle } from '../types.js'
import type { ProcessExitInfo } from '../../process-monitor.js'

export class ClaudeSessionHandle implements ProviderSessionHandle {
  readonly provider = 'claude'
  private isClosed = false

  constructor(
    private readonly query: Query,
    private readonly input: Pushable<AgentUserMessage>,
    private readonly abortController: AbortController,
    /** Resolves when the underlying CLI subprocess actually exits (not merely
     *  when the pump breaks on the abort signal). Sourced from the
     *  ProcessMonitor registration. Awaited by SessionManager.clear() to gate
     *  its respawn on the OLD process dying, so the fresh `--session-id`
     *  Query doesn't collide with the still-shutting-down child
     *  ("Session ID already in use"). Resolves immediately when no real
     *  process ever spawned (mocked SDK / deferred spawn). Never rejects. */
    private readonly processExitedPromise: Promise<ProcessExitInfo>,
    private readonly cleanupMonitor: () => void,
  ) {}

  get messages(): AsyncIterable<AgentMessage> {
    return this.query as AsyncIterable<AgentMessage>
  }

  get processExited(): Promise<ProcessExitInfo> {
    return this.processExitedPromise
  }

  get queueDepth(): number {
    return this.input.queueDepth
  }

  get closed(): boolean {
    return this.isClosed
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal
  }

  enqueueUserMessage(message: AgentUserMessage): void {
    this.input.push(message)
  }

  sendControlMessage(message: AgentUserMessage): void {
    this.input.push(message)
  }

  clearQueuedInput(): number {
    return this.input.clearQueue()
  }

  drainQueuedInput(): AgentUserMessage[] {
    return this.input.drainQueue()
  }

  abort(): void {
    // Detach any parked SDK input waiter BEFORE aborting the controller.
    // The CLI idle-exited and autoResume keeps this handle's input queue open
    // while it builds resume options; the SDK's streamInput is parked in
    // next() awaiting the next prompt message. Without this, the first message
    // pushed during the resume window would be handed to that parked waiter
    // and dropped (the SDK's loop checks its abort signal after each pull).
    // Detaching first makes the message queue, where respawnInPlace's
    // drainQueuedInput can recover it for the resumed Query.
    this.input.detachWaiter()
    this.abortController.abort()
  }

  destroy(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.input.end()
    this.abortController.abort()
    // Query.close() is the SDK's authoritative resource cleanup: flush the
    // transcript-mirror batcher, abort every in-flight cancel controller, close
    // the transport (stdin EOF → grace → SIGTERM/SIGKILL) and reject pending
    // control responses. input.end() + abortController.abort() above ask the
    // SDK to wind down; this is the belt-and-suspenders call that guarantees
    // MCP transports and pending requests are released even if the graceful
    // path stalls. Idempotent in the SDK (performCleanup guards on a
    // cleanupPromise) and safe to call when the process already exited — it
    // either already ran or throws, so swallow.
    try {
      this.query.close()
    } catch {
      /* already closed / process exited before cleanup — nothing to do */
    }
    this.cleanupMonitor()
  }

  async interrupt(opts?: { cancelQueued?: boolean }): Promise<ProviderInterruptReceipt | void> {
    // SDK ≥0.3.24x: interrupt() resolves with an interrupt receipt
    // (SDKControlInterruptResponse). With cancelQueued the CLI cancels every
    // queued (and pending-dispatch) main-thread message and lists them on the
    // receipt's `cancelled` field (interrupt_cancel_queued_v1); without it the
    // `still_queued` survivors are meant to run, so there is nothing to
    // report. The SDK's public TS signature has no parameters yet (type lag),
    // but the runtime forwards the options object into the control request —
    // verified in sdk.mjs:
    //   interrupt(e){...request({subtype:"interrupt",...e?.cancelQueued===!0&&{cancel_queued:!0}})}
    // so forwarding undefined is identical to zero args (the field is built
    // conditionally) and one typed call site covers both paths. CLIs older
    // than the field ignore the unknown field and behave as a plain
    // interrupt, so forwarding is always safe. The receipt's uuids are the
    // ones stamped on the SDKUserMessage objects this host pushed, so they
    // match the server-minted uuids clients know.
    const q = this.query as Query & {
      interrupt(o?: { cancelQueued?: boolean }): Promise<{ cancelled?: string[] } | undefined>
    }
    const receipt = await q.interrupt(opts?.cancelQueued ? { cancelQueued: true } : undefined)
    if (receipt?.cancelled?.length) return { cancelledQueued: receipt.cancelled }
  }

  backgroundTasks(toolUseId?: string): Promise<boolean> {
    return this.query.backgroundTasks(toolUseId)
  }

  stopTask(taskId: string): Promise<void> {
    return this.query.stopTask(taskId)
  }

  /** Runtime extended-thinking change. The token + display mapping lives in
   *  the session-manager (ThinkingSetting → number|null + display|null); this
   *  just forwards. `display` follows the SDK's runtime param semantics:
   *  'summarized' | 'omitted' replaces the session display mode, null clears
   *  back to the API default, and undefined keeps the session-start mode. */
  setMaxThinkingTokens(tokens: number | null, display?: 'summarized' | 'omitted' | null): Promise<void> {
    return this.query.setMaxThinkingTokens(tokens, display)
  }

  setModel(model?: string): Promise<void> {
    return this.query.setModel(model)
  }

  setPermissionMode(mode: string): Promise<void> {
    return this.query.setPermissionMode(mode as Parameters<Query['setPermissionMode']>[0])
  }

  applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    return this.query.applyFlagSettings(settings as Parameters<Query['applyFlagSettings']>[0])
  }

  supportedModels(): Promise<unknown> {
    return this.query.supportedModels()
  }

  supportedCommands(): Promise<unknown> {
    return this.query.supportedCommands()
  }

  supportedAgents(): Promise<unknown> {
    return this.query.supportedAgents()
  }

  mcpServerStatus(): Promise<unknown> {
    return this.query.mcpServerStatus()
  }

  reconnectMcpServer(name: string): Promise<void> {
    return this.query.reconnectMcpServer(name)
  }

  toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    return this.query.toggleMcpServer(name, enabled)
  }

  setMcpServers(servers: Record<string, unknown>): Promise<unknown> {
    return this.query.setMcpServers(servers as Parameters<Query['setMcpServers']>[0])
  }

  /** Pin (or clear, mode:null) a per-MCP-server permission-mode override
   *  (tighten-only: 'default' | 'auto' | null). The SDK resolves
   *  `{ warning?: string }` — set when the server name matches no known
   *  server (typo detection); the override still applies if that server
   *  connects later. */
  setMcpPermissionModeOverride(serverName: string, mode: 'default' | 'auto' | null): Promise<{ warning?: string }> {
    return this.query.setMcpPermissionModeOverride(serverName, mode)
  }

  reloadPlugins(): Promise<unknown> {
    return this.query.reloadPlugins()
  }

  reloadSkills(): Promise<unknown> {
    return this.query.reloadSkills()
  }

  getContextUsage(): Promise<unknown> {
    return this.query.getContextUsage()
  }

  /** Authenticated-account info (email / organization / subscription /
   *  auth backend). Read-only; the manager narrows the raw response via
   *  coerceAccountInfo before it reaches the wire. */
  accountInfo(): Promise<unknown> {
    return this.query.accountInfo()
  }

  /** File-checkpoint rewind. The userMessageId here is the SDK on-disk uuid
   *  (the manager maps the app-level uuid via the promptUuids sidecar);
   *  the result is narrowed by the manager via coerceRewindResult. */
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown> {
    return this.query.rewindFiles(userMessageId, options)
  }

  /** Read a file's content (SDK Query.readFile), gated by the session's
   *  Read-permission rules inside the SDK. Resolves `{ contents }` or null
   *  (denied / missing); the manager narrows via coerceReadFileOutput. */
  readFile(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }): Promise<unknown> {
    return this.query.readFile(path, options)
  }

  /** Auto-generated session title (SDK `generate_session_title` control
   *  request). `persist: true` writes the title into the CLI transcript so
   *  it survives `--resume`. The SDK resolves to the title STRING (it
   *  returns `response.title`), not a `{ title }` wrapper. */
  generateTitle(description: string): Promise<unknown> {
    const q = this.query as typeof this.query & {
      generateSessionTitle(
        description: string,
        options: { persist: boolean },
      ): Promise<string>
    }
    return q.generateSessionTitle(description, { persist: true })
  }

  /** Structured /usage data (session cost/usage totals + claude.ai plan
   *  rate-limit windows). The SDK method is EXPERIMENTAL and its name will
   *  change when stabilized — this wrapper is the single call site, so the
   *  rename is a one-line edit here. */
  getUsage(): Promise<unknown> {
    return this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
  }
}
