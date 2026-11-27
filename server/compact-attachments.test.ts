import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { aliasPathOf, attachmentRoot, imageObjectPathOf } from './attachment-paths.js'
import { AttachmentObjectStore } from './attachment-object-store.js'
import { UploadStore } from './upload-store.js'
import { inspectImageBytes } from '../shared/image-inspect.js'
import { imageRefId, type ImageAttachmentRef, type ImageRefBlock } from '../shared/image-attachment.js'
import type { NativeFileAttachment } from './providers/native/session-log/format.js'
import {
  buildCompactAttachmentContent,
  COMPACT_TEXT_FILE_BYTES,
  COMPACT_TEXT_TOTAL_BYTES,
} from './compact-attachments.js'

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function fixture(prefix = 'compact-attachments-') {
  const stateDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(stateDir)
  const store = new UploadStore({ stateDir })
  return { stateDir, store, uploadStore: store }
}

async function addUpload(
  fixture: { stateDir: string; store: UploadStore },
  id: string,
  bytes: Buffer,
  opts: { name?: string; modelForm?: NativeFileAttachment['modelForm']; mediaType?: string } = {},
): Promise<NativeFileAttachment> {
  const name = opts.name ?? `${id}.txt`
  const digest = createHash('sha256').update(bytes).digest('hex')
  const path = aliasPathOf(attachmentRoot(fixture.stateDir), digest, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  fixture.store.record([{
    id, path, cwd: fixture.stateDir, name, size: bytes.length, digest,
    uploadedAt: 1, sessionTitle: '', sessionId: 'compact-source',
  }])
  return {
    id, name, size: bytes.length, digest, path,
    ...(opts.mediaType ? { mediaType: opts.mediaType } : {}),
    modelForm: opts.modelForm ?? 'handle',
  }
}

function user(uuid: string, content: unknown[], parent: string | null = null): SDKMessage {
  return {
    type: 'user', uuid, parent_tool_use_id: parent,
    message: { role: 'user', content },
  } as unknown as SDKMessage
}

function occurrence(messageUuid: string, blockPath: number[], attachment: NativeFileAttachment) {
  return { messageUuid, blockPath, attachment }
}

function publicFile(attachment: NativeFileAttachment) {
  return {
    type: 'file',
    attachment: {
      id: attachment.id, name: attachment.name, size: attachment.size, digest: attachment.digest,
    },
  }
}

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

type ImageMeta = { mediaType: ImageAttachmentRef['mediaType']; width: number; height: number }

/** Publish bytes into the real image object store and return the ref the upload
 *  route would hand back. The resolver verifies digest/length/declared facts but
 *  never re-inspects image validity (an upload-time concern), so a budget test
 *  may publish opaque bytes. */
async function addImage(fixture: { stateDir: string }, bytes: Buffer, meta: ImageMeta): Promise<ImageAttachmentRef> {
  const objects = new AttachmentObjectStore(fixture.stateDir)
  const pub = await objects.publishImage(bytes, meta)
  return { id: imageRefId(pub.digest), mediaType: meta.mediaType, bytes: pub.bytes, width: meta.width, height: meta.height }
}

function inspectedPng(): { bytes: Buffer; meta: ImageMeta } {
  const bytes = Buffer.from(PNG_1X1, 'base64')
  const inspected = inspectImageBytes(bytes)
  if (!inspected.ok) throw new Error('fixture PNG must inspect')
  return { bytes, meta: inspected.image }
}

function imageRefBlock(ref: ImageAttachmentRef): ImageRefBlock {
  return { type: 'image', attachment: ref }
}

describe('buildCompactAttachmentContent', () => {
  it('hydrates a small UTF-8 attachment even when it is the only user content', async () => {
    const f = await fixture()
    const attachment = await addUpload(f, 'notes', Buffer.from('hello from the attachment'))
    const result = await buildCompactAttachmentContent(
      [user('u1', [publicFile(attachment)])],
      [occurrence('u1', [0], attachment)],
      f,
    )

    expect(result.hasAttachments).toBe(true)
    expect(result.hasNativeMedia).toBe(false)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('hello from the attachment')
    expect(text).toContain('Upload id: notes')
    expect(text).not.toContain(attachment.path)
    expect(text).not.toContain('Read-only path')
  })

  it('allocates exactly 65,536 bytes per file and 262,144 bytes per request, newest and last blocks first', async () => {
    const f = await fixture()
    const old = await addUpload(f, 'old', Buffer.alloc(70_000, 'o'))
    const first = await addUpload(f, 'first', Buffer.alloc(70_000, 'f'))
    const second = await addUpload(f, 'second', Buffer.alloc(70_000, 's'))
    const newerFirst = await addUpload(f, 'newer-first', Buffer.alloc(70_000, 'n'))
    const newerLast = await addUpload(f, 'newer-last', Buffer.alloc(70_000, 'l'))
    const messages = [
      user('old-message', [publicFile(old)]),
      user('middle-message', [publicFile(first), publicFile(second)]),
      user('new-message', [publicFile(newerFirst), publicFile(newerLast)]),
    ]
    const occurrences = [
      occurrence('old-message', [0], old),
      occurrence('middle-message', [0], first), occurrence('middle-message', [1], second),
      occurrence('new-message', [0], newerFirst), occurrence('new-message', [1], newerLast),
    ]
    const lookup = vi.spyOn(f.store, 'getById')

    const result = await buildCompactAttachmentContent(messages, occurrences, f)

    expect(COMPACT_TEXT_FILE_BYTES).toBe(65_536)
    expect(COMPACT_TEXT_TOTAL_BYTES).toBe(262_144)
    expect(result.content).toHaveLength(5)
    const serialized = JSON.stringify(result.content)
    expect(serialized).toContain('65,536')
    expect(serialized).toContain('262,144')
    expect(serialized).toContain('truncated')
    expect(serialized).not.toContain(f.stateDir)
    for (const block of result.content.slice(1)) {
      const text = (block as { text: string }).text
      expect(text).toContain('truncated')
    }
    expect((result.content[0] as { text: string }).text).toContain('not hydrated')
    expect(lookup).not.toHaveBeenCalledWith(old.id)
    // The four selected files retain exactly one 64 KiB window each. The old
    // file loses the request-budget race even though it appears first in output.
    for (const [index, char] of ['f', 's', 'n', 'l'].entries()) {
      const text = (result.content[index + 1] as { text: string }).text
      expect(text).toContain(char.repeat(65_536))
      expect(text).not.toContain(char.repeat(65_537))
    }
  })

  it('stops retaining text at the first non-fitting multibyte codepoint across chunks', async () => {
    const f = await fixture()
    const targetBytes = Buffer.concat([
      Buffer.from('é'),
      Buffer.alloc(65_534, 'x'),
      Buffer.from('L'),
    ])
    const target = await addUpload(f, 'utf8-prefix', targetBytes)
    const fillers = [
      await addUpload(f, 'fill-a', Buffer.alloc(65_536, 'a')),
      await addUpload(f, 'fill-b', Buffer.alloc(65_536, 'b')),
      await addUpload(f, 'fill-c', Buffer.alloc(65_536, 'c')),
      await addUpload(f, 'fill-d', Buffer.alloc(65_535, 'd')),
    ]

    const result = await buildCompactAttachmentContent([
      user('target', [publicFile(target)]),
      user('fillers', fillers.map(publicFile)),
    ], [
      occurrence('target', [0], target),
      ...fillers.map((attachment, index) => occurrence('fillers', [index], attachment)),
    ], f)

    const text = (result.content[0] as { text: string }).text
    expect(text).toContain(`included 0 of ${targetBytes.length} raw bytes`)
    expect(text).not.toContain('\nL\n')
  })

  it('injects a provider tool-result occurrence at its original block path', async () => {
    const f = await fixture()
    const attachment = await addUpload(f, 'tool-text', Buffer.from('text returned by AttachmentRead'))
    const messages = [user('tool-result', [{
      type: 'tool_result', tool_use_id: 'read-1', content: [],
    }])]

    const result = await buildCompactAttachmentContent(
      messages,
      [occurrence('tool-result', [0, 0], attachment)],
      f,
    )

    expect(result.content).toHaveLength(1)
    expect(JSON.stringify(result.content)).toContain('text returned by AttachmentRead')
    expect(messages).toEqual([user('tool-result', [{
      type: 'tool_result', tool_use_id: 'read-1', content: [],
    }])])
  })

  it('keeps a nested public file without an exact provider join unread', async () => {
    const f = await fixture()
    const attachment: NativeFileAttachment = {
      id: 'unmatched', name: 'unmatched.txt', size: 9, digest: 'a'.repeat(64),
      path: join(f.stateDir, 'must-not-read.txt'), modelForm: 'handle',
    }
    const result = await buildCompactAttachmentContent([
      user('nested-public', [{ type: 'tool_result', tool_use_id: 'read-1', content: [publicFile(attachment)] }]),
    ], [], f)

    expect(result.content).toHaveLength(1)
    expect(JSON.stringify(result.content[0])).toContain('no exact provider occurrence')
    expect(JSON.stringify(result.content[0])).not.toContain(attachment.path)
  })

  it('deduplicates and caps merged main/subagent PDFs without reading over-budget aliases or mutating history', async () => {
    const f = await fixture('compact-pdf-budget-')
    const bytesA = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(20 * 1024 * 1024 - 5, 'a')])
    const bytesB = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(20 * 1024 * 1024 - 5, 'b')])
    const a = await addUpload(f, 'main-pdf', bytesA, {
      name: 'main.pdf', modelForm: 'pdf-document', mediaType: 'application/pdf',
    })
    const b = await addUpload(f, 'subagent-pdf', bytesB, {
      name: 'subagent.pdf', modelForm: 'pdf-document', mediaType: 'application/pdf',
    })
    const messages = [
      user('main', [publicFile(a)]),
      user('subagent-duplicate', [publicFile(a)], 'agent-1'),
      user('subagent-over-budget', [publicFile(b)], 'agent-1'),
    ]
    const before = JSON.stringify(messages)
    const lookup = vi.spyOn(f.store, 'getById')

    const result = await buildCompactAttachmentContent(messages, [
      occurrence('main', [0], a),
      occurrence('subagent-duplicate', [0], a),
      occurrence('subagent-over-budget', [0], b),
    ], f)

    expect(result.hasNativeMedia).toBe(true)
    expect(result.content.map((block) => (block as { type: string }).type)).toEqual(['document', 'text', 'text'])
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith(a.id)
    expect(lookup).not.toHaveBeenCalledWith(b.id)
    expect(JSON.stringify(result.content.slice(1))).toContain('28,000,000')
    expect(JSON.stringify(result.content)).not.toContain(b.path)
    expect(JSON.stringify(messages)).toBe(before)
  }, 30_000)

  it('allows a later same-digest PDF occurrence when only the second message fits', async () => {
    const f = await fixture('compact-pdf-second-fit-')
    const attachment = await addUpload(f, 'shared-pdf', Buffer.from('%PDF-small'), {
      name: 'shared.pdf', modelForm: 'pdf-document', mediaType: 'application/pdf',
    })
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'i'.repeat(28_000_000) },
    }

    const result = await buildCompactAttachmentContent([
      user('image-heavy', [publicFile(attachment), image]),
      user('fits', [publicFile(attachment)]),
    ], [
      occurrence('image-heavy', [0], attachment),
      occurrence('fits', [0], attachment),
    ], f)

    expect(result.content.map((block) => (block as { type: string }).type)).toEqual([
      'text', 'image', 'document',
    ])
    expect((result.content[0] as { text: string }).text).toContain('28,000,000')
    expect((result.content[2] as { title?: string }).title).toBe('shared.pdf')
  }, 30_000)

  it('does not read a handle-form PDF or an unselected non-UTF-8 binary', async () => {
    const f = await fixture()
    const pdf = await addUpload(f, 'handle-pdf', Buffer.from('%PDF-not-read'), {
      name: 'handle.pdf', modelForm: 'handle', mediaType: 'application/pdf',
    })
    const binary = await addUpload(f, 'old-binary', Buffer.from([0xff, 0xfe, 0xfd]))
    const fillers = await Promise.all(['a', 'b', 'c', 'd'].map((id) =>
      addUpload(f, `fill-${id}`, Buffer.alloc(65_536, id)),
    ))
    const messages = [
      user('pdf', [publicFile(pdf)]),
      user('binary', [publicFile(binary)]),
      user('newest', fillers.map(publicFile)),
    ]
    const lookup = vi.spyOn(f.store, 'getById')

    const result = await buildCompactAttachmentContent(messages, [
      occurrence('pdf', [0], pdf),
      occurrence('binary', [0], binary),
      ...fillers.map((attachment, index) => occurrence('newest', [index], attachment)),
    ], f)

    expect(lookup).not.toHaveBeenCalledWith(pdf.id)
    expect(lookup).not.toHaveBeenCalledWith(binary.id)
    expect((result.content[1] as { text: string }).text).toContain('not hydrated')
  })

  it.each(['missing', 'digest', 'utf8'] as const)('fails a selected attachment with %s bytes', async (failure) => {
    const f = await fixture()
    const bytes = failure === 'utf8' ? Buffer.from([0xff, 0xfe]) : Buffer.from('selected')
    const attachment = await addUpload(f, `bad-${failure}`, bytes)
    if (failure === 'missing') await rm(attachment.path)
    if (failure === 'digest') await writeFile(attachment.path, 'tampered')

    await expect(buildCompactAttachmentContent(
      [user('bad', [publicFile(attachment)])],
      [occurrence('bad', [0], attachment)],
      f,
    )).rejects.toThrow()
  })

  it('resolves image refs to verified base64 source in the API image shape', async () => {
    const f = await fixture()
    const { bytes, meta } = inspectedPng()
    const ref = await addImage(f, bytes, meta)
    const legacy = { type: 'image', source: { type: 'base64', data: 'aGVsbG8=', media_type: 'image/png' } }
    const messages = [user('u1', [imageRefBlock(ref), legacy])]
    const before = JSON.stringify(messages)

    const result = await buildCompactAttachmentContent(messages, [], f)

    expect(result.hasAttachments).toBe(true)
    expect(result.hasNativeMedia).toBe(true)
    expect(result.content).toHaveLength(2)
    // Hydration rewrites only the projected clones, never the input history.
    expect(JSON.stringify(messages)).toBe(before)
    // The ref is hydrated to the clean API image shape: the verified base64 of
    // the stored bytes, with no server-only attachment/path fields (the
    // Messages API rejects those). toEqual pins the exact shape.
    expect(result.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', data: PNG_1X1, media_type: 'image/png' },
    })
    // The legacy base64 block rides alongside unchanged.
    expect(result.content[1]).toEqual(legacy)
  })

  it('passes legacy base64 image blocks through unchanged', async () => {
    const f = await fixture()
    const legacy = { type: 'image', source: { type: 'base64', data: 'aGVsbG8=', media_type: 'image/png' } }

    const result = await buildCompactAttachmentContent([user('u1', [legacy])], [], f)

    expect(result.hasNativeMedia).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual(legacy)
  })

  it.each(['missing', 'corrupt', 'mismatch'] as const)('fails closed on a %s image ref', async (failure) => {
    const f = await fixture()
    const { bytes, meta } = inspectedPng()
    let ref: ImageAttachmentRef
    if (failure === 'missing') {
      ref = { id: imageRefId('f'.repeat(64)), mediaType: 'image/png', bytes: 68, width: 1, height: 1 }
    } else {
      ref = await addImage(f, bytes, meta)
      if (failure === 'corrupt') {
        const objectPath = imageObjectPathOf(attachmentRoot(f.stateDir), ref.id.slice('sha256:'.length))
        await chmod(objectPath, 0o600)
        const tampered = Buffer.from(bytes)
        tampered[0] ^= 0xff
        await writeFile(objectPath, tampered)
      } else {
        ref = { ...ref, width: ref.width + 1 }
      }
    }

    await expect(buildCompactAttachmentContent([user('u1', [imageRefBlock(ref)])], [], f))
      .rejects.toMatchObject({ status: 400 })
  })

  it('counts resolved image base64 against the per-message PDF budget', async () => {
    const f = await fixture('compact-image-budget-')
    // 9.6 MB of opaque bytes -> 12.8M base64 chars; the 12 MB PDF adds 16M, so
    // the message exceeds the 28M merged budget only once the image is hydrated
    // (an unresolved ref contributes 0 and would wrongly let the PDF fit).
    const ref = await addImage(f, Buffer.alloc(9_600_000, 'x'), { mediaType: 'image/png', width: 1, height: 1 })
    const pdf = await addUpload(
      f,
      'budget-pdf',
      Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(12_000_000 - 5, 'p')]),
      { name: 'budget.pdf', modelForm: 'pdf-document', mediaType: 'application/pdf' },
    )

    const result = await buildCompactAttachmentContent(
      [user('budget', [imageRefBlock(ref), publicFile(pdf)])],
      [occurrence('budget', [1], pdf)],
      f,
    )

    expect(result.content.map((block) => (block as { type: string }).type)).toEqual(['image', 'text'])
    expect((result.content[0] as { source: { data: string } }).source.data).toHaveLength(12_800_000)
    expect((result.content[1] as { text: string }).text).toContain('28,000,000')
    expect((result.content[1] as { text: string }).text).toContain('omitted')
  }, 30_000)
})
