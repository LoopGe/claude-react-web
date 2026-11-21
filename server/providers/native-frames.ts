// server/providers/native-frames.ts
//
// ADAPTER-SIDE legacy SDK frame builders (option C relocation of the former
// native/frames.ts). The neutral core emits the vocabulary's live frames
// (native/vocabulary/live-frame.ts) and the host adapter
// (native-host-frame-adapter.ts) owns the production SDK projection; these
// SDK-shaped constructors survive for the test suite, which builds legacy
// frames directly. This module lives OUTSIDE native/ so the core neutrality
// pin (native/vocabulary/neutrality.test.ts) sees zero SDK frame vocabulary
// inside the core tree. The neutral identity facts (FrameContext /
// defaultFrameContext / Usage) relocated to the vocabulary; they are
// re-exported here so existing consumers keep one import site.
import type { AgentMessage } from '../agent-message.js'
import type { FrameContext } from './native/vocabulary/frame-context.js'
import type { Usage } from './native/vocabulary/types.js'

export { defaultFrameContext, type FrameContext } from './native/vocabulary/frame-context.js'
export { isRetainedThinkingBlock, type Usage } from './native/vocabulary/types.js'

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

function base(ctx: FrameContext, type: string, uuid = ctx.uuid()): Record<string, unknown> {
  return { type, session_id: ctx.sessionId, uuid, parent_tool_use_id: ctx.parentToolUseId ?? null }
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

export function toolResultFrame(ctx: FrameContext, toolUseId: string, text: string, isError: boolean, uuid?: string): Frame {
  return {
    ...base(ctx, 'user', uuid),
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

export function informationalFrame(ctx: FrameContext, text: string): Frame {
  return {
    ...base(ctx, 'system'),
    subtype: 'informational',
    content: text,
    level: 'warning',
  } as AgentMessage
}

export function taskStartedFrame(opts: {
  taskId: string
  toolUseId: string
  taskType: 'local_bash' | 'local_agent'
  description: string
  subagentType?: string
  receivedAt: number
}): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: opts.taskId,
    tool_use_id: opts.toolUseId,
    task_type: opts.taskType,
    description: opts.description,
    ...(opts.subagentType !== undefined ? { subagent_type: opts.subagentType } : {}),
    is_backgrounded: true,
    receivedAt: opts.receivedAt,
  } as unknown as AgentMessage
}

export function taskNotificationFrame(opts: {
  taskId: string
  toolUseId: string
  description: string
  status: 'completed' | 'failed' | 'stopped'
  result?: string
  reason?: 'worker_restart'
  receivedAt: number
}): Frame {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: opts.taskId,
    tool_use_id: opts.toolUseId,
    description: opts.description,
    status: opts.status,
    ...(opts.result ? { result: opts.result } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    receivedAt: opts.receivedAt,
  } as unknown as AgentMessage
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
