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
import type { NativeCoreFrame } from './vocabulary/live-frame.js'
import { BlockAssembler } from './vocabulary/assembler.js'
import { brandString } from './vocabulary/brand.js'
import type { CanonicalEvent, CanonicalUsagePartial } from './canonical.js'
import { projectNativeHistoryToWire } from './wire/wire-projection.js'
import type { FrameContext } from './vocabulary/frame-context.js'
import type { NativeTaskManager } from './task-manager.js'
import type { ToolDef } from './tools/types.js'
import type { NativeProjectionOptions } from './attachment-projection.js'

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
}

export interface LoopDeps {
  stream(req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal }): AsyncIterable<CanonicalEvent>
  tools: ToolDef[]
  /** Maximum number of model API rounds for this prompt. A final-round
   *  tool_use receives a synthetic error result instead of being executed. */
  maxTurns?: number
  tasks: NativeTaskManager
  /** The session's working directory; every ToolContext is built from it. */
  cwd: string
  /** `questionResult` is the broker's internal marker for an AskUserQuestion
   *  denial that carries the user's ANSWER (answer / clarify / malformed).
   *  It is never set for aborts, session-close denials, missing handlers or
   *  ordinary permission denials. */
  requestPermission(toolName: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<{ allowed: boolean; input: Record<string, unknown>; message?: string; questionResult?: boolean }>
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
}

export interface TurnResult {
  usage: TokenUsage
  numTurns: number
  finalText: string
  isError: boolean
}

/** One gathered tool result in neutral form: the call it answers, its content
 *  blocks (text / file), and whether the invocation failed. */
interface NeutralToolResult {
  callId: string
  content: ContentBlock[]
  isError: boolean
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
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let numTurns = 0
  let finalText = ''
  // P1 never marks the whole turn as an error: tool failures surface as
  // error tool_results and the model gets to recover in the next round.
  // Exhausting maxTurns is the exception: the model gets no recovery round.
  let isError = false
  const initialMessages = Array.isArray(turnInput) ? turnInput : [turnInput]
  history.push(...initialMessages)
  deps.onInitialMessagesOwned?.()
  for (;;) {
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
      break
    }
    const results: NeutralToolResult[] = []
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
      const tool = toolByName.get(call.name)
      const input = parseToolInput(call.arguments)
      if (!tool) {
        results.push({ callId: call.id, content: [{ type: 'text', text: `unknown tool: ${call.name}` }], isError: true })
        continue
      }
      const decision = await deps.requestPermission(call.name, input, call.id, signal)
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
        continue
      }
      let text: string
      let resultContent: NeutralToolResult['content'] | undefined
      let runFailed = false
      try {
        const execute = (taskSignal: AbortSignal) =>
          tool.run(decision.input as never, {
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
              description: backgroundable.describe(decision.input),
              subagentType: backgroundable.subagentType?.(decision.input),
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
      }
      results.push({ callId: call.id, content: resultContent ?? [{ type: 'text', text }], isError: runFailed })
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
      deps.persistToolResult({ uuid, message: historyMessage })
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
    if (capped) break
  }
  if (deps.emitResult !== false) {
    deps.emit({
      type: 'result',
      result: finalText,
      usage,
      numTurns,
      durationMs: 0,
      isError,
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
