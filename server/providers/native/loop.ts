// server/providers/native/loop.ts
import type { AgentMessage } from '../../agent-message.js'
import { assistantFrame, resultFrame, streamEventFrame, toolResultFrame, type ContentBlock, type FrameContext, type Usage } from './frames.js'
import type { CanonicalEvent, CanonicalUsagePartial } from './canonical.js'
import type { ToolDef } from './tools/types.js'

export interface LoopDeps {
  stream(req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal }): AsyncIterable<CanonicalEvent>
  tools: ToolDef[]
  /** The session's working directory; every ToolContext is built from it. */
  cwd: string
  requestPermission(toolName: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<{ allowed: boolean; input: Record<string, unknown>; message?: string }>
  emit(frame: AgentMessage): void
  system: string
}

export interface TurnResult {
  usage: Usage
  numTurns: number
  finalText: string
  isError: boolean
}

type AggBlock = Extract<ContentBlock, { type: 'text' }> | Extract<ContentBlock, { type: 'thinking' }> | { type: 'tool_use'; id: string; name: string; json: string }

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
  const ctx = frameCtx
  const toolByName = new Map(deps.tools.map((t) => [t.name, t]))
  let usage: Usage = { input_tokens: 0, output_tokens: 0 }
  let numTurns = 0
  let finalText = ''
  // P1 never marks the whole turn as an error: tool failures surface as
  // error tool_results and the model gets to recover in the next round.
  const isError = false
  history.push(turnInput)
  for (;;) {
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
              ? { type: 'thinking', thinking: '' }
              : { type: 'text', text: '' }
          break
        }
        case 'block_delta': {
          const block = blocks[ev.index]
          if (!block) break
          // A delta must match its block kind — the adapter maps unknown
          // delta types (e.g. thinking's signature_delta) to an empty
          // tool_input delta, so a mismatched delta is a no-op, never a
          // crash or cross-block contamination.
          if (ev.delta.type === 'text' && block.type === 'text') block.text += ev.delta.text
          else if (ev.delta.type === 'thinking' && block.type === 'thinking') block.thinking += ev.delta.thinking
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
    const content: ContentBlock[] = blocks.map((b) =>
      b.type === 'tool_use'
        ? { type: 'tool_use', id: b.id, name: b.name, input: parseJsonInput(b.json) }
        : b,
    )
    deps.emit(assistantFrame(ctx, { model, content, stopReason, usage: roundUsage }))
    // Strip thinking blocks from what goes back to the API: P1 does not
    // enable extended thinking and never aggregates signature_delta, so a
    // re-sent thinking block would be unsigned and the API rejects unsigned
    // thinking on follow-up requests. The UI-facing assistant frame above
    // keeps the blocks; only the conversation history drops them.
    history.push({ role: 'assistant', content: content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') })
    const toolUses = content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    if (toolUses.length === 0) {
      finalText = content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
      break
    }
    const results: unknown[] = []
    for (const call of toolUses) {
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
        results.push({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: decision.message ?? 'permission denied' }], is_error: true })
        continue
      }
      let text: string
      let runFailed = false
      try {
        const outcome = await tool.run(decision.input as never, { cwd: deps.cwd, signal })
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
  }
  deps.emit(resultFrame(ctx, { result: finalText, usage, numTurns, durationMs: 0, isError }))
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
