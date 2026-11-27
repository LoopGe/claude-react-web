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

import { describe, expect, it, vi } from 'vitest'
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
} from './native-frames.js'
import { brandString } from './native/vocabulary/brand.js'
import { createAssistantMessage, createToolResultMessage } from './native/vocabulary/message.js'
import type { ContentBlock, TokenUsage } from './native/vocabulary/types.js'
import type { NativeSessionEvent } from './native/vocabulary/session-event.js'
import type { AssistantFrame, OperationalFrame, NativeCoreFrame, EnvelopedConversationFrame } from './native/vocabulary/live-frame.js'
import type { RequestMessage, ToolResultMessage } from './native/vocabulary/message.js'
import type { NativeSessionCore } from './native/core-contract.js'
import type { AgentMessage, AgentUserMessage, ProviderContentBlock } from '../agent-message.js'
import {
  projectNativeFrameToSdk,
  projectNativeEventToSdk,
  projectNativeEventToSdkLine,
  projectSdkInputToNative,
  wrapNativeCore,
  nativeCoreOf,
  type NativeFrameEnvelope,
} from './native-host-frame-adapter.js'
import { migrateEventToV3 } from './native/session-log/migration.js'
import { historyFromEvents } from './native/session-log/replay.js'
import { extractHistory } from '../recap.js'

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
): AssistantFrame {
  const replayState = { response: { stop_reason: stopReason } }
  const message = createAssistantMessage({
    content,
    source: { provider: 'anthropic', model, replayState },
  })
  // F2: stopReason / model are FIRST-CLASS frame fields (the core populates
  // stopReason from the finish reason). The replay envelope rides along but the
  // projection must not source stop_reason from it.
  return { type: 'assistant-frame', message, usage, stopReason, model, replayState }
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
    const event: OperationalFrame = { type: 'init', sessionId: SESSION, uuid: UUID, parentToolUseId: null, fastMode: true }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
    expect(projectNativeEventToSdk({ ...event, fastMode: false })).toEqual({ ...golden, fast_mode_state: 'off' })
  })

  it('api_retry: attempt / max_retries / retry_delay_ms + envelope', () => {
    const golden = apiRetryFrame(ctx(), { attempt: 3, maxRetries: 10, delayMs: 26_000 })
    const event: OperationalFrame = {
      type: 'api/retry', sessionId: SESSION, uuid: UUID, parentToolUseId: null,
      attempt: 3, maxRetries: 10, delayMs: 26_000,
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('informational: content + warning level + envelope', () => {
    const golden = informationalFrame(ctx(), 'agent selection dropped')
    const event: OperationalFrame = {
      type: 'informational', sessionId: SESSION, uuid: UUID, parentToolUseId: null, text: 'agent selection dropped',
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('task_started: full field set, is_backgrounded, original start time, NO session envelope', () => {
    const golden = taskStartedFrame({
      taskId: 'task-1', toolUseId: 'tu-1', taskType: 'local_agent',
      description: 'inspect the repo', subagentType: 'Explore', receivedAt: 1234,
    })
    const event: OperationalFrame = {
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
    const event: OperationalFrame = {
      type: 'task/started', taskId: 'task-2', toolUseId: 'tu-2', taskType: 'local_bash', description: 'run a shell', time: 99,
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('task_notification: terminal status, inline result, completion time', () => {
    const golden = taskNotificationFrame({
      taskId: 'task-1', toolUseId: 'tu-1', description: 'inspect the repo',
      status: 'completed', result: 'final report', receivedAt: 5678,
    })
    const event: OperationalFrame = {
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
    const event: OperationalFrame = {
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
    const event: OperationalFrame = {
      type: 'result', sessionId: SESSION, uuid: UUID, parentToolUseId: null,
      result: 'done', usage: NEUTRAL_USAGE, numTurns: 2, durationMs: 100, isError: false, fastMode: true,
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('result: error subtype maps from isError; fast_mode_state omitted when absent', () => {
    const golden = resultFrame(ctx(), {
      result: 'boom', usage: { input_tokens: 1, output_tokens: 0 }, numTurns: 0, durationMs: 0, isError: true,
    })
    const event: OperationalFrame = {
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
    const event: OperationalFrame = {
      type: 'result', sessionId: SESSION, uuid: UUID, parentToolUseId: PARENT,
      result: 'nested', usage: { inputTokens: 0, outputTokens: 0 }, numTurns: 1, durationMs: 0, isError: false,
    }
    expect(projectNativeEventToSdk(event)).toEqual(golden)
  })

  it('prompt_suggestion: exact SDK shape — no subtype, no parent_tool_use_id', () => {
    // SDKPromptSuggestionMessage is a top-level message type carrying only
    // type/suggestion/uuid/session_id — the operationalEnvelope helper (which
    // adds subtype + parent_tool_use_id) must NOT be used.
    const event: OperationalFrame = { type: 'prompt/suggestion', sessionId: 's1', uuid: 'u1', parentToolUseId: null, suggestion: '跑测试' }
    const projected = projectNativeEventToSdk(event) as Record<string, any>
    expect(projected).toEqual({ type: 'prompt_suggestion', suggestion: '跑测试', uuid: 'u1', session_id: 's1' })
    expect('subtype' in projected).toBe(false)
    expect('parent_tool_use_id' in projected).toBe(false)
  })

  it('durable session events have no live operational projection (null)', () => {
    const event: NativeSessionEvent = { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } }
    expect(projectNativeEventToSdk(event)).toBeNull()
    const title: NativeSessionEvent = { type: 'session/title', seq: 0, time: 0, data: { title: 'T' } }
    expect(projectNativeEventToSdk(title)).toBeNull()
  })
})

// ── Task 13: durable event → SDK RawLine history-read seam ─────────────────

describe('projectNativeEventToSdkLine — history read seam (T13)', () => {
  const TS = '2026-11-09T00:00:00.000Z'
  const TIME = Date.parse(TS)

  it('projects a user/message to the SDK user line (envelope + content)', () => {
    const event: NativeSessionEvent = {
      type: 'user/message', seq: 3, time: TIME, parentToolUseId: null,
      data: { role: 'user', id: brandString<'MessageId'>('u1'), content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    }
    expect(projectNativeEventToSdkLine(event, SESSION)).toEqual({
      seq: 3, type: 'user', uuid: 'u1', session_id: SESSION, parent_tool_use_id: null, timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    })
  })

  it('carries isCompactSummary and the sidechain parent verbatim', () => {
    const event: NativeSessionEvent = {
      type: 'user/message', seq: 0, time: TIME, parentToolUseId: PARENT,
      data: { role: 'user', id: brandString<'MessageId'>('u2'), content: [{ type: 'text', text: 'seed' }], source: { kind: 'user' }, isCompactSummary: true },
    }
    const line = projectNativeEventToSdkLine(event, SESSION) as Record<string, any>
    expect(line.parent_tool_use_id).toBe(PARENT)
    expect(line.isCompactSummary).toBe(true)
  })

  it('projects an assistant/message with msg_<uuid> id, rawStopReason and usage', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'done' }, { type: 'tool-call', id: brandString<'ToolCallId'>('t1'), name: 'Read', arguments: '{"file":"a"}' }],
      source: { provider: 'anthropic', model: 'claude-test' },
    })
    const event: NativeSessionEvent = {
      type: 'assistant/message', seq: 4, time: TIME, parentToolUseId: null,
      data: { message, stream: [], usage: NEUTRAL_USAGE, rawStopReason: 'stop_sequence' },
    }
    const line = projectNativeEventToSdkLine(event, SESSION) as Record<string, any>
    expect(line.type).toBe('assistant')
    expect(line.uuid).toBe(message.id)
    expect(line.message.id).toBe(`msg_${message.id}`)
    expect(line.message.model).toBe('claude-test')
    // The rare raw reason survives verbatim (the closed FinishReason union
    // cannot express it).
    expect(line.message.stop_reason).toBe('stop_sequence')
    expect(line.message.usage).toEqual(SDK_USAGE)
    expect(line.message.content).toEqual([
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } },
    ])
  })

  it('reconstructs stop_reason from the packed finish record when rawStopReason is absent', () => {
    const message = createAssistantMessage({ content: [{ type: 'text', text: 'x' }], source: { provider: 'anthropic', model: 'm' } })
    const event: NativeSessionEvent = {
      type: 'assistant/message', seq: 0, time: TIME, parentToolUseId: null,
      data: { message, stream: [{ type: 'chunk', time: TIME, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }] },
    }
    expect((projectNativeEventToSdkLine(event, SESSION) as Record<string, any>).message.stop_reason).toBe('tool_use')
  })

  it('projects a tool/result to the SDK user tool_result line', () => {
    const message = createToolResultMessage({ callId: brandString<'ToolCallId'>('t1'), content: [{ type: 'text', text: 'ok' }], isError: false })
    const event: NativeSessionEvent = { type: 'tool/result', seq: 5, time: TIME, parentToolUseId: null, data: { message } }
    expect(projectNativeEventToSdkLine(event, SESSION)).toEqual({
      seq: 5, type: 'user', uuid: message.id, session_id: SESSION, parent_tool_use_id: null, timestamp: TS,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: false }] },
    })
  })

  it('returns null for durable operational events (the reader synthesizes their lines)', () => {
    const compact: NativeSessionEvent = { type: 'session/compact', seq: 0, time: TIME, data: { text: 'S', context: 'C', uuid: 'c1', timestamp: TS } }
    const skill: NativeSessionEvent = { type: 'session/skill', seq: 1, time: TIME, data: { name: 'a', body: 'B', timestamp: TS } }
    const context: NativeSessionEvent = { type: 'session/context', seq: 2, time: 0, data: { text: 'ctx' } }
    expect(projectNativeEventToSdkLine(compact, SESSION)).toBeNull()
    expect(projectNativeEventToSdkLine(skill, SESSION)).toBeNull()
    expect(projectNativeEventToSdkLine(context, SESSION)).toBeNull()
  })

  it('returns null for a session/title event (log-only, never a transcript row)', () => {
    const titleEvent: NativeSessionEvent = { type: 'session/title', seq: 0, time: TIME, data: { title: 'T' } }
    expect(projectNativeEventToSdkLine(titleEvent, SESSION)).toBeNull()
  })

  it('round-trips a migrated legacy message event back to the identical SDK line', () => {
    const legacy = [
      { seq: 0, type: 'user', uuid: 'u1', session_id: SESSION, parent_tool_use_id: null, timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } }] } },
      { seq: 1, type: 'assistant', uuid: 'a1', session_id: SESSION, parent_tool_use_id: null, timestamp: TS, message: { type: 'assistant', role: 'assistant', id: 'msg_original', model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } },
      { seq: 2, type: 'user', uuid: 'r1', session_id: SESSION, parent_tool_use_id: 'agent1', timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bare string', is_error: true }] } },
    ] as const
    for (const event of legacy) {
      const neutral = migrateEventToV3(event as never)
      expect(projectNativeEventToSdkLine(neutral, SESSION)).toEqual(event)
    }
  })
})

describe('projectNativeFrameToSdk — assembler chunks are not host frames', () => {
  it('throws on a StreamChunk (assembler-internal, never projected to the host)', () => {
    expect(() => projectNativeFrameToSdk({ type: 'text-delta', index: 0, text: 'x' }, env())).toThrow()
  })
})

describe('projectNativeFrameToSdk — stopReason is first-class (F2)', () => {
  it('sources stop_reason from the frame field, NOT the replay envelope', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'partial' }],
      // The envelope carries a DIFFERENT stop reason; the projection must ignore it.
      source: { provider: 'anthropic', model: 'claude-test', replayState: { response: { stop_reason: 'end_turn' } } },
    })
    const frame: AssistantFrame = {
      type: 'assistant-frame', message, usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'tool_use', model: 'claude-test',
      replayState: { response: { stop_reason: 'end_turn' } },
    }
    const projected = projectNativeFrameToSdk(frame, env()) as Record<string, any>
    expect(projected.message.stop_reason).toBe('tool_use')
  })

  it('projects a stopReason with no replay envelope present', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'x' }],
      source: { provider: 'anthropic', model: 'claude-test' },
    })
    const frame: AssistantFrame = { type: 'assistant-frame', message, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'max_tokens', model: 'claude-test' }
    const projected = projectNativeFrameToSdk(frame, env()) as Record<string, any>
    expect(projected.message.stop_reason).toBe('max_tokens')
  })
})

// ── Task 7: SDK input → neutral projection ──────────────────────────────

const FILE_REF = { id: 'upload-1', name: 'notes.txt', size: 4, digest: 'a'.repeat(64) }
const IMAGE_REF = { id: `sha256:${'b'.repeat(64)}`, mediaType: 'image/png' as const, bytes: 10, width: 2, height: 3 }

function hostUserMsg(content: AgentUserMessage['message']['content'], uuid = 'host-uuid-1'): AgentUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid,
  } as AgentUserMessage
}

describe('projectSdkInputToNative — lossless content projection', () => {
  it('projects a bare string content to a single neutral TextBlock', () => {
    const neutral = projectSdkInputToNative(hostUserMsg('hello'))
    expect(neutral.role).toBe('user')
    expect(neutral.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('projects text blocks to neutral TextBlocks', () => {
    const neutral = projectSdkInputToNative(hostUserMsg([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]))
    expect(neutral.content).toEqual([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])
  })

  it('retains the full resolved file attachment for the fidelity input (T10: persistence + wire projection consume it)', () => {
    const resolved = { type: 'file' as const, attachment: { ...FILE_REF, path: '/registry/notes.txt', mediaType: 'text/plain' } }
    const neutral = projectSdkInputToNative(hostUserMsg([resolved, { type: 'text', text: 'inspect' }]))
    // The core's durable log + wire request projection (handle text / PDF) need
    // the registry path / media type / model form, so the fidelity input keeps
    // the FULL resolved attachment. The public UI transcript strips it at the
    // history-read boundary (publicNativeHistoryLine), never the client.
    expect(neutral.content[0]).toEqual({ type: 'file', attachment: resolved.attachment })
    expect(neutral.content[1]).toEqual({ type: 'text', text: 'inspect' })
    expect(neutral.content[0]).toHaveProperty('attachment.path', '/registry/notes.txt')
  })

  it('projects a base64 image to a LegacyImageBlock verbatim', () => {
    const base64 = { type: 'image' as const, source: { type: 'base64' as const, data: 'AAAA', media_type: 'image/png' } }
    const neutral = projectSdkInputToNative(hostUserMsg([base64]))
    expect(neutral.content[0]).toEqual({ type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } })
  })

  it('projects a store-backed image ref to an ImageRefBlock', () => {
    // The host input union carries base64 images today; the R5 mixed model also
    // admits store-backed refs, which the projection handles structurally.
    const ref = { type: 'image' as const, attachment: IMAGE_REF } as unknown as ProviderContentBlock
    const neutral = projectSdkInputToNative(hostUserMsg([ref]))
    expect(neutral.content[0]).toEqual({ type: 'image', attachment: IMAGE_REF })
  })

  it('preserves the host uuid as the neutral durable identity (branded MessageId)', () => {
    const neutral = projectSdkInputToNative(hostUserMsg('hi', 'host-uuid-xyz'))
    // Goal-4: the durable log identity must match the host bridge (resume/replay/
    // compact/lease all key on the host uuid), so the neutral id IS the host uuid.
    expect(neutral.id).toBe('host-uuid-xyz')
    expect(neutral.source).toEqual({ kind: 'user' })
    expect(Object.isFrozen(neutral)).toBe(true)
  })

  it('throws loudly when the host message has no uuid identity to preserve', () => {
    const noUuid = { ...hostUserMsg('hi'), uuid: undefined } as unknown as AgentUserMessage
    expect(() => projectSdkInputToNative(noUuid)).toThrow(/uuid identity/)
  })

  it('preserves block order across a mixed text/image/file batch', () => {
    const neutral = projectSdkInputToNative(hostUserMsg([
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', data: 'AA', media_type: 'image/jpeg' } },
      { type: 'file', attachment: { ...FILE_REF, path: '/registry/notes.txt' } },
      { type: 'text', text: 'after' },
    ]))
    expect(neutral.content.map((b) => b.type)).toEqual(['text', 'image', 'file', 'text'])
  })
})

// ── Task 7: wrapNativeCore handle translation ───────────────────────────

interface FakeCore {
  core: NativeSessionCore
  queued: RequestMessage[]
  control: RequestMessage[]
  enqueued: RequestMessage[]
}

function makeFakeCore(opts: { sessionId?: string; frames?: NativeCoreFrame[] } = {}): FakeCore {
  const queued: RequestMessage[] = []
  const control: RequestMessage[] = []
  const enqueued: RequestMessage[] = []
  const frames = opts.frames ?? []
  const core: NativeSessionCore = {
    sessionId: opts.sessionId ?? SESSION,
    messages: (async function* () { for (const f of frames) yield f })(),
    enqueue(msg) { queued.push(msg); enqueued.push(msg) },
    enqueueControl(msg) { control.push(msg) },
    drainQueued() { return queued.splice(0) },
    clearQueued() { const n = queued.length; queued.length = 0; return n },
    get queueDepth() { return queued.length },
    closed: false,
    abortSignal: new AbortController().signal,
    processExited: Promise.resolve(),
    abort() {},
    destroy() {},
    reloadSkills: async () => ({}),
  }
  return { core, queued, control, enqueued }
}

async function collect(iterable: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = []
  for await (const m of iterable) out.push(m)
  return out
}

describe('wrapNativeCore — input identity + drain', () => {
  it('drainQueuedInput returns the original AgentUserMessage[] (equal to legacy), receivedAt preserved', () => {
    const { core } = makeFakeCore()
    const handle = wrapNativeCore(core, {})
    const a = { ...hostUserMsg('one', 'uuid-a'), receivedAt: 1000 } as AgentUserMessage
    const b = { ...hostUserMsg('two', 'uuid-b'), receivedAt: 2000 } as AgentUserMessage
    handle.enqueueUserMessage(a)
    handle.enqueueUserMessage(b)
    const drained = handle.drainQueuedInput!()
    expect(drained).toEqual([a, b])
    expect(drained[0]).toBe(a)
    expect(drained[1]).toBe(b)
    expect((drained[0] as { receivedAt?: number }).receivedAt).toBe(1000)
    expect((drained[1] as { receivedAt?: number }).receivedAt).toBe(2000)
  })

  it('re-keys receivedAt onto the uuid identity (host uuid preserved, arrival kept)', () => {
    const { core, enqueued } = makeFakeCore()
    const handle = wrapNativeCore(core, {})
    const host = { ...hostUserMsg('hi', 'host-uuid-9'), receivedAt: 4242 } as AgentUserMessage
    handle.enqueueUserMessage(host)
    expect(enqueued).toHaveLength(1)
    const neutral = enqueued[0] as { id: string }
    expect(neutral.id).toBe('host-uuid-9')
    // The host arrival time survives the round-trip keyed by the uuid identity.
    const drained = handle.drainQueuedInput!()
    expect((drained[0] as { receivedAt?: number }).receivedAt).toBe(4242)
  })

  it('TRANSFER drain (drainQueuedInput) releases the pairing silently — no host failed, a later outcome is loud (Q1)', () => {
    const { core, enqueued } = makeFakeCore()
    const persisted: Array<{ uuid: string | undefined; outcome: string }> = []
    const handle = wrapNativeCore(core, {
      onUserMessagePersistence: (m, outcome) => persisted.push({ uuid: m.uuid, outcome }),
    })
    const host = hostUserMsg('parked', 'host-uuid-parked')
    handle.enqueueUserMessage(host)
    // respawnInPlace transfer drain: the prompt is MOVED, not abandoned. The
    // adapter releases the pairing silently and fires NO host 'failed' (the
    // manager's send lease is preserved across the re-enqueue).
    const drained = handle.drainQueuedInput!()
    expect(drained).toEqual([host])
    expect(persisted).toEqual([])
    // The pairing is released: a subsequent outcome for the drained id is loud.
    expect(() => core.onUserMessagePersistence!(enqueued[0], 'failed')).toThrow(/unpaired/)
  })

  it('clearQueuedInput delegates to core.clearQueued and returns the count', () => {
    const { core } = makeFakeCore()
    const handle = wrapNativeCore(core, {})
    handle.enqueueUserMessage(hostUserMsg('one', 'u1'))
    handle.enqueueUserMessage(hostUserMsg('two', 'u2'))
    expect(handle.clearQueuedInput()).toBe(2)
    expect(handle.drainQueuedInput!()).toEqual([])
  })

  it('sendControlMessage delegates to core.enqueueControl (no visible user turn, no pairing)', () => {
    const { core, control, queued } = makeFakeCore()
    const handle = wrapNativeCore(core, {})
    handle.sendControlMessage(hostUserMsg('seed', 'ctrl-1'))
    expect(control).toHaveLength(1)
    expect(queued).toHaveLength(0)
    // A control seed never fires an outcome and is never drained, so it must
    // NOT be paired — a pairing entry would be immortal (full host message +
    // arrival retained for the wrapper lifetime). An outcome for it is loud.
    expect(() => core.onUserMessageConsumed!(control[0])).toThrow(/unpaired/)
  })

  it('queueDepth mirrors the core queue depth', () => {
    const { core } = makeFakeCore()
    const handle = wrapNativeCore(core, {})
    expect(handle.queueDepth).toBe(0)
    handle.enqueueUserMessage(hostUserMsg('one', 'u1'))
    expect(handle.queueDepth).toBe(1)
  })
})

describe('wrapNativeCore — lease callbacks wrap core neutral outcomes', () => {
  it('fires onUserMessageConsumed with the host uuid when the core consumes a neutral prompt', () => {
    const { core, enqueued } = makeFakeCore()
    const consumed: AgentUserMessage[] = []
    const handle = wrapNativeCore(core, { onUserMessageConsumed: (m) => consumed.push(m) })
    const host = { ...hostUserMsg('go', 'host-uuid-consume'), receivedAt: 7777 } as AgentUserMessage
    handle.enqueueUserMessage(host)
    core.onUserMessageConsumed!(enqueued[0])
    expect(consumed).toHaveLength(1)
    expect(consumed[0].uuid).toBe('host-uuid-consume')
    // The re-keyed arrival time (keyed by neutral uuid) feeds the host projection.
    expect((consumed[0] as { receivedAt?: number }).receivedAt).toBe(7777)
  })

  it('fires onUserMessagePersistence with the host uuid and the neutral outcome', () => {
    const { core, enqueued } = makeFakeCore()
    const persisted: Array<{ uuid: string | undefined; outcome: string }> = []
    const handle = wrapNativeCore(core, {
      onUserMessagePersistence: (m, outcome) => persisted.push({ uuid: m.uuid, outcome }),
    })
    handle.enqueueUserMessage(hostUserMsg('go', 'host-uuid-persist'))
    core.onUserMessagePersistence!(enqueued[0], 'appended')
    core.onUserMessagePersistence!(enqueued[0], 'failed')
    expect(persisted).toEqual([
      { uuid: 'host-uuid-persist', outcome: 'appended' },
      { uuid: 'host-uuid-persist', outcome: 'failed' },
    ])
  })

  it('preserves copyConsumedAt: a stamp on the projected outcome reaches the original host message', () => {
    const { core, enqueued } = makeFakeCore()
    // Simulate the manager: stamp consumedAt on the message the callback receives.
    const handle = wrapNativeCore(core, {
      onUserMessageConsumed: (m) => { (m as { consumedAt?: number }).consumedAt = 9999 },
    })
    const host = hostUserMsg('go', 'host-uuid-copy')
    handle.enqueueUserMessage(host)
    core.onUserMessageConsumed!(enqueued[0])
    expect((host as { consumedAt?: number }).consumedAt).toBe(9999)
  })

  it('releases the host pairing on consumption (no unbounded growth; a repeat outcome is loud)', () => {
    const { core, enqueued } = makeFakeCore()
    const handle = wrapNativeCore(core, { onUserMessageConsumed: () => {} })
    handle.enqueueUserMessage(hostUserMsg('go', 'host-uuid-release'))
    core.onUserMessageConsumed!(enqueued[0])
    // A consumed prompt is durable + no longer withdrawable; its pairing is gone,
    // so a second outcome for the same neutral id surfaces loudly rather than
    // silently re-firing (and the strong Map does not retain it for the session).
    expect(() => core.onUserMessageConsumed!(enqueued[0])).toThrow(/unpaired/)
  })

  it('forwards onSupplementDelivered unchanged (uuid + outcome are already neutral)', () => {
    const { core } = makeFakeCore()
    core.enqueueSupplement = () => false
    const delivered: Array<{ uuid: string; outcome: unknown }> = []
    const handle = wrapNativeCore(core, { onSupplementDelivered: (uuid, outcome) => delivered.push({ uuid, outcome }) })
    core.onSupplementDelivered!('sup-1', { ok: true, boundary: 'PreToolUse' })
    expect(delivered).toEqual([{ uuid: 'sup-1', outcome: { ok: true, boundary: 'PreToolUse' } }])
    expect(handle.enqueueSupplement!({ uuid: 'sup-2', text: 'pivot' })).toBe(false)
  })
})

describe('wrapNativeCore — messages projects NativeCoreFrame → SDK (identical to legacy)', () => {
  it('projects an assistant frame via projectNativeFrameToSdk with the frame-derived envelope', async () => {
    const af = assistantFrameInput([{ type: 'text', text: 'hello' }], NEUTRAL_USAGE, 'end_turn')
    const { core } = makeFakeCore({ frames: [af] })
    const handle = wrapNativeCore(core, {})
    const [projected] = await collect(handle.messages) as Record<string, any>[]
    const expected = projectNativeFrameToSdk(af, { sessionId: SESSION, uuid: af.message.id, parentToolUseId: null }) as Record<string, any>
    expect(projected).toEqual(expected)
    expect(projected.uuid).toBe(af.message.id)
    expect(projected.session_id).toBe(SESSION)
    expect(projected.parent_tool_use_id).toBeNull()
  })

  it('projects an operational frame via projectNativeEventToSdk (inline envelope)', async () => {
    const init: OperationalFrame = { type: 'init', sessionId: SESSION, uuid: UUID, parentToolUseId: null, fastMode: true }
    const { core } = makeFakeCore({ frames: [init] })
    const handle = wrapNativeCore(core, {})
    const [projected] = await collect(handle.messages)
    expect(projected).toEqual(projectNativeEventToSdk(init))
  })

  it('projects a prompt/suggestion frame on the messages stream (same SDK shape, no parent key)', async () => {
    const suggestion: OperationalFrame = { type: 'prompt/suggestion', sessionId: 's1', uuid: 'u1', parentToolUseId: null, suggestion: '跑测试' }
    const { core } = makeFakeCore({ sessionId: 's1', frames: [suggestion] })
    const handle = wrapNativeCore(core, {})
    const [projected] = await collect(handle.messages) as Record<string, any>[]
    expect(projected).toEqual({ type: 'prompt_suggestion', suggestion: '跑测试', uuid: 'u1', session_id: 's1' })
    expect('subtype' in projected).toBe(false)
    expect('parent_tool_use_id' in projected).toBe(false)
  })

  it('passes a raw stream event through verbatim on the message channel', async () => {
    const event = { type: 'message_stop' }
    const raw: NativeCoreFrame = { type: 'raw-stream-event', event }
    const { core } = makeFakeCore({ frames: [raw] })
    const handle = wrapNativeCore(core, {})
    const [projected] = await collect(handle.messages) as Record<string, any>[]
    expect(projected.type).toBe('stream_event')
    expect(projected.event).toBe(event)
    expect(projected.session_id).toBe(SESSION)
    expect(projected.parent_tool_use_id).toBeNull()
  })

  it('projects a mixed frame stream in order', async () => {
    const af = assistantFrameInput([{ type: 'text', text: 'x' }], { inputTokens: 0, outputTokens: 0 }, null)
    const result: OperationalFrame = { type: 'result', sessionId: SESSION, uuid: UUID, parentToolUseId: null, result: 'done', usage: { inputTokens: 0, outputTokens: 0 }, numTurns: 1, durationMs: 0, isError: false }
    const { core } = makeFakeCore({ frames: [af, result] })
    const handle = wrapNativeCore(core, {})
    const projected = await collect(handle.messages) as Record<string, any>[]
    expect(projected.map((m) => m.type)).toEqual(['assistant', 'result'])
  })
})

describe('wrapNativeCore — control delegation', () => {
  it('delegates interrupt / abort / destroy; interrupt-cancel passes host uuids through and releases the pairing', async () => {
    const { core, enqueued } = makeFakeCore()
    const interrupt = vi.fn(async () => ({ cancelledQueued: [] as string[] }))
    const abort = vi.fn()
    const destroy = vi.fn(async () => {})
    core.interrupt = interrupt
    core.abort = abort
    core.destroy = destroy
    const handle = wrapNativeCore(core, { onUserMessageConsumed: () => {} })
    handle.enqueueUserMessage(hostUserMsg('queued', 'host-uuid-cancel'))
    const neutralId = (enqueued[0] as { id: string }).id
    // Identity preserved: the neutral id IS the host uuid.
    expect(neutralId).toBe('host-uuid-cancel')
    interrupt.mockResolvedValue({ cancelledQueued: [neutralId] })
    const receipt = await handle.interrupt!({ cancelQueued: true })
    expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true })
    expect(receipt).toEqual({ cancelledQueued: ['host-uuid-cancel'] })
    // Withdrawn entries release the pairing (no leak): a later outcome is loud.
    expect(() => core.onUserMessageConsumed!(enqueued[0])).toThrow(/unpaired/)
    handle.abort()
    expect(abort).toHaveBeenCalled()
    await handle.destroy('reason')
    expect(destroy).toHaveBeenCalledWith('reason')
  })

  it('exposes core lifecycle reads (closed / abortSignal / processExited / echoesUserPrompts)', () => {
    const { core } = makeFakeCore()
    const handle = wrapNativeCore(core, {})
    expect(handle.closed).toBe(false)
    expect(handle.abortSignal).toBe(core.abortSignal)
    expect(handle.processExited).toBe(core.processExited)
    expect(handle.echoesUserPrompts).toBe(false)
    expect(handle.provider).toBe('native')
  })

  it('delegates getEffectiveSettings / getContextUsage / compactInPlace neutrally', async () => {
    const { core } = makeFakeCore()
    core.getEffectiveSettings = () => ({ model: 'claude-test', agent: null })
    core.getContextUsage = async () => ({ totalTokens: 5 })
    core.compactInPlace = vi.fn(async () => {})
    const handle = wrapNativeCore(core, {})
    expect(handle.getEffectiveSettings!()).toEqual({ model: 'claude-test', agent: null })
    expect(await handle.getContextUsage!()).toEqual({ totalTokens: 5 })
    await handle.compactInPlace!('summary', { uuid: 'c1', timestamp: 't' })
    expect(core.compactInPlace).toHaveBeenCalledWith('summary', { uuid: 'c1', timestamp: 't' })
  })
})

// ── Task 10: neutral core emission (enveloped conversation + tool results) ──

describe('wrapNativeCore — T10 enveloped conversation emission', () => {
  it('projects an enveloped assistant frame with the sidechain parent', async () => {
    const af = assistantFrameInput([{ type: 'text', text: 'nested' }], NEUTRAL_USAGE, 'end_turn')
    const enveloped: EnvelopedConversationFrame = { type: 'enveloped-conversation', frame: af, parentToolUseId: PARENT }
    const { core } = makeFakeCore({ frames: [enveloped] })
    const handle = wrapNativeCore(core, {})
    const [projected] = await collect(handle.messages) as Record<string, any>[]
    expect(projected.parent_tool_use_id).toBe(PARENT)
    expect(projected.uuid).toBe(af.message.id)
    expect(projected.message.content[0]).toEqual({ type: 'text', text: 'nested' })
  })

  it('projects an enveloped raw stream event verbatim with the sidechain parent', async () => {
    const event = { type: 'message_stop' }
    const enveloped: EnvelopedConversationFrame = { type: 'enveloped-conversation', frame: { type: 'raw-stream-event', event }, parentToolUseId: PARENT }
    const { core } = makeFakeCore({ frames: [enveloped] })
    const handle = wrapNativeCore(core, {})
    const [projected] = await collect(handle.messages) as Record<string, any>[]
    expect(projected.type).toBe('stream_event')
    expect(projected.event).toBe(event)
    expect(projected.parent_tool_use_id).toBe(PARENT)
  })

  it('projects an enveloped first-class tool result with the sidechain parent and shared uuid', async () => {
    const toolResult = createToolResultMessage({
      callId: brandString<'ToolCallId'>('toolu_01'),
      content: [{ type: 'text', text: 'output' }],
      isError: false,
    })
    const enveloped: EnvelopedConversationFrame = { type: 'enveloped-conversation', frame: toolResult, parentToolUseId: PARENT }
    const { core } = makeFakeCore({ frames: [enveloped] })
    const handle = wrapNativeCore(core, {})
    const [projected] = await collect(handle.messages) as Record<string, any>[]
    expect(projected.type).toBe('user')
    expect(projected.uuid).toBe(toolResult.id)
    expect(projected.parent_tool_use_id).toBe(PARENT)
    expect(projected.message.content[0]).toEqual({
      type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'output' }], is_error: false,
    })
  })

  it('projects a bare first-class tool result with a null parent (main thread)', async () => {
    const toolResult: ToolResultMessage = createToolResultMessage({
      callId: brandString<'ToolCallId'>('toolu_02'),
      content: [{ type: 'text', text: 'main' }],
      isError: true,
    })
    const { core } = makeFakeCore({ frames: [toolResult] })
    const handle = wrapNativeCore(core, {})
    const [projected] = await collect(handle.messages) as Record<string, any>[]
    expect(projected.parent_tool_use_id).toBeNull()
    expect(projected.uuid).toBe(toolResult.id)
    expect(projected.message.content[0].is_error).toBe(true)
  })

  it('a main-thread enveloped frame (null parent) projects identically to the bare frame', async () => {
    const af = assistantFrameInput([{ type: 'text', text: 'x' }], NEUTRAL_USAGE, 'end_turn')
    const enveloped: EnvelopedConversationFrame = { type: 'enveloped-conversation', frame: af, parentToolUseId: null }
    const { core } = makeFakeCore({ frames: [enveloped] })
    const handle = wrapNativeCore(core, {})
    const [projected] = await collect(handle.messages) as Record<string, any>[]
    expect(projected).toEqual(projectNativeFrameToSdk(af, { sessionId: SESSION, uuid: af.message.id, parentToolUseId: null }))
  })
})

describe('wrapNativeCore — drain modes: withdrawal fires failed, transfer preserves the lease (Q1)', () => {
  /** A fake core mirroring the T10 drain-mode contract: a WITHDRAWAL drain fires
   *  terminal 'failed' per entry; a TRANSFER drain fires nothing (the adapter
   *  releases the pairing silently). */
  function makeDrainingCore() {
    const queued: RequestMessage[] = []
    const enqueued: RequestMessage[] = []
    const core: NativeSessionCore = {
      sessionId: SESSION,
      messages: (async function* () {})(),
      enqueue(msg) { queued.push(msg); enqueued.push(msg) },
      enqueueControl() {},
      drainQueued(mode = 'withdrawal') {
        const drained = queued.splice(0)
        if (mode === 'withdrawal') {
          for (const msg of drained) core.onUserMessagePersistence?.(msg, 'failed')
        }
        return drained
      },
      clearQueued() { return core.drainQueued('withdrawal').length },
      get queueDepth() { return queued.length },
      closed: false,
      abortSignal: new AbortController().signal,
      processExited: Promise.resolve(),
      abort() {},
      destroy() {},
      reloadSkills: async () => ({}),
    }
    return { core, enqueued }
  }

  it('TRANSFER drain (drainQueuedInput) preserves the send lease: no failed, pairing released silently, hosts returned', () => {
    const { core, enqueued } = makeDrainingCore()
    // Model the manager's session-scoped send lease: acquired at send, released
    // only by a host persistence outcome (appended/failed) or the manager's own
    // withdrawal release. The re-enqueue never re-acquires it.
    const leased = new Set<string>()
    const persisted: Array<{ uuid: string | undefined; outcome: string }> = []
    const handle = wrapNativeCore(core, {
      onUserMessagePersistence: (m, outcome) => {
        persisted.push({ uuid: m.uuid, outcome })
        leased.delete(m.uuid!) // the host lease callback releases the send lease
      },
    })
    const a = hostUserMsg('one', 'uuid-a')
    const b = hostUserMsg('two', 'uuid-b')
    leased.add('uuid-a'); leased.add('uuid-b') // sendContent acquired the leases
    handle.enqueueUserMessage(a)
    handle.enqueueUserMessage(b)
    // respawnInPlace transfer drain.
    const drained = handle.drainQueuedInput!()
    expect(drained).toEqual([a, b])
    expect(drained[0]).toBe(a)
    expect(drained[1]).toBe(b)
    // NO host 'failed' fired → the send lease is PRESERVED across the transfer.
    expect(persisted).toEqual([])
    expect(leased.has('uuid-a')).toBe(true)
    expect(leased.has('uuid-b')).toBe(true)
    // The pairing is released SILENTLY (no orphan): a repeat outcome is loud.
    expect(() => core.onUserMessagePersistence!(enqueued[0], 'failed')).toThrow(/unpaired/)
    // The re-enqueue onto the fresh handle re-pairs and the lease is still held;
    // consumption later releases it via 'appended'.
    handle.enqueueUserMessage(a)
    core.onUserMessagePersistence!(enqueued[0], 'appended')
    expect(persisted).toEqual([{ uuid: 'uuid-a', outcome: 'appended' }])
    expect(leased.has('uuid-a')).toBe(false)
  })

  it('WITHDRAWAL clearQueuedInput fires failed per entry (releases lease + pairing) and returns the count', () => {
    const { core } = makeDrainingCore()
    const leased = new Set<string>(['u1', 'u2'])
    const persisted: string[] = []
    const handle = wrapNativeCore(core, {
      onUserMessagePersistence: (m) => { persisted.push(m.uuid!); leased.delete(m.uuid!) },
    })
    handle.enqueueUserMessage(hostUserMsg('one', 'u1'))
    handle.enqueueUserMessage(hostUserMsg('two', 'u2'))
    expect(handle.clearQueuedInput()).toBe(2)
    expect(persisted).toEqual(['u1', 'u2'])
    expect(leased.size).toBe(0) // withdrawal released the send leases
    expect(handle.drainQueuedInput!()).toEqual([])
  })

  it('WITHDRAWAL interrupt-cancel fires failed per entry, returns the receipt, and releases the pairing', async () => {
    const { core, enqueued } = makeDrainingCore()
    const leased = new Set<string>(['host-uuid-cancel'])
    const persisted: string[] = []
    core.interrupt = async (opts) => {
      if (!opts?.cancelQueued) return undefined
      const drained = core.drainQueued('withdrawal')
      return { cancelledQueued: drained.map((m) => (m as { id: string }).id) }
    }
    const handle = wrapNativeCore(core, {
      onUserMessagePersistence: (m) => { persisted.push(m.uuid!); leased.delete(m.uuid!) },
    })
    handle.enqueueUserMessage(hostUserMsg('queued', 'host-uuid-cancel'))
    const receipt = await handle.interrupt!({ cancelQueued: true })
    expect(receipt).toEqual({ cancelledQueued: ['host-uuid-cancel'] })
    expect(persisted).toEqual(['host-uuid-cancel'])
    expect(leased.size).toBe(0) // withdrawal released the send lease
    // The withdrawn pairing is released: a later outcome is loud.
    expect(() => core.onUserMessageConsumed!(enqueued[0])).toThrow(/unpaired/)
  })

  it('the withdrawn parked head terminal failed maps via the pairing to the host uuid', () => {
    const { core, enqueued } = makeDrainingCore()
    const persisted: Array<{ uuid: string | undefined; outcome: string }> = []
    const handle = wrapNativeCore(core, {
      onUserMessagePersistence: (m, outcome) => persisted.push({ uuid: m.uuid, outcome }),
    })
    const parked = hostUserMsg('parked', 'host-uuid-parked')
    handle.enqueueUserMessage(parked)
    // A withdrawal drain fires the terminal 'failed' for the parked head; the
    // adapter maps it back to the host uuid via the (still-live) pairing.
    core.drainQueued('withdrawal')
    expect(persisted).toEqual([{ uuid: 'host-uuid-parked', outcome: 'failed' }])
    expect(() => core.onUserMessagePersistence!(enqueued[0], 'failed')).toThrow(/unpaired/)
  })
})

describe('wrapNativeCore — core seam + pre-fidelity input projection', () => {
  it('nativeCoreOf returns the wrapped neutral core', () => {
    const { core } = makeFakeCore()
    const handle = wrapNativeCore(core, {})
    expect(nativeCoreOf(handle)).toBe(core)
  })

  it('projectInput pre-projects the host input but pairs the ORIGINAL host message', () => {
    const { core, enqueued } = makeFakeCore()
    const consumed: AgentUserMessage[] = []
    // A pre-fidelity-style projection that rewrites content (handle text) while
    // preserving the uuid identity.
    const projectInput = (host: AgentUserMessage): AgentUserMessage => ({
      ...host,
      message: { role: 'user', content: [{ type: 'text', text: 'projected' }] },
    }) as AgentUserMessage
    const handle = wrapNativeCore(core, { onUserMessageConsumed: (m) => consumed.push(m) }, { projectInput })
    const host = hostUserMsg([{ type: 'text', text: 'original' }], 'host-uuid-pi')
    handle.enqueueUserMessage(host)
    // The core received the PROJECTED neutral content...
    expect((enqueued[0] as unknown as { content: Array<{ text: string }> }).content[0].text).toBe('projected')
    // ...but the pairing keys on the ORIGINAL host (uuid preserved).
    core.onUserMessageConsumed!(enqueued[0])
    expect(consumed[0].uuid).toBe('host-uuid-pi')
    expect(consumed[0].message.content).toEqual([{ type: 'text', text: 'original' }])
    // drain returns the ORIGINAL host, not the projected form.
  })
})

// ── Followup B: authoritative compaction input (getCompactionInput) ──────
//
// The handle's getCompactionInput projects the provider's UNCAPPED neutral
// model history (historyFromEvents — floored at the last compact, sidechain
// excluded) to SDK shape, recovers the floor summary's isCompactSummary
// identity, and drops the context snapshot so recap's extractHistory keeps the
// prior summary as a FULL-TEXT System line and never counts the context as a
// human turn. These tests drive the REAL replay over a constructed neutral log
// and the REAL extractHistory consumer, not a hand-built SDK array.

describe('wrapNativeCore — getCompactionInput authoritative model-history projection', () => {
  const TS = '2026-11-26T00:00:00.000Z'
  const TIME = Date.parse(TS)
  // Longer than recap's 500-char User/Assistant truncation cap, so a System
  // line that still carries the whole string proves the summary was NOT
  // truncated (the B4 identity-recovery requirement).
  const SUMMARY = 'SUMMARY of the prior conversation. ' + 'detail '.repeat(120)
  const CTX = '<system-reminder>Working directory: /repo\nCurrent time: 2026-11-26T00:00:00.000Z</system-reminder>'

  function compactionEvents(): NativeSessionEvent[] {
    const preUser: NativeSessionEvent = {
      type: 'user/message', seq: 0, time: TIME, parentToolUseId: null,
      data: { role: 'user', id: brandString<'MessageId'>('u-pre'), content: [{ type: 'text', text: 'pre-compact question' }], source: { kind: 'user' } },
    }
    const preAssistant: NativeSessionEvent = {
      type: 'assistant/message', seq: 1, time: TIME, parentToolUseId: null,
      data: { message: createAssistantMessage({ content: [{ type: 'text', text: 'pre-compact answer' }], source: { provider: 'anthropic', model: 'm' } }), stream: [] },
    }
    const compact: NativeSessionEvent = {
      type: 'session/compact', seq: 2, time: TIME,
      data: { text: SUMMARY, context: CTX, uuid: 'c1', timestamp: TS, retainHistory: true, summaryUuid: 'sum-1' },
    }
    const postUser: NativeSessionEvent = {
      type: 'user/message', seq: 3, time: TIME, parentToolUseId: null,
      data: {
        role: 'user', id: brandString<'MessageId'>('u-post'), source: { kind: 'user' },
        content: [
          { type: 'text', text: 'post-compact question' },
          { type: 'file', attachment: { id: 'sha256:aa', name: 'f.txt', size: 10, digest: 'aa' } },
          { type: 'image', attachment: { id: 'sha256:bb', mediaType: 'image/png', bytes: 5, width: 1, height: 1 } },
        ],
      },
    }
    const postAssistant: NativeSessionEvent = {
      type: 'assistant/message', seq: 4, time: TIME, parentToolUseId: null,
      data: {
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'thinking hard', signature: 'sig-1' },
            { type: 'text', text: 'post-compact answer' },
            { type: 'tool-call', id: brandString<'ToolCallId'>('toolu_agent'), name: 'Agent', arguments: '{"prompt":"do"}' },
          ],
          source: { provider: 'anthropic', model: 'm' },
        }),
        stream: [],
      },
    }
    // The subagent RESULT lives in the MAIN history (Agent tool_result) and
    // carries a nested file block — it must survive the projection.
    const agentResult: NativeSessionEvent = {
      type: 'tool/result', seq: 5, time: TIME, parentToolUseId: null,
      data: {
        message: createToolResultMessage({
          callId: brandString<'ToolCallId'>('toolu_agent'),
          content: [
            { type: 'text', text: 'subagent result report' },
            { type: 'file', attachment: { id: 'sha256:cc', name: 'r.txt', size: 3, digest: 'cc' } },
          ],
          isError: false,
        }),
      },
    }
    // Sidechain internals (non-null parent) belong to the transcript UI, not
    // the model history — both must be excluded.
    const sideAssistant: NativeSessionEvent = {
      type: 'assistant/message', seq: 6, time: TIME, parentToolUseId: 'toolu_agent',
      data: { message: createAssistantMessage({ content: [{ type: 'text', text: 'subagent-internal-chatter' }], source: { provider: 'anthropic', model: 'm' } }), stream: [] },
    }
    const sideResult: NativeSessionEvent = {
      type: 'tool/result', seq: 7, time: TIME, parentToolUseId: 'toolu_agent',
      data: { message: createToolResultMessage({ callId: brandString<'ToolCallId'>('toolu_inner'), content: [{ type: 'text', text: 'subagent-internal-chatter' }], isError: false }) },
    }
    return [preUser, preAssistant, compact, postUser, postAssistant, agentResult, sideAssistant, sideResult]
  }

  function makeCompactionCore(events: NativeSessionEvent[], boundary: { text: string; context: string } | null): NativeSessionCore {
    const history = historyFromEvents(events)
    return {
      ...makeFakeCore().core,
      getCompactionHistory: () => history,
      getCompactionBoundary: () => boundary,
    }
  }

  it('projects model history to SDK with summary identity, excludes sidechain + pre-compact floor', () => {
    const core = makeCompactionCore(compactionEvents(), { text: SUMMARY, context: CTX })
    const handle = wrapNativeCore(core, {})
    const input = handle.getCompactionInput!() as Array<Record<string, any>>

    // Floor summary identity recovered (B4): exactly one isCompactSummary user
    // message carrying the full summary text.
    const summaries = input.filter((m) => m.isCompactSummary === true)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].type).toBe('user')
    expect(JSON.stringify(summaries[0].message.content)).toContain('SUMMARY')

    const serialized = JSON.stringify(input)
    // The compact floor supersedes the pre-compact conversation.
    expect(serialized).not.toContain('pre-compact question')
    expect(serialized).not.toContain('pre-compact answer')
    // Sidechain internals excluded; the subagent RESULT (main history) kept.
    expect(serialized).not.toContain('subagent-internal-chatter')
    expect(serialized).toContain('subagent result report')
    // Post-compact conversation present.
    expect(serialized).toContain('post-compact question')
    expect(serialized).toContain('post-compact answer')
    // The context snapshot is dropped (not a user turn).
    expect(serialized).not.toContain('Working directory: /repo')

    // Block coverage: signed thinking, attachment refs (direct + nested), image
    // ref, and the Agent tool_use all survive the projection.
    const assistant = input.find((m) => m.type === 'assistant')!
    expect(assistant.message.content).toEqual([
      { type: 'thinking', thinking: 'thinking hard', signature: 'sig-1' },
      { type: 'text', text: 'post-compact answer' },
      { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: 'do' } },
    ])
    const postUser = input.find((m) => m.type === 'user' && m.uuid === 'u-post')!
    expect(postUser.message.content).toEqual([
      { type: 'text', text: 'post-compact question' },
      { type: 'file', attachment: { id: 'sha256:aa', name: 'f.txt', size: 10, digest: 'aa' } },
      { type: 'image', attachment: { id: 'sha256:bb', mediaType: 'image/png', bytes: 5, width: 1, height: 1 } },
    ])
    const toolResult = input.find((m) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.type === 'tool_result')!
    expect(toolResult.message.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_agent',
      content: [
        { type: 'text', text: 'subagent result report' },
        { type: 'file', attachment: { id: 'sha256:cc', name: 'r.txt', size: 3, digest: 'cc' } },
      ],
      is_error: false,
    })
  })

  it('extractHistory keeps the prior summary full-text System and counts no context user turn', () => {
    const core = makeCompactionCore(compactionEvents(), { text: SUMMARY, context: CTX })
    const handle = wrapNativeCore(core, {})
    const input = handle.getCompactionInput!()
    const { lines, stats } = extractHistory(input)

    // Only the genuine post-compact human turn counts (the tool_result-only
    // user message is skipped by extractHistory; the summary is System; the
    // context snapshot is absent).
    expect(stats.userTurns).toBe(1)
    const systemLines = lines.filter((l) => l.role === 'System')
    expect(systemLines).toHaveLength(1)
    // Full text retained — well beyond the 500-char ordinary-line cap.
    expect(systemLines[0].text.length).toBeGreaterThan(500)
    expect(systemLines[0].text).toContain('SUMMARY')
    expect(lines.some((l) => l.role === 'User' && l.text.includes('Working directory'))).toBe(false)
  })

  it('projects every message plainly when the log has no compact boundary', () => {
    const events = compactionEvents().filter((e) => e.type !== 'session/compact')
    const core = makeCompactionCore(events, null)
    const handle = wrapNativeCore(core, {})
    const input = handle.getCompactionInput!() as Array<Record<string, any>>
    expect(input.some((m) => m.isCompactSummary === true)).toBe(false)
    // No floor: the pre-compact conversation is retained.
    expect(JSON.stringify(input)).toContain('pre-compact question')
  })

  it('omits getCompactionInput when the core exposes no neutral history accessor', () => {
    const { core } = makeFakeCore()
    const handle = wrapNativeCore(core, {})
    expect(handle.getCompactionInput).toBeUndefined()
  })
})

