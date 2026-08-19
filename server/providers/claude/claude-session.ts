import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentMessage, AgentUserMessage } from '../../agent-message.js'
import type { Pushable } from '../../pushable.js'
import type { ProviderSessionHandle } from '../types.js'
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
    this.cleanupMonitor()
  }

  interrupt(): Promise<void> {
    return this.query.interrupt()
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

  reloadPlugins(): Promise<unknown> {
    return this.query.reloadPlugins()
  }

  reloadSkills(): Promise<unknown> {
    return this.query.reloadSkills()
  }

  getContextUsage(): Promise<unknown> {
    return this.query.getContextUsage()
  }
}
