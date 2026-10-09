// Tests for the composer's pasted-image thumbnail strip: clicking (or
// keyboard-activating) a thumb opens the app-wide Lightbox with ALL attached
// images as the navigable group, positioned at the clicked thumb — while the
// ✕ button keeps removing without touching the viewer.

import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ComposerImagePreviews } from './ComposerImagePreviews'
import { ImageViewerProvider } from '../hooks/useImageViewer'
import type { PastedImage } from '../types'

function pasted(id: string, previewUrl: string): PastedImage {
  return {
    id,
    data: 'AAAA',
    mediaType: 'image/png',
    width: 10,
    height: 10,
    size: 4,
    previewUrl,
  }
}

const IMAGES = [pasted('p1', 'blob:mock-1'), pasted('p2', 'blob:mock-2'), pasted('p3', 'blob:mock-3')]

function setup(images = IMAGES) {
  const onRemove = vi.fn()
  const { container } = render(
    <ImageViewerProvider>
      <ComposerImagePreviews images={images} onRemove={onRemove} />
    </ImageViewerProvider>,
  )
  return { container, onRemove }
}

describe('ComposerImagePreviews', () => {
  it('renders one thumbnail card per attached image', () => {
    const { container } = setup()
    const cards = container.querySelectorAll('.image-preview-card')
    expect(cards).toHaveLength(3)
    expect(cards[1]?.querySelector('img')?.getAttribute('src')).toBe('blob:mock-2')
  })

  it('opens the viewer on the clicked thumb, grouped over all attached images', () => {
    const { container } = setup()
    const thumbs = container.querySelectorAll('.image-preview-card img')
    fireEvent.click(thumbs[1])
    const viewerImg = document.body.querySelector('img.lightbox-img') as HTMLImageElement
    expect(viewerImg.getAttribute('src')).toBe('blob:mock-2')
    // Group navigation: next reaches the third attached image.
    fireEvent.click(document.body.querySelector('.lightbox-nav-next') as HTMLButtonElement)
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe('blob:mock-3')
  })

  it('opens the viewer with Enter/Space (keyboard parity with MsgImage)', () => {
    const { container } = setup()
    const thumb = container.querySelectorAll('.image-preview-card img')[2] as HTMLImageElement
    expect(thumb.getAttribute('role')).toBe('button')
    expect(thumb.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(thumb, { key: 'Enter' })
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe('blob:mock-3')
  })

  it('remove button still removes and does not open the viewer', () => {
    const { container, onRemove } = setup()
    const card = container.querySelectorAll('.image-preview-card')[0] as HTMLElement
    fireEvent.click(card.querySelector('.image-preview-remove') as HTMLButtonElement)
    expect(onRemove).toHaveBeenCalledWith('p1')
    expect(document.body.querySelector('img.lightbox-img')).toBeNull()
  })

  it('click does nothing (and does not throw) outside a provider', () => {
    const onRemove = vi.fn()
    const { container } = render(<ComposerImagePreviews images={IMAGES} onRemove={onRemove} />)
    expect(() => fireEvent.click(container.querySelector('.image-preview-card img') as HTMLImageElement)).not.toThrow()
    expect(document.body.querySelector('img.lightbox-img')).toBeNull()
  })
})
