import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createAttachmentReadTool } from './attachment-read.js'
import { projectNativeMessages } from '../attachment-projection.js'
import { PDF_MAX_BYTES, PdfBudgetLedger, PreparedPdfStore } from '../pdf-documents.js'
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
  pdfBudgets: PdfBudgetLedger
  preparedPdfs: PreparedPdfStore
}

async function fixture(options: {
  id?: string
  bytes?: Buffer
  name?: string
  mediaType?: string
  references?: boolean
  reportedSize?: number
  pdfDocumentsEnabled?: boolean
  shared?: { pdfBudgets: PdfBudgetLedger; preparedPdfs: PreparedPdfStore }
} = {}): Promise<Fixture> {
  const stateDir = await mkdtemp(join(tmpdir(), 'attachment-read-state-'))
  const cwd = await mkdtemp(join(tmpdir(), 'attachment-read-cwd-'))
  dirs.push(stateDir, cwd)
  const bytes = options.bytes ?? Buffer.from('one\ntwo\nthree\nfour', 'utf8')
  const name = options.name ?? 'notes.txt'
  const id = options.id ?? 'upload-1'
  const digest = createHash('sha256').update(bytes).digest('hex')
  const size = options.reportedSize ?? bytes.length
  const path = aliasPathOf(attachmentRoot(stateDir), digest, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes)
  const store = new UploadStore({ stateDir })
  store.record([{
    id, path, cwd, name, size, digest,
    uploadedAt: 1, sessionTitle: '', sessionId: 'session-1',
  }])
  const occurrence: NativeFileAttachment = {
    id, name, size, digest, path,
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
  const pdfBudgets = options.shared?.pdfBudgets ?? new PdfBudgetLedger()
  const preparedPdfs = options.shared?.preparedPdfs ?? new PreparedPdfStore(pdfBudgets)
  const tool = createAttachmentReadTool({
    uploadStore: store,
    stateDir,
    referenceIndex: index,
    sessionId: 'session-1',
    pdfBudgets,
    preparedPdfs,
    pdfDocumentsEnabled: () => options.pdfDocumentsEnabled !== false,
  })
  return { stateDir, cwd, path, store, index, occurrence, tool, pdfBudgets, preparedPdfs }
}

function run(
  fx: Fixture,
  input: { id: string; offset?: number; limit?: number },
  context: { toolUseId?: string; historyKey?: string } = {},
) {
  return fx.tool.run(input, {
    cwd: fx.cwd,
    signal: new AbortController().signal,
    toolUseId: context.toolUseId ?? 'tool-1',
    historyKey: context.historyKey ?? 'main',
  })
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

  it('authorizes a PDF before pagination rejection', async () => {
    const fx = await fixture({
      bytes: Buffer.from('%PDF-1.4\nbody'),
      name: 'document.pdf',
      mediaType: 'application/pdf',
    })
    fx.store.record([{ ...fx.store.getById('upload-1')!, path: join(fx.cwd, 'other.pdf') }])
    const outcome = await run(fx, { id: 'upload-1', offset: 2 })
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('registry')
    expect(outcome.text).not.toMatch(/pagination/i)
    expect(vi.mocked(createReadStream)).not.toHaveBeenCalled()
  })

  it('returns structured PDF content and consumes PreparedPdf without a double read', async () => {
    const bytes = Buffer.from('%PDF-1.4\nprepared body')
    const fx = await fixture({ bytes, name: 'document.pdf', mediaType: 'application/pdf' })
    const outcome = await run(fx, { id: 'upload-1' })
    expect(outcome.isError).not.toBe(true)
    expect(outcome.text).toBe('Read PDF document.pdf')
    expect(outcome.content).toHaveLength(2)
    expect(outcome.content?.[0]).toEqual({ type: 'text', text: 'Read PDF document.pdf' })
    expect(outcome.content?.[1]).toMatchObject({
      type: 'file',
      attachment: { id: 'upload-1', modelForm: 'pdf-document' },
    })
    expect(JSON.stringify(outcome)).not.toContain(bytes.toString('base64'))
    expect(vi.mocked(createReadStream).mock.calls).toHaveLength(1)

    fx.preparedPdfs.confirmPersisted('tool-1')
    const history = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: outcome.content }] }]
    const projected = await projectNativeMessages(history, {
      stateDir: fx.stateDir,
      uploadStore: fx.store,
      preparedPdfs: fx.preparedPdfs,
    }, new AbortController().signal) as Array<{ content: Array<{ content: Array<{ type: string; source?: { data: string } }> }> }>
    expect(projected[0].content[0].content[1]).toMatchObject({
      type: 'document',
      source: { data: bytes.toString('base64') },
    })
    expect(vi.mocked(createReadStream).mock.calls).toHaveLength(1)

    await projectNativeMessages(history, {
      stateDir: fx.stateDir,
      uploadStore: fx.store,
      preparedPdfs: fx.preparedPdfs,
    }, new AbortController().signal)
    expect(vi.mocked(createReadStream).mock.calls).toHaveLength(2)

    await writeFile(fx.path, '%PDF-1.4\ntampered body')
    const failure = await projectNativeMessages(history, {
      stateDir: fx.stateDir,
      uploadStore: fx.store,
      preparedPdfs: fx.preparedPdfs,
    }, new AbortController().signal).catch((err: unknown) => err)
    expect((failure as Error).message).toMatch(/integrity/i)
    expect((failure as Error).message).not.toContain(fx.path)
  })

  it('allows the same digest in main and agent partitions but returns a handle for a same-partition duplicate', async () => {
    const fx = await fixture({
      bytes: Buffer.from('%PDF-1.4\nshared'),
      name: 'document.pdf',
      mediaType: 'application/pdf',
    })
    const main = await run(fx, { id: 'upload-1' }, { toolUseId: 'main-read', historyKey: 'main' })
    const agent = await run(fx, { id: 'upload-1' }, { toolUseId: 'agent-read', historyKey: 'agent-1' })
    expect(main.isError).not.toBe(true)
    expect(agent.isError).not.toBe(true)
    const duplicate = await run(fx, { id: 'upload-1' }, { toolUseId: 'duplicate-read', historyKey: 'main' })
    expect(duplicate.isError).not.toBe(true)
    expect(duplicate.text).toBe('Read PDF document.pdf')
    expect(duplicate.content).toEqual([
      { type: 'text', text: 'Read PDF document.pdf' },
      { type: 'file', attachment: { ...fx.occurrence, modelForm: 'handle' } },
    ])
    expect(vi.mocked(createReadStream).mock.calls).toHaveLength(2)
  })

  it('rejects disabled, oversized, and non-magic PDFs without returning document content', async () => {
    const disabled = await fixture({
      bytes: Buffer.from('%PDF-1.4\nbody'), name: 'document.pdf', mediaType: 'application/pdf', pdfDocumentsEnabled: false,
    })
    const disabledOutcome = await run(disabled, { id: 'upload-1' })
    expect(disabledOutcome.isError).toBe(true)
    expect(disabledOutcome.text).toMatch(/disabled/i)
    expect(vi.mocked(createReadStream)).not.toHaveBeenCalled()

    const oversized = await fixture({
      bytes: Buffer.from('%PDF-1.4\nbody'), name: 'document.pdf', mediaType: 'application/pdf', reportedSize: PDF_MAX_BYTES + 1,
    })
    const oversizedOutcome = await run(oversized, { id: 'upload-1' })
    expect(oversizedOutcome.isError).toBe(true)
    expect(oversizedOutcome.text).toMatch(/20 MiB/i)
    expect(vi.mocked(createReadStream).mock.calls).toHaveLength(0)

    const nonMagic = await fixture({ bytes: Buffer.from('plain text'), name: 'document.pdf', mediaType: 'application/pdf' })
    const nonMagicOutcome = await run(nonMagic, { id: 'upload-1' })
    expect(nonMagicOutcome.isError).toBe(true)
    expect(nonMagicOutcome.text).toMatch(/magic|PDF/i)
    expect(nonMagicOutcome.content).toBeUndefined()
  })

  it('reserves a second concurrent maximum-size PDF before opening its bytes', async () => {
    const firstBytes = Buffer.alloc(PDF_MAX_BYTES)
    firstBytes.write('%PDF-')
    const secondBytes = Buffer.alloc(PDF_MAX_BYTES)
    secondBytes.write('%PDF-')
    secondBytes[secondBytes.length - 1] = 1
    const pdfBudgets = new PdfBudgetLedger()
    const shared = { pdfBudgets, preparedPdfs: new PreparedPdfStore(pdfBudgets) }
    const first = await fixture({ id: 'first', bytes: firstBytes, name: 'first.pdf', mediaType: 'application/pdf', shared })
    const second = await fixture({ id: 'second', bytes: secondBytes, name: 'second.pdf', mediaType: 'application/pdf', shared })

    let notifyStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    vi.mocked(createReadStream).mockImplementationOnce(() => Readable.from((async function* () {
      yield firstBytes
      notifyStarted()
      await new Promise<void>((resolve) => { release = resolve })
    })()) as ReturnType<typeof createReadStream>)
    const pending = run(first, { id: 'first' }, { toolUseId: 'first-read' })
    let completed: Awaited<typeof pending>
    try {
      await started
      const calls = vi.mocked(createReadStream).mock.calls.length
      const rejected = await run(second, { id: 'second' }, { toolUseId: 'second-read' })
      expect(rejected.isError).toBe(true)
      expect(rejected.text).toMatch(/budget|20 MiB|28,000,000/i)
      expect(vi.mocked(createReadStream).mock.calls.length).toBe(calls)
    } finally {
      release()
      completed = await pending
    }
    expect(completed.isError).not.toBe(true)
  })
})
