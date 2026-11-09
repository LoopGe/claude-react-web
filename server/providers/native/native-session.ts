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
import type { ToolDef } from './tools/types.js'

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

/** Fire-and-forget flush: a persistence failure must never become an
 *  unhandled rejection or a second terminal frame, but it must be visible. */
function flushInBackground(sessionLog: NativeSessionLog, sessionId: string, what: string): void {
  void sessionLog.flush().catch((err) => log.warn(`[${sessionId}] failed to flush ${what}:`, err))
}

/** Narrow an assistant event's opaque `message.usage` to the counter pair the
 *  session tracks. Old / partial logs may omit it or carry another shape. */
function usageOf(value: unknown): Usage | null {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as { input_tokens?: unknown; output_tokens?: unknown }
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null
  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }
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
  tools: ToolDef[]
  system: string
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
  private totalUsage: Usage = { input_tokens: 0, output_tokens: 0 }
  private _closed = false

  constructor(private readonly opts: NativeSessionOptions) {
    // opts must be bound before these: output's label and ctx carry the id.
    this.output = createPushable<AgentMessage>(`native-session[${opts.id}]`)
    this.ctx = defaultFrameContext(opts.id)
    this.model = opts.model ?? DEFAULT_MODEL
    this.permissionMode = opts.permissionMode ?? 'default'
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

  /** Restore the usage counters from `turn/end` events. A seeded fork's
   *  `turn/end { reason: 'forked' }` carries no usage and is skipped, so it
   *  neither resets `lastUsage` nor contributes to `totalUsage`. When the log
   *  has no usage-bearing `turn/end` at all (an older / interrupted log), the
   *  last assistant usage is the fallback for `lastUsage`; `totalUsage` stays
   *  the sum of completed turns — see spec §9. */
  private restoreUsage(events: readonly NativeLogEvent[]): void {
    let last: Usage = { input_tokens: 0, output_tokens: 0 }
    let total: Usage = { input_tokens: 0, output_tokens: 0 }
    let lastAssistant: Usage | null = null
    let sawUsageEnd = false
    for (const event of events) {
      if (event.type === 'assistant') {
        lastAssistant = usageOf(event.message.usage) ?? lastAssistant
        continue
      }
      if (event.type !== 'turn/end' || !event.usage) continue
      sawUsageEnd = true
      last = { input_tokens: event.usage.input_tokens, output_tokens: event.usage.output_tokens }
      total = {
        input_tokens: total.input_tokens + event.usage.input_tokens,
        output_tokens: total.output_tokens + event.usage.output_tokens,
      }
    }
    // With no turn/end record the last assistant usage is the only durable
    // reading available for LAST usage. `totalUsage` deliberately stays the
    // sum of completed turns only: adding the fallback to the total would make
    // it drop after a restart, once a real turn/end exists to sum instead.
    if (!sawUsageEnd && lastAssistant) {
      last = { ...lastAssistant }
    }
    this.lastUsage = last
    this.totalUsage = total
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
    const result = (await this.opts.canUseTool(toolName, input, {
      signal,
      toolUseID: toolUseId,
    })) as { behavior?: string; updatedInput?: Record<string, unknown>; message?: string }
    if (result?.behavior === 'allow') {
      return { allowed: true, input: result.updatedInput ?? input }
    }
    return { allowed: false, input, message: result?.message ?? 'permission denied' }
  }

  /** The real network streamer: Task 2's caller with retry, whose onRetry
   *  callback surfaces each backoff as an `api_retry` frame. */
  private defaultStream(req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal }): AsyncIterable<CanonicalEvent> {
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
      async (info) => this.output.push(apiRetryFrame(this.ctx, info)),
    )
  }

  private streamFor(req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal }): AsyncIterable<CanonicalEvent> {
    const testStream = this.opts.streamSupplier?.()
    return testStream ? testStream(req) : this.defaultStream(req)
  }

  /** Persist the durable half of the frame stream: model-visible assistant
   *  messages and top-level tool_result user messages. Everything else
   *  (stream_event, system/init, result, api_retry) is UI-only and never
   *  enters the log. Fire-and-forget — the turn-end flush is the barrier. */
  private persistFrame(frame: AgentMessage): void {
    const f = frame as Frame
    if (f.type === 'assistant') {
      this.log.append({
        type: 'assistant',
        uuid: f.uuid!,
        session_id: this.opts.id,
        parent_tool_use_id: null,
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
    } else if (f.type === 'user' && f.parent_tool_use_id === null) {
      this.log.append({
        type: 'user',
        uuid: f.uuid!,
        session_id: this.opts.id,
        parent_tool_use_id: null,
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
    for (const event of synthetic) this.log.append(event)
    this.history.push({
      role: 'user',
      content: synthetic.flatMap((event) => event.message.content),
    })
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
          message: persistedUserMessage(next.message),
        })
        await this.log.flush()
        const res = await runTurn(
          {
            stream: (req) => this.streamFor(req),
            tools: this.opts.tools,
            cwd: this.opts.cwd,
            requestPermission: this.requestPermission,
            emit: (frame) => {
              this.persistFrame(frame)
              this.output.push(frame)
            },
            system: this.opts.system,
          },
          this.ctx,
          this.history,
          { role: 'user', content: next.message.content } as { role: 'user'; content: unknown[] },
          this.model,
          turnSignal,
        )
        // Success-path result frame was already emitted by runTurn; only the
        // usage accounting happens here.
        this.lastUsage = res.usage
        this.totalUsage = {
          input_tokens: this.totalUsage.input_tokens + res.usage.input_tokens,
          output_tokens: this.totalUsage.output_tokens + res.usage.output_tokens,
        }
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

  clearQueuedInput(): number {
    return this.input.splice(0).length
  }

  drainQueuedInput(): AgentUserMessage[] {
    return this.input.splice(0)
  }

  async interrupt(): Promise<ProviderInterruptReceipt | void> {
    // Drop queued turns (cancelQueued semantics), then abort the in-flight
    // turn. NO frame emission here — the pumpLoop catch emits the single
    // 'interrupted by user' result frame.
    this.input.splice(0)
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
    return {
      totalTokens: this.lastUsage.input_tokens + this.lastUsage.output_tokens,
      maxTokens: CONTEXT_WINDOW,
      model: this.model,
    }
  }

  async getUsage(): Promise<unknown> {
    return { last: this.lastUsage, total: this.totalUsage }
  }

  async reloadSkills(): Promise<unknown> {
    return []
  }

  abort(): void {
    this.sessionAbort.abort(new Error('aborted'))
  }

  async destroy(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this.sessionAbort.abort(new Error('destroyed'))
    this.output.end()
    await this.log.close()
  }
}
