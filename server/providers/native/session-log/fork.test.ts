// fork.test.ts — buildForkSeed operates on NEUTRAL events (Task 5).
//
// The seed is neutral v3 end-to-end: a v3 source's canonical baseline is copied
// (never mutated), a v1/v2 source is migrated in memory first. The neutral
// envelope carries no session_id — the child log's header id owns the identity
// and stamps it onto the legacy read view at projection time. The behavior pin
// asserts the neutral seed's resume equals the legacy-projection round-trip
// resume (the path the former legacy seed took through open's normalization).
import { describe, expect, it } from 'vitest'
import { formatSupplementInstruction } from '../../steering-format.js'
import { buildForkSeed } from './fork.js'
import { historyFromEvents } from './replay.js'
import { migrateEventToV3 } from './migration.js'
import { projectNeutralEventToLegacy } from './format.js'
import type { NativeLogEvent } from './format.js'
import type { NativeSessionLogSnapshot } from './log.js'
import { projectNativeHistoryToWire } from '../wire/wire-projection.js'
import { brandString } from '../vocabulary/brand.js'
import type { NativeSessionEvent, SessionEvent } from '../vocabulary/session-event.js'
import type { ContentBlock } from '../vocabulary/types.js'

const TS = '2026-11-09T00:00:00.000Z'
const TIME = Date.parse(TS)

// ── neutral fixture constructors ────────────────────────────────────────────
function nUser(seq: number, uuid: string, parent: string | null, content: ContentBlock[]): SessionEvent<'user/message'> {
  return {
    type: 'user/message', seq, time: TIME, parentToolUseId: parent,
    data: { role: 'user', id: brandString<'MessageId'>(uuid), content, source: { kind: 'user' } },
  }
}
function nAssistant(seq: number, uuid: string, content: ContentBlock[]): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message', seq, time: TIME, parentToolUseId: null,
    data: {
      message: { role: 'assistant', id: brandString<'MessageId'>(uuid), content, source: { kind: 'model', provider: 'anthropic', model: 'claude-x' } },
      stream: [],
    },
  }
}
function nSkill(seq: number, name: string, body: string): SessionEvent<'session/skill'> {
  return { type: 'session/skill', seq, time: TIME, data: { name, body, timestamp: TS } }
}
function nContext(seq: number, text: string): SessionEvent<'session/context'> {
  return { type: 'session/context', seq, time: 0, data: { text } }
}
const toolCall = (id: string): ContentBlock => ({ type: 'tool-call', id: brandString<'ToolCallId'>(id), name: 'Read', arguments: '{}' })
const text = (t: string): ContentBlock => ({ type: 'text', text: t })

/** A v3 snapshot: `neutralEvents` is the canonical baseline (returned by
 *  reference from neutralEventsOf); `events` is its legacy read view. */
function neutralSource(events: NativeSessionEvent[]): NativeSessionLogSnapshot {
  return {
    header: { type: 'session/header', v: 3, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
    events: events.map((event) => projectNeutralEventToLegacy(event, 'src')),
    neutralEvents: events,
    path: '/p', completeBytes: 0, totalBytes: 0,
  }
}
/** An unmigrated v1/v2 snapshot: legacy `events`, no neutral baseline. */
function legacySource(events: NativeLogEvent[], v: number): NativeSessionLogSnapshot {
  return {
    header: { type: 'session/header', v, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
    events, path: '/p', completeBytes: 0, totalBytes: 0,
  } as NativeSessionLogSnapshot
}

/** Wire request messages replayed from a neutral event stream — the durable
 *  resume contract. Replay mints fresh ids for context/skill text messages on
 *  every call, but those never reach the API; the wire projection reads
 *  role/content only, so it is the deterministic resume-equivalence oracle. */
function wireReplay(events: NativeSessionEvent[]): Promise<unknown[]> {
  return projectNativeHistoryToWire(historyFromEvents(events), {}, new AbortController().signal)
}
/** The former legacy fork resume path: project the neutral seed to legacy SDK
 *  lines (stamping the child id) and migrate back — exactly what open did to a
 *  legacy seed before replaying it. */
function legacyRoundTrip(seed: NativeSessionEvent[]): NativeSessionEvent[] {
  return seed.map((event) => migrateEventToV3(projectNeutralEventToLegacy(event, 'dst')))
}

const source = neutralSource([
  nContext(0, 'ctx'),
  nUser(1, 'u1', null, [text('hi')]),
  nAssistant(2, 'a1', [toolCall('t1')]),
])

describe('buildForkSeed (neutral)', () => {
  it('cuts inclusively, marks the seed and repairs the open turn', () => {
    const seed = buildForkSeed({ source, sourceId: 'src', cwd: '/new', resumeSessionAt: 'a1' })
    expect(seed.isSeeded).toBe(true)
    expect(seed.version).toBe(3)
    expect(seed.inheritedEventCount).toBe(3)
    expect(seed.events.slice(0, 3).map((e) => e.seq)).toEqual([0, 1, 2])
    expect(seed.events.every((e) => 'data' in e)).toBe(true)
    expect(seed.events.some((e) => e.type === 'session/end-seed')).toBe(true)
    expect(seed.events.some((e) => e.type === 'turn/end' && e.data.reason === 'forked')).toBe(true)
    const synthetic = seed.events.filter((e) => e.type === 'tool/result')
    expect(synthetic).toHaveLength(1)
    expect(synthetic[0].data.message.isError).toBe(true)
    expect(synthetic[0].data.message.toolCallId).toBe('t1')
    const context = seed.events.filter((e) => e.type === 'session/context')
    expect(context.map((e) => e.data.text)).toEqual(['ctx', expect.stringContaining('/new')])
  })
  it('copies the full prefix when no boundary is given', () => {
    expect(buildForkSeed({ source, sourceId: 'src', cwd: '/new' }).inheritedEventCount).toBe(3)
  })
  it('carries no source session_id; the child projection stamps the child id; source untouched', () => {
    const before = JSON.stringify(source)
    const seed = buildForkSeed({ source, sourceId: 'src', cwd: '/new' })
    // The neutral envelope has no session_id field at all.
    expect(seed.events.every((e) => !('session_id' in e))).toBe(true)
    // The child's legacy read view stamps the CHILD id on every message event.
    const projected = seed.events.map((e) => projectNeutralEventToLegacy(e, 'dst'))
    const withSessionId = projected.filter((e) => 'session_id' in e) as Array<{ session_id: string }>
    expect(withSessionId.length).toBeGreaterThan(0)
    expect(withSessionId.every((e) => e.session_id === 'dst')).toBe(true)
    // The source baseline (returned by reference) is never mutated.
    expect(JSON.stringify(source)).toBe(before)
  })
  it('rejects an unknown boundary uuid', () => {
    expect(() => buildForkSeed({ source, sourceId: 'src', cwd: '/new', resumeSessionAt: 'nope' })).toThrow(/fork boundary/)
  })
  it('copies a subagent descriptor with its identity, parent, and profile intact', () => {
    const descriptor: SessionEvent<'subagent/descriptor'> = {
      type: 'subagent/descriptor', seq: 1, time: TIME,
      data: {
        toolUseId: 'agent-1', parentToolUseId: 'parent-1', kind: 'agent', toolName: 'Agent',
        label: 'review', depth: 2, profile: { name: 'reviewer', instruction: 'REVIEW', skills: [] }, timestamp: TS,
      },
    }
    const withDescriptor = neutralSource([nContext(0, 'ctx'), descriptor])
    const seed = buildForkSeed({ source: withDescriptor, sourceId: 'src', cwd: '/new' })
    expect(seed.events.find((event) => event.type === 'subagent/descriptor')).toEqual({ ...descriptor, seq: 1 })
  })
  it('includes an immediately following session/skill when cutting at its raw user', () => {
    const image: ContentBlock = { type: 'image', source: { type: 'base64', data: 'x', media_type: 'image/png' } }
    const withSkill = neutralSource([
      nUser(0, 'u1', null, [image, text('/alpha args'), text('/beta')]),
      nSkill(1, 'alpha', 'PERSISTED SKILL BODY'),
      nAssistant(2, 'a1', [text('done')]),
    ])
    const seed = buildForkSeed({ source: withSkill, sourceId: 'src', cwd: '/new', resumeSessionAt: 'u1' })
    expect(seed.inheritedEventCount).toBe(2)
    expect(seed.events.slice(0, 2)).toEqual([
      { ...nUser(0, 'u1', null, [image, text('/alpha args'), text('/beta')]), seq: 0 },
      { ...nSkill(1, 'alpha', 'PERSISTED SKILL BODY'), seq: 1 },
    ])
  })
  it('pairs a case-insensitive command invocation with its instruction at the cut', () => {
    // Command lookup folds case, so the typed token `/ALPHA` can expand the
    // authored `alpha` row; the fork cut must still keep the pair together.
    const withCommand = neutralSource([
      nUser(0, 'u1', null, [text('/ALPHA args')]),
      nSkill(1, 'alpha', 'PERSISTED COMMAND BODY'),
      nAssistant(2, 'a1', [text('done')]),
    ])
    const seed = buildForkSeed({ source: withCommand, sourceId: 'src', cwd: '/new', resumeSessionAt: 'u1' })
    expect(seed.inheritedEventCount).toBe(2)
    expect(seed.events[1]).toEqual({ ...nSkill(1, 'alpha', 'PERSISTED COMMAND BODY'), seq: 1 })
  })
  it.each([
    { label: 'ordinary text', parent: null, content: [text('ordinary prompt')] },
    { label: 'sidechain invocation', parent: 'agent-1', content: [text('/alpha')] },
    { label: 'name mismatch', parent: null, content: [text('/beta')] },
  ])('does not extend a cut for a $label before session/skill', ({ parent, content }) => {
    const src = neutralSource([nUser(0, 'u1', parent, content), nSkill(1, 'alpha', 'PERSISTED SKILL BODY')])
    const seed = buildForkSeed({ source: src, sourceId: 'src', cwd: '/new', resumeSessionAt: 'u1' })
    expect(seed.inheritedEventCount).toBe(1)
    expect(seed.events.filter((event) => event.type === 'session/skill')).toEqual([])
  })
  it('does not extend a cut at a tool/result uuid before session/skill', () => {
    const toolResult: SessionEvent<'tool/result'> = {
      type: 'tool/result', seq: 0, time: TIME, parentToolUseId: null,
      data: {
        message: {
          role: 'tool', id: brandString<'MessageId'>('u1'), source: { kind: 'tool', callId: brandString<'ToolCallId'>('t1') },
          toolCallId: brandString<'ToolCallId'>('t1'), content: [text('ok')], isError: false,
        },
      },
    }
    const src = neutralSource([toolResult, nSkill(1, 'alpha', 'PERSISTED SKILL BODY')])
    const seed = buildForkSeed({ source: src, sourceId: 'src', cwd: '/new', resumeSessionAt: 'u1' })
    expect(seed.inheritedEventCount).toBe(1)
    expect(seed.events.filter((event) => event.type === 'session/skill')).toEqual([])
  })
  it('leaves a raw-only crash prefix raw-only instead of inventing a skill', () => {
    const rawOnly = neutralSource([nUser(0, 'u1', null, [text('/alpha')])])
    const seed = buildForkSeed({ source: rawOnly, sourceId: 'src', cwd: '/new', resumeSessionAt: 'u1' })
    expect(seed.inheritedEventCount).toBe(1)
    expect(seed.events.filter((event) => event.type === 'session/skill')).toEqual([])
    expect(JSON.stringify(historyFromEvents(seed.events))).toContain('/alpha')
  })
  it('keeps assistant anchors exclusive of later raw-user skill groups', () => {
    const withLaterSkill = neutralSource([
      nUser(0, 'u1', null, [text('/alpha')]),
      nSkill(1, 'alpha', 'FIRST SKILL'),
      nAssistant(2, 'a1', [text('done')]),
      nUser(3, 'u2', null, [text('/beta')]),
      nSkill(4, 'beta', 'SECOND SKILL'),
    ])
    const seed = buildForkSeed({ source: withLaterSkill, sourceId: 'src', cwd: '/new', resumeSessionAt: 'a1' })
    expect(seed.inheritedEventCount).toBe(3)
    expect(seed.events.filter((event) => event.type === 'session/skill')).toEqual([
      { ...nSkill(1, 'alpha', 'FIRST SKILL'), seq: 1 },
    ])
  })
  it('copies a supplement into the seed and replays it at its position', () => {
    const wrapped = formatSupplementInstruction('pivot')
    const supplement: SessionEvent<'session/supplement'> = {
      type: 'session/supplement', seq: 2, time: TIME, data: { uuid: 'steer-1', text: wrapped, timestamp: TS },
    }
    const withSupplement = neutralSource([
      nContext(0, 'ctx'),
      nUser(1, 'u1', null, [text('go')]),
      supplement,
      nUser(3, 'u2', null, [text('later')]),
    ])
    const seed = buildForkSeed({ source: withSupplement, sourceId: 'src', cwd: '/new' })
    expect(seed.events.filter((e) => e.type === 'session/supplement')).toEqual([{ ...supplement, seq: 2 }])
    const messages = historyFromEvents(seed.events) as Array<{ role: string; content: ReadonlyArray<{ text?: string }> }>
    expect(messages.map((m) => m.content[0]?.text)).toEqual([
      'ctx', 'go', wrapped, 'later', expect.stringContaining('/new'),
    ])
  })
  it('preserves prompt uuids and the cut point; neutral resume equals the legacy round-trip resume', async () => {
    const seed = buildForkSeed({ source, sourceId: 'src', cwd: '/new', resumeSessionAt: 'a1' })
    // Prompt uuid intact on the copied user event; assistant anchor preserved.
    expect(seed.events[1].type === 'user/message' && seed.events[1].data.id).toBe('u1')
    expect(seed.events[2].type === 'assistant/message' && seed.events[2].data.message.id).toBe('a1')
    // Behavior pin: the neutral seed's resume (wire request) equals the former
    // legacy seed's path (project to legacy SDK lines, migrate back, replay).
    expect(await wireReplay(seed.events)).toEqual(await wireReplay(legacyRoundTrip(seed.events)))
  })
})

describe('buildForkSeed (v1/v2 source migrates to neutral)', () => {
  const attachment = {
    id: 'upload-1', name: 'notes.txt', size: 123, digest: 'd'.repeat(64),
    path: '/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle',
  }
  const sourceV2 = legacySource([
    { seq: 0, type: 'user', uuid: 'structured-user', session_id: 'src', parent_tool_use_id: null, timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'file', attachment }, { type: 'text', text: 'after' }] } },
    { seq: 1, type: 'session/attachments', attachments: [attachment], timestamp: TS },
    { seq: 2, type: 'assistant', uuid: 'answer-uuid', session_id: 'src', parent_tool_use_id: null, timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ] as NativeLogEvent[], 2)

  it('migrates the source to a neutral v3 seed preserving occurrences, uuids and catalog', async () => {
    const seed = buildForkSeed({ source: sourceV2, sourceId: 'src', cwd: '/new', resumeSessionAt: 'answer-uuid' })
    expect(seed.version).toBe(3)
    expect(seed.events.every((e) => 'data' in e)).toBe(true)
    expect(seed.inheritedEventCount).toBe(3)
    const user = seed.events[0]
    expect(user.type === 'user/message' && user.data.id).toBe('structured-user')
    expect(user.type === 'user/message' && user.data.content[1]).toEqual({ type: 'file', attachment })
    expect(seed.events[1].type === 'session/attachments' && seed.events[1].data.attachments).toEqual([attachment])
    expect(seed.events[2].type === 'assistant/message' && seed.events[2].data.message.id).toBe('answer-uuid')
    const history = historyFromEvents(seed.events)
    expect(JSON.stringify(history)).toContain('"type":"file"')
    expect(JSON.stringify(history)).not.toContain('session/attachments')
    // Behavior pin: neutral resume == the legacy fork resume round-trip.
    expect(await wireReplay(seed.events)).toEqual(await wireReplay(legacyRoundTrip(seed.events)))
  })
  it('does not invent an attachment catalog for a raw-only v2 prefix', () => {
    const rawOnly = legacySource([
      { seq: 0, type: 'user', uuid: 'raw-user', session_id: 'src', parent_tool_use_id: null, timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'raw only' }] } },
    ] as NativeLogEvent[], 2)
    const seed = buildForkSeed({ source: rawOnly, sourceId: 'src', cwd: '/new', resumeSessionAt: 'raw-user' })
    expect(seed.events.filter((event) => event.type === 'session/attachments')).toEqual([])
    expect(JSON.stringify(historyFromEvents(seed.events))).toContain('raw only')
  })
  it('does not mutate the legacy source snapshot', () => {
    const before = JSON.stringify(sourceV2)
    buildForkSeed({ source: sourceV2, sourceId: 'src', cwd: '/new' })
    expect(JSON.stringify(sourceV2)).toBe(before)
  })
})
