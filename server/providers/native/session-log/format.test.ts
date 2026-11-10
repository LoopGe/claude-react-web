import { describe, expect, it } from 'vitest'
import { NATIVE_SESSION_LOG_VERSION, parseEventLine, parseHeaderLine, serializeEvent, serializeHeader } from './format.js'
import { NativeSessionStorageError } from './errors.js'

const header = { type: 'session/header', v: 1, id: 's1', cwd: '/repo', createdAt: 1, isSeeded: false, inheritedEventCount: 0 } as const

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
