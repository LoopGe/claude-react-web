import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentMessage, AgentUserMessage } from '../../agent-message.js'
import type { Pushable } from '../../pushable.js'
import type { ProviderSessionHandle } from '../types.js'

export class ClaudeSessionHandle implements ProviderSessionHandle {
  readonly provider = 'claude'
  private isClosed = false

  constructor(
    private readonly query: Query,
    private readonly input: Pushable<AgentUserMessage>,
    private readonly abortController: AbortController,
    private readonly cleanupMonitor: () => void,
  ) {}

  get messages(): AsyncIterable<AgentMessage> {
    return this.query as AsyncIterable<AgentMessage>
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

  abort(): void {
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

  setModel(model: string): Promise<void> {
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
