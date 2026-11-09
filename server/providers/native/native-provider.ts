// server/providers/native/native-provider.ts
//
// The self-built agent provider: no CLI subprocess — the turn loop, tools,
// and Anthropic streaming all run in this process (server/providers/native/*).
// Registration lives in ../default-providers.ts alongside ClaudeProvider.

import { config, requireAuthToken } from '../../config.js'
import type { HistoryEntry, HistoryPage } from '../../history-reader.js'
import type { SessionMeta } from '../../persistence.js'
import type { AgentProvider, CreateSessionOptions, ProviderCapabilities, ProviderSessionHandle } from '../types.js'
import type { LoopDeps } from './loop.js'
import { PromptSectionRegistry, IDENTITY_SECTION } from './prompt/sections.js'
import { NativeSession } from './native-session.js'
import { nativeHistoryCache } from './session-log/cache.js'
import { deleteNativeSessionLog, hasNativeSessionLog } from './session-log/log.js'
import { resolveNativeStateDir } from './session-log/paths.js'
import { readNativeHistoryEntries, readNativeHistoryPage } from './session-log/reader.js'
import { bashTool } from './tools/bash.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { grepTool } from './tools/grep.js'
import type { ToolDef } from './tools/types.js'

const TOOLS: ToolDef[] = [bashTool, readTool, writeTool, editTool, grepTool]

export class NativeProvider implements AgentProvider {
  readonly name = 'native'
  /** Native session logs live under `<stateDir>/native-sessions/`. */
  readonly stateDir: string
  readonly capabilities: ProviderCapabilities = {
    supportsFineGrainedPermissions: true,
    supportsMcp: false,
    supportsModelSwitch: true,
    supportsInterrupt: true,
    supportsResume: true,
    supportsFork: true,
    supportsPlugins: false,
    supportsFastMode: false,
    supportsEffortLevel: false,
    supportsThinkingControl: false,
    supportsCommands: false,
    supportsAgents: false,
    supportsContextUsage: true,
    supportsUsage: true,
    supportsAccountInfo: false,
    supportsSessionTitle: false,
    supportsTaskControl: false,
    supportsStructuredOutput: false,
    supportsReadFile: false,
    supportsSubagentTranscripts: false,
    supportsSteering: false,
  }

  /** Test seam: when set, replaces the real network streamer for every turn.
   *  Read per turn via the session's streamSupplier, so tests can swap the
   *  script between turns. Not part of the public contract. */
  _testStream?: LoopDeps['stream']

  constructor(opts: { stateDir?: string } = {}) {
    this.stateDir = resolveNativeStateDir(opts.stateDir)
  }

  createSession(opts: CreateSessionOptions): ProviderSessionHandle {
    // One registry per session: sections are stable per conversation in P1.
    const registry = new PromptSectionRegistry()
    registry.register(IDENTITY_SECTION)
    for (const tool of TOOLS) {
      registry.register({ name: `tool:${tool.name}`, order: tool.promptOrder, text: tool.guidance })
    }
    const systemPromptAppend = (opts as { systemPromptAppend?: string }).systemPromptAppend
    const system = systemPromptAppend ? `${registry.render()}\n\n${systemPromptAppend}` : registry.render()
    return new NativeSession({
      id: opts.id,
      cwd: opts.cwd ?? process.cwd(),
      stateDir: this.stateDir,
      resume: opts.resume,
      forkSession: opts.forkSession,
      resumeSessionAt: opts.resumeSessionAt,
      model: opts.model,
      permissionMode: opts.permissionMode,
      credentials: () => ({
        baseUrl: opts.profile?.baseUrl ?? config.baseUrl,
        authToken: opts.profile?.authToken ?? requireAuthToken(),
      }),
      tools: TOOLS,
      system,
      canUseTool: opts.canUseTool,
      onUserMessageConsumed: opts.onUserMessageConsumed,
      streamSupplier: () => this._testStream,
    })
  }

  readHistoryPage(
    id: string,
    opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
  ): Promise<HistoryPage> {
    return readNativeHistoryPage(this.stateDir, id, opts)
  }

  readHistoryEntries(id: string, opts: { afterUuid?: string }): Promise<HistoryEntry[]> {
    return readNativeHistoryEntries(this.stateDir, id, opts)
  }

  hasTranscript(meta: SessionMeta): Promise<boolean> {
    return hasNativeSessionLog(this.stateDir, meta.id)
  }

  deleteTranscript(id: string): Promise<boolean> {
    nativeHistoryCache.invalidate(id)
    return deleteNativeSessionLog(this.stateDir, id)
  }
}
