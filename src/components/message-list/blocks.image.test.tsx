// Image-block rendering through BlockView: the durable ref shape resolves
// via the content route (useImageContent), the legacy base64 shape keeps its
// synchronous data-URL path. Both must render, and the resolved ref URL must
// reach the Lightbox through the normal MsgImage viewer wiring.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { BlockView } from './blocks'
import { ImageViewerProvider } from '../../hooks/useImageViewer'
import { _clearImageContentCacheForTests } from '../../hooks/useImageContent'
import type { Block } from '../../types'
import type { ImageAttachmentRef } from '../../../shared/image-attachment'

const REF: ImageAttachmentRef = {
  id: `sha256:${'ab'.repeat(32)}`,
  mediaType: 'image/webp',
  bytes: 4,
  width: 10,
  height: 20,
}
const DIGEST = REF.id.slice('sha256:'.length)

const REF_BLOCK = { type: 'image', attachment: REF } as unknown as Block
const LEGACY_BLOCK = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
} as unknown as Block

let urlCounter = 0
const createObjectURL = vi.fn(() => `blob:content-${++urlCounter}`)
const revokeObjectURL = vi.fn()

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.startsWith('/api/attachments/images/')) throw new Error(`unexpected fetch: ${url}`)
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { 'Content-Type': 'image/webp' },
    }) as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  urlCounter = 0
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectURL, configurable: true, writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeObjectURL, configurable: true, writable: true,
  })
  _clearImageContentCacheForTests()
  stubFetch()
})

afterEach(() => {
  _clearImageContentCacheForTests()
  vi.unstubAllGlobals()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (URL as any).createObjectURL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (URL as any).revokeObjectURL
})

describe('BlockView image blocks', () => {
  it('renders a legacy base64 block as a data URL without any fetch', () => {
    const fetchMock = stubFetch()
    const { container } = render(<BlockView block={LEGACY_BLOCK} />)
    const img = container.querySelector('img.msg-image') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders a ref block via the content route (placeholder, then blob URL)', async () => {
    let release!: (res: Response) => void
    const gate = new Promise<Response>((r) => { release = r })
    const fetchMock = vi.fn((_input: RequestInfo | URL) => gate)
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<BlockView block={REF_BLOCK} />)
    // While the content fetch is in flight the ref's recorded dimensions
    // hold the layout (no decode needed).
    const placeholder = container.querySelector('.msg-image-loading') as HTMLElement
    expect(placeholder).not.toBeNull()
    expect(placeholder.style.aspectRatio).toBe('10 / 20')
    expect(container.querySelector('img.msg-image')).toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/attachments/images/${DIGEST}`)
    release(new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'image/webp' } }) as Response)
    await waitFor(() => {
      const img = container.querySelector('img.msg-image') as HTMLImageElement
      expect(img).not.toBeNull()
      expect(img.getAttribute('src')).toBe('blob:content-1')
    })
    expect(container.querySelector('.msg-image-loading')).toBeNull()
  })

  it('shows an unavailable card when the content route refuses the ref', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 }) as Response))
    const { container } = render(<BlockView block={REF_BLOCK} />)
    await waitFor(() => {
      expect(container.textContent).toContain('[image: unavailable]')
    })
    expect(container.querySelector('img.msg-image')).toBeNull()
  })

  it('opens the Lightbox on the resolved ref URL', async () => {
    stubFetch()
    const { container } = render(
      <ImageViewerProvider>
        <BlockView block={REF_BLOCK} />
      </ImageViewerProvider>,
    )
    await waitFor(() => {
      expect(container.querySelector('img.msg-image')).not.toBeNull()
    })
    fireEvent.click(container.querySelector('img.msg-image') as HTMLImageElement)
    const viewerImg = document.body.querySelector('img.lightbox-img') as HTMLImageElement
    expect(viewerImg).not.toBeNull()
    expect(viewerImg.getAttribute('src')).toBe('blob:content-1')
  })

  it('keeps the invalid-block fallback for a malformed image block', () => {
    const { container } = render(<BlockView block={{ type: 'image' } as unknown as Block} />)
    expect(container.textContent).toContain('[image: invalid]')
  })
})
