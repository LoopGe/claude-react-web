import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { UploadPreview, TEXT_PREVIEW_LIMIT } from './UploadPreview'
import { uploadPreviewKind, uploadMimeType } from '../../shared/uploads'

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
})
