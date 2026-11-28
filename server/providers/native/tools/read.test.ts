// server/providers/native/tools/read.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolInputError } from './types.js'
import { MODEL_READ_WINDOW_MAX_BYTES } from '../file-read.js'
import { createReadTool } from './read.js'
import { NativeReadState } from '../read-state.js'
import { PdfBudgetLedger, PreparedPdfStore } from '../pdf-documents.js'
import { IMAGE_MAX_BYTES } from '../image-documents.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })
let state: NativeReadState
let readTool: ReturnType<typeof createReadTool>
beforeEach(() => {
  state = new NativeReadState()
  readTool = createReadTool(state)
})

describe('readTool', () => {
  it('returns line-numbered content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\n')
    const res = await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    expect(res.text).toContain('     1\tone')
    expect(res.text).toContain('     2\ttwo')
    expect(res.isError).toBeFalsy()
  })

  it('honors offset and limit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'a.txt'), '1\n2\n3\n4\n')
    const res = await readTool.run({ file_path: 'a.txt', offset: 2, limit: 2 }, ctx(dir))
    expect(res.text).not.toContain('1\t')
    expect(res.text).toContain('     2\t2')
    expect(res.text).toContain('     3\t3')
    expect(res.text).not.toContain('     4\t4')
  })

  it('rejects paths escaping the cwd', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await expect(readTool.run({ file_path: '../outside.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
    await expect(readTool.run({ file_path: '/etc/hosts' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('throws ToolInputError for a missing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await expect(readTool.run({ file_path: 'nope.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('preserves trailing-newline and empty-file line numbering', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'trailing.txt'), 'one\ntwo\n')
    await writeFile(join(dir, 'empty.txt'), '')

    const trailing = await readTool.run({ file_path: 'trailing.txt' }, ctx(dir))
    const empty = await readTool.run({ file_path: 'empty.txt' }, ctx(dir))
    expect(trailing.text).toBe('     1\tone\n     2\ttwo\n     3\t')
    expect(empty.text).toBe('     1\t')
  })

  it('normalizes fractional offset and limit like the existing tool', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'a.txt'), '1\n2\n3\n4\n')
    const res = await readTool.run({ file_path: 'a.txt', offset: 2.9, limit: 2.9 }, ctx(dir))
    expect(res.text).toBe('     2\t2\n     3\t3')
  })

  it('rejects invalid UTF-8 and NUL without partial output', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'invalid.txt'), Buffer.from([0x61, 0xff, 0x62]))
    await writeFile(join(dir, 'nul.txt'), Buffer.from([0x61, 0, 0x62]))

    await expect(readTool.run({ file_path: 'invalid.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
    await expect(readTool.run({ file_path: 'nul.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('rejects a requested raw window over 1 MiB', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'large.txt'), Buffer.alloc(MODEL_READ_WINDOW_MAX_BYTES + 1, 0x61))
    await expect(readTool.run({ file_path: 'large.txt', limit: 1 }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('returns line 2001 with its original line number', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'a.txt'), Array.from({ length: 2001 }, (_, index) => String(index + 1)).join('\n'))
    const res = await readTool.run({ file_path: 'a.txt', offset: 2001 }, ctx(dir))
    expect(res.text).toBe('  2001\t2001')
  })

  it('resumes an exact continuation and seeds after the second complete window', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'a.txt'), Array.from({ length: 2001 }, (_, index) => String(index + 1)).join('\n'))

    await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    await expect(state.assertEditable(dir, 'a.txt')).rejects.toThrow(/read/i)
    const res = await readTool.run({ file_path: 'a.txt', offset: 2001 }, ctx(dir))

    expect(res.text).toBe('  2001\t2001')
    await expect(state.assertEditable(dir, 'a.txt')).resolves.toBeDefined()
  })
})

describe('readTool media files', () => {
  /** Header-only PNG with the given dimensions (the inspector never decodes). */
  function png(width: number, height: number): Buffer {
    const bytes = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
    bytes.writeUInt32BE(13, 8)
    bytes.write('IHDR', 12, 'latin1')
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(height, 20)
    return bytes
  }

  const digest = 'a'.repeat(64)

  function mediaTool() {
    const ledger = new PdfBudgetLedger()
    const preparedPdfs = new PreparedPdfStore(ledger)
    const published: Array<{ digest: string; objectPath: string; size: number }> = []
    const tool = createReadTool(new NativeReadState(), {
      imagePort: {
        publishImage: async (bytes) => ({ digest, bytes: bytes.byteLength }),
        readImage: async () => ({ mediaType: 'image/png', base64: 'AAAA' }),
      },
      attachmentPort: {
        readVerified: async function* () {},
        resolveAuthorized: async (occurrence) => occurrence,
        publish: async (input) => {
          const chunks: Uint8Array[] = []
          for await (const chunk of input.chunks) chunks.push(chunk)
          const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
          const entry = { digest: digest.slice(0, 63) + 'b', objectPath: '/store/objects/pdf', size }
          published.push(entry)
          return entry
        },
      },
      pdfBudgets: ledger,
      preparedPdfs,
    })
    return { tool, ledger, preparedPdfs, published }
  }

  it('returns an image as a store-backed ref occurrence instead of text', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-media-'))
    await writeFile(join(dir, 'shot.png'), png(640, 480))
    const { tool, ledger } = mediaTool()
    const res = await tool.run({ file_path: 'shot.png' }, ctx(dir))
    expect(res.text).toContain('Image: shot.png')
    expect(res.text).toContain('Dimensions: 640x480')
    expect(res.content?.some((block) => block.type === 'image')).toBe(true)
    const ref = res.content?.find((block) => block.type === 'image') as { attachment: { id: string; bytes: number; width: number } }
    expect(ref.attachment.id).toBe(`sha256:${digest}`)
    expect(ref.attachment.bytes).toBe(24)
    expect(ref.attachment.width).toBe(640)
    // The occurrence holds request-media room for this history.
    expect(ledger.reserveImageBudget('main', 1, 'other')).toMatchObject({ ok: true })
  })

  it('refuses over-cap images before reading their bytes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-media-'))
    await writeFile(join(dir, 'huge.png'), Buffer.concat([png(2, 2), Buffer.alloc(IMAGE_MAX_BYTES)]))
    const { tool } = mediaTool()
    await expect(tool.run({ file_path: 'huge.png' }, ctx(dir))).rejects.toThrow(/5 MiB per-image limit/)
  })

  it('refuses offset/limit on media reads', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-media-'))
    await writeFile(join(dir, 'shot.png'), png(4, 4))
    const { tool } = mediaTool()
    await expect(tool.run({ file_path: 'shot.png', offset: 2 }, ctx(dir))).rejects.toThrow(/offset or limit/)
  })

  it('publishes a working-directory PDF and returns its document occurrence', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-media-'))
    await writeFile(join(dir, 'doc.pdf'), Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'latin1'))
    const { tool, published } = mediaTool()
    const res = await tool.run({ file_path: 'doc.pdf' }, ctx(dir))
    expect(res.text).toBe('Read PDF doc.pdf')
    const file = res.content?.find((block) => block.type === 'file') as { attachment: { id: string; modelForm: string; path: string; mediaType: string } }
    expect(file.attachment.modelForm).toBe('pdf-document')
    expect(file.attachment.mediaType).toBe('application/pdf')
    expect(file.attachment.path).toBe('/store/objects/pdf')
    expect(file.attachment.id.startsWith('sha256:')).toBe(true)
    expect(published).toHaveLength(1)
  })

  it('rejects bytes that only look like a PDF by extension', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-media-'))
    await writeFile(join(dir, 'fake.pdf'), 'plain text, no magic')
    const { tool } = mediaTool()
    // Sniffing is content-first: this is text, so the text reader returns it.
    const res = await tool.run({ file_path: 'fake.pdf' }, ctx(dir))
    expect(res.text).toContain('plain text, no magic')
  })
})

describe('readTool unchanged files', () => {
  it('answers a repeated full read with a wasted-call note instead of the content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-dedupe-'))
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
    const first = await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    expect(first.text).toContain('     1\tone')
    const second = await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    expect(second.text).toContain('Wasted call')
    expect(second.text).toContain('a.txt')
    expect(second.text).not.toContain('     1\tone')
  })

  it('returns the content again once the file changed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-dedupe-'))
    await writeFile(join(dir, 'a.txt'), 'one\n')
    await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    await writeFile(join(dir, 'a.txt'), 'one changed\n')
    const res = await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    expect(res.text).toContain('one changed')
    expect(res.text).not.toContain('Wasted call')
  })

  it('never dedupes an explicit window request', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-dedupe-'))
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
    await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    const res = await readTool.run({ file_path: 'a.txt', limit: 1 }, ctx(dir))
    expect(res.text).toContain('     1\tone')
    expect(res.text).not.toContain('Wasted call')
  })
})

describe('readTool notebooks', () => {
  const notebook = JSON.stringify({
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'intro'] },
      { cell_type: 'code', source: 'print(1)', outputs: [{ output_type: 'stream', text: ['1\n'] }] },
      { cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=' } }] },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })

  it('renders cells and stream output instead of raw JSON', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-nb-'))
    await writeFile(join(dir, 'analysis.ipynb'), notebook)
    const res = await readTool.run({ file_path: 'analysis.ipynb' }, ctx(dir))
    expect(res.text).toContain('Cell 1 (markdown)')
    expect(res.text).toContain('# Title')
    expect(res.text).toContain('Cell 2 (code)')
    expect(res.text).toContain('print(1)')
    expect(res.text).toContain('Output:')
    expect(res.text).not.toContain('nbformat')
    expect(res.text).not.toContain('iVBORw0KGgo=')
  })

  it('paginates the rendered cells with offset/limit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-nb-'))
    await writeFile(join(dir, 'analysis.ipynb'), notebook)
    const res = await readTool.run({ file_path: 'analysis.ipynb', offset: 1, limit: 1 }, ctx(dir))
    expect(res.text).toBe('     1\tCell 1 (markdown)')
  })

  it('falls back to plain text for a .ipynb that is not a notebook', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-nb-'))
    await writeFile(join(dir, 'broken.ipynb'), 'not json at all')
    const res = await readTool.run({ file_path: 'broken.ipynb' }, ctx(dir))
    expect(res.text).toContain('not json at all')
  })
})
