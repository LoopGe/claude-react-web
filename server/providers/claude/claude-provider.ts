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
  }

  private readonly processMonitor: ProcessMonitor
  private readonly spawnWrapper: ReturnType<ProcessMonitor['createSpawnWrapper']>
  private cachedEnv?: NodeJS.ProcessEnv
  private cachedAuthToken?: string
  private cachedBaseUrl?: string

  constructor(private readonly opts: ClaudeProviderOptions = {}) {
    this.processMonitor = new ProcessMonitor((info) => this.opts.onProcessExit?.(info))
    this.spawnWrapper = this.processMonitor.createSpawnWrapper()
  }

  createSession(opts: CreateSessionOptions): ClaudeSessionHandle {
    const sdkOptions = { ...((opts.providerExtras?.sdkOptions as Options | undefined) ?? {}) }
    if (opts.resume && !sdkOptions.resume) sdkOptions.resume = opts.resume
    if (opts.forkSession !== undefined) sdkOptions.forkSession = opts.forkSession
    if (opts.cwd !== undefined) sdkOptions.cwd = opts.cwd
    if (opts.model !== undefined) sdkOptions.model = opts.model
    if (opts.title !== undefined) sdkOptions.title = opts.title
    if (opts.betas !== undefined) sdkOptions.betas = opts.betas as Options['betas']
    if (opts.mcpServers !== undefined) sdkOptions.mcpServers = opts.mcpServers as Options['mcpServers']
    if (opts.includePartialMessages !== undefined) sdkOptions.includePartialMessages = opts.includePartialMessages
    if (opts.effortLevel !== undefined) sdkOptions.effort = opts.effortLevel as Options['effort']

    const requestedMode = (opts.permissionMode ?? sdkOptions.permissionMode) as PermissionMode | undefined
    this.applyStandardQueryOpts(sdkOptions, opts.env)
    sdkOptions.permissionMode = this.sdkForwardMode(requestedMode)
    if (!sdkOptions.resume || sdkOptions.forkSession) {
      sdkOptions.sessionId = opts.id
    }
    if (opts.canUseTool && !sdkOptions.canUseTool) {
      sdkOptions.canUseTool = opts.canUseTool as Options['canUseTool']
    }

    const input = createPushable<AgentUserMessage>(
      'input-' + opts.id.slice(0, 8),
      undefined,
      opts.onUserMessageConsumed,
    )
    const abortController = new AbortController()
    sdkOptions.abortController = abortController
    sdkOptions.spawnClaudeCodeProcess = this.spawnWrapper
    this.processMonitor.register(abortController.signal, opts.id)

    const q = query({ prompt: input.iterable, options: sdkOptions })
    const handle = new ClaudeSessionHandle(
      q,
      input,
      abortController,
      () => this.processMonitor.unregister(abortController.signal),
    )

    if (opts.fastMode) {
      void q.applyFlagSettings({ fastMode: true }).catch((err) => {
        console.warn('[session ' + opts.id + '] re-applying fastMode on spawn failed:', err)
      })
    }
    if (opts.effortLevel) {
      void q.applyFlagSettings({ effortLevel: opts.effortLevel as 'low' | 'medium' | 'high' | 'xhigh' }).catch((err) => {
        console.warn('[session ' + opts.id + '] applying effortLevel on spawn failed:', err)
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

  private applyStandardQueryOpts(opts: Options, customEnv?: Record<string, string>): void {
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
    if (this.opts.mpStore) {
      const enabledPaths = this.opts.mpStore.getEnabledPluginAbsolutePaths()
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
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ANTHROPIC_') && key !== 'ANTHROPIC_API_KEY' && !(key in env)) {
        env[key] = process.env[key]
      }
    }
    this.cachedEnv = env
    return env
  }
}
