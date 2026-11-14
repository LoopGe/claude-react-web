// server/providers/native/native-provider.ts
//
// The self-built agent provider: no CLI subprocess — the turn loop, tools,
// and Anthropic streaming all run in this process (server/providers/native/*).
// Registration lives in ../default-providers.ts alongside ClaudeProvider.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { config, DEFAULT_PROFILE, requireAuthToken } from '../../config.js'
import { resolveActiveProfile } from '../../profiles.js'
import { HttpError } from '../../errors.js'
import type { HistoryEntry, HistoryPage } from '../../history-reader.js'
import type { SessionMeta } from '../../persistence.js'
import type { AgentProvider, CreateSessionOptions, ProviderCapabilities, ProviderSessionHandle, ProviderSessionRef } from '../types.js'
import type { LoopDeps } from './loop.js'
import { NativeMcpConnections } from './mcp/connections.js'
import { PromptSectionRegistry, IDENTITY_SECTION, type PromptSection } from './prompt/sections.js'
import { NativeSession } from './native-session.js'
import { NativeModelContextResolver } from './model-context.js'
import { AnthropicModelDiscovery } from './model-discovery.js'
import { AGENT_GUIDANCE } from './subagent.js'
import { SKILL_GUIDANCE } from './tools/skill.js'
import { TASK_OUTPUT_GUIDANCE } from './tools/task-output.js'
import { nativeHistoryCache } from './session-log/cache.js'
import { deleteNativeSessionLog, hasNativeSessionLog } from './session-log/log.js'
import { resolveNativeStateDir } from './session-log/paths.js'
import { readNativeHistoryEntries, readNativeHistoryPage } from './session-log/reader.js'
import { readNativeSubagentTranscript } from './subagent-transcripts.js'
import { bashTool } from './tools/bash.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { grepTool } from './tools/grep.js'
import { globTool } from './tools/glob.js'
import { lsTool } from './tools/ls.js'
import { notebookEditTool } from './tools/notebook-edit.js'
import { askUserQuestionTool } from './tools/ask-user-question.js'
import { TODO_WRITE_GUIDANCE } from './tools/todo-write.js'
import { WEB_SEARCH_GUIDANCE } from './tools/web-search.js'
import { WEB_FETCH_GUIDANCE } from './tools/web-fetch.js'
import type { ToolDef } from './tools/types.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'
import type { UploadStore } from '../../upload-store.js'
import { NativeAttachmentReferenceIndex } from '../../attachment-reference-index.js'
import { PdfBudgetLedger, PreparedPdfStore } from './pdf-documents.js'
import { createAttachmentReadTool } from './tools/index.js'
import { copyConsumedAt, projectFileBlocksForProvider, type AgentUserMessage } from '../../agent-message.js'
import { extractToolProfile } from '../../../shared/tool-profile.js'

const TOOLS: ToolDef[] = [bashTool, readTool, writeTool, editTool, grepTool, globTool, lsTool, notebookEditTool, askUserQuestionTool]

/** Pre-fidelity native sessions consume the same legacy handle as before. The
 *  subclass lives at the provider boundary so the manager stays neutral. */
class LegacyNativeSession extends NativeSession {
  override enqueueUserMessage(message: AgentUserMessage): void {
    const projected = projectFileBlocksForProvider(message)
    super.enqueueUserMessage(projected)
    copyConsumedAt(projected, message)
  }

  override sendControlMessage(message: AgentUserMessage): void {
    const projected = projectFileBlocksForProvider(message)
    super.sendControlMessage(projected)
    copyConsumedAt(projected, message)
  }
}

/** The Agent tool's prompt section. The text is the tool def's own guidance
 *  (one exported constant), so the section and the schema cannot drift. */
const AGENT_SECTION: PromptSection = { name: 'tool:Agent', order: 80, text: AGENT_GUIDANCE }

/** TaskOutput is available to parent and nested loops through the shared manager. */
const TASK_OUTPUT_SECTION: PromptSection = { name: 'tool:TaskOutput', order: 82, text: TASK_OUTPUT_GUIDANCE }

/** The Skill tool's prompt section, same single-source rule. Registered in
 *  BOTH prompts: the Skill tool is still in a subagent's tool list. */
const SKILL_SECTION: PromptSection = { name: 'tool:Skill', order: 85, text: SKILL_GUIDANCE }

/** The two web tools are per-session factories (WebFetch needs the session's
 *  live model and profile credentials; WebSearch owns a per-session search
 *  counter), so their sections are registered from the same guidance constants
 *  instead of riding the static `TOOLS` loop. Both prompts get them: a
 *  subagent has the same tools. */
const WEB_FETCH_SECTION: PromptSection = { name: 'tool:WebFetch', order: 160, text: WEB_FETCH_GUIDANCE }
const WEB_SEARCH_SECTION: PromptSection = { name: 'tool:WebSearch', order: 170, text: WEB_SEARCH_GUIDANCE }

/** TodoWrite is a per-session factory too (the list lives in the session's
 *  tool instance), so its section rides the same explicit registration. */
const TODO_WRITE_SECTION: PromptSection = { name: 'tool:TodoWrite', order: 180, text: TODO_WRITE_GUIDANCE }

/** Build this session's system prompt (plus any per-session append). The
 *  subagent variant omits the Agent section — see createSession. */
function renderSystem(opts: { withAgentSection: boolean; systemPromptAppend?: string }, tools: readonly ToolDef[]): string {
  const registry = new PromptSectionRegistry()
  registry.register(IDENTITY_SECTION)
  for (const tool of tools) {
    registry.register({ name: `tool:${tool.name}`, order: tool.promptOrder, text: tool.guidance })
  }
  registry.register(WEB_FETCH_SECTION)
  registry.register(WEB_SEARCH_SECTION)
  registry.register(TODO_WRITE_SECTION)
  if (opts.withAgentSection) registry.register(AGENT_SECTION)
  registry.register(TASK_OUTPUT_SECTION)
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
    supportsAccountInfo: true,
    supportsSessionTitle: true,
    supportsTaskControl: true,
    supportsStructuredOutput: false,
    supportsReadFile: false,
    supportsSubagentTranscripts: true,
    supportsSteering: true,
  }

  readonly subagentTranscripts = {
    listSubagents: async (ref: ProviderSessionRef): Promise<string[]> => {
      const loaded = await nativeHistoryCache.load(this.stateDir, ref.id)
      return loaded?.subagents.entries.map((entry) => entry.agentId) ?? []
    },
    readTranscript: (ref: ProviderSessionRef, agentId: string): Promise<unknown[]> =>
      readNativeSubagentTranscript(this.stateDir, ref.id, agentId),
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

  /** Shared registry reference for the structured-attachment pipeline. The
   *  provider deliberately never constructs an independent store. */
  readonly uploadStore?: UploadStore
  readonly attachmentReferences: NativeAttachmentReferenceIndex
  private readonly modelContext: NativeModelContextResolver

  constructor(opts: {
    stateDir?: string
    authFor?: (name: string) => OAuthClientProvider | undefined
    agentStore?: AgentDefinitionStore
    uploadStore?: UploadStore
    modelContext?: NativeModelContextResolver
  } = {}) {
    this.stateDir = resolveNativeStateDir(opts.stateDir)
    this.authFor = opts.authFor
    this.agentStore = opts.agentStore
    this.uploadStore = opts.uploadStore
    const discovery = new AnthropicModelDiscovery()
    this.modelContext = opts.modelContext ?? new NativeModelContextResolver({
      discovery: {
        retrieve: async (route) => this._testStream ? undefined : discovery.retrieve(route),
      },
    })
    this.attachmentReferences = opts.uploadStore?.attachmentReferences
      ?? new NativeAttachmentReferenceIndex({ stateDir: this.stateDir })
  }

  createSession(opts: CreateSessionOptions): ProviderSessionHandle {
    // The native path has no sandbox implementation (no OS-level isolation
    // layer), so accepting the intent would silently drop it. The manager
    // rejects this before worktree provisioning for its own create path;
    // this guard covers direct provider callers (fork / respawn / tests).
    if (opts.sandbox?.enabled === true) {
      throw new HttpError(501, 'provider native does not support sandbox')
    }
    // Prompt sections are stable per conversation in P1 (no hot-plug). The parent
    // prompt advertises Agent; the subagent prompt does not — nested tools drop
    // Agent, and guidance for a tool the model cannot call is misleading.
    const systemPromptAppend = (opts as { systemPromptAppend?: string }).systemPromptAppend
    const pdfBudgets = new PdfBudgetLedger()
    const preparedPdfs = new PreparedPdfStore(pdfBudgets)
    const tools = config.nativeAttachmentFidelity && this.uploadStore
      ? [...TOOLS, createAttachmentReadTool({
          uploadStore: this.uploadStore,
          stateDir: this.stateDir,
          referenceIndex: this.attachmentReferences,
          sessionId: opts.id,
          pdfBudgets,
          preparedPdfs,
          pdfDocumentsEnabled: () => config.nativeAttachmentFidelity && config.nativePdfDocuments,
        })]
      : TOOLS
    const system = renderSystem({ withAgentSection: true, systemPromptAppend }, tools)
    const subagentSystem = renderSystem({ withAgentSection: false, systemPromptAppend }, tools)
    // The manager has already resolved globals + inline configs + first-party
    // `injectAll` results into `mcpServers`. Connections start here and are
    // awaited per turn, so spawn never blocks on a slow server.
    const mcp = new NativeMcpConnections({ authFor: this.authFor })
    mcp.load(opts.mcpServers as Record<string, unknown> | undefined)
    // Spawn skill policy rides the SDK-shaped create body the manager already
    // forwards through providerExtras (`Options.skills`).
    const sdkOptions = opts.providerExtras?.sdkOptions as ({ skills?: string[] | 'all' } & Record<string, unknown>) | undefined
    // The constructor can throw on real paths (corrupt/unsupported log, missing
    // fork log). The queued connect has no owner then, so it must be torn down
    // here or it would run forever and leak its children.
    const profile = opts.profile ?? resolveActiveProfile(config.profiles, config.activeProfileId, DEFAULT_PROFILE)
    const credentials = () => ({
      baseUrl: opts.profile?.baseUrl ?? config.baseUrl,
      authToken: opts.profile?.authToken ?? requireAuthToken(),
    })
    try {
      const SessionClass = config.nativeAttachmentFidelity ? NativeSession : LegacyNativeSession
      return new SessionClass({
        id: opts.id,
        cwd: opts.cwd ?? process.cwd(),
        stateDir: this.stateDir,
        uploadStore: this.uploadStore,
        attachmentReferences: this.attachmentReferences,
        pdfBudgets,
        preparedPdfs,
        resume: opts.resume,
        forkSession: opts.forkSession,
        resumeSessionAt: opts.resumeSessionAt,
        model: opts.model,
        agent: opts.agent,
        permissionMode: opts.permissionMode,
        thinking: opts.thinking,
        effortLevel: opts.effortLevel,
        fastMode: opts.fastMode,
        profile,
        modelContext: this.modelContext,
        credentials,
        tools,
        mcp,
        agentStore: this.agentStore,
        skills: sdkOptions?.skills,
        toolProfile: extractToolProfile(sdkOptions),
        system,
        subagentSystem,
        canUseTool: opts.canUseTool,
        onUserMessageConsumed: opts.onUserMessageConsumed,
        onUserMessagePersistence: opts.onUserMessagePersistence,
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

  async deleteTranscript(id: string): Promise<boolean> {
    nativeHistoryCache.invalidate(id)
    const deleted = await deleteNativeSessionLog(this.stateDir, id)
    this.attachmentReferences.removeSession(id)
    return deleted
  }
}
