// @vitest-environment happy-dom
// FileViewer content-body tests: binary image files must preview as <img>
// (wired into the app-wide Lightbox via MsgImage) instead of UTF-8 mojibake,
// while text files keep the CodeBlock path. Also covers the truncated-image
// edge — a truncated base64 payload is an undecodable image, so the viewer
// shows the size hint rather than a broken <img>.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { FileViewer } from './FileViewer'
import { ImageViewerProvider } from '../hooks/useImageViewer'
import { useReadFile } from '../hooks/useReadFile'

vi.mock('../hooks/useReadFile', () => ({ useReadFile: vi.fn() }))
const mockRead = useReadFile as unknown as ReturnType<typeof vi.fn>

// 1×1 PNG — happy-dom decodes data-URL PNGs, so the Lightbox loads cleanly.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const baseResult = {
  data: null as Record<string, unknown> | null,
  contents: undefined as string | undefined,
  available: true,
  truncated: undefined as boolean | undefined,
  error: null as string | null,
  loading: false,
  refetch: () => {},
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  mockRead.mockReturnValue({ ...baseResult })
})

function renderViewer(name: string, path: string, over: Partial<typeof baseResult> = {}) {
  mockRead.mockReturnValue({ ...baseResult, ...over })
  return render(
    <ImageViewerProvider>
      <FileViewer open sessionId="s1" path={path} name={name} onClose={() => {}} />
    </ImageViewerProvider>,
  )
}

describe('FileViewer image preview', () => {
  it('renders a PNG as a clickable MsgImage, not as mojibake text', () => {
    renderViewer('app-home.png', '/repo/app-home.png', {
      data: { available: true, contents: PNG_B64, encoding: 'base64' },
      contents: PNG_B64,
    })
    const img = document.body.querySelector('img.msg-image') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG_B64}`)
    expect(document.body.querySelector('.file-viewer-code')).toBeNull()
  })

  it('opens the project Lightbox when the image is clicked', () => {
    renderViewer('app-home.png', '/repo/app-home.png', {
      data: { available: true, contents: PNG_B64, encoding: 'base64' },
      contents: PNG_B64,
    })
    fireEvent.click(document.body.querySelector('img.msg-image') as HTMLImageElement)
    expect(document.body.querySelector('img.lightbox-img')).not.toBeNull()
  })

  it('keeps the code view for non-image files', () => {
    renderViewer('Foo.tsx', '/repo/Foo.tsx', {
      data: { available: true, contents: 'export const x = 1' },
      contents: 'export const x = 1',
    })
    expect(document.body.querySelector('.file-viewer-code')).not.toBeNull()
    expect(document.body.querySelector('img.msg-image')).toBeNull()
    expect(document.body.textContent).toContain('export const x = 1')
  })

  it('shows the size hint instead of a broken img when the image read was truncated', () => {
    renderViewer('big.png', '/repo/big.png', {
      data: { available: true, contents: PNG_B64, encoding: 'base64', truncated: true },
      contents: PNG_B64,
      truncated: true,
    })
    expect(document.body.querySelector('img.msg-image')).toBeNull()
    expect(document.body.querySelector('.file-viewer-truncated')).not.toBeNull()
  })

  it('requests base64 for image paths and plain text otherwise', () => {
    mockRead.mockReturnValue({ ...baseResult })
    const { unmount } = renderViewer('app-home.png', '/repo/app-home.png')
    expect(mockRead).toHaveBeenLastCalledWith(
      's1',
      '/repo/app-home.png',
      expect.objectContaining({ encoding: 'base64' }),
    )
    unmount()

    renderViewer('Foo.tsx', '/repo/Foo.tsx')
    expect(mockRead).toHaveBeenLastCalledWith('s1', '/repo/Foo.tsx', undefined)
  })

  it('falls back to the code view when the read did not return base64', () => {
    // SDK contract: `encoding` is absent when an older CLI ignored the
    // request — contents is then utf-8 text and must not become a data URL.
    renderViewer('app-home.png', '/repo/app-home.png', {
      data: { available: true, contents: 'not-an-image' },
      contents: 'not-an-image',
    })
    expect(document.body.querySelector('img.msg-image')).toBeNull()
    expect(document.body.querySelector('.file-viewer-code')).not.toBeNull()
  })

  it('renders no broken img when an image file is empty', () => {
    renderViewer('empty.png', '/repo/empty.png', {
      data: { available: true, contents: '', encoding: 'base64' },
      contents: '',
    })
    expect(document.body.querySelector('img.msg-image')).toBeNull()
  })

  it('decides image-vs-code from the read path, not the display name', () => {
    // name is a label; the bytes come from path.
    renderViewer('Screenshot', '/repo/pic.png', {
      data: { available: true, contents: PNG_B64, encoding: 'base64' },
      contents: PNG_B64,
    })
    expect(document.body.querySelector('img.msg-image')).not.toBeNull()
  })
})
