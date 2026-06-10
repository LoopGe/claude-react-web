import type { AgentMessage, AgentUserMessage } from '../agent-message.js'
import type { HistoryPage } from '../history-reader.js'
import type { SessionMeta } from '../persistence.js'
import type { ResumableSession } from '../session-types.js'

export interface CreateSessionOptions {
  id: string
  provider?: string
  cwd?: string
  model?: string
  permissionMode?: string
  title?: string
  betas?: string[]
  effortLevel?: string
  fastMode?: boolean
  env?: Record<string, string>
  mcpServers?: Record<string, unknown>
  enabledMcpServers?: string[]
  includePartialMessages?: boolean
  resume?: string
  forkSession?: boolean
  onUserMessageConsumed?: (message: AgentUserMessage) => void
  canUseTool?: (...args: unknown[]) => Promise<unknown>
  providerExtras?: Record<string, unknown>
}

export interface ProviderSessionHandle {
  readonly provider: string
  readonly messages: AsyncIterable<AgentMessage>
  enqueueUserMessage(message: AgentUserMessage): void
  readonly queueDepth: number
  readonly closed: boolean
  readonly abortSignal: AbortSignal
  abort(): void
  destroy(reason?: string): Promise<void> | void
  interrupt?(): Promise<void>
  setModel?(model?: string): Promise<void>
  setPermissionMode?(mode: string): Promise<void>
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>
  supportedModels?(): Promise<unknown>
  supportedCommands?(): Promise<unknown>
  supportedAgents?(): Promise<unknown>
  mcpServerStatus?(): Promise<unknown>
  reconnectMcpServer?(name: string): Promise<void>
  toggleMcpServer?(name: string, enabled: boolean): Promise<void>
  setMcpServers?(servers: Record<string, unknown>): Promise<unknown>
  reloadPlugins?(): Promise<unknown>
  getContextUsage?(): Promise<unknown>
}

export interface ProviderCapabilities {
  supportsFineGrainedPermissions: boolean
  supportsMcp: boolean
  supportsModelSwitch: boolean
  supportsInterrupt: boolean
  supportsResume: boolean
  supportsFork: boolean
  supportsPlugins: boolean
  supportsFastMode: boolean
  supportsEffortLevel: boolean
  supportsCommands: boolean
  supportsAgents: boolean
  supportsContextUsage: boolean
}

export interface ListResumableOptions {
  dir?: string
}

export interface AgentProvider {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  createSession(opts: CreateSessionOptions): ProviderSessionHandle
  getSessionInfo?(id: string, opts?: { dir?: string }): Promise<ResumableSession | undefined>
  listResumable?(opts?: ListResumableOptions): Promise<ResumableSession[]>
  readHistoryPage?(id: string, opts: { before?: number; beforeUuid?: string; limit: number }): Promise<HistoryPage>
  hasTranscript?(meta: SessionMeta): Promise<boolean>
}
