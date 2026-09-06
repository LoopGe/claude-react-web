import type { AgentMessage, AgentUserMessage } from '../agent-message.js'
import type { HistoryEntry, HistoryPage } from '../history-reader.js'
import type { SessionMeta } from '../persistence.js'
import type { ResumableSession } from '../session-types.js'
import type { SessionMemorySettings, ThinkingSetting } from '../../shared/session-info.js'
import type { ProviderProfile } from '../config.js'
import type { StructuredRunRequest, StructuredRunResult } from '../../shared/structured.js'
import type { SandboxSetting } from '../../shared/sandbox.js'

export interface CreateSessionOptions {
  id: string
  provider?: string
  cwd?: string
  model?: string
  /** Start-as custom agent name (SDK Options.agent). The provider maps it
   *  explicitly into sdkOptions so it always reaches the SDK even if the
   *  sdkOptions spreading path changes. */
  agent?: string
  permissionMode?: string
  title?: string
  betas?: string[]
  effortLevel?: string
  /** Per-session extended-thinking config (SDK Options.thinking at spawn;
   *  Query.setMaxThinkingTokens for runtime changes). */
  thinking?: ThinkingSetting
  /** Per-session auto-compact window intent in absolute tokens (SDK
   *  Settings.autoCompactWindow). No spawn-time Options equivalent — the
   *  provider re-applies it post-spawn via applyFlagSettings, like
   *  fastMode/effortLevel. Undefined means "auto" (CLI derives the threshold
   *  from the model's context window). */
  autoCompactWindow?: number
  fastMode?: boolean
  /** Per-session auto-memory intent (SDK Settings keys applied post-spawn
   *  via applyFlagSettings — the SDK has no spawn-time Options.memory). */
  memory?: SessionMemorySettings
  /** Per-session sandbox intent (SDK Settings.sandbox, applied post-spawn via
   *  applyFlagSettings — deliberately NOT Options.sandbox, whose `enabled`
   *  would default failIfUnavailable=true and hard-fail the whole session when
   *  sandbox deps are missing; see shared/sandbox.ts). */
  sandbox?: SandboxSetting
  env?: Record<string, string>
  mcpServers?: Record<string, unknown>
  enabledMcpServers?: string[]
  /** Compound keys (`<plugin>@<marketplace>`) of the plugin subset to load
   *  for this session. `undefined` = all enabled (default); `[]` = none. */
  enabledPlugins?: string[]
  includePartialMessages?: boolean
  includeHookEvents?: boolean
  /** Forward subagent text/thinking blocks as assistant/user frames with
   *  parent_tool_use_id set (SDK Options.forwardSubagentText). Resolved by
   *  the session-manager from config and passed explicitly on every spawn /
   *  respawn — the provider just forwards it. */
  forwardSubagentText?: boolean
  resume?: string
  forkSession?: boolean
  /** When forking (forkSession + resume), truncate the fork's loaded history
   *  to (and including) this assistant message uuid. Without it the CLI
   *  doesn't know where to cut and the fork subprocess hangs. SDK option. */
  resumeSessionAt?: string
  onUserMessageConsumed?: (message: AgentUserMessage) => void
  canUseTool?: (...args: unknown[]) => Promise<unknown>
  /** MCP elicitation (OAuth auth / server-initiated form) callback.
   *  SDK-agnostic loose signature mirroring canUseTool — the claude provider
   *  casts it to the SDK's OnElicitation when forwarding to query(). */
  onElicitation?: (...args: unknown[]) => Promise<unknown>
  /** User-dialog (blocking CLI prompt, e.g. refusal fallback) callback.
   *  Loose signature mirroring onElicitation — the claude provider casts it
   *  to the SDK's OnUserDialog when forwarding to query(). */
  onUserDialog?: (...args: unknown[]) => Promise<unknown>
  /** Dialog kinds to declare via Options.supportedDialogKinds. Must travel
   *  atomically with onUserDialog: the SDK's spawn-time check rejects
   *  non-empty kinds with no callback. Ignored when onUserDialog is absent. */
  supportedDialogKinds?: string[]
  /** Enable predicted next-user-prompt suggestions (SDK Options.promptSuggestions).
   *  When true, the SDK emits a prompt_suggestion message after each turn. */
  promptSuggestions?: boolean
  /** Enable periodic present-tense subagent progress summaries (SDK
   *  Options.agentProgressSummaries). When true, the SDK emits
   *  task_progress frames whose `summary` field carries the progress text
   *  (~every 30s per subagent, served from the prompt cache — cheap). */
  agentProgressSummaries?: boolean
  providerExtras?: Record<string, unknown>
  /** The resolved provider profile for this session. Threaded from the
   *  session-manager so the provider can use profile-scoped credentials
   *  and model lists without re-resolving. */
  profile?: ProviderProfile
}

/** Receipt of a successful interrupt, for providers that can report which
 *  CLI-side queued messages the interrupt withdrew. Providers whose
 *  underlying control call carries no such information simply resolve
 *  without a value (the host independently accounts for the messages it
 *  drained from its own input queue). */
export interface ProviderInterruptReceipt {
  /** Server-minted uuids of user turns the CLI dropped from its own input
   *  queue because the interrupt carried `cancelQueued`. May include
   *  internally-enqueued uuids the host never sent (cron triggers,
   *  auto-resume continuations) — the host ignores unknown uuids rather
   *  than treating them as an error. */
  cancelledQueued?: string[]
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
  destroy(reason?: string): Promise<void> | void
  /** Interrupt the in-flight turn. With `cancelQueued`, ALSO ask the CLI to
   *  drop every queued (and pending-dispatch) main-thread message instead of
   *  letting it start the next turn — SDK 0.3.219
   *  `interrupt_cancel_queued_v1` ("stop means stop everything" for a remote
   *  UI's Stop button). CLIs older than the field ignore it and behave as a
   *  plain interrupt, so no capability gate is required: the host drains its
   *  own input queue either way. Resolves with a receipt when the provider
   *  can report CLI-side cancellations. */
  interrupt?(opts?: { cancelQueued?: boolean }): Promise<ProviderInterruptReceipt | void>
  /** Background in-flight foreground tasks (Bash commands and subagents) —
   *  the CLI's Ctrl+B semantics. With `toolUseId`, only that task; without,
   *  every foreground task. The model immediately receives a "running in
   *  background" tool_result and the turn continues. Resolves false when
   *  there was nothing to background. */
  backgroundTasks?(toolUseId?: string): Promise<boolean>
  /** Stop a running task by id. The SDK emits a task_notification with
   *  status 'stopped' afterwards. */
  stopTask?(taskId: string): Promise<void>
  /** Runtime extended-thinking change (SDK Query.setMaxThinkingTokens —
   *  deprecated in favour of spawn-time Options.thinking, but still the
   *  ONLY runtime path; the SDK has no Settings key for this). Token
   *  mapping is the caller's job: null = adaptive (model-decides),
   *  0 = disabled, N = enabled with an N-token budget. `display` follows
   *  the SDK's thinkingDisplay param: 'summarized' | 'omitted' replaces the
   *  session display mode, null clears it back to the API default, and
   *  undefined keeps the session-start mode. */
  setMaxThinkingTokens?(tokens: number | null, display?: 'summarized' | 'omitted' | null): Promise<void>
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
  /** Pin (or clear, mode:null) a per-MCP-server permission-mode override
   *  (SDK Query.setMcpPermissionModeOverride — tighten-only: 'default' |
   *  'auto' | null). Resolves `{ warning? }`; the warning is set when the
   *  server name matches no currently-known server. */
  setMcpPermissionModeOverride?(serverName: string, mode: 'default' | 'auto' | null): Promise<{ warning?: string }>
  reloadPlugins?(): Promise<unknown>
  reloadSkills(): Promise<unknown>
  getContextUsage?(): Promise<unknown>
  getUsage?(): Promise<unknown>
  /** Authenticated-account info (SDK Query.accountInfo): email /
   *  organization / subscriptionType / tokenSource / apiKeySource /
   *  apiProvider. Read-only control request; needs a live session. */
  accountInfo?(): Promise<unknown>
  /** Restore tracked files to their state at a user message (SDK
   *  Query.rewindFiles). `userMessageId` is the SDK on-disk uuid of the
   *  target user message (the caller maps the app-level uuid); `dryRun`
   *  previews the diff without touching files. Requires sessions spawned
   *  with enableFileCheckpointing. */
  rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown>
  /** Auto-generate a session title (SDK Query.generateSessionTitle —
   *  `generate_session_title` control request). `description` is a short
   *  text the CLI uses to synthesize a title. `persist: true` is passed to
   *  the SDK so the title also survives resume via the CLI transcript. */
  generateTitle?(description: string): Promise<unknown>
  /** Read a file's content (SDK Query.readFile) — gated by the session's
   *  Read-permission rules inside the SDK. `path` is relative to cwd or
   *  absolute; resolves to `{ contents }` or null (denied / missing). */
  readFile?(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }): Promise<unknown>
  /** List subagent ids recorded on disk for this session (SDK standalone
   *  listSubagents — scans `subagents/agent-<id>.jsonl` under the session's
   *  project transcript dir). Empty when the session has no subagents. */
  listSubagents?(): Promise<string[]>
  /** Read one subagent's full transcript from its own JSONL (SDK standalone
   *  getSubagentMessages — returns SessionMessage[] in conversation order via
   *  parentUuid links). Works for background/async subagents whose frames were
   *  never forwarded to the main stream. */
  getSubagentMessages?(agentId: string, opts?: { limit?: number; offset?: number }): Promise<unknown>
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
  supportsThinkingControl: boolean
  supportsCommands: boolean
  supportsAgents: boolean
  supportsContextUsage: boolean
  supportsUsage: boolean
  supportsAccountInfo: boolean
  supportsRewindFiles: boolean
  supportsSessionTitle: boolean
  supportsTaskControl: boolean
  supportsStructuredOutput: boolean
  supportsReadFile: boolean
  supportsSubagentTranscripts: boolean
}

export interface ListResumableOptions {
  dir?: string
}

export interface AgentProvider {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  createSession(opts: CreateSessionOptions): ProviderSessionHandle
  /** One-shot headless structured-output run (SDK Options.outputFormat /
   *  JSON-schema): spawn a fresh non-persisted query with a single user
   *  message, run to a terminal `result` frame, and return the parsed output
   *  or a narrowed error. Providers that lack the target binary / contract
   *  simply omit it — the manager answers 501. The optional signal aborts the
   *  subprocess (client cancel / server timeout). */
  runStructured?(req: StructuredRunRequest, signal?: AbortSignal): Promise<StructuredRunResult>
  getSessionInfo?(id: string, opts?: { dir?: string }): Promise<ResumableSession | undefined>
  listResumable?(opts?: ListResumableOptions): Promise<ResumableSession[]>
  readHistoryPage?(id: string, opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string }): Promise<HistoryPage>
  readHistoryEntries?(id: string, opts: { afterUuid?: string }): Promise<HistoryEntry[]>
  hasTranscript?(meta: SessionMeta): Promise<boolean>
}
