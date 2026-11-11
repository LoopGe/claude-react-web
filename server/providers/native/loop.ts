// server/providers/native/loop.ts
import type { AgentMessage } from '../../agent-message.js'
import { assistantFrame, isRetainedThinkingBlock, resultFrame, streamEventFrame, toolResultFrame, type ContentBlock, type FrameContext, type Usage } from './frames.js'
import type { CanonicalEvent, CanonicalUsagePartial } from './canonical.js'
import type { NativeTaskManager } from './task-manager.js'
import type { ToolDef } from './tools/types.js'

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
  emit(frame: AgentMessage): void
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
}

export interface TurnResult {
  usage: Usage
  numTurns: number
  finalText: string
  isError: boolean
}

type AggBlock =
  | Extract<ContentBlock, { type: 'text' }>
  | Extract<ContentBlock, { type: 'redacted_thinking' }>
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; json: string }

/** One agent turn: stream → aggregate → execute tools → repeat until the
 *  model stops calling tools, then emit the result frame. History is mutated
 *  in place (the session owns its lifetime across turns). */
export async function runTurn(
  deps: LoopDeps,
  frameCtx: FrameContext,
  history: unknown[],
  turnInput: { role: 'user'; content: unknown[] },
  model: string,
  signal: AbortSignal,
): Promise<TurnResult> {
  if (deps.maxTurns !== undefined && (!Number.isInteger(deps.maxTurns) || deps.maxTurns <= 0)) {
    throw new Error('maxTurns must be a positive integer')
  }
  const ctx = frameCtx
  const toolByName = new Map(deps.tools.map((t) => [t.name, t]))
  let usage: Usage = { input_tokens: 0, output_tokens: 0 }
  let numTurns = 0
  let finalText = ''
  // P1 never marks the whole turn as an error: tool failures surface as
  // error tool_results and the model gets to recover in the next round.
  // Exhausting maxTurns is the exception: the model gets no recovery round.
  let isError = false
  history.push(turnInput)
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
    const blocks: AggBlock[] = []
    let stopReason: string | null = null
    // Per-API-round usage: each assistant frame reports only the usage of the
    // round that produced it. Carrying fields over from the previous round
    // would double-count cache buckets when an adapter omits them.
    let roundUsage: Usage = { input_tokens: 0, output_tokens: 0 }
    for await (const ev of deps.stream({
      model, system: deps.system, tools: deps.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
      messages: history, signal,
    })) {
      switch (ev.kind) {
        case 'message_start': {
          roundUsage = mergeUsage(roundUsage, ev.usage)
          break
        }
        case 'block_start': {
          blocks[ev.index] = ev.block.type === 'tool_use'
            ? { type: 'tool_use', id: ev.block.id, name: ev.block.name, json: '' }
            : ev.block.type === 'thinking'
              ? { type: 'thinking', thinking: '', signature: '' }
              : ev.block.type === 'redacted_thinking'
                ? { type: 'redacted_thinking', data: ev.block.data }
                : { type: 'text', text: '' }
          break
        }
        case 'block_delta': {
          const block = blocks[ev.index]
          if (!block) break
          // A delta must match its block kind — a mismatched delta is a
          // no-op, never a crash or cross-block contamination.
          if (ev.delta.type === 'text' && block.type === 'text') block.text += ev.delta.text
          else if (ev.delta.type === 'thinking' && block.type === 'thinking') block.thinking += ev.delta.thinking
          else if (ev.delta.type === 'signature' && block.type === 'thinking') block.signature += ev.delta.signature
          else if (ev.delta.type === 'tool_input' && block.type === 'tool_use') block.json += ev.delta.json
          break
        }
        case 'message_end': {
          stopReason = ev.stopReason
          roundUsage = mergeUsage(roundUsage, ev.usage)
          break
        }
        default:
          break
      }
      // UI passthrough: prefer the protocol-native event so the client's
      // existing stream_event phase parser keeps working; canonical shapes
      // are a valid fallback for adapters without a raw payload.
      deps.emit(streamEventFrame(ctx, ev.raw ?? ev))
    }
    numTurns++
    usage = roundUsage
    const content: ContentBlock[] = blocks.map((b) => {
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: parseJsonInput(b.json) }
      // Carry the signature in the UI frame: the session log persists these
      // frames, and replay rebuilds model history from them.
      if (b.type === 'thinking') {
        return b.signature !== ''
          ? { type: 'thinking', thinking: b.thinking, signature: b.signature }
          : { type: 'thinking', thinking: b.thinking }
      }
      return b
    })
    deps.emit(assistantFrame(ctx, { model, content, stopReason, usage: roundUsage }))
    // A re-sent thinking block must be verifiable, or the API rejects it: keep
    // signed and redacted blocks, strip unsigned thinking from history. The
    // UI-facing assistant frame above keeps every block.
    history.push({ role: 'assistant', content: content.filter(isRetainedThinkingBlock) })
    const toolUses = content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    const capped = deps.maxTurns !== undefined && numTurns === deps.maxTurns
    if (toolUses.length === 0) {
      finalText = content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
      if (capped && stopReason !== 'end_turn') isError = true
      break
    }
    const results: unknown[] = []
    if (capped) {
      isError = true
      finalText = content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
      for (const call of toolUses) {
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: [{ type: 'text', text: `max turns reached (${deps.maxTurns}); tool not executed` }],
          is_error: true,
        })
      }
    }
    for (const call of toolUses.slice(results.length)) {
      // Abort during a previous tool's execution (or its permission): do NOT
      // run any further tool — an already-aborted signal would park the
      // permission request forever. Results gathered so far still get their
      // tool_result frames and history push below.
      if (signal.aborted) break
      const tool = toolByName.get(call.name)
      if (!tool) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `unknown tool: ${call.name}` }], is_error: true })
        continue
      }
      const decision = await deps.requestPermission(call.name, call.input, call.id, signal)
      if (!decision.allowed) {
        // The broker resolves an ANSWERED AskUserQuestion as a marked denial:
        // the message IS the tool's output, not a permission error. Only that
        // explicit marker qualifies — aborts, session-close denials and
        // ordinary permission denials stay errors for every tool.
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: [{ type: 'text', text: decision.message ?? 'permission denied' }],
          is_error: !(call.name === 'AskUserQuestion' && decision.questionResult === true),
        })
        continue
      }
      let text: string
      let runFailed = false
      try {
        const execute = (taskSignal: AbortSignal) =>
          tool.run(decision.input as never, { cwd: deps.cwd, signal: taskSignal, toolUseId: call.id })
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
        runFailed = outcome.isError ?? false
      } catch (err) {
        text = err instanceof Error ? err.message : String(err)
        runFailed = true
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text }], is_error: runFailed })
    }
    // An abort mid-response leaves tool_use blocks unanswered. The API
    // requires every tool_use to be matched by a tool_result in the next user
    // message, so skipped calls get a synthetic error result — otherwise the
    // turn after the interrupt would fail on invalid history.
    for (const call of toolUses.slice(results.length)) {
      results.push({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: 'aborted' }], is_error: true })
    }
    // tool_result frames are built with the caller's frameCtx, so they carry
    // the REAL session id.
    for (const r of results) {
      deps.emit(toolResultFrame(ctx, (r as { tool_use_id: string }).tool_use_id, (r as { content: Array<{ text: string }> }).content[0].text, (r as { is_error?: boolean }).is_error ?? false))
    }
    history.push({ role: 'user', content: results })
    if (capped) break
  }
  if (deps.emitResult !== false) {
    deps.emit(resultFrame(ctx, {
      result: finalText,
      usage,
      numTurns,
      durationMs: 0,
      isError,
      fastModeState: deps.fastModeState?.(),
    }))
  }
  return { usage, numTurns, finalText, isError }
}

function parseJsonInput(json: string): Record<string, unknown> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Merge a protocol usage partial into the turn's running totals. Cache
 *  fields are carried through so the /usage panel can show them; absent
 *  fields leave the prior reading untouched. */
function mergeUsage(base: Usage, partial: CanonicalUsagePartial | undefined): Usage {
  if (!partial) return base
  return {
    ...base,
    ...(typeof partial.input_tokens === 'number' ? { input_tokens: partial.input_tokens } : {}),
    ...(typeof partial.output_tokens === 'number' ? { output_tokens: partial.output_tokens } : {}),
    ...(typeof partial.cache_read_input_tokens === 'number'
      ? { cache_read_input_tokens: partial.cache_read_input_tokens }
      : {}),
    ...(typeof partial.cache_creation_input_tokens === 'number'
      ? { cache_creation_input_tokens: partial.cache_creation_input_tokens }
      : {}),
  }
}
