import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UploadStore, UPLOAD_SUBDIR, type UploadEntry } from './upload-store.js'
import { resolveAttachmentContent } from './attachment-resolver.js'
import type { ProviderInputContentBlock, ResolvedFileBlock } from './agent-message.js'
import type { FileBlock } from '../shared/attachments.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('resolveAttachmentContent', () => {
  let stateDir: string
  let uploadDir: string
  let store: UploadStore

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'crw-attachment-resolver-'))
    uploadDir = join(stateDir, UPLOAD_SUBDIR)
    mkdirSync(uploadDir, { recursive: true })
    store = new UploadStore({ stateDir })
    vi.mocked(createReadStream).mockClear()
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  function record(name: string, bytes: Buffer | string, overrides: Partial<UploadEntry> = {}): UploadEntry {
    const path = join(uploadDir, name)
    writeFileSync(path, bytes)
    const entry: UploadEntry = {
      id: `id-${name}`,
      path,
      cwd: stateDir,
      name,
      size: Buffer.byteLength(bytes),
      uploadedAt: 1,
      sessionTitle: '',
      sessionId: 's1',
      digest: sha256(bytes),
      ...overrides,
    }
    store.record([entry])
    return entry
  }

  function file(entry: UploadEntry): FileBlock {
    return {
      type: 'file',
      attachment: { id: entry.id, name: entry.name, size: entry.size },
    }
  }

  function resolve(content: ProviderInputContentBlock[], signal = new AbortController().signal) {
    return resolveAttachmentContent(content, { sessionId: 's1', signal, uploadStore: store, stateDir })
  }

  it('reads a duplicate registry id once while preserving every occurrence position', async () => {
    const entry = record('notes.txt', 'hello')
    const resolved = await resolve([
      file(entry),
      { type: 'text', text: 'between' },
      file(entry),
    ])

    expect(vi.mocked(createReadStream)).toHaveBeenCalledTimes(1)
    expect(resolved.map((block) => block.type)).toEqual(['file', 'text', 'file'])
    expect(resolved[0]).toEqual({
      type: 'file',
      attachment: {
        id: entry.id,
        name: entry.name,
        size: 5,
        digest: sha256('hello'),
        path: entry.path,
      },
    })
    expect(resolved[2]).toEqual(resolved[0])
    expect(resolved[2]).not.toBe(resolved[0])
    const first = resolved[0] as ResolvedFileBlock
    const second = resolved[2] as ResolvedFileBlock
    expect(second.attachment).not.toBe(first.attachment)
  })

  it('backfills a missing legacy digest into the shared registry', async () => {
    const entry = record('legacy.txt', 'legacy', { digest: undefined })
    const resolved = await resolve([file(entry)]) as [ResolvedFileBlock]

    expect(resolved[0].attachment.digest).toBe(sha256('legacy'))
    expect(store.getById(entry.id)?.digest).toBe(sha256('legacy'))
  })

  it.each([
    ['short', 'abc'],
    ['uppercase', 'A'.repeat(64)],
    ['mismatched', '0'.repeat(64)],
  ])('rejects a %s registry digest before dispatch', async (_label, digest) => {
    const entry = record('bad-digest.txt', 'hello', { digest })
    await expect(resolve([file(entry)])).rejects.toMatchObject({ status: 400 })
  })

  it('rejects a registry size that does not match the streamed bytes', async () => {
    const entry = record('bad-size.txt', 'hello', { size: 4 })
    await expect(resolve([file(entry)])).rejects.toMatchObject({ status: 400 })
  })

  it('rejects a symlink whose realpath escapes the approved upload root', async () => {
    const outside = join(stateDir, 'outside.txt')
    writeFileSync(outside, 'secret')
    const link = join(uploadDir, 'escape.txt')
    symlinkSync(outside, link, 'file')
    const entry: UploadEntry = {
      id: 'escape', path: link, cwd: stateDir, name: 'escape.txt', size: 6,
      uploadedAt: 1, sessionTitle: '', sessionId: 's1', digest: sha256('secret'),
    }
    store.record([entry])

    await expect(resolve([file(entry)])).rejects.toThrow(/path|allowed|contained/i)
    expect(vi.mocked(createReadStream)).not.toHaveBeenCalled()
  })

  it('uses PDF magic rather than the filename extension', async () => {
    const fake = record('fake.pdf', 'not a pdf')
    const real = record('real.bin', '%PDF-1.7\nbody')
    const resolved = await resolve([file(fake), file(real)]) as ResolvedFileBlock[]

    expect(resolved[0].attachment.mediaType).toBeUndefined()
    expect(resolved[1].attachment.mediaType).toBe('application/pdf')
  })

  it('rejects foreign and non-regular registry entries', async () => {
    const foreign = record('foreign.txt', 'hello', { sessionId: 'other' })
    await expect(resolve([file(foreign)])).rejects.toMatchObject({ status: 400 })

    const directory = join(uploadDir, 'directory')
    mkdirSync(directory)
    const entry: UploadEntry = {
      id: 'directory', path: directory, cwd: stateDir, name: 'directory', size: 0,
      uploadedAt: 1, sessionTitle: '', sessionId: 's1', digest: sha256(''),
    }
    store.record([entry])
    await expect(resolve([file(entry)])).rejects.toMatchObject({ status: 400 })
  })
})
