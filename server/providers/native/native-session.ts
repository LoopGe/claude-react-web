// server/providers/native/native-session.ts
//
// The native provider's NEUTRAL core session (design R1, Task 10): owns the
// conversation history, the serialized turn pump, and the neutral frame output
// stream, and drives Task 9's `runTurn` loop against Task 2's Anthropic
// streamer. Implements NativeSessionCore — `messages` yields neutral
// NativeCoreFrame, input arrives as neutral RequestMessage via enqueue /
// enqueueControl, and the persistence-outcome callbacks are neutral assignable
// slots. The host adapter (native-host-frame-adapter.ts wrapNativeCore) wraps
// this core into the SDK-shaped ProviderSessionHandle: it owns the host-input
// identity (receivedAt re-key), the lease callbacks, and the neutral→SDK frame
// projection. No subprocess — the "process" is this Node process, so
// processExited resolves immediately.
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
import type { ProviderProfile } from '../../../shared/profile.js'
import { effortLevelsForModel, supportsFastModeForModel, supportsThinkingForModel } from '../../../shared/model-capability.js'
import type {
  NativeSessionCore,
  NativeAttachmentOccurrence,
  NativeInterruptReceipt,
  NativeResetBaseSettings,
  NativeEffectiveSettings,
  NativePersistenceOutcome,
  NativeDrainMode,
} from './core-contract.js'
import { runTurn, type LoopDeps, type NativeLoopFrame, type PersistedToolResult, type TurnResult, type TurnStats } from './loop.js'
import { estimateText, estimateMessage, estimateToolSchema, ROLE_OVERHEAD } from './estimate.js'
import { createUserMessage, freezeMessage, type RequestMessage, type ToolResultMessage } from './vocabulary/message.js'
import { brandString } from './vocabulary/brand.js'
import { finishReasonOf, type ContentBlock, type TokenUsage, type Usage } from './vocabulary/types.js'
import type { AssistantStreamRecord, NativeSessionEvent, SessionEvent } from './vocabulary/session-event.js'
import type { OperationalFrame, NativeCoreFrame, AssistantFrame } from './vocabulary/live-frame.js'
import type { RawStreamEvent } from './vocabulary/stream.js'
import type { NativeHostPorts } from './ports.js'
import { streamAnthropicMessages, EFFORT_LEVELS, type EffortLevel, type StreamRequest } from './anthropic-stream.js'
import type { CanonicalEvent } from './canonical.js'
import { defaultFrameContext, type FrameContext } from './vocabulary/frame-context.js'
import { NativeSessionLog, loadNativeSessionLogSync, type NativeSeed } from './session-log/log.js'
import { buildForkSeed } from './session-log/fork.js'
import { contextSnapshot, historyFromEvents, repairInterruptedTurn } from './session-log/replay.js'
import { neutralEventsOf, neutralFileOccurrences } from './session-log/neutral-read.js'
import { NativeSessionStorageError } from './session-log/errors.js'
import { nativeSessionLogPath } from './session-log/paths.js'
import type { NativeFileAttachment, NativeTurnEndReason } from './session-log/format.js'
import { mcpToolDefs } from './mcp/tools.js'
import type { NativeMcpConnections } from './mcp/connections.js'
import type { ToolDef } from './tools/types.js'
import { createAgentTool, type AgentToolDeps } from './subagent.js'
import { EXPLORE_AGENT_DESCRIPTION, EXPLORE_AGENT_NAME } from './explore.js'
import { NativeTaskManager } from './task-manager.js'
import { NativeSkillCatalog, LISTING_BUDGET_FRACTION, type NativeSkillCommand, type NativeSkillInvocationView, type NativeSkillView } from './skills.js'
import { BUILTIN_COMMANDS, discoverCommands, expandCommandBody, type NativeCommand } from './commands.js'
import { createSkillTool } from './tools/skill.js'
import { createTaskOutputTool } from './tools/task-output.js'
import { createWebFetchTool } from './tools/web-fetch.js'
import { createWebSearchTool } from './tools/web-search.js'
import { createTodoWriteTool } from './tools/todo-write.js'
import { createEnterPlanModeTool, createExitPlanModeTool, PLAN_MODE_GUIDANCE } from './tools/plan-mode.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'
import { agentUnusableReason } from '../../../shared/agent-definitions.js'
import {
  agentSelectionFromEvents,
  agentSelectionOf,
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
import { isQuestionResult } from '../../../shared/question-result.js'
import type { ThinkingDisplay, ThinkingSetting } from '../../../shared/session-info.js'
import type { UploadStore } from '../../upload-store.js'
import type { NativeAttachmentReferenceIndex } from './attachment-reference-index.js'
import {
  assignPdfModelForms,
  PdfBudgetLedger,
  PreparedPdfStore,
  type PdfBudgetReservation,
} from './pdf-documents.js'
import { DEFAULT_CONTEXT_WINDOW, type NativeModelContextResolver } from './model-context.js'
import {
  SUGGESTION_MAX_TOKENS,
  SUGGESTION_PROMPT,
  suggestionSuppressionReason,
  type SuggestionSnapshot,
} from './prompt-suggestion.js'
import { normalizeSuggestion, screenSuggestion } from './prompt-suggestion-filter.js'
import { projectNativeHistoryToWire } from './wire/wire-projection.js'
import { metrics } from '../../metrics.js'
import type { FileReadResult } from '../../../shared/read-file.js'
import { CANONICAL_SKILL_NAME_SOURCE } from '../../../shared/skills.js'
import type { NativeReadState } from './read-state.js'
import {
  DEFAULT_READ_MAX_BYTES,
  NativeFileUnavailableError,
  readNativeTarget,
  resolveNativeReadTarget,
} from './file-read.js'

interface PendingDurableInitial {
  message: RequestMessage
  persisted?: { role: 'user'; content: unknown[] }
  pdfReservations?: PdfBudgetReservation[]
}

const log = createLogger('native')

/** The native default model and per-round output cap. Exported so the
 *  one-shot structured runner (structured-run.ts / NativeProvider.runStructured)
 *  shares the session defaults instead of duplicating them. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5'
export const DEFAULT_MAX_TOKENS = 16384

/** The aux prompt for `generateTitle`. The manager trims and persists the
 *  caller's first text block, so the model must answer with the title alone. */
const TITLE_PROMPT =
  'Generate a concise session title in the same language as the request. Return only the title, without quotes, a prefix, or trailing punctuation.'

function containsStructuredFile(content: unknown[]): boolean {
  return content.some((block) => typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'file')
}

/** Neutral disjoint TokenUsage → the SDK Usage shape the session's live
 *  lastUsage / turn-end accounting and the legacy result frame carry. */
function sdkUsageOf(usage: TokenUsage): Usage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  }
}

/** SDK Usage counter pair → neutral disjoint TokenUsage (the inverse of
 *  sdkUsageOf), for the neutral terminal result frame the pump catch emits. */
function neutralUsageOf(usage: Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
  }
}

// ── Assistant stream-record packing (T11) ───────────────────────────────────
// The v3 durable assistant/message event carries the settled message PLUS its
// packed streaming history (AssistantStreamRecord). The core packs each settled
// content block into a single-chunk run honoring the inter-arrival convention
// dt[0] === 0 (T5): the run's first-chunk time is the round's first observed
// raw-stream-event arrival. Finer per-delta cadence packing awaits the loop
// exposing timed neutral chunks; the settled-content granularity is lossless
// for the message and is the builder-sanctioned packing granularity. A finish
// `chunk` record carries the stop reason so the legacy compat projection can
// reconstruct the turn-boundary signal. The neutral→legacy projection itself
// lives in session-log/format.ts (version compat), never in the core.

/** Pack the settled assistant content into AssistantStreamRecord runs. Each
 *  block becomes one run with dt=[0] (inter-arrival convention); redacted
 *  reasoning rides a verbatim block-end `chunk` (it has no text delta).
 *  Exported for the packing unit pin. */
export function packAssistantStream(
  content: readonly ContentBlock[],
  time0: number,
  stopReason: string | null,
): AssistantStreamRecord[] {
  const records: AssistantStreamRecord[] = []
  for (const [index, block] of content.entries()) {
    switch (block.type) {
      case 'text':
        records.push({ type: 'text-chunks', time0, index, dt: [0], texts: [block.text] })
        break
      case 'reasoning':
        if (block.redacted === true) {
          records.push({ type: 'chunk', time: time0, chunk: { type: 'block-end', index, block } })
        } else {
          records.push({ type: 'reasoning-chunks', time0, index, dt: [0], texts: [block.text] })
        }
        break
      case 'tool-call':
        records.push({ type: 'tool-call-chunks', time0, index, dt: [0], id: block.id, name: block.name, args: [block.arguments] })
        break
      default:
        throw new Error(`native stream packing: block kind "${(block as { type: string }).type}" is not an assistant emission`)
    }
  }
  if (stopReason !== null) {
    records.push({ type: 'chunk', time: time0, chunk: { type: 'finish', reason: finishReasonOf(stopReason) } })
  }
  return records
}

/** `/name args` — the composer's slash-command shape for a user-invoked skill.
 *  The name grammar is the CLI's canonical skill-name rule (a bare name or a
 *  single `plugin:`-composed name), compiled from the shared canonical source
 *  so the slash parser and the name validator never drift. */
const SKILL_COMMAND_RE = new RegExp('^/(' + CANONICAL_SKILL_NAME_SOURCE + ')(?:\\s+([\\s\\S]*))?$')

/** The first text block of a user turn — the only block that can carry a
 *  leading slash invocation. Every non-text block (image / file) remains
 *  untouched in the original user message. */
function invocationTextOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const block = content.find(
      (candidate) => typeof candidate === 'object' && candidate !== null &&
        (candidate as { type?: unknown }).type === 'text',
    ) as { type: 'text'; text?: unknown } | undefined
    if (typeof block?.text === 'string') return block.text
  }
  return undefined
}

/** Resolve one text block against the command catalog (builtins first, then
 *  the discovered custom rows). Lookup is case-insensitive — `/Foo` and `/foo`
 *  both resolve — while the returned name stays the authored catalog name.
 *  A builtin wins a same-name custom collision because the list is searched
 *  in concatenation order. Anything else (not a command, an unknown name) has
 *  no instruction and falls through to skill matching / plain text. */
function commandInvocationForTurn(
  content: unknown,
  commands: readonly NativeCommand[],
): { name: string; body: string } | null {
  const text = invocationTextOf(content)
  if (text === undefined) return null
  const match = SKILL_COMMAND_RE.exec(text)
  if (!match) return null
  const typed = match[1].toLowerCase()
  const cmd = commands.find((candidate) => candidate.name.toLowerCase() === typed)
  return cmd ? { name: cmd.name, body: expandCommandBody(cmd, match[2] ?? '') } : null
}

/** Resolve one text block against the captured scoped view. A `/name args`
 *  invocation of a skill the user may invoke returns that skill's canonical
 *  body with the args substituted exactly once (the raw turn keeps the typed
 *  text). Anything else (not a command, an unknown skill, an `off` skill) has
 *  no instruction. */
function skillInvocationForTurn(
  content: unknown,
  skills: NativeSkillInvocationView,
): { name: string; body: string } | null {
  const text = invocationTextOf(content)
  if (text === undefined) return null
  const match = SKILL_COMMAND_RE.exec(text)
  return match ? skills.expand(match[1], match[2] ?? '') : null
}

/** `/compact` is a CONTROL ACTION, not a prompt: the session intercepts it
 *  ahead of command/skill expansion and routes it to the host compaction
 *  callback (no model turn for the literal text). Name matching shares the
 *  slash grammar and case-insensitivity of command lookup; trailing arguments
 *  are ignored — the host summarizer compresses the whole conversation and
 *  takes no focus instructions. */
function isCompactControlInvocation(content: unknown): boolean {
  const text = invocationTextOf(content)
  if (text === undefined) return false
  const match = SKILL_COMMAND_RE.exec(text)
  return match !== null && match[1].toLowerCase() === 'compact'
}

/** Fire-and-forget flush: a persistence failure must never become an
 *  unhandled rejection or a second terminal frame, but it must be visible. */
function flushInBackground(sessionLog: NativeSessionLog, sessionId: string, what: string): void {
  void sessionLog.flush().catch((err) => log.warn(`[${sessionId}] failed to flush ${what}:`, err))
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
   *  prefers its model list; absent = the ConfigPort's active profile / model list. */
  profile?: ProviderProfile
  /** Shared route-capacity resolver owned by the provider. Direct unit
   * sessions without one retain the 200K fallback. */
  modelContext?: NativeModelContextResolver
  /** Spawn auto-compact policy window (absolute tokens), read by the host
   *  adapter from Options.settings. Clamped under the resolved model window
   *  in getContextUsage; undefined = no pin. */
  autoCompactWindow?: number
  /** Host-service ports threaded from the provider (stored on opts; the
   *  per-service call sites consume them). Config reads (profile resolution,
   *  fidelity flags, auto-compact ratio, model list) go through ports.config. */
  ports: NativeHostPorts
  /** Resolved lazily, on the first real network turn — a session must be
   *  creatable on an unconfigured machine (the failure surfaces as a loud
   *  turn error, not a create-time throw). */
  credentials: () => { baseUrl: string; authToken: string }
  /** Per-session proof of complete current-version reads, shared by Read/Edit. */
  readState: NativeReadState
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
  /** Per-session plugin subset (compound `<plugin>@<marketplace>` keys) for
   *  read-only plugin-skill discovery. `undefined` = all enabled, `[]` = none.
   *  Forwarded to the skill port; the catalog never touches the marketplace. */
  enabledPlugins?: string[]
  /** The host-resolved CLI config root (`claudeConfigDir()`), parent of the
   *  user-scope `commands/` discovery root. Passed in by the composition root
   *  — the neutral core never derives host config itself. */
  commandsUserRoot: string
  /** Create-body tool surface, merged field-wise with the selected persona.
   *  The native loop honors the allow/deny lists; permission aliases/config
   *  remain SDK-only fields and do not affect this in-process tool list. */
  toolProfile?: SessionToolProfile
  /** Turn-end prompt-suggestion intent (SDK `Options.promptSuggestions`).
   *  `undefined` = enabled; the provider normalizes the create-body value to
   *  an explicit boolean (`?? true`). */
  promptSuggestions?: boolean
  system: string
  /** The prompt a nested (Agent/Task) run gets: the parent system WITHOUT the
   *  shared delegation section, since nested tools exclude both names and a
   *  subagent told to delegate would look for a tool it cannot see. Defaults to
   *  `system`. */
  subagentSystem?: string
  /** Loose canUseTool from CreateSessionOptions — (toolName, input, {signal}) => PermissionResult. */
  canUseTool?: (...args: unknown[]) => Promise<unknown>
  /** Host-bound permission-mode change request, threaded from
   *  CreateSessionOptions. Consumed by the plan-mode entry hook (enterPlanMode)
   *  so a tool-driven mode change routes through the host manager. Absent in
   *  unit sessions that drive the core without a host manager (a no-op then). */
  requestPermissionModeChange?: (mode: string) => Promise<void>
  /** Host-bound in-place compaction request, threaded from
   *  CreateSessionOptions. The `/compact` control interception calls it
   *  instead of expanding a prompt; the manager records the request and runs
   *  its in-place compaction flow (summarize + compactInPlace + appended
   *  divider/summary, history retained) once the control turn settles idle.
   *  Absent in unit sessions that drive
   *  the core without a host manager (the control turn then simply completes
   *  with no compaction). */
  requestCompact?: () => Promise<void>
  /** Test seam: evaluated PER TURN; a non-undefined return replaces the real
   *  network streamer for that turn. Per-turn evaluation lets tests swap the
   *  script between turns. */
  streamSupplier?: () => LoopDeps['stream'] | undefined
}

export class NativeSession implements NativeSessionCore {
  /** The session id stamped on every projected live frame envelope. */
  readonly sessionId: string

  private readonly output: Pushable<NativeCoreFrame>
  private readonly input: RequestMessage[] = []
  /** Consumed from FIFO but not yet appended. It remains withdrawable and is
   * always retried before any later input after a migration/append failure. */
  private pendingDurableInitial: PendingDurableInitial | null = null
  /** Monotonic explicit-enqueue marker. A pre-append failure captures this
   * value so only an enqueue observed AFTER that failure can release its pause. */
  private enqueueGeneration = 0
  /** True while a pre-append failure has parked `pendingDurableInitial` and the
   * pump loop is paused: no turn is in flight and none will start until a direct
   * `enqueueUserMessage` retries the durable append. Set synchronously when the
   * failure is classified (BEFORE the error result frame is pushed) so a send
   * arriving even during turn/end finalization already sees the pause; cleared
   * by the enqueue that releases it (or by withdrawal). The manager reads it via
   * `awaitingDurableRetry` to dispatch a retry synchronously instead of stranding
   * it in the queued-not-published path, which waits for a turn terminal that a
   * paused loop will never emit. */
  private durableRetryPaused = false
  private readonly ctx: FrameContext
  /** Append-only persistence for this session. Every constructor path opens it
   *  (fresh create, resume, or fork-seeded) before `system/init` is pushed. */
  private readonly log: NativeSessionLog
  /** Arrival time per queued turn, keyed by the neutral message id — recorded
   *  at enqueue, written to the log when the pump consumes the message (a
   *  drained turn must not persist), and deleted on that consumption or on
   *  drain, so the map holds only in-flight prompts. The host adapter
   *  separately re-keys the HOST receivedAt onto the uuid for the lease-callback
   *  projections; this map is the core's own enqueue-time arrival for the
   *  durable timestamp. */
  private readonly receivedAt = new Map<string, number>()
  /** Neutral persistence-outcome slots (NativeSessionCore). The host adapter
   *  assigns translating functions that look up the paired host message and
   *  fire the host lease callbacks. Unassigned in a bare core (unit tests). */
  onUserMessageConsumed?: (msg: RequestMessage) => void
  onUserMessagePersistence?: (msg: RequestMessage, outcome: NativePersistenceOutcome) => void
  onSupplementDelivered?: (uuid: string, outcome: SupplementOutcome) => void
  /** Flush of the most recent assistant event. `requestPermission` awaits it
   *  before any tool runs, so a crash is always recoverable as "call sent,
   *  result unknown" — never "tool ran but its call was never durable". */
  private assistantFlush: Promise<void> | null = null
  /** Arrival time of the current API round's first raw stream event — the
   *  time0 for the packed AssistantStreamRecord runs. Reset when the round's
   *  assistant frame is persisted. */
  private roundFirstChunkAt: number | null = null
  /** Session-level abort (abort()/destroy()). Never aborted by a mere interrupt. */
  private readonly sessionAbort = new AbortController()
  /** Per-turn abort, replaced by pumpLoop for every turn. */
  private turnAbort: AbortController | null = null
  /** The in-flight turn's shared stats record (see TurnStats): created by
   *  pumpLoop, advanced by runTurn, stamped by interrupt(), read by BOTH
   *  settlement paths. Null while no turn is in flight. */
  private turnStats: TurnStats | null = null
  /** Neutral conversation state sent to the API on every turn (mutated in place
   *  by runTurn; projected to the wire request by projectNativeHistoryToWire). */
  private readonly history: RequestMessage[] = []
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
  /** Custom `.claude/commands` rows discovered as of the last reload. Replaced
   *  wholesale (never mutated), so a turn's captured reference is a stable
   *  snapshot. Builtin rows are concatenated separately at every read. */
  private customCommands: NativeCommand[] = []
  /** The CURRENT command discovery in flight — the same supersede semantics
   *  as `skillsReady`, re-assigned by `reloadSkills`. */
  private commandsReady: Promise<void>
  /** Generation fence for command discovery: a slower earlier pass must not
   *  overwrite a newer committed one (mirrors NativeSkillCatalog.reload). */
  private commandGeneration = 0
  private committedCommandGeneration = 0
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
  private modelGeneration = 0
  private readonly profile: ProviderProfile
  /** Live permission mode: setPermissionMode keeps it current for the lifetime
   *  of the session — the spawn-time opts value is only the starting point, so
   *  a bypass-spawned session can be downgraded mid-flight. */
  private permissionMode: string
  /** The ACTIVE main turn's permission-mode snapshot, passed to every tool's
   *  permission call for that turn. Normally frozen at turn start (a non-plan
   *  mid-turn chip switch only lands next turn). A PLAN-involved mid-turn
   *  transition — entry to plan (EnterPlanMode) or exit from plan (an approved
   *  ExitPlanMode) — refreshes it via setPermissionMode so the broker's
   *  acceptEdits/bypass auto-allow engages for the rest of the SAME turn, matching
   *  the CLI's approve→execute semantics. Null when no main turn is running; the
   *  turn loop owns a local reference, so a stale holder is never read. */
  private activeTurnMode: { mode: string } | null = null
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
  /** The wire shape of the last MAIN-thread API request, captured per round in
   *  the turn's stream lambda (last round wins). The turn-end suggestion fork
   *  replays this prefix so the parent's cache breakpoints still hit. Nested
   *  runners wire their own stream and never capture. References are stored
   *  as-is: the wire projection builds fresh arrays per round, so the snapshot
   *  holds that round's arrays unchanged. */
  private suggestionSnapshot: SuggestionSnapshot | null = null
  /** The LAST MAIN-thread API round's neutral usage — each main-thread
   *  assistant frame overwrites it (nested frames never do), so after a turn it
   *  holds the last round's reading, not the turn total. The suggestion
   *  cache-evidence gate reads it. */
  private lastRoundUsage: TokenUsage | null = null
  /** Abort controller for the in-flight turn-end suggestion fork. Replaced
   *  every time a new fork starts; aborted by new input (enqueue), a new turn
   *  starting (pumpLoop), interrupt, and destroy. Null when no fork is live. */
  private suggestionAbort: AbortController | null = null
  /** The in-flight suggestion fork's settlement promise (never rejects — the
   *  fork owns its failure contract). destroy awaits it under a bounded cap;
   *  the fork's finally clears it once settled. Null when no fork is live. */
  private suggestionInFlight: Promise<void> | null = null
  /** Per-model totals for the /usage panel. Accumulated from every persisted
   *  assistant frame (one per API round), which keeps the live value identical
   *  to what a restart rebuilds from the log. */
  private readonly usageByModel = new Map<string, Usage>()
  private _closed = false

  constructor(private readonly opts: NativeSessionOptions) {
    // opts must be bound before these: output's label and ctx carry the id.
    this.sessionId = opts.id
    this.output = createPushable<NativeCoreFrame>(`native-session[${opts.id}]`)
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
    this.profile = opts.profile ?? opts.ports.config.activeProfile()
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
      auxLlm: opts.ports.auxLlm,
    })
    this.webSearchTool = createWebSearchTool()
    this.todoWriteTool = createTodoWriteTool({ todos: [] })
    // Skills are discovered before the first turn can ask for them. The
    // policy is stored separately from discovery (the catalog resolves state
    // lazily), so configure-before/after-reload makes no difference.
    this.skills = new NativeSkillCatalog(opts.cwd, opts.ports.skill, opts.enabledPlugins)
    this.skills.configure(opts.skills)
    this.skillsReady = this.startSkillReload()
    // Custom commands are discovered before the first turn can invoke them,
    // the same per-turn-await shape as the skill catalog.
    this.commandsReady = this.startCommandReload()
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
      emit: (frame, parentToolUseId) => {
        this.persistFrame(frame, parentToolUseId)
        this.emitFrame(frame, parentToolUseId)
      },
      persistToolResult: (result, parentToolUseId) => this.persistToolResult(result, parentToolUseId),
      attachmentProjection: {
        attachmentPort: opts.uploadStore ? opts.ports.attachment : undefined,
        preparedPdfs: this.preparedPdfs,
      },
      appendDescriptor: async (input) => {
        // The runner builds the neutral v3 descriptor (identity in `data`, time
        // paired with data.timestamp); the log assigns seq. Return the neutral
        // event with that seq — for a v3 log this is exactly the stored canonical
        // form.
        const appended = await this.log.appendDurable(input)
        return { ...input, seq: appended.seq } as SessionEvent<'subagent/descriptor'>
      },
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
    this.pdfBudgets.rebuildFromEvents(neutralEventsOf(this.log))
    this.syncAttachmentReferences()
    // session-health's stuck-GC force-unloads sessions whose init never
    // lands — push it first, before any turn output. `fast_mode_state` is
    // intent-based, so the client's chip is correct before the first turn
    // ends (the native provider has no CLI to report a runtime state).
    this.output.push({
      type: 'init',
      sessionId: opts.id,
      uuid: this.ctx.uuid(),
      parentToolUseId: null,
      fastMode: this.fastMode,
    })
    if (this.legacyAgentDropNotice !== undefined) {
      this.output.push({
        type: 'informational',
        sessionId: opts.id,
        uuid: this.ctx.uuid(),
        parentToolUseId: null,
        text: this.legacyAgentDropNotice,
      })
    }
    // `tools` is now the effective list from birth, not builtins-only until
    // the first turn: the invariant tools = builtins + Agent + Task + MCP defs
    // must hold for every reader, not just the pump after discovery.
    this.rebuildTools()
    // MCP discovery is fire-and-forget (`load` enqueues the connect pass), so
    // the rebuild above ran before it settled and saw no MCP defs. Refresh the
    // snapshot once discovery lands so pre-turn readers (the context
    // composition) honor the birth invariant above without waiting for a turn.
    // Later live mutations rebuild themselves; this closes only the initial
    // discovery gap. A destroy before settlement no-ops.
    if (this.mcp) {
      void this.mcp.whenReady()
        .then(() => { if (!this._closed) this.rebuildTools() })
        .catch((err) => log.debug(`[${opts.id}] post-discovery tool refresh failed:`, err))
    }
  }

  private currentSkillView(): ReturnType<NativeSkillCatalog['view']> {
    return this.skills.view(this.currentProfile?.skills ?? this.baseSkillPolicy)
  }

  private skillToolFor(view: NativeSkillView): ToolDef {
    return createSkillTool({
      bodyOf: (name: string, args?: string) => view.bodyOf(name, args),
    } as NativeSkillCatalog)
  }

  private applyEffectiveProfile(): void {
    const model = this.currentProfile?.model ?? this.baseModel
    if (model !== this.model) this.modelGeneration++
    this.model = model
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

  private restoreAgentSelection(events: readonly NativeSessionEvent[], sessionLog: NativeSessionLog): void {
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
    const timestamp = new Date().toISOString()
    const input = {
      type: 'session/agent' as const,
      time: Date.parse(timestamp),
      data: {
        name: dropped ? null : definition.name,
        ...(dropped
          ? { droppedAgent: { name: definition.name, unsupportedFields } }
          : { definition: structuredClone(definition) }),
        base: this.agentBaseSnapshot(),
        timestamp,
      },
    }
    // append returns the canonical stored event (neutral for a v3 log); the
    // selection snapshot is rebuilt from the input + the log-assigned seq, the
    // same neutral read the resume/fork paths use (agentSelectionOf).
    const appended = sessionLog.append(input)
    flushInBackground(sessionLog, this.opts.id, 'legacy agent migration')
    this.applyAgentSelection(agentSelectionOf({ ...input, seq: appended.seq } as SessionEvent<'session/agent'>))
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
    const timestamp = new Date().toISOString()
    const input = {
      type: 'session/agent' as const,
      time: Date.parse(timestamp),
      data: {
        name,
        ...(definition ? { definition: structuredClone(definition) } : {}),
        base,
        timestamp,
      },
    }
    const appended = await this.log.appendDurable(input)
    this.applyAgentSelection(agentSelectionOf({ ...input, seq: appended.seq } as SessionEvent<'session/agent'>))
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
    const previous = agentSelectionFromEvents(neutralEventsOf(this.log))
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

  getEffectiveSettings(): NativeEffectiveSettings {
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

  getResetBaseSettings(): NativeResetBaseSettings {
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
    let selection: SessionEvent<'session/agent'> | undefined
    if (opts.agent !== undefined) {
      const reason = agentUnusableReason(opts.agentStore, opts.agent)
      if (reason) throw new Error(reason)
      const definition = opts.agentStore!.get(opts.agent)!
      // Validate BEFORE opening the file: a rejected fresh selection must not
      // leave a turn-less log that a later resume could mistake for a session.
      assertAgentProfileSupported(definition)
      const timestamp = new Date().toISOString()
      selection = {
        seq: 1,
        type: 'session/agent',
        time: Date.parse(timestamp),
        data: {
          name: definition.name,
          definition: structuredClone(definition),
          base: this.agentBaseSnapshot(),
          timestamp,
        },
      }
    }
    // The opening context is a neutral v3 seed event (time 0, matching the
    // legacy migration's session/context projection byte-for-byte). The log
    // normalizes the seed and assigns seq; no legacy read view is involved.
    const context: SessionEvent<'session/context'> = {
      seq: 0,
      type: 'session/context',
      time: 0,
      data: { text: contextSnapshot(opts.cwd) },
    }
    const log = NativeSessionLog.open({
      stateDir: opts.stateDir,
      id: opts.id,
      cwd: opts.cwd,
      resume: false,
      seed: { events: selection ? [context, selection] : [context], inheritedEventCount: 0, isSeeded: false },
    })
    this.history.push(...historyFromEvents(neutralEventsOf(log)))
    if (selection) {
      // Context and selection share the initial synchronous seed write: the
      // next-turn profile is durable before createSession returns.
      this.applyAgentSelection(agentSelectionOf(selection))
    }
    return log
  }

  /** Resume: rebuild model history from the persisted events, repairing any
   *  tool_use a crash left unanswered (the API rejects invalid tool history).
   *  The synthetic results are appended so they survive the next restart too,
   *  and the repaired turn is durably closed with `turn/end { interrupted }`. */
  private openResumeLog(opts: NativeSessionOptions): NativeSessionLog {
    const log = NativeSessionLog.open({ stateDir: opts.stateDir, id: opts.id, cwd: opts.cwd, resume: true })
    // Snapshot the neutral prefix BEFORE the repair appends: for a v3 log the
    // helper returns the live baseline by reference, which the repair mutates.
    const events = neutralEventsOf(log).slice()
    const { synthetic } = repairInterruptedTurn(neutralEventsOf(log))
    if (synthetic.length > 0) {
      for (const event of synthetic) log.append(event)
      log.append({ type: 'turn/end', time: 0, data: { reason: 'interrupted' } })
      flushInBackground(log, opts.id, 'interrupted-turn repair')
    }
    // `append` mutated the log's event streams, so this is the original prefix
    // plus the synthetic results (now seq-numbered). `turn/end` is bookkeeping
    // and is skipped by `historyFromEvents`.
    this.history.push(...historyFromEvents(neutralEventsOf(log)))
    this.restoreAgentSelection(neutralEventsOf(log), log)
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
    const forkSeed = buildForkSeed({
      source,
      sourceId,
      cwd: opts.cwd,
      resumeSessionAt: opts.resumeSessionAt,
    })
    // The seed is neutral end-to-end (a v1/v2 source was migrated in memory by
    // buildForkSeed); the child log is v3 and stamps its own header id at the
    // SDK-seam / v1-v2 compat projection, so no session_id rewrite rides the
    // seed. `forkSeed.events` is the NEUTRAL seed list, not a legacy read view.
    const seedEvents = forkSeed.events
    const seed: NativeSeed = forkSeed
    const firstSelection = neutralEventsOf(source).find(
      (event): event is SessionEvent<'session/agent'> => event.type === 'session/agent',
    )
    if (firstSelection && !agentSelectionFromEvents(seedEvents)) {
      // The cut predates the persona, but later source metadata must not leak
      // into the child. Preserve the pre-persona base carried by the FIRST
      // selection and synchronously seed an explicit neutral clear for replay.
      const timestamp = new Date().toISOString()
      seedEvents.push({
        seq: seedEvents.length,
        type: 'session/agent',
        time: Date.parse(timestamp),
        data: {
          name: null,
          base: structuredClone(firstSelection.data.base),
          timestamp,
        },
      })
    }
    const log = NativeSessionLog.open({
      stateDir: opts.stateDir,
      id: opts.id,
      cwd: opts.cwd,
      resume: false,
      seed,
    })
    this.history.push(...historyFromEvents(neutralEventsOf(log)))
    this.restoreAgentSelection(seedEvents, log)
    // Match what a restart of this child would see: its copied prefix's
    // usage-bearing `turn/end` events define last/total (the `{forked}` close
    // carries none and is skipped). Without this the fork reports 0 until the
    // next restart, then jumps to the inherited numbers.
    this.restoreUsage(seedEvents)
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
  private restoreUsage(events: readonly NativeSessionEvent[]): void {
    let lastAssistant: Usage | null = null
    let lastEnd: Usage | null = null
    this.usageByModel.clear()
    for (const event of events) {
      if (event.type === 'session/compact') {
        lastAssistant = null
        lastEnd = null
        continue
      }
      if (event.type === 'assistant/message') {
        const usage = event.data.usage !== undefined ? sdkUsageOf(event.data.usage) : null
        if (usage) {
          // The context bar describes the MAIN conversation's last request, so
          // only a top-level assistant frame updates it. Billing is cumulative
          // across the whole session, sidechain rounds included.
          if (event.parentToolUseId === null) lastAssistant = usage
          const model = event.data.message.source.model || this.model
          this.usageByModel.set(
            model,
            addUsage(this.usageByModel.get(model) ?? { input_tokens: 0, output_tokens: 0 }, usage),
          )
        }
        continue
      }
      if (event.type !== 'turn/end' || !event.data.usage) continue
      lastEnd = { input_tokens: event.data.usage.inputTokens, output_tokens: event.data.usage.outputTokens }
    }
    this.lastUsage = lastAssistant ?? lastEnd ?? { input_tokens: 0, output_tokens: 0 }
  }

  readonly abortSignal = this.sessionAbort.signal
  readonly processExited: Promise<unknown> = Promise.resolve()

  get queueDepth(): number {
    return this.input.length + (this.pendingDurableInitial ? 1 : 0)
  }

  /** The durable-retry pause: a pre-append failure parked the head prompt and
   * broke the pump loop, so no turn terminal will arrive until a direct enqueue
   * retries it. `queueDepth` still counts the parked prompt (it is withdrawable
   * pending input), but a mid-turn send must NOT be queued-not-published against
   * it — the manager dispatches synchronously to release the pause. */
  get awaitingDurableRetry(): boolean {
    return this.durableRetryPaused
  }

  get messages(): AsyncIterable<NativeCoreFrame> {
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
    readOnlyHint?: boolean,
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
    return this.decidePermission(toolName, input, toolUseId, signal, permissionMode, readOnlyHint)
  }

  private async decidePermission(
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal: AbortSignal,
    permissionMode: string,
    readOnlyHint?: boolean,
  ) {
    // An interrupt/destroy can land while the model turn's flush is in flight.
    // Re-check before handing the signal to the broker: its abort listener
    // never fires for an already-aborted signal, so the permission would park
    // forever — and bypass mode would run the tool after the user stopped.
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
      // The resolved ToolDef's read-only metadata (MCP tools: the server's
      // declared annotation). Only present when proven true — the host plan
      // gate treats absence as "not proven" (fail-closed).
      ...(readOnlyHint === true ? { readOnlyHint: true } : {}),
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

  async readFile(
    path: string,
    opts?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' },
  ): Promise<FileReadResult> {
    const tools = this.currentProfile?.tools ?? this.baseToolProfile?.tools
    const disallowedTools = this.currentProfile?.disallowedTools ?? this.baseToolProfile?.disallowedTools
    if ((tools !== undefined && !tools.includes('Read')) || disallowedTools?.includes('Read')) {
      return { available: false }
    }

    const maxBytes = opts?.maxBytes ?? DEFAULT_READ_MAX_BYTES
    const encoding = opts?.encoding ?? 'utf-8'
    const input = { file_path: path, maxBytes, encoding }
    try {
      const target = await resolveNativeReadTarget(this.opts.cwd, path)
      const permission = this.baseToolProfile?.allowedTools?.includes('Read')
        ? { allowed: true, input }
        : await this.decidePermission(
          'Read',
          input,
          `host-read-file:${this.ctx.uuid()}`,
          this.sessionAbort.signal,
          this.permissionMode,
        )
      if (!permission.allowed) return { available: false }
      const updated = permission.input
      if (Object.keys(updated).length !== 3
        || updated.file_path !== input.file_path
        || updated.maxBytes !== input.maxBytes
        || updated.encoding !== input.encoding) {
        return { available: false }
      }
      const { result, observation } = await readNativeTarget(target, {
        maxBytes,
        encoding,
        signal: this.sessionAbort.signal,
      })
      if (observation) this.opts.readState.observeHost(observation)
      return result
    } catch (err) {
      if (err instanceof NativeFileUnavailableError) return { available: false }
      throw err
    }
  }

  async seedReadState(path: string, mtimeMs: number): Promise<void> {
    await this.opts.readState.seedReadState(this.opts.cwd, path, mtimeMs)
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
        if (!opts?.suppressRetryFrames) {
          this.output.push({
            type: 'api/retry',
            sessionId: this.opts.id,
            uuid: this.ctx.uuid(),
            parentToolUseId: this.ctx.parentToolUseId ?? null,
            attempt: info.attempt,
            maxRetries: info.maxRetries,
            delayMs: info.delayMs,
          })
        }
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

  /** Turn-end prompt-suggestion orchestration (design §5–§7). Runs the
   *  suppression chain against the just-finished turn; on a pass, spawns ONE
   *  fire-and-forget fork that replays the captured request snapshot. Never
   *  blocks or errors the main turn — every outcome is silent bar the frame. */
  private async maybeSuggestPrompt(turnResult: TurnResult | null): Promise<void> {
    const reason = suggestionSuppressionReason({
      enabled: this.opts.promptSuggestions !== false,
      assistantCount: this.history.filter((m) => m.role === 'assistant').length,
      turnIsError: turnResult === null || turnResult.isError,
      permissionMode: this.permissionMode,
      currentModel: this.model,
      snapshot: this.suggestionSnapshot,
      lastRoundUsage: this.lastRoundUsage,
      now: Date.now(),
    })
    if (reason !== null) {
      // The gate returns only 'cache_cold'; derive the sub-cause for the log
      // from the inputs it read (design §5 gate 8 cacheColdBy): no usage / zero
      // reads is missing evidence, a warm-but-old prefix is expiry.
      const coldBy = reason === 'cache_cold'
        ? ((this.lastRoundUsage?.cacheReadTokens ?? 0) === 0 ? 'no_evidence' : 'prefix_expired')
        : undefined
      log.debug(`[${this.opts.id}] prompt suggestion suppressed: ${reason}${coldBy ? ` (cacheColdBy: ${coldBy})` : ''}`)
      metrics.count('native_prompt_suggestion_total', { outcome: 'suppressed', reason })
      return
    }
    // At most one suggestion per turn: abort any previous fork before starting.
    this.suggestionAbort?.abort()
    if (this.sessionAbort.signal.aborted) return
    const abort = new AbortController()
    this.suggestionAbort = abort
    // runSuggestion owns its failure contract (never rejects), so this
    // fire-and-forget assignment can never produce an unhandled rejection.
    this.suggestionInFlight = this.runSuggestion(abort.signal)
  }

  /** The suggestion fork: project the final assistant message to its wire
   *  shape, append it + the SUGGESTION MODE prompt after the snapshot prefix
   *  (breakpoint-free), stream ONE round, and emit at most one normalized +
   *  screened suggestion. Reads only the snapshot — never live system/tools —
   *  and never touches history, the v3 log, read-state, or session usage. */
  private async runSuggestion(signal: AbortSignal): Promise<void> {
    // The gate proved the snapshot non-null and no await ran since, so this
    // synchronous read holds exactly the gated snapshot.
    const snap = this.suggestionSnapshot!
    const startedAt = Date.now()
    try {
      const last = this.history[this.history.length - 1]
      if (last === undefined || last.role !== 'assistant') {
        log.debug(`[${this.opts.id}] prompt suggestion skipped: last history message is not an assistant`)
        return
      }
      const finalWire = await projectNativeHistoryToWire(
        [last],
        {
          attachmentPort: this.opts.uploadStore ? this.opts.ports.attachment : undefined,
          preparedPdfs: this.preparedPdfs,
        },
        signal,
      )
      if (signal.aborted) return
      // Credentials are resolved by runSuggestionFork's production branch only
      // (the test seam bypasses them, exactly as streamFor bypasses defaultStream).
      const req: Omit<StreamRequest, 'baseUrl' | 'authToken'> = {
        model: snap.model,
        system: snap.system,
        tools: snap.tools,
        messages: snap.messages,
        appendMessages: [...finalWire, { role: 'user', content: [{ type: 'text', text: SUGGESTION_PROMPT }] }],
        maxTokens: SUGGESTION_MAX_TOKENS,
        // Same model gate as the main request: a non-thinking model/gateway
        // must not receive an unexpected thinking field. No effort/fastMode/
        // temperature/thinkingDisplay — prediction needs none of them.
        // Known limitation (design §11): always-on-thinking Anthropic models
        // whose ids match the classifier (e.g. Opus 5.5 / Sonnet 5.5) 400 on
        // thinking:disabled at every effort level, yet the keyword classifier
        // (opus/sonnet substring) returns true for them — the fork silently
        // skips there (contained by the silent-failure contract). Fable ids do
        // NOT match the classifier, so they take the omitted-field path instead.
        // A thinking-mode-aware gate is a scheduled follow-up.
        ...(supportsThinkingForModel(snap.model) === true ? { thinking: { type: 'disabled' as const } } : {}),
        signal,
      }
      // Collect text by block index; reasoning/tool deltas are ignored (the
      // fork never executes tools — single round, text only).
      const textByIndex = new Map<number, string>()
      for await (const ev of this.runSuggestionFork(req)) {
        if (signal.aborted) return
        if (ev.kind === 'block_start' && ev.block.type === 'text') textByIndex.set(ev.index, '')
        else if (ev.kind === 'block_delta' && ev.delta.type === 'text' && textByIndex.has(ev.index)) {
          textByIndex.set(ev.index, textByIndex.get(ev.index)! + ev.delta.text)
        }
      }
      if (signal.aborted) return
      // First non-null normalized candidate in block order, then the screen.
      let candidate: string | null = null
      for (const index of [...textByIndex.keys()].sort((a, b) => a - b)) {
        candidate = normalizeSuggestion(textByIndex.get(index)!)
        if (candidate !== null) break
      }
      if (candidate === null) {
        log.debug(`[${this.opts.id}] prompt suggestion suppressed: empty`)
        metrics.count('native_prompt_suggestion_total', { outcome: 'suppressed', reason: 'empty' })
        return
      }
      const screened = screenSuggestion(candidate)
      if (!screened.ok) {
        log.debug(`[${this.opts.id}] prompt suggestion suppressed: ${screened.reason}`)
        metrics.count('native_prompt_suggestion_total', { outcome: 'suppressed', reason: screened.reason })
        return
      }
      this.output.push({
        type: 'prompt/suggestion',
        suggestion: screened.text,
        sessionId: this.opts.id,
        uuid: this.ctx.uuid(),
        parentToolUseId: null,
      })
      metrics.count('native_prompt_suggestion_total', { outcome: 'generated' })
      // §8 parity: textLen + elapsed (from fork start) + the cacheRead evidence
      // that authorized this generation (the gate proved it non-zero).
      log.debug(`[${this.opts.id}] prompt suggestion generated (textLen=${screened.text.length}, elapsed=${Date.now() - startedAt}ms, cacheRead=${this.lastRoundUsage?.cacheReadTokens ?? 0})`)
    } catch (err) {
      if (signal.aborted) return // aborted → silent
      log.debug(`[${this.opts.id}] prompt suggestion failed:`, err)
      metrics.count('native_prompt_suggestion_total', { outcome: 'failed', reason: 'error' })
    } finally {
      // Clear only if this fork still owns the slot — a newer turn may have
      // already replaced it while this one was settling.
      if (this.suggestionAbort?.signal === signal) {
        this.suggestionAbort = null
        this.suggestionInFlight = null
      }
    }
  }

  /** Route the fork through the test seam when present (flattening the
   *  breakpoint-free tail into messages so the seam sees the full fork
   *  content); otherwise call the real streamer with a SILENT onRetry — a
   *  fork's retry frames must never reach the session channel. */
  private runSuggestionFork(req: Omit<StreamRequest, 'baseUrl' | 'authToken'>): AsyncIterable<CanonicalEvent> {
    const testStream = this.opts.streamSupplier?.()
    if (testStream) {
      return testStream({
        model: req.model,
        system: req.system,
        tools: req.tools,
        messages: [...req.messages, ...(req.appendMessages ?? [])],
        signal: req.signal,
      })
    }
    // The fork inherits the transport's cap behavior — no separate idle
    // timeout: a wedged fork on an idle session is bounded by the 1024 output
    // cap and aborted on user activity/destroy. A fork-specific idle cap is a
    // possible follow-up (design §10 left the choice to the implementer).
    return streamAnthropicMessages({ ...this.opts.credentials(), ...req }, async () => {})
  }

  /** The operational live-frame discriminants (the system/result surface).
   *  Everything else in the loop emission union is a conversation frame. */
  private isOperationalFrame(frame: NativeLoopFrame): frame is OperationalFrame {
    if (!('type' in frame)) return false
    switch (frame.type) {
      case 'init': case 'api/retry': case 'informational': case 'task/started': case 'task/notification': case 'result': case 'prompt/suggestion':
        return true
      default:
        return false
    }
  }

  /** Emit one neutral loop frame onto the live channel. Operational frames
   *  carry their envelope inline (pushed verbatim); conversation frames
   *  (assistant bundle / raw passthrough / first-class tool result) are wrapped
   *  with the caller's sidechain parent so the host adapter can derive the SDK
   *  envelope. This is the neutral core emission — the SDK projection lives in
   *  wrapNativeCore, never here. */
  private emitFrame(frame: NativeLoopFrame, parentToolUseId: string | null): void {
    if (this.isOperationalFrame(frame)) {
      this.output.push(frame)
      return
    }
    // runTurn only emits conversation frames here (assistant bundle / raw
    // passthrough / first-class tool result); StreamChunk is assembler-internal
    // and never reaches deps.emit. Narrow the widened loop union to the
    // conversation subset the envelope wrapper carries.
    const conversation = frame as AssistantFrame | RawStreamEvent | ToolResultMessage
    this.output.push({ type: 'enveloped-conversation', frame: conversation, parentToolUseId })
  }

  /** Persist a neutral assistant frame as a v3 `assistant/message` event: the
   *  settled message plus its packed streaming history (dt[0]=0). The core
   *  writes NEUTRAL — the session-log writer owns the neutral→legacy version
   *  compat for a not-yet-migrated v1/v2 log (T12 migrates eager-at-open). Raw
   *  passthrough frames only arm the round's first-chunk time; canonical tool
   *  results use `persistToolResult` below (their structured content is not on
   *  the deliberately text-only UI frame). */
  private persistFrame(frame: NativeLoopFrame, parentToolUseId: string | null): void {
    if (!('type' in frame)) return
    if (frame.type === 'raw-stream-event') {
      // Arrival timing only — the core never inspects the raw payload (R2).
      if (this.roundFirstChunkAt === null) this.roundFirstChunkAt = Date.now()
      return
    }
    if (frame.type !== 'assistant-frame') return
    // One assistant frame = one API round; keep the LAST MAIN-thread round's
    // reading for the suggestion cache-evidence gate (overwritten every round).
    // Nested runners share this persist path with a non-null parent — their
    // usage must not clobber the main-thread evidence the snapshot pairs with.
    if (parentToolUseId === null) this.lastRoundUsage = frame.usage
    const time = Date.now()
    const time0 = this.roundFirstChunkAt ?? time
    this.roundFirstChunkAt = null
    this.log.append({
      type: 'assistant/message',
      time,
      parentToolUseId,
      data: {
        message: frame.message,
        stream: packAssistantStream(frame.message.content, time0, frame.stopReason),
        usage: frame.usage,
        // The verbatim API stop reason rides the durable event so rare reasons
        // the closed FinishReason union cannot express (stop_sequence,
        // pause_turn, refusal, …) survive live → durable → legacy projection
        // (T12 migration carries it; the live emitter populates it here).
        ...(frame.stopReason !== null ? { rawStopReason: frame.stopReason } : {}),
      },
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
    const model = frame.model || this.model
    this.usageByModel.set(
      model,
      addUsage(this.usageByModel.get(model) ?? { input_tokens: 0, output_tokens: 0 }, sdkUsageOf(frame.usage)),
    )
  }

  private syncAttachmentReferences(): void {
    this.opts.attachmentReferences?.replaceSession(this.opts.id, neutralEventsOf(this.log))
  }

  private persistToolResult(record: PersistedToolResult, parentToolUseId: string | null): void {
    // Write the neutral first-class `tool/result` event. The durable identity is
    // record.uuid (shared with the live UI frame), so re-key the loop's history
    // message onto it; the full canonical content (text + structured files) is
    // persisted while the live UI frame stays text-only.
    const message = freezeMessage({ ...record.message, id: brandString<'MessageId'>(record.uuid) })
    this.log.append({
      type: 'tool/result',
      time: Date.now(),
      parentToolUseId,
      data: { message },
    })
    this.preparedPdfs.confirmPersisted(message.toolCallId)
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
    const { synthetic } = repairInterruptedTurn(neutralEventsOf(this.log))
    if (synthetic.length === 0) return
    for (const event of synthetic) {
      this.log.append(event)
      // The live ring/UI must see the same synthetic result the disk replay
      // will show, with the SAME uuid so the seq store and a later restart do
      // not render it twice. The synthetic neutral tool/result message's minted
      // id IS that durable uuid (the legacy projection stamps it), so emit the
      // message itself as a first-class neutral tool result — the host adapter
      // projects it back to the identical SDK user frame — and join it to the
      // model history ungrouped (the wire adapter regroups consecutive ones).
      const message = event.data.message
      this.output.push({ type: 'enveloped-conversation', frame: message, parentToolUseId: null })
      this.history.push(message)
    }
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

  /** Start a command-discovery pass and return it as the current
   *  `commandsReady`. Same observed-but-loud contract as `startSkillReload`:
   *  the catch marks the promise handled at process level while the turn path
   *  still awaits the ORIGINAL promise, so a real failure stays a loud turn
   *  error. The generation fence keeps a slower earlier pass from overwriting
   *  a newer committed snapshot. */
  private startCommandReload(): Promise<void> {
    const generation = ++this.commandGeneration
    const reload = discoverCommands(this.opts.cwd, this.opts.commandsUserRoot).then((commands) => {
      if (generation <= this.committedCommandGeneration) return
      this.customCommands = commands
      this.committedCommandGeneration = generation
    })
    void reload.catch((err) => log.warn(`[${this.opts.id}] command discovery failed:`, err))
    return reload
  }

  /** The full slash surface: builtin rows, then discovered custom rows, then
   *  the current skill view's rows — deduped by lowercased name so a command
   *  wins a same-name skill and a builtin wins a same-name custom file.
   *  Display names stay as authored; only the dedupe key is case-folded. */
  private commandCatalog(custom: readonly NativeCommand[], skillCommands: readonly NativeSkillCommand[]): NativeSkillCommand[] {
    const out: NativeSkillCommand[] = []
    const seen = new Set<string>()
    const push = (row: NativeSkillCommand): void => {
      const key = row.name.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push(row)
    }
    for (const cmd of BUILTIN_COMMANDS) {
      push({ name: cmd.name, description: cmd.description, argumentHint: cmd.argumentHint, builtin: true })
    }
    for (const cmd of custom) {
      push({ name: cmd.name, description: cmd.description, argumentHint: cmd.argumentHint })
    }
    for (const row of skillCommands) push(row)
    return out
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
    // call, and a subagent could never load a skill. The plan tools ride every
    // list too (main AND nested): a subagent inherits plan enforcement, and
    // EnterPlanMode binds to the session's host-bound entry hook so a
    // tool-driven mode change routes through the manager. Stateless, so a
    // fresh instance per rebuild is fine (the hook reads live opts at call).
    const tools: ToolDef[] = [
      ...this.opts.tools,
      this.webFetchTool,
      this.webSearchTool,
      this.todoWriteTool,
      this.agentTool,
      this.taskTool,
      this.taskOutputTool,
      skillTool,
      createEnterPlanModeTool({ enterPlanMode: () => this.enterPlanMode() }),
      createExitPlanModeTool(),
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
      // A new turn supersedes any in-flight suggestion. This covers the drain
      // path (input queued mid-turn, consumed here without a fresh enqueue) as
      // well as the ordinary next-message path; enqueue aborts too, but a fork
      // spawned after that enqueue (during turn/end finalization) is caught here.
      this.suggestionAbort?.abort()
      const pending = this.pendingDurableInitial ?? { message: this.input.shift() as RequestMessage }
      this.pendingDurableInitial = pending
      const next = pending.message
      // Fresh per-turn signal, armed BEFORE the persistence await: interrupt()
      // kills THIS turn only, and must stay responsive while the consumed
      // turn's write is in flight (the session survives for the next message).
      const turnAbort = new AbortController()
      this.turnAbort = turnAbort
      // The turn's shared stats record. The loop advances rounds/phase/usage;
      // both settlement paths read it, so an aborted turn reports what actually
      // happened (completed rounds, elapsed wall time, partial usage) instead
      // of the fabricated `0 turns / 0 ms`.
      const turnStats: TurnStats = {
        startedAt: Date.now(),
        rounds: 0,
        phase: 'streaming',
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      this.turnStats = turnStats
      // Fresh stream-packing clock per turn: a turn interrupted mid-stream
      // never persists an assistant frame, so its first-chunk time must not
      // leak into the next turn's packed records.
      this.roundFirstChunkAt = null
      const turnSignal = AbortSignal.any([this.sessionAbort.signal, turnAbort.signal])
      let endReason: NativeTurnEndReason = 'error'
      // Only a completed turn carries this turn's usage. An interrupted /
      // errored turn has no usage of its own — stamping the PREVIOUS turn's
      // `lastUsage` here would make `restoreUsage` sum it again after restart.
      let endUsage: Usage | undefined
      let initialMessages: RequestMessage[] = []
      let appendedInitialMessages: RequestMessage[] = []
      let initialMessagesOwned = false
      let rawAppended = false
      let pauseForDurableRetry = false
      let pauseEnqueueGeneration = 0
      // The success-path TurnResult; stays null on the catch path (interrupt /
      // API error) so the suggestion gate reads it as last_response_error.
      let turnResult: TurnResult | null = null
      try {
        // Capture every persona-controlled execution field at one boundary.
        // Discovery/flush/MCP awaits below must not let a live control switch
        // replace only part of this turn's configuration.
        const turnProfile = this.currentProfile
        const turnSkillPolicy = turnProfile?.skills ?? this.baseSkillPolicy
        const turnBaseToolProfile = this.baseToolProfile
        const turnModel = this.model
        // The turn's permission-mode snapshot. A plan-involved mid-turn
        // transition refreshes `turnMode.mode` in place (setPermissionMode), so
        // the loop below reads the current value on every tool call.
        const turnMode = { mode: this.permissionMode }
        this.activeTurnMode = turnMode
        const turnEffortLevel = this.effortLevel
        let turnSkillView: NativeSkillInvocationView | undefined
        let invocation: { name: string; body: string } | null = null
        let compactControl = false
        let catalogError: unknown
        try {
          // Catalog discovery is awaited per turn, not at spawn: a slow disk
          // never delays session creation, and the ready promises track the
          // LATEST reload pass, so a manual reload supersedes the construction
          // snapshot.
          await this.skillsReady
          await this.commandsReady
          // Freeze the freshly discovered caches BEFORE resolving the invocation.
          // Invocation, available_skills and the Skill tool now share one view.
          turnSkillView = this.skills.snapshot(turnSkillPolicy)
          // Interception order contract: a control-action interception belongs
          // ahead of prompt expansion — `/compact` routes to the host
          // compaction callback and never reaches the catalog (its builtin
          // row is bodyless). Command expansion precedes skill matching (a
          // command wins a same-name collision); an unknown name matches
          // neither and passes through as ordinary text. The command list is
          // captured once so a later reload cannot mix into this turn.
          compactControl = isCompactControlInvocation(next.content)
          if (!compactControl) {
            const turnCommands = [...BUILTIN_COMMANDS, ...this.customCommands]
            invocation = commandInvocationForTurn(next.content, turnCommands)
              ?? skillInvocationForTurn(next.content, turnSkillView)
          }
        } catch (err) {
          catalogError = err
        }

        // Persist the raw prompt before consumption is acknowledged. A v1 log
        // upgrades before its first structured occurrence; a failed migration
        // or raw append leaves `pendingDurableInitial` withdrawable and pauses
        // the FIFO so later input cannot overtake it.
        const timestamp = new Date(this.receivedAt.get(next.id!)!).toISOString()
        if (!pending.persisted) {
          // The neutral user content blocks are SDK-compatible (text / image /
          // structured file with the full resolved attachment); the v1/v2 log
          // stores them verbatim. PDF model forms are assigned once here at the
          // transactional budget boundary (T11 owns the neutral v3 form).
          const normalized = { role: 'user' as const, content: next.content as unknown[] }
          const assigned = assignPdfModelForms(
            normalized.content,
            this.pdfBudgets,
            this.opts.ports.config.nativeAttachmentFidelity && this.opts.ports.config.nativePdfDocuments,
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
        // The persisted content is already neutral (adapter-projected input,
        // PDF model forms assigned); wrap it as an identified user message for
        // the turn loop — no SDK→neutral bridge (T13).
        initialMessages = [createUserMessage({ content: persisted.content as ContentBlock[], source: { kind: 'user' } })]
        this.log.append({
          type: 'user/message',
          time: Date.parse(timestamp),
          parentToolUseId: null,
          data: {
            role: 'user',
            id: brandString<'MessageId'>(next.id!),
            content: persisted.content as ContentBlock[],
            source: { kind: 'user' },
          },
        })
        for (const reservation of pending.pdfReservations ?? []) this.pdfBudgets.confirm(reservation)
        pending.pdfReservations = []
        rawAppended = true
        this.syncAttachmentReferences()
        this.onUserMessagePersistence?.(next, 'appended')
        appendedInitialMessages = [...initialMessages]
        if (invocation) {
          // The dual-event model for BOTH skill and command expansion: the raw
          // typed turn above plus this hidden instruction. `session/skill` is
          // the durable "instruction paired with the preceding raw user turn"
          // event — replay inserts the stored body verbatim, fork cuts extend
          // over the pair, and compaction preserves it, all without consulting
          // the current catalogs. Command invocations ride the same shape.
          const instruction = createUserMessage({ content: [{ type: 'text', text: invocation.body }], source: { kind: 'user' } })
          initialMessages.push(instruction)
          this.log.append({
            type: 'session/skill',
            time: Date.parse(timestamp),
            data: { name: invocation.name, body: invocation.body, timestamp },
          })
          appendedInitialMessages.push(instruction)
        }
        this.pendingDurableInitial = null
        this.onUserMessageConsumed?.(next)
        // Terminal: the durable timestamp is written and the consume ack fired,
        // so the arrival entry is dead. Delete it here (drainQueued deletes its
        // own) or the strong Map grows one entry per turn for the session
        // lifetime — the legacy WeakMap<AgentUserMessage> released on GC.
        this.receivedAt.delete(next.id!)
        // The prompt is now durable in the writer's event stream, so steering
        // admission may open. It closes when the manager settles the turn.
        this.steeringOpen = true
        await this.log.flush()
        if (catalogError !== undefined) throw catalogError
        if (compactControl) {
          // Control turn: no model round for the literal text. Request the
          // host's in-place compaction BEFORE the terminal result so the
          // manager's request flag is set before the pump settles this turn;
          // the flow itself runs at the settle trigger point, where the
          // session reads idle (compactInPlace refuses an in-flight turn or
          // queued input). The result carries text so the pump classifies a
          // REAL turn settlement — an empty bookend would skip queued-input
          // materialization and strand a prompt queued behind this one.
          await this.opts.requestCompact?.()
          // A Stop can land while the host callback is in flight. Throw into
          // the shared catch so the control turn settles as the interrupted
          // turn it is (one terminal frame), never as a completed one.
          if (turnAbort.signal.aborted) throw new Error('interrupted by user')
          this.output.push({
            type: 'result',
            sessionId: this.opts.id,
            uuid: this.ctx.uuid(),
            parentToolUseId: this.ctx.parentToolUseId ?? null,
            result: 'Compaction requested.',
            usage: neutralUsageOf({ input_tokens: 0, output_tokens: 0 }),
            numTurns: turnStats.rounds,
            durationMs: Date.now() - turnStats.startedAt,
            isError: false,
            reason: 'completed',
            fastMode: this.fastMode,
          })
          endReason = 'completed'
        } else {
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
              stream: (req) => {
                // Main-thread rounds only: nested runners call streamFor through
                // their own deps and never pass here. Last round wins.
                this.suggestionSnapshot = {
                  at: Date.now(),
                  model: req.model,
                  system: req.system,
                  tools: req.tools,
                  messages: req.messages,
                }
                // Plan guidance is appended PER ROUND from the LIVE mode, not
                // baked into turnSystem: a mid-turn EnterPlanMode adds it to the
                // very next round and an ExitPlanMode approval removes it. The
                // snapshot above keeps the base system (the suggestion fork is
                // suppressed in plan mode, so it never replays this prefix).
                const system = this.permissionMode === 'plan'
                  ? `${req.system}\n\n${PLAN_MODE_GUIDANCE}`
                  : req.system
                return this.streamFor({ ...req, system }, { effortLevel: () => turnEffortLevel })
              },
              tools: [...turnTools],
              maxTurns: turnProfile?.maxTurns,
              turnStats,
              tasks: this.tasks,
              cwd: this.opts.cwd,
              requestPermission: (toolName, input, toolUseId, signal, readOnlyHint) =>
                this.requestPermission(toolName, input, toolUseId, signal, turnMode.mode, readOnlyHint),
              emit: (frame) => {
                const parent = this.ctx.parentToolUseId ?? null
                this.persistFrame(frame, parent)
                this.emitFrame(frame, parent)
              },
              persistToolResult: (result) => this.persistToolResult(result, null),
              attachmentProjection: {
                attachmentPort: this.opts.uploadStore ? this.opts.ports.attachment : undefined,
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
          this.lastUsage = sdkUsageOf(res.usage)
          endReason = res.isError ? 'error' : 'completed'
          if (!res.isError) endUsage = sdkUsageOf(res.usage)
          turnResult = res
        }
      } catch (err) {
        // A withdrawn parked head (pendingDurableInitial !== pending) already
        // received its terminal 'failed' outcome from drainQueued (the T7
        // pairing fix fires it for EVERY drained entry), so the catch must not
        // fire a second one. A pre-append failure that was NOT withdrawn stays
        // leased while the same pending prompt can be retried.
        // A pre-append failure owns no canonical history and keeps the pending
        // prompt at the FIFO head. Once raw append succeeds, later failures
        // restore exactly the appended prefix (raw plus any appended skill),
        // unless runTurn already took ownership of that same prefix.
        if (!initialMessagesOwned) this.history.push(...appendedInitialMessages)
        if (!rawAppended && this.pendingDurableInitial === pending) {
          pauseForDurableRetry = true
          pauseEnqueueGeneration = this.enqueueGeneration
          // Arm the pause signal before the error result frame is pushed below,
          // so a retry send dispatched while turn/end finalization is still in
          // flight already reads the pause and takes the synchronous path.
          this.durableRetryPaused = true
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
        this.output.push({
          type: 'result',
          sessionId: this.opts.id,
          uuid: this.ctx.uuid(),
          parentToolUseId: this.ctx.parentToolUseId ?? null,
          result: interrupted ? 'interrupted by user' : err instanceof Error ? err.message : String(err),
          // The interrupted turn's OWN completed-round usage — never the
          // previous turn's `lastUsage` (the turn/end accounting above already
          // documents why a failed turn must not inherit it). Zero before the
          // first round completes.
          usage: turnStats.usage,
          numTurns: turnStats.rounds,
          durationMs: Date.now() - turnStats.startedAt,
          isError: true,
          reason: interrupted ? 'interrupted' : 'error',
          // Stamped by interrupt(): the abort exception often surfaces in the
          // NEXT round, after the loop's live phase flipped back to streaming.
          ...(interrupted ? { abortPhase: turnStats.abortPhase ?? turnStats.phase } : {}),
          fastMode: this.fastMode,
        })
        endReason = interrupted ? 'interrupted' : 'error'
      } finally {
        this.preparedPdfs.clearHistory('main')
        this.turnAbort = null
        this.turnStats = null
        this.activeTurnMode = null
      }
      // Exactly one turn/end per turn, OUTSIDE the turn try/catch: a flush
      // failure here must log rather than land in the catch above, which
      // would emit a second terminal result and a second turn/end.
      try {
        const turnEnd = {
          type: 'turn/end' as const,
          time: 0,
          data: {
            reason: endReason,
            ...(endUsage ? { usage: neutralUsageOf(endUsage) } : {}),
          },
        }
        this.log.append(turnEnd)
        await this.log.flush()
      } catch (err) {
        log.warn(`[${this.opts.id}] failed to persist turn/end:`, err)
      }
      // Turn-end prompt suggestion: fire-and-forget AFTER the terminal result
      // and turn/end persistence. The gate reads turnResult (null on the catch
      // path → last_response_error); a spawned fork never blocks the next turn.
      void this.maybeSuggestPrompt(turnResult)
      // Park even when later input is already queued. Only an enqueue observed
      // after this failure (including during turn/end finalization) releases
      // the pause, exactly once; older queued input cannot drive a retry loop.
      if (pauseForDurableRetry && this.enqueueGeneration === pauseEnqueueGeneration) break
    }
  }

  enqueue(message: RequestMessage): void {
    if (this._closed) return
    // New user input supersedes any in-flight suggestion (CLI onCommand).
    this.suggestionAbort?.abort()
    // A direct enqueue is exactly what releases a durable-retry pause: the pump
    // loop (re)starts and retries the parked head prompt before this message.
    this.durableRetryPaused = false
    // Arrival time only — the message is not part of the conversation until
    // the pump consumes it (see pumpLoop). Keyed by the neutral message id (the
    // host uuid for adapter-projected input); the host adapter re-keys the HOST
    // receivedAt separately for the lease-callback projections.
    this.receivedAt.set(message.id!, Date.now())
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
  enqueueControl(message: RequestMessage): void {
    // The compact seed is a durable conversation message even though it never
    // starts a turn: persist it, then make it visible to the next request.
    const timestamp = new Date().toISOString()
    this.log.append({
      type: 'user/message',
      time: Date.parse(timestamp),
      parentToolUseId: null,
      data: {
        role: 'user',
        id: brandString<'MessageId'>(message.id!),
        content: message.content,
        source: { kind: 'user' },
        isCompactSummary: true,
      },
    })
    this.syncAttachmentReferences()
    flushInBackground(this.log, this.opts.id, 'compact summary')
    this.history.push(createUserMessage({ content: message.content, source: { kind: 'user' } }))
  }

  getAttachmentOccurrences(): readonly NativeAttachmentOccurrence[] {
    const occurrences: NativeAttachmentOccurrence[] = []
    for (const occurrence of neutralFileOccurrences(neutralEventsOf(this.log))) {
      // Catalog entries (session/attachments) carry no message identity — the
      // legacy scan walked only user events, so they never became occurrences.
      if (occurrence.messageUuid === '') continue
      // The helper emits the HOST SDK-transcript coordinates: a direct user file
      // at [i], a tool/result inner file at [0, inner] (the legacy projection
      // wraps tool/result content in ONE tool_result block at outer index 0).
      // compact-attachments hydrates by joining these on uuid + blockPath.
      occurrences.push({
        messageUuid: occurrence.messageUuid,
        blockPath: occurrence.blockPath,
        attachment: occurrence.attachment,
      })
    }
    return occurrences
  }

  getAttachmentCatalog(): readonly NativeFileAttachment[] {
    const seen = new Set<string>()
    const catalog: NativeFileAttachment[] = []
    // Full-log neutral scan (direct user + tool/result inner + the hidden
    // session/attachments handoff catalogs), deduped by id+digest in log order —
    // the manual replacement copies every referenced attachment so AttachmentRead
    // stays authorized in the handoff log.
    for (const { attachment } of neutralFileOccurrences(neutralEventsOf(this.log))) {
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
        time: Date.parse(opts.timestamp),
        data: {
          attachments: opts.attachments.map((attachment) => ({ ...attachment })),
          timestamp: opts.timestamp,
        },
      })
    }
    this.log.append({
      type: 'user/message',
      time: Date.parse(opts.timestamp),
      parentToolUseId: null,
      data: {
        role: 'user',
        id: brandString<'MessageId'>(opts.uuid),
        content: [{ type: 'text', text: summary }],
        source: { kind: 'user' },
        isCompactSummary: true,
      },
    })
    await this.log.flush()
    this.syncAttachmentReferences()
    this.history.push(createUserMessage({ content: [{ type: 'text', text: summary }], source: { kind: 'user' } }))
  }

  /** Compaction-only projection of the durable raw-user → instruction pairs.
   *  Adjacency is the pairing contract: a raw-only crash prefix or an unrelated
   *  later skill event must never synthesize an invocation. */
  getSkillCompactionEntries(): readonly { afterUserUuid: string; body: string }[] {
    const events = neutralEventsOf(this.log)
    const entries: Array<{ afterUserUuid: string; body: string }> = []
    for (let index = 0; index < events.length - 1; index++) {
      const user = events[index]
      const skill = events[index + 1]
      if (user.type === 'user/message' && user.parentToolUseId === null && skill.type === 'session/skill') {
        entries.push({ afterUserUuid: user.data.id, body: skill.data.body })
      }
    }
    return entries
  }

  /** Authoritative neutral model history for the host's compaction input: the
   *  uncapped replay, floored at the last compact, sidechain excluded. The host
   *  adapter owns the SDK projection + floor-summary identity recovery; the
   *  core returns only neutral messages (no SDK import). */
  getCompactionHistory(): RequestMessage[] {
    return historyFromEvents(neutralEventsOf(this.log))
  }

  /** The last compact boundary's neutral facts (summary text + context
   *  snapshot), or null when the log has none. Reverse scan mirrors replay's
   *  `lastCompactIndex` floor (ES2022 — no Array.findLastIndex). */
  getCompactionBoundary(): { text: string; context: string } | null {
    const events = neutralEventsOf(this.log)
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'session/compact') {
        return { text: event.data.text, context: event.data.context }
      }
    }
    return null
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
  async compactInPlace(summary: string, opts: { uuid: string; timestamp: string; summaryUuid?: string }): Promise<void> {
    if (this._closed) throw new Error('session is closed')
    if (this.turnAbort !== null) throw new Error('a turn is in flight')
    if (this.queueDepth > 0) throw new Error('input is queued')
    // An empty summary would persist a `session/compact` line the parser
    // rejects as corrupt (it requires a non-empty `text`), bricking resume.
    if (!summary.trim()) throw new Error('empty summary')
    const context = contextSnapshot(this.opts.cwd)
    this.log.append({
      type: 'session/compact',
      time: Date.parse(opts.timestamp),
      data: {
        text: summary, context, uuid: opts.uuid, timestamp: opts.timestamp,
        // retainHistory keeps the pre-compact transcript visible above this
        // boundary while the model history still floors here; summaryUuid is
        // the summary frame's durable identity so disk replay and the live
        // frame agree (no duplicate card on restart).
        retainHistory: true,
        ...(opts.summaryUuid ? { summaryUuid: opts.summaryUuid } : {}),
      },
    })
    await this.log.flush()
    this.pdfBudgets.rebuildFromEvents(neutralEventsOf(this.log))
    // History is a readonly array mutated in place; splice keeps every holder
    // of the reference (the pump loop) looking at the compacted conversation.
    this.history.splice(
      0,
      this.history.length,
      createUserMessage({ content: [{ type: 'text', text: context }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: summary }], source: { kind: 'user' } }),
    )
    this.lastUsage = { input_tokens: 0, output_tokens: 0 }
  }

  clearQueued(): number {
    return this.drainQueued('withdrawal').length
  }

  drainQueued(mode: NativeDrainMode = 'withdrawal'): RequestMessage[] {
    const pending = this.pendingDurableInitial
    for (const reservation of pending?.pdfReservations ?? []) this.pdfBudgets.release(reservation)
    this.pendingDurableInitial = null
    // Withdrawing the parked head prompt ends any durable-retry pause.
    this.durableRetryPaused = false
    const drained = [...(pending ? [pending.message] : []), ...this.input.splice(0)]
    // T7 pairing fix / Q1: a WITHDRAWAL drain abandons the prompts, so fire a
    // terminal 'failed' outcome per entry — the adapter releases the host↔neutral
    // pairing AND the host lease callback releases the manager's send lease. A
    // TRANSFER drain (respawnInPlace moving prompts to a fresh handle) fires NO
    // outcome: the adapter releases the pairing silently and the send lease is
    // PRESERVED across the re-enqueue (which never re-acquires it). Either way
    // THIS handle's pairing ends; the pump catch no longer fires 'failed' for a
    // withdrawn parked head — the withdrawal drain is its single terminal point.
    for (const msg of drained) {
      this.receivedAt.delete(msg.id!)
      if (mode === 'withdrawal') this.onUserMessagePersistence?.(msg, 'failed')
    }
    return drained
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
        time: Date.parse(timestamp),
        data: { uuid: entry.uuid, text: entry.text, timestamp },
      })
    }
    await this.log.flush()
    // An entry a concurrent drain removed meanwhile (interrupt) is the
    // manager's to requeue — do not inject or report it again.
    const retained = wrapped.filter((_entry, index) => this.supplementQueue.includes(batch[index]))
    this.supplementQueue = this.supplementQueue.filter((entry) => !batch.includes(entry))
    for (const entry of retained) {
      this.onSupplementDelivered?.(entry.uuid, { ok: true, boundary: 'PreToolUse' })
    }
    return retained
  }

  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    return toolUseId === undefined ? this.tasks.background() : this.tasks.background(toolUseId)
  }

  async stopTask(taskId: string): Promise<void> {
    return this.tasks.stop(taskId)
  }

  async interrupt(opts?: { cancelQueued?: boolean }): Promise<NativeInterruptReceipt | void> {
    // A plain interrupt stops the current turn but leaves queued user turns
    // for the next one — the manager's contract (and claude's Query.interrupt
    // behavior). Only `cancelQueued` drops them; the manager has already
    // drained its host queue (leg 1) and will broadcast the withdrawal. This
    // drain catches anything enqueued since leg 1 (leg 2): drainQueued fires a
    // terminal 'failed' per entry (releasing the adapter pairing) and the
    // receipt lists the cancelled neutral ids (=== host uuids) for the
    // manager's withdrawal accounting.
    // An interrupt also discards any in-flight suggestion (CLI contract).
    this.suggestionAbort?.abort()
    let cancelledQueued: string[] | undefined
    if (opts?.cancelQueued) {
      cancelledQueued = this.drainQueued().map((msg) => msg.id!)
    }
    // NO frame emission here — the pumpLoop catch emits the single
    // 'interrupted by user' result frame.
    // Stamp the phase the user stopped IN. The abort exception usually
    // surfaces in the NEXT round (already back to 'streaming'), so the
    // settlement must not re-read the live phase.
    if (this.turnStats) this.turnStats.abortPhase = this.turnStats.phase
    this.turnAbort?.abort(new Error('interrupted by user'))
    return cancelledQueued !== undefined ? { cancelledQueued } : undefined
  }

  async setModel(model?: string): Promise<void> {
    if (!model) return
    await this.updateAgentBase({ model })
  }

  /** Plan-mode entry signal: route the mode change through the host-bound
   *  callback so the manager's live permissionMode (the broker plan gate + UI
   *  chip) and this handle's mode (persistence + per-round guidance) update
   *  together. The EnterPlanMode tool deps bind to this hook; a session with no
   *  host callback (bare unit core) is a no-op. The mode string stays neutral —
   *  the host owns the permission-mode vocabulary. */
  async enterPlanMode(): Promise<void> {
    await this.opts.requestPermissionModeChange?.('plan')
  }

  async setPermissionMode(mode: string): Promise<void> {
    const previousEffective = this.permissionMode
    try {
      await this.updateAgentBase({ permissionMode: mode })
    } catch (err) {
      // The manager's permission contract is local enforcement even when the
      // provider write fails. Apply ONLY the requested base locally, then
      // rethrow so the manager resynchronizes the ACTUAL next-turn effective
      // mode (requested base without a persona override, persona otherwise).
      this.basePermissionMode = mode
      this.applyEffectiveProfile()
      this.refreshActiveTurnModeOnPlanTransition(previousEffective)
      throw err
    }
    this.refreshActiveTurnModeOnPlanTransition(previousEffective)
  }

  /** Spec G1 "Mid-turn transitions": a PLAN-involved mode change (entry to plan
   *  via EnterPlanMode, or exit from plan via an approved ExitPlanMode) must bind
   *  the very next tool call of the CURRENT turn — not just the next turn — so an
   *  approved plan lets acceptEdits/bypass auto-allow the following edits in the
   *  SAME turn (CLI approve→execute parity). Non-plan mid-turn switches keep the
   *  turn-start snapshot (next-turn behavior). The broker plan gate already reads
   *  the manager's live mode; this refreshes the per-call snapshot the
   *  acceptEdits/bypass branches read. Model/effort/skill snapshots are untouched. */
  private refreshActiveTurnModeOnPlanTransition(previousEffective: string): void {
    const holder = this.activeTurnMode
    if (!holder) return
    if (previousEffective === 'plan' || this.permissionMode === 'plan') {
      holder.mode = this.permissionMode
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
   *  maxTokens, model, autoCompactThreshold }. Capacity is resolved for the
   *  captured route and retried when an actual effective-model change lands. */
  async getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<unknown> {
    // Match the pump's mid-turn formula: prompt tokens = input + cache reads
    // + cache writes. Output is not part of the window the next request sends.
    for (;;) {
      const generation = this.modelGeneration
      const model = this.model
      const contextWindow = this.opts.modelContext
        ? (await this.opts.modelContext.resolve({
            profile: this.profile,
            providerId: this.profile.id,
            baseUrl: this.profile.baseUrl,
            model,
            api: 'anthropic-messages',
            credentials: this.opts.credentials,
          })).contextWindow
        : DEFAULT_CONTEXT_WINDOW
      if (generation !== this.modelGeneration) continue
      // Refresh the skill-listing cap from the resolved window. The manager
      // fires this probe after every turn, so a model down-switch shrinks the
      // cap for the next turn; the default budget holds until the first
      // resolve. Set BEFORE the composition below so the breakdown prices the
      // same budgeted section the next request will send.
      this.skills.setListingBudget(Math.floor(contextWindow * LISTING_BUDGET_FRACTION))
      const usage = this.lastUsage
      // The spawn pin is a policy ceiling clamped under the model window; the
      // ratio policy and output reserve apply to that effective window. The
      // bar denominator (maxTokens) stays the resolved model window.
      const pin = this.opts.autoCompactWindow
      const effectiveWindow = pin !== undefined && pin > 0 ? Math.min(contextWindow, pin) : contextWindow
      const outputReservedWindow = effectiveWindow - DEFAULT_MAX_TOKENS
      const totalTokens =
        usage.input_tokens
        + (usage.cache_read_input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0)
      const autoCompactThreshold = outputReservedWindow > 0
        ? Math.min(Math.floor(effectiveWindow * this.opts.ports.config.nativeAutoCompactRatio), outputReservedWindow)
        : 0
      return {
        totalTokens,
        maxTokens: contextWindow,
        model,
        autoCompactThreshold,
        // The manager's reconcile/seed probes pass { detail: 'summary' } and
        // read only the lite fields + auto-compact facts; skip the breakdown
        // so a probe never pays for a composition nobody reads.
        ...(opts?.detail === 'summary' ? {} : this.contextComposition(totalTokens, contextWindow, autoCompactThreshold)),
      }
    }
  }

  /** Heuristic composition of the next request's context, anchored to the
   *  last real usage sample: the used rows sum to `totalTokens` by
   *  construction (Messages is the residual), so the split is approximate
   *  but the total is exact. O(prompt + tools) — never walks history, which
   *  matters because the manager fires getContextUsage as a post-turn
   *  reconcile probe. Reads the EFFECTIVE tool list (`this.tools`, already
   *  persona-filtered by rebuildTools) so a restrictive persona prices only
   *  the schemas the next request injects. Non-atomic by design (DSH
   *  precedent): totalTokens describes the last request, the estimates the
   *  next one; nothing makes decisions from this table. */
  private contextComposition(
    totalTokens: number,
    maxTokens: number,
    autoCompactThreshold: number,
  ): {
    categories: Array<{ name: string; tokens: number; kind: 'used' | 'buffer' | 'free' }>
    skills?: { includedSkills: number; totalSkills: number; tokenCount: number; skillFrontmatter: Array<{ name: string; source: string; tokens: number }> }
    mcpTools?: Array<{ name: string; serverName: string; tokens: number; isLoaded: true }>
  } {
    const skillView = this.currentSkillView()
    const skillSection = skillView.section()
    const persona = this.currentProfile?.instruction
    const system = persona ? `${this.baseSystem}\n\n${persona}` : this.baseSystem
    const systemTokens = estimateText(system) + ROLE_OVERHEAD
    const skillTokens = skillSection ? estimateText(skillSection) + ROLE_OVERHEAD : 0
    const builtinTools = this.tools.filter((t) => !this.mcpToolServers.has(t.name))
    const mcpTools = this.tools.filter((t) => this.mcpToolServers.has(t.name))
    const systemToolsTokens = builtinTools.reduce((s, t) => s + estimateToolSchema(t), 0)
    // Per-FQN prices computed ONCE, shared by the MCP row and the payload.
    const mcpPrices = new Map(mcpTools.map((t) => [t.name, estimateToolSchema(t)]))
    const mcpToolsTokens = [...mcpPrices.values()].reduce((s, n) => s + n, 0)
    const estimated = systemTokens + skillTokens + systemToolsTokens + mcpToolsTokens
    const messagesTokens = totalTokens > 0
      ? Math.max(0, totalTokens - estimated)
      : this.history.reduce((s, m) => s + estimateMessage(m), 0)
    const bufferTokens = autoCompactThreshold > 0 ? maxTokens - autoCompactThreshold : 0
    const freeTokens = Math.max(0, maxTokens - totalTokens - bufferTokens)

    const categories: Array<{ name: string; tokens: number; kind: 'used' | 'buffer' | 'free' }> = [
      { name: 'System prompt', tokens: systemTokens, kind: 'used' },
      { name: 'System tools', tokens: systemToolsTokens, kind: 'used' },
      ...(mcpToolsTokens > 0 ? [{ name: 'MCP tools', tokens: mcpToolsTokens, kind: 'used' as const }] : []),
      ...(skillTokens > 0 ? [{ name: 'Skills', tokens: skillTokens, kind: 'used' as const }] : []),
      { name: 'Messages', tokens: messagesTokens, kind: 'used' },
      ...(bufferTokens > 0 ? [{ name: 'Autocompact buffer', tokens: bufferTokens, kind: 'buffer' as const }] : []),
      { name: 'Free space', tokens: freeTokens, kind: 'free' },
    ]

    const listing = skillView.listing()
    const skills = listing.total > 0
      ? {
          includedSkills: listing.listed.length,
          totalSkills: listing.total,
          tokenCount: skillTokens,
          skillFrontmatter: listing.listed.map((s) => ({ name: s.name, source: s.source, tokens: estimateText(s.line) })),
        }
      : undefined

    const mcpPayload = (this.mcp?.tools() ?? [])
      .filter((info) => mcpPrices.has(info.fqn))
      .map((info) => ({ name: info.name, serverName: info.server, tokens: mcpPrices.get(info.fqn)!, isLoaded: true as const }))

    return {
      categories,
      ...(skills ? { skills } : {}),
      ...(mcpPayload.length > 0 ? { mcpTools: mcpPayload } : {}),
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

  /** The `/` command catalog: builtin prompt commands, discovered custom
   *  commands, and every user-invocable skill of the current catalog (deduped
   *  by name, command wins). Awaits the CURRENT discovery passes so an
   *  immediate `/commands` fetch after spawn cannot race them into an empty
   *  answer. */
  async supportedCommands(): Promise<unknown> {
    await this.skillsReady
    await this.commandsReady
    return this.commandCatalog(this.customCommands, this.currentSkillView().commands())
  }

  /** Auto-title through the injected auxiliary LLM port. The model is
   *  resolved at CALL time: the profile's recapModel when set, else the
   *  session's CURRENT model (a live switch must reach this call). The
   *  manager trims and persists the returned first text block.
   *
   *  Claude `persist:true` parity: the trimmed title is also appended as a
   *  durable `session/title` event through the live writer BEFORE returning,
   *  so an auto-titled session recovers with its title. The log-level
   *  no-overwrite guard skips the append when any title event already exists
   *  (a manual rename that landed first); a manual rename landing after wins
   *  latest-wins. A failed append propagates — the manager's timeSdkControl
   *  surfaces it and leaves the session untitled. */
  async generateTitle(description: string): Promise<unknown> {
    const raw = await this.opts.ports.auxLlm.call({
      model: this.opts.profile?.recapModel || this.model,
      system: TITLE_PROMPT,
      userContent: description,
      // Reasoning models emit a thinking preamble BEFORE the title text; a
      // 64-token cap was consumed entirely by thinking (thinking-only content,
      // stop_reason max_tokens → "Empty response"), leaving the session
      // permanently untitled. 1024 matches the other aux callers — a cap, not
      // a reservation, so a plain title still costs only its actual tokens.
      maxTokens: 1024,
      temperature: 0.3,
      caller: 'session-title',
      target: this.opts.credentials(),
    })
    // The trim mirrors the manager's own normalization; the scan is per-call
    // (auto-title runs once per session) — no cached state.
    const text = String(raw ?? '').trim()
    if (text && !neutralEventsOf(this.log).some((e) => e.type === 'session/title')) {
      await this.log.appendDurable({ type: 'session/title', time: Date.now(), data: { title: text } })
    }
    return raw
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
   *  ports.config.modelList`) and the capabilities come from the SAME model-id
   *  classification the request builder gates effort/fast mode on — the
   *  picker and the wire can therefore never disagree about a model. */
  async supportedModels(): Promise<unknown> {
    return (this.opts.profile?.modelList ?? this.opts.ports.config.modelList).map((value) => {
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

  /** Re-read the skill AND command roots and answer the fresh merged catalog.
   *  The new discoveries replace `skillsReady` / `commandsReady`, so every
   *  per-turn await from here on tracks THIS pass — a manual reload both
   *  supersedes the construction snapshot and recovers the session from a
   *  failed one. The `skills` key is the manager's broadcast contract: it
   *  relays the array as `commands-changed`, so it carries the FULL slash
   *  surface (builtin + custom + skill rows), not skill rows alone. */
  async reloadSkills(): Promise<unknown> {
    this.skillsReady = this.startSkillReload()
    this.commandsReady = this.startCommandReload()
    await this.skillsReady
    await this.commandsReady
    return { skills: this.commandCatalog(this.customCommands, this.currentSkillView().commands()) }
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

  // ── MCP control (optional NativeSessionCore members) ───────────────────

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
    this.opts.readState.clear()
    this.sessionAbort.abort(new Error('destroyed'))
    // Turn-end suggestion: abort the in-flight fork, then give it a bounded
    // window to settle before teardown ends the output stream and closes the
    // log (CLI cH equivalent, ≤30s). The cap timer is unref'd so a wedged fork
    // can never keep the process alive; the fork's own catch settles it on abort.
    this.suggestionAbort?.abort()
    const suggestionSettle = this.suggestionInFlight
    if (suggestionSettle) {
      let timer: NodeJS.Timeout | undefined
      const cap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 30_000)
        timer.unref()
      })
      try {
        await Promise.race([suggestionSettle, cap])
      } finally {
        clearTimeout(timer)
      }
    }
    // Crash recovery transfers pending input to respawnInPlace; keep its FIFO
    // and leases while the _closed checks above stop the old pump. Every other
    // teardown withdraws that input before releasing its lease.
    if (reason !== 'crash-recovery') this.drainQueued()
    // Abort first, then close: closeAll aborts every record synchronously, so
    // a hung handshake / in-flight call cannot hold teardown open. Idempotent.
    await this.mcp?.closeAll()
    await this.tasks.destroy()
    this.output.end()
    await this.log.close()
  }
}
