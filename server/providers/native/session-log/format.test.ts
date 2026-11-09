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
  it('rejects an unknown event type', () => {
    expect(() => parseEventLine({ seq: 0, type: 'mystery' }, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
  })
  it('rejects a user event without a timestamp', () => {
    expect(() => parseEventLine({ seq: 0, type: 'user', uuid: 'u', session_id: 's1', parent_tool_use_id: null, message: { role: 'user', content: [] } }, 0, 's1', 'p')).toThrow(/timestamp/)
  })
})