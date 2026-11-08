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
import { apiRetryFrame, defaultFrameContext, resultFrame, type FrameContext, type Usage } from './frames.js'
import type { ToolDef } from './tools/types.js'

const log = createLogger('native')

const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_MAX_TOKENS = 16384
const CONTEXT_WINDOW = 200_000

export interface NativeSessionOptions {
  id: string
  cwd: string
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

function contextSnapshot(cwd: string): string {
  return `<system-reminder>Working directory: ${cwd}\nCurrent time: ${new Date().toISOString()}</system-reminder>`
}

export class NativeSession implements ProviderSessionHandle {
  readonly provider = 'native'

  private readonly output: Pushable<AgentMessage>
  private readonly input: AgentUserMessage[] = []
  private readonly ctx: FrameContext
  /** Session-level abort (abort()/destroy()). Never aborted by a mere interrupt. */
  private readonly sessionAbort = new AbortController()
  /** Per-turn abort, replaced by pumpLoop for every turn. */
  private turnAbort: AbortController | null = null
  /** Conversation state sent to the API on every turn (mutated in place by runTurn). */
  private readonly history: unknown[] = []
  private model: string
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
    // History-only context snapshot (user-role, per the DSH design): NEVER
    // emitted as a frame — user frames carry only tool_result content (the
    // frame contract), and the manager's echo filter would drop or double-
    // render a text user frame.
    this.history.push({ role: 'user', content: [{ type: 'text', text: contextSnapshot(opts.cwd) }] })
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

  private requestPermission: LoopDeps['requestPermission'] = async (toolName, input) => {
    if (this.opts.permissionMode === 'bypassPermissions' || !this.opts.canUseTool) {
      return { allowed: true, input }
    }
    // Only ever invoked from inside a turn, where turnAbort is live.
    const result = (await this.opts.canUseTool(toolName, input, {
      signal: AbortSignal.any([this.sessionAbort.signal, this.turnAbort!.signal]),
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

  private async pumpLoop(): Promise<void> {
    while (!this._closed && this.input.length > 0) {
      const next = this.input.shift() as AgentUserMessage
      this.opts.onUserMessageConsumed?.(next)
      // Fresh per-turn signal: interrupt() kills THIS turn only; the session
      // survives for the next message (a one-shot controller would brick it).
      const turnAbort = new AbortController()
      this.turnAbort = turnAbort
      const turnSignal = AbortSignal.any([this.sessionAbort.signal, turnAbort.signal])
      try {
        const res = await runTurn(
          {
            stream: (req) => this.streamFor(req),
            tools: this.opts.tools,
            cwd: this.opts.cwd,
            requestPermission: this.requestPermission,
            emit: (frame) => this.output.push(frame),
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
      } catch (err) {
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
      } finally {
        this.turnAbort = null
      }
    }
  }

  enqueueUserMessage(message: AgentUserMessage): void {
    if (this._closed) return
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

  async getContextUsage(): Promise<unknown> {
    const used = this.lastUsage.input_tokens + this.lastUsage.output_tokens
    return {
      ...this.lastUsage,
      context_window: CONTEXT_WINDOW,
      used_percentage: Math.min(100, (used / CONTEXT_WINDOW) * 100),
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
  }
}
