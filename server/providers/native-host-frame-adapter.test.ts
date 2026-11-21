// Reconstruction pin (Task 6, design R1/R2/R6): the host adapter's neutral→SDK
// projection must rebuild EVERY SDK field a host consumer reads, losslessly,
// field-for-field equal to the GOLDEN frame today's frames.ts constructors
// produce from equivalent inputs. The golden is the authoritative contract —
// native's actual emission surface (R6), not the full claude subtype list.
//
// Methodology: each test builds the golden via the legacy constructor with a
// DETERMINISTIC frame context (fixed uuid), builds the neutral counterpart via
// the vocabulary constructors, projects it, and asserts deep equality. The one
// non-deterministic field is the assistant message.id (frames.ts mints a fresh
// crypto.randomUUID()); it is pinned by shape + derivation and normalized out of
// the deep-equality so every other field is compared verbatim.

import { describe, expect, it } from 'vitest'
import {
  apiRetryFrame,
  assistantFrame,
  informationalFrame,
  resultFrame,
  streamEventFrame,
  taskNotificationFrame,
  taskStartedFrame,
  toolResultFrame,
  type ContentBlock as SdkContentBlock,
  type FrameContext,
  type Usage as SdkUsage,
} from './native/frames.js'
import { brandString } from './native/vocabulary/brand.js'
import { createAssistantMessage, createToolResultMessage } from './native/vocabulary/message.js'
import type { ContentBlock, TokenUsage } from './native/vocabulary/types.js'
import type { NativeSessionEvent } from './native/vocabulary/session-event.js'
import {
  projectNativeFrameToSdk,
  projectNativeEventToSdk,
  type NativeAssistantFrame,
  type NativeFrameEnvelope,
  type NativeOperationalEvent,
} from './native-host-frame-adapter.js'

const SESSION = 'sess-1'
const UUID = '11111111-1111-4111-8111-111111111111'
const PARENT = 'toolu_parent'
const MSG_ID_RE = /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Deterministic golden context: uuid() returns the fixed UUID so envelope
 *  fields compare verbatim against the projection's env. */
function ctx(parentToolUseId: string | null = null): FrameContext {
  return { sessionId: SESSION, uuid: () => UUID, parentToolUseId }
}
function env(parentToolUseId: string | null = null, receivedAt?: number): NativeFrameEnvelope {
  return receivedAt === undefined
    ? { sessionId: SESSION, uuid: UUID, parentToolUseId }
    : { sessionId: SESSION, uuid: UUID, parentToolUseId, receivedAt }
}

const SDK_USAGE: SdkUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
}
const NEUTRAL_USAGE: TokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 3,
  cacheWriteTokens: 2,
}

/** The assistant message.id is a fresh mint in BOTH the golden and the
 *  projection. Pin its shape + derivation, then compare every other field
 *  verbatim by normalizing the golden's id to the projected one. */
function expectAssistantEqual(projected: Record<string, any>, golden: Record<string, any>): void {
  expect(projected.message.id).toBe(`msg_${UUID}`)
  expect(golden.message.id).toMatch(MSG_ID_RE)
  expect(projected).toEqual({ ...golden, message: { ...golden.message, id: projected.message.id } })
}

function assistantFrameInput(
  content: ContentBlock[],
  usage: TokenUsage,
  stopReason: string | null,
  model = 'claude-test',
): NativeAssistantFrame {
  const message = createAssistantMessage({
    content,
    source: { provider: 'anthropic', model, replayState: { response: { stop_reason: stopReason } } },
  })
  return { type: 'assistant-frame', message, usage }
}

describe('projectNativeFrameToSdk — assistant reconstruction', () => {
  it('rebuilds text / signed-thinking / redacted / tool_use blocks, usage and model', () => {
    const sdkContent: SdkContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'reasoning', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: 'redacted-blob' },
      { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
    ]
    const neutralContent: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'reasoning', signature: 'sig-abc' },
      { type: 'reasoning', text: '', redacted: true, data: 'redacted-blob' },
      { type: 'tool-call', id: brandString<'ToolCallId'>('toolu_01'), name: 'Bash', arguments: '{"command":"ls"}' },
    ]
    const golden = assistantFrame(ctx(), { model: 'claude-test', content: sdkContent, stopReason: 'tool_use', usage: SDK_USAGE })
    const projected = projectNativeFrameToSdk(assistantFrameInput(neutralContent, NEUTRAL_USAGE, 'tool_use'), env()) as Record<string, any>
    expectAssistantEqual(projected, golden)
    expect(projected.message.model).toBe('claude-test')
    expect(projected.message.stop_reason).toBe('tool_use')
    expect(projected.message.usage).toEqual(SDK_USAGE)
  })

  it('omits the signature key for unsigned thinking (matches the loop)', () => {
    const golden = assistantFrame(ctx(), {
      model: 'claude-test',
      content: [{ type: 'thinking', thinking: 'unsigned' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    })
    const projected = projectNativeFrameToSdk(
      assistantFrameInput([{ type: 'reasoning', text: 'unsigned' }], { inputTokens: 1, outputTokens: 2 }, 'end_turn'),
      env(),
    ) as Record<string, any>
    expectAssistantEqual(projected, golden)
    expect(projected.message.content[0]).toEqual({ type: 'thinking', thinking: 'unsigned' })
    expect('signature' in projected.message.content[0]).toBe(false)
  })

  it('parses tool-call raw-JSON arguments; empty arguments become {}', () => {
    const golden = assistantFrame(ctx(), {
      model: 'claude-test',
      content: [{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: {} }],
      stopReason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    const projected = projectNativeFrameToSdk(
      assistantFrameInput(
        [{ type: 'tool-call', id: brandString<'ToolCallId'>('toolu_02'), name: 'Read', arguments: '' }],
        { inputTokens: 0, outputTokens: 0 },
        'tool_use',
      ),
      env(),
    ) as Record<string, any>
    expectAssistantEqual(projected, golden)
    expect(projected.message.content[0].input).toEqual({})
  })

  it('maps a null stop_reason and cache-free usage verbatim', () => {
    const golden = assistantFrame(ctx(), {
      model: 'claude-test',
      content: [{ type: 'text', text: 'partial' }],
      stopReason: null,
      usage: { input_tokens: 7, output_tokens: 0 },
    })
    const projected = projectNativeFrameToSdk(
      assistantFrameInput([{ type: 'text', text: 'partial' }], { inputTokens: 7, outputTokens: 0 }, null),
      env(),
    ) as Record<string, any>
    expectAssistantEqual(projected, golden)
    expect(projected.message.stop_reason).toBeNull()
    expect(projected.message.usage).toEqual({ input_tokens: 7, output_tokens: 0 })
  })

  it('preserves the sidechain parent (null-vs-string) on the envelope', () => {
    const golden = assistantFrame(ctx(PARENT), { model: 'claude-test', content: [], stopReason: null, usage: { input_tokens: 0, output_tokens: 0 } })
    const projected = projectNativeFrameToSdk(assistantFrameInput([], { inputTokens: 0, outputTokens: 0 }, null), env(PARENT)) as Record<string, any>
    expectAssistantEqual(projected, golden)
    expect(projected.parent_tool_use_id).toBe(PARENT)
    expect(projected.session_id).toBe(SESSION)
    expect(projected.uuid).toBe(UUID)
  })
})

describe('projectNativeFrameToSdk — user tool_result reconstruction', () => {
  it('rebuilds tool_use_id / content / is_error', () => {
    const golden = toolResultFrame(ctx(), 'toolu_01', 'tool output', false, UUID)
    const message = createToolResultMessage({
      callId: brandString<'ToolCallId'>('toolu_01'),
      content: [{ type: 'text', text: 'tool output' }],
      isError: false,
    })
    const projected = projectNativeFrameToSdk(message, env()) as Record<string, any>
    expect(projected).toEqual(golden)
    expect(projected.type).toBe('user')
    expect(projected.message.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: [{ type: 'text', text: 'tool output' }],
      is_error: false,
    })
  })

  it('carries is_error true and an empty text summary', () => {
    const golden = toolResultFrame(ctx(), 'toolu_02', '', true, UUID)
    const message = createToolResultMessage({
      callId: brandString<'ToolCallId'>('toolu_02'),
      content: [{ type: 'text', text: '' }],
      isError: true,
    })
    expect(projectNativeFrameToSdk(message, env())).toEqual(golden)
  })

  it('preserves the sidechain parent on a tool_result envelope', () => {
    const golden = toolResultFrame(ctx(PARENT), 'toolu_03', 'nested', false, UUID)
    const message = createToolResultMessage({
      callId: brandString<'ToolCallId'>('toolu_03'),
      content: [{ type: 'text', text: 'nested' }],
      isError: false,
    })
    const projected = projectNativeFrameToSdk(message, env(PARENT)) as Record<string, any>
    expect(projected).toEqual(golden)
    expect(projected.parent_tool_use_id).toBe(PARENT)
  })
})

describe('projectNativeFrameToSdk — stream_event raw byte-identity (R2)', () => {
  const events: unknown[] = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ]
  for (const event of events) {
    it(`passes ${(event as { type: string }).type} through verbatim (reference identity)`, () => {
      const projected = projectNativeFrameToSdk({ type: 'raw-stream-event', event }, env()) as Record<string, any>
      expect(projected.event).toBe(event)
      expect(projected).toEqual(streamEventFrame(ctx(), event))
      expect(projected.type).toBe('stream_event')
    })
  }

  it('preserves the sidechain parent on a stream_event envelope', () => {
    const event = { type: 'message_stop' }
    const projected = projectNativeFrameToSdk({ type: 'raw-stream-event', event }, env(PARENT)) as Record<string, any>
    expect(projected).toEqual(streamEventFrame(ctx(PARENT), event))
    expect(projected.event).toBe(event)
  })
})

describe('projectNativeFrameToSdk — envelope receivedAt stamp', () => {
  it('stamps receivedAt when the env carries it; omits the key otherwise', () => {
    const event = { type: 'message_stop' }
    const stamped = projectNativeFrameToSdk({ type: 'raw-stream-event', event }, env(null, 1234)) as Record<string, any>
    expect(stamped.receivedAt).toBe(1234)
    const unstamped = projectNativeFrameToSdk({ type: 'raw-stream-event', event }, env()) as Record<string, any>
    expect('receivedAt' in unstamped).toBe(false)
  })
})

describe('projectNativeEventToSdk — operational reconstruction (R6)', () => {
  it('init: fast_mode_state on/off, main-thread null parent', () => {
    const golden = {
      type: 'system', subtype: 'init', session_id: SESSION, uuid: UUID,
      parent_tool_use_id: null, fast_mode_state: 'on',
    }
    const event: NativeOperationalEvent = { type: 'init', sessionId: SESSION, uuid: UUID, parentToolUseId: null, fastMode: true }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
    expect(projectNativeEventToSdk({ ...event, fastMode: false })).toEqual({ ...golden, fast_mode_state: 'off' })
  })

  it('api_retry: attempt / max_retries / retry_delay_ms + envelope', () => {
    const golden = apiRetryFrame(ctx(), { attempt: 3, maxRetries: 10, delayMs: 26_000 })
    const event: NativeOperationalEvent = {
      type: 'api/retry', sessionId: SESSION, uuid: UUID, parentToolUseId: null,
      attempt: 3, maxRetries: 10, delayMs: 26_000,
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('informational: content + warning level + envelope', () => {
    const golden = informationalFrame(ctx(), 'agent selection dropped')
    const event: NativeOperationalEvent = {
      type: 'informational', sessionId: SESSION, uuid: UUID, parentToolUseId: null, text: 'agent selection dropped',
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('task_started: full field set, is_backgrounded, original start time, NO session envelope', () => {
    const golden = taskStartedFrame({
      taskId: 'task-1', toolUseId: 'tu-1', taskType: 'local_agent',
      description: 'inspect the repo', subagentType: 'Explore', receivedAt: 1234,
    })
    const event: NativeOperationalEvent = {
      type: 'task/started', taskId: 'task-1', toolUseId: 'tu-1', taskType: 'local_agent',
      description: 'inspect the repo', subagentType: 'Explore', time: 1234,
    }
    const projected = projectNativeEventToSdk(event) as Record<string, any>
    expect(projected).toEqual(golden)
    expect('session_id' in projected).toBe(false)
    expect('uuid' in projected).toBe(false)
    expect('parent_tool_use_id' in projected).toBe(false)
  })

  it('task_started: omits subagent_type when absent; local_bash task type', () => {
    const golden = taskStartedFrame({
      taskId: 'task-2', toolUseId: 'tu-2', taskType: 'local_bash', description: 'run a shell', receivedAt: 99,
    })
    const event: NativeOperationalEvent = {
      type: 'task/started', taskId: 'task-2', toolUseId: 'tu-2', taskType: 'local_bash', description: 'run a shell', time: 99,
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('task_notification: terminal status, inline result, completion time', () => {
    const golden = taskNotificationFrame({
      taskId: 'task-1', toolUseId: 'tu-1', description: 'inspect the repo',
      status: 'completed', result: 'final report', receivedAt: 5678,
    })
    const event: NativeOperationalEvent = {
      type: 'task/notification', taskId: 'task-1', toolUseId: 'tu-1', description: 'inspect the repo',
      status: 'completed', result: 'final report', time: 5678,
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('task_notification: omits an empty result; carries reason when present', () => {
    const golden = taskNotificationFrame({
      taskId: 'task-3', toolUseId: 'tu-3', description: 'empty output',
      status: 'stopped', result: '', reason: 'worker_restart', receivedAt: 9999,
    })
    const event: NativeOperationalEvent = {
      type: 'task/notification', taskId: 'task-3', toolUseId: 'tu-3', description: 'empty output',
      status: 'stopped', result: '', reason: 'worker_restart', time: 9999,
    }
    const projected = projectNativeEventToSdk(event) as Record<string, any>
    expect(projected).toEqual(golden)
    expect('result' in projected).toBe(false)
    expect(projected.reason).toBe('worker_restart')
  })

  it('result: success subtype, full field set, runtime native, fast_mode_state', () => {
    const golden = resultFrame(ctx(), {
      result: 'done', usage: SDK_USAGE, numTurns: 2, durationMs: 100, isError: false, fastModeState: 'on',
    })
    const event: NativeOperationalEvent = {
      type: 'result', sessionId: SESSION, uuid: UUID, parentToolUseId: null,
      result: 'done', usage: NEUTRAL_USAGE, numTurns: 2, durationMs: 100, isError: false, fastMode: true,
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('result: error subtype maps from isError; fast_mode_state omitted when absent', () => {
    const golden = resultFrame(ctx(), {
      result: 'boom', usage: { input_tokens: 1, output_tokens: 0 }, numTurns: 0, durationMs: 0, isError: true,
    })
    const event: NativeOperationalEvent = {
      type: 'result', sessionId: SESSION, uuid: UUID, parentToolUseId: null,
      result: 'boom', usage: { inputTokens: 1, outputTokens: 0 }, numTurns: 0, durationMs: 0, isError: true,
    }
    const projected = projectNativeEventToSdk(event) as Record<string, any>
    expect(projected).toEqual(golden)
    expect(projected.subtype).toBe('error_during_execution')
    expect('fast_mode_state' in projected).toBe(false)
  })

  it('result: preserves the sidechain parent', () => {
    const golden = resultFrame(ctx(PARENT), {
      result: 'nested', usage: { input_tokens: 0, output_tokens: 0 }, numTurns: 1, durationMs: 0, isError: false,
    })
    const event: NativeOperationalEvent = {
      type: 'result', sessionId: SESSION, uuid: UUID, parentToolUseId: PARENT,
      result: 'nested', usage: { inputTokens: 0, outputTokens: 0 }, numTurns: 1, durationMs: 0, isError: false,
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('durable session events have no live operational projection (null)', () => {
    const event: NativeSessionEvent = { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } }
    expect(projectNativeEventToSdk(event)).toBeNull()
  })
})

describe('projectNativeFrameToSdk — assembler chunks are not host frames', () => {
  it('throws on a StreamChunk (assembler-internal, never projected to the host)', () => {
    expect(() => projectNativeFrameToSdk({ type: 'text-delta', index: 0, text: 'x' }, env())).toThrow()
  })
})

