import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createAttachmentReadTool } from './attachment-read.js'
import { NativeAttachmentReferenceIndex } from '../../../attachment-reference-index.js'
import { aliasPathOf, attachmentRoot } from '../../../attachment-paths.js'
import { UploadStore } from '../../../upload-store.js'
import { readTool } from './read.js'
import type { NativeFileAttachment } from '../session-log/format.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

const dirs: string[] = []
afterEach(async () => {
  vi.mocked(createReadStream).mockRestore()
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

interface Fixture {
  stateDir: string
  cwd: string
  path: string
  store: UploadStore
  index: NativeAttachmentReferenceIndex
  occurrence: NativeFileAttachment
  tool: ReturnType<typeof createAttachmentReadTool>
}

async function fixture(options: {
  bytes?: Buffer
  name?: string
  mediaType?: string
  references?: boolean
} = {}): Promise<Fixture> {
  const stateDir = await mkdtemp(join(tmpdir(), 'attachment-read-state-'))
  const cwd = await mkdtemp(join(tmpdir(), 'attachment-read-cwd-'))
  dirs.push(stateDir, cwd)
  const bytes = options.bytes ?? Buffer.from('one\ntwo\nthree\nfour', 'utf8')
  const name = options.name ?? 'notes.txt'
  const digest = createHash('sha256').update(bytes).digest('hex')
  const path = aliasPathOf(attachmentRoot(stateDir), digest, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes)
  const store = new UploadStore({ stateDir })
  store.record([{
    id: 'upload-1', path, cwd, name, size: bytes.length, digest,
    uploadedAt: 1, sessionTitle: '', sessionId: 'session-1',
  }])
  const occurrence: NativeFileAttachment = {
    id: 'upload-1', name, size: bytes.length, digest, path,
    ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
    modelForm: 'handle',
  }
  const index = new NativeAttachmentReferenceIndex({ stateDir })
  if (options.references !== false) {
    index.replaceSession('session-1', [{
      seq: 0,
      type: 'user',
      uuid: 'user-1',
      session_id: 'session-1',
      parent_tool_use_id: null,
      timestamp: '2026-11-13T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'file', attachment: occurrence }] },
    }])
  }
  const tool = createAttachmentReadTool({
    uploadStore: store,
    stateDir,
    referenceIndex: index,
    sessionId: 'session-1',
  })
  return { stateDir, cwd, path, store, index, occurrence, tool }
}

function run(fx: Fixture, input: { id: string; offset?: number; limit?: number }) {
  return fx.tool.run(input, { cwd: fx.cwd, signal: new AbortController().signal })
}

describe('AttachmentRead', () => {
  it('is a read-only upload-id tool and does not widen ordinary Read cwd access', async () => {
    const fx = await fixture()
    expect(fx.tool.readOnlyHint).toBe(true)
    expect(fx.tool.schema).toMatchObject({ required: ['id'] })
    expect(fx.tool.schema).not.toHaveProperty('properties.file_path')
    await expect(readTool.run({ file_path: fx.path }, {
      cwd: fx.cwd, signal: new AbortController().signal,
    })).rejects.toThrow('path escapes the session working directory')
  })

  it('reads a registry upload outside cwd with 1-based line pagination', async () => {
    const fx = await fixture({ bytes: Buffer.from('one\ntwo\nthree', 'utf8') })
    const outcome = await run(fx, { id: 'upload-1', offset: 2, limit: 2 })
    expect(outcome.isError).not.toBe(true)
    expect(outcome.text).toContain('Attachment: notes.txt')
    expect(outcome.text).toContain('Lines: 2-3')
    expect(outcome.text).toContain('Truncated: no')
    expect(outcome.text).toContain('     2\ttwo')
    expect(outcome.text).toContain('     3\tthree')
    expect(outcome.text).not.toContain('     1\tone')
    expect(outcome.text).not.toContain(fx.path)
  })

  it('caps the requested window at 2000 lines and marks the omission', async () => {
    const bytes = Buffer.from(Array.from({ length: 2002 }, (_, i) => `line-${i + 1}`).join('\n'))
    const fx = await fixture({ bytes })
    const outcome = await run(fx, { id: 'upload-1', limit: 5000 })
    expect(outcome.text).toContain('Lines: 1-2000')
    expect(outcome.text).toContain('Truncated: yes')
    expect(outcome.text).toContain('  2000\tline-2000')
    expect(outcome.text).not.toContain('line-2001')
  })

  it('caps output at 64 KiB without splitting UTF-8 or hiding truncation', async () => {
    const fx = await fixture({ bytes: Buffer.from(`prefix-${'界'.repeat(30_000)}`) })
    const outcome = await run(fx, { id: 'upload-1' })
    expect(Buffer.byteLength(outcome.text, 'utf8')).toBeLessThanOrEqual(65_536)
    expect(outcome.text).toContain('Truncated: yes')
    expect(outcome.text).toContain('64 KiB')
    expect(outcome.text).not.toContain('�')
  })

  it('does not return any text before the stream reaches EOF and verifies the digest', async () => {
    const fx = await fixture({ bytes: Buffer.from('hello') })
    let notifyStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    vi.mocked(createReadStream).mockImplementationOnce(() => Readable.from((async function* () {
      yield Buffer.from('he')
      notifyStarted()
      await new Promise<void>((resolve) => { release = resolve })
      yield Buffer.from('XXX')
    })()) as ReturnType<typeof createReadStream>)

    let settled = false
    const pending = run(fx, { id: 'upload-1' }).then((outcome) => {
      settled = true
      return outcome
    })
    await started
    expect(settled).toBe(false)
    release()
    const outcome = await pending
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('integrity')
    expect(outcome.text).not.toContain('     1\the')
  })

  it('uses fatal UTF-8 decoding instead of returning replacement-character text', async () => {
    const fx = await fixture({ bytes: Buffer.from([0x66, 0xff, 0x65]) })
    const outcome = await run(fx, { id: 'upload-1' })
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('UTF-8')
    expect(outcome.text).not.toContain('�')
  })

  it('rejects foreign ids and registry entries with no current-log reference', async () => {
    const fx = await fixture()
    const foreign = await run(fx, { id: 'foreign' })
    expect(foreign.isError).toBe(true)
    expect(foreign.text).toContain('foreign')

    const unreferenced = await fixture({ references: false })
    const outcome = await run(unreferenced, { id: 'upload-1' })
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('not referenced')
    expect(outcome.text).not.toContain(unreferenced.path)
  })

  it('rejects registry/path mismatches and digest mismatches without a path fallback', async () => {
    const mismatched = await fixture()
    mismatched.store.record([{
      ...mismatched.store.getById('upload-1')!,
      path: join(mismatched.cwd, 'other.txt'),
    }])
    const mismatch = await run(mismatched, { id: 'upload-1' })
    expect(mismatch.isError).toBe(true)
    expect(mismatch.text).toContain('registry')
    expect(mismatch.text).not.toContain(mismatched.path)

    const tampered = await fixture({ bytes: Buffer.from('good') })
    await writeFile(tampered.path, 'evil')
    const corrupt = await run(tampered, { id: 'upload-1' })
    expect(corrupt.isError).toBe(true)
    expect(corrupt.text).toContain('integrity')
    expect(corrupt.text).not.toContain(tampered.path)
  })

  it.each(['missing', 'directory', 'read-error'] as const)(
    'sanitizes realpath/stat/read failures for %s targets',
    async (kind) => {
      const fx = await fixture()
      if (kind === 'missing') await rm(fx.path)
      if (kind === 'directory') {
        await rm(fx.path)
        await mkdir(fx.path)
      }
      if (kind === 'read-error') {
        vi.mocked(createReadStream).mockImplementationOnce(() => new Readable({
          read() {
            this.destroy(new Error(`EACCES: secret read failed for ${fx.path}`))
          },
        }) as ReturnType<typeof createReadStream>)
      }
      const outcome = await run(fx, { id: 'upload-1' })
      expect(outcome.isError).toBe(true)
      expect(outcome.text).toContain('upload-1')
      expect(outcome.text).toContain('notes.txt')
      expect(outcome.text).not.toContain(fx.path)
      expect(outcome.text).not.toContain(fx.stateDir)
      expect(JSON.stringify(outcome)).not.toContain(fx.path)
    },
  )

  it.each([{ offset: 2 }, { limit: 10 }])(
    'rejects PDF pagination before opening the file: %j',
    async (input) => {
      const fx = await fixture({
        bytes: Buffer.from('%PDF-1.4\nbody'),
        name: 'document.pdf',
        mediaType: 'application/pdf',
      })
      const calls = vi.mocked(createReadStream).mock.calls.length
      const outcome = await run(fx, { id: 'upload-1', ...input })
      expect(outcome.isError).toBe(true)
      expect(outcome.text).toMatch(/offset|limit|pagination/i)
      expect(vi.mocked(createReadStream).mock.calls.length).toBe(calls)
    },
  )
})
