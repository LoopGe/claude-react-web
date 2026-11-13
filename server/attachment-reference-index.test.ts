import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NativeAttachmentReferenceIndex,
  nativeAttachmentOccurrences,
} from './attachment-reference-index.js'
import { NativeSessionLog } from './providers/native/session-log/log.js'
import { nativeSessionDir } from './providers/native/session-log/paths.js'
import type {
  NativeEventInput,
  NativeFileAttachment,
  NativeLogEvent,
} from './providers/native/session-log/format.js'

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
    timestamp: '2026-11-13T00:00:00.000Z',
    message: { role: 'user', content },
  }
}

async function writeV2Log(dir: string, id: string, events: NativeEventInput[]): Promise<void> {
  const log = NativeSessionLog.open({ stateDir: dir, id, cwd: dir, resume: false })
  await log.migrateToV2()
  for (const event of events) log.append(event)
  await log.flush()
  await log.close()
}

describe('nativeAttachmentOccurrences', () => {
  it('collects direct, nested tool-result, and hidden-catalog occurrences only', () => {
    const direct = attachment('direct')
    const nested = attachment('nested')
    const catalog = attachment('catalog')
    const events: NativeLogEvent[] = [
      {
        seq: 0,
        ...userWith([
          { type: 'text', text: 'old handles carry no structured authorization' },
          { type: 'file', attachment: direct },
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: [{ type: 'file', attachment: nested }],
          },
        ]),
      } as NativeLogEvent,
      {
        seq: 1,
        type: 'session/attachments',
        attachments: [catalog],
        timestamp: '2026-11-13T00:00:01.000Z',
      },
    ]

    expect(nativeAttachmentOccurrences(events).map((entry) => entry.id)).toEqual([
      'direct', 'nested', 'catalog',
    ])
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

    index.replaceSession('fork', [userWith([{ type: 'file', attachment: attachment('upload-1') }])])
    index.removeSession('dormant')
    expect(index.hasReference('upload-1')).toBe(true)
    index.removeSession('fork')
    expect(index.hasReference('upload-1')).toBe(false)
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
