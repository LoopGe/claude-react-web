// server/providers/native/native-provider.ts
//
// The self-built agent provider: no CLI subprocess — the turn loop, tools,
// and Anthropic streaming all run in this process (server/providers/native/*).
// Registration lives in ../default-providers.ts alongside ClaudeProvider.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { HttpError } from '../../errors.js'
import { claudeConfigDir } from '../../claude-config-dir.js'
import type { HistoryEntry, HistoryPage, HistoryReadResult } from '../../../shared/transcript-format.js'
import type { SessionMeta } from '../../persistence.js'
import type { AgentProvider, CreateSessionOptions, ListResumableOptions, ProviderCapabilities, ProviderSessionHandle, ProviderSessionRef, TasklistSource } from '../types.js'
import type { ResumableSession } from '../../session-types.js'
import {
  listNativeResumableRows,
  readNativeResumableRow,
  invalidateNativeResumableCache,
  type NativeResumableRow,
} from '../native-resumable-listing.js'
import type { LoopDeps } from './loop.js'
import type { NativeHostPorts } from './ports.js'
import { NativeMcpConnections } from './mcp/connections.js'
import { SharedRegistry } from './mcp/shared-registry.js'
import { PromptSectionRegistry, IDENTITY_SECTION, type PromptSection } from './prompt/sections.js'
import { BEHAVIOR_SECTIONS } from './prompt/behavior.js'
import {
  readNativeEnvironment,
  environmentSection,
  agentsSection,
  type NativeAvailableAgent,
  type NativeEnvironmentFacts,
} from './prompt/environment.js'
import { unsupportedAgentFields } from './agent-profile.js'
import { NativeSession, DEFAULT_MODEL } from './native-session.js'
import { runStructuredOnce } from './structured-run.js'
import type { StructuredRunRequest, StructuredRunResult } from '../../../shared/structured.js'
import { wrapNativeCore, projectFileBlocksForProvider, type NativeHostCallbacks } from '../native-host-frame-adapter.js'
import { NativeModelContextResolver } from './model-context.js'
import { AnthropicModelDiscovery } from './model-discovery.js'
import { AGENT_GUIDANCE } from './subagent.js'
import { SKILL_GUIDANCE } from './tools/skill.js'
import { TASK_OUTPUT_GUIDANCE } from './tools/task-output.js'
import { TASK_STOP_GUIDANCE } from './tools/task-stop.js'
import { nativeHistoryCache } from './session-log/cache.js'
import { appendSessionTitle, deleteNativeSessionLog, hasNativeSessionLog } from './session-log/log.js'
import { resolveNativeStateDir } from './session-log/paths.js'
import { readNativeHistoryEntries, readNativeHistoryPage, readNativeHistorySnapshot } from './session-log/reader.js'
import { readNativeSubagentTranscript } from './subagent-transcripts.js'
import { bashTool } from './tools/bash.js'
import { createReadTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { createEditTool } from './tools/edit.js'
import { grepTool } from './tools/grep.js'
import { globTool } from './tools/glob.js'
import { lsTool } from './tools/ls.js'
import { notebookEditTool } from './tools/notebook-edit.js'
import { askUserQuestionTool } from './tools/ask-user-question.js'
import { TODO_WRITE_GUIDANCE } from './tools/todo-write.js'
import { TASK_CREATE_GUIDANCE } from './tools/task-create.js'
import { TASK_UPDATE_GUIDANCE } from './tools/task-update.js'
import { TASK_GET_GUIDANCE } from './tools/task-get.js'
import { TASK_LIST_GUIDANCE } from './tools/task-list.js'
import { WEB_SEARCH_GUIDANCE } from './tools/web-search.js'
import { WEB_FETCH_GUIDANCE } from './tools/web-fetch.js'
import type { ToolDef } from './tools/types.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'
import type { UploadStore } from '../../upload-store.js'
import { NativeAttachmentReferenceIndex } from './attachment-reference-index.js'
import { PdfBudgetLedger, PreparedPdfStore } from './pdf-documents.js'
import { createAttachmentReadTool } from './tools/index.js'
import { extractToolProfile } from '../../../shared/tool-profile.js'
import { formatHooksValidationErrors, validateSessionHooksConfig, type SessionHooksConfig } from '../../../shared/hooks.js'

import { NativeReadState } from './read-state.js'

const STATIC_TOOLS: ToolDef[] = [grepTool, globTool, lsTool, notebookEditTool, askUserQuestionTool]

/** The pre-fidelity (legacy text-only) input boundary: structured file blocks
 *  become handle text BEFORE the neutral input projection, so the core receives
 *  text-only messages. Applied through wrapNativeCore's projectInput hook; the
 *  pairing/lease bookkeeping still keys on the original host message. Both this
 *  and the fidelity path compose the SAME neutral core + host adapter — the
 *  fidelity flag only selects whether the input is pre-projected here (and
 *  whether the attachment-read tool is installed), never a different session
 *  class. The projection itself is adapter-owned (re-exported from the host
 *  frame adapter, the boundary home). */
const legacyInputProjection = { projectInput: projectFileBlocksForProvider }

/** The Agent tool's prompt section. The text is the tool def's own guidance
 *  (one exported constant), so the section and the schema cannot drift. */
const AGENT_SECTION: PromptSection = { name: 'tool:Agent', order: 80, text: AGENT_GUIDANCE }

/** TaskOutput is available to parent and nested loops through the shared manager. */
const TASK_OUTPUT_SECTION: PromptSection = { name: 'tool:TaskOutput', order: 82, text: TASK_OUTPUT_GUIDANCE }

/** TaskStop shares that manager, so its section rides the same unconditional
 *  registration — a subagent can stop the session's backgrounded tasks too. */
const TASK_STOP_SECTION: PromptSection = { name: 'tool:TaskStop', order: 83, text: TASK_STOP_GUIDANCE }

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

/** The Task* family is session-owned as well (the store lives in the session),
 *  so its four sections ride the same explicit registration as TodoWrite, in
 *  BOTH prompt variants — a subagent creates and updates tasks in the same
 *  session store. Order 180 matches the tools' promptOrder; the registry's
 *  name tie-break sequences the family deterministically beside TodoWrite. */
const TASK_CREATE_SECTION: PromptSection = { name: 'tool:TaskCreate', order: 180, text: TASK_CREATE_GUIDANCE }
const TASK_UPDATE_SECTION: PromptSection = { name: 'tool:TaskUpdate', order: 180, text: TASK_UPDATE_GUIDANCE }
const TASK_GET_SECTION: PromptSection = { name: 'tool:TaskGet', order: 180, text: TASK_GET_GUIDANCE }
const TASK_LIST_SECTION: PromptSection = { name: 'tool:TaskList', order: 180, text: TASK_LIST_GUIDANCE }

/** Build this session's system prompt (plus any per-session append). The
 *  subagent variant omits the Agent section and the `<available_agents>` roster
 *  — a nested loop has no Agent tool to call (see createSession).
 *
 *  `<env>` rides BOTH prompts (a subagent works in the same working directory).
 *  Both the facts and the roster are spawn-time snapshots: the section registry
 *  is rebuilt per session, never per turn (P1 prompt-stability rule). */
function renderSystem(
  opts: {
    withAgentSection: boolean
    systemPromptAppend?: string
    env: NativeEnvironmentFacts
    agents: readonly NativeAvailableAgent[]
  },
  tools: readonly ToolDef[],
): string {
  const registry = new PromptSectionRegistry()
  registry.register(IDENTITY_SECTION)
  // Behavior/tone guidance rides both prompt variants (parent and subagent).
  for (const section of BEHAVIOR_SECTIONS) registry.register(section)
  registry.register(environmentSection(opts.env))
  if (opts.withAgentSection) {
    const agents = agentsSection(opts.agents)
    if (agents) registry.register(agents)
  }
  for (const tool of tools) {
    registry.register({ name: `tool:${tool.name}`, order: tool.promptOrder, text: tool.guidance })
  }
  registry.register(WEB_FETCH_SECTION)
  registry.register(WEB_SEARCH_SECTION)
  registry.register(TODO_WRITE_SECTION)
  registry.register(TASK_CREATE_SECTION)
  registry.register(TASK_UPDATE_SECTION)
  registry.register(TASK_GET_SECTION)
  registry.register(TASK_LIST_SECTION)
  if (opts.withAgentSection) registry.register(AGENT_SECTION)
  registry.register(TASK_OUTPUT_SECTION)
  registry.register(TASK_STOP_SECTION)
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
    supportsPlugins: true,
    // Plugin-SKILL discovery: enabledPlugins narrows the plugin-skill catalog
    // (NativeSkillCatalog). Functional alongside full plugin agent-extension
    // parity (supportsPlugins).
    supportsPluginSkills: true,
    supportsFastMode: true,
    supportsEffortLevel: true,
    supportsThinkingControl: true,
    supportsCommands: true,
    supportsAgents: true,
    supportsContextUsage: true,
    supportsUsage: true,
    // API-key auth has no subscription account to report (accountInfo()
    // resolves undefined), so the capability reflects display reality: the
    // account route 501s and the UI locks the section with a note instead of
    // rendering empty rows.
    supportsAccountInfo: false,
    supportsSessionTitle: true,
    supportsTaskControl: true,
    supportsStructuredOutput: true,
    supportsReadFile: true,
    supportsSubagentTranscripts: true,
    supportsSteering: true,
    supportsSandbox: false,
    // Session-scoped hooks run on the native engine (13 layer-1 events, the
    // flag/session config source the Settings Hooks tab edits). File-based
    // (settings.json), plugin and agent-frontmatter hook sources are NOT wired
    // yet, and 14 layer-2 events have no trigger — the Hooks panel says both
    // instead of locking the surface.
    supportsHooks: true,
    supportsMemory: false,
    tasksSurviveRestart: false,
    interleavedSubagentHistory: true,
    hostDrivenAutoCompact: true,
    persistentAttachmentRefs: true,
    cliSidePlanSteering: false,
    ownsCliTranscriptJsonl: false,
  }

  readonly subagentTranscripts = {
    listSubagents: async (ref: ProviderSessionRef): Promise<string[]> => {
      const loaded = await nativeHistoryCache.load(this.stateDir, ref.id)
      return loaded?.subagents.entries.map((entry) => entry.agentId) ?? []
    },
    readTranscript: (ref: ProviderSessionRef, agentId: string): Promise<unknown[]> =>
      readNativeSubagentTranscript(this.stateDir, ref.id, agentId, this.ports.transcript),
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
  /** Host-service ports injected by the wiring layer (default-providers /
   *  tests); threaded into every session this provider creates. Config reads
   *  (fidelity flags, profile resolution, model list) go through ports.config.
   *  The real adapters live host-side in ../native-host-adapters.ts. */
  readonly ports: NativeHostPorts
  private readonly modelContext: NativeModelContextResolver
  /** One host-global shared MCP registry per provider (the provider is
   *  one-per-host). Every session's connection view delegates its external
   *  stdio entries here, so identical configs across sessions share one child.
   *  Platform-agnostic: the record's death gate degrades on POSIX. */
  private readonly mcpRegistry: SharedRegistry

  constructor(opts: {
    stateDir?: string
    authFor?: (name: string) => OAuthClientProvider | undefined
    agentStore?: AgentDefinitionStore
    uploadStore?: UploadStore
    modelContext?: NativeModelContextResolver
    ports: NativeHostPorts
  }) {
    this.stateDir = resolveNativeStateDir(opts.stateDir)
    this.authFor = opts.authFor
    this.mcpRegistry = new SharedRegistry({ transportPort: opts.ports.mcpTransport })
    this.agentStore = opts.agentStore
    this.uploadStore = opts.uploadStore
    this.ports = opts.ports
    const discovery = new AnthropicModelDiscovery()
    this.modelContext = opts.modelContext ?? new NativeModelContextResolver({
      discovery: {
        retrieve: async (route) => this._testStream ? undefined : discovery.retrieve(route),
      },
      defaultContextWindow: () => this.ports.config.nativeDefaultContextWindow,
    })
    this.attachmentReferences = opts.uploadStore?.attachmentReferences
      ?? new NativeAttachmentReferenceIndex({ stateDir: this.stateDir })
  }

  /** Enabled agent definitions the native provider can actually run, for the
   *  `<available_agents>` roster. Definitions carrying fields the native
   *  profile does not support are skipped: advertising one would invite a
   *  `subagent_type` that fails at call time (profileFromDefinition throws).
   *  Never throws — a broken store degrades to "no custom agents". */
  private availableAgents(): NativeAvailableAgent[] {
    try {
      const store = this.agentStore
      if (!store) return []
      return store
        .list()
        .filter((def) => def.enabled && unsupportedAgentFields(def).length === 0)
        .map((def) => ({
          name: def.name,
          description: def.description,
          ...(def.tools && def.tools.length > 0 ? { tools: [...def.tools] } : {}),
        }))
    } catch {
      return []
    }
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
    // prompt advertises Agent (and the agent roster); the subagent prompt does
    // not — nested tools drop Agent, and guidance for a tool the model cannot
    // call (or an agent it cannot delegate to) is misleading.
    const systemPromptAppend = (opts as { systemPromptAppend?: string }).systemPromptAppend
    const env = readNativeEnvironment(opts.cwd ?? process.cwd())
    const agents = this.availableAgents()
    const pdfBudgets = new PdfBudgetLedger()
    const preparedPdfs = new PreparedPdfStore(pdfBudgets)
    const readState = new NativeReadState()
    const sessionTools: ToolDef[] = [
      bashTool,
      createReadTool(readState),
      writeTool,
      createEditTool(readState),
      ...STATIC_TOOLS,
    ]
    const configPort = this.ports.config
    const tools = configPort.nativeAttachmentFidelity && this.uploadStore
      ? [...sessionTools, createAttachmentReadTool({
          attachmentPort: this.ports.attachment,
          referenceIndex: this.attachmentReferences,
          sessionId: opts.id,
          pdfBudgets,
          preparedPdfs,
          pdfDocumentsEnabled: () => configPort.nativeAttachmentFidelity && configPort.nativePdfDocuments,
        })]
      : sessionTools
    const system = renderSystem({ withAgentSection: true, systemPromptAppend, env, agents }, tools)
    const subagentSystem = renderSystem({ withAgentSection: false, systemPromptAppend, env, agents: [] }, tools)
    // The manager has already resolved globals + inline configs + first-party
    // `injectAll` results into `mcpServers`. The session owns that map as the
    // user half of its two-map MCP composition (user ∪ plugin, user-wins) and
    // starts the initial connect pass in its constructor; connections are
    // awaited per turn, so spawn never blocks on a slow server.
    const mcp = new NativeMcpConnections({ transportPort: this.ports.mcpTransport, authFor: this.authFor, registry: this.mcpRegistry })
    // Spawn skill policy and the auto-compact window pin ride the SDK-shaped
    // create body the manager already forwards through providerExtras
    // (`Options.skills`, `Options.settings.autoCompactWindow`). The pin is
    // coerced here at the `unknown` boundary (same rule as the persistence
    // coerce) and reaches the neutral core as a plain number.
    const sdkOptions = opts.providerExtras?.sdkOptions as
      ({ skills?: string[] | 'all'; settings?: { hooks?: unknown; autoCompactWindow?: unknown } } & Record<string, unknown>) | undefined
    const rawAutoCompactWindow = sdkOptions?.settings?.autoCompactWindow
    const autoCompactWindow = typeof rawAutoCompactWindow === 'number' && Number.isFinite(rawAutoCompactWindow) && rawAutoCompactWindow > 0
      ? Math.round(rawAutoCompactWindow)
      : undefined
    // The constructor can throw on real paths (corrupt/unsupported log, missing
    // fork log). Its initial connect pass has no owner then, so it must be torn
    // down here or it would run forever and leak its children. `closeAll` closes
    // the local connects AND releases any shared-registry refs the load acquired.
    const profile = opts.profile ?? (configPort.hasProfiles ? configPort.activeProfile() : configPort.fallbackProfile())
    const credentials = () => {
      if (opts.profile === undefined && !profile.authToken) {
        // Preserve the lazy missing-token failure without consulting a newer
        // active profile, whose credential belongs to a different route.
        throw new HttpError(401, 'authToken is not configured. Set `authToken` in config.json (and optionally `baseUrl`).')
      }
      return { baseUrl: profile.baseUrl, authToken: profile.authToken }
    }
    try {
      // Spawn hooks ride the same settings channel as the auto-compact pin.
      // Coerced at the unknown boundary (the routes already validate; this
      // fence covers direct provider callers — fork / respawn / tests). An
      // invalid config fails loudly instead of silently dropping the hooks.
      // Inside the try so a validation throw tears down the queued MCP load.
      let hooks: SessionHooksConfig | undefined
      if (sdkOptions?.settings?.hooks !== undefined) {
        const parsedHooks = validateSessionHooksConfig(sdkOptions.settings.hooks)
        if (!parsedHooks.ok) {
          throw new HttpError(400, `invalid hooks config: ${formatHooksValidationErrors(parsedHooks.errors)}`)
        }
        hooks = parsedHooks.value
      }
      // The neutral core (NativeSessionCore) owns the turn engine, persistence
      // and neutral emission; wrapNativeCore translates it into the SDK-shaped
      // ProviderSessionHandle (host-input identity, lease callbacks, frame
      // projection). The host lease callbacks ride the WRAPPER, never the core
      // opts (R1). The pre-fidelity path projects structured files to handle
      // text before the neutral input projection; the fidelity path keeps them.
      const core = new NativeSession({
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
        autoCompactWindow,
        hooks,
        ports: this.ports,
        credentials,
        readState,
        tools,
        mcp,
        mcpServers: opts.mcpServers as Record<string, unknown> | undefined,
        agentStore: this.agentStore,
        skills: sdkOptions?.skills,
        enabledPlugins: opts.enabledPlugins,
        // The user-scope command root resolves host-side here (the CLI config
        // dir); the neutral core receives it as a plain path and never derives
        // host config itself.
        commandsUserRoot: claudeConfigDir(),
        toolProfile: extractToolProfile(sdkOptions),
        promptSuggestions: opts.promptSuggestions ?? true,
        agentProgressSummaries: opts.agentProgressSummaries ?? true,
        system,
        subagentSystem,
        canUseTool: opts.canUseTool,
        requestPermissionModeChange: opts.requestPermissionModeChange,
        requestCompact: opts.requestCompact,
        streamSupplier: () => this._testStream,
      })
      const hostCallbacks: NativeHostCallbacks = {
        onUserMessageConsumed: opts.onUserMessageConsumed,
        onUserMessagePersistence: opts.onUserMessagePersistence,
        onSupplementDelivered: opts.onSupplementDelivered,
      }
      return wrapNativeCore(core, hostCallbacks, configPort.nativeAttachmentFidelity ? {} : legacyInputProjection)
    } catch (err) {
      void mcp.closeAll()
      throw err
    }
  }

  /** One-shot headless structured run: a transient neutral runTurn context
   *  with the terminal StructuredOutput runtime attached — no session, no
   *  durable log (structured-run.ts owns the run and the headless permission
   *  policy). The profile resolves exactly like createSession; the model
   *  falls back to the native default. */
  async runStructured(req: StructuredRunRequest, signal?: AbortSignal): Promise<StructuredRunResult> {
    const configPort = this.ports.config
    const profile = configPort.hasProfiles ? configPort.activeProfile() : configPort.fallbackProfile()
    if (!profile.authToken) {
      throw new HttpError(401, 'authToken is not configured. Set `authToken` in config.json (and optionally `baseUrl`).')
    }
    return runStructuredOnce(
      req,
      {
        cwd: req.cwd ?? process.cwd(),
        model: req.model ?? DEFAULT_MODEL,
        credentials: { baseUrl: profile.baseUrl, authToken: profile.authToken },
        stream: this._testStream,
      },
      signal,
    )
  }

  readHistoryPage(
    id: string,
    opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
  ): Promise<HistoryPage> {
    return readNativeHistoryPage(this.stateDir, id, this.ports.transcript, opts)
  }

  readHistoryEntries(id: string, opts: { afterUuid?: string }): Promise<HistoryEntry[]> {
    return readNativeHistoryEntries(this.stateDir, id, this.ports.transcript, opts)
  }

  readHistoryForReconcile(id: string, opts: { afterUuid?: string }): Promise<HistoryReadResult> {
    return readNativeHistorySnapshot(this.stateDir, id, this.ports.transcript, opts)
  }

  hasTranscript(meta: SessionMeta): Promise<boolean> {
    return hasNativeSessionLog(this.stateDir, meta.id)
  }

  /** Disk-session discovery for the /resume picker. Maps the host-side listing
   *  scan's rows into the manager's ResumableSession shape; the manager's
   *  provider iteration annotates known/running/terminated and defaults
   *  `provider`, so those stay false/unset here. The log's durable title maps
   *  to `title` (NOT customTitle — that slot is the CLI-side /rename channel). */
  async listResumable(opts?: ListResumableOptions): Promise<ResumableSession[]> {
    const rows = await listNativeResumableRows(this.stateDir, opts)
    return rows.map((row) => this.toResumable(row))
  }

  /** Single-id adoption probe (SessionManager.adoptDiskSession). Missing log →
   *  undefined; corrupt log → throws (the manager catches per provider). */
  async getSessionInfo(id: string): Promise<ResumableSession | undefined> {
    const row = await readNativeResumableRow(this.stateDir, id)
    return row ? this.toResumable(row) : undefined
  }

  private toResumable(row: NativeResumableRow): ResumableSession {
    return {
      sessionId: row.sessionId,
      cwd: row.cwd,
      createdAt: row.createdAt,
      lastModified: row.lastModified,
      title: row.title,
      firstPrompt: row.firstPrompt,
      lastPrompt: row.lastPrompt,
      known: false,
      running: false,
      terminated: false,
    }
  }

  async deleteTranscript(id: string): Promise<boolean> {
    nativeHistoryCache.invalidate(id)
    invalidateNativeResumableCache(id)
    const deleted = await deleteNativeSessionLog(this.stateDir, id)
    this.attachmentReferences.removeSession(id)
    return deleted
  }

  /** Mirror a manual rename into the durable log (live or dormant) so the
   *  title survives a resume. The log helper owns the single-writer decision;
   *  a missing log throws and the manager's best-effort seam catches it. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    await appendSessionTitle(this.stateDir, sessionId, title)
  }

  /** Durable tasklist source for the host derive (server/tasklist-state.ts):
   *  every session's neutral v3 log lives under this provider's state dir,
   *  live or dormant — no session handle needed. */
  tasklistSource(): TasklistSource {
    return { stateDir: this.stateDir }
  }
}
