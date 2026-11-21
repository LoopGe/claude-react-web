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
} from './native/frames.js'
import { brandString } from './native/vocabulary/brand.js'
import { createAssistantMessage, createToolResultMessage } from './native/vocabulary/message.js'
import type { ContentBlock, TokenUsage } from './native/vocabulary/types.js'
import type { NativeSessionEvent } from './native/vocabulary/session-event.js'
import type { AssistantFrame, OperationalFrame, NativeCoreFrame } from './native/vocabulary/live-frame.js'
import type { RequestMessage } from './native/vocabulary/message.js'
import type { NativeSessionCore } from './native/core-contract.js'
import type { AgentMessage, AgentUserMessage, ProviderContentBlock } from '../agent-message.js'
import {
  projectNativeFrameToSdk,
  projectNativeEventToSdk,
  projectSdkInputToNative,
  wrapNativeCore,
  type NativeFrameEnvelope,
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

  it('projects a resolved file block to a neutral FileBlock ref (public identity, no registry path)', () => {
    const resolved = { type: 'file' as const, attachment: { ...FILE_REF, path: '/registry/notes.txt', mediaType: 'text/plain' } }
    const neutral = projectSdkInputToNative(hostUserMsg([resolved, { type: 'text', text: 'inspect' }]))
    expect(neutral.content[0]).toEqual({ type: 'file', attachment: FILE_REF })
    expect(neutral.content[1]).toEqual({ type: 'text', text: 'inspect' })
    // The registry path / observed media type are server-only and never enter the vocabulary.
    expect(neutral.content[0]).not.toHaveProperty('attachment.path')
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

  it('drain keeps the pairing so a terminal failed for the withdrawn parked head still maps to the host uuid', () => {
    const { core, enqueued } = makeFakeCore()
    const persisted: Array<{ uuid: string | undefined; outcome: string }> = []
    const handle = wrapNativeCore(core, {
      onUserMessagePersistence: (m, outcome) => persisted.push({ uuid: m.uuid, outcome }),
    })
    const host = hostUserMsg('parked', 'host-uuid-parked')
    handle.enqueueUserMessage(host)
    // The manager drains its host queue BEFORE interrupt; the core then fires
    // 'failed' for the withdrawn parked head (native-session.ts:1376).
    const drained = handle.drainQueuedInput!()
    expect(drained).toEqual([host])
    expect(() => core.onUserMessagePersistence!(enqueued[0], 'failed')).not.toThrow()
    expect(persisted).toEqual([{ uuid: 'host-uuid-parked', outcome: 'failed' }])
    // 'failed' is terminal: the pairing is now released (a repeat outcome is loud).
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

  it('sendControlMessage delegates to core.enqueueControl (no visible user turn)', () => {
    const { core, control, queued } = makeFakeCore()
    const handle = wrapNativeCore(core, {})
    handle.sendControlMessage(hostUserMsg('seed', 'ctrl-1'))
    expect(control).toHaveLength(1)
    expect(queued).toHaveLength(0)
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

