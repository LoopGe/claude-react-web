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
import type { AgentMessage, AgentUserMessage } from '../../agent-message.js'
import type { ProviderInterruptReceipt, ProviderSessionHandle } from '../types.js'
import { runTurn, type LoopDeps } from './loop.js'
import { streamAnthropicMessages } from './anthropic-stream.js'
import type { CanonicalEvent } from './canonical.js'
import { apiRetryFrame, defaultFrameContext, resultFrame, type Frame, type FrameContext, type Usage } from './frames.js'
import { NativeSessionLog, loadNativeSessionLogSync } from './session-log/log.js'
import { buildForkSeed } from './session-log/fork.js'
import { contextSnapshot, historyFromEvents, repairInterruptedTurn } from './session-log/replay.js'
import { NativeSessionStorageError } from './session-log/errors.js'
import { nativeSessionLogPath } from './session-log/paths.js'
import type { NativeLogEvent, NativeTurnEndReason } from './session-log/format.js'
import { mcpToolDefs } from './mcp/tools.js'
import type { NativeMcpConnections } from './mcp/connections.js'
import type { ToolDef } from './tools/types.js'
import { createAgentTool } from './subagent.js'
import { NativeSkillCatalog } from './skills.js'
import { createSkillTool } from './tools/skill.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'

const log = createLogger('native')

const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_MAX_TOKENS = 16384
const CONTEXT_WINDOW = 200_000

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

/** `/name args` — the composer's slash-command shape for a user-invoked skill.
 *  The name grammar mirrors the CLI's skill-name rule. */
const SKILL_COMMAND_RE = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\s+([\s\S]*))?$/

/** Resolve one text block against the catalog: a `/name args` invocation of a
 *  skill the user may invoke becomes that skill's body plus the arguments;
 *  anything else (not a command, an unknown skill, an `off` skill) is returned
 *  unchanged. */
function expandSkillText(text: string, skills: NativeSkillCatalog): string {
  const match = SKILL_COMMAND_RE.exec(text)
  if (!match) return text
  const skill = skills.expand(match[1])
  if (!skill) return text
  const args = match[2]
  return args ? `${skill.body}\n\n${args}` : skill.body
}

/** The model-facing content of one user turn. For block content every non-text
 *  block (image / file) is preserved untouched: only the FIRST text block is
 *  considered, because that is where the slash command rides. */
function expandSkillTurn(content: unknown, skills: NativeSkillCatalog): unknown {
  if (typeof content === 'string') return expandSkillText(content, skills)
  if (!Array.isArray(content)) return content
  const index = content.findIndex(
    (block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text',
  )
  if (index === -1) return content
  const block = content[index] as { type: 'text'; text?: unknown } & Record<string, unknown>
  if (typeof block.text !== 'string') return content
  const expandedText = expandSkillText(block.text, skills)
  if (expandedText === block.text) return content
  const expanded = content.slice()
  expanded[index] = { ...block, text: expandedText }
  return expanded
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
  /** Resume this session's own log (non-fork), or the source log id for a fork. */
  resume?: string
  /** Fork from `resume`'s log into `id` instead of resuming it. */
  forkSession?: boolean
  /** Fork cut point: the assistant message uuid to keep, inclusive. */
  resumeSessionAt?: string
  model?: string
  permissionMode?: string
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
  system: string
  /** The prompt a nested (Agent) run gets: the parent system WITHOUT the
   *  `tool:Agent` section, since nested tools exclude Agent and a subagent
   *  told to delegate would look for a tool it cannot see. Defaults to
   *  `system`. */
  subagentSystem?: string
  /** Loose canUseTool from CreateSessionOptions — (toolName, input, {signal}) => PermissionResult. */
  canUseTool?: (...args: unknown[]) => Promise<unknown>
  /** Manager-injected consumed stamp (CreateSessionOptions.onUserMessageConsumed):
   *  called when a queued message is dequeued for a turn — without it the
   *  client's send bubble stays 'queued' forever. */
  onUserMessageConsumed?: (message: AgentUserMessage) => void
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
  /** Builtins plus the MCP tools discovered as of the last rebuild. Replaced
   *  (never mutated) so a mid-turn `setServers`/toggle only affects the NEXT
   *  turn: the running turn holds the snapshot its `runTurn` started with. */
  private tools: ToolDef[]
  /** The Agent tool this session hands the model. Built once (not per turn) so
   *  its live getters keep tracking `model` and the rebuilt `tools` list; it
   *  is appended in `rebuildTools` alongside the builtins. */
  private readonly agentTool: ToolDef
  /** Local SKILL.md catalog. Discovery is kicked off at construction and
   *  awaited per turn, the same shape as MCP's `whenReady`. */
  private readonly skills: NativeSkillCatalog
  /** The Skill tool this session hands the model. Built once; it rides every
   *  tool list (nested ones too — a subagent may load a skill) and its
   *  guidance is the provider's static prompt section. */
  private readonly skillTool: ToolDef
  /** The CURRENT discovery/reload in flight. Re-assigned by `reloadSkills`, so
   *  a manual reload supersedes the construction one (and can recover from a
   *  transient construction failure) for every per-turn await. */
  private skillsReady: Promise<void>
  /** Model-facing tool name → owning server, for the permission request's
   *  `mcpServer` field. Built from discovery metadata, never by parsing the
   *  FQN (it may be truncated and hashed). */
  private readonly mcpToolServers = new Map<string, { name: string; source: 'sdk' | 'dynamic' }>()
  private readonly mcp: NativeMcpConnections | undefined
  private model: string
  /** Live permission mode: setPermissionMode keeps it current for the lifetime
   *  of the session — the spawn-time opts value is only the starting point, so
   *  a bypass-spawned session can be downgraded mid-flight. */
  private permissionMode: string
  /** Synchronous pump guard: set before the async pumpLoop starts, so a
   *  second enqueueUserMessage while the first turn is still being scheduled
   *  cannot start a second concurrent pump. */
  private pumping = false
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
    this.model = opts.model ?? DEFAULT_MODEL
    this.permissionMode = opts.permissionMode ?? 'default'
    // Skills are discovered before the first turn can ask for them. The
    // policy is stored separately from discovery (the catalog resolves state
    // lazily), so configure-before/after-reload makes no difference.
    this.skills = new NativeSkillCatalog(opts.cwd)
    this.skills.configure(opts.skills)
    this.skillTool = createSkillTool(this.skills)
    this.skillsReady = this.startSkillReload()
    // Every session can delegate, MCP or not: `tools` is a live getter and the
    // `emit` path is the session's own persist+push, so a nested run's frames
    // land in the transcript with their real parent. Built after `ctx` exists.
    this.agentTool = createAgentTool({
      cwd: opts.cwd,
      model: () => this.model,
      system: () => this.subagentSystem(),
      frameCtx: this.ctx,
      tools: () => this.tools,
      streamFor: (req) => this.streamFor(req, { suppressRetryFrames: true }),
      requestPermission: this.requestPermission,
      emit: (frame) => {
        this.persistFrame(frame)
        this.output.push(frame)
      },
      agentStore: opts.agentStore,
    })
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
    // session-health's stuck-GC force-unloads sessions whose init never
    // lands — push it first, before any turn output.
    this.output.push({
      type: 'system',
      subtype: 'init',
      session_id: opts.id,
      uuid: this.ctx.uuid(),
      parent_tool_use_id: null,
    } as unknown as AgentMessage)
    // `tools` is now the effective list from birth, not builtins-only until
    // the first turn: the invariant tools = builtins + Agent + MCP defs must
    // hold for every reader, not just the pump after discovery.
    this.rebuildTools()
  }

  /** Fresh session: the log is created here, with its opening `session/context`
   *  written through the seed path so the header AND the context are durable
   *  synchronously at open (a crash before the first turn must still leave a
   *  log that carries the working directory). The context is the first model
   *  message — history-only, per the DSH design, never a frame. An existing
   *  log for this id is left untouched: `open` throws `kind: 'exists'`. */
  private openFreshLog(opts: NativeSessionOptions): NativeSessionLog {
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
      seed: { events: [context], inheritedEventCount: 0, isSeeded: false },
    })
    this.history.push(...historyFromEvents([context]))
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
    const log = NativeSessionLog.open({
      stateDir: opts.stateDir,
      id: opts.id,
      cwd: opts.cwd,
      resume: false,
      seed,
    })
    this.history.push(...historyFromEvents(seed.events))
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
    return this.input.length
  }

  get messages(): AsyncIterable<AgentMessage> {
    return this.output.iterable
  }

  get closed(): boolean {
    return this._closed
  }

  private requestPermission: LoopDeps['requestPermission'] = async (toolName, input, toolUseId, signal) => {
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
    if (this.permissionMode === 'bypassPermissions') return { allowed: true, input }
    // Fail closed: without a handler there is nothing to ask.
    if (!this.opts.canUseTool) {
      return { allowed: false, input, message: 'no permission handler registered for this session' }
    }
    const mcpServer = this.mcpToolServers.get(toolName)
    const result = (await this.opts.canUseTool(toolName, input, {
      signal,
      toolUseID: toolUseId,
      ...(mcpServer ? { mcpServer } : {}),
    })) as { behavior?: string; updatedInput?: Record<string, unknown>; message?: string }
    if (result?.behavior === 'allow') {
      return { allowed: true, input: result.updatedInput ?? input }
    }
    return { allowed: false, input, message: result?.message ?? 'permission denied' }
  }

  /** The real network streamer: Task 2's caller with retry, whose onRetry
   *  callback surfaces each backoff as an `api_retry` frame. A nested
   *  (subagent) stream sets `suppressRetryFrames`: retry behavior is
   *  unchanged, but a subagent's backoff must not look like a main-thread
   *  retry in the UI. */
  private defaultStream(
    req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal },
    opts?: { suppressRetryFrames?: boolean },
  ): AsyncIterable<CanonicalEvent> {
    return streamAnthropicMessages(
      {
        ...this.opts.credentials(),
        model: req.model,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        maxTokens: DEFAULT_MAX_TOKENS,
        signal: req.signal,
      },
      async (info) => {
        if (!opts?.suppressRetryFrames) this.output.push(apiRetryFrame(this.ctx, info))
      },
    )
  }

  private streamFor(
    req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal },
    opts?: { suppressRetryFrames?: boolean },
  ): AsyncIterable<CanonicalEvent> {
    // The test seam ignores opts: scripted streams have no retry path.
    const testStream = this.opts.streamSupplier?.()
    return testStream ? testStream(req) : this.defaultStream(req, opts)
  }

  /** Persist the durable half of the frame stream: model-visible assistant
   *  messages and tool_result user messages (main thread AND sidechain — the
   *  latter carry their spawning tool_use id, so replay can keep them out of
   *  the main history while the transcript still renders them). Everything
   *  else (stream_event, system/init, result, api_retry) is UI-only and never
   *  enters the log. Fire-and-forget — the turn-end flush is the barrier. */
  private persistFrame(frame: AgentMessage): void {
    const f = frame as Frame
    if (f.type === 'assistant') {
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
    } else if (f.type === 'user') {
      this.log.append({
        type: 'user',
        uuid: f.uuid!,
        session_id: this.opts.id,
        parent_tool_use_id: f.parent_tool_use_id ?? null,
        timestamp: new Date().toISOString(),
        message: persistedUserMessage(f.message),
      })
      flushInBackground(this.log, this.opts.id, 'tool result')
    }
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

  /** The nested (Agent) prompt: the subagent system plus the CURRENT skills
   *  section, read at call time so a reload/override reaches the next nested
   *  run. The parent system is built per turn in `pumpLoop`. */
  private subagentSystem(): string {
    return withSkillsSection(this.opts.subagentSystem ?? this.opts.system, this.skills.section())
  }

  /** Rebuild the tool list and the FQN → server map from the current
   *  connection state. Runs before every turn and after every live MCP
   *  mutation; `this.tools` is replaced (not mutated) so a running turn keeps
   *  the snapshot it was handed. */
  private rebuildTools(): void {
    this.mcpToolServers.clear()
    // The Agent and Skill tools ride EVERY list, MCP-less sessions included —
    // otherwise the model loses delegation exactly when it has no servers to
    // call, and a subagent could never load a skill.
    if (!this.mcp) {
      this.tools = [...this.opts.tools, this.agentTool, this.skillTool]
      return
    }
    const infos = this.mcp.tools()
    this.tools = [...this.opts.tools, this.agentTool, this.skillTool, ...mcpToolDefs(this.mcp)]
    const sdkServers = new Set(
      this.mcp.statuses().filter((status) => status.source === 'sdk').map((status) => status.name),
    )
    for (const info of infos) {
      this.mcpToolServers.set(info.fqn, {
        name: info.server,
        source: sdkServers.has(info.server) ? 'sdk' : 'dynamic',
      })
    }
  }

  private async pumpLoop(): Promise<void> {
    while (!this._closed && this.input.length > 0) {
      const next = this.input.shift() as AgentUserMessage
      this.opts.onUserMessageConsumed?.(next)
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
      try {
        // Skill discovery is awaited per turn, not at spawn: a slow disk never
        // delays session creation, and `skillsReady` tracks the LATEST reload
        // pass, so a manual reload supersedes the construction snapshot. It
        // precedes the user write because a `/name args` turn is persisted —
        // and sent — as the skill's expanded body.
        await this.skillsReady
        const turnContent = expandSkillTurn(next.message.content, this.skills)
        // The turn is consumed now, so it is part of the conversation: write it
        // (and wait for the write) before the model sees it. A queued turn that
        // gets drained without reaching this point is never persisted. Inside
        // the try so a rejected write is classified as this turn's failure
        // instead of rejecting the pump.
        this.log.append({
          type: 'user',
          uuid: next.uuid!,
          session_id: this.opts.id,
          parent_tool_use_id: null,
          timestamp: new Date(this.receivedAt.get(next)!).toISOString(),
          message: persistedUserMessage({ content: turnContent }),
        })
        await this.log.flush()
        // Discovery is awaited per turn, not at spawn: a slow server never
        // delays session creation, and a mid-turn replace/toggle only lands
        // on the next turn (the turn below runs on this snapshot).
        await this.mcp?.whenReady()
        this.rebuildTools()
        const res = await runTurn(
          {
            stream: (req) => this.streamFor(req),
            tools: [...this.tools],
            cwd: this.opts.cwd,
            requestPermission: this.requestPermission,
            emit: (frame) => {
              this.persistFrame(frame)
              this.output.push(frame)
            },
            system: withSkillsSection(this.opts.system, this.skills.section()),
          },
          this.ctx,
          this.history,
          { role: 'user', content: turnContent } as { role: 'user'; content: unknown[] },
          this.model,
          turnSignal,
        )
        // Success-path result frame was already emitted by runTurn; only the
        // LAST-reading accounting happens here. Per-model totals are summed
        // from the persisted assistant frames in `persistFrame`, so the live
        // value and a restart's rebuild are identical.
        this.lastUsage = res.usage
        endReason = 'completed'
        endUsage = res.usage
      } catch (err) {
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
        }))
        endReason = interrupted ? 'interrupted' : 'error'
      } finally {
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
    }
  }

  enqueueUserMessage(message: AgentUserMessage): void {
    if (this._closed) return
    // Arrival time only — the message is not part of the conversation until
    // the pump consumes it (see pumpLoop). The WeakMap keeps the provider's
    // AgentUserMessage contract untouched.
    this.receivedAt.set(message, Date.now())
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
    flushInBackground(this.log, this.opts.id, 'compact summary')
    this.history.push({ role: 'user', content: message.message.content })
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
    if (this.input.length > 0) throw new Error('input is queued')
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
    return this.input.splice(0).length
  }

  drainQueuedInput(): AgentUserMessage[] {
    return this.input.splice(0)
  }

  async interrupt(opts?: { cancelQueued?: boolean }): Promise<ProviderInterruptReceipt | void> {
    // A plain interrupt stops the current turn but leaves queued user turns
    // for the next one — the manager's contract (and claude's Query.interrupt
    // behavior). Only `cancelQueued` drops them; the manager has already
    // drained its host queue and will broadcast the withdrawal.
    if (opts?.cancelQueued) this.input.splice(0)
    // NO frame emission here — the pumpLoop catch emits the single
    // 'interrupted by user' result frame.
    this.turnAbort?.abort(new Error('interrupted by user'))
  }

  async setModel(model?: string): Promise<void> {
    if (model) this.model = model
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode
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
    return this.skills.commands()
  }

  /** Re-read the skill roots and answer the fresh command catalog. The new
   *  discovery replaces `skillsReady`, so every per-turn await from here on
   *  tracks THIS pass — a manual reload both supersedes the construction
   *  snapshot and recovers the session from a failed one. */
  async reloadSkills(): Promise<unknown> {
    this.skillsReady = this.startSkillReload()
    await this.skillsReady
    return { skills: this.skills.commands() }
  }

  /** The flag-settings layer, reduced to the ONE key this provider supports.
   *  `skillOverrides` replaces the per-skill override map (`{}` restores the
   *  spawn default). Plugin toggles must fail loudly: `supportsPlugins` is
   *  false, so silently accepting them would report a change that never
   *  happened. */
  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    const unknownKeys = Object.keys(settings).filter((key) => key !== 'skillOverrides')
    if (unknownKeys.length > 0) {
      throw new Error(`native provider does not support flag settings: ${unknownKeys.join(', ')}`)
    }
    const overrides = settings.skillOverrides
    if (overrides === undefined) return
    this.skills.applyOverrides(overrides as Record<string, 'on' | 'name-only' | 'user-invocable-only' | 'off'>)
  }

  /** Built-in agents only: the /agents route unions the enabled
   *  `AgentDefinitionStore` definitions on top (same split as claude). */
  async supportedAgents(): Promise<unknown> {
    return [{ name: 'general-purpose', description: 'General-purpose subagent for self-contained tasks.' }]
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

  async destroy(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this.sessionAbort.abort(new Error('destroyed'))
    // Abort first, then close: closeAll aborts every record synchronously, so
    // a hung handshake / in-flight call cannot hold teardown open. Idempotent.
    await this.mcp?.closeAll()
    this.output.end()
    await this.log.close()
  }
}
