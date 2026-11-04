// @vitest-environment happy-dom
// FilePreviewBody content tests: image files preview as <img> (wired into the
// app-wide Lightbox) instead of UTF-8 mojibake, markdown renders formatted with
// a source toggle, and the body's pending/error/unavailable states. This file
// owns the coverage that used to live in FileViewer.test.tsx — the resource
// pane and the (removed) modal shared this body.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { FilePreviewBody, type FilePreviewBodyProps } from './FilePreviewBody'
import { ImageViewerProvider } from '../../hooks/useImageViewer'
import type { FileReadResult } from '../../../shared/read-file'

// 1×1 PNG — happy-dom decodes data-URL PNGs, so the Lightbox loads cleanly.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})

function renderBody(
  path: string,
  title: string,
  data: FileReadResult | null,
  over: Partial<FilePreviewBodyProps> = {},
) {
  return render(
    <ImageViewerProvider>
      <FilePreviewBody path={path} title={title} data={data} error={null} loading={false} {...over} />
    </ImageViewerProvider>,
  )
}

describe('FilePreviewBody images', () => {
  it('renders a PNG as a clickable MsgImage, not as mojibake text', () => {
    renderBody('app-home.png', 'app-home.png', {
      available: true,
      contents: PNG_B64,
      encoding: 'base64',
    })
    const img = document.body.querySelector('img.msg-image') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG_B64}`)
    expect(document.body.querySelector('.file-viewer-code')).toBeNull()
  })

  it('opens the project Lightbox when the image is clicked', () => {
    renderBody('app-home.png', 'app-home.png', {
      available: true,
      contents: PNG_B64,
      encoding: 'base64',
    })
    fireEvent.click(document.body.querySelector('img.msg-image') as HTMLImageElement)
    expect(document.body.querySelector('img.lightbox-img')).not.toBeNull()
  })

  it('shows the size hint instead of a broken img when the image read was truncated', () => {
    renderBody('big.png', 'big.png', {
      available: true,
      contents: PNG_B64,
      encoding: 'base64',
      truncated: true,
    })
    expect(document.body.querySelector('img.msg-image')).toBeNull()
    expect(document.body.querySelector('.file-viewer-truncated')).not.toBeNull()
  })

  it('falls back to the code view when the read did not return base64', () => {
    // SDK contract: `encoding` is absent when an older CLI ignored the
    // request — contents is then utf-8 text and must not become a data URL.
    renderBody('app-home.png', 'app-home.png', {
      available: true,
      contents: 'not-an-image',
    })
    expect(document.body.querySelector('img.msg-image')).toBeNull()
    expect(document.body.querySelector('.file-viewer-code')).not.toBeNull()
  })

  it('renders no broken img when an image file is empty', () => {
    renderBody('empty.png', 'empty.png', { available: true, contents: '', encoding: 'base64' })
    expect(document.body.querySelector('img.msg-image')).toBeNull()
  })

  it('decides image-vs-code from the read path, not the display title', () => {
    // title is a label; the bytes come from path.
    renderBody('/repo/pic.png', 'Screenshot', {
      available: true,
      contents: PNG_B64,
      encoding: 'base64',
    })
    expect(document.body.querySelector('img.msg-image')).not.toBeNull()
  })
})

describe('FilePreviewBody markdown and text', () => {
  it('renders numbered lines and highlights the line target', () => {
    renderBody('/repo/a.ts', 'a.ts', { available: true, contents: 'one\ntwo\nthree' }, { line: 2 })
    const lines = [...document.body.querySelectorAll<HTMLElement>('[data-line]')]
    expect(lines).toHaveLength(3)
    expect(lines[1].className).toContain('code-line-target')
  })

  it('a line target on a markdown file opens the source view', () => {
    renderBody(
      '/repo/README.md',
      'README.md',
      { available: true, contents: '# Hi\n\ntext' },
      { line: 1 },
    )
    expect(document.body.querySelector('.numbered-code')).not.toBeNull()
    expect(document.body.querySelector('.file-viewer-md')).toBeNull()
  })

  it('falls back to plain text above the line cap', () => {
    const contents = Array.from({ length: 5001 }, (_, i) => `line ${i}`).join('\n')
    renderBody('/repo/huge.ts', 'huge.ts', { available: true, contents }, { line: 10 })
    expect(document.body.querySelectorAll('[data-line]')).toHaveLength(0)
    expect(document.body.textContent).toContain('Line navigation is unavailable')
  })

  it('keeps the code view for non-image files', () => {
    renderBody('Foo.tsx', 'Foo.tsx', { available: true, contents: 'export const x = 1' })
    expect(document.body.querySelector('.file-viewer-code')).not.toBeNull()
    expect(document.body.querySelector('img.msg-image')).toBeNull()
    expect(document.body.textContent).toContain('export const x = 1')
  })

  it('renders a markdown file as formatted markdown, not code', () => {
    const src = `# Hello

**bold** text`
    renderBody('README.md', 'README.md', { available: true, contents: src })
    const md = document.body.querySelector('.file-viewer-md')
    expect(md).not.toBeNull()
    // The transcript pipeline demotes heading levels; assert the heading
    // text lands in some heading, not a specific rank.
    expect(md?.querySelector('h1,h2,h3,h4,h5,h6')?.textContent).toBe('Hello')
    expect(md?.querySelector('strong')?.textContent).toBe('bold')
    expect(document.body.querySelector('.file-viewer-code')).toBeNull()
  })

  it('flips a markdown file to its raw source and back', () => {
    const src = `# Hello

plain`
    renderBody('README.md', 'README.md', { available: true, contents: src })
    expect(document.body.querySelector('.file-viewer-code')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /view source/i }))
    const code = document.body.querySelector('.file-viewer-code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toContain('# Hello')

    fireEvent.click(screen.getByRole('button', { name: /view preview/i }))
    expect(document.body.querySelector('.file-viewer-md')).not.toBeNull()
  })

  it('decides markdown-vs-code from the read path, not the display title', () => {
    renderBody('/repo/README.md', 'Notes', { available: true, contents: '# Hi' })
    expect(document.body.querySelector('.file-viewer-md')).not.toBeNull()
    expect(document.body.querySelector('.file-viewer-code')).toBeNull()
  })
})

describe('FilePreviewBody states', () => {
  it('shows Reading… while no response has landed', () => {
    renderBody('/repo/a.ts', 'a.ts', null, { loading: true })
    expect(screen.getByText('Reading…')).toBeTruthy()
  })

  it('shows the read error', () => {
    renderBody('/repo/a.ts', 'a.ts', null, { error: 'Session is not live' })
    expect(screen.getByText('Session is not live')).toBeTruthy()
  })

  it('shows the unavailable hint for a denied or missing read', () => {
    renderBody('/repo/a.ts', 'a.ts', { available: false })
    expect(screen.getByText('Needs read permission, or the file is missing.')).toBeTruthy()
  })

  it('keeps the retained last-good content beside a refetch error', () => {
    renderBody('/repo/a.ts', 'a.ts', { available: true, contents: 'hello world' }, {
      error: 'refetch failed',
    })
    expect(screen.getByText('refetch failed')).toBeTruthy()
    expect(screen.getByText(/hello world/)).toBeTruthy()
  })
})