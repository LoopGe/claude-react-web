// server/providers/native/native-session.ts
//
// The native provider's session handle: owns the conversation history, the
// serialized turn pump, and the frame output stream, and drives Task 9's
// `runTurn` loop against Task 2's Anthropic streamer. No subprocess — the
// "process" is this Node process, so processExited resolves immediately.
//
// Signal lifecycle is deliberately two-level:
//   - sessionAbort: created once; aborted by abort()/destroy() only.
//   - turnAbort: fresh per turn; aborted by interrupt() ONLY.
// Every turn runs on AbortSignal.any([...]) of both, so an interrupt kills
// the current turn while leaving the session usable for the next message.
//
// Result frames have a SINGLE emission point. Task 9's loop emits the result
// frame on the success path; the pump loop's catch is the only other emitter
// (interrupt / API error). interrupt() itself emits nothing — it aborts the
// turn and lets the catch classify it — so every turn ends with exactly one
// terminal frame.

import { createPushable, type Pushable } from '../../pushable.js'
import { createLogger } from '../../log.js'
import { callAnthropicMessages } from '../../anthropic-api.js'
import { config, type ProviderProfile } from '../../config.js'
import { effortLevelsForModel, supportsFastModeForModel } from '../../effort-capability.js'
import type { AgentMessage, AgentUserMessage } from '../../agent-message.js'
import type { ProviderAttachmentOccurrence, ProviderInterruptReceipt, ProviderResetBaseSettings, ProviderSessionHandle } from '../types.js'
import { runTurn, type LoopDeps, type PersistedToolResult } from './loop.js'
import { streamAnthropicMessages, EFFORT_LEVELS, type EffortLevel } from './anthropic-stream.js'
import type { CanonicalEvent } from './canonical.js'
import { apiRetryFrame, defaultFrameContext, informationalFrame, resultFrame, type Frame, type FrameContext, type Usage } from './frames.js'
import { NativeSessionLog, loadNativeSessionLogSync } from './session-log/log.js'
import { buildForkSeed } from './session-log/fork.js'
import { contextSnapshot, historyFromEvents, repairInterruptedTurn } from './session-log/replay.js'
import { NativeSessionStorageError } from './session-log/errors.js'
import { nativeSessionLogPath } from './session-log/paths.js'
import type { NativeFileAttachment, NativeLogEvent, NativeSubagentDescriptorEvent, NativeTurnEndReason } from './session-log/format.js'
import { nativeAttachmentOccurrences } from '../../attachment-reference-index.js'
import { mcpToolDefs } from './mcp/tools.js'
import type { NativeMcpConnections } from './mcp/connections.js'
import type { ToolDef } from './tools/types.js'
import { createAgentTool, type AgentToolDeps } from './subagent.js'
import { EXPLORE_AGENT_DESCRIPTION, EXPLORE_AGENT_NAME } from './explore.js'
import { NativeTaskManager } from './task-manager.js'
import { NativeSkillCatalog, type NativeSkillInvocationView, type NativeSkillView } from './skills.js'
import { createSkillTool } from './tools/skill.js'
import { createTaskOutputTool } from './tools/task-output.js'
import { createWebFetchTool } from './tools/web-fetch.js'
import { createWebSearchTool } from './tools/web-search.js'
import { createTodoWriteTool } from './tools/todo-write.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'
import { agentUnusableReason } from '../../agent-definition-store.js'
import {
  agentSelectionFromEvents,
  assertAgentProfileSupported,
  profileFromDefinition,
  unsupportedAgentFields,
  type NativeAgentBase,
  type NativeAgentProfile,
  type NativeAgentSelectionEvent,
} from './agent-profile.js'
import { filterToolsForProfile } from './agent-tools.js'
import type { SessionToolProfile } from '../../../shared/tool-profile.js'
import { formatSupplementInstruction, type SupplementOutcome } from '../steering-format.js'
import { isQuestionResult } from '../../permission-broker.js'
import type { ThinkingDisplay, ThinkingSetting } from '../../../shared/session-info.js'
import type { UploadStore } from '../../upload-store.js'
import type { NativeAttachmentReferenceIndex } from '../../attachment-reference-index.js'
import {
  assignPdfModelForms,
  PdfBudgetLedger,
  PreparedPdfStore,
  type PdfBudgetReservation,
} from './pdf-documents.js'

interface PendingDurableInitial {
  message: AgentUserMessage
  persisted?: { role: 'user'; content: unknown[] }
  pdfReservations?: PdfBudgetReservation[]
}

const log = createLogger('native')

const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_MAX_TOKENS = 16384
const CONTEXT_WINDOW = 200_000

/** The aux prompt for `generateTitle`. The manager trims and persists the
 *  caller's first text block, so the model must answer with the title alone. */
const TITLE_PROMPT =
  'Generate a concise session title in the same language as the request. Return only the title, without quotes, a prefix, or trailing punctuation.'

/** The log format requires a persisted user event's content to be a block
 *  array (the parser rejects a bare string as corrupt). The manager's primary
 *  send path and `seedCompactSummary` both send `content: text` as a string,
 *  so normalize on the way to disk only — the in-memory history keeps the
 *  caller's shape. */
function persistedUserMessage(message: { content: unknown }): { role: 'user'; content: unknown[] } {
  const content = message.content
  return {
    role: 'user',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : (content as unknown[]),
  }
}

/** Normalize a raw prompt for persistence. PDF model forms are assigned once
 * at the pump's transactional budget boundary, never during request projection. */
function nativeUserMessage(message: { content: unknown }): { role: 'user'; content: unknown[] } {
  return persistedUserMessage(message)
}

function containsStructuredFile(content: unknown[]): boolean {
  return content.some((block) => typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'file')
}

/** `/name args` — the composer's slash-command shape for a user-invoked skill.
 *  The name grammar mirrors the CLI's skill-name rule. */
const SKILL_COMMAND_RE = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\s+([\s\S]*))?$/

/** Resolve one text block against the captured scoped view. A `/name args`
 *  invocation of a skill the user may invoke returns that skill's canonical
 *  body exactly once; args stay only in the original input. Anything else (not
 *  a command, an unknown skill, an `off` skill) has no instruction. */
function skillInvocationForTurn(
  content: unknown,
  skills: NativeSkillInvocationView,
): { name: string; body: string } | null {
  let text: string | undefined
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    // Only the FIRST text block can carry the slash command. Every non-text
    // block (image / file) remains untouched in the original user message.
    const block = content.find(
      (candidate) => typeof candidate === 'object' && candidate !== null &&
        (candidate as { type?: unknown }).type === 'text',
    ) as { type: 'text'; text?: unknown } | undefined
    if (typeof block?.text === 'string') text = block.text
  }
  if (text === undefined) return null
  const match = SKILL_COMMAND_RE.exec(text)
  return match ? skills.expand(match[1]) : null
}

/** Fire-and-forget flush: a persistence failure must never become an
 *  unhandled rejection or a second terminal frame, but it must be visible. */
function flushInBackground(sessionLog: NativeSessionLog, sessionId: string, what: string): void {
  void sessionLog.flush().catch((err) => log.warn(`[${sessionId}] failed to flush ${what}:`, err))
}

/** Narrow an assistant event's opaque `message.usage` to the counter pair the
 *  session tracks. Old / partial logs may omit it or carry another shape. */
function usageOf(value: unknown): Usage | null {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_read_input_tokens?: unknown
    cache_creation_input_tokens?: unknown
  }
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(typeof usage.cache_read_input_tokens === 'number'
      ? { cache_read_input_tokens: usage.cache_read_input_tokens }
      : {}),
    ...(typeof usage.cache_creation_input_tokens === 'number'
      ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
      : {}),
  }
}

/** Append the `<available_skills>` block to a system prompt, or leave it
 *  untouched when nothing is listable (no stray blank line). */
function withSkillsSection(system: string, section: string): string {
  return section ? `${system}\n\n${section}` : system
}

/** Field-wise sum of two usage readings (cache fields only appear when at
 *  least one side carries them). */
function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number): number => (x ?? 0) + (y ?? 0)
  const cacheRead = sum(a.cache_read_input_tokens, b.cache_read_input_tokens)
  const cacheCreate = sum(a.cache_creation_input_tokens, b.cache_creation_input_tokens)
  return {
    input_tokens: sum(a.input_tokens, b.input_tokens),
    output_tokens: sum(a.output_tokens, b.output_tokens),
    ...(cacheRead !== 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreate !== 0 ? { cache_creation_input_tokens: cacheCreate } : {}),
  }
}

export interface NativeSessionOptions {
  id: string
  cwd: string
  /** Resolved native state dir (`<stateDir>/native-sessions/<id>/session.v1.jsonl`). */
  stateDir: string
  /** Shared upload registry, injected by the provider for authorized byte
   * projections. Plain handle-only sessions do not read it. */
  uploadStore?: UploadStore
  /** Derived reference view shared with upload deletion. */
  attachmentReferences?: NativeAttachmentReferenceIndex
  /** Shared with AttachmentRead. Optional for direct handle-only unit sessions. */
  pdfBudgets?: PdfBudgetLedger
  preparedPdfs?: PreparedPdfStore
  /** Resume this session's own log (non-fork), or the source log id for a fork. */
  resume?: string
  /** Fork from `resume`'s log into `id` instead of resuming it. */
  forkSession?: boolean
  /** Fork cut point: the assistant message uuid to keep, inclusive. */
  resumeSessionAt?: string
  model?: string
  /** Main-thread agent to resolve at fresh create. Resume/fork restore the
   *  selection snapshot from the copied log prefix; a pre-selection legacy log
   *  migrates this metadata name against the current enabled definition. */
  agent?: string
  permissionMode?: string
  /** Extended-thinking config carried over from `SessionMeta.thinking`.
   *  Only the starting point: `setMaxThinkingTokens` keeps a live field. */
  thinking?: ThinkingSetting
  /** Reasoning effort carried over from `SessionMeta.effortLevel`. Only the
   *  starting point: `applyFlagSettings({effortLevel})` keeps a live field. */
  effortLevel?: string
  /** Fast-mode intent carried over from `SessionMeta.fastMode`. Only the
   *  starting point: `applyFlagSettings({fastMode})` keeps a live field. */
  fastMode?: boolean
  /** The resolved provider profile, threaded from the manager. `supportedModels`
   *  prefers its model list; absent (unit tests) = the global config's. */
  profile?: ProviderProfile
  /** Resolved lazily, on the first real network turn — a session must be
   *  creatable on an unconfigured machine (the failure surfaces as a loud
   *  turn error, not a create-time throw). */
  credentials: () => { baseUrl: string; authToken: string }
  /** The builtin tools only. Discovered MCP tools are appended per turn by
   *  `rebuildTools`. */
  tools: ToolDef[]
  /** Per-session MCP connections (external servers + first-party in-process
   *  ones). Absent in unit tests that drive the session without MCP. */
  mcp?: NativeMcpConnections
  /** Custom agent definitions the Agent tool resolves `subagent_type`
   *  against. Absent = only the built-in general-purpose agent. */
  agentStore?: AgentDefinitionStore
  /** Spawn `Options.skills` policy: `undefined` = the CLI's name-only
   *  default, `'all'` = list with descriptions, `string[]` = allowlist. */
  skills?: string[] | 'all'
  /** Create-body tool surface, merged field-wise with the selected persona.
   *  The native loop honors the allow/deny lists; permission aliases/config
   *  remain SDK-only fields and do not affect this in-process tool list. */
  toolProfile?: SessionToolProfile
  system: string
  /** The prompt a nested (Agent/Task) run gets: the parent system WITHOUT the
   *  shared delegation section, since nested tools exclude both names and a
   *  subagent told to delegate would look for a tool it cannot see. Defaults to
   *  `system`. */
  subagentSystem?: string
  /** Loose canUseTool from CreateSessionOptions — (toolName, input, {signal}) => PermissionResult. */
  canUseTool?: (...args: unknown[]) => Promise<unknown>
  /** Manager-injected consumed stamp (CreateSessionOptions.onUserMessageConsumed):
   *  called when a queued message is dequeued for a turn — without it the
   *  client's send bubble stays 'queued' forever. */
  onUserMessageConsumed?: (message: AgentUserMessage) => void
  /** Raw persistence owns the send lease: appended converts it to a persisted
   * reference; failed releases an abandoned prompt. A retryable pre-append
   * failure emits no outcome and retains the lease until append or withdrawal. */
  onUserMessagePersistence?: (message: AgentUserMessage, outcome: 'appended' | 'failed') => void
  /** Mid-run steering delivery: fired per supplement once its
   *  `session/supplement` event is durable, right before the next request
   *  carries it. The manager stamps the bubble and the sidecar from it. */
  onSupplementDelivered?: (uuid: string, outcome: SupplementOutcome) => void
  /** Test seam: evaluated PER TURN; a non-undefined return replaces the real
   *  network streamer for that turn. Per-turn evaluation lets tests swap the
   *  script between turns. */
  streamSupplier?: () => LoopDeps['stream'] | undefined
}

export class NativeSession implements ProviderSessionHandle {
  readonly provider = 'native'
  /** The native loop never replays a top-level user prompt through its message
   *  stream (only tool_result user frames), so the manager pairs prompt uuids
   *  at consumption instead of waiting for an SDK echo. */
  readonly echoesUserPrompts = false

  private readonly output: Pushable<AgentMessage>
  private readonly input: AgentUserMessage[] = []
  /** Consumed from FIFO but not yet appended. It remains withdrawable and is
   * always retried before any later input after a migration/append failure. */
  private pendingDurableInitial: PendingDurableInitial | null = null
  /** Monotonic explicit-enqueue marker. A pre-append failure captures this
   * value so only an enqueue observed AFTER that failure can release its pause. */
  private enqueueGeneration = 0
  private readonly ctx: FrameContext
  /** Append-only persistence for this session. Every constructor path opens it
   *  (fresh create, resume, or fork-seeded) before `system/init` is pushed. */
  private readonly log: NativeSessionLog
  /** Arrival time per queued turn — written to the log when the pump consumes
   *  the message, never at enqueue time (a drained turn must not persist). */
  private readonly receivedAt = new WeakMap<AgentUserMessage, number>()
  /** Flush of the most recent assistant event. `requestPermission` awaits it
   *  before any tool runs, so a crash is always recoverable as "call sent,
   *  result unknown" — never "tool ran but its call was never durable". */
  private assistantFlush: Promise<void> | null = null
  /** Session-level abort (abort()/destroy()). Never aborted by a mere interrupt. */
  private readonly sessionAbort = new AbortController()
  /** Per-turn abort, replaced by pumpLoop for every turn. */
  private turnAbort: AbortController | null = null
  /** Conversation state sent to the API on every turn (mutated in place by runTurn). */
  private readonly history: unknown[] = []
  private readonly pdfBudgets: PdfBudgetLedger
  private readonly preparedPdfs: PreparedPdfStore
  /** Builtins plus the MCP tools discovered as of the last rebuild. Replaced
   *  (never mutated) so a mid-turn `setServers`/toggle only affects the NEXT
   *  turn: the running turn holds the snapshot its `runTurn` started with. */
  private tools: ToolDef[]
  /** The same full discovery snapshot with ONLY session-base tool constraints
   *  applied. Nested profiles start here, independently of the MAIN persona. */
  private nestedTools: ToolDef[]
  /** Every detachable execution in this session, shared with nested loops. */
  private readonly tasks: NativeTaskManager
  /** Agent and Task share one runner and live getters; only their wire names differ. */
  private readonly agentTool: ToolDef
  private readonly taskTool: ToolDef
  /** Reads this session's detached Bash/Agent/Task outcomes through the shared manager. */
  private readonly taskOutputTool: ToolDef
  /** Local SKILL.md catalog. Discovery is kicked off at construction and
   *  awaited per turn, the same shape as MCP's `whenReady`. */
  private readonly skills: NativeSkillCatalog
  /** WebFetch reads the LIVE model through its getter at call time (a model
   *  switch must reach the auxiliary call) and the session's profile
   *  credentials. Prompt sections are registered by the provider from the
   *  tools' own guidance constants. */
  private readonly webFetchTool: ToolDef
  /** WebSearch is per-session so its `searchCount` counter is scoped to one
   *  conversation instead of being shared process-wide. */
  private readonly webSearchTool: ToolDef
  /** TodoWrite is per-session because the tool instance owns the live todo
   *  list; two sessions must never share tasks. */
  private readonly todoWriteTool: ToolDef
  /** The CURRENT discovery/reload in flight. Re-assigned by `reloadSkills`, so
   *  a manual reload supersedes the construction one (and can recover from a
   *  transient construction failure) for every per-turn await. */
  private skillsReady: Promise<void>
  /** Model-facing tool name → owning server, for the permission request's
   *  `mcpServer` field. Built from discovery metadata, never by parsing the
   *  FQN (it may be truncated and hashed). */
  private mcpToolServers: ReadonlyMap<string, { name: string; source: 'sdk' | 'dynamic' }> = new Map()
  private readonly mcp: NativeMcpConnections | undefined
  /** Base values survive independently of the selected persona. The effective
   *  fields below are what the next request and permission broker observe. */
  private readonly baseSystem: string
  private baseModel: string
  private basePermissionMode: string | undefined
  private baseEffortLevel: EffortLevel | undefined
  private baseSkillPolicy: readonly string[] | 'all' | undefined
  private baseToolProfile: SessionToolProfile | undefined
  private currentProfile: NativeAgentProfile | null = null
  /** Distinguishes an explicit logged clear from a pre-selection legacy log.
   *  Only the former may erase the legacy metadata name at manager sync. */
  private hasAgentSelectionEvent = false
  /** A legacy unsupported-preset drop is visible only after system/init. */
  private legacyAgentDropNotice: string | undefined
  private model: string
  /** Live permission mode: setPermissionMode keeps it current for the lifetime
   *  of the session — the spawn-time opts value is only the starting point, so
   *  a bypass-spawned session can be downgraded mid-flight. */
  private permissionMode: string
  /** Live extended-thinking config, read when the next request is built.
   *  `undefined` = no explicit choice (API/model default). */
  private thinking: ThinkingSetting | undefined
  /** The session display mode, tracked apart from the token config (the
   *  setMaxThinkingTokens contract: undefined keeps it, null resets it).
   *  'highlights' may be held here but is never sent on the wire. */
  private thinkingDisplay: ThinkingDisplay | undefined
  /** Live reasoning effort, read when the next request is built.
   *  `undefined` = no explicit choice (model default). */
  private effortLevel: EffortLevel | undefined
  /** Live fast-mode intent, read when the next request is built. */
  private fastMode: boolean
  /** Synchronous pump guard: set before the async pumpLoop starts, so a
   *  second enqueueUserMessage while the first turn is still being scheduled
   *  cannot start a second concurrent pump. */
  private pumping = false
  /** Steering admission: opened when the pump consumes a prompt (a turn is
   *  starting) and closed by `noteTurnSettled` (the manager's turn-end
   *  fallback). Deliberately NOT keyed on `turnAbort !== null`: a supplement
   *  landing between the manager's turn-end drain and the pump's `finally`
   *  would then be admitted with no round left to inject it into (stranded). */
  private steeringOpen = false
  /** Supplements admitted during the current turn, not yet injected. */
  private supplementQueue: Array<{ uuid: string; text: string }> = []
  private lastUsage: Usage = { input_tokens: 0, output_tokens: 0 }
  /** Per-model totals for the /usage panel. Accumulated from every persisted
   *  assistant frame (one per API round), which keeps the live value identical
   *  to what a restart rebuilds from the log. */
  private readonly usageByModel = new Map<string, Usage>()
  private _closed = false

  constructor(private readonly opts: NativeSessionOptions) {
    // opts must be bound before these: output's label and ctx carry the id.
    this.output = createPushable<AgentMessage>(`native-session[${opts.id}]`)
    this.ctx = defaultFrameContext(opts.id)
    this.mcp = opts.mcp
    this.tools = [...opts.tools]
    this.nestedTools = [...opts.tools]
    this.baseSystem = opts.system
    this.baseModel = opts.model ?? DEFAULT_MODEL
    this.basePermissionMode = opts.permissionMode
    this.baseEffortLevel = opts.effortLevel as EffortLevel | undefined
    this.baseSkillPolicy = Array.isArray(opts.skills) ? [...opts.skills] : opts.skills
    this.baseToolProfile = opts.toolProfile ? structuredClone(opts.toolProfile) : undefined
    this.model = this.baseModel
    this.permissionMode = this.basePermissionMode ?? 'default'
    this.thinking = opts.thinking
    this.thinkingDisplay = opts.thinking && 'display' in opts.thinking ? opts.thinking.display : undefined
    this.effortLevel = this.baseEffortLevel
    this.fastMode = opts.fastMode === true
    this.pdfBudgets = opts.pdfBudgets ?? new PdfBudgetLedger()
    this.preparedPdfs = opts.preparedPdfs ?? new PreparedPdfStore(this.pdfBudgets)
    // Built after `this.model` is bound: the model getter must observe a live
    // switch, not the spawn-time value.
    this.webFetchTool = createWebFetchTool({
      model: () => this.model,
      profile: opts.profile,
      credentials: opts.credentials,
    })
    this.webSearchTool = createWebSearchTool()
    this.todoWriteTool = createTodoWriteTool({ todos: [] })
    // Skills are discovered before the first turn can ask for them. The
    // policy is stored separately from discovery (the catalog resolves state
    // lazily), so configure-before/after-reload makes no difference.
    this.skills = new NativeSkillCatalog(opts.cwd)
    this.skills.configure(opts.skills)
    this.skillsReady = this.startSkillReload()
    this.tasks = new NativeTaskManager((frame) => this.output.push(frame))
    this.taskOutputTool = createTaskOutputTool(this.tasks)
    // Every session can delegate, MCP or not: `tools` is a live getter and the
    // `emit` path is the session's own persist+push, so a nested run's frames
    // land in the transcript with their real parent. Built after `ctx` exists.
    const agentDeps: AgentToolDeps = {
      cwd: opts.cwd,
      model: () => this.model,
      effortLevel: () => this.effortLevel,
      permissionMode: () => this.permissionMode,
      system: (skillView) => this.subagentSystem(skillView),
      frameCtx: this.ctx,
      tools: () => this.nestedTools,
      mcpToolServers: () => this.mcpToolServers,
      skillView: (policy) => this.skills.view(policy ?? this.baseSkillPolicy),
      skillToolFor: (view) => this.skillToolFor(view),
      tasks: this.tasks,
      streamFor: (req, streamOpts) => this.streamFor(req, {
        ...streamOpts,
        suppressRetryFrames: true,
      }),
      requestPermission: this.requestPermission,
      emit: (frame) => {
        this.persistFrame(frame)
        this.output.push(frame)
      },
      persistToolResult: (result, parentToolUseId) => this.persistToolResult(result, parentToolUseId),
      attachmentProjection: {
        uploadStore: opts.uploadStore,
        stateDir: opts.stateDir,
        preparedPdfs: this.preparedPdfs,
      },
      appendDescriptor: async (input) => await this.log.appendDurable({
        ...input,
        timestamp: new Date().toISOString(),
      }) as NativeSubagentDescriptorEvent,
      agentStore: opts.agentStore,
    }
    this.agentTool = createAgentTool(agentDeps)
    this.taskTool = createAgentTool(agentDeps, 'Task')
    // The mode switch owns the log, the model history, and the usage
    // counters. It runs before `system/init` so a storage failure (fresh id
    // that already has a log, corrupt resume) throws out of createSession
    // instead of leaving a half-started session.
    if (opts.forkSession && opts.resume) {
      this.log = this.openForkLog(opts, opts.resume)
    } else if (opts.resume) {
      this.log = this.openResumeLog(opts)
    } else {
      this.log = this.openFreshLog(opts)
    }
    this.pdfBudgets.rebuildFromEvents(this.log.events)
    this.syncAttachmentReferences()
    // session-health's stuck-GC force-unloads sessions whose init never
    // lands — push it first, before any turn output. `fast_mode_state` is
    // intent-based, so the client's chip is correct before the first turn
    // ends (the native provider has no CLI to report a runtime state).
    this.output.push({
      type: 'system',
      subtype: 'init',
      session_id: opts.id,
      uuid: this.ctx.uuid(),
      parent_tool_use_id: null,
      fast_mode_state: this.fastMode ? 'on' : 'off',
    } as unknown as AgentMessage)
    if (this.legacyAgentDropNotice !== undefined) {
      this.output.push(informationalFrame(this.ctx, this.legacyAgentDropNotice))
    }
    // `tools` is now the effective list from birth, not builtins-only until
    // the first turn: the invariant tools = builtins + Agent + Task + MCP defs
    // must hold for every reader, not just the pump after discovery.
    this.rebuildTools()
  }

  private currentSkillView(): ReturnType<NativeSkillCatalog['view']> {
    return this.skills.view(this.currentProfile?.skills ?? this.baseSkillPolicy)
  }

  private skillToolFor(view: NativeSkillView): ToolDef {
    return createSkillTool({
      bodyOf: (name: string) => view.bodyOf(name),
    } as NativeSkillCatalog)
  }

  private applyEffectiveProfile(): void {
    this.model = this.currentProfile?.model ?? this.baseModel
    this.permissionMode = this.currentProfile?.permissionMode ?? this.basePermissionMode ?? 'default'
    this.effortLevel = this.currentProfile?.effort ?? this.baseEffortLevel
  }

  private applyAgentBase(base: NativeAgentBase): void {
    this.baseModel = base.model
    this.basePermissionMode = base.permissionMode
    this.baseEffortLevel = base.effortLevel as EffortLevel | undefined
    this.baseSkillPolicy = Array.isArray(base.skillPolicy) ? [...base.skillPolicy] : base.skillPolicy
    this.skills.configure(
      this.baseSkillPolicy === 'all' || this.baseSkillPolicy === undefined
        ? this.baseSkillPolicy
        : [...this.baseSkillPolicy],
    )
    this.baseToolProfile = base.toolProfile ? structuredClone(base.toolProfile) : undefined
  }

  private applyAgentSelection(selection: NativeAgentSelectionEvent): void {
    this.hasAgentSelectionEvent = true
    this.applyAgentBase(selection.base)
    if (selection.name === null) {
      this.currentProfile = null
    } else {
      if (!selection.definition) throw new Error(`agent selection "${selection.name}" has no definition snapshot`)
      this.currentProfile = profileFromDefinition(selection.definition)
    }
    this.applyEffectiveProfile()
  }

  private restoreAgentSelection(events: readonly NativeLogEvent[], sessionLog: NativeSessionLog): void {
    const selection = agentSelectionFromEvents(events)
    if (selection) {
      this.applyAgentSelection(selection)
      return
    }
    if (this.opts.agent === undefined) return
    const definition = this.opts.agentStore?.get(this.opts.agent)
    if (definition?.enabled !== true) return

    const unsupportedFields = unsupportedAgentFields(definition)
    const dropped = unsupportedFields.length > 0
    const migrated = sessionLog.append({
      type: 'session/agent',
      name: dropped ? null : definition.name,
      ...(dropped
        ? { droppedAgent: { name: definition.name, unsupportedFields } }
        : { definition: structuredClone(definition) }),
      base: this.agentBaseSnapshot(),
      timestamp: new Date().toISOString(),
    }) as NativeAgentSelectionEvent
    flushInBackground(sessionLog, this.opts.id, 'legacy agent migration')
    this.applyAgentSelection(migrated)
    if (dropped) {
      this.legacyAgentDropNotice =
        `Legacy agent "${definition.name}" was dropped because the native provider does not support: ` +
        `${unsupportedFields.join(', ')}. The session will continue without an agent preset.`
    }
  }

  private agentBaseSnapshot(): NativeAgentBase {
    return {
      model: this.baseModel,
      permissionMode: this.basePermissionMode ?? 'default',
      ...(this.baseEffortLevel !== undefined ? { effortLevel: this.baseEffortLevel } : {}),
      ...(this.baseSkillPolicy !== undefined
        ? { skillPolicy: Array.isArray(this.baseSkillPolicy) ? [...this.baseSkillPolicy] : this.baseSkillPolicy }
        : {}),
      ...(this.baseToolProfile !== undefined ? { toolProfile: structuredClone(this.baseToolProfile) } : {}),
    }
  }

  /** A selection becomes visible only after its definition and latest base are
   *  durable. The same path serves clear (name null, no definition). */
  private async appendAgentSelection(
    name: string | null,
    definition: NativeAgentSelectionEvent['definition'],
    base: NativeAgentBase,
  ): Promise<void> {
    const selection = await this.log.appendDurable({
      type: 'session/agent',
      name,
      ...(definition ? { definition: structuredClone(definition) } : {}),
      base,
      timestamp: new Date().toISOString(),
    }) as NativeAgentSelectionEvent
    this.applyAgentSelection(selection)
  }

  /** Base-only controls append a fresh copy of the CURRENT selection so a
   *  later resume → clear cannot resurrect the base captured at selection time.
   *  Pre-event logs keep their legacy no-event shape until an explicit switch. */
  private async updateAgentBase(changes: Partial<NativeAgentBase>): Promise<void> {
    if (!this.hasAgentSelectionEvent) {
      if (changes.model !== undefined) this.baseModel = changes.model
      if (changes.permissionMode !== undefined) this.basePermissionMode = changes.permissionMode
      if ('effortLevel' in changes) this.baseEffortLevel = changes.effortLevel as EffortLevel | undefined
      if ('skillPolicy' in changes) {
        this.baseSkillPolicy = Array.isArray(changes.skillPolicy) ? [...changes.skillPolicy] : changes.skillPolicy
        this.skills.configure(
          this.baseSkillPolicy === 'all' || this.baseSkillPolicy === undefined
            ? this.baseSkillPolicy
            : [...this.baseSkillPolicy],
        )
      }
      if ('toolProfile' in changes) {
        this.baseToolProfile = changes.toolProfile ? structuredClone(changes.toolProfile) : undefined
      }
      this.applyEffectiveProfile()
      return
    }
    const previous = agentSelectionFromEvents(this.log.events)
    if (!previous) throw new Error('agent selection state has no persisted snapshot')
    if (this.currentProfile && !previous.definition) {
      throw new Error(`agent selection "${this.currentProfile.name}" has no definition snapshot`)
    }
    await this.appendAgentSelection(
      this.currentProfile?.name ?? null,
      this.currentProfile ? structuredClone(previous.definition!) : undefined,
      { ...this.agentBaseSnapshot(), ...changes },
    )
  }

  getEffectiveSettings(): { model: string; permissionMode?: string; effortLevel?: string; agent: string | null } {
    const permissionMode = this.currentProfile?.permissionMode ?? this.basePermissionMode
    return {
      model: this.model,
      // Undefined is meaningful intent: the manager must not persist an
      // invented 'default' that would override the caller's next resume mode.
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(this.effortLevel !== undefined ? { effortLevel: this.effortLevel } : {}),
      agent: this.hasAgentSelectionEvent ? (this.currentProfile?.name ?? null) : (this.opts.agent ?? null),
    }
  }

  getResetBaseSettings(): ProviderResetBaseSettings {
    return {
      model: this.baseModel,
      permissionMode: this.basePermissionMode,
      effortLevel: this.baseEffortLevel,
      skills: this.baseSkillPolicy === 'all' || this.baseSkillPolicy === undefined
        ? this.baseSkillPolicy
        : [...this.baseSkillPolicy],
      toolProfile: this.baseToolProfile ? structuredClone(this.baseToolProfile) : undefined,
    }
  }

  /** Fresh session: the log is created here, with its opening `session/context`
   *  written through the seed path so the header AND the context are durable
   *  synchronously at open (a crash before the first turn must still leave a
   *  log that carries the working directory). The context is the first model
   *  message — history-only, per the DSH design, never a frame. An existing
   *  log for this id is left untouched: `open` throws `kind: 'exists'`. */
  private openFreshLog(opts: NativeSessionOptions): NativeSessionLog {
    let selection: NativeAgentSelectionEvent | undefined
    if (opts.agent !== undefined) {
      const reason = agentUnusableReason(opts.agentStore, opts.agent)
      if (reason) throw new Error(reason)
      const definition = opts.agentStore!.get(opts.agent)!
      // Validate BEFORE opening the file: a rejected fresh selection must not
      // leave a turn-less log that a later resume could mistake for a session.
      assertAgentProfileSupported(definition)
      selection = {
        seq: 1,
        type: 'session/agent',
        name: definition.name,
        definition: structuredClone(definition),
        base: this.agentBaseSnapshot(),
        timestamp: new Date().toISOString(),
      }
    }
    const context: NativeLogEvent = {
      seq: 0,
      type: 'session/context',
      text: contextSnapshot(opts.cwd),
    }
    const log = NativeSessionLog.open({
      stateDir: opts.stateDir,
      id: opts.id,
      cwd: opts.cwd,
      resume: false,
      seed: { events: selection ? [context, selection] : [context], inheritedEventCount: 0, isSeeded: false },
    })
    this.history.push(...historyFromEvents([context]))
    if (selection) {
      // Context and selection share the initial synchronous seed write: the
      // next-turn profile is durable before createSession returns.
      this.applyAgentSelection(selection)
    }
    return log
  }

  /** Resume: rebuild model history from the persisted events, repairing any
   *  tool_use a crash left unanswered (the API rejects invalid tool history).
   *  The synthetic results are appended so they survive the next restart too,
   *  and the repaired turn is durably closed with `turn/end { interrupted }`. */
  private openResumeLog(opts: NativeSessionOptions): NativeSessionLog {
    const log = NativeSessionLog.open({ stateDir: opts.stateDir, id: opts.id, cwd: opts.cwd, resume: true })
    const events = log.events.slice()
    const { synthetic } = repairInterruptedTurn(events)
    if (synthetic.length > 0) {
      for (const event of synthetic) log.append(event)
      log.append({ type: 'turn/end', reason: 'interrupted' })
      flushInBackground(log, opts.id, 'interrupted-turn repair')
    }
    // `append` mutated log.events, so this is the original prefix plus the
    // synthetic results (now seq-numbered). `turn/end` is bookkeeping and is
    // skipped by `historyFromEvents`.
    this.history.push(...historyFromEvents(log.events))
    this.restoreAgentSelection(log.events, log)
    this.restoreUsage(events)
    return log
  }

  /** Fork: copy the source log (up to `resumeSessionAt`) into a new seeded
   *  log for `opts.id`, then start from the seed's model history. */
  private openForkLog(opts: NativeSessionOptions, sourceId: string): NativeSessionLog {
    const source = loadNativeSessionLogSync(opts.stateDir, sourceId)
    if (!source) {
      const path = nativeSessionLogPath(opts.stateDir, sourceId)
      throw new NativeSessionStorageError(
        'missing',
        `no session log to fork from at ${path}`,
        sourceId,
        path,
      )
    }
    const seed = buildForkSeed({
      source,
      sourceId,
      newId: opts.id,
      cwd: opts.cwd,
      resumeSessionAt: opts.resumeSessionAt,
    })
    const firstSelection = source.events.find(
      (event): event is NativeAgentSelectionEvent => event.type === 'session/agent',
    )
    if (firstSelection && !agentSelectionFromEvents(seed.events)) {
      // The cut predates the persona, but later source metadata must not leak
      // into the child. Preserve the pre-persona base carried by the FIRST
      // selection and synchronously seed an explicit clear for replay.
      seed.events.push({
        seq: seed.events.length,
        type: 'session/agent',
        name: null,
        base: structuredClone(firstSelection.base),
        timestamp: new Date().toISOString(),
      })
    }
    const log = NativeSessionLog.open({
      stateDir: opts.stateDir,
      id: opts.id,
      cwd: opts.cwd,
      resume: false,
      seed,
    })
    this.history.push(...historyFromEvents(seed.events))
    this.restoreAgentSelection(seed.events, log)
    // Match what a restart of this child would see: its copied prefix's
    // usage-bearing `turn/end` events define last/total (the `{forked}` close
    // carries none and is skipped). Without this the fork reports 0 until the
    // next restart, then jumps to the inherited numbers.
    this.restoreUsage(seed.events)
    return log
  }

  /** Restore the usage reading and per-model totals from the log. The LAST
 *  reading prefers the final assistant frame because it carries the cache
 *  buckets the context bar needs; a usage-bearing `turn/end` (which only has
 *  input/output) is the fallback. The per-model totals sum every persisted
 *  assistant frame — one per API round — which is exactly what the live path
 *  accumulates in `persistFrame`.
 *
 *  A `session/compact` event resets the LAST reading (the request after it
 *  carries only the captured context + summary, so the context bar must show
 *  0 like the live path does after `compactInPlace`). `usageByModel` keeps
 *  scanning the whole log: billing is cumulative across the boundary. */
  private restoreUsage(events: readonly NativeLogEvent[]): void {
    let lastAssistant: Usage | null = null
    let lastEnd: Usage | null = null
    this.usageByModel.clear()
    for (const event of events) {
      if (event.type === 'session/compact') {
        lastAssistant = null
        lastEnd = null
        continue
      }
      if (event.type === 'assistant') {
        const usage = usageOf(event.message.usage)
        if (usage) {
          // The context bar describes the MAIN conversation's last request, so
          // only a top-level assistant frame updates it. Billing is cumulative
          // across the whole session, sidechain rounds included.
          if (event.parent_tool_use_id == null) lastAssistant = usage
          const model = typeof event.message.model === 'string' && event.message.model
            ? event.message.model
            : this.model
          this.usageByModel.set(
            model,
            addUsage(this.usageByModel.get(model) ?? { input_tokens: 0, output_tokens: 0 }, usage),
          )
        }
        continue
      }
      if (event.type !== 'turn/end' || !event.usage) continue
      lastEnd = { input_tokens: event.usage.input_tokens, output_tokens: event.usage.output_tokens }
    }
    this.lastUsage = lastAssistant ?? lastEnd ?? { input_tokens: 0, output_tokens: 0 }
  }

  readonly abortSignal = this.sessionAbort.signal
  readonly processExited: Promise<unknown> = Promise.resolve()

  get queueDepth(): number {
    return this.input.length + (this.pendingDurableInitial ? 1 : 0)
  }

  get messages(): AsyncIterable<AgentMessage> {
    return this.output.iterable
  }

  get closed(): boolean {
    return this._closed
  }

  private requestPermission = async (
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal: AbortSignal,
    permissionMode = this.permissionMode,
  ) => {
    // Guard against an abort that fired while the previous tool executed: an
    // already-aborted signal never fires the broker's abort listener, so
    // without this check the permission promise could never settle and the
    // turn would park forever.
    if (signal.aborted) return { allowed: false, input, message: 'aborted' }
    // Pre-tool durability barrier (spec §7): the assistant event announcing
    // this call must be on disk before ANY tool runs, so a crash is always
    // recognizable as "call sent, result unknown". A rejected flush throws
    // here and surfaces as the turn's error through the pump catch. This is
    // the loop's single pre-tool seam, so it covers bypass / deny paths too.
    if (this.assistantFlush) await this.assistantFlush
    // An interrupt/destroy can land while the flush is in flight. Re-check
    // before handing the signal to the broker: its abort listener never fires
    // for an already-aborted signal, so the permission would park forever —
    // and bypass mode would run the tool after the user stopped the turn.
    if (signal.aborted) return { allowed: false, input, message: 'aborted' }
    // Live mode, not the spawn-time opts value: a bypass session downgraded
    // to default must stop auto-allowing.
    if (permissionMode === 'bypassPermissions') return { allowed: true, input }
    // Fail closed: without a handler there is nothing to ask.
    if (!this.opts.canUseTool) {
      return { allowed: false, input, message: 'no permission handler registered for this session' }
    }
    const mcpServer = this.mcpToolServers.get(toolName)
    const result = (await this.opts.canUseTool(toolName, input, {
      signal,
      toolUseID: toolUseId,
      permissionMode,
      ...(mcpServer ? { mcpServer } : {}),
    })) as { behavior?: string; updatedInput?: Record<string, unknown>; message?: string }
    if (result?.behavior === 'allow') {
      return { allowed: true, input: result.updatedInput ?? input }
    }
    // The broker marks answer/clarify/malformed AskUserQuestion denials as
    // question RESULTS (the denial message IS the answer). Aborts, denyAll,
    // missing handlers and ordinary denials carry no marker and stay errors.
    return {
      allowed: false,
      input,
      message: result?.message ?? 'permission denied',
      questionResult: isQuestionResult(result),
    }
  }

  /** The real network streamer: Task 2's caller with retry, whose onRetry
   *  callback surfaces each backoff as an `api_retry` frame. A nested
   *  (subagent) stream sets `suppressRetryFrames`: retry behavior is
   *  unchanged, but a subagent's backoff must not look like a main-thread
   *  retry in the UI. */
  private defaultStream(
    req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal },
    opts?: { suppressRetryFrames?: boolean; effortLevel?: () => EffortLevel | undefined },
  ): AsyncIterable<CanonicalEvent> {
    return streamAnthropicMessages(
      {
        ...this.opts.credentials(),
        model: req.model,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        maxTokens: DEFAULT_MAX_TOKENS,
        thinking: this.thinking,
        thinkingDisplay: this.thinkingDisplay,
        effort: opts?.effortLevel ? opts.effortLevel() : this.effortLevel,
        fastMode: this.fastMode,
        signal: req.signal,
      },
      async (info) => {
        if (!opts?.suppressRetryFrames) this.output.push(apiRetryFrame(this.ctx, info))
      },
    )
  }

  private streamFor(
    req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal },
    opts?: { suppressRetryFrames?: boolean; effortLevel?: () => EffortLevel | undefined },
  ): AsyncIterable<CanonicalEvent> {
    // The test seam ignores opts: scripted streams have no retry path.
    const testStream = this.opts.streamSupplier?.()
    return testStream ? testStream(req) : this.defaultStream(req, opts)
  }

  /** Persist an assistant UI frame. Canonical tool results use
   * `persistToolResult` below instead: their structured content is not present
   * on the deliberately text-only UI frame. */
  private persistFrame(frame: AgentMessage): void {
    const f = frame as Frame
    if (f.type !== 'assistant') return
    this.log.append({
      type: 'assistant',
      uuid: f.uuid!,
      session_id: this.opts.id,
      parent_tool_use_id: f.parent_tool_use_id ?? null,
      timestamp: new Date().toISOString(),
      message: f.message,
    })
    // Keep the flush promise so `requestPermission` can await it before any
    // tool executes. The catch keeps a text-only turn (which never reaches
    // requestPermission) from producing an unhandled rejection; a tool turn
    // re-awaits the same promise and surfaces the failure as its error.
    const flush = this.log.flush()
    this.assistantFlush = flush
    void flush.catch((err) => log.warn(`[${this.opts.id}] failed to flush assistant frame:`, err))
    // One assistant frame = one API round. Summing here (rather than from
    // the turn's final usage) keeps the live per-model totals identical to
    // what `restoreUsage` rebuilds from the log.
    const usage = usageOf(f.message.usage)
    if (usage) {
      const model = typeof f.message.model === 'string' && f.message.model ? f.message.model : this.model
      this.usageByModel.set(
        model,
        addUsage(this.usageByModel.get(model) ?? { input_tokens: 0, output_tokens: 0 }, usage),
      )
    }
  }

  private syncAttachmentReferences(): void {
    this.opts.attachmentReferences?.replaceSession(this.opts.id, this.log.events)
  }

  private persistToolResult(record: PersistedToolResult, parentToolUseId: string | null): void {
    this.log.append({
      type: 'user',
      uuid: record.uuid,
      session_id: this.opts.id,
      parent_tool_use_id: parentToolUseId,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [record.result] },
    })
    this.preparedPdfs.confirmPersisted(record.result.tool_use_id)
    this.syncAttachmentReferences()
    flushInBackground(this.log, this.opts.id, 'tool result')
  }

  /** A turn that throws after its assistant message entered the log (a failed
   *  pre-tool flush, or a throwing permission handler) leaves `tool_use` ids
   *  unanswered. Append the same synthetic results the resume repair uses so
   *  BOTH the live history and the durable log are closed: a memory-only
   *  repair would make a later restart place the results after later turns,
   *  producing permanently invalid history. */
  private repairUnansweredToolUses(): void {
    const { synthetic } = repairInterruptedTurn(this.log.events)
    if (synthetic.length === 0) return
    for (const event of synthetic) {
      this.log.append(event)
      // The live ring/UI must see the same synthetic result the disk replay
      // will show, with the SAME uuid so the seq store and a later restart do
      // not render it twice. Push directly (not through emit: the log append
      // above already happened).
      // Reuse the persisted event's message verbatim so the live frame and
      // the disk replay are identical by construction (same uuid AND shape).
      this.output.push({
        type: 'user',
        uuid: event.uuid,
        session_id: this.opts.id,
        parent_tool_use_id: null,
        message: event.message,
      } as unknown as AgentMessage)
    }
    this.history.push({
      role: 'user',
      content: synthetic.flatMap((event) => event.message.content),
    })
  }

  /** Start a discovery pass and return it as the current `skillsReady`.
   *
   *  Discovery is awaited only by a turn, so a session destroyed before its
   *  first turn would leave the promise unhandled at process level. The
   *  handler marks it observed while the turn path still awaits the ORIGINAL
   *  promise — a real discovery failure stays a loud turn error, never a
   *  silent empty catalog. */
  private startSkillReload(): Promise<void> {
    const reload = this.skills.reload()
    void reload.catch((err) => log.warn(`[${this.opts.id}] skill discovery failed:`, err))
    return reload
  }

  /** The nested (Agent/Task) prompt: the subagent system plus the nested run's
   *  scoped Skill section. The view reads the shared catalog at call time, so
   *  a reload reaches the next run without reviving an excluded skill. */
  private subagentSystem(skillView: NativeSkillView): string {
    return withSkillsSection(
      this.opts.subagentSystem ?? this.baseSystem,
      skillView.section(),
    )
  }

  /** Construct the complete builtin + current MCP discovery snapshot and its
   *  ownership metadata together. Both lists and the map are fresh, so a later
   *  rebuild cannot mutate a parent or nested run already using an older one. */
  private buildFullTools(skillTool: ToolDef): {
    tools: ToolDef[]
    mcpToolServers: Map<string, { name: string; source: 'sdk' | 'dynamic' }>
  } {
    // Agent, Task and Skill ride EVERY list, MCP-less sessions included —
    // otherwise the model loses delegation exactly when it has no servers to
    // call, and a subagent could never load a skill.
    const tools: ToolDef[] = [
      ...this.opts.tools,
      this.webFetchTool,
      this.webSearchTool,
      this.todoWriteTool,
      this.agentTool,
      this.taskTool,
      this.taskOutputTool,
      skillTool,
    ]
    const mcpToolServers = new Map<string, { name: string; source: 'sdk' | 'dynamic' }>()
    if (this.mcp) {
      const infos = this.mcp.tools()
      tools.push(...mcpToolDefs(this.mcp))
      const sdkServers = new Set(
        this.mcp.statuses().filter((status) => status.source === 'sdk').map((status) => status.name),
      )
      for (const info of infos) {
        mcpToolServers.set(info.fqn, {
          name: info.server,
          source: sdkServers.has(info.server) ? 'sdk' : 'dynamic',
        })
      }
    }
    return { tools, mcpToolServers }
  }

  /** Rebuild the tool list and the FQN → server map from the current
   *  connection state. Runs before every turn and after every live MCP
   *  mutation; all snapshots are replaced (never mutated) so a running turn
   *  keeps the arrays and ownership map it started with. */
  private rebuildTools(
    skillTool = this.skillToolFor(this.currentSkillView()),
    profile: NativeAgentProfile | null = this.currentProfile,
    baseToolProfile: SessionToolProfile | undefined = this.baseToolProfile,
  ): ToolDef[] {
    const { tools: fullTools, mcpToolServers } = this.buildFullTools(skillTool)
    this.mcpToolServers = mcpToolServers
    // Nested profiles start from the COMPLETE discovery snapshot, but session-
    // base restrictions remain hard boundaries for every child. The MAIN
    // persona is deliberately absent from this filter.
    this.nestedTools = filterToolsForProfile(fullTools, {
      tools: baseToolProfile?.tools,
      disallowedTools: baseToolProfile?.disallowedTools,
    }, this.mcpToolServers)
    // The main turn keeps its existing field-wise base/persona merge. Each
    // field wins independently; a persona [] is an explicit empty allowlist.
    this.tools = filterToolsForProfile(fullTools, {
      tools: profile?.tools ?? baseToolProfile?.tools,
      disallowedTools: profile?.disallowedTools ?? baseToolProfile?.disallowedTools,
      mcpServers: profile?.mcpServers,
    }, this.mcpToolServers)
    return this.tools
  }

  private async pumpLoop(): Promise<void> {
    while (!this._closed && (this.pendingDurableInitial !== null || this.input.length > 0)) {
      const pending = this.pendingDurableInitial ?? { message: this.input.shift() as AgentUserMessage }
      this.pendingDurableInitial = pending
      const next = pending.message
      // Fresh per-turn signal, armed BEFORE the persistence await: interrupt()
      // kills THIS turn only, and must stay responsive while the consumed
      // turn's write is in flight (the session survives for the next message).
      const turnAbort = new AbortController()
      this.turnAbort = turnAbort
      const turnSignal = AbortSignal.any([this.sessionAbort.signal, turnAbort.signal])
      let endReason: NativeTurnEndReason = 'error'
      // Only a completed turn carries this turn's usage. An interrupted /
      // errored turn has no usage of its own — stamping the PREVIOUS turn's
      // `lastUsage` here would make `restoreUsage` sum it again after restart.
      let endUsage: Usage | undefined
      let initialMessages: Array<{ role: 'user'; content: unknown[] }> = []
      let appendedInitialMessages: Array<{ role: 'user'; content: unknown[] }> = []
      let initialMessagesOwned = false
      let rawAppended = false
      let pauseForDurableRetry = false
      let pauseEnqueueGeneration = 0
      try {
        // Capture every persona-controlled execution field at one boundary.
        // Discovery/flush/MCP awaits below must not let a live control switch
        // replace only part of this turn's configuration.
        const turnProfile = this.currentProfile
        const turnSkillPolicy = turnProfile?.skills ?? this.baseSkillPolicy
        const turnBaseToolProfile = this.baseToolProfile
        const turnModel = this.model
        const turnPermissionMode = this.permissionMode
        const turnEffortLevel = this.effortLevel
        let turnSkillView: NativeSkillInvocationView | undefined
        let invocation: { name: string; body: string } | null = null
        let skillError: unknown
        try {
          // Skill discovery is awaited per turn, not at spawn: a slow disk
          // never delays session creation, and `skillsReady` tracks the LATEST
          // reload pass, so a manual reload supersedes the construction snapshot.
          await this.skillsReady
          // Freeze the freshly discovered cache BEFORE resolving the command.
          // Invocation, available_skills and the Skill tool now share one view.
          turnSkillView = this.skills.snapshot(turnSkillPolicy)
          invocation = skillInvocationForTurn(next.message.content, turnSkillView)
        } catch (err) {
          skillError = err
        }

        // Persist the raw prompt before consumption is acknowledged. A v1 log
        // upgrades before its first structured occurrence; a failed migration
        // or raw append leaves `pendingDurableInitial` withdrawable and pauses
        // the FIFO so later input cannot overtake it.
        const timestamp = new Date(this.receivedAt.get(next)!).toISOString()
        if (!pending.persisted) {
          const normalized = nativeUserMessage(next.message)
          const assigned = assignPdfModelForms(
            normalized.content,
            this.pdfBudgets,
            config.nativeAttachmentFidelity && config.nativePdfDocuments,
          )
          pending.persisted = { ...normalized, content: assigned.content }
          pending.pdfReservations = assigned.reservations
        }
        const persisted = pending.persisted
        if (this._closed) throw new Error('session destroyed before persistence')
        if (this.pendingDurableInitial !== pending) {
          throw new Error('initial message was withdrawn before persistence')
        }
        if (containsStructuredFile(persisted.content)) await this.log.migrateToV2()
        if (this._closed) throw new Error('session destroyed before persistence')
        if (this.pendingDurableInitial !== pending) {
          throw new Error('initial message was withdrawn before persistence')
        }
        const rawMessage = {
          role: 'user',
          content: typeof next.message.content === 'string' ? next.message.content : persisted.content,
        } as { role: 'user'; content: unknown[] }
        initialMessages = [rawMessage]
        this.log.append({
          type: 'user',
          uuid: next.uuid!,
          session_id: this.opts.id,
          parent_tool_use_id: null,
          timestamp,
          message: persisted,
        })
        for (const reservation of pending.pdfReservations ?? []) this.pdfBudgets.confirm(reservation)
        pending.pdfReservations = []
        rawAppended = true
        this.syncAttachmentReferences()
        this.opts.onUserMessagePersistence?.(next, 'appended')
        appendedInitialMessages = [rawMessage]
        if (invocation) {
          const instruction = {
            role: 'user',
            content: [{ type: 'text', text: invocation.body }],
          } as { role: 'user'; content: unknown[] }
          initialMessages.push(instruction)
          this.log.append({
            type: 'session/skill',
            name: invocation.name,
            body: invocation.body,
            timestamp,
          })
          appendedInitialMessages.push(instruction)
        }
        this.pendingDurableInitial = null
        this.opts.onUserMessageConsumed?.(next)
        // The prompt is now durable in the writer's event stream, so steering
        // admission may open. It closes when the manager settles the turn.
        this.steeringOpen = true
        await this.log.flush()
        if (skillError !== undefined) throw skillError
        // MCP discovery is awaited per turn, not at spawn: a slow server never
        // delays session creation, and a mid-turn replace/toggle only lands
        // on the next turn (the turn below runs on this snapshot).
        await this.mcp?.whenReady()
        // Everything a preset can override was captured before the awaits.
        // Build the effective list with THAT profile and return the exact
        // snapshot runTurn will use, rather than reading live fields again.
        const skillView = turnSkillView!
        const turnTools = this.rebuildTools(
          this.skillToolFor(skillView),
          turnProfile,
          turnBaseToolProfile,
        )
        const turnSystem = withSkillsSection(
          turnProfile?.instruction
            ? `${this.baseSystem}\n\n${turnProfile.instruction}`
            : this.baseSystem,
          skillView.section(),
        )
        const res = await runTurn(
          {
            stream: (req) => this.streamFor(req, { effortLevel: () => turnEffortLevel }),
            tools: [...turnTools],
            maxTurns: turnProfile?.maxTurns,
            tasks: this.tasks,
            cwd: this.opts.cwd,
            requestPermission: (toolName, input, toolUseId, signal) =>
              this.requestPermission(toolName, input, toolUseId, signal, turnPermissionMode),
            emit: (frame) => {
              this.persistFrame(frame)
              this.output.push(frame)
            },
            persistToolResult: (result) => this.persistToolResult(result, null),
            attachmentProjection: {
              uploadStore: this.opts.uploadStore,
              stateDir: this.opts.stateDir,
              preparedPdfs: this.preparedPdfs,
            },
            system: turnSystem,
            fastModeState: () => (this.fastMode ? 'on' : 'off'),
            drainSupplement: () => this.injectSupplements(),
            onInitialMessagesOwned: () => { initialMessagesOwned = true },
          },
          this.ctx,
          this.history,
          initialMessages,
          turnModel,
          turnSignal,
        )
        // Success-path result frame was already emitted by runTurn; only the
        // LAST-reading accounting happens here. Per-model totals are summed
        // from the persisted assistant frames in `persistFrame`, so the live
        // value and a restart's rebuild are identical.
        this.lastUsage = res.usage
        endReason = res.isError ? 'error' : 'completed'
        if (!res.isError) endUsage = res.usage
      } catch (err) {
        // A pre-append failure stays leased while the same pending prompt can
        // be retried. Only withdrawal or another abandonment releases it.
        if (!rawAppended && !this._closed && this.pendingDurableInitial !== pending) {
          this.opts.onUserMessagePersistence?.(next, 'failed')
        }
        // A pre-append failure owns no canonical history and keeps the pending
        // prompt at the FIFO head. Once raw append succeeds, later failures
        // restore exactly the appended prefix (raw plus any appended skill),
        // unless runTurn already took ownership of that same prefix.
        if (!initialMessagesOwned) this.history.push(...appendedInitialMessages)
        if (!rawAppended && this.pendingDurableInitial === pending) {
          pauseForDurableRetry = true
          pauseEnqueueGeneration = this.enqueueGeneration
        } else if (rawAppended && this.pendingDurableInitial === pending) {
          // A skill append can fail after the raw append. Never retry the raw
          // event into a duplicate; the restored history matches disk exactly.
          this.pendingDurableInitial = null
        }
        // The assistant message may already be in `history` with unanswered
        // tool calls (the failure can land at the pre-tool barrier); close
        // them before the next request is built.
        this.repairUnansweredToolUses()
        // The other half of the single result-emission point: classify an
        // interrupt (this turn's abort, session still alive) vs a real error,
        // so interrupt() never double-emits and the client sees exactly one
        // terminal frame per turn.
        const interrupted = turnAbort.signal.aborted && !this.sessionAbort.signal.aborted
        if (interrupted) log.info(`[${this.opts.id}] turn interrupted by user`)
        else log.error(`[${this.opts.id}] turn failed:`, err)
        this.output.push(resultFrame(this.ctx, {
          result: interrupted ? 'interrupted by user' : err instanceof Error ? err.message : String(err),
          usage: this.lastUsage,
          numTurns: 0,
          durationMs: 0,
          isError: true,
          fastModeState: this.fastMode ? 'on' : 'off',
        }))
        endReason = interrupted ? 'interrupted' : 'error'
      } finally {
        this.preparedPdfs.clearHistory('main')
        this.turnAbort = null
      }
      // Exactly one turn/end per turn, OUTSIDE the turn try/catch: a flush
      // failure here must log rather than land in the catch above, which
      // would emit a second terminal result and a second turn/end.
      try {
        const turnEnd: { type: 'turn/end'; reason: NativeTurnEndReason; usage?: Usage } = {
          type: 'turn/end',
          reason: endReason,
        }
        if (endUsage) turnEnd.usage = endUsage
        this.log.append(turnEnd)
        await this.log.flush()
      } catch (err) {
        log.warn(`[${this.opts.id}] failed to persist turn/end:`, err)
      }
      // Park even when later input is already queued. Only an enqueue observed
      // after this failure (including during turn/end finalization) releases
      // the pause, exactly once; older queued input cannot drive a retry loop.
      if (pauseForDurableRetry && this.enqueueGeneration === pauseEnqueueGeneration) break
    }
  }

  enqueueUserMessage(message: AgentUserMessage): void {
    if (this._closed) return
    // Arrival time only — the message is not part of the conversation until
    // the pump consumes it (see pumpLoop). The WeakMap keeps the provider's
    // AgentUserMessage contract untouched.
    this.receivedAt.set(message, Date.now())
    this.enqueueGeneration++
    this.input.push(message)
    if (!this.pumping) {
      this.pumping = true
      void this.pumpLoop().finally(() => {
        this.pumping = false
      })
    }
  }

  /** Compact-seed path (SessionManager.seedCompactSummary): the message must
   *  join the conversation WITHOUT triggering a turn (shouldQuery:false
   *  semantics). Append it to the history the next turn sends; no frame —
   *  the manager broadcasts the seed itself. */
  sendControlMessage(message: AgentUserMessage): void {
    // The compact seed is a durable conversation message even though it never
    // starts a turn: persist it, then make it visible to the next request.
    this.log.append({
      type: 'user',
      uuid: message.uuid!,
      session_id: this.opts.id,
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
      message: persistedUserMessage(message.message),
      isCompactSummary: true,
    })
    this.syncAttachmentReferences()
    flushInBackground(this.log, this.opts.id, 'compact summary')
    this.history.push({ role: 'user', content: message.message.content })
  }

  getAttachmentOccurrences(): readonly ProviderAttachmentOccurrence[] {
    const occurrences: ProviderAttachmentOccurrence[] = []
    for (const event of this.log.events) {
      if (event.type !== 'user') continue
      for (let outerIndex = 0; outerIndex < event.message.content.length; outerIndex++) {
        const outer = event.message.content[outerIndex] as {
          type?: unknown
          attachment?: NativeFileAttachment
          content?: unknown
        }
        if (outer?.type === 'file' && outer.attachment) {
          occurrences.push({
            messageUuid: event.uuid,
            blockPath: [outerIndex],
            attachment: outer.attachment,
          })
          continue
        }
        if (outer?.type !== 'tool_result' || !Array.isArray(outer.content)) continue
        for (let innerIndex = 0; innerIndex < outer.content.length; innerIndex++) {
          const inner = outer.content[innerIndex] as {
            type?: unknown
            attachment?: NativeFileAttachment
          }
          if (inner?.type !== 'file' || !inner.attachment) continue
          occurrences.push({
            messageUuid: event.uuid,
            blockPath: [outerIndex, innerIndex],
            attachment: inner.attachment,
          })
        }
      }
    }
    return occurrences
  }

  getAttachmentCatalog(): readonly NativeFileAttachment[] {
    const seen = new Set<string>()
    const catalog: NativeFileAttachment[] = []
    for (const attachment of nativeAttachmentOccurrences(this.log.events)) {
      const key = `${attachment.id}\0${attachment.digest}`
      if (seen.has(key)) continue
      seen.add(key)
      catalog.push({ ...attachment })
    }
    return catalog
  }

  /** Manual replacement handoff: catalog first, summary second, one awaited
   * flush. The manager keeps the new session unpublished until this resolves. */
  async seedCompactSummary(
    summary: string,
    opts: { uuid: string; timestamp: string; attachments: readonly NativeFileAttachment[] },
  ): Promise<void> {
    if (this._closed) throw new Error('session is closed')
    if (!summary.trim()) throw new Error('empty summary')
    if (opts.attachments.length > 0) {
      await this.log.migrateToV2()
      this.log.append({
        type: 'session/attachments',
        attachments: opts.attachments.map((attachment) => ({ ...attachment })),
        timestamp: opts.timestamp,
      })
    }
    this.log.append({
      type: 'user',
      uuid: opts.uuid,
      session_id: this.opts.id,
      parent_tool_use_id: null,
      timestamp: opts.timestamp,
      message: { role: 'user', content: [{ type: 'text', text: summary }] },
      isCompactSummary: true,
    })
    await this.log.flush()
    this.syncAttachmentReferences()
    this.history.push({ role: 'user', content: [{ type: 'text', text: summary }] })
  }

  /** Compaction-only projection of the durable raw-user → instruction pairs.
   *  Adjacency is the pairing contract: a raw-only crash prefix or an unrelated
   *  later skill event must never synthesize an invocation. */
  getSkillCompactionEntries(): readonly { afterUserUuid: string; body: string }[] {
    const entries: Array<{ afterUserUuid: string; body: string }> = []
    for (let index = 0; index < this.log.events.length - 1; index++) {
      const user = this.log.events[index]
      const skill = this.log.events[index + 1]
      if (user.type === 'user' && user.parent_tool_use_id === null && skill.type === 'session/skill') {
        entries.push({ afterUserUuid: user.uuid, body: skill.body })
      }
    }
    return entries
  }

  /** Compact the conversation in place (P1.1 auto-compact): append the
   *  append-only `session/compact` boundary, then restart the model history
   *  from the captured context snapshot plus the summary. Only legal while the
   *  session is idle — the manager treats a throw as "not now" and skips this
   *  attempt. Emits NO frames: the manager owns the client-facing divider.
   *  `lastUsage` resets so the context bar starts from zero while
   *  `usageByModel` keeps the cumulative billing totals. A failed flush throws
   *  before any in-memory state changes, leaving the session exactly as it was.
   *
   *  Sequencing contract: the compact boundary is appended before the flush
   *  and the history is swapped only after it resolves, so no
   *  `sendControlMessage` may run during that await — the manager owns it and
   *  only compacts while the session is idle. A queued user turn cannot slip
   *  in: the log's serialized flush chain makes the pump's own flush resolve
   *  after the compact write, so the turn starts against the swapped history. */
  async compactInPlace(summary: string, opts: { uuid: string; timestamp: string }): Promise<void> {
    if (this._closed) throw new Error('session is closed')
    if (this.turnAbort !== null) throw new Error('a turn is in flight')
    if (this.queueDepth > 0) throw new Error('input is queued')
    // An empty summary would persist a `session/compact` line the parser
    // rejects as corrupt (it requires a non-empty `text`), bricking resume.
    if (!summary.trim()) throw new Error('empty summary')
    const context = contextSnapshot(this.opts.cwd)
    this.log.append({
      type: 'session/compact',
      text: summary,
      context,
      uuid: opts.uuid,
      timestamp: opts.timestamp,
    })
    await this.log.flush()
    this.pdfBudgets.rebuildFromEvents(this.log.events)
    // History is a readonly array mutated in place; splice keeps every holder
    // of the reference (the pump loop) looking at the compacted conversation.
    this.history.splice(
      0,
      this.history.length,
      { role: 'user', content: [{ type: 'text', text: context }] },
      { role: 'user', content: [{ type: 'text', text: summary }] },
    )
    this.lastUsage = { input_tokens: 0, output_tokens: 0 }
  }

  clearQueuedInput(): number {
    return this.drainQueuedInput().length
  }

  drainQueuedInput(): AgentUserMessage[] {
    const pending = this.pendingDurableInitial
    for (const reservation of pending?.pdfReservations ?? []) this.pdfBudgets.release(reservation)
    this.pendingDurableInitial = null
    return [...(pending ? [pending.message] : []), ...this.input.splice(0)]
  }

  /** Mid-run steering intake: admitted ONLY while a turn is live — i.e. since
   *  the pump consumed its prompt and before the manager settles the turn.
   *  False means "not now", and the manager transparently falls back to its
   *  normal next-turn queue. */
  enqueueSupplement(entry: { uuid: string; text: string }): boolean {
    if (!this.steeringOpen) return false
    this.supplementQueue.push(entry)
    return true
  }

  /** Close steering admission at the turn's end. The manager calls this on
   *  every terminal frame shape (result / interrupt / API error), so a steer
   *  arriving after the turn can never be admitted with no round to inject
   *  into. */
  noteTurnSettled(): void {
    this.steeringOpen = false
  }

  /** Remove and return undelivered supplements — the manager's turn-end and
   *  interrupt requeue path (zero-loss fallback into the next-turn queue). */
  drainSupplements(): Array<{ uuid: string; text: string }> {
    return this.supplementQueue.splice(0)
  }

  /** The loop's per-round drain: persist one `session/supplement` event per
   *  pending entry (the WRAPPED guidance, so replay rebuilds the exact model
   *  history), await the flush barrier, then report delivery. The loop appends
   *  the returned text to history before building the next request.
   *
   *  The queue is cleared only AFTER the flush succeeds: a rejected flush
   *  leaves the batch pending, so the manager's turn-end `drainSupplements`
   *  requeue (or the next round's drain) still owns it — clearing first would
   *  silently drop the message after the client already rendered its bubble. */
  private async injectSupplements(): Promise<Array<{ uuid: string; text: string }>> {
    // A COPY: entries stay queued until the batch is durable.
    const batch = this.supplementQueue.slice()
    if (batch.length === 0) return []
    const timestamp = new Date().toISOString()
    const wrapped = batch.map((entry) => ({
      uuid: entry.uuid,
      text: formatSupplementInstruction(entry.text),
    }))
    for (const entry of wrapped) {
      this.log.append({
        type: 'session/supplement',
        uuid: entry.uuid,
        text: entry.text,
        timestamp,
      })
    }
    await this.log.flush()
    // An entry a concurrent drain removed meanwhile (interrupt) is the
    // manager's to requeue — do not inject or report it again.
    const retained = wrapped.filter((_entry, index) => this.supplementQueue.includes(batch[index]))
    this.supplementQueue = this.supplementQueue.filter((entry) => !batch.includes(entry))
    for (const entry of retained) {
      this.opts.onSupplementDelivered?.(entry.uuid, { ok: true, boundary: 'PreToolUse' })
    }
    return retained
  }

  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    return toolUseId === undefined ? this.tasks.background() : this.tasks.background(toolUseId)
  }

  async stopTask(taskId: string): Promise<void> {
    return this.tasks.stop(taskId)
  }

  async interrupt(opts?: { cancelQueued?: boolean }): Promise<ProviderInterruptReceipt | void> {
    // A plain interrupt stops the current turn but leaves queued user turns
    // for the next one — the manager's contract (and claude's Query.interrupt
    // behavior). Only `cancelQueued` drops them; the manager has already
    // drained its host queue and will broadcast the withdrawal.
    if (opts?.cancelQueued) this.drainQueuedInput()
    // NO frame emission here — the pumpLoop catch emits the single
    // 'interrupted by user' result frame.
    this.turnAbort?.abort(new Error('interrupted by user'))
  }

  async setModel(model?: string): Promise<void> {
    if (!model) return
    await this.updateAgentBase({ model })
  }

  async setPermissionMode(mode: string): Promise<void> {
    try {
      await this.updateAgentBase({ permissionMode: mode })
    } catch (err) {
      // The manager's permission contract is local enforcement even when the
      // provider write fails. Apply ONLY the requested base locally, then
      // rethrow so the manager resynchronizes the ACTUAL next-turn effective
      // mode (requested base without a persona override, persona otherwise).
      this.basePermissionMode = mode
      this.applyEffectiveProfile()
      throw err
    }
  }

  /** Runtime extended-thinking change (the SDK's setMaxThinkingTokens
   *  contract). The manager owns the ThinkingSetting → tokens mapping;
   *  null = adaptive, 0 = disabled, N = enabled with an N-token budget.
   *  The display is tracked SEPARATELY from the token config: an ABSENT
   *  display keeps the session-start mode, null resets it to the API
   *  default, and a provided value replaces it. 'highlights' is stored but
   *  never reaches the wire — the API only accepts 'summarized'|'omitted'.
   *  The next request reads both live fields. */
  async setMaxThinkingTokens(
    tokens: number | null,
    display?: 'summarized' | 'omitted' | 'highlights' | null,
  ): Promise<void> {
    if (display !== undefined) this.thinkingDisplay = display === null ? undefined : display
    this.thinking = tokens === null
      ? { type: 'adaptive' }
      : tokens === 0
        ? { type: 'disabled' }
        : { type: 'enabled', budgetTokens: tokens }
  }

  /** Wire shape consumed by the host's reconcile probe
   *  (liteContextUsageFromSdkUsage in session-pump.ts): { totalTokens,
   *  maxTokens, model }. */
  async getContextUsage(): Promise<unknown> {
    // Match the pump's mid-turn formula: prompt tokens = input + cache reads
    // + cache writes. Output is not part of the window the next request sends.
    const usage = this.lastUsage
    return {
      totalTokens:
        usage.input_tokens
        + (usage.cache_read_input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0),
      maxTokens: CONTEXT_WINDOW,
      model: this.model,
    }
  }

  async getUsage(): Promise<unknown> {
    const modelUsage: Record<string, {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
    }> = {}
    for (const [model, usage] of this.usageByModel) {
      modelUsage[model] = {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(usage.cache_read_input_tokens !== undefined
          ? { cacheReadInputTokens: usage.cache_read_input_tokens }
          : {}),
        ...(usage.cache_creation_input_tokens !== undefined
          ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
          : {}),
      }
    }
    // The native provider has no pricing table: report real token/model data
    // and let the panel render cost as unavailable instead of $0.
    return {
      session: { model_usage: modelUsage },
      rate_limits_available: false,
      cost_available: false,
    }
  }

  /** The `/` command catalog: every user-invocable skill of the current
   *  catalog, in the catalog's own selection state. Awaits the CURRENT
   *  discovery pass so an immediate `/commands` fetch after spawn cannot race
   *  it into an empty answer. */
  async supportedCommands(): Promise<unknown> {
    await this.skillsReady
    return this.currentSkillView().commands()
  }

  /** Auto-title through the shared auxiliary caller — the same wire contract
   *  recap / commit-message use. The model is resolved at CALL time: the
   *  profile's recapModel when set, else the session's CURRENT model (a live
   *  switch must reach this call). The manager trims and persists the
   *  returned first text block. */
  async generateTitle(description: string): Promise<unknown> {
    return callAnthropicMessages({
      model: this.opts.profile?.recapModel || this.model,
      system: TITLE_PROMPT,
      userContent: description,
      maxTokens: 64,
      temperature: 0.3,
      caller: 'session-title',
      target: this.opts.credentials(),
    })
  }

  /** The native provider talks to an Anthropic-compatible endpoint with the
   *  profile's token; there is no CLI account state to report. Answering
   *  undefined keeps the route's `{ account: null }` honest instead of
   *  fabricating account fields. */
  async accountInfo(): Promise<unknown> {
    return undefined
  }

  /** The model report, in the SDK's camelCase shape (the manager translates
   *  it to the wire's snake_case). The native provider has no CLI to ask, so
   *  the list is the configured one (`opts.profile?.modelList ??
   *  config.modelList`) and the capabilities come from the SAME model-id
   *  classification the request builder gates effort/fast mode on — the
   *  picker and the wire can therefore never disagree about a model. */
  async supportedModels(): Promise<unknown> {
    return (this.opts.profile?.modelList ?? config.modelList).map((value) => {
      const levels = effortLevelsForModel(value) ?? []
      return {
        value,
        displayName: value,
        supportsFastMode: supportsFastModeForModel(value) === true,
        supportsEffort: levels.length > 0,
        supportedEffortLevels: levels,
      }
    })
  }

  /** Re-read the skill roots and answer the fresh command catalog. The new
   *  discovery replaces `skillsReady`, so every per-turn await from here on
   *  tracks THIS pass — a manual reload both supersedes the construction
   *  snapshot and recovers the session from a failed one. */
  async reloadSkills(): Promise<unknown> {
    this.skillsReady = this.startSkillReload()
    await this.skillsReady
    return { skills: this.currentSkillView().commands() }
  }

  /** The flag-settings layer for the keys this provider supports.
   *  `skillOverrides` replaces the per-skill override map (`{}` restores the
   *  spawn default); `effortLevel` takes a level from the API's ladder or null
   *  (clear back to the model default — anything else throws); `fastMode`
   *  takes true to enable and false/null to clear; `agent` selects a stored
   *  main-thread persona or clears it with null.
   *
   *  Every key and any incoming definition is validated BEFORE state changes.
   *  Agent/base snapshots take effect on the next turn; fast mode and skill
   *  overrides keep their existing live-field behavior. Every other key fails
   *  loudly rather than reporting a change the native provider cannot honor. */
  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    const supported = new Set(['skillOverrides', 'effortLevel', 'fastMode', 'agent'])
    const unknownKeys = Object.keys(settings).filter((key) => !supported.has(key))
    if (unknownKeys.length > 0) {
      throw new Error(`native provider does not support flag settings: ${unknownKeys.join(', ')}`)
    }

    const level = settings.effortLevel
    let nextEffort = this.baseEffortLevel
    if (level !== undefined) {
      if (level === null) {
        nextEffort = undefined
      } else if (typeof level === 'string' && (EFFORT_LEVELS as readonly string[]).includes(level)) {
        nextEffort = level as EffortLevel
      } else {
        throw new Error(`native provider does not support effort level: ${String(level)}`)
      }
    }

    const fastMode = settings.fastMode
    if (fastMode !== undefined && fastMode !== null && typeof fastMode !== 'boolean') {
      throw new Error(`native provider does not support fast mode: ${String(fastMode)}`)
    }

    let agentIntent: {
      name: string | null
      definition?: NativeAgentSelectionEvent['definition']
    } | undefined
    if ('agent' in settings) {
      const name = settings.agent
      if (name !== null && typeof name !== 'string') {
        throw new Error(`native provider does not support agent: ${String(name)}`)
      }
      agentIntent = { name }
      if (name !== null) {
        const reason = agentUnusableReason(this.opts.agentStore, name)
        if (reason) throw new Error(reason)
        const definition = this.opts.agentStore!.get(name)!
        assertAgentProfileSupported(definition)
        agentIntent.definition = definition
      }
    }

    const nextBase = this.agentBaseSnapshot()
    if (level !== undefined) {
      if (nextEffort === undefined) delete nextBase.effortLevel
      else nextBase.effortLevel = nextEffort
    }
    if (agentIntent) {
      await this.appendAgentSelection(agentIntent.name, agentIntent.definition, nextBase)
    } else if (level !== undefined) {
      await this.updateAgentBase({ effortLevel: nextEffort })
    }
    if (fastMode !== undefined) this.fastMode = fastMode === true

    const overrides = settings.skillOverrides
    if (overrides === undefined) return
    this.skills.applyOverrides(overrides as Record<string, 'on' | 'name-only' | 'user-invocable-only' | 'off'>)
  }

  /** Built-in agents only: the /agents route unions the enabled
   *  `AgentDefinitionStore` definitions on top (same split as claude). */
  async supportedAgents(): Promise<unknown> {
    return [
      { name: 'general-purpose', description: 'General-purpose subagent for self-contained tasks.' },
      { name: EXPLORE_AGENT_NAME, description: EXPLORE_AGENT_DESCRIPTION },
    ]
  }

  // ── MCP control (optional ProviderSessionHandle members) ───────────────

  async mcpServerStatus(): Promise<unknown> {
    return this.mcp?.statuses() ?? []
  }

  /** Replace the dynamic MCP server set (Task 3 semantics: unchanged entries
   *  are kept, changed/removed ones close, added ones connect). The next turn
   *  sees the new tool list; a running turn keeps its snapshot. */
  async setMcpServers(servers: Record<string, unknown>): Promise<unknown> {
    if (!this.mcp) return { added: [], removed: [], errors: {} }
    const result = await this.mcp.setServers(servers)
    this.rebuildTools()
    return result
  }

  async reconnectMcpServer(name: string): Promise<void> {
    await this.mcp?.reconnect(name)
    this.rebuildTools()
  }

  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    await this.mcp?.toggle(name, enabled)
    this.rebuildTools()
  }

  async readMcpResource(serverName: string, uri: string): Promise<unknown> {
    return this.mcp?.readResource(serverName, uri)
  }

  abort(): void {
    this.sessionAbort.abort(new Error('aborted'))
  }

  async destroy(reason?: string): Promise<void> {
    if (this._closed) return
    this._closed = true
    this.sessionAbort.abort(new Error('destroyed'))
    // Crash recovery transfers pending input to respawnInPlace; keep its FIFO
    // and leases while the _closed checks above stop the old pump. Every other
    // teardown withdraws that input before releasing its lease.
    if (reason !== 'crash-recovery') this.drainQueuedInput()
    // Abort first, then close: closeAll aborts every record synchronously, so
    // a hung handshake / in-flight call cannot hold teardown open. Idempotent.
    await this.mcp?.closeAll()
    await this.tasks.destroy()
    this.output.end()
    await this.log.close()
  }
}
