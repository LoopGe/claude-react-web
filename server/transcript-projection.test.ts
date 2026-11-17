import { describe, it, expect } from 'vitest'
import {
  occurrenceIdOf,
  frameKindOf,
  semanticEquivalent,
  classifyLegacyAppOnly,
} from './transcript-projection.js'

describe('occurrenceId', () => {
  it('frameKindOf discriminates system subtype and compact summary', () => {
    expect(frameKindOf({ type: 'system', subtype: 'compact_boundary' })).toBe('system:compact_boundary')
    expect(frameKindOf({ type: 'user', isCompactSummary: true })).toBe('user:compact_summary')
    expect(frameKindOf({ type: 'assistant' })).toBe('assistant')
  })
  it('uuid + frameKind; compact boundary and summary sharing one event uuid stay distinct', () => {
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'W' }
    const summary = { type: 'user', uuid: 'W', isCompactSummary: true }
    expect(occurrenceIdOf(boundary, {})).not.toBe(occurrenceIdOf(summary, {}))
  })
  it('same uuid+frameKind, different logical occurrence → disambiguator keeps two ids', () => {
    const m = { type: 'assistant', uuid: 'W', message: { id: 'r1', content: [] } }
    const a = occurrenceIdOf(m, { sourceLogId: 'L', sourceOrdinal: 3 })
    const b = occurrenceIdOf(m, { sourceLogId: 'L', sourceOrdinal: 9 })
    expect(a).not.toBe(b)
  })
  it('uuid-less provider row uses provider:<sourceLogId>:<sourceOrdinal>', () => {
    expect(occurrenceIdOf({ type: 'assistant' }, { sourceLogId: 'L', sourceOrdinal: 7 })).toBe('provider:L:7')
  })
})

describe('semanticEquivalent', () => {
  it('ignores transport provenance (restoredFromDisk/receivedAt/session_id)', () => {
    const a = {
      type: 'assistant',
      uuid: 'x',
      message: { id: 'r', content: [{ type: 'text', text: 'hi' }] },
      receivedAt: 1,
      session_id: 's1',
    }
    const b = {
      type: 'assistant',
      uuid: 'y',
      message: { id: 'r', content: [{ type: 'text', text: 'hi' }] },
      restoredFromDisk: true,
      session_id: 's2',
    }
    expect(semanticEquivalent(a, b)).toBe(true)
  })
  it('top-level local_command_output.content is semantic (not dropped)', () => {
    const a = { type: 'system', subtype: 'local_command_output', content: 'Total cost: $1' }
    const b = { type: 'system', subtype: 'local_command_output' }
    expect(semanticEquivalent(a, b)).toBe(false)
  })
  it('stop_reason difference is semantic', () => {
    const a = { type: 'assistant', message: { id: 'r', content: [], stop_reason: 'end_turn' } }
    const b = { type: 'assistant', message: { id: 'r', content: [], stop_reason: 'tool_use' } }
    expect(semanticEquivalent(a, b)).toBe(false)
  })
})

describe('classifyLegacyAppOnly', () => {
  it('live-only task_notification (provider-live) is provider-ephemeral, not source-lost', () => {
    const m = { type: 'system', subtype: 'task_notification', tool_use_id: 't', status: 'completed' }
    expect(classifyLegacyAppOnly(m, { taskNotification: 'provider-live' })).toBe('provider-ephemeral')
  })
  it('unmatched restored assistant is source-lost', () => {
    expect(classifyLegacyAppOnly({ type: 'assistant', uuid: 'a' }, { restoredFromDisk: true })).toBe(
      'source-lost',
    )
  })
  it('unproven CLI user text is not a human prompt', () => {
    expect(
      classifyLegacyAppOnly({ type: 'user', message: { role: 'user', content: '<task-notification>' } }, {}),
    ).toBe('source-lost')
  })
  it('app-send-proven prompt is app', () => {
    expect(
      classifyLegacyAppOnly(
        { type: 'user', uuid: 'u', message: { role: 'user', content: 'hello' } },
        { appSendProven: true },
      ),
    ).toBe('app')
  })
})
