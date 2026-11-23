import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NativeAttachmentReferenceIndex,
  nativeAttachmentOccurrences,
} from './attachment-reference-index.js'
import { NativeSessionLog, loadNativeSessionLog } from './session-log/log.js'
import { nativeSessionDir } from './session-log/paths.js'
import { projectNeutralEventToLegacy } from './session-log/format.js'
import type {
  NativeEventInput,
  NativeFileAttachment,
  NativeLogEvent,
} from './session-log/format.js'
import type { NativeSessionEvent } from './vocabulary/session-event.js'
import type { ContentBlock } from './vocabulary/types.js'
import { brandString } from './vocabulary/brand.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'attachment-index-'))
  dirs.push(dir)
  return dir
}

const TS_ISO = '2026-11-13T00:00:00.000Z'
const TS = Date.parse(TS_ISO)

function attachment(id: string): NativeFileAttachment {
  return {
    id,
    name: `${id}.txt`,
    size: 4,
    digest: 'a'.repeat(64),
    path: join('registry', `${id}.txt`),
    modelForm: 'handle',
  }
}

function userWith(content: unknown[]): NativeEventInput {
  return {
    type: 'user',
    uuid: 'user-1',
    session_id: 'native-1',
    parent_tool_use_id: null,
    timestamp: TS_ISO,
    message: { role: 'user', content },
  }
}

function neutralUser(seq: number, uuid: string, parent: string | null, content: ContentBlock[]): NativeSessionEvent {
  return {
    type: 'user/message',
    seq,
    time: TS,
    parentToolUseId: parent,
    data: { role: 'user', id: brandString<'MessageId'>(uuid), content, source: { kind: 'user' } },
  }
}

function neutralToolResult(seq: number, uuid: string, callId: string, parent: string | null, content: ContentBlock[]): NativeSessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: TS,
    parentToolUseId: parent,
    data: {
      message: {
        role: 'tool',
        id: brandString<'MessageId'>(uuid),
        source: { kind: 'tool', callId: brandString<'ToolCallId'>(callId) },
        toolCallId: brandString<'ToolCallId'>(callId),
        content,
        isError: false,
      },
    },
  }
}

/** The pre-neutralization scan, kept verbatim as the behavior-preservation
 *  reference: the neutral read must yield exactly what this legacy scan
 *  yielded on the legacy projection of the same log. */
function legacyAttachmentScan(events: readonly NativeLogEvent[]): NativeFileAttachment[] {
  const isFileBlock = (value: unknown): value is { type: 'file'; attachment: NativeFileAttachment } =>
    typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'file'
    && typeof (value as { attachment?: unknown }).attachment === 'object'
    && (value as { attachment?: unknown }).attachment !== null
  const occurrences: NativeFileAttachment[] = []
  for (const event of events) {
    if (event.type === 'session/attachments') {
      occurrences.push(...event.attachments)
      continue
    }
    if (event.type !== 'user') continue
    for (const block of event.message.content) {
      if (isFileBlock(block)) {
        occurrences.push(block.attachment)
        continue
      }
      if (typeof block !== 'object' || block === null) continue
      const candidate = block as { type?: unknown; content?: unknown }
      if (candidate.type !== 'tool_result' || !Array.isArray(candidate.content)) continue
      for (const inner of candidate.content) {
        if (isFileBlock(inner)) occurrences.push(inner.attachment)
      }
    }
  }
  return occurrences
}

async function writeV2Log(dir: string, id: string, events: NativeEventInput[]): Promise<void> {
  const log = NativeSessionLog.open({ stateDir: dir, id, cwd: dir, resume: false })
  await log.migrateToV2()
  for (const event of events) log.append(event)
  await log.flush()
  await log.close()
}

/** A genuinely UNMIGRATED v2 log on disk (seed version 2, legacy appends):
 *  its snapshot carries no neutralEvents, so a neutral read must fall back
 *  to the lossless migration. */
async function writeUnmigratedV2Log(dir: string, id: string, events: NativeEventInput[]): Promise<void> {
  const log = NativeSessionLog.open({
    stateDir: dir,
    id,
    cwd: dir,
    resume: false,
    seed: { events: [], inheritedEventCount: 0, isSeeded: false, version: 2 },
  })
  for (const event of events) log.append(event)
  await log.flush()
  await log.close()
}

describe('nativeAttachmentOccurrences', () => {
  it('collects direct, tool/result inner, sidechain, and hidden-catalog occurrences only', () => {
    const direct = attachment('direct')
    const nested = attachment('nested')
    const catalog = attachment('catalog')
    const side = attachment('side')
    const events: NativeSessionEvent[] = [
      neutralUser(0, 'user-1', null, [
        { type: 'text', text: 'old handles carry no structured authorization' },
        { type: 'file', attachment: direct },
      ]),
      neutralToolResult(1, 'tr-1', 'call-1', null, [{ type: 'file', attachment: nested }]),
      { type: 'session/attachments', seq: 2, time: TS, data: { attachments: [catalog], timestamp: TS_ISO } },
      neutralUser(3, 'user-2', 'agent-1', [{ type: 'file', attachment: side }]),
    ]

    expect(nativeAttachmentOccurrences(events).map((entry) => entry.id)).toEqual([
      'direct', 'nested', 'catalog', 'side',
    ])
    // Behavior pin: deep-equal to the legacy scan on the legacy projection.
    expect(nativeAttachmentOccurrences(events)).toEqual(
      legacyAttachmentScan(events.map((event) => projectNeutralEventToLegacy(event, 'native-1'))),
    )
  })
})

describe('NativeAttachmentReferenceIndex', () => {
  it('rebuilds dormant v2 references from disk and maintains fork/delete increments', async () => {
    const dir = await stateDir()
    await writeV2Log(dir, 'dormant', [userWith([{ type: 'file', attachment: attachment('upload-1') }])])
    const index = new NativeAttachmentReferenceIndex({ stateDir: dir })

    await index.rebuild()
    expect(index.hasReference('upload-1')).toBe(true)
    expect(index.hasReference('other')).toBe(false)
    expect(index.occurrencesForSession('dormant').map((entry) => entry.id)).toEqual(['upload-1'])

    index.replaceSession('fork', [neutralUser(0, 'fork-user', null, [{ type: 'file', attachment: attachment('upload-1') }])])
    index.removeSession('dormant')
    expect(index.hasReference('upload-1')).toBe(true)
    index.removeSession('fork')
    expect(index.hasReference('upload-1')).toBe(false)
  })

  it('rebuilds an unmigrated v2 log through the neutralEventsOf migration fallback (v1/v2 fixture pin)', async () => {
    const dir = await stateDir()
    const legacyEvents: NativeEventInput[] = [
      userWith([{ type: 'file', attachment: attachment('upload-1') }]),
      {
        type: 'user',
        uuid: 'tr-1',
        session_id: 'native-1',
        parent_tool_use_id: 'agent-1',
        timestamp: TS_ISO,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'file', attachment: attachment('inner-1') }] }],
        },
      },
      { type: 'session/attachments', attachments: [attachment('catalog-1')], timestamp: TS_ISO },
    ]
    await writeUnmigratedV2Log(dir, 'legacy', legacyEvents)
    const snapshot = await loadNativeSessionLog(dir, 'legacy')
    expect(snapshot?.header.v).toBe(2)
    expect(snapshot?.neutralEvents).toBeUndefined()

    const index = new NativeAttachmentReferenceIndex({ stateDir: dir })
    await index.rebuild()
    expect(index.occurrencesForSession('legacy')).toEqual(legacyAttachmentScan(snapshot!.events))
    expect(index.occurrencesForSession('legacy').map((entry) => entry.id)).toEqual([
      'upload-1', 'inner-1', 'catalog-1',
    ])
    expect(index.hasReference('upload-1')).toBe(true)
    expect(index.hasReference('inner-1')).toBe(true)
    expect(index.hasReference('catalog-1')).toBe(true)
    expect(index.hasReference('other')).toBe(false)
  })

  it('reference-counts in-flight leases independently of persisted references', () => {
    const index = new NativeAttachmentReferenceIndex({ stateDir: join(tmpdir(), 'unused') })
    index.acquireLease('upload-1')
    index.acquireLease('upload-1')
    index.releaseLease('upload-1')
    expect(index.hasReference('upload-1')).toBe(true)
    index.releaseLease('upload-1')
    expect(index.hasReference('upload-1')).toBe(false)
  })

  it('fails closed when any native reference log cannot be read, then recovers after deletion', async () => {
    const dir = await stateDir()
    const corruptDir = nativeSessionDir(dir, 'corrupt')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(join(corruptDir, 'session.v1.jsonl'), '{not json\n')
    const index = new NativeAttachmentReferenceIndex({ stateDir: dir })

    await index.rebuild()
    expect(index.hasReference('unrelated-upload')).toBe(true)
    index.removeSession('corrupt')
    expect(index.hasReference('unrelated-upload')).toBe(false)
  })
})

describe('NativeAttachmentReferenceIndex pending-input references (T7b-6 §10)', () => {
  it('blocks deletion of a file referenced by a durable pending dispatch state', async () => {
    const index = new NativeAttachmentReferenceIndex({ stateDir: await stateDir() })
    await index.rebuild()
    expect(index.hasReference('upload-1')).toBe(false)
    // A queued-not-published prompt references upload-1; after a crash the
    // in-memory lease is gone and the prompt is not yet in the log.
    index.setPendingInputReferences('s1', ['upload-1'])
    expect(index.hasReference('upload-1')).toBe(true)
    expect(index.hasReference('other')).toBe(false)
    // Materialized/withdrawn → cleared.
    index.setPendingInputReferences('s1', [])
    expect(index.hasReference('upload-1')).toBe(false)
  })

  it('removeSession clears pending references', async () => {
    const index = new NativeAttachmentReferenceIndex({ stateDir: await stateDir() })
    await index.rebuild()
    index.setPendingInputReferences('s1', ['upload-1'])
    index.removeSession('s1')
    expect(index.hasReference('upload-1')).toBe(false)
  })
})