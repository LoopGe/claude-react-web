// Tests for the shared <MsgImage> render-site wrapper: it keeps the
// msg-image contract (class, no stray props on the DOM) and wires the click
// through ImageViewerApiContext — opening the viewer on the given group at
// the given index, and doing nothing (without throwing) outside a provider.

import { describe, it, expect } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { MsgImage } from './MsgImage'
import { ImageViewerProvider } from '../hooks/useImageViewer'

// happy-dom decodes data-URL PNGs; fixtures must be real decodable images.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const srcA = `${PNG_1PX}#a`
const srcB = `${PNG_1PX}#b`
const srcC = `${PNG_1PX}#c`
describe('MsgImage', () => {
  it('renders img.msg-image with src/alt and opens the viewer on click', () => {
    const { container } = render(
      <ImageViewerProvider>
        <MsgImage src={srcA} alt="shot" />
      </ImageViewerProvider>,
    )
    const img = container.querySelector('img.msg-image') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe(srcA)
    expect(img.getAttribute('alt')).toBe('shot')

    fireEvent.click(img)
    const viewerImg = document.body.querySelector('img.lightbox-img')
    expect(viewerImg).not.toBeNull()
    expect(viewerImg?.getAttribute('src')).toBe(srcA)
  })

  it('passes the whole group and index, opening at the clicked position', () => {
    const group = [
      { src: srcA, alt: 'one' },
      { src: srcB, alt: 'two' },
      { src: srcC, alt: 'three' },
    ]
    const { container } = render(
      <ImageViewerProvider>
        <MsgImage src={srcB} alt="two" group={group} index={1} />
      </ImageViewerProvider>,
    )
    fireEvent.click(container.querySelector('img.msg-image') as HTMLImageElement)
    const viewerImg = document.body.querySelector('img.lightbox-img') as HTMLImageElement
    expect(viewerImg.getAttribute('src')).toBe(srcB)
    // The viewer can navigate the group: next wraps to the third image.
    fireEvent.click(document.body.querySelector('.lightbox-nav-next') as HTMLButtonElement)
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcC)
  })

  it('does nothing (and does not throw) outside a provider', () => {
    const { container } = render(<MsgImage src={srcA} />)
    expect(() => fireEvent.click(container.querySelector('img.msg-image') as HTMLImageElement)).not.toThrow()
    expect(document.body.querySelector('img.lightbox-img')).toBeNull()
  })

  it('does not open the viewer for an image inside a markdown link (the link owns the click)', () => {
    const { container } = render(
      <ImageViewerProvider>
        <a href="https://example.com" target="_blank" rel="noreferrer">
          <MsgImage src={srcA} alt="shot" />
        </a>
      </ImageViewerProvider>,
    )
    fireEvent.click(container.querySelector('img.msg-image') as HTMLImageElement)
    expect(document.body.querySelector('img.lightbox-img')).toBeNull()
  })

  it('is keyboard-activatable (Enter/Space open the viewer)', () => {
    const { container } = render(
      <ImageViewerProvider>
        <MsgImage src={srcA} alt="shot" />
      </ImageViewerProvider>,
    )
    const img = container.querySelector('img.msg-image') as HTMLImageElement
    expect(img.getAttribute('tabindex')).toBe('0')
    expect(img.getAttribute('role')).toBe('button')

    fireEvent.keyDown(img, { key: 'Enter' })
    expect(document.body.querySelector('img.lightbox-img')).not.toBeNull()
    act(() => fireEvent.click(document.body.querySelector('[aria-label="Close"]') as HTMLButtonElement))
    // The exit is animated (~180ms): the overlay reports closing immediately.
    expect(document.body.querySelector('.lightbox-overlay')?.getAttribute('data-state')).toBe('closing')

    fireEvent.keyDown(img, { key: ' ' })
    expect(document.body.querySelector('img.lightbox-img')).not.toBeNull()
  })
})
