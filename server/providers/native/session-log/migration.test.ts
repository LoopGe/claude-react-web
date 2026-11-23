// migration.test.ts
//
// Lossless v1/v2 → v3 migration pin (design "Persistence v3 + migration", R5/R7).
// Two layers:
//   1. migrateEventToV3 — per-event field fidelity + the PARSED-LINE round-trip
//      pin: projectNeutralEventToLegacy(migrateEventToV3(e)) === e on a corpus of
//      real-shaped native log events (image-bearing, rare stop_reasons, thinking
//      signatures, compact, skill, blockPaths, usage, agent base, parent
//      null-vs-string, isCompactSummary).
//   2. migrateToV3 — the eager-at-open writer migration: a real v2 log on disk
//      upgrades to v3 before the first append, idempotent, every event rewritten,
//      the legacy projection of the neutral baseline + model history unchanged
//      (T6 dropped the live legacy read view); fresh seeds default v3.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeSessionLog, loadNativeSessionLogSync } from './log.js'
import { migrateEventToV3 } from './migration.js'
import { projectNeutralEventToLegacy, serializeEvent, serializeHeader } from './format.js'
import type { NativeLogEvent, NativeSessionHeader } from './format.js'
import { historyFromEvents } from './replay.js'
import { nativeSessionDir, nativeSessionLogPath } from './paths.js'
import type { StoredAgentDefinition } from '../../../agent-definition-store.js'

const SID = 's1'
const TS = '2026-11-21T10:00:00.000Z'
const TS2 = '2026-11-21T10:00:01.500Z'

const attachment = {
  id: 'upload-1',
  name: 'notes.txt',
  size: 123,
  digest: 'b'.repeat(64),
  path: '/registry/notes.txt',
  mediaType: 'text/plain',
  modelForm: 'handle' as const,
}
const pdfAttachment = {
  id: 'upload-2',
  name: 'spec.pdf',
  size: 4096,
  digest: 'c'.repeat(64),
  path: '/registry/spec.pdf',
  mediaType: 'application/pdf',
  modelForm: 'pdf-document' as const,
}
const imageBlock = { type: 'image', source: { type: 'base64', data: 'aGVsbG8taW1hZ2U=', media_type: 'image/png' } }
const imageRefBlock = { type: 'image', attachment: { id: `sha256:${'d'.repeat(64)}`, mediaType: 'image/png', bytes: 11, width: 4, height: 4 } }

const agentDefinition: StoredAgentDefinition = {
  name: 'reviewer',
  description: 'Reviews code',
  prompt: 'You review code.',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  model: 'claude-x',
  tools: ['Read', 'Grep'],
}
const agentBase = { model: 'base-model', permissionMode: 'default', effortLevel: 'high', skillPolicy: 'all' as const }

/** A real-shaped native v2 log corpus: every durable event type, image-bearing
 *  user content (inline base64 + store ref + structured files), signed/redacted
 *  thinking, common + rare stop_reasons, compact, skill, supplement, descriptor,
 *  attachment catalog, agent selection, sidechain parents, isCompactSummary. */
/** Omit that distributes over the discriminated union so each member keeps its
 *  own fields (a plain Omit<Union, K> collapses to the common keys). */
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never

function corpus(): NativeLogEvent[] {
  const events: Array<WithoutSeq<NativeLogEvent>> = [
    { type: 'session/context', text: '<system-reminder>Working directory: /repo</system-reminder>' },
    {
      type: 'user', uuid: 'u1', session_id: SID, parent_tool_use_id: null, timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: 'look' }, imageBlock, imageRefBlock, { type: 'file', attachment }] },
    },
    {
      type: 'assistant', uuid: 'a1', session_id: SID, parent_tool_use_id: null, timestamp: TS2,
      message: {
        // GENUINE old durable shape: the SDK message.id is INDEPENDENT of the
        // event uuid (pre-neutral frames.ts minted `msg_<random>`; M ≠ uuid).
        type: 'assistant', role: 'assistant', id: 'msg_M1', model: 'claude-x', stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'pondering', signature: 'sig-abc' },
          { type: 'redacted_thinking', data: 'redacted-blob' },
          { type: 'text', text: 'running' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls', args: ['-la'] } },
        ],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
      },
    } as WithoutSeq<NativeLogEvent>,
    {
      type: 'user', uuid: 'tr1', session_id: SID, parent_tool_use_id: null, timestamp: TS2,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'ok' }, { type: 'file', attachment: pdfAttachment }], is_error: false }] },
    },
    {
      type: 'assistant', uuid: 'a2', session_id: SID, parent_tool_use_id: null, timestamp: TS2,
      message: { type: 'assistant', role: 'assistant', id: 'msg_M2', model: 'claude-x', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'halted' }], usage: { input_tokens: 1, output_tokens: 2 } },
    } as WithoutSeq<NativeLogEvent>,
    { type: 'session/skill', name: 'code-review', body: '# Code review\nDo the thing.', timestamp: TS2 },
    { type: 'session/supplement', uuid: 'sup1', text: '<system-reminder>steer</system-reminder>', timestamp: TS2 },
    { type: 'turn/end', reason: 'completed', usage: { input_tokens: 101, output_tokens: 22, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } },
    { type: 'session/compact', text: 'SUMMARY', context: 'CTX-SNAPSHOT', uuid: 'c1', timestamp: TS2 },
    {
      type: 'user', uuid: 'cs1', session_id: SID, parent_tool_use_id: null, timestamp: TS2, isCompactSummary: true,
      message: { role: 'user', content: [{ type: 'text', text: 'SUMMARY' }] },
    },
    {
      type: 'subagent/descriptor', toolUseId: 'tool-1', parentToolUseId: null, kind: 'agent', toolName: 'Agent',
      label: 'reviewer', depth: 1, profile: { name: 'reviewer', model: 'claude-x', maxTurns: 5 }, timestamp: TS2,
    },
    { type: 'session/attachments', attachments: [attachment, pdfAttachment], timestamp: TS2 },
    { type: 'session/agent', name: 'reviewer', definition: agentDefinition, base: agentBase, timestamp: TS2 },
    {
      type: 'assistant', uuid: 'a3', session_id: SID, parent_tool_use_id: 'tool-1', timestamp: TS2,
      message: { type: 'assistant', role: 'assistant', id: 'msg_M3', model: 'claude-x', stop_reason: null, content: [{ type: 'text', text: 'partial' }] },
    } as WithoutSeq<NativeLogEvent>,
    {
      type: 'user', uuid: 'u2', session_id: SID, parent_tool_use_id: 'tool-1', timestamp: TS2,
      message: { role: 'user', content: [{ type: 'text', text: 'sidechain prompt' }] },
    },
    { type: 'session/end-seed' },
    { type: 'turn/end', reason: 'interrupted' },
  ]
  return events.map((event, seq) => ({ ...event, seq }) as NativeLogEvent)
}

/** The parsed-line round-trip: migrate to neutral, project back to the legacy
 *  SDK line the host saw, and require deep equality with the source event. */
function roundTrip(event: NativeLogEvent): NativeLogEvent {
  return projectNeutralEventToLegacy(migrateEventToV3(event), SID)
}

let dir: string
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const fresh = async () => { dir = await mkdtemp(join(tmpdir(), 'native-migration-')); return dir }

describe('migrateEventToV3 — lossless per-event projection', () => {
  it('round-trips every corpus event to the identical parsed legacy line', () => {
    for (const event of corpus()) {
      expect(roundTrip(event)).toEqual(event)
    }
  })

  it('preserves uuid identity, contiguous seq and parent null-vs-string', () => {
    const events = corpus()
    const neutral = events.map(migrateEventToV3)
    expect(neutral.map((e) => e.seq)).toEqual(events.map((e) => e.seq))
    // user/assistant/tool message events carry the host uuid as the neutral id.
    const u1 = neutral[1]
    expect(u1.type).toBe('user/message')
    expect((u1 as { data: { id: string } }).data.id).toBe('u1')
    expect(u1.parentToolUseId).toBeNull()
    const a3 = neutral[13]
    expect(a3.parentToolUseId).toBe('tool-1')
    const u2 = neutral[14]
    expect(u2.parentToolUseId).toBe('tool-1')
    // operational events carry no parent axis.
    expect(neutral[0].parentToolUseId).toBeUndefined()
  })

  it('maps a tool_result user frame to a first-class tool/result preserving inner content + blockPaths', () => {
    const tr = corpus()[3]
    const neutral = migrateEventToV3(tr)
    expect(neutral.type).toBe('tool/result')
    const data = (neutral as unknown as { data: { message: { toolCallId: string; isError?: boolean; content: unknown[] } } }).data
    expect(data.message.toolCallId).toBe('tool-1')
    expect(data.message.isError).toBe(false)
    expect(data.message.content).toEqual([{ type: 'text', text: 'ok' }, { type: 'file', attachment: pdfAttachment }])
    // The legacy projection reconstructs the single tool_result block at index 0
    // with the file at inner index 1 — the occurrence blockPath [0, 1] survives.
    expect(roundTrip(tr)).toEqual(tr)
  })

  it('preserves a bare-string tool_result content verbatim (legacy SDK shape)', () => {
    const event: NativeLogEvent = {
      seq: 0, type: 'user', uuid: 'tr-str', session_id: SID, parent_tool_use_id: 'tool-1', timestamp: TS,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'native diff output', is_error: false }] },
    }
    const neutral = migrateEventToV3(event)
    expect(neutral.type).toBe('tool/result')
    const data = (neutral as unknown as { data: { message: { content: unknown[] }; meta?: { legacyStringContent?: string } } }).data
    // Neutral content normalizes the string to one text block; the verbatim
    // string rides meta so the legacy projection reconstructs it exactly.
    expect(data.message.content).toEqual([{ type: 'text', text: 'native diff output' }])
    expect(data.meta?.legacyStringContent).toBe('native diff output')
    const projected = roundTrip(event) as { message: { content: Array<{ content: unknown }> } }
    expect(projected.message.content[0].content).toBe('native diff output')
    expect(projected).toEqual(event)
  })

  it('preserves inline base64 images as LegacyImageBlock with NO store offload (R5)', () => {
    const u1 = corpus()[1]
    const neutral = migrateEventToV3(u1)
    const content = (neutral as unknown as { data: { content: Array<Record<string, unknown>> } }).data.content
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', data: 'aGVsbG8taW1hZ2U=', media_type: 'image/png' } })
    expect(content[1]).not.toHaveProperty('attachment')
    expect(content[1]).not.toHaveProperty('offloaded')
    // store-backed ref stays a ref; structured file keeps its full attachment.
    expect(content[2]).toEqual(imageRefBlock)
    expect(content[3]).toEqual({ type: 'file', attachment })
  })

  it('preserves thinking signatures and redacted data verbatim', () => {
    const a1 = corpus()[2]
    const neutral = migrateEventToV3(a1)
    const content = (neutral as unknown as { data: { message: { content: Array<Record<string, unknown>> } } }).data.message.content
    expect(content[0]).toEqual({ type: 'reasoning', text: 'pondering', signature: 'sig-abc' })
    expect(content[1]).toEqual({ type: 'reasoning', text: '', redacted: true, data: 'redacted-blob' })
    expect(content[3]).toEqual({ type: 'tool-call', id: 'tool-1', name: 'Bash', arguments: JSON.stringify({ command: 'ls', args: ['-la'] }) })
  })

  it('preserves isCompactSummary via the event-level data marker', () => {
    const cs = corpus()[9]
    const neutral = migrateEventToV3(cs)
    const data = (neutral as unknown as { data: { source: { kind: string }; isCompactSummary?: boolean } }).data
    expect(data.isCompactSummary).toBe(true)
    // The message source stays the closed core 'user' kind (no union widening).
    expect(data.source.kind).toBe('user')
    expect(roundTrip(cs)).toEqual(cs)
    expect((roundTrip(cs) as { isCompactSummary?: boolean }).isCompactSummary).toBe(true)
    // An ordinary user message carries no marker.
    const u1 = migrateEventToV3(corpus()[1])
    expect((u1 as unknown as { data: { isCompactSummary?: boolean } }).data.isCompactSummary).toBeUndefined()
    expect((roundTrip(corpus()[1]) as { isCompactSummary?: boolean }).isCompactSummary).toBeUndefined()
  })

  it('preserves compact text+context, skill body, supplement, descriptor, catalog and agent base verbatim', () => {
    const events = corpus()
    for (const index of [5, 6, 8, 10, 11, 12]) {
      expect(roundTrip(events[index])).toEqual(events[index])
    }
    const skill = migrateEventToV3(events[5])
    expect((skill as { data: { body: string } }).data.body).toBe('# Code review\nDo the thing.')
    const agent = migrateEventToV3(events[12])
    expect((agent as { data: { base: unknown; definition: unknown } }).data.base).toEqual(agentBase)
    expect((agent as { data: { definition: unknown } }).data.definition).toEqual(agentDefinition)
  })

  it('preserves assistant usage/model and turn-end cache usage', () => {
    const a1 = migrateEventToV3(corpus()[2])
    const data = (a1 as { data: { usage: unknown; message: { source: { model: string } } } }).data
    expect(data.message.source.model).toBe('claude-x')
    expect(data.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 7 })
    const turnEnd = migrateEventToV3(corpus()[7])
    expect((turnEnd as { data: { usage: unknown } }).data.usage).toEqual({ inputTokens: 101, outputTokens: 22, cacheReadTokens: 5, cacheWriteTokens: 7 })
    expect(roundTrip(corpus()[7])).toEqual(corpus()[7])
  })

  it('packs a settled-content stream with dt[0]=0 and a mapped finish record', () => {
    const a1 = migrateEventToV3(corpus()[2])
    const stream = (a1 as { data: { stream: Array<{ type: string; dt?: number[] }> } }).data.stream
    for (const record of stream) {
      if (record.dt) expect(record.dt[0]).toBe(0)
    }
    const finish = stream
      .map((r) => (r as { chunk?: { type: string; reason?: { kind: string } } }).chunk)
      .find((chunk) => chunk?.type === 'finish')
    expect(finish?.reason?.kind).toBe('tool-calls')
  })
})

describe('assistant SDK message.id independence (Goal-4 lossless identity)', () => {
  it('preserves an original message.id INDEPENDENT of the event uuid (real old durable shape)', () => {
    // Git-proven old shape: pre-neutral frames.ts assistantFrame minted
    // `msg_<crypto.randomUUID()>` distinct from the event uuid (U ≠ M).
    const event = {
      seq: 0, type: 'assistant', uuid: 'U-independent', session_id: SID, parent_tool_use_id: null, timestamp: TS,
      message: { type: 'assistant', role: 'assistant', id: 'msg_M-independent', model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
    } as NativeLogEvent
    const neutral = migrateEventToV3(event)
    const data = (neutral as unknown as { data: { message: { id: string }; meta?: { legacyMessageId?: string } } }).data
    // The neutral message id carries the host uuid; the verbatim SDK id rides meta.
    expect(data.message.id).toBe('U-independent')
    expect(data.meta?.legacyMessageId).toBe('msg_M-independent')
    const projected = roundTrip(event) as { uuid: string; message: { id: string } }
    expect(projected.uuid).toBe('U-independent')
    // The ORIGINAL independent id survives — NOT a rebuilt msg_<uuid>.
    expect(projected.message.id).toBe('msg_M-independent')
    expect(projected.message.id).not.toBe('msg_U-independent')
    expect(projected).toEqual(event)
  })

  it('new neutral-core logs (no meta) still project the msg_<uuid> convention', () => {
    const neutral = {
      type: 'assistant/message', seq: 0, time: 1000, parentToolUseId: null,
      data: {
        message: { id: 'U2', role: 'assistant', content: [{ type: 'text', text: 'x' }], source: { kind: 'model', provider: 'anthropic', model: 'm' } },
        stream: [],
      },
    }
    const projected = projectNeutralEventToLegacy(neutral as never, SID) as { message: { id: string } }
    expect(projected.message.id).toBe('msg_U2')
  })
})

describe('rare stop_reason raw carriage (T11 minor 1)', () => {
  const rareAssistant = (uuid: string, stopReason: string): NativeLogEvent => ({
    seq: 0, type: 'assistant', uuid, session_id: SID, parent_tool_use_id: null, timestamp: TS,
    // Independent SDK id (M ≠ uuid), the genuine old durable shape.
    message: { type: 'assistant', role: 'assistant', id: `msg_indep_${uuid}`, model: 'claude-x', stop_reason: stopReason, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } },
  } as NativeLogEvent)

  it.each(['stop_sequence', 'pause_turn', 'refusal', 'end_turn', 'tool_use', 'max_tokens'])(
    'preserves stop_reason %s verbatim through migration + projection',
    (reason) => {
      const event = rareAssistant(`a-${reason}`, reason)
      const neutral = migrateEventToV3(event)
      expect((neutral as { data: { rawStopReason?: string } }).data.rawStopReason).toBe(reason)
      const projected = roundTrip(event) as { message: { stop_reason: string } }
      expect(projected.message.stop_reason).toBe(reason)
      expect(projected).toEqual(event)
    },
  )

  it('carries no rawStopReason for a null stop_reason (interrupted turn)', () => {
    const event = corpus()[13] // a3, stop_reason null
    const neutral = migrateEventToV3(event)
    expect((neutral as { data: { rawStopReason?: string } }).data.rawStopReason).toBeUndefined()
    expect((roundTrip(event) as { message: { stop_reason: null } }).message.stop_reason).toBeNull()
  })
})

describe('migrateToV3 — eager-at-open writer migration', () => {
  /** Write a real v2 log to disk (header + corpus), bypassing the writer's eager
   *  migration so the resume path observes an unmigrated v1/v2 source. */
  async function writeLegacyLog(stateDir: string, id: string, version: number, events: NativeLogEvent[]): Promise<void> {
    const header: NativeSessionHeader = { type: 'session/header', v: version, id, cwd: '/repo', createdAt: Date.now(), isSeeded: false, inheritedEventCount: 0 }
    const body = serializeHeader(header) + '\n' + events.map((e) => serializeEvent(e) + '\n').join('')
    await mkdir(nativeSessionDir(stateDir, id), { recursive: true })
    await writeFile(nativeSessionLogPath(stateDir, id), body, 'utf8')
  }

  it('upgrades a v2 log to v3 at open, rewriting every event losslessly', async () => {
    const stateDir = await fresh()
    const events = corpus()
    await writeLegacyLog(stateDir, SID, 2, events)
    // Sanity: the source parses as v2 with the exact corpus.
    const before = loadNativeSessionLogSync(stateDir, SID)!
    expect(before.header.v).toBe(2)
    expect(before.events).toEqual(events)

    const log = NativeSessionLog.open({ stateDir, id: SID, cwd: '/repo', resume: true })
    await log.migrateToV3() // resolve the eager-at-open migration
    expect(log.header.v).toBe(3)
    await log.flush()
    await log.close()

    const after = loadNativeSessionLogSync(stateDir, SID)!
    expect(after.header.v).toBe(3)
    // Every event rewritten to neutral; seq contiguous; the legacy projection of
    // the neutral baseline is identical to the source (T6: no live legacy view).
    expect(after.neutralEvents!.map((e) => e.seq)).toEqual(events.map((e) => e.seq))
    expect(after.neutralEvents!.map((e) => e.type)).toEqual(events.map((e) => migrateEventToV3(e).type))
    expect(after.neutralEvents!.map((e) => projectNeutralEventToLegacy(e, SID))).toEqual(events)
    expect(after.events).toEqual([])
    // The on-disk bytes are neutral v3 lines (not the legacy source bytes).
    const text = await readFile(nativeSessionLogPath(stateDir, SID), 'utf8')
    expect(text).toContain('"type":"assistant/message"')
    expect(text).toContain('"type":"tool/result"')
    expect(text.split('\n')[0]).toContain('"v":3')
    // Model history is unchanged by the migration (neutral replay of the v3
    // baseline equals neutral replay of the migrated legacy corpus). Compare
    // role/content shape: the compact-floor seed messages mint fresh ids per
    // replay, which the wire projection never reads.
    const shape = (messages: ReturnType<typeof historyFromEvents>) => messages.map((m) => ({ role: m.role, content: m.content }))
    expect(shape(historyFromEvents(after.neutralEvents!))).toEqual(shape(historyFromEvents(events.map(migrateEventToV3))))
  })

  it('is idempotent: a second migration is a no-op and bytes are stable', async () => {
    const stateDir = await fresh()
    await writeLegacyLog(stateDir, SID, 2, corpus())
    const log = NativeSessionLog.open({ stateDir, id: SID, cwd: '/repo', resume: true })
    await log.migrateToV3()
    await log.flush()
    const firstBytes = await readFile(nativeSessionLogPath(stateDir, SID), 'utf8')
    await log.migrateToV3()
    await log.flush()
    const secondBytes = await readFile(nativeSessionLogPath(stateDir, SID), 'utf8')
    expect(secondBytes).toBe(firstBytes)
    expect(log.header.v).toBe(3)
    await log.close()
    // migrateEventToV3 is a deterministic pure projection.
    for (const event of corpus()) {
      expect(migrateEventToV3(event)).toEqual(migrateEventToV3(event))
    }
  })

  it('accepts legacy + neutral appends after migration with contiguous seq', async () => {
    const stateDir = await fresh()
    const events = corpus()
    await writeLegacyLog(stateDir, SID, 2, events)
    const log = NativeSessionLog.open({ stateDir, id: SID, cwd: '/repo', resume: true })
    await log.migrateToV3()
    // A legacy turn/end (core still emits these) and a neutral assistant append.
    log.append({ type: 'turn/end', reason: 'completed' })
    log.append({
      type: 'assistant/message', time: Date.now(), parentToolUseId: null,
      data: {
        message: { id: 'a-new' as never, role: 'assistant', content: [{ type: 'text', text: 'next' }], source: { kind: 'model', provider: 'anthropic', model: 'claude-x' } },
        stream: [], rawStopReason: 'end_turn',
      },
    })
    await log.flush()
    await log.close()
    const after = loadNativeSessionLogSync(stateDir, SID)!
    expect(after.neutralEvents!.map((e) => e.seq)).toEqual([...events.map((e) => e.seq), events.length, events.length + 1])
    // The write-compat projection of the post-migration appends (T6: read the
    // neutral baseline, project to legacy for the shape assertion).
    const afterLegacy = after.neutralEvents!.map((e) => projectNeutralEventToLegacy(e, SID))
    expect(afterLegacy[events.length]).toMatchObject({ type: 'turn/end', reason: 'completed' })
    expect(afterLegacy[events.length + 1]).toMatchObject({ type: 'assistant', uuid: 'a-new', message: { stop_reason: 'end_turn' } })
  })

  it('fresh seeds default to v3 and normalize a legacy seed losslessly', async () => {
    const stateDir = await fresh()
    const context: NativeLogEvent = { seq: 0, type: 'session/context', text: 'ctx' }
    const log = NativeSessionLog.open({
      stateDir, id: 'fresh', cwd: '/repo', resume: false,
      seed: { events: [context], inheritedEventCount: 0, isSeeded: false },
    })
    expect(log.header.v).toBe(3)
    expect(log.neutralEvents![0]).toMatchObject({ type: 'session/context', seq: 0, data: { text: 'ctx' } })
    // T6: no live legacy view; the compat projection reconstructs the seed line.
    expect(projectNeutralEventToLegacy(log.neutralEvents![0], 'fresh')).toEqual(context)
    expect(log.events).toEqual([])
    await log.close()
  })

  it('a legacy-version seed preserves its version until the eager migration upgrades it', async () => {
    const stateDir = await fresh()
    const events = corpus()
    await writeLegacyLog(stateDir, SID, 2, events)
    // The writer's v1/v2 compat contract: an explicit legacy seed version is
    // written as-is, then migrateToV3 upgrades it to neutral. (Fork seeds
    // themselves are neutral v3 — buildForkSeed migrates a legacy source in
    // memory; this pins open's seed-version handling, not the fork builder.)
    const log = NativeSessionLog.open({
      stateDir, id: 'child', cwd: '/repo', resume: false,
      seed: { events, inheritedEventCount: events.length, isSeeded: true, version: 2 },
    })
    await log.migrateToV3()
    expect(log.header.v).toBe(3)
    await log.flush()
    await log.close()
    const after = loadNativeSessionLogSync(stateDir, 'child')!
    expect(after.header.v).toBe(3)
    // The neutral events carry no session_id; the compat projection stamps the
    // child header id on message events only (operational events have none).
    // T6: read the neutral baseline, project to legacy for the fidelity pin.
    expect(after.neutralEvents!.map((e) => projectNeutralEventToLegacy(e, 'child'))).toEqual(events.map((e) =>
      e.type === 'user' || e.type === 'assistant' ? { ...e, session_id: 'child' } : e,
    ))
  })

  it('migrates a v1 log (no structured files) to v3', async () => {
    const stateDir = await fresh()
    const v1Events: NativeLogEvent[] = [
      { seq: 0, type: 'session/context', text: 'ctx' },
      { seq: 1, type: 'user', uuid: 'u1', session_id: SID, parent_tool_use_id: null, timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'hi' }, imageBlock] } },
      { seq: 2, type: 'turn/end', reason: 'completed' },
    ]
    await writeLegacyLog(stateDir, SID, 1, v1Events)
    const log = NativeSessionLog.open({ stateDir, id: SID, cwd: '/repo', resume: true })
    await log.migrateToV3()
    expect(log.header.v).toBe(3)
    await log.flush()
    await log.close()
    const after = loadNativeSessionLogSync(stateDir, SID)!
    // T6: no live legacy view; the compat projection of the neutral baseline
    // reconstructs the v1 source lines losslessly.
    expect(after.neutralEvents!.map((e) => projectNeutralEventToLegacy(e, SID))).toEqual(v1Events)
    expect(after.neutralEvents!.map((e) => e.type)).toEqual(['session/context', 'user/message', 'turn/end'])
  })
})