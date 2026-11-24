import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { UploadPreview, TEXT_PREVIEW_LIMIT } from './UploadPreview'
import { uploadPreviewKind, uploadMimeType } from '../../shared/uploads'
import { PDF_PREVIEW_MAX_BYTES } from '../../shared/read-file'

// The PDF viewer internals are owned by PdfBody.test.tsx and the byte-source
// host by UploadPdfModal.test.tsx; stub the lazy boundary so the PDF-branch
// tests pin that the manager preview feeds bytes-by-id to the viewer.
const pdfBody = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('./file-preview/LazyPdfBody', () => ({
  default: (props: unknown) => {
    pdfBody.render(props)
    return <div data-testid="pdf-body" />
  },
}))

const TARGET = {
  id: 'x1',
  path: '/p/claude-web-uploads/1-shot.png',
  cwd: '/p',
  name: 'shot.png',
  size: 3,
  uploadedAt: Date.now(),
  sessionTitle: '',
  exists: true,
}

/** Response-like whose body reader yields the given chunks then done. */
function fetchWith(chunks: string[]) {
  const encoder = new TextEncoder()
  return vi.fn().mockResolvedValue({
    ok: true,
    body: {
      getReader: () => {
        const queue = chunks.map((c) => encoder.encode(c))
        return {
          read: () =>
            queue.length
              ? Promise.resolve({ done: false, value: queue.shift() })
              : Promise.resolve({ done: true, value: undefined }),
          cancel: vi.fn(),
        }
      },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})
// afterEach(cleanup) is registered globally by src/test-setup.ts; only the
// fetch stub needs explicit teardown here.
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UploadPreview', () => {
  it('image kind renders an <img> pointed at the content route', () => {
    render(<UploadPreview target={{ ...TARGET, name: 'shot.png' }} onClose={() => {}} />)
    const img = screen.getByRole('img')
    expect(img.getAttribute('src')).toBe('/api/uploads/x1/content')
  })

  it('text kind streams the content into a code block', async () => {
    vi.stubGlobal('fetch', fetchWith(['hello ']))
    render(<UploadPreview target={{ ...TARGET, name: 'notes.txt' }} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/hello/)).toBeTruthy())
  })

  it('text kind marks truncated when the stream passes the cap', async () => {
    const bigChunk = 'a'.repeat(TEXT_PREVIEW_LIMIT + 10)
    const fetch = fetchWith([bigChunk])
    vi.stubGlobal('fetch', fetch)
    render(<UploadPreview target={{ ...TARGET, name: 'big.log' }} onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText(/preview limited to the first/i)).toBeTruthy(),
    )
    // The body is exactly the cap, with no NUL padding from the oversized
    // final allocation.
    const pre = document.querySelector('pre.uploads-preview-text')
    expect(pre?.textContent?.length).toBe(TEXT_PREVIEW_LIMIT)
    expect(pre?.textContent).not.toContain('\0')
  })

  it('a stream ending exactly at the cap is complete — no truncation banner', async () => {
    vi.stubGlobal('fetch', fetchWith(['a'.repeat(TEXT_PREVIEW_LIMIT)]))
    render(<UploadPreview target={{ ...TARGET, name: 'exact.log' }} onClose={() => {}} />)
    await waitFor(() => {
      const pre = document.querySelector('pre.uploads-preview-text')
      expect(pre?.textContent?.length).toBe(TEXT_PREVIEW_LIMIT)
    })
    expect(screen.queryByText(/preview limited/i)).toBeNull()
  })

  it('text kind surfaces a fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    render(<UploadPreview target={{ ...TARGET, name: 'gone.txt' }} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeTruthy())
  })

  it('other kinds show the unsupported notice', () => {
    render(<UploadPreview target={{ ...TARGET, name: 'app.exe' }} onClose={() => {}} />)
    expect(screen.getByText(/no preview available/i)).toBeTruthy()
  })

  it('PDF kind fetches bytes by id and renders the viewer, not the unsupported notice', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n%%EOF')
    const fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer })
    vi.stubGlobal('fetch', fetch)
    render(<UploadPreview target={{ ...TARGET, name: 'doc.pdf' }} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('pdf-body')).toBeTruthy())
    expect(fetch).toHaveBeenCalledWith(
      '/api/uploads/x1/content',
      expect.objectContaining({ signal: expect.anything() }),
    )
    const props = pdfBody.render.mock.calls.at(-1)?.[0] as { bytes: Uint8Array; title: string }
    expect(Array.from(props.bytes)).toEqual(Array.from(bytes))
    expect(props.title).toBe('doc.pdf')
    expect(screen.queryByText(/no preview available/i)).toBeNull()
  })

  it('PDF kind surfaces a fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    render(<UploadPreview target={{ ...TARGET, name: 'gone.pdf' }} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeTruthy())
    expect(screen.queryByTestId('pdf-body')).toBeNull()
  })

  it('PDF kind keeps the download button', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})))
    render(<UploadPreview target={{ ...TARGET, name: 'doc.pdf' }} onClose={() => {}} />)
    const download = screen.getByRole('link', { name: /download file/i })
    expect(download.getAttribute('href')).toBe('/api/uploads/x1/content?download=1')
  })

  it('PDF kind refuses an over-cap size before fetching, keeping the download button', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(
      <UploadPreview
        target={{ ...TARGET, name: 'big.pdf', size: PDF_PREVIEW_MAX_BYTES + 1 }}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/too large to preview/i).textContent).toMatch(/20/)
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByTestId('pdf-body')).toBeNull()
    expect(screen.getByRole('link', { name: /download file/i }).getAttribute('href')).toBe(
      '/api/uploads/x1/content?download=1',
    )
  })

  it('Close button invokes onClose', () => {
    const onClose = vi.fn()
    render(<UploadPreview target={TARGET} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close preview/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('uploadPreviewKind / uploadMimeType', () => {
  it('classifies images, text, and other', () => {
    expect(uploadPreviewKind('a.png')).toBe('image')
    expect(uploadPreviewKind('b.JPG')).toBe('image')
    expect(uploadPreviewKind('c.tsx')).toBe('text')
    expect(uploadPreviewKind('d.md')).toBe('text')
    expect(uploadPreviewKind('Dockerfile')).toBe('text')
    expect(uploadPreviewKind('e.svg')).toBe('other')
    expect(uploadPreviewKind('f.bin')).toBe('other')
  })

  it('maps mimes; unknown binaries are octet-stream', () => {
    expect(uploadMimeType('a.png')).toBe('image/png')
    expect(uploadMimeType('b.jpeg')).toBe('image/jpeg')
    expect(uploadMimeType('c.json')).toBe('text/plain; charset=utf-8')
    expect(uploadMimeType('d.zzz')).toBe('application/octet-stream')
  })

  it('classifies pdf as its own client preview kind — never image', () => {
    expect(uploadPreviewKind('doc.pdf')).toBe('pdf')
    expect(uploadPreviewKind('DOC.PDF')).toBe('pdf')
    expect(uploadPreviewKind('dir\\report.pdf')).toBe('pdf')
    // The image table is untouched: pdf is not an IMAGE_MIMES entry.
    expect(uploadPreviewKind('a.png')).toBe('image')
    expect(uploadPreviewKind('e.svg')).toBe('other')
  })

  it('pdf keeps the octet-stream served type (nosniff posture unchanged)', () => {
    expect(uploadMimeType('doc.pdf')).toBe('application/octet-stream')
    expect(uploadMimeType('DOC.PDF')).toBe('application/octet-stream')
  })
})
