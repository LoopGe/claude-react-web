import { describe, it, expect, expectTypeOf } from 'vitest'
import { brandString, type ToolCallId } from './brand.js'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type UserMessage,
} from './message.js'
import type { TokenUsage } from './types.js'
import {
  hasContiguousSeq,
  isSidechainEvent,
  type AssistantStreamRecord,
  type JsonValue,
  type NativeSessionEvent,
  type NativeSessionHeader,
  type NativeTurnEndReason,
  type SessionEvent,
  type SessionEventMap,
  type SessionSeq,
} from './session-event.js'
import type { NativeAgentBase, NativeAgentProfile } from './agent-profile.js'
// PF3 identity pins: the relocated neutral types must stay structurally
// identical to the host-side originals (type-only imports — erased at runtime,
// so this vocabulary test executes no host module).
import type {
  NativeAgentBase as HostNativeAgentBase,
  NativeAgentProfile as HostNativeAgentProfile,
} from '../agent-profile.js'
import type { StoredAgentDefinition as NeutralStoredAgentDefinition } from '../../../../shared/agent-definitions.js'
import type { StoredAgentDefinition as HostStoredAgentDefinition } from '../../../agent-definition-store.js'
import type { NativeFileAttachment } from '../../../../shared/attachment-types.js'

const callId: ToolCallId = brandString<'ToolCallId'>('toolu_01abc')
const timestamp = '2026-11-21T00:00:00.000Z'

const userMessage: UserMessage = createUserMessage({
  content: [
    { type: 'text', text: 'hello' },
    // R5 mixed image model: store-backed ref AND legacy inline base64.
    { type: 'image', attachment: { id: 'img-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
    { type: 'image', source: { type: 'base64', data: 'aGk=', media_type: 'image/png' } },
    { type: 'file', attachment: { id: 'file-1', name: 'a.txt', size: 2, digest: 'b'.repeat(64) } },
  ],
  source: { kind: 'user' },
})

const assistantMessage: AssistantMessage = createAssistantMessage({
  content: [
    { type: 'reasoning', text: 'thinking', signature: 'sig-abc' },
    { type: 'text', text: 'hi' },
    { type: 'tool-call', id: callId, name: 'Read', arguments: '{"file_path":"a.ts"}' },
  ],
  source: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
})

const toolMessage: ToolResultMessage = createToolResultMessage({
  callId,
  content: [{ type: 'text', text: 'file contents' }],
  isError: false,
})

const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 }

const stream: AssistantStreamRecord[] = [
  { type: 'reasoning-chunks', time0: 1000, index: 0, dt: [0, 20], texts: ['think', 'ing'] },
  { type: 'text-chunks', time0: 1100, index: 1, dt: [0, 10, 10], texts: ['h', 'i', '!'] },
  { type: 'tool-call-chunks', time0: 1200, index: 2, dt: [0, 5], id: callId, name: 'Read', args: ['{"file_', 'path":"a.ts"}'] },
  { type: 'chunk', time: 1300, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } },
]

const profile: NativeAgentProfile = {
  name: 'reviewer',
  instruction: 'review carefully',
  model: 'sonnet',
  tools: ['Read', 'Grep'],
  mcpServers: ['git-tools'],
  permissionMode: 'default',
  maxTurns: 5,
  effort: 'high',
}

const base: NativeAgentBase = {
  model: 'sonnet',
  permissionMode: 'default',
  effortLevel: 'high',
  skillPolicy: 'all',
  toolProfile: { tools: ['Read'], toolAliases: { Bash: 'mcp__workspace__bash' } },
}

const definition: NeutralStoredAgentDefinition = {
  name: 'reviewer',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  description: 'reviews code',
  prompt: 'review carefully',
  model: 'sonnet',
  tools: ['Read'],
  mcpServers: ['git-tools'],
  permissionMode: 'default',
  maxTurns: 5,
  effort: 'high',
}

const handleAttachment: NativeFileAttachment = {
  id: 'up-1',
  name: 'notes.txt',
  size: 12,
  digest: 'a'.repeat(64),
  path: '/registry/notes.txt',
  modelForm: 'handle',
}

const pdfAttachment: NativeFileAttachment = {
  id: 'up-2',
  name: 'spec.pdf',
  size: 2048,
  digest: 'c'.repeat(64),
  path: '/registry/spec.pdf',
  mediaType: 'application/pdf',
  modelForm: 'pdf-document',
}

/** One fixture per durable key — the 12 neutral counterparts of today's
 *  11-event v1/v2 union (tool results split out of user content into their
 *  own first-class event). */
const fixtures: NativeSessionEvent[] = [
  { type: 'user/message', seq: 0, time: 1000, data: userMessage, parentToolUseId: null },
  {
    type: 'assistant/message',
    seq: 1,
    time: 1100,
    data: { message: assistantMessage, stream, usage, interrupted: true },
    parentToolUseId: null,
  },
  {
    type: 'tool/result',
    seq: 2,
    time: 1200,
    data: {
      message: toolMessage,
      error: { name: 'ToolError', code: 'E_TIMEOUT', reason: 'tool ran too long' },
      meta: { toolUseId: 'toolu_01abc', durationMs: 42, nested: { ok: true, tags: ['a', 'b'] } },
    },
    parentToolUseId: null,
  },
  { type: 'session/context', seq: 3, time: 1300, data: { text: '<system-reminder>context</system-reminder>' } },
  { type: 'turn/end', seq: 4, time: 1400, data: { reason: 'completed', usage } },
  { type: 'session/end-seed', seq: 5, time: 1500, data: { inherited: true } },
  { type: 'session/compact', seq: 6, time: 1600, data: { text: 'summary', context: 'opening context', uuid: 'uuid-compact', timestamp } },
  { type: 'session/supplement', seq: 7, time: 1700, data: { uuid: 'uuid-supplement', text: 'wrapped guidance', timestamp } },
  { type: 'session/skill', seq: 8, time: 1800, data: { name: 'code-review', body: 'SKILL.md body', timestamp } },
  {
    type: 'subagent/descriptor',
    seq: 9,
    time: 1900,
    data: { toolUseId: callId, parentToolUseId: null, kind: 'agent', toolName: 'Agent', label: 'reviewer', depth: 1, profile, timestamp },
  },
  { type: 'session/attachments', seq: 10, time: 2000, data: { attachments: [handleAttachment, pdfAttachment], timestamp } },
  { type: 'session/agent', seq: 11, time: 2100, data: { name: 'reviewer', definition, base, timestamp } },
]

/** Optional-field-free variants: every optional absent, sidechain parents,
 *  null descriptor profile, dropped-agent selection. */
const variants: NativeSessionEvent[] = [
  { type: 'user/message', seq: 0, time: 1000, data: userMessage, parentToolUseId: 'toolu_parent' },
  { type: 'assistant/message', seq: 1, time: 1100, data: { message: assistantMessage, stream: [] }, parentToolUseId: 'toolu_parent' },
  { type: 'tool/result', seq: 2, time: 1200, data: { message: toolMessage }, parentToolUseId: 'toolu_parent' },
  { type: 'turn/end', seq: 3, time: 1300, data: { reason: 'interrupted' } },
  { type: 'turn/end', seq: 4, time: 1400, data: { reason: 'error' } },
  { type: 'turn/end', seq: 5, time: 1500, data: { reason: 'forked' } },
  { type: 'session/end-seed', seq: 6, time: 1600, data: {} },
  {
    type: 'subagent/descriptor',
    seq: 7,
    time: 1700,
    data: { toolUseId: callId, parentToolUseId: 'toolu_parent', kind: 'skill', toolName: 'Skill', label: 'code-review', depth: 2, profile: null, timestamp },
  },
  {
    type: 'session/agent',
    seq: 8,
    time: 1800,
    data: { name: null, base, droppedAgent: { name: 'legacy', unsupportedFields: ['background', 'memory'] }, timestamp },
  },
  { type: 'session/attachments', seq: 9, time: 1900, data: { attachments: [], timestamp } },
]

function assertNever(value: never): never {
  throw new Error(`unexpected event: ${JSON.stringify(value)}`)
}

/** Compile-time narrowing pin — never called (expectTypeOf is erased to a
 *  no-op, but the ambient narrowing reads must not execute at runtime). */
function _narrowingPin(event: NativeSessionEvent): void {
  if (event.type === 'user/message') {
    expectTypeOf(event.data).toEqualTypeOf<UserMessage & { isCompactSummary?: true }>()
    expectTypeOf(event.data.isCompactSummary).toEqualTypeOf<true | undefined>()
  }
  if (event.type === 'assistant/message') {
    expectTypeOf(event.data.message).toEqualTypeOf<AssistantMessage>()
    expectTypeOf(event.data.stream).toEqualTypeOf<AssistantStreamRecord[]>()
    expectTypeOf(event.data.usage).toEqualTypeOf<TokenUsage | undefined>()
    expectTypeOf(event.data.interrupted).toEqualTypeOf<true | undefined>()
    expectTypeOf(event.data.rawStopReason).toEqualTypeOf<string | undefined>()
  }
  if (event.type === 'tool/result') {
    expectTypeOf(event.data.message).toEqualTypeOf<ToolResultMessage>()
    expectTypeOf(event.data.meta).toEqualTypeOf<JsonValue | undefined>()
  }
  if (event.type === 'subagent/descriptor') {
    expectTypeOf(event.data.profile).toEqualTypeOf<NativeAgentProfile | null>()
    expectTypeOf(event.data.parentToolUseId).toEqualTypeOf<string | null>()
  }
  if (event.type === 'session/agent') {
    expectTypeOf(event.data.definition).toEqualTypeOf<NeutralStoredAgentDefinition | undefined>()
    expectTypeOf(event.data.base).toEqualTypeOf<NativeAgentBase>()
  }
}

/** Exhaustive fold — the default arm is a compile-time leak detector: a new
 *  SessionEventMap key without a branch breaks this function's typecheck. */
function eventLabel(event: NativeSessionEvent): string {
  switch (event.type) {
    case 'user/message': return `user:${event.data.id}`
    case 'assistant/message': return `assistant:${event.data.message.id}`
    case 'tool/result': return `tool:${event.data.message.toolCallId}`
    case 'session/context': return `context:${event.data.text.length}`
    case 'turn/end': return `turn-end:${event.data.reason}`
    case 'session/end-seed': return 'end-seed'
    case 'session/compact': return `compact:${event.data.uuid}`
    case 'session/supplement': return `supplement:${event.data.uuid}`
    case 'session/skill': return `skill:${event.data.name}`
    case 'subagent/descriptor': return `descriptor:${event.data.toolUseId}`
    case 'session/attachments': return `attachments:${event.data.attachments.length}`
    case 'session/agent': return `agent:${event.data.name ?? '(none)'}`
    default: return assertNever(event)
  }
}

describe('SessionEvent discrimination', () => {
  it('narrows data per type (compile-time pin in _narrowingPin)', () => {
    expect(_narrowingPin).toBeTypeOf('function')
  })

  it('every durable key folds exhaustively at runtime', () => {
    const labels = fixtures.map(eventLabel)
    expect(labels).toHaveLength(12)
    expect(new Set(labels.map((l) => l.split(':')[0])).size).toBe(12)
    expect(() => eventLabel({ type: 'bogus' } as unknown as NativeSessionEvent)).toThrow()
  })

  it('SessionSeq is a plain number and the envelope carries seq/time/ignorable', () => {
    expectTypeOf<SessionSeq>().toEqualTypeOf<number>()
    const ignorable: SessionEvent<'session/context'> = {
      type: 'session/context', seq: 0, time: 0, data: { text: 'x' }, ignorable: true,
    }
    expect(ignorable.ignorable).toBe(true)
    expectTypeOf<NativeSessionEvent>().toEqualTypeOf<
      { [T in keyof SessionEventMap]: SessionEvent<T> }[keyof SessionEventMap]
    >()
  })

  it('R6: live-only operational frames are NOT durable event keys', () => {
    // @ts-expect-error — task frames stay live-only
    expectTypeOf<SessionEvent<'task/started'>>().toBeNever()
    // @ts-expect-error — api_retry stays live-only
    expectTypeOf<SessionEvent<'api/retry'>>().toBeNever()
    // @ts-expect-error — informational stays live-only
    expectTypeOf<SessionEvent<'informational'>>().toBeNever()
    // @ts-expect-error — result stays live-only
    expectTypeOf<SessionEvent<'result'>>().toBeNever()
    // @ts-expect-error — init stays live-only
    expectTypeOf<SessionEvent<'init'>>().toBeNever()
    expect(true).toBe(true)
  })
})

describe('durable event JSON round-trips', () => {
  it.each(fixtures.map((event, i) => [i, event.type] as const))('fixture %i (%s) survives stringify/parse', (i) => {
    const event = fixtures[i]
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })

  it.each(variants.map((event, i) => [i, event.type] as const))('variant %i (%s) survives stringify/parse', (i) => {
    const event = variants[i]
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })

  it('the whole fixture log round-trips with contiguous seq intact', () => {
    const parsed = JSON.parse(JSON.stringify(fixtures)) as NativeSessionEvent[]
    expect(parsed).toEqual(fixtures)
    expect(hasContiguousSeq(parsed)).toBe(true)
  })

  it('preserves a null parent as null (not dropped) through the wire', () => {
    const main = fixtures[0]
    const parsed = JSON.parse(JSON.stringify(main)) as NativeSessionEvent
    expect('parentToolUseId' in parsed).toBe(true)
    expect(parsed.parentToolUseId).toBeNull()
    const sidechain = variants[0]
    const parsedSide = JSON.parse(JSON.stringify(sidechain)) as NativeSessionEvent
    expect(parsedSide.parentToolUseId).toBe('toolu_parent')
  })
})

describe('NativeSessionHeader', () => {
  it('is version 3 (literal, not number)', () => {
    expectTypeOf<NativeSessionHeader['v']>().toEqualTypeOf<3>()
    expectTypeOf<NativeSessionHeader['type']>().toEqualTypeOf<'session/header'>()
    const header: NativeSessionHeader = {
      type: 'session/header',
      v: 3,
      id: 'session-1',
      cwd: 'D:/codes/claude-react-web',
      createdAt: 1000,
      isSeeded: false,
      inheritedEventCount: 0,
    }
    expect(JSON.parse(JSON.stringify(header))).toEqual(header)
    // @ts-expect-error — v is the literal 3, never another version
    const wrongVersion: NativeSessionHeader = { ...header, v: 2 }
    expect(wrongVersion.v).toBe(2)
  })
})

describe('isSidechainEvent', () => {
  const messageTypes = ['user/message', 'assistant/message', 'tool/result'] as const

  it('is true only for message events with a non-null string parent', () => {
    for (const type of messageTypes) {
      expect(isSidechainEvent({ type, parentToolUseId: 'toolu_parent' })).toBe(true)
      expect(isSidechainEvent({ type, parentToolUseId: null })).toBe(false)
      expect(isSidechainEvent({ type })).toBe(false)
    }
  })

  it('is false for operational events even if a parent rides along', () => {
    for (const type of ['session/context', 'turn/end', 'session/compact', 'session/agent', 'subagent/descriptor'] as const) {
      expect(isSidechainEvent({ type, parentToolUseId: 'toolu_parent' })).toBe(false)
    }
    expect(isSidechainEvent({})).toBe(false)
  })

  it('preserves the null-vs-string distinction on real events', () => {
    const main = fixtures.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')
    expect(main.length).toBeGreaterThan(0)
    for (const event of main) expect(isSidechainEvent(event)).toBe(false)
    for (const event of variants.slice(0, 3)) expect(isSidechainEvent(event)).toBe(true)
  })
})

describe('hasContiguousSeq', () => {
  it('accepts a gapless run starting at the expected seq', () => {
    expect(hasContiguousSeq([])).toBe(true)
    expect(hasContiguousSeq([{ seq: 0 }, { seq: 1 }, { seq: 2 }])).toBe(true)
    expect(hasContiguousSeq([{ seq: 5 }, { seq: 6 }], 5)).toBe(true)
    expect(hasContiguousSeq(fixtures)).toBe(true)
  })

  it('rejects gaps, duplicates, and a wrong start', () => {
    expect(hasContiguousSeq([{ seq: 0 }, { seq: 2 }])).toBe(false)
    expect(hasContiguousSeq([{ seq: 0 }, { seq: 0 }])).toBe(false)
    expect(hasContiguousSeq([{ seq: 1 }, { seq: 2 }])).toBe(false)
    expect(hasContiguousSeq([{ seq: 5 }, { seq: 6 }], 0)).toBe(false)
    expect(hasContiguousSeq([{ seq: 0 }, { seq: 1.5 }])).toBe(false)
  })
})

describe('PF3 relocation identity', () => {
  it('NativeAgentProfile/NativeAgentBase are structurally identical to the host originals', () => {
    expectTypeOf<NativeAgentProfile>().toEqualTypeOf<HostNativeAgentProfile>()
    expectTypeOf<NativeAgentBase>().toEqualTypeOf<HostNativeAgentBase>()
  })

  it('the neutral StoredAgentDefinition is structurally identical to the host store type', () => {
    expectTypeOf<NeutralStoredAgentDefinition>().toEqualTypeOf<HostStoredAgentDefinition>()
  })

  it('the effort union matches the runtime NATIVE_AGENT_EFFORT_LEVELS values', () => {
    expectTypeOf<NonNullable<NativeAgentProfile['effort']>>().toEqualTypeOf<'low' | 'medium' | 'high' | 'xhigh' | 'max'>()
  })

  it('NativeTurnEndReason matches the v1/v2 union', () => {
    expectTypeOf<NativeTurnEndReason>().toEqualTypeOf<'completed' | 'interrupted' | 'error' | 'forked'>()
  })
})

describe('JsonValue', () => {
  it('accepts nested JSON and rejects non-JSON values', () => {
    const meta: JsonValue = { a: [1, 'two', false, null, { b: 'c' }], d: 0.5 }
    expect(meta).toBeTruthy()
    expectTypeOf<string>().toMatchTypeOf<JsonValue>()
    expectTypeOf<number>().toMatchTypeOf<JsonValue>()
    expectTypeOf<boolean>().toMatchTypeOf<JsonValue>()
    expectTypeOf<null>().toMatchTypeOf<JsonValue>()
    expectTypeOf<undefined>().not.toMatchTypeOf<JsonValue>()
    expectTypeOf<() => void>().not.toMatchTypeOf<JsonValue>()
    expectTypeOf<Date>().not.toMatchTypeOf<JsonValue>()
    expectTypeOf<{ a: undefined }>().not.toMatchTypeOf<JsonValue>()
  })
})
