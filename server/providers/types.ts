import type { AgentMessage, AgentUserMessage } from '../agent-message.js'
import type { HistoryEntry, HistoryPage } from '../history-reader.js'
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
  /** Compound keys (`<plugin>@<marketplace>`) of the plugin subset to load
   *  for this session. `undefined` = all enabled (default); `[]` = none. */
  enabledPlugins?: string[]
  includePartialMessages?: boolean
  includeHookEvents?: boolean
  resume?: string
  forkSession?: boolean
  /** When forking (forkSession + resume), truncate the fork's loaded history
   *  to (and including) this assistant message uuid. Without it the CLI
   *  doesn't know where to cut and the fork subprocess hangs. SDK option. */
  resumeSessionAt?: string
  onUserMessageConsumed?: (message: AgentUserMessage) => void
  canUseTool?: (...args: unknown[]) => Promise<unknown>
  providerExtras?: Record<string, unknown>
}

export interface ProviderSessionHandle {
  readonly provider?: string
  readonly messages: AsyncIterable<AgentMessage>
  enqueueUserMessage(message: AgentUserMessage): void
  /** Enqueue a provider control command without treating it as a visible
   *  user turn in this app's history. Providers that use the same SDK input
   *  queue as normal user messages can implement this as a raw queue push;
   *  SessionManager owns the UI/history bookkeeping. */
  sendControlMessage(message: AgentUserMessage): void
  /** Drop queued user turns that have not yet been consumed by the provider. */
  clearQueuedInput(): number
  /** Remove and return queued user turns that have not yet been consumed by
   *  the provider — used by crash recovery to carry a pending user turn
   *  across a re-resume (otherwise the turn is silently lost: the UI already
   *  painted the bubble, but the SDK never wrote it to disk before crashing,
   *  so --resume loads a transcript without it). Optional: providers whose
   *  input queue can't be drained can omit it, and crash recovery falls back
   *  to losing the pending turn. */
  drainQueuedInput?(): AgentUserMessage[]
  readonly queueDepth: number
  readonly closed: boolean
  readonly abortSignal: AbortSignal
  /** Resolves when the underlying CLI subprocess actually exits (not merely
   *  when the pump breaks on the abort signal). Awaited by
   *  SessionManager.clear() to gate its respawn on the OLD process dying so
   *  the fresh `--session-id` Query doesn't collide with the
   *  still-shutting-down child. Typed `unknown` here to avoid a type-cycle
   *  into process-monitor.ts; the Claude provider narrows it to
   *  `Promise<ProcessExitInfo>`. Resolves immediately when no real process
   *  ever spawned. Never rejects. */
  readonly processExited: Promise<unknown>
  abort(): void
  destroy(reason: string): Promise<void> | void
  interrupt(): Promise<void>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: string): Promise<void>
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  supportedModels(): Promise<unknown>
  supportedCommands(): Promise<unknown>
  supportedAgents(): Promise<unknown>
  mcpServerStatus(): Promise<unknown>
  reconnectMcpServer(name: string): Promise<void>
  toggleMcpServer(name: string, enabled: boolean): Promise<void>
  setMcpServers(servers: Record<string, unknown>): Promise<unknown>
  reloadPlugins(): Promise<unknown>
  reloadSkills(): Promise<unknown>
  getContextUsage(): Promise<unknown>
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
  readHistoryPage?(id: string, opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string }): Promise<HistoryPage>
  readHistoryEntries?(id: string, opts: { afterUuid?: string }): Promise<HistoryEntry[]>
  hasTranscript?(meta: SessionMeta): Promise<boolean>
}
