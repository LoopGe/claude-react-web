import {
  getSessionInfo,
  listSessions,
  query,
  type Options,
  type PermissionMode,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk'
import { config as defaultConfig } from '../../config.js'
import { readHistoryEntries, readHistoryPage } from '../../history-reader.js'
import type { HistoryEntry, HistoryPage } from '../../history-reader.js'
import type { SessionMeta } from '../../persistence.js'
import type { MpStore } from '../../mp-store.js'
import { createPushable } from '../../pushable.js'
import { ProcessMonitor, type ProcessExitInfo } from '../../process-monitor.js'
import type { AgentProvider, CreateSessionOptions, ListResumableOptions, ProviderCapabilities } from '../types.js'
import { ClaudeSessionHandle } from './claude-session.js'
import type { AgentUserMessage } from '../../agent-message.js'
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

export interface ClaudeProviderOptions {
  claudeBinary?: string
  mpStore?: MpStore
  onProcessExit?: (info: ProcessExitInfo) => void
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
    supportsCommands: true,
    supportsAgents: true,
    supportsContextUsage: true,
    supportsUsage: true,
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
    if (opts.resume && !sdkOptions.resume) sdkOptions.resume = opts.resume
    if (opts.forkSession !== undefined) sdkOptions.forkSession = opts.forkSession
    if (opts.resumeSessionAt !== undefined) sdkOptions.resumeSessionAt = opts.resumeSessionAt
    if (opts.cwd !== undefined) sdkOptions.cwd = opts.cwd
    if (opts.model !== undefined) sdkOptions.model = opts.model
    if (opts.title !== undefined) sdkOptions.title = opts.title
    if (opts.betas !== undefined) sdkOptions.betas = opts.betas as Options['betas']
    if (opts.mcpServers !== undefined) sdkOptions.mcpServers = opts.mcpServers as Options['mcpServers']
    if (opts.includePartialMessages !== undefined) sdkOptions.includePartialMessages = opts.includePartialMessages
    if (opts.includeHookEvents !== undefined) sdkOptions.includeHookEvents = opts.includeHookEvents
    if (opts.effortLevel !== undefined) sdkOptions.effort = opts.effortLevel as Options['effort']

    const requestedMode = (opts.permissionMode ?? sdkOptions.permissionMode) as PermissionMode | undefined
    this.applyStandardQueryOpts(sdkOptions, opts.env, opts.enabledPlugins)
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
    log.debug(`[provider] createSession id=${opts.id}`)

    const q = query({ prompt: input.iterable, options: sdkOptions })
    const handle = new ClaudeSessionHandle(
      q,
      input,
      abortController,
      reg.exited,
      () => this.processMonitor.unregister(reg),
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

    return handle
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

  private applyStandardQueryOpts(opts: Options, customEnv?: Record<string, string>, enabledPlugins?: string[]): void {
    if (opts.includePartialMessages === undefined) opts.includePartialMessages = true
    if (!opts.pathToClaudeCodeExecutable && this.opts.claudeBinary) {
      opts.pathToClaudeCodeExecutable = this.opts.claudeBinary
    }
    const effectiveModel = opts.model || defaultConfig.defaultModel
    opts.env = {
      ...(opts.env ?? this.buildAnthropicEnv()),
      ANTHROPIC_DEFAULT_OPUS_MODEL: effectiveModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: effectiveModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: effectiveModel,
      ANTHROPIC_SMALL_FAST_MODEL: effectiveModel,
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
  }

  private buildAnthropicEnv(): NodeJS.ProcessEnv {
    if (
      this.cachedEnv &&
      this.cachedAuthToken === defaultConfig.authToken &&
      this.cachedBaseUrl === defaultConfig.baseUrl
    ) {
      return this.cachedEnv
    }
    this.cachedAuthToken = defaultConfig.authToken
    this.cachedBaseUrl = defaultConfig.baseUrl
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
      ANTHROPIC_AUTH_TOKEN: defaultConfig.authToken,
      ANTHROPIC_BASE_URL: defaultConfig.baseUrl,
      ANTHROPIC_API_KEY: undefined,
    }
    // Pass through max output tokens config to the CLI subprocess. The CLI
    // reads CLAUDE_CODE_MAX_OUTPUT_TOKENS to cap single-response output;
    // 0 / unset = CLI default. Only set when the user configured a non-zero
    // value (don't override the CLI's own default with 0).
    if (defaultConfig.maxOutputTokens > 0) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(defaultConfig.maxOutputTokens)
    }
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ANTHROPIC_') && key !== 'ANTHROPIC_API_KEY' && !(key in env)) {
        env[key] = process.env[key]
      }
    }
    // Tool search (the CLI's default 'tst' mode) defers MCP tools behind
    // `tool_reference` beta blocks. Non-first-party API proxies reject /
    // silently drop those blocks, so the model never receives the tool
    // schemas and can't call MCP tools — even though mcp-status reports
    // them connected. claude-code has the same gate inside the CLI, but
    // older CLI binaries predate it; enforcing it here makes MCP work
    // regardless of CLI version. Respect an explicit ENABLE_TOOL_SEARCH
    // from the host env if the user set one.
    if (
      !('ENABLE_TOOL_SEARCH' in env) &&
      defaultConfig.baseUrl &&
      !isFirstPartyAnthropicUrl(defaultConfig.baseUrl)
    ) {
      env.ENABLE_TOOL_SEARCH = 'false'
      log.info(`non-first-party ANTHROPIC_BASE_URL=${defaultConfig.baseUrl} — forcing ENABLE_TOOL_SEARCH=false so MCP tools aren't deferred behind unsupported tool_reference blocks`)
    }
    this.cachedEnv = env
    return env
  }
}
