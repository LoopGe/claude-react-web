// Ref-keyed uploaded-PDF preview: the byte source (fetch raw bytes by upload
// id from GET /uploads/:id/content — no live session) and the modal chrome.
// The PDF viewer internals (pdf.js, worker, zoom) are owned by PdfBody.test.tsx;
// here the lazy boundary is stubbed so the tests pin what the host hands it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UploadPdfModal, UploadPdfViewer } from './UploadPdfModal'

const pdfBody = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('./file-preview/LazyPdfBody', () => ({
  default: (props: unknown) => {
    pdfBody.render(props)
    return <div data-testid="pdf-body" />
  },
}))

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%%EOF')

/** fetch stub serving the given bytes through arrayBuffer(). */
function fetchBytes(bytes: Uint8Array = PDF_BYTES) {
  return vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => bytes.buffer,
  })
}

beforeEach(() => {
  pdfBody.render.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UploadPdfViewer (ref-keyed byte source)', () => {
  it('fetches raw bytes by upload id and hands them to the lazy viewer', async () => {
    const fetch = fetchBytes()
    vi.stubGlobal('fetch', fetch)
    render(<UploadPdfViewer id="u1" name="doc.pdf" />)
    await waitFor(() => expect(screen.getByTestId('pdf-body')).toBeTruthy())
    expect(fetch).toHaveBeenCalledWith(
      '/api/uploads/u1/content',
      expect.objectContaining({ signal: expect.anything() }),
    )
    const props = pdfBody.render.mock.calls.at(-1)?.[0] as {
      bytes: Uint8Array
      title: string
      viewStateKey: string
    }
    expect(Array.from(props.bytes)).toEqual(Array.from(PDF_BYTES))
    expect(props.title).toBe('doc.pdf')
    expect(props.viewStateKey).toBe('upload:u1')
  })

  it('shows a loading state while the bytes are in flight', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})))
    render(<UploadPdfViewer id="u1" name="doc.pdf" />)
    expect(screen.getByRole('status').textContent).toMatch(/loading/i)
    expect(screen.queryByTestId('pdf-body')).toBeNull()
  })

  it('surfaces a fetch failure instead of the viewer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    render(<UploadPdfViewer id="gone" name="gone.pdf" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/404/))
    expect(screen.queryByTestId('pdf-body')).toBeNull()
  })

  it('aborts the fetch on unmount', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        signal = init.signal
        return new Promise(() => {})
      }),
    )
    const { unmount } = render(<UploadPdfViewer id="u1" name="doc.pdf" />)
    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(false)
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})

describe('UploadPdfModal (chip-opened preview)', () => {
  it('renders the viewer for the chip ref inside a dialog with download + close', async () => {
    const fetch = fetchBytes()
    vi.stubGlobal('fetch', fetch)
    const onClose = vi.fn()
    render(<UploadPdfModal file={{ id: 'u1', name: 'doc.pdf', size: PDF_BYTES.length }} onClose={onClose} />)
    await waitFor(() => expect(screen.getByTestId('pdf-body')).toBeTruthy())
    expect(fetch).toHaveBeenCalledWith(
      '/api/uploads/u1/content',
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('doc.pdf')).toBeTruthy()
    const download = screen.getByRole('link', { name: /download file/i })
    expect(download.getAttribute('href')).toBe('/api/uploads/u1/content?download=1')
    fireEvent.click(screen.getByRole('button', { name: /close preview/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces a fetch failure inside the modal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    render(<UploadPdfModal file={{ id: 'u1', name: 'doc.pdf', size: 3 }} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/500/))
    expect(screen.queryByTestId('pdf-body')).toBeNull()
  })
})
