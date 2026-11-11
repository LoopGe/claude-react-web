// server/providers/native/native-provider.ts
//
// The self-built agent provider: no CLI subprocess — the turn loop, tools,
// and Anthropic streaming all run in this process (server/providers/native/*).
// Registration lives in ../default-providers.ts alongside ClaudeProvider.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { config, requireAuthToken } from '../../config.js'
import type { HistoryEntry, HistoryPage } from '../../history-reader.js'
import type { SessionMeta } from '../../persistence.js'
import type { AgentProvider, CreateSessionOptions, ProviderCapabilities, ProviderSessionHandle } from '../types.js'
import type { LoopDeps } from './loop.js'
import { NativeMcpConnections } from './mcp/connections.js'
import { PromptSectionRegistry, IDENTITY_SECTION, type PromptSection } from './prompt/sections.js'
import { NativeSession } from './native-session.js'
import { AGENT_GUIDANCE } from './subagent.js'
import { SKILL_GUIDANCE } from './tools/skill.js'
import { nativeHistoryCache } from './session-log/cache.js'
import { deleteNativeSessionLog, hasNativeSessionLog } from './session-log/log.js'
import { resolveNativeStateDir } from './session-log/paths.js'
import { readNativeHistoryEntries, readNativeHistoryPage } from './session-log/reader.js'
import { bashTool } from './tools/bash.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { grepTool } from './tools/grep.js'
import { globTool } from './tools/glob.js'
import { lsTool } from './tools/ls.js'
import type { ToolDef } from './tools/types.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'

const TOOLS: ToolDef[] = [bashTool, readTool, writeTool, editTool, grepTool, globTool, lsTool]

/** The Agent tool's prompt section. The text is the tool def's own guidance
 *  (one exported constant), so the section and the schema cannot drift. */
const AGENT_SECTION: PromptSection = { name: 'tool:Agent', order: 80, text: AGENT_GUIDANCE }

/** The Skill tool's prompt section, same single-source rule. Registered in
 *  BOTH prompts: the Skill tool is still in a subagent's tool list. */
const SKILL_SECTION: PromptSection = { name: 'tool:Skill', order: 85, text: SKILL_GUIDANCE }

/** Build this session's system prompt (plus any per-session append). The
 *  subagent variant omits the Agent section — see createSession. */
function renderSystem(opts: { withAgentSection: boolean; systemPromptAppend?: string }): string {
  const registry = new PromptSectionRegistry()
  registry.register(IDENTITY_SECTION)
  for (const tool of TOOLS) {
    registry.register({ name: `tool:${tool.name}`, order: tool.promptOrder, text: tool.guidance })
  }
  if (opts.withAgentSection) registry.register(AGENT_SECTION)
  registry.register(SKILL_SECTION)
  const rendered = registry.render()
  return opts.systemPromptAppend ? `${rendered}\n\n${opts.systemPromptAppend}` : rendered
}

export class NativeProvider implements AgentProvider {
  readonly name = 'native'
  /** Native session logs live under `<stateDir>/native-sessions/`. */
  readonly stateDir: string
  readonly capabilities: ProviderCapabilities = {
    supportsFineGrainedPermissions: true,
    supportsMcp: true,
    supportsModelSwitch: true,
    supportsInterrupt: true,
    supportsResume: true,
    supportsFork: true,
    supportsPlugins: false,
    supportsFastMode: true,
    supportsEffortLevel: true,
    supportsThinkingControl: true,
    supportsCommands: true,
    supportsAgents: true,
    supportsContextUsage: true,
    supportsUsage: true,
    supportsAccountInfo: false,
    supportsSessionTitle: false,
    supportsTaskControl: false,
    supportsStructuredOutput: false,
    supportsReadFile: false,
    supportsSubagentTranscripts: false,
    supportsSteering: true,
  }

  /** Test seam: when set, replaces the real network streamer for every turn.
   *  Read per turn via the session's streamSupplier, so tests can swap the
   *  script between turns. Not part of the public contract. */
  _testStream?: LoopDeps['stream']

  /** OAuth provider resolver for a remote MCP server (see
   *  NativeMcpConnectionsOptions.authFor). Undefined when the host stores no
   *  MCP credentials. */
  readonly authFor?: (name: string) => OAuthClientProvider | undefined

  /** Custom agent definitions the Agent tool resolves `subagent_type`
   *  against; forwarded to every session this provider creates. */
  readonly agentStore?: AgentDefinitionStore

  constructor(opts: {
    stateDir?: string
    authFor?: (name: string) => OAuthClientProvider | undefined
    agentStore?: AgentDefinitionStore
  } = {}) {
    this.stateDir = resolveNativeStateDir(opts.stateDir)
    this.authFor = opts.authFor
    this.agentStore = opts.agentStore
  }

  createSession(opts: CreateSessionOptions): ProviderSessionHandle {
    // Prompt sections are stable per conversation in P1 (no hot-plug). The parent
    // prompt advertises Agent; the subagent prompt does not — nested tools drop
    // Agent, and guidance for a tool the model cannot call is misleading.
    const systemPromptAppend = (opts as { systemPromptAppend?: string }).systemPromptAppend
    const system = renderSystem({ withAgentSection: true, systemPromptAppend })
    const subagentSystem = renderSystem({ withAgentSection: false, systemPromptAppend })
    // The manager has already resolved globals + inline configs + first-party
    // `injectAll` results into `mcpServers`. Connections start here and are
    // awaited per turn, so spawn never blocks on a slow server.
    const mcp = new NativeMcpConnections({ authFor: this.authFor })
    mcp.load(opts.mcpServers as Record<string, unknown> | undefined)
    // Spawn skill policy rides the SDK-shaped create body the manager already
    // forwards through providerExtras (`Options.skills`).
    const sdkOptions = opts.providerExtras?.sdkOptions as { skills?: string[] | 'all' } | undefined
    // The constructor can throw on real paths (corrupt/unsupported log, missing
    // fork log). The queued connect has no owner then, so it must be torn down
    // here or it would run forever and leak its children.
    try {
      return new NativeSession({
        id: opts.id,
        cwd: opts.cwd ?? process.cwd(),
        stateDir: this.stateDir,
        resume: opts.resume,
        forkSession: opts.forkSession,
        resumeSessionAt: opts.resumeSessionAt,
        model: opts.model,
        permissionMode: opts.permissionMode,
        thinking: opts.thinking,
        effortLevel: opts.effortLevel,
        fastMode: opts.fastMode,
        profile: opts.profile,
        credentials: () => ({
          baseUrl: opts.profile?.baseUrl ?? config.baseUrl,
          authToken: opts.profile?.authToken ?? requireAuthToken(),
        }),
        tools: TOOLS,
        mcp,
        agentStore: this.agentStore,
        skills: sdkOptions?.skills,
        system,
        subagentSystem,
        canUseTool: opts.canUseTool,
        onUserMessageConsumed: opts.onUserMessageConsumed,
        onSupplementDelivered: opts.onSupplementDelivered,
        streamSupplier: () => this._testStream,
      })
    } catch (err) {
      void mcp.closeAll()
      throw err
    }
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
