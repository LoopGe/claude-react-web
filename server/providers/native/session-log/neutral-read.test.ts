// neutral-read.test.ts
//
// Pins the shared neutral-read helpers (native read-view neutralization):
//   1. neutralEventsOf — the v3 baseline is returned as-is (identity, including
//      an EMPTY baseline); an unmigrated v1/v2 snapshot (neutralEvents absent
//      OR null) falls back to the lossless migrateEventToV3 projection.
//   2. neutralFileOccurrences — exact HOST SDK-transcript coordinates
//      (user/message → [i], tool/result → [0, inner], catalog → []), the
//      messageUuid identity (data.id / data.message.id), and sidechain
//      parentToolUseId preservation.
//   3. Behavior preservation — the neutral scan yields the SAME attachments
//      as the legacy nativeAttachmentOccurrences scan on the same log.

import { describe, expect, it } from 'vitest'
import { neutralEventsOf, neutralFileOccurrences } from './neutral-read.js'
import { migrateEventToV3 } from './migration.js'
import { nativeAttachmentOccurrences } from '../attachment-reference-index.js'
import { brandString } from '../vocabulary/brand.js'
import type { NativeSessionEvent } from '../vocabulary/session-event.js'
import type { NativeLogEvent } from './format.js'
import type { NativeFileAttachment } from '../../../../shared/attachment-types.js'

const TS_ISO = '2026-11-23T10:00:00.000Z'
const TS = Date.parse(TS_ISO)

const fileA: NativeFileAttachment = {
  id: 'upload-a', name: 'notes.txt', size: 123, digest: 'a'.repeat(64),
  path: '/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle',
}
const pdfA: NativeFileAttachment = {
  id: 'upload-pdf', name: 'spec.pdf', size: 4096, digest: 'b'.repeat(64),
  path: '/registry/spec.pdf', mediaType: 'application/pdf', modelForm: 'pdf-document',
}
const catalogA: NativeFileAttachment = {
  id: 'upload-cat', name: 'handoff.txt', size: 7, digest: 'c'.repeat(64),
  path: '/registry/handoff.txt', mediaType: 'text/plain', modelForm: 'handle',
}

/** A hand-built NEUTRAL v3 fixture: a catalog, a main-thread user file at
 *  content index 1, a main-thread tool/result inner file at index 0, a
 *  sidechain user file at index 0, a sidechain tool/result inner file at
 *  index 1 (after a text block), plus file-less assistant/turn-end events. */
function neutralFixture(): NativeSessionEvent[] {
  return [
    { type: 'session/attachments', seq: 0, time: TS, data: { attachments: [catalogA], timestamp: TS_ISO } },
    {
      type: 'user/message', seq: 1, time: TS, parentToolUseId: null,
      data: {
        role: 'user', id: brandString<'MessageId'>('u1'),
        content: [{ type: 'text', text: 'look' }, { type: 'file', attachment: fileA }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'tool/result', seq: 2, time: TS, parentToolUseId: null,
      data: {
        message: {
          role: 'tool', id: brandString<'MessageId'>('tr1'),
          source: { kind: 'tool', callId: brandString<'ToolCallId'>('tool-1') },
          toolCallId: brandString<'ToolCallId'>('tool-1'),
          content: [{ type: 'file', attachment: pdfA }],
          isError: false,
        },
      },
    },
    {
      type: 'user/message', seq: 3, time: TS, parentToolUseId: 'tool-9',
      data: {
        role: 'user', id: brandString<'MessageId'>('u2'),
        content: [{ type: 'file', attachment: fileA }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'tool/result', seq: 4, time: TS, parentToolUseId: 'tool-9',
      data: {
        message: {
          role: 'tool', id: brandString<'MessageId'>('tr2'),
          source: { kind: 'tool', callId: brandString<'ToolCallId'>('tool-10') },
          toolCallId: brandString<'ToolCallId'>('tool-10'),
          content: [{ type: 'text', text: 'ok' }, { type: 'file', attachment: pdfA }],
          isError: false,
        },
      },
    },
    {
      type: 'assistant/message', seq: 5, time: TS, parentToolUseId: null,
      data: {
        message: {
          role: 'assistant', id: brandString<'MessageId'>('a1'),
          content: [{ type: 'text', text: 'done' }],
          source: { kind: 'model', provider: 'anthropic', model: 'claude-x' },
        },
        stream: [],
      },
    },
    { type: 'turn/end', seq: 6, time: TS, data: { reason: 'completed' } },
  ]
}

/** Omit that distributes over the discriminated union so each member keeps its
 *  own fields (a plain Omit<Union, K> collapses to the common keys). */
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never

/** The SAME log in the legacy v1/v2 read view: direct user file blocks,
 *  tool_result inner file blocks, a catalog, sidechain parents. */
function legacyCorpus(): NativeLogEvent[] {
  const raw: Array<WithoutSeq<NativeLogEvent>> = [
    { type: 'session/attachments', attachments: [catalogA], timestamp: TS_ISO },
    {
      type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: TS_ISO,
      message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'file', attachment: fileA }] },
    },
    {
      type: 'user', uuid: 'tr1', session_id: 's1', parent_tool_use_id: null, timestamp: TS_ISO,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'file', attachment: pdfA }], is_error: false }] },
    },
    {
      type: 'user', uuid: 'u2', session_id: 's1', parent_tool_use_id: 'tool-9', timestamp: TS_ISO,
      message: { role: 'user', content: [{ type: 'file', attachment: fileA }] },
    },
    {
      type: 'user', uuid: 'tr2', session_id: 's1', parent_tool_use_id: 'tool-9', timestamp: TS_ISO,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-10', content: [{ type: 'text', text: 'ok' }, { type: 'file', attachment: pdfA }], is_error: false }] },
    },
  ]
  return raw.map((event, seq) => ({ ...event, seq }) as NativeLogEvent)
}

describe('neutralEventsOf — the single v3-vs-migration fallback decision point', () => {
  it('returns the v3 neutral baseline as-is (by reference) when present', () => {
    const neutralEvents = neutralFixture()
    const snapshot = { events: legacyCorpus(), neutralEvents }
    expect(neutralEventsOf(snapshot)).toBe(neutralEvents)
  })

  it('returns an EMPTY v3 baseline without migrating the legacy view', () => {
    expect(neutralEventsOf({ events: legacyCorpus(), neutralEvents: [] })).toEqual([])
  })

  it('falls back to the lossless migration when neutralEvents is undefined (v1/v2 snapshot)', () => {
    const events = legacyCorpus()
    expect(neutralEventsOf({ events })).toEqual(events.map(migrateEventToV3))
  })

  it('falls back to the lossless migration when neutralEvents is null (live v1/v2 writer)', () => {
    const events = legacyCorpus()
    expect(neutralEventsOf({ events, neutralEvents: null })).toEqual(events.map(migrateEventToV3))
  })
})

describe('neutralFileOccurrences — host SDK-transcript coordinates', () => {
  it('yields the exact tuples: user [i], tool/result [0, inner], catalog [], sidechain parent preserved', () => {
    expect(neutralFileOccurrences(neutralFixture())).toEqual([
      { attachment: catalogA, messageUuid: '', parentToolUseId: null, blockPath: [] },
      { attachment: fileA, messageUuid: 'u1', parentToolUseId: null, blockPath: [1] },
      { attachment: pdfA, messageUuid: 'tr1', parentToolUseId: null, blockPath: [0, 0] },
      { attachment: fileA, messageUuid: 'u2', parentToolUseId: 'tool-9', blockPath: [0] },
      { attachment: pdfA, messageUuid: 'tr2', parentToolUseId: 'tool-9', blockPath: [0, 1] },
    ])
  })

  it('yields nothing for an empty event list', () => {
    expect(neutralFileOccurrences([])).toEqual([])
  })
})

describe('neutralFileOccurrences — behavior preservation vs the legacy scan', () => {
  it('yields the same attachments as nativeAttachmentOccurrences on a migrated v1/v2 log', () => {
    const events = legacyCorpus()
    const legacy = nativeAttachmentOccurrences(events)
    const neutral = neutralFileOccurrences(events.map(migrateEventToV3)).map((o) => o.attachment)
    expect(neutral).toEqual(legacy)
  })

  it('yields the same attachments reading a hand-built neutral v3 baseline directly', () => {
    const legacy = nativeAttachmentOccurrences(legacyCorpus())
    expect(neutralFileOccurrences(neutralFixture()).map((o) => o.attachment)).toEqual(legacy)
  })
})
