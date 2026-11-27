// server/providers/native/loop.ts
//
// The neutral turn engine (design R1/R2/R4, Task 9). runTurn folds the
// protocol-neutral CanonicalEvent stream through the shared BlockAssembler into
// neutral ContentBlocks, emits neutral live frames (AssistantFrame + the R2
// RawStreamEvent passthrough + first-class tool results + the terminal result
// OperationalFrame), and keeps the model history NEUTRAL (RequestMessage[]).
// The per-round API request is built by the wire adapter
// (projectNativeHistoryToWire); the SDK projection of the emitted frames belongs
// to the host boundary (native-session's emission wiring), never here. The loop
// core imports the neutral vocabulary + the wire/canonical boundaries, not the
// SDK frame constructors.
import {
  createAssistantMessage,
  createToolResultMessage,
  freezeMessage,
  type RequestMessage,
  type ToolResultMessage,
} from './vocabulary/message.js'
import { finishReasonOf, parseToolInput, type ContentBlock, type TokenUsage, type ToolCallBlock } from './vocabulary/types.js'
import type { StreamChunk } from './vocabulary/stream.js'
import type { NativeCoreFrame, TurnPhase } from './vocabulary/live-frame.js'
import { BlockAssembler } from './vocabulary/assembler.js'
import { brandString } from './vocabulary/brand.js'
import type { CanonicalEvent, CanonicalUsagePartial } from './canonical.js'
import { projectNativeHistoryToWire } from './wire/wire-projection.js'
import type { FrameContext } from './vocabulary/frame-context.js'
import type { NativeTaskManager } from './task-manager.js'
import type { ToolDef } from './tools/types.js'
import type { NativeProjectionOptions } from './attachment-projection.js'
import type { HookDecision, HookEvent } from './hooks/types.js'
import type { ThinkingSetting } from '../../../shared/session-info.js'
import type { RequestOutputFormat } from './anthropic-stream.js'
import { isPlainObject } from '../../../shared/type-guards.js'

/** The loop's live emission union: the core frame language plus a first-class
 *  tool result. Tool results travel as a ToolResultMessage (the host adapter's
 *  NativeHostFrame projection already handles role-'tool'); NativeCoreFrame
 *  itself stays unchanged so the adapter's exhaustive switches remain green.
 *  T10/T17 may formally fold tool results into the core emission union. */
export type NativeLoopFrame = NativeCoreFrame | ToolResultMessage

/** A persisted tool result: the durable identity plus the neutral first-class
 *  tool message (full canonical content, files included). The session projects
 *  it to the legacy log event shape until the v3 format lands (T11). */
export interface PersistedToolResult {
  uuid: string
  message: ToolResultMessage
  /** PostToolUse classifier assertion accompanying this result (RS §3). The
   *  engine merges/ties it to the rewrite; the seam preserves it on the durable
   *  record so the hook fact is not silently dropped. Native has no result-side
   *  permission-classifier consumer yet (the host auto-classifier runs
   *  pre-execution on the action), so delivery to a classifier is a follow-up
   *  vocabulary/session seam — carrying it here keeps it bound to the call. */
  classifierContext?: string
}

export interface LoopDeps {
  /** One API round. `thinking`/`outputFormat` are OPTIONAL per-request
   *  overrides: the production supplier (native-session streamFor →
   *  defaultStream) projects them onto the Anthropic request OVER the session
   *  defaults. The main turn loop passes neither (session behavior unchanged);
   *  the hook verdict rounds pass thinking-disabled (+ json_schema for prompt)
   *  through this same shape. */
  stream(req: {
    model: string
    system: string
    tools: unknown[]
    messages: unknown[]
    signal: AbortSignal
    thinking?: ThinkingSetting
    outputFormat?: RequestOutputFormat
  }): AsyncIterable<CanonicalEvent>
  tools: ToolDef[]
  /** Maximum number of model API rounds for this prompt. A final-round
   *  tool_use receives a synthetic error result instead of being executed. */
  maxTurns?: number
  /** Live per-turn facts shared with the session's settlement path (see
   *  TurnStats). Absent for nested runners (structured runs / subagents),
   *  which emit no terminal result and never need an abort settlement. */
  turnStats?: TurnStats
  tasks: NativeTaskManager
  /** The session's working directory; every ToolContext is built from it. */
  cwd: string
  /** `questionResult` is the broker's internal marker for an AskUserQuestion
   *  denial that carries the user's ANSWER (answer / clarify / malformed).
   *  It is never set for aborts, session-close denials, missing handlers or
   *  ordinary permission denials. `readOnlyHint` is the resolved ToolDef's
   *  read-only metadata (for MCP tools, the server's declared annotation),
   *  forwarded to the host permission gate as read-only evidence. */
  requestPermission(toolName: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal, readOnlyHint?: boolean): Promise<{ allowed: boolean; input: Record<string, unknown>; message?: string; questionResult?: boolean; interrupt?: boolean }>
  /** Hook decision point (T8). The per-call tool block dispatches PreToolUse
   *  BEFORE requestPermission (RS §5): allow/deny short-circuit the permission
   *  request, ask/defer/no-decision enter it. Absent = no hook engine wired
   *  (the nested Agent runner until its own seam lands), so the permission
   *  flow runs unchanged. The session owns the engine + config re-collection. */
  dispatchHook?: (event: HookEvent, input: Record<string, unknown>, ctx: { signal: AbortSignal; hasContext: boolean }) => Promise<HookDecision>
  emit(frame: NativeLoopFrame): void
  /** Append the canonical result exactly once. The same UUID is passed to the
   * text-only UI frame, so disk replay and live rendering share identity. */
  persistToolResult(result: PersistedToolResult): void
  /** Registry/state context for the per-round neutral→wire request projection. */
  attachmentProjection: NativeProjectionOptions
  system: string
  /** Emit the terminal result frame at the end of the turn (default true). A
   *  nested (sidechain) runner sets this to false: its frames belong to a
   *  parent tool, and the parent's own turn owns the single terminal result. */
  emitResult?: boolean
  /** The session's LIVE fast-mode intent, read when the result frame is
   *  emitted so the terminal frame reports the state the next turn would use.
   *  Absent = the provider has no fast mode (the field is then omitted). */
  fastModeState?: () => 'on' | 'off'
  /** Mid-run steering: drain supplements queued since the previous round.
   *  Called at the TOP of every iteration (before the API request); each
   *  entry's `text` is ALREADY the wrapped guidance, appended to history
   *  verbatim. The session's drain owns persistence and the delivery callback
   *  — the loop neither wraps nor reports. Absent for the nested Agent runner
   *  (a subagent never consumes main-thread steering). */
  drainSupplement?: () => Promise<Array<{ uuid: string; text: string }>>
  /** Called synchronously after the initial user message(s) join history.
   *  The session uses this to distinguish pre-run failures (where its catch
   *  must restore them) from failures after the loop took ownership. */
  onInitialMessagesOwned?: () => void
  /** Seed the turn's Stop-guard state (RS §4.4): an asyncRewake wake turn IS
   *  stop-hook feedback (the CLI notification's stopHookActive:true fact), so
   *  its FIRST Stop dispatch carries stop_hook_active:true — a well-behaved
   *  rewake Stop hook checks it and terminates instead of re-waking forever.
   *  Absent/false = an ordinary user turn (fresh guard). */
  initialStopHookActive?: boolean
}

export interface TurnResult {
  usage: TokenUsage
  numTurns: number
  finalText: string
  isError: boolean
}

/** RS §5: the Stop forced-continuation cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP??8`).
 *  The count increments on EVERY Stop feedback continuation (exit-2 block OR
 *  additionalContext — both ride the CLI's blockingErrors list); the turn ends
 *  with a warning when the incremented count EXCEEDS the cap (CLI `Da`:
 *  `$e = Ts + 1; if (He > 0 && $e > He)`), so 8 continuations are honored and
 *  the 9th block ends the turn. Native pins the default — there is no env knob
 *  (server/config.ts reads no process.env). */
const STOP_BLOCK_CAP = 8

/** Live per-turn facts, shared by the loop that produces them and the session's
 *  settlement path (which runs when runTurn throws). The session stamps
 *  `startedAt` when it arms the turn and `abortPhase` when the user interrupts;
 *  the loop advances `rounds` / `phase` / `usage` as it runs. Because an abort
 *  or API failure unwinds the loop through an exception, the catch path cannot
 *  receive a TurnResult — it reads this same record, so the round count and
 *  duration the success frame and the interrupted/error settlement report
 *  cannot disagree. Usage deliberately CAN: the success frame stays on its
 *  existing last-round reading while an interrupted settlement reports the
 *  turn total (see `usage`). */
export interface TurnStats {
  /** Wall-clock turn start (ms epoch), stamped by the session at turn start —
   *  before the durable-append await, so the duration covers the whole turn. */
  readonly startedAt: number
  /** Completed model rounds (the same counter the loop reports as numTurns).
   *  An aborted round has no settled assistant message and does not count. */
  rounds: number
  /** Current loop phase. */
  phase: TurnPhase
  /** The phase observed at the instant the user interrupted (stamped by the
   *  session's interrupt()). Only meaningful for the interrupted settlement —
   *  the exception itself often surfaces in the NEXT round, after `phase`
   *  already flipped back to 'streaming'. */
  abortPhase?: TurnPhase
  /** Usage accumulated over COMPLETED rounds. The interrupted settlement
   *  reports it as the partial turn's usage (never the previous turn's
   *  `lastUsage`). The completed result frame keeps its existing last-round
   *  reading — making it cumulative is a separate, product-visible change. */
  usage: TokenUsage
}

/** One gathered tool result in neutral form: the call it answers, its content
 *  blocks (text / file), and whether the invocation failed. */
interface NeutralToolResult {
  callId: string
  content: ContentBlock[]
  isError: boolean
  /** PostToolUse classifier assertion accompanying the result (RS §3); carried
   *  to the durable record, never fed to the model (it is not a delivery channel). */
  classifierContext?: string
}

/** One agent turn: stream → assemble → execute tools → repeat until the
 *  model stops calling tools, then emit the result frame. History is mutated
 *  in place (the session owns its lifetime across turns) and stays NEUTRAL. */
export async function runTurn(
  deps: LoopDeps,
  frameCtx: FrameContext,
  history: RequestMessage[],
  turnInput: RequestMessage | readonly RequestMessage[],
  model: string,
  signal: AbortSignal,
): Promise<TurnResult> {
  if (deps.maxTurns !== undefined && (!Number.isInteger(deps.maxTurns) || deps.maxTurns <= 0)) {
    throw new Error('maxTurns must be a positive integer')
  }
  const ctx = frameCtx
  const toolByName = new Map(deps.tools.map((t) => [t.name, t]))
  const turnStartedAt = deps.turnStats?.startedAt ?? Date.now()
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let numTurns = 0
  let finalText = ''
  // P1 never marks the whole turn as an error: tool failures surface as
  // error tool_results and the model gets to recover in the next round.
  // Exhausting maxTurns is the exception: the model gets no recovery round.
  let isError = false
  // A permission denial carrying interrupt:true (RS §5 / §13.1) aborts the
  // turn: the remaining calls in the batch are skipped (synthetic 'aborted'
  // results below) and no recovery round runs.
  let interruptTurn = false
  // Stop-seam state (RS §5), per turn: whether a Stop hook already forced a
  // continuation this turn (the next Stop input's stop_hook_active) and the
  // running count of forced continuations (the block cap). A new user prompt
  // starts a fresh runTurn, so both reset — matching the CLI's per-query guards.
  // A wake turn seeds the guard true (RS §4.4 stopHookActive notification fact).
  let stopHookActive = deps.initialStopHookActive === true
  let stopBlockCount = 0
  const initialMessages = Array.isArray(turnInput) ? turnInput : [turnInput]
  history.push(...initialMessages)
  deps.onInitialMessagesOwned?.()
  for (;;) {
    // A new round is about to stream and the previous round's tools are done,
    // so stamp the phase BEFORE the supplement drain: the drain awaits the
    // log flush, and an interrupt in that window is a stop before the next
    // round — not "stopped in tools". (A later settlement reads `abortPhase`,
    // which the session stamps at interrupt time.)
    if (deps.turnStats) deps.turnStats.phase = 'streaming'
    // Mid-run steering: anything queued since the previous round joins the
    // conversation as a user message BEFORE this round's request is built.
    // `entry.text` is already the wrapped guidance — never re-wrap it.
    if (deps.drainSupplement) {
      const entries = await deps.drainSupplement()
      for (const entry of entries) {
        history.push({ role: 'user', content: [{ type: 'text', text: entry.text }] })
      }
    }
    const assembler = new BlockAssembler()
    const bridge = new CanonicalBridge()
    let stopReason: string | null = null
    // Per-API-round usage: each assistant frame reports only the usage of the
    // round that produced it. Carrying fields over from the previous round
    // would double-count cache buckets when an adapter omits them.
    let roundUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    for await (const ev of deps.stream({
      model, system: deps.system, tools: deps.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
      messages: await projectNativeHistoryToWire(history, deps.attachmentProjection, signal), signal,
    })) {
      if ((ev.kind === 'message_start' || ev.kind === 'message_end') && ev.usage) {
        roundUsage = mergeUsage(roundUsage, ev.usage)
        assembler.push({ type: 'usage', usage: roundUsage })
      }
      if (ev.kind === 'message_end') {
        stopReason = ev.stopReason
        assembler.push({ type: 'finish', reason: finishReasonOf(stopReason) })
      }
      for (const chunk of bridge.translate(ev)) assembler.push(chunk)
      // R2 UI passthrough: prefer the protocol-native event so the client's
      // existing stream_event phase parser keeps working byte-identically;
      // canonical shapes are a valid fallback for adapters without a raw
      // payload. The core never inspects the event.
      deps.emit({ type: 'raw-stream-event', event: ev.raw ?? ev })
    }
    numTurns++
    usage = roundUsage
    if (deps.turnStats) {
      deps.turnStats.rounds = numTurns
      deps.turnStats.usage = addUsage(deps.turnStats.usage, roundUsage)
    }
    const blocks = assembler.blocks()
    // The settled assistant message keeps EVERY block (the UI frame renders
    // them all); the wire adapter owns the signed-thinking retention filter
    // when this message is projected into a later request.
    const message = createAssistantMessage({ content: blocks, source: { provider: 'anthropic', model } })
    const replayState = assembler.replayState
    deps.emit({
      type: 'assistant-frame',
      message,
      usage: roundUsage,
      // F2: stopReason is sourced DIRECTLY from the canonical message_end,
      // never from the replay envelope (the assembler discards it on block
      // misalignment).
      stopReason,
      model,
      ...(replayState !== undefined ? { replayState } : {}),
    })
    history.push(message)
    const toolCalls = blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call')
    const capped = deps.maxTurns !== undefined && numTurns === deps.maxTurns
    if (toolCalls.length === 0) {
      finalText = textOf(blocks)
      if (capped && stopReason !== 'end_turn') isError = true
      // Stop seam (RS §5): dispatch BEFORE settling the turn. An exit-2 /
      // decision block feeds the block reason to the model and forces another
      // API round; additionalContext is the non-error feedback continuation
      // channel (same capped path). An aborted turn is an interrupt, not a
      // model stop — no Stop dispatch (the CLI cancels its stop hooks on abort).
      if (deps.dispatchHook && !signal.aborted) {
        const stopDecision = await deps.dispatchHook('Stop', {
          session_id: ctx.sessionId,
          cwd: deps.cwd,
          hook_event_name: 'Stop',
          stop_hook_active: stopHookActive,
          last_assistant_message: finalText,
        }, { signal, hasContext: true })
        // continue:false overrides exit-2 on Stop (RS §2.3): end the turn even
        // when the merged action is block. The engine merge is sticky-false —
        // any hook's continue:false wins and a later continue:true cannot
        // resurrect continuation (the CLI's preventContinuation short-circuit) —
        // and the seam consumes that merged fact.
        if (stopDecision.continue !== false) {
          const feedback: string[] = []
          if (stopDecision.action === 'block') {
            const reason = stopDecision.block?.reason ?? ''
            // exit-2 with empty stderr is a real hook shape; the continuation
            // still happens, with a factual marker so the user message is never
            // empty (the CLI wraps the stderr in an event-prefixed message).
            feedback.push(reason.trim() !== '' ? reason : 'Stop hook blocked the turn from ending.')
          }
          for (const context of stopDecision.additionalContext) {
            if (context.trim() !== '') feedback.push(context)
          }
          // maxTurns wins over a Stop forced continuation (the CLI checks
          // max_turns before the cap): a capped turn ends regardless.
          if (feedback.length > 0 && !capped) {
            stopBlockCount++
            stopHookActive = true
            if (stopBlockCount > STOP_BLOCK_CAP) {
              deps.emit({
                type: 'informational',
                text: `A hook blocked the turn from ending ${stopBlockCount} consecutive times — overriding and ending turn. `
                  + "For Stop hooks, check stop_hook_active in the input and return success while it's true.",
                sessionId: ctx.sessionId,
                uuid: ctx.uuid(),
                parentToolUseId: ctx.parentToolUseId ?? null,
              })
              break
            }
            history.push({ role: 'user', content: [{ type: 'text', text: feedback.join('\n') }] })
            continue
          }
        }
      }
      break
    }
    const results: NeutralToolResult[] = []
    // Hook feedback accumulated across this round's calls — PreToolUse /
    // PostToolUse / PostToolUseFailure additionalContext plus the post-tool
    // exit-2 block reasons; it is injected into the conversation after the tool
    // results (below) so the next model round sees it. Collected regardless of
    // each call's allow/deny outcome.
    const hookContext: string[] = []
    if (capped) {
      isError = true
      finalText = textOf(blocks)
      for (const call of toolCalls) {
        results.push({
          callId: call.id,
          content: [{ type: 'text', text: `max turns reached (${deps.maxTurns}); tool not executed` }],
          isError: true,
        })
      }
    }
    for (const call of toolCalls.slice(results.length)) {
      // Abort during a previous tool's execution (or its permission): do NOT
      // run any further tool — an already-aborted signal would park the
      // permission request forever. Results gathered so far still get their
      // tool_result frames and history push below.
      if (signal.aborted) break
      if (deps.turnStats) deps.turnStats.phase = 'tools'
      const tool = toolByName.get(call.name)
      const input = parseToolInput(call.arguments)
      if (!tool) {
        results.push({ callId: call.id, content: [{ type: 'text', text: `unknown tool: ${call.name}` }], isError: true })
        continue
      }
      // PreToolUse hook seam (RS §5): dispatch BEFORE the permission request.
      // allow/deny short-circuit canUseTool; ask/defer/no-decision enter the
      // normal permission flow. A denied/blocked tool is never run.
      // Alias parity (T2 carry-forward): the engine matches the literal
      // tool_name; Agent/Task/Explore alias normalization belongs to the
      // matcher seam and is deferred — a matcher naming only one alias does
      // not yet fire on its siblings.
      let effectiveInput = input
      let hookAllow = false
      let hookDenyMessage: string | undefined
      if (deps.dispatchHook) {
        const hookDecision = await deps.dispatchHook('PreToolUse', {
          session_id: ctx.sessionId,
          cwd: deps.cwd,
          hook_event_name: 'PreToolUse',
          tool_name: call.name,
          tool_input: input,
          tool_use_id: call.id,
        }, { signal, hasContext: true })
        for (const context of hookDecision.additionalContext) {
          if (context.trim() !== '') hookContext.push(context)
        }
        if (hookDecision.action === 'block') {
          hookDenyMessage = hookDecision.block?.reason ?? 'blocked by hook'
        } else if (hookDecision.action === 'deny') {
          hookDenyMessage = hookDecision.permission?.message ?? 'denied by hook'
        } else if (hookDecision.action === 'allow') {
          const updated = hookDecision.permission?.updatedInput
          if (updated !== undefined) {
            const refusal = updatedInputRefusal(tool, updated)
            if (refusal !== null) hookDenyMessage = refusal
            else effectiveInput = updated
          }
          if (hookDenyMessage === undefined) hookAllow = true
        }
        // ask / defer / continue → the normal permission flow below.
      }
      if (hookDenyMessage !== undefined) {
        results.push({ callId: call.id, content: [{ type: 'text', text: hookDenyMessage }], isError: true })
        continue
      }
      let toolInput: Record<string, unknown>
      if (hookAllow) {
        toolInput = effectiveInput
      } else {
        const decision = await deps.requestPermission(call.name, effectiveInput, call.id, signal, tool.readOnlyHint === true)
        if (!decision.allowed) {
          // The broker resolves an ANSWERED AskUserQuestion as a marked denial:
          // the message IS the tool's output, not a permission error. Only that
          // explicit marker qualifies — aborts, session-close denials and
          // ordinary permission denials stay errors for every tool.
          results.push({
            callId: call.id,
            content: [{ type: 'text', text: decision.message ?? 'permission denied' }],
            isError: !(call.name === 'AskUserQuestion' && decision.questionResult === true),
          })
          // interrupt:true aborts the turn (RS §5): stop the batch, no recovery
          // round. The remaining calls get synthetic 'aborted' results below.
          if (decision.interrupt) {
            interruptTurn = true
            break
          }
          continue
        }
        toolInput = decision.input
      }
      let text: string
      let resultContent: NeutralToolResult['content'] | undefined
      let runFailed = false
      // The throw-vs-return fact that routes the post-tool hook (RS §12.1).
      // Distinct from `runFailed`, which is ALSO true for a soft isError normal
      // return — only a genuine throw sets this.
      let toolThrew = false
      try {
        const execute = (taskSignal: AbortSignal) =>
          tool.run(toolInput as never, {
            cwd: deps.cwd,
            signal: taskSignal,
            toolUseId: call.id,
            historyKey: ctx.parentToolUseId ?? 'main',
          })
        const backgroundable = tool.backgroundable
        const outcome = backgroundable
          ? await deps.tasks.runForeground({
              toolUseId: call.id,
              taskType: backgroundable.taskType,
              description: backgroundable.describe(toolInput),
              subagentType: backgroundable.subagentType?.(toolInput),
            }, execute, signal, ctx.parentToolUseId ?? undefined)
          : await execute(signal)
        text = outcome.text
        // Tools already emit neutral vocabulary content (text blocks + file
        // occurrences keeping their full resolved attachment), so it travels
        // into the tool-result message unchanged.
        resultContent = outcome.content
        runFailed = outcome.isError ?? false
      } catch (err) {
        text = err instanceof Error ? err.message : String(err)
        runFailed = true
        toolThrew = true
      }
      // PostToolUse / PostToolUseFailure seam (RS §12.1). Routing is by
      // THROW-vs-RETURN only: a normal return — even one whose result carries a
      // soft isError — dispatches PostToolUse; a thrown error dispatches
      // PostToolUseFailure. The result's is_error flag is never consulted. The
      // MCP adapter normalizes MCP isError:true into a throw (CLI `ys` parity),
      // so MCP errors reach Failure through this same throw fact. Dispatched
      // after the try/catch so a hook-engine failure can never be misread as a
      // tool throw (one unified decision point, not two scattered dispatches).
      let postClassifierContext: string | undefined
      if (deps.dispatchHook) {
        const event = toolThrew ? 'PostToolUseFailure' : 'PostToolUse'
        const postDecision = await deps.dispatchHook(event, {
          session_id: ctx.sessionId,
          cwd: deps.cwd,
          hook_event_name: event,
          tool_name: call.name,
          tool_input: toolInput,
          tool_use_id: call.id,
          ...(toolThrew ? { error: text } : { tool_response: text }),
        }, { signal, hasContext: true })
        for (const context of postDecision.additionalContext) {
          if (context.trim() !== '') hookContext.push(context)
        }
        // exit-2 / decision block: the tool already ran (or already failed), so
        // its result stands; the block stderr is fed to the model as next-round
        // feedback (RS §3 "stderr immediately to the model"), not a replacement.
        if (postDecision.action === 'block' && postDecision.block && postDecision.block.reason.trim() !== '') {
          hookContext.push(postDecision.block.reason)
        }
        // PostToolUse rewrite (RS §3 / §4.9): the engine merged the rewrites
        // last-write-wins across hooks. updatedToolOutput replaces the output of
        // ANY tool; updatedMCPToolOutput is the MCP-only fallback. CLI precedence:
        // updatedToolOutput wins when present, else updatedMCPToolOutput for an
        // MCP tool (the mcp__ name prefix, the CLI's `fh` marker), else nothing —
        // a non-MCP tool ignores updatedMCPToolOutput. A thrown failure's result
        // is never rewritten (a soft isError normal return IS).
        if (!toolThrew) {
          const isMcpTool = call.name.startsWith('mcp__')
          const rewrite = postDecision.updatedToolOutput !== undefined
            ? postDecision.updatedToolOutput
            : isMcpTool ? postDecision.updatedMCPToolOutput : undefined
          if (rewrite !== undefined) {
            resultContent = [{ type: 'text', text: rewrite }]
          }
        }
        // The classifier assertion accompanies the result (RS §3); preserve it
        // on the durable record. It is never model-facing — not a delivery
        // channel (SDK PostToolUseHookSpecificOutput.classifierContext).
        postClassifierContext = postDecision.classifierContext
      }
      results.push({
        callId: call.id,
        content: resultContent ?? [{ type: 'text', text }],
        isError: runFailed,
        ...(postClassifierContext !== undefined ? { classifierContext: postClassifierContext } : {}),
      })
    }
    // An abort mid-response leaves tool_use blocks unanswered. The API
    // requires every tool_use to be matched by a tool_result in the next user
    // message, so skipped calls get a synthetic error result — otherwise the
    // turn after the interrupt would fail on invalid history.
    for (const call of toolCalls.slice(results.length)) {
      results.push({ callId: call.id, content: [{ type: 'text', text: 'aborted' }], isError: true })
    }
    // tool_result frames are built with the caller's frameCtx, so they carry
    // the REAL session id. Persistence and the UI share one minted UUID; the
    // live frame deliberately carries only the text summary, never internal
    // files (the full canonical content travels the persistence path + history).
    for (const result of results) {
      const uuid = ctx.uuid()
      const callId = brandString<'ToolCallId'>(result.callId)
      const historyMessage = createToolResultMessage({ callId, content: result.content, isError: result.isError })
      deps.persistToolResult({
        uuid,
        message: historyMessage,
        ...(result.classifierContext !== undefined ? { classifierContext: result.classifierContext } : {}),
      })
      const summary = result.content.find((block): block is { type: 'text'; text: string } => block.type === 'text')?.text ?? ''
      // The live UI frame is a text-only tool message keyed by the SAME uuid as
      // the persisted result, so disk replay and live rendering share identity.
      const liveFrame = freezeMessage({
        role: 'tool',
        id: brandString<'MessageId'>(uuid),
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: summary }],
        isError: result.isError,
      })
      deps.emit(liveFrame)
      history.push(historyMessage)
    }
    // The round's collected hook feedback (PreToolUse / PostToolUse /
    // PostToolUseFailure additionalContext + post-tool exit-2 block reasons)
    // joins the conversation after the tool results (the same pre-request
    // boundary as steering supplements), so the next model round sees it. One
    // user message carries the round's collected context.
    if (hookContext.length > 0) {
      history.push({ role: 'user', content: [{ type: 'text', text: hookContext.join('\n') }] })
    }
    // A permission interrupt ends the turn after the denial results are durable
    // (no recovery round); the terminal result reports the abnormal end.
    if (interruptTurn) {
      isError = true
      break
    }
    if (capped) break
  }
  if (deps.emitResult !== false) {
    deps.emit({
      type: 'result',
      result: finalText,
      usage,
      numTurns,
      durationMs: Date.now() - turnStartedAt,
      isError,
      // Neutral outcome (the adapter maps it to the SDK terminal_reason).
      // maxTurns exhaustion is 'error' today; the SDK's 'max_turns' value is a
      // later refinement, not a behavior this loop wants to overclaim.
      reason: isError ? 'error' : 'completed',
      sessionId: ctx.sessionId,
      uuid: ctx.uuid(),
      parentToolUseId: ctx.parentToolUseId ?? null,
      ...(deps.fastModeState ? { fastMode: deps.fastModeState() === 'on' } : {}),
    })
  }
  return { usage, numTurns, finalText, isError }
}

/** Concatenate the text blocks of an assembled round (the turn's final text). */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('')
}

/** RS §5 Man/EWe: a PreToolUse hook's `updatedInput` must satisfy the tool's
 *  input schema and must not carry internal reserved keys. Returns the deny
 *  message (the tool is NOT run) or null when the rewrite is acceptable.
 *  Internal `_`-prefixed keys are rejected outright — only Claude Code sets
 *  such keys, and native tool inputs never legitimately carry them, so any is
 *  hook-injected. This is a conservative superset of the CLI's `__artifact`-
 *  specific reserved-key gate; RS §5 / Review Focus 5 pin the general `_` prefix. */
export function updatedInputRefusal(
  tool: ToolDef,
  updatedInput: Record<string, unknown>,
  event: 'PreToolUse' | 'PermissionRequest' = 'PreToolUse',
): string | null {
  const hookLabel = `${event} hook for ${tool.name}`
  const issues = schemaIssues(tool.schema, updatedInput, '')
  if (issues.length > 0) {
    return `${hookLabel} returned updatedInput that failed schema validation: ${issues.join('; ')}\n`
      + 'The tool input from the model was valid; the hook\'s rewrite of it was not.'
  }
  const reserved = Object.keys(updatedInput).find((key) => key.toLowerCase().startsWith('_'))
  if (reserved !== undefined) {
    return `${hookLabel} returned updatedInput with a key starting with "_" (in any letter case). `
      + 'Only Claude Code sets such keys. Remove the key from updatedInput. The tool was not run.'
  }
  return null
}

/** Validate a value against the JSON-Schema subset the native tool schemas use
 *  (type / enum / required / properties / items / additionalProperties:false /
 *  minLength / minimum / maximum). Returns human-readable issue strings; empty
 *  means valid. Unknown keywords are ignored, per JSON Schema semantics. This
 *  mirrors the CLI's `inputSchema.safeParse` gate on a hook's updatedInput. */
function schemaIssues(schema: Record<string, unknown>, value: unknown, path: string): string[] {
  const issues: string[] = []
  const at = path === '' ? 'input' : path
  if (schema.type !== undefined && !matchesJsonType(schema.type, value)) {
    issues.push(`${at} must be of type ${Array.isArray(schema.type) ? schema.type.join(' or ') : String(schema.type)}`)
    return issues
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    issues.push(`${at} must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) {
    issues.push(`${at} must have at least ${schema.minLength} characters`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${at} must be >= ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${at} must be <= ${schema.maximum}`)
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) issues.push(`${childPath(path, key)} is required`)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key]
      if (isPlainObject(childSchema)) issues.push(...schemaIssues(childSchema, child, childPath(path, key)))
      else if (schema.additionalProperties === false) issues.push(`${childPath(path, key)} is not an allowed property`)
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    const items = schema.items
    value.forEach((item, index) => issues.push(...schemaIssues(items, item, `${at}[${index}]`)))
  }
  return issues
}

function childPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

/** JSON-Schema `type` check (a single type or an array of alternatives). */
function matchesJsonType(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) return type.some((t) => matchesJsonType(t, value))
  switch (type) {
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    default: return true // an unknown type keyword imposes no constraint
  }
}

/** Merge a protocol usage partial into the round's running neutral totals.
 *  Cache fields are carried through so the /usage panel can show them; absent
 *  fields leave the prior reading untouched. */
function mergeUsage(base: TokenUsage, partial: CanonicalUsagePartial | undefined): TokenUsage {
  if (!partial) return base
  return {
    ...base,
    ...(typeof partial.input_tokens === 'number' ? { inputTokens: partial.input_tokens } : {}),
    ...(typeof partial.output_tokens === 'number' ? { outputTokens: partial.output_tokens } : {}),
    ...(typeof partial.cache_read_input_tokens === 'number' ? { cacheReadTokens: partial.cache_read_input_tokens } : {}),
    ...(typeof partial.cache_creation_input_tokens === 'number' ? { cacheWriteTokens: partial.cache_creation_input_tokens } : {}),
  }
}

/** Field-wise sum of two neutral usage readings (cache fields only appear when
 *  at least one side carries them) — the turn-total accumulator for TurnStats. */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  const cacheWrite = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheRead !== 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

type BridgePartial =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature: string }
  | { type: 'redacted'; data: string }
  | { type: 'tool-call'; id: string; name: string; json: string }

/** Stateful CanonicalEvent → StreamChunk bridge. The canonical wire IR carries
 *  deltas + block markers but no authoritative block payload at block_end, and
 *  the neutral StreamChunk has no signature delta — so the bridge accumulates
 *  each block and emits an authoritative `block-end` chunk (the assembler's
 *  first-close-wins settlement consumes it). Reasoning signatures and redacted
 *  data ride that authoritative block; tool-call id/name ride tool-call-delta.
 *  Usage/finish events return [] (the loop pushes those chunks itself). */
class CanonicalBridge {
  private partials = new Map<number, BridgePartial>()

  translate(ev: CanonicalEvent): StreamChunk[] {
    switch (ev.kind) {
      case 'block_start': {
        const index = ev.index
        switch (ev.block.type) {
          case 'text':
            this.partials.set(index, { type: 'text', text: '' })
            return [{ type: 'block-start', index, blockType: 'text' }]
          case 'thinking':
            this.partials.set(index, { type: 'reasoning', text: '', signature: '' })
            return [{ type: 'block-start', index, blockType: 'reasoning' }]
          case 'redacted_thinking': {
            this.partials.set(index, { type: 'redacted', data: ev.block.data })
            return [
              { type: 'block-start', index, blockType: 'reasoning' },
              { type: 'block-end', index, block: { type: 'reasoning', text: '', redacted: true, data: ev.block.data } },
            ]
          }
          case 'tool_use': {
            this.partials.set(index, { type: 'tool-call', id: ev.block.id, name: ev.block.name, json: '' })
            return [
              { type: 'block-start', index, blockType: 'tool-call' },
              { type: 'tool-call-delta', index, id: brandString<'ToolCallId'>(ev.block.id), name: ev.block.name, argumentsDelta: '' },
            ]
          }
        }
        return []
      }
      case 'block_delta': {
        const partial = this.partials.get(ev.index)
        if (!partial) return []
        const delta = ev.delta
        // A delta must match its block kind — a mismatched delta is a no-op,
        // never a crash or cross-block contamination.
        if (delta.type === 'text' && partial.type === 'text') {
          partial.text += delta.text
          return [{ type: 'text-delta', index: ev.index, text: delta.text }]
        }
        if (delta.type === 'thinking' && partial.type === 'reasoning') {
          partial.text += delta.thinking
          return [{ type: 'reasoning-delta', index: ev.index, text: delta.thinking }]
        }
        if (delta.type === 'signature' && partial.type === 'reasoning') {
          // No signature StreamChunk exists; it rides the authoritative block-end.
          partial.signature += delta.signature
          return []
        }
        if (delta.type === 'tool_input' && partial.type === 'tool-call') {
          partial.json += delta.json
          return [{ type: 'tool-call-delta', index: ev.index, id: brandString<'ToolCallId'>(partial.id), name: partial.name, argumentsDelta: delta.json }]
        }
        return []
      }
      case 'block_end': {
        const partial = this.partials.get(ev.index)
        if (!partial) return []
        return [{ type: 'block-end', index: ev.index, block: this.build(partial) }]
      }
      default:
        return []
    }
  }

  private build(partial: BridgePartial): ContentBlock {
    switch (partial.type) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return {
        type: 'reasoning',
        text: partial.text,
        ...(partial.signature !== '' ? { signature: partial.signature } : {}),
      }
      case 'redacted': return { type: 'reasoning', text: '', redacted: true, data: partial.data }
      case 'tool-call': return {
        type: 'tool-call',
        id: brandString<'ToolCallId'>(partial.id),
        name: partial.name,
        arguments: partial.json,
      }
    }
  }
}
