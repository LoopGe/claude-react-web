import { describe, expect, it } from 'vitest'
import type { StoredAgentDefinition } from '../../../agent-definition-store.js'
import { NATIVE_SESSION_LOG_VERSION, parseEventLine, parseHeaderLine, serializeEvent, serializeHeader } from './format.js'
import type { NativeEventInput, NativeLogEvent, NativeSkillInvocationEvent } from './format.js'
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
  it('rejects an unknown version', () => {
    expect(() => parseHeaderLine({ ...header, v: 2 }, 's1', 'p')).toThrow(NativeSessionStorageError)
    try { parseHeaderLine({ ...header, v: 2 }, 's1', 'p') } catch (e) {
      expect((e as NativeSessionStorageError).kind).toBe('unsupported-version')
    }
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
})
