import {
  getSessionInfo,
  listSessions,
  query,
  renameSession as sdkRenameSession,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKResultError,
  type SDKResultSuccess,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { config as defaultConfig, DEFAULT_PROFILE } from '../../config.js'
import type { ModelGroupConfig, ProviderProfile } from '../../config.js'
import { profileDefaultModel, resolveActiveProfile } from '../../profiles.js'
import {
  capabilitiesForTier,
  fallbackAliasesFor,
  resolveConfiguredModelId,
  resolveGroup,
} from '../../model-groups.js'
import { readHistoryEntries, readHistoryPage } from '../../history-reader.js'
import type { HistoryEntry, HistoryPage } from '../../history-reader.js'
import type { SessionMeta } from '../../persistence.js'
import type { MpStore } from '../../mp-store.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'
import { createPushable } from '../../pushable.js'
import { ProcessMonitor, type ProcessExitInfo } from '../../process-monitor.js'
import type { AgentProvider, CreateSessionOptions, ListResumableOptions, ProviderCapabilities } from '../types.js'
import { ClaudeSessionHandle } from './claude-session.js'
import type { AgentUserMessage } from '../../agent-message.js'
import type { StructuredRunRequest, StructuredRunResult } from '../../../shared/structured.js'
import type { ResumableSession } from '../../session-types.js'
import { createLogger } from '../../log.js'

const log = createLogger('claude-provider')

/** True when a base URL points at a first-party Anthropic API host
 *  (api.anthropic.com or a *.anthropic.com subdomain). Non-first-party
 *  proxies (zhipuai, other OpenAI-compatible gateways) don't support the
 *  `tool_reference` beta blocks that tool search relies on, so MCP tools
 *  deferred behind tool search never reach the model. */
function isFirstPartyAnthropicUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com')
  } catch {
    return false
  }
}

/** Env keys that would leak secrets if logged verbatim — redact by key. */
const SENSITIVE_ENV_KEY = /token|secret|password|auth|key/i
/** Env keys that meaningfully shape the spawned subprocess. Filters out the
 *  standard OS noise (PATH, HOME, TEMP, …) so the spawn log stays focused on
 *  the behavior-affecting variables this app injects. */
const RELEVANT_ENV_KEY = /^(ANTHROPIC_|CLAUDE_CODE_|DISABLE_AUTOUPDATER$|ENABLE_TOOL_SEARCH$)/i

/** Truncate a long string for log output, marking the cut. */
function truncateForLog(s: unknown, max = 300): unknown {
  if (typeof s !== 'string' || s.length <= max) return s
  return `${s.slice(0, max)}…(+${s.length - max} chars)`
}

/** `Options.systemPrompt` is either a plain string or a `{ type: 'preset',
 *  preset }` object — truncate the long form either way. */
function summarizeSystemPrompt(sp: unknown): unknown {
  if (typeof sp === 'string') return truncateForLog(sp)
  if (sp && typeof sp === 'object') {
    const o = sp as Record<string, unknown>
    return { ...o, preset: truncateForLog(o.preset) }
  }
  return sp
}

/** Summarize the FINAL spawn payload handed to query() into a flat,
 *  JSON-serializable object for permanent diagnostic logging. Captures every
 *  option the CLI subprocess receives at spawn (model, cwd, betas, resume/
 *  fork, permission mode, thinking, mcp/plugins, sanitized env, …) plus the
 *  post-spawn applyFlagSettings intents (fastMode/effortLevel/autoCompactWindow/
 *  memory) that have no spawn-time Options equivalent — so one spawn log line
 *  tells the whole story for debugging session-shape drift (e.g. the
 *  200K-vs-1M context-window question). Env values whose key looks sensitive
 *  are redacted: ANTHROPIC_AUTH_TOKEN / *_API_KEY / … must never reach logs. */
function summarizeSpawn(opts: CreateSessionOptions, sdkOptions: Options): Record<string, unknown> {
  const env: Record<string, string> = {}
  if (sdkOptions.env) {
    for (const [k, v] of Object.entries(sdkOptions.env)) {
      if (v === undefined || v === null) continue
      if (!RELEVANT_ENV_KEY.test(k)) continue
      env[k] = SENSITIVE_ENV_KEY.test(k) ? '[redacted]' : String(v)
    }
  }
  return {
    id: opts.id,
    provider: opts.provider,
    modelGroupId: opts.providerExtras?.modelGroupId,
    sessionId: sdkOptions.sessionId,
    resume: sdkOptions.resume,
    forkSession: sdkOptions.forkSession,
    resumeSessionAt: sdkOptions.resumeSessionAt,
    model: sdkOptions.model,
    cwd: sdkOptions.cwd,
    permissionMode: sdkOptions.permissionMode,
    title: truncateForLog(sdkOptions.title),
    systemPrompt: summarizeSystemPrompt(sdkOptions.systemPrompt),
    betas: sdkOptions.betas,
    effort: sdkOptions.effort,
    thinking: sdkOptions.thinking,
    includePartialMessages: sdkOptions.includePartialMessages,
    includeHookEvents: sdkOptions.includeHookEvents,
    forwardSubagentText: sdkOptions.forwardSubagentText,
    promptSuggestions: sdkOptions.promptSuggestions,
    agentProgressSummaries: sdkOptions.agentProgressSummaries,
    enableFileCheckpointing: sdkOptions.enableFileCheckpointing,
    additionalDirectories: sdkOptions.additionalDirectories,
    mcpServers: sdkOptions.mcpServers ? Object.keys(sdkOptions.mcpServers) : undefined,
    plugins: sdkOptions.plugins,
    pathToClaudeCodeExecutable: sdkOptions.pathToClaudeCodeExecutable,
    env,
    postSpawn: {
      fastMode: opts.fastMode,
      effortLevel: opts.effortLevel,
      autoCompactWindow: opts.autoCompactWindow,
      memory: opts.memory,
      sandbox: opts.sandbox,
      enabledPlugins: opts.enabledPlugins,
    },
  }
}

/** Build the SDK subprocess env for a profile. Exported pure for tests. */
export function buildProfileEnv(profile: ProviderProfile, maxOutputTokens: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? process.env.USERPROFILE,
    USERPROFILE: process.env.USERPROFILE,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    SHELL: process.env.SHELL,
    ComSpec: process.env.ComSpec,
    NODE_PATH: process.env.NODE_PATH,
    ANTHROPIC_AUTH_TOKEN: profile.authToken,
    ANTHROPIC_BASE_URL: profile.baseUrl,
    ANTHROPIC_API_KEY: undefined,
  }
  if (maxOutputTokens > 0) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens)
  }
  // SDK 0.3.233 dropped todo/task tools (TodoWrite, TaskCreate/Get/Update/List) from the DEFAULT tool surface on Opus 4.8 / Sonnet 5 / Fable 5+
  // — this UI renders todo checklists (src/components/TodoChecklist.tsx), so
  // opt back in explicitly rather than letting the model tier silently
  // downgrade the feature.
  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1'
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ANTHROPIC_') && key !== 'ANTHROPIC_API_KEY' && !(key in env)) {
      env[key] = process.env[key]
    }
  }
  if (!('ENABLE_TOOL_SEARCH' in env) && profile.baseUrl && !isFirstPartyAnthropicUrl(profile.baseUrl)) {
    env.ENABLE_TOOL_SEARCH = 'false'
    log.info(`non-first-party ANTHROPIC_BASE_URL=${profile.baseUrl} — forcing ENABLE_TOOL_SEARCH=false`)
  }
  return env
}

/** Same short-name -> configured-model resolution the manager uses for the
 *  main model, wired to the provider's view of the configured list. */
function resolveConfiguredModel(
  model: string | undefined,
  modelList: readonly string[],
): string | undefined {
  return resolveConfiguredModelId(model, modelList)
}

export interface ClaudeProviderOptions {
  claudeBinary?: string
  mpStore?: MpStore
  agentStore?: AgentDefinitionStore
  onProcessExit?: (info: ProcessExitInfo) => void
}

/** Inject enabled custom agent definitions from the store into SDK
 *  `Options.agents`, merging over the existing value. Store defs are the base;
 *  any pre-existing `opts.agents` overload them on a name clash (the spread
 *  of `opts.agents` comes last and wins). Exported pure so it's unit-testable
 *  without mocking the whole SDK Query surface. */
export function injectAgentDefinitions(opts: Options, store: AgentDefinitionStore | undefined): void {
  if (!store) return
  const agents = store.getEnabledDefinitions()
  if (Object.keys(agents).length === 0) return
  opts.agents = { ...agents, ...(opts.agents ?? {}) }
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude'
  readonly capabilities: ProviderCapabilities = {
    supportsFineGrainedPermissions: true,
    supportsMcp: true,
    supportsModelSwitch: true,
    supportsInterrupt: true,
    supportsResume: true,
    supportsFork: true,
    supportsPlugins: true,
    supportsFastMode: true,
    supportsEffortLevel: true,
    supportsThinkingControl: true,
    supportsCommands: true,
    supportsAgents: true,
    supportsContextUsage: true,
    supportsUsage: true,
    supportsAccountInfo: true,
    supportsRewindFiles: true,
    supportsSessionTitle: true,
    supportsTaskControl: true,
    supportsStructuredOutput: true,
    supportsReadFile: true,
    supportsSubagentTranscripts: true,
  }

  private readonly processMonitor: ProcessMonitor
  private cachedEnv?: NodeJS.ProcessEnv
  private cachedAuthToken?: string
  private cachedBaseUrl?: string

  constructor(private readonly opts: ClaudeProviderOptions = {}) {
    this.processMonitor = new ProcessMonitor((info) => this.opts.onProcessExit?.(info))
  }

  createSession(opts: CreateSessionOptions): ClaudeSessionHandle {
    const sdkOptions = { ...((opts.providerExtras?.sdkOptions as Options | undefined) ?? {}) }
    const modelGroupId = opts.providerExtras?.modelGroupId as string | undefined
    const profile = opts.profile ?? resolveActiveProfile(defaultConfig.profiles, defaultConfig.activeProfileId, DEFAULT_PROFILE)
    const group = modelGroupId ? profile.modelGroups.find((g) => g.id === modelGroupId) : undefined
    if (opts.resume && !sdkOptions.resume) sdkOptions.resume = opts.resume
    if (opts.forkSession !== undefined) sdkOptions.forkSession = opts.forkSession
    if (opts.resumeSessionAt !== undefined) sdkOptions.resumeSessionAt = opts.resumeSessionAt
    if (opts.cwd !== undefined) sdkOptions.cwd = opts.cwd
    if (opts.model !== undefined) sdkOptions.model = opts.model
    if (opts.agent !== undefined) sdkOptions.agent = opts.agent
    if (opts.title !== undefined) sdkOptions.title = opts.title
    if (opts.betas !== undefined) sdkOptions.betas = opts.betas as Options['betas']
    if (opts.mcpServers !== undefined) sdkOptions.mcpServers = opts.mcpServers as Options['mcpServers']
    if (opts.includePartialMessages !== undefined) sdkOptions.includePartialMessages = opts.includePartialMessages
    if (opts.includeHookEvents !== undefined) sdkOptions.includeHookEvents = opts.includeHookEvents
    if (opts.forwardSubagentText !== undefined) sdkOptions.forwardSubagentText = opts.forwardSubagentText
    if (opts.effortLevel !== undefined) sdkOptions.effort = opts.effortLevel as Options['effort']
    // Extended thinking is a first-class spawn-time option (unlike fastMode /
    // effortLevel, which need a post-spawn applyFlagSettings round-trip).
    if (opts.thinking !== undefined) sdkOptions.thinking = opts.thinking as Options['thinking']
    // Enable prompt suggestions by default — nearly free (piggybacks on
    // prompt cache) and provides a useful UX affordance.
    sdkOptions.promptSuggestions = opts.promptSuggestions ?? true
    // Enable subagent progress summaries by default — served from the
    // prompt cache (~free, ~every 30s per subagent) and it feeds the
    // task_progress.summary the TasksPanel and subagent chips render.
    sdkOptions.agentProgressSummaries = opts.agentProgressSummaries ?? true
    // Enable file checkpointing by default so Query.rewindFiles works out
    // of the box (the feature is dead weight without it, and the cost is
    // bounded backups of files the session modifies). An explicit
    // `enableFileCheckpointing: false` in the create body reaches
    // sdkOptions via providerExtras and is left verbatim.
    if (sdkOptions.enableFileCheckpointing === undefined) {
      sdkOptions.enableFileCheckpointing = true
    }
    // The app renders a per-task stop control (POST /sessions/:id/tasks/:taskId/stop)
    // for every background task, so declare the per-task stop affordance to the
    // CLI — it can then route interrupt semantics through the per-task control
    // instead of aborting the whole turn.
    sdkOptions.perTaskStopAffordance = true

    const requestedMode = (opts.permissionMode ?? sdkOptions.permissionMode) as PermissionMode | undefined
    this.applyStandardQueryOpts(sdkOptions, opts.env, opts.enabledPlugins, group, profile)
    sdkOptions.permissionMode = this.sdkForwardMode(requestedMode)
    if (!sdkOptions.resume || sdkOptions.forkSession) {
      sdkOptions.sessionId = opts.id
    }
    if (opts.canUseTool && !sdkOptions.canUseTool) {
      sdkOptions.canUseTool = opts.canUseTool as Options['canUseTool']
    }
    if (opts.onElicitation && !sdkOptions.onElicitation) {
      sdkOptions.onElicitation = opts.onElicitation as Options['onElicitation']
    }
    // Atomic pair: only forward supportedDialogKinds when the callback is
    // present — non-empty kinds without onUserDialog make the SDK spawn throw.
    if (opts.onUserDialog && !sdkOptions.onUserDialog) {
      sdkOptions.onUserDialog = opts.onUserDialog as Options['onUserDialog']
      sdkOptions.supportedDialogKinds = opts.supportedDialogKinds
    }

    // Cap the input queue as an OOM backstop. In normal operation the SDK
    // consumes each user turn immediately and depth stays at 0–1; the cap
    // only bites when the subprocess is wedged and a caller keeps enqueuing
    // (e.g. many large image turns). The stuck-session health monitor also
    // bounds that window in time — this bounds it in memory. Drop-oldest at
    // 64 queued turns only triggers in genuinely pathological spam, where
    // the history ring still retains every message for the UI and the user
    // can resend; the alternative is unbounded memory growth.
    const INPUT_QUEUE_MAX_DEPTH = 64
    const input = createPushable<AgentUserMessage>(
      'input-' + opts.id.slice(0, 8),
      INPUT_QUEUE_MAX_DEPTH,
      opts.onUserMessageConsumed,
    )
    const abortController = new AbortController()
    sdkOptions.abortController = abortController
    // Correlate spawns to sessions via closure, NOT the AbortSignal: the SDK
    // hands spawnClaudeCodeProcess its OWN internal forwardedAbort.signal
    // (never our abortController.signal), so the signal can't be a Map key.
    // register() returns a MonitoredSpawn captured by the per-session spawn
    // closure; its `exited` promise resolves on the real process exit (used
    // by SessionManager.clear() to gate respawn on the old child dying).
    const reg = this.processMonitor.register(opts.id)
    sdkOptions.spawnClaudeCodeProcess = (o) => this.processMonitor.spawnFor(reg, o)
    // Permanent spawn diagnostics: every parameter the subprocess receives,
    // in one structured line. Info level so it's always on — spawns are rare
    // (one per open / resume / fork / clear), and this is the first place to
    // look when a session's shape (model, betas, context window, permission
    // mode) differs from what was asked for. Gated via enabled() so the env
    // summary is only built when the level is actually active.
    if (log.enabled('info')) {
      log.info('createSession', summarizeSpawn(opts, sdkOptions))
    }

    const q = query({ prompt: input.iterable, options: sdkOptions })
    const handle = new ClaudeSessionHandle(
      q,
      input,
      abortController,
      reg.exited,
      () => this.processMonitor.unregister(reg),
      // opts.id is the app-level session id, which doubles as the SDK on-disk
      // session id on fresh/fork spawns and equals the resumed id on resume —
      // so it locates this session's own `subagents/` transcript dir. cwd
      // narrows the SDK project-dir scan to the right projects subtree.
      opts.id,
      opts.cwd,
    )

    if (opts.fastMode) {
      void q.applyFlagSettings({ fastMode: true }).catch((err) => {
        log.warn(`[${opts.id}] re-applying fastMode on spawn failed:`, err)
      })
    }
    if (opts.effortLevel) {
      void q.applyFlagSettings({ effortLevel: opts.effortLevel as 'low' | 'medium' | 'high' | 'xhigh' }).catch((err) => {
        log.warn(`[${opts.id}] applying effortLevel on spawn failed:`, err)
      })
    }
    // Auto-compact window intent (SDK Settings key with no spawn-time Options
    // equivalent) — re-applied post-spawn exactly like fastMode/effortLevel
    // above. Only a positive token count pins a window; undefined = "auto".
    if (opts.autoCompactWindow !== undefined && opts.autoCompactWindow > 0) {
      void q.applyFlagSettings({
        autoCompactWindow: Math.round(opts.autoCompactWindow),
        autoCompactEnabled: true,
      }).catch((err) => {
        log.warn(`[${opts.id}] applying autoCompactWindow on spawn failed:`, err)
      })
    }
    // Auto-memory intent (enable / directory / auto-dream). These are SDK
    // Settings keys with no spawn-time Options equivalent, so they're
    // re-applied post-spawn exactly like fastMode above. Spawn-time values
    // are never null — nulls only arrive via the live setMemorySettings
    // route, which goes straight to the handle.
    if (
      opts.memory &&
      (opts.memory.autoMemoryEnabled !== undefined ||
        opts.memory.autoMemoryDirectory !== undefined ||
        opts.memory.autoDreamEnabled !== undefined)
    ) {
      const memoryFlags: Record<string, boolean | string> = {}
      if (opts.memory.autoMemoryEnabled !== undefined) memoryFlags.autoMemoryEnabled = opts.memory.autoMemoryEnabled
      if (opts.memory.autoMemoryDirectory !== undefined) memoryFlags.autoMemoryDirectory = opts.memory.autoMemoryDirectory
      if (opts.memory.autoDreamEnabled !== undefined) memoryFlags.autoDreamEnabled = opts.memory.autoDreamEnabled
      void q.applyFlagSettings(memoryFlags).catch((err) => {
        log.warn(`[${opts.id}] re-applying memory settings on spawn failed:`, err)
      })
    }
    // Sandbox intent (SDK Settings.sandbox, no spawn-time Options equivalent)
    // — re-applied post-spawn exactly like memory/autoCompactWindow above,
    // via the flag-settings layer. NOT Options.sandbox: passing `enabled` via
    // Options defaults failIfUnavailable=true, which makes a whole session
    // error out when sandbox dependencies are missing (e.g. bubblewrap on
    // Linux); the settings layer degrades gracefully instead. A present object
    // sets the flag (null-clearing happens via the live setSandbox route).
    if (opts.sandbox) {
      void q.applyFlagSettings({ sandbox: opts.sandbox }).catch((err) => {
        log.warn(`[${opts.id}] applying sandbox on spawn failed:`, err)
      })
    }

    // Fallback degradation chain for group sessions: tier aliases below the
    // main slot, resolved by the CLI through the tier env vars. Post-spawn
    // because fallbackModel is a Settings key with no spawn-time Options
    // equivalent — exactly like fastMode/effortLevel above.
    if (group) {
      const fallback = fallbackAliasesFor(group.main ?? 'opus')
      if (fallback.length > 0) {
        void q.applyFlagSettings({ fallbackModel: fallback }).catch((err) => {
          log.warn(`[${opts.id}] applying fallbackModel on spawn failed:`, err)
        })
      }
    }

    return handle
  }

  /** One-shot headless structured-output run (SDK Options.outputFormat).
   *  Spawns a fresh, non-persisted query with a single user message and runs
   *  it to a terminal `result` frame, then narrows the outcome. Unlike
   *  createSession there is no session lifecycle to manage — no SessionMeta,
   *  no residents, no processMonitor: the query is short-lived and torn down
   *  via abort in the finally. The SDK forwards the schema to the CLI subprocess
   *  as `--json-schema` automatically, so no flag is built here. */
  async runStructured(req: StructuredRunRequest, signal?: AbortSignal): Promise<StructuredRunResult> {
    const { prompt, schema, cwd, model, maxTurns, maxBudgetUsd } = req
    const permissionMode = req.permissionMode as PermissionMode | undefined
    const abortController = new AbortController()
    // External abort (client cancel / server timeout) tears down the
    // subprocess exactly as a local abort would. The abort-listener guard
    // also covers a signal that was already aborted before we subscribed.
    const onAbort = () => abortController.abort()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const sdkOptions: Options = {
      outputFormat: { type: 'json_schema', schema },
      env: this.buildAnthropicEnv(),
      abortController,
      // We only need the terminal result frame — skip partial/turn-suggestion
      // noise on the wire.
      includePartialMessages: false,
      promptSuggestions: false,
      agentProgressSummaries: false,
    }
    if (this.opts.claudeBinary) sdkOptions.pathToClaudeCodeExecutable = this.opts.claudeBinary
    if (model) sdkOptions.model = model
    if (cwd) sdkOptions.cwd = cwd
    if (maxTurns !== undefined) sdkOptions.maxTurns = maxTurns
    if (maxBudgetUsd !== undefined) sdkOptions.maxBudgetUsd = maxBudgetUsd
    // Forward the permission mode verbatim (same enum as sessions). A one-shot
    // run has no app-level mode translation layer, but the value space is the
    // same SDK PermissionMode. Default = SDK default when absent.
    if (permissionMode) sdkOptions.permissionMode = permissionMode
    if (permissionMode === 'bypassPermissions') {
      // bypass requires the SDK's explicit guard — the enum alone is not
      // enough or the spawn fails.
      sdkOptions.allowDangerouslySkipPermissions = true
    } else {
      // Headless one-shot has no web UI to answer tool permission prompts, so
      // a permissioned call would sit unanswered until the 120s timeout. Auto-
      // deny every permission-requiring call (safe reads flow through approval
      // rules and never reach canUseTool), keeping the run read-only by default
      // and guaranteeing it terminates. Deny with interrupt:false so the model
      // re-plans instead of aborting the turn.
      sdkOptions.canUseTool = async () =>
        ({ behavior: 'deny', message: 'denied by structured run', interrupt: false }) as const
    }

    // Close the input after the single user turn so the run is clearly
    // bounded (a still-open iterable leaves the CLI waiting for more input).
    const input = createPushable<AgentUserMessage>('structured', 1)
    const userMsg: AgentUserMessage = {
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: randomUUID(),
    }
    input.push(userMsg)
    input.end()

    // The whole body is under try/finally so ANY synchronous throw (including
    // from query() itself) still tears down the subprocess via abort.
    try {
      const q = query({ prompt: input.iterable, options: sdkOptions })
      for await (const msg of q) {
        if (msg.type === 'result') return this.toStructuredResult(msg)
      }
      return {
        ok: false,
        errorSubtype: 'error_during_execution',
        errors: ['agent finished without a result message'],
      }
    } catch (err) {
      // External abort (client cancel / timeout) surfaces as AbortError here.
      // The route owns the 408/abort response; this provider just must not
      // leave an unhandled rejection — return a benign aborted result.
      if (err && (err as Error).name === 'AbortError') {
        return { ok: false, errorSubtype: 'error_during_execution', errors: ['run aborted'] }
      }
      throw err
    } finally {
      try {
        abortController.abort()
      } catch {
        // abort never throws, but keep teardown defensive
      }
    }
  }

  /** Narrow an SDK result frame into the browser-safe StructuredRunResult.
   *  Success (subtype 'success') carries structured_output + run metadata;
   *  any other subtype is an error carrying its SDK-defined reason. Callers
   *  pass only `type:'result'` frames. */
  private toStructuredResult(msg: SDKMessage): StructuredRunResult {
    const s = msg as SDKResultSuccess
    if (s.subtype === 'success') {
      return {
        ok: true,
        structuredOutput: s.structured_output,
        rawText: s.result,
        numTurns: s.num_turns,
        totalCostUsd: s.total_cost_usd,
      }
    }
    const e = msg as SDKResultError
    return { ok: false, errorSubtype: e.subtype, errors: e.errors }
  }

  async getSessionInfo(id: string, opts?: { dir?: string }): Promise<ResumableSession | undefined> {
    const info = await getSessionInfo(id, opts?.dir ? { dir: opts.dir } : undefined)
    return info ? this.toResumable(info) : undefined
  }

  async listResumable(opts?: ListResumableOptions): Promise<ResumableSession[]> {
    const raw = await listSessions(opts?.dir ? { dir: opts.dir } : undefined)
    return raw.map((session) => this.toResumable(session))
  }

  readHistoryPage(id: string, opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string }): Promise<HistoryPage> {
    return readHistoryPage(id, opts)
  }

  readHistoryEntries(id: string, opts: { afterUuid?: string }): Promise<HistoryEntry[]> {
    return readHistoryEntries(id, opts)
  }

  async hasTranscript(meta: SessionMeta): Promise<boolean> {
    const info = await getSessionInfo(meta.id, meta.cwd ? { dir: meta.cwd } : undefined)
    return !!info
  }

  /** Append a custom-title entry to the session's on-disk transcript (SDK
   *  renameSession), so a manual retitle also survives an external
   *  `claude --resume` — which otherwise prefers the CLI's own transcript
   *  title over this app's metadata. `dir` scopes the project-dir scan. */
  async renameSession(sessionId: string, title: string, opts?: { dir?: string }): Promise<void> {
    await sdkRenameSession(sessionId, title, opts?.dir ? { dir: opts.dir } : undefined)
  }

  private toResumable(info: SDKSessionInfo): ResumableSession {
    return {
      provider: this.name,
      sessionId: info.sessionId,
      title: info.customTitle ?? info.summary ?? info.firstPrompt,
      firstPrompt: info.firstPrompt,
      cwd: info.cwd,
      createdAt: info.createdAt,
      lastModified: info.lastModified,
      gitBranch: info.gitBranch,
      known: false,
      running: false,
      terminated: false,
    }
  }

  private sdkForwardMode(mode?: PermissionMode): PermissionMode | undefined {
    return mode === 'plan' ? 'plan' : undefined
  }

  private applyStandardQueryOpts(
    opts: Options,
    customEnv?: Record<string, string>,
    enabledPlugins?: string[],
    group?: ModelGroupConfig,
    profile: ProviderProfile = resolveActiveProfile(defaultConfig.profiles, defaultConfig.activeProfileId, DEFAULT_PROFILE),
  ): void {
    if (opts.includePartialMessages === undefined) opts.includePartialMessages = true
    if (!opts.pathToClaudeCodeExecutable && this.opts.claudeBinary) {
      opts.pathToClaudeCodeExecutable = this.opts.claudeBinary
    }
    const effectiveModel = opts.model || profileDefaultModel(profile)
    if (group) {
      // Real three-tier routing: each slot maps to its own model so the CLI
      // resolves tier aliases + background-subagent routing independently.
      // The four tier env vars stay in the per-session opts.env — NEVER in
      // buildAnthropicEnv()'s shared cache (cross-session contamination).
      const r = resolveGroup(group, (m) => resolveConfiguredModel(m, profile.modelList))
      opts.model = r.main
      opts.env = {
        ...(opts.env ?? this.buildAnthropicEnv(profile)),
        ANTHROPIC_DEFAULT_OPUS_MODEL: r.tiers.opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: r.tiers.sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: r.tiers.haiku,
        ANTHROPIC_SMALL_FAST_MODEL: r.tiers.haiku,
      }
      // Lever B — gateway capability declaration. Only for opaque models on
      // non-first-party base URLs: recognizable ids let the CLI's built-in
      // detection decide (more accurate), and first-party hosts need nothing.
      if (!isFirstPartyAnthropicUrl(profile.baseUrl)) {
        for (const tier of ['OPUS', 'SONNET', 'HAIKU'] as const) {
          const slot = tier.toLowerCase() as 'opus' | 'sonnet' | 'haiku'
          const caps = capabilitiesForTier(slot, r.tiers[slot])
          if (caps.length > 0) {
            opts.env[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`] = r.tiers[slot]
            opts.env[`ANTHROPIC_DEFAULT_${tier}_MODEL_DESCRIPTION`] = r.tiers[slot]
            opts.env[`ANTHROPIC_DEFAULT_${tier}_MODEL_SUPPORTED_CAPABILITIES`] = caps.join(',')
          }
        }
      }
    } else {
      // Today's behavior unchanged: collapse all four aliases to the model.
      opts.model = effectiveModel
      opts.env = {
        ...(opts.env ?? this.buildAnthropicEnv(profile)),
        ANTHROPIC_DEFAULT_OPUS_MODEL: effectiveModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: effectiveModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: effectiveModel,
        ANTHROPIC_SMALL_FAST_MODEL: effectiveModel,
      }
    }
    if (customEnv) opts.env = { ...opts.env, ...customEnv }
    // Force-disable the CLI's auto-updater. claude-react-web pins the binary
    // itself (resolveClaudeBinary -> pathToClaudeCodeExecutable), so if a
    // spawned subprocess ALSO runs its own updater, an upgrade replaces
    // claude.exe mid-flight and concurrent session spawns hit ENOENT during
    // the replacement window — every live session crashes with spawn_failed.
    // The updater runs inside the subprocess, so it isn't logged here; it
    // only surfaces as a burst of spawn_failed (observed: a 2.1.201 ->
    // 2.1.212 auto-update took down all sessions at once). Asserted AFTER
    // customEnv so even a per-session `env` can't re-enable it; operators
    // update the binary manually (npm i -g) and restart.
    opts.env = { ...opts.env, DISABLE_AUTOUPDATER: '1' }
    if (this.opts.mpStore) {
      // `enabledPlugins` undefined = all enabled (default). Present (incl. [])
      // = resolve only that subset. [] naturally yields an empty path list,
      // leaving opts.plugins unset so no plugins load.
      const enabledPaths = enabledPlugins !== undefined
        ? this.opts.mpStore.getEnabledPluginAbsolutePathsFor(enabledPlugins)
        : this.opts.mpStore.getEnabledPluginAbsolutePaths()
      if (enabledPaths.length > 0) {
        const existing = opts.plugins ?? []
        opts.plugins = [
          ...existing,
          ...enabledPaths.map((path) => ({ type: 'local' as const, path })),
        ]
      }
    }
    // Enabled custom agent definitions ride every spawn's Options.agents,
    // mirroring how the mpStore block injects plugin paths above.
    injectAgentDefinitions(opts, this.opts.agentStore)
  }

  private buildAnthropicEnv(profile: ProviderProfile = resolveActiveProfile(defaultConfig.profiles, defaultConfig.activeProfileId, DEFAULT_PROFILE)): NodeJS.ProcessEnv {
    if (
      this.cachedEnv &&
      this.cachedAuthToken === profile.authToken &&
      this.cachedBaseUrl === profile.baseUrl
    ) {
      return this.cachedEnv
    }
    this.cachedAuthToken = profile.authToken
    this.cachedBaseUrl = profile.baseUrl
    this.cachedEnv = buildProfileEnv(profile, defaultConfig.maxOutputTokens)
    return this.cachedEnv
  }
}
