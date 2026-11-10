// server/providers/native/frames.ts
import type { AgentMessage } from '../../agent-message.js'

// The SDKMessage union does not carry the frame fields uniformly (e.g.
// SDKResultSuccess has no parent_tool_use_id, most members have no `message`),
// so the read side is widened to a Record intersection — every produced object
// is still structurally an SDK message and assignable to AgentMessage.
export type Frame = AgentMessage & Record<string, any>

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

/** Model history may carry a thinking block only when the API can verify it:
 *  signed (`signature` non-empty) or redacted (`data` non-empty). The API
 *  rejects unsigned thinking on a follow-up request, so those are stripped
 *  from history — the UI-facing assistant frame keeps every block. Shared by
 *  the live loop and the log replay so the two can never diverge. */
export function isRetainedThinkingBlock(block: { type?: unknown; signature?: unknown; data?: unknown }): boolean {
  if (block.type === 'thinking') return typeof block.signature === 'string' && block.signature !== ''
  if (block.type === 'redacted_thinking') return typeof block.data === 'string' && block.data !== ''
  return true
}

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface FrameContext {
  sessionId: string
  uuid(): string
  /** Set by a nested (sidechain) runner: the id of the tool_use that spawned
   *  it. Unset / null for the main thread. */
  parentToolUseId?: string | null
}

export function defaultFrameContext(sessionId: string, parentToolUseId?: string | null): FrameContext {
  return { sessionId, uuid: () => crypto.randomUUID(), parentToolUseId: parentToolUseId ?? null }
}

function base(ctx: FrameContext, type: string): Record<string, unknown> {
  return { type, session_id: ctx.sessionId, uuid: ctx.uuid(), parent_tool_use_id: ctx.parentToolUseId ?? null }
}

export function assistantFrame(
  ctx: FrameContext,
  opts: { model: string; content: ContentBlock[]; stopReason: string | null; usage: Usage },
): Frame {
  return {
    ...base(ctx, 'assistant'),
    message: {
      id: `msg_${crypto.randomUUID()}`,
      type: 'assistant',
      role: 'assistant',
      model: opts.model,
      content: opts.content,
      stop_reason: opts.stopReason,
      usage: opts.usage,
    },
  } as AgentMessage
}

export function toolResultFrame(ctx: FrameContext, toolUseId: string, text: string, isError: boolean): Frame {
  return {
    ...base(ctx, 'user'),
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text }],
        is_error: isError,
      }],
    },
  } as AgentMessage
}

export function apiRetryFrame(
  ctx: FrameContext,
  info: { attempt: number; maxRetries: number; delayMs: number },
): Frame {
  return {
    ...base(ctx, 'system'),
    subtype: 'api_retry',
    attempt: info.attempt,
    max_retries: info.maxRetries,
    retry_delay_ms: info.delayMs,
  } as AgentMessage
}

export function resultFrame(
  ctx: FrameContext,
  opts: {
    result: string
    usage: Usage
    numTurns: number
    durationMs: number
    isError: boolean
    /** Intent-based fast-mode state (`on` when the session's fast intent is
     *  on), stamped on every native result frame so the client's chip is
     *  truthful for a provider with no CLI to report `cooldown`. */
    fastModeState?: 'on' | 'off'
  },
): Frame {
  return {
    ...base(ctx, 'result'),
    subtype: opts.isError ? 'error_during_execution' : 'success',
    runtime: 'native',
    result: opts.result,
    usage: opts.usage,
    num_turns: opts.numTurns,
    duration_ms: opts.durationMs,
    is_error: opts.isError,
    ...(opts.fastModeState !== undefined ? { fast_mode_state: opts.fastModeState } : {}),
  } as unknown as AgentMessage
}

export function streamEventFrame(ctx: FrameContext, event: unknown): Frame {
  return { ...base(ctx, 'stream_event'), event } as AgentMessage
}
