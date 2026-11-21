import { describe, expect, it } from 'vitest'
import type { StoredAgentDefinition } from '../../../agent-definition-store.js'
import { NATIVE_SESSION_LOG_VERSION, NATIVE_SESSION_LOG_V3, eventRequiresV3, parseEventLine, parseEventLineV3, parseHeaderLine, projectNeutralEventToLegacy, serializeEvent, serializeHeader } from './format.js'
import type { NativeEventInput, NativeLogEvent, NativeSkillInvocationEvent } from './format.js'
import type { NativeSessionEvent } from '../vocabulary/session-event.js'
import { NativeSessionStorageError } from './errors.js'

const header = { type: 'session/header', v: 1, id: 's1', cwd: '/repo', createdAt: 1, isSeeded: false, inheritedEventCount: 0 } as const

const agentDefinition: StoredAgentDefinition = {
  name: 'reviewer',
  description: 'Reviews code',
  prompt: 'Review the change carefully.',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  model: 'claude-opus-4-1',
  tools: [],
  disallowedTools: ['Bash'],
  mcpServers: ['workspace'],
  skills: ['code-review'],
  permissionMode: 'plan',
  maxTurns: 5,
  effort: 'high',
}

const selectionInput: NativeEventInput = {
  type: 'session/agent',
  name: 'reviewer',
  definition: agentDefinition,
  base: {
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    effortLevel: 'medium',
    skillPolicy: ['code-review'],
    toolProfile: {
      tools: ['Read', 'Grep'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      toolAliases: { Search: 'Grep' },
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
    },
  },
  timestamp: '2026-11-11T00:00:00.000Z',
}

const descriptorEvent: NativeLogEvent = {
  seq: 8,
  type: 'subagent/descriptor',
  toolUseId: 'task-1',
  parentToolUseId: 'agent-parent',
  kind: 'agent',
  toolName: 'Task',
  label: 'Review the change',
  depth: 2,
  profile: {
    name: 'reviewer',
    instruction: 'Review the change carefully.',
    model: 'claude-opus-4-1',
    tools: ['Read'],
    disallowedTools: ['Bash'],
    mcpServers: ['workspace'],
    skills: [],
    permissionMode: 'plan',
    maxTurns: 5,
    effort: 'high',
  },
  timestamp: '2026-11-12T00:00:00.000Z',
}

const skillInvocationEvent: NativeSkillInvocationEvent = {
  seq: 0,
  type: 'session/skill',
  name: 'alpha',
  body: 'Base directory for this skill: /snapshot\n\nPERSISTED INSTRUCTIONS',
  timestamp: '2026-11-12T00:00:00.000Z',
}

function expectCorrupt(raw: unknown): void {
  expect(() => parseEventLine(raw, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
  try {
    parseEventLine(raw, 0, 's1', 'p')
  } catch (error) {
    expect((error as NativeSessionStorageError).kind).toBe('corrupt')
  }
}

describe('session log format', () => {
  it('round-trips the header', () => {
    expect(NATIVE_SESSION_LOG_VERSION).toBe(1)
    expect(parseHeaderLine(JSON.parse(serializeHeader(header)), 's1', 'p')).toEqual(header)
  })
  it('accepts v1 and v2 headers while keeping v1 as the fresh-write version', () => {
    expect(parseHeaderLine({ ...header, v: 2 }, 's1', 'p')).toEqual({ ...header, v: 2 })
  })
  it('rejects an unknown version', () => {
    expect(() => parseHeaderLine({ ...header, v: 99 }, 's1', 'p')).toThrow(NativeSessionStorageError)
    try { parseHeaderLine({ ...header, v: 99 }, 's1', 'p') } catch (e) {
      expect((e as NativeSessionStorageError).kind).toBe('unsupported-version')
    }
  })
  it('accepts a v3 header', () => {
    expect(parseHeaderLine({ ...header, v: 3 }, 's1', 'p')).toEqual({ ...header, v: 3 })
  })
  it('keeps the legacy v1-only parser closed to v2 logs', () => {
    try { parseHeaderLine({ ...header, v: 2 }, 's1', 'p', [1]) } catch (e) {
      expect((e as NativeSessionStorageError).kind).toBe('unsupported-version')
      return
    }
    throw new Error('expected the v1-only parser to reject v2')
  })
  it('accepts each known event and enforces contiguous seq', () => {
    const events = [
      { seq: 0, type: 'user', uuid: 'u', session_id: 's1', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [] } },
      { seq: 1, type: 'assistant', uuid: 'a', session_id: 's1', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content: [], id: 'msg_1', model: 'm' } },
      { seq: 2, type: 'session/context', text: 'ctx' },
      { seq: 3, type: 'turn/end', reason: 'completed' },
      { seq: 4, type: 'session/end-seed' },
      { seq: 5, type: 'session/compact', text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: 't' },
      { seq: 6, type: 'session/supplement', uuid: 'sp1', text: 'WRAPPED', timestamp: 't' },
    ]
    for (const [i, e] of events.entries()) {
      expect(parseEventLine(e, i, 's1', 'p')).toEqual(e)
      expect(JSON.parse(serializeEvent(e as never))).toEqual(e)
    }
    expect(() => parseEventLine(events[1], 0, 's1', 'p')).toThrow(/seq/)
    expect(parseEventLine(events[1], 1, 's1', 'p')).toMatchObject({
      message: { id: 'msg_1', model: 'm' },
    })
  })
  it('round-trips a subagent descriptor with its detached profile and empty skills', () => {
    const serialized = serializeEvent(descriptorEvent)
    const parsed = parseEventLine(JSON.parse(serialized), 8, 's1', 'p')
    expect(parsed).toEqual(descriptorEvent)
    expect(parsed).toMatchObject({ toolName: 'Task', profile: { skills: [] } })
  })
  it('rejects malformed subagent descriptors as corrupt', () => {
    const valid = { ...descriptorEvent, seq: 0 } as Record<string, unknown>
    const profile = valid.profile as Record<string, unknown>
    const cases: unknown[] = [
      { ...valid, depth: 0 },
      { ...valid, depth: 1.5 },
      { ...valid, toolName: 'Bash' },
      { ...valid, kind: 'other' },
      { ...valid, toolUseId: '' },
      { ...valid, parentToolUseId: 7 },
      { ...valid, label: '' },
      { ...valid, timestamp: '' },
      { ...valid, profile: { ...profile, name: 7 } },
      { ...valid, profile: { ...profile, skills: 'none' } },
      { ...valid, profile: { ...profile, maxTurns: 0 } },
      { ...valid, profile: { ...profile, maxTurns: -1 } },
      { ...valid, profile: { ...profile, maxTurns: 1.5 } },
      { ...valid, profile: { ...profile, effort: 'ultra' } },
      { ...valid, profile: { ...profile, injected: true } },
      { ...valid, injected: true },
    ]
    for (const raw of cases) expectCorrupt(raw)
    for (const field of [
      'toolUseId', 'parentToolUseId', 'kind', 'toolName', 'label', 'depth', 'profile', 'timestamp',
    ]) {
      const missing = { ...valid }
      delete missing[field]
      expectCorrupt(missing)
    }
  })
  it('round-trips the exact session/skill instruction shape', () => {
    const serialized = serializeEvent(skillInvocationEvent)
    expect(JSON.parse(serialized)).toEqual({
      seq: 0,
      type: 'session/skill',
      name: 'alpha',
      body: 'Base directory for this skill: /snapshot\n\nPERSISTED INSTRUCTIONS',
      timestamp: '2026-11-12T00:00:00.000Z',
    })
    expect(parseEventLine(JSON.parse(serialized), 0, 's1', 'p')).toEqual(skillInvocationEvent)
  })
  it('rejects unknown session/skill fields, including args and a UI uuid', () => {
    for (const raw of [
      { ...skillInvocationEvent, args: '--verbose' },
      { ...skillInvocationEvent, uuid: 'ui-uuid' },
      { ...skillInvocationEvent, injected: true },
    ]) {
      expectCorrupt(raw)
    }
  })
  it('rejects missing or non-string session/skill fields as corrupt', () => {
    for (const field of ['name', 'body', 'timestamp'] as const) {
      const missing = { ...skillInvocationEvent } as Record<string, unknown>
      delete missing[field]
      expectCorrupt(missing)
      for (const value of [null, 7, {}, []]) {
        expectCorrupt({ ...skillInvocationEvent, [field]: value })
      }
    }
  })
  it('rejects an empty session/skill body as corrupt', () => {
    expectCorrupt({ ...skillInvocationEvent, body: '' })
  })
  it('round-trips an appended agent selection with its definition and base snapshots', () => {
    const appended = { ...selectionInput, seq: 7 }
    const serialized = serializeEvent(appended)
    expect(parseEventLine(JSON.parse(serialized), 7, 's1', 'p')).toEqual(appended)
  })
  it('round-trips a compatibility drop event', () => {
    const event: NativeLogEvent = {
      seq: 0,
      type: 'session/agent',
      name: null,
      base: { model: 'claude-sonnet-4-5', permissionMode: 'default', skillPolicy: 'all' },
      droppedAgent: { name: 'legacy', unsupportedFields: ['memory', 'effort'] },
      timestamp: '2026-11-11T00:00:00.000Z',
    }
    expect(parseEventLine(JSON.parse(serializeEvent(event)), 0, 's1', 'p')).toEqual(event)
  })
  it('rejects malformed agent selection base snapshots as corrupt', () => {
    const valid = { seq: 0, type: 'session/agent', name: null, timestamp: 't' }
    const cases = [
      { ...valid },
      { ...valid, base: null },
      { ...valid, base: { permissionMode: 'default' } },
      { ...valid, base: { model: 1, permissionMode: 'default' } },
      { ...valid, base: { model: 'm', permissionMode: 'default', effortLevel: 2 } },
      { ...valid, base: { model: 'm', permissionMode: 'default', skillPolicy: 'some' } },
      { ...valid, base: { model: 'm', permissionMode: 'default', skillPolicy: ['ok', 2] } },
      { ...valid, base: { model: 'm', permissionMode: 'default', toolProfile: { tools: ['Read', 2] } } },
      { ...valid, base: { model: 'm', permissionMode: 'default', toolProfile: { toolAliases: { Search: 2 } } } },
      { ...valid, base: { model: 'm', permissionMode: 'default', injected: true } },
    ]
    for (const raw of cases) expectCorrupt(raw)
  })
  it('rejects malformed or inconsistent definition snapshots instead of stripping fields', () => {
    const valid = {
      seq: 0,
      type: 'session/agent',
      name: 'reviewer',
      base: { model: 'm', permissionMode: 'default' },
      timestamp: 't',
    }
    const cases = [
      { ...valid },
      { ...valid, definition: null },
      { ...valid, definition: { ...agentDefinition, name: 'other' } },
      { ...valid, definition: { ...agentDefinition, memory: 'invalid' } },
      { ...valid, definition: { ...agentDefinition, effort: 'ultra' } },
      { ...valid, definition: { ...agentDefinition, permissionMode: 'disabled' } },
      { ...valid, definition: { ...agentDefinition, maxTurns: '5' } },
      { ...valid, definition: { ...agentDefinition, injected: 'do not strip me' } },
      { seq: 0, type: 'session/agent', name: null, definition: agentDefinition, base: valid.base, timestamp: 't' },
    ]
    for (const raw of cases) expectCorrupt(raw)
  })
  it('rejects malformed or misplaced droppedAgent metadata as corrupt', () => {
    const clear = {
      seq: 0,
      type: 'session/agent',
      name: null,
      base: { model: 'm', permissionMode: 'default' },
      timestamp: 't',
    }
    const selected = { ...clear, name: 'reviewer', definition: agentDefinition }
    const cases = [
      { ...clear, droppedAgent: null },
      { ...clear, droppedAgent: { unsupportedFields: ['memory'] } },
      { ...clear, droppedAgent: { name: 'legacy', unsupportedFields: 'memory' } },
      { ...clear, droppedAgent: { name: 'legacy', unsupportedFields: ['memory', 2] } },
      { ...clear, droppedAgent: { name: 'legacy', unsupportedFields: [] } },
      { ...selected, droppedAgent: { name: 'legacy', unsupportedFields: ['memory'] } },
      { ...clear, definition: agentDefinition, droppedAgent: { name: 'legacy', unsupportedFields: ['memory'] } },
    ]
    for (const raw of cases) expectCorrupt(raw)
  })
  it('rejects an empty session/compact field', () => {
    const compact = { seq: 0, type: 'session/compact', text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: 't' }
    for (const field of ['text', 'context', 'uuid', 'timestamp'] as const) {
      expect(() => parseEventLine({ ...compact, [field]: '' }, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
    }
  })
  it('rejects a missing or empty session/supplement field', () => {
    const supplement = { seq: 0, type: 'session/supplement', uuid: 'sp1', text: 'WRAPPED', timestamp: 't' }
    for (const field of ['uuid', 'text'] as const) {
      expect(() => parseEventLine({ ...supplement, [field]: '' }, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
      expect(() => parseEventLine({ ...supplement, [field]: undefined }, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
    }
    const noUuid = { ...supplement } as Record<string, unknown>
    delete noUuid.uuid
    expect(() => parseEventLine(noUuid, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
    const noText = { ...supplement } as Record<string, unknown>
    delete noText.text
    expect(() => parseEventLine(noText, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
  })
  it('accepts a string parent_tool_use_id on user and assistant events', () => {
    const user = { seq: 0, type: 'user', uuid: 'u', session_id: 's1', parent_tool_use_id: 'tu1', timestamp: 't', message: { role: 'user', content: [] } }
    const assistant = { seq: 0, type: 'assistant', uuid: 'a', session_id: 's1', parent_tool_use_id: 'tu1', timestamp: 't', message: { role: 'assistant', content: [] } }
    expect(parseEventLine(user, 0, 's1', 'p')).toMatchObject({ parent_tool_use_id: 'tu1' })
    expect(parseEventLine(assistant, 0, 's1', 'p')).toMatchObject({ parent_tool_use_id: 'tu1' })
  })
  it('rejects a non-string, non-null parent_tool_use_id', () => {
    for (const type of ['user', 'assistant'] as const) {
      const base = { seq: 0, type, uuid: 'x', session_id: 's1', parent_tool_use_id: null, timestamp: 't', message: { role: type, content: [] } }
      for (const bad of [3, {}, true, undefined] as unknown[]) {
        expect(() => parseEventLine({ ...base, parent_tool_use_id: bad }, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
      }
    }
  })
  it('rejects an unknown event type', () => {
    expect(() => parseEventLine({ seq: 0, type: 'mystery' }, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
  })
  it('rejects a user event without a timestamp', () => {
    expect(() => parseEventLine({ seq: 0, type: 'user', uuid: 'u', session_id: 's1', parent_tool_use_id: null, message: { role: 'user', content: [] } }, 0, 's1', 'p')).toThrow(/timestamp/)
  })

  const nativeAttachment = {
    id: 'upload-1',
    name: 'notes.txt',
    size: 123,
    digest: 'a'.repeat(64),
    path: '/state/claude-web-attachments/v1/ab/' + 'a'.repeat(64) + '-notes.txt',
    mediaType: 'text/plain',
    modelForm: 'handle',
  }
  const nativeFile = { type: 'file', attachment: nativeAttachment }
  const v2User = {
    seq: 0,
    type: 'user',
    uuid: 'u-v2',
    session_id: 's1',
    parent_tool_use_id: null,
    timestamp: '2026-11-13T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'before' }, nativeFile, { type: 'text', text: 'after' }] },
  }
  const parseV2 = (raw: unknown) => parseEventLine(raw, 0, 's1', 'p', 2)
  const expectCorruptV2 = (raw: unknown) => {
    try { parseV2(raw) } catch (error) {
      expect((error as NativeSessionStorageError).kind).toBe('corrupt')
      return
    }
    throw new Error('expected corrupt v2 event')
  }

  it('round-trips v2 native files and the hidden attachment catalog', () => {
    expect(parseV2(JSON.parse(JSON.stringify(v2User)))).toEqual(v2User)
    const catalog = {
      seq: 0,
      type: 'session/attachments',
      attachments: [{ ...nativeAttachment, mediaType: 'application/pdf', modelForm: 'pdf-document' }],
      timestamp: '2026-11-13T00:00:01.000Z',
    }
    expect(parseV2(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog)
  })
  it('keeps a legacy v1 handle readable but rejects structured v2 shapes in v1', () => {
    const legacy = {
      ...v2User,
      message: { role: 'user', content: [{ type: 'text', text: '[File: notes.txt (123 bytes, sha256: aaaaaaaa, upload id: upload-1)] Read /legacy/notes.txt' }] },
    }
    expect(parseEventLine(legacy, 0, 's1', 'p')).toEqual(legacy)
    expectCorrupt(v2User)
    expectCorrupt({ seq: 0, type: 'session/attachments', attachments: [nativeAttachment], timestamp: 't' })
  })
  it('strictly validates every native attachment field and rejects unknown fields', () => {
    const cases: unknown[] = [
      { ...nativeFile, injected: true },
      { type: 'file', attachment: { ...nativeAttachment, injected: true } },
      ...['id', 'name', 'path'].map((field) => ({ type: 'file', attachment: { ...nativeAttachment, [field]: '' } })),
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((size) => ({ type: 'file', attachment: { ...nativeAttachment, size } })),
      ...['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)].map((digest) => ({ type: 'file', attachment: { ...nativeAttachment, digest } })),
      { type: 'file', attachment: { ...nativeAttachment, mediaType: '' } },
      { type: 'file', attachment: { ...nativeAttachment, modelForm: 'document' } },
      { type: 'file', attachment: { ...nativeAttachment, modelForm: 'pdf-document' } },
      { type: 'file', attachment: { ...nativeAttachment, modelForm: 'pdf-document', mediaType: 'text/plain' } },
    ]
    for (const field of ['id', 'name', 'size', 'digest', 'path', 'modelForm']) {
      const attachment = { ...nativeAttachment } as Record<string, unknown>
      delete attachment[field]
      cases.push({ type: 'file', attachment })
    }
    for (const attachment of cases) expectCorruptV2({ ...v2User, message: { role: 'user', content: [attachment] } })
  })
  it('validates native files nested in tool_result content', () => {
    const event = {
      ...v2User,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'text', text: 'Read notes.txt' }, nativeFile] }],
      },
    }
    expect(parseV2(event)).toEqual(event)
    expectCorruptV2({
      ...event,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [{ ...nativeFile, attachment: { ...nativeAttachment, digest: 'bad' } }] }] },
    })
    expectCorrupt(event)
  })
  it('rejects a structured file below the supported tool_result depth', () => {
    expectCorruptV2({
      ...v2User,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'outer',
          content: [{
            type: 'tool_result',
            tool_use_id: 'inner',
            content: [nativeFile],
          }],
        }],
      },
    })
  })
  it('rejects malformed attachment catalogs', () => {
    const valid = { seq: 0, type: 'session/attachments', attachments: [nativeAttachment], timestamp: 't' }
    for (const raw of [
      { ...valid, injected: true },
      { ...valid, attachments: nativeAttachment },
      { ...valid, attachments: [{ ...nativeAttachment, modelForm: 'pdf-document' }] },
      { ...valid, timestamp: '' },
    ]) expectCorruptV2(raw)
  })
})

describe('session log format v3 (neutral)', () => {
  const v3Attachment = {
    id: 'upload-1', name: 'notes.txt', size: 123, digest: 'a'.repeat(64),
    path: '/state/notes.txt', mediaType: 'text/plain', modelForm: 'handle',
  }
  const assistantMessage = {
    id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'reply' }],
    source: { kind: 'model', provider: 'anthropic', model: 'm' },
  }
  const neutralEvents: NativeSessionEvent[] = [
    { type: 'user/message', seq: 0, time: 1000, parentToolUseId: null, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 1, time: 1001, parentToolUseId: null, data: { message: assistantMessage, stream: [{ type: 'text-chunks', time0: 1000, index: 0, dt: [0], texts: ['reply'] }, { type: 'chunk', time: 1001, chunk: { type: 'finish', reason: { kind: 'stop' } } }], usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'tool/result', seq: 2, time: 1002, parentToolUseId: null, data: { message: { id: 't1', role: 'tool', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: false } } },
    { type: 'session/context', seq: 3, time: 1003, data: { text: 'ctx' } },
    { type: 'turn/end', seq: 4, time: 1004, data: { reason: 'completed', usage: { inputTokens: 1, outputTokens: 2 } } },
    { type: 'session/end-seed', seq: 5, time: 1005, data: { inherited: true } },
    { type: 'session/compact', seq: 6, time: 1006, data: { text: 'SUM', context: 'CTX', uuid: 'c1', timestamp: 't' } },
    { type: 'session/supplement', seq: 7, time: 1007, data: { uuid: 'sp1', text: 'WRAP', timestamp: 't' } },
    { type: 'session/skill', seq: 8, time: 1008, data: { name: 'alpha', body: 'BODY', timestamp: 't' } },
    { type: 'subagent/descriptor', seq: 9, time: 1009, data: { toolUseId: 'task-1', parentToolUseId: null, kind: 'agent', toolName: 'Task', label: 'L', depth: 1, profile: null, timestamp: 't' } },
    { type: 'session/attachments', seq: 10, time: 1010, data: { attachments: [v3Attachment], timestamp: 't' } },
    { type: 'session/agent', seq: 11, time: 1011, data: { name: null, base: { model: 'm', permissionMode: 'default' }, timestamp: 't' } },
  ] as unknown as NativeSessionEvent[]

  const expectCorruptV3 = (raw: unknown, seq = 0) => {
    try { parseEventLineV3(raw, seq, 's1', 'p') } catch (error) {
      expect((error as NativeSessionStorageError).kind).toBe('corrupt')
      return
    }
    throw new Error('expected corrupt v3 event')
  }

  it('exposes v3 as a supported version', () => {
    expect(NATIVE_SESSION_LOG_V3).toBe(3)
  })

  it('round-trips each neutral event losslessly', () => {
    for (const event of neutralEvents) {
      const parsed = parseEventLineV3(JSON.parse(serializeEvent(event)), event.seq, 's1', 'p')
      expect(parsed).toEqual(event)
    }
  })

  it('enforces contiguous seq', () => {
    expect(() => parseEventLineV3(neutralEvents[1], 0, 's1', 'p')).toThrow(/seq/)
    expect(() => parseEventLineV3({ ...neutralEvents[0], seq: 5 }, 0, 's1', 'p')).toThrow(/seq/)
  })

  it('preserves the parent null-vs-string distinction on message events', () => {
    for (const type of ['user/message', 'assistant/message', 'tool/result'] as const) {
      const base = neutralEvents.find((e) => e.type === type)!
      expect(parseEventLineV3({ ...base, parentToolUseId: null }, base.seq, 's1', 'p')).toMatchObject({ parentToolUseId: null })
      expect(parseEventLineV3({ ...base, parentToolUseId: 'tu1' }, base.seq, 's1', 'p')).toMatchObject({ parentToolUseId: 'tu1' })
    }
  })

  it('rejects a MISSING parent on message events as corrupt (not null)', () => {
    for (const type of ['user/message', 'assistant/message', 'tool/result'] as const) {
      const base = neutralEvents.find((e) => e.type === type)! as Record<string, unknown>
      const missing = { ...base }
      delete missing.parentToolUseId
      expectCorruptV3(missing, base.seq as number)
    }
  })

  it('rejects a non-string, non-null parent on message events', () => {
    const base = neutralEvents[0]
    for (const bad of [3, {}, true]) expectCorruptV3({ ...base, parentToolUseId: bad })
  })

  it('allows an absent parent on operational events', () => {
    const context = neutralEvents[3]
    expect(parseEventLineV3(context, context.seq, 's1', 'p')).toEqual(context)
    expect(parseEventLineV3({ ...context, parentToolUseId: null }, context.seq, 's1', 'p')).toMatchObject({ parentToolUseId: null })
  })

  it('rejects unknown event types and unknown envelope keys', () => {
    expectCorruptV3({ seq: 0, type: 'mystery', time: 1, data: {} })
    expectCorruptV3({ ...neutralEvents[3], injected: true })
    expectCorruptV3({ ...neutralEvents[0], uuid: 'legacy-field' })
  })

  it('rejects a missing or non-finite time and a non-object data', () => {
    const noTime = { ...neutralEvents[3] } as Record<string, unknown>
    delete noTime.time
    expectCorruptV3(noTime, 3)
    expectCorruptV3({ ...neutralEvents[3], time: Number.NaN }, 3)
    expectCorruptV3({ ...neutralEvents[3], data: 'ctx' }, 3)
  })

  it('validates the ignorable flag', () => {
    expectCorruptV3({ ...neutralEvents[3], ignorable: false }, 3)
    const flagged = { ...neutralEvents[3], ignorable: true }
    expect(parseEventLineV3(flagged, 3, 's1', 'p')).toEqual(flagged)
  })

  it('enforces the dt[0]=0 inter-arrival convention and texts/dt alignment', () => {
    const assistant = neutralEvents[1] as Record<string, unknown>
    const data = assistant.data as { stream: unknown[] }
    expectCorruptV3({ ...assistant, data: { ...data, stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [5], texts: ['x'] }] } }, 1)
    expectCorruptV3({ ...assistant, data: { ...data, stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [0, 1], texts: ['x'] }] } }, 1)
    expectCorruptV3({ ...assistant, data: { ...data, stream: [{ type: 'bogus', time0: 1, index: 0, dt: [0], texts: ['x'] }] } }, 1)
  })

  it('detects events that require v3', () => {
    expect(eventRequiresV3(neutralEvents[1])).toBe(true) // packed stream
    expect(eventRequiresV3(neutralEvents[2])).toBe(false) // plain tool result
    expect(eventRequiresV3(neutralEvents[5])).toBe(true) // inherited end-seed
    expect(eventRequiresV3(neutralEvents[3])).toBe(false) // plain context
    expect(eventRequiresV3({ ...neutralEvents[3], ignorable: true } as NativeSessionEvent)).toBe(true)
    const noStream = { ...neutralEvents[1], data: { ...(neutralEvents[1] as { data: object }).data, stream: [] } } as unknown as NativeSessionEvent
    expect(eventRequiresV3(noStream)).toBe(false)
    const toolError = { ...neutralEvents[2], data: { ...(neutralEvents[2] as { data: object }).data, error: { name: 'E', code: 'C' } } } as unknown as NativeSessionEvent
    expect(eventRequiresV3(toolError)).toBe(true)
  })

  it('projects a neutral assistant event to the legacy assistant shape', () => {
    const legacy = projectNeutralEventToLegacy(neutralEvents[1], 's1')
    expect(legacy).toMatchObject({
      seq: 1, type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null,
      message: { role: 'assistant', id: 'msg_a1', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'reply' }], usage: { input_tokens: 10, output_tokens: 5 } },
    })
    // The legacy parser accepts the projection (v2).
    expect(parseEventLine(JSON.parse(serializeEvent(legacy)), 1, 's1', 'p', 2)).toEqual(legacy)
  })

  it('projects a neutral tool result to the legacy user tool_result shape', () => {
    const legacy = projectNeutralEventToLegacy(neutralEvents[2], 's1')
    expect(legacy).toMatchObject({
      seq: 2, type: 'user', uuid: 't1', session_id: 's1', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'ok' }], is_error: false }] },
    })
  })

  it('reconstructs tool_use / max_tokens / interrupted stop reasons from the finish record', () => {
    const withFinish = (reason: { kind: string } | null) => {
      const stream = reason === null ? [] : [{ type: 'chunk', time: 1, chunk: { type: 'finish', reason } }]
      return { ...neutralEvents[1], data: { ...(neutralEvents[1] as { data: object }).data, stream } } as NativeSessionEvent
    }
    expect(projectNeutralEventToLegacy(withFinish({ kind: 'tool-calls' }), 's1')).toMatchObject({ message: { stop_reason: 'tool_use' } })
    expect(projectNeutralEventToLegacy(withFinish({ kind: 'max-tokens' }), 's1')).toMatchObject({ message: { stop_reason: 'max_tokens' } })
    expect(projectNeutralEventToLegacy(withFinish(null), 's1')).toMatchObject({ message: { stop_reason: null } })
  })

  it('routes the legacy parseEventLine dispatcher through the v3 projection', () => {
    const legacy = parseEventLine(JSON.parse(serializeEvent(neutralEvents[1])), 1, 's1', 'p', 3)
    expect(legacy).toMatchObject({ type: 'assistant', uuid: 'a1', message: { id: 'msg_a1' } })
  })
})
