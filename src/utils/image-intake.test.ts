import { describe, expect, it, vi } from 'vitest'
import { isSupportedImageMediaType } from '../../shared/image-media'
import { intakeComposerFiles, splitIntakeFiles } from './image-intake'

function file(name: string, type: string): File {
  return new File(['x'], name, { type })
}

describe('isSupportedImageMediaType', () => {
  it('accepts the four formats the composer sends inline', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      expect(isSupportedImageMediaType(type)).toBe(true)
    }
  })

  it('rejects unsupported image formats and non-images', () => {
    for (const type of ['image/svg+xml', 'image/avif', 'image/bmp', 'application/pdf', '']) {
      expect(isSupportedImageMediaType(type)).toBe(false)
    }
  })
})

describe('splitIntakeFiles', () => {
  it('returns two empty groups for an empty batch', () => {
    expect(splitIntakeFiles([])).toEqual({ images: [], uploads: [] })
  })

  it('routes every supported image to the inline group in source order', () => {
    const a = file('a.png', 'image/png')
    const b = file('b.jpg', 'image/jpeg')
    expect(splitIntakeFiles([a, b])).toEqual({ images: [a, b], uploads: [] })
  })

  it('routes non-images and unsupported image types to the upload group in source order', () => {
    const pdf = file('doc.pdf', 'application/pdf')
    const svg = file('vector.svg', 'image/svg+xml')
    const zip = file('data.zip', 'application/zip')
    expect(splitIntakeFiles([pdf, svg, zip])).toEqual({ images: [], uploads: [pdf, svg, zip] })
  })

  it('splits a mixed batch without reordering within either group', () => {
    const a = file('a.png', 'image/png')
    const pdf = file('doc.pdf', 'application/pdf')
    const b = file('b.gif', 'image/gif')
    const svg = file('vector.svg', 'image/svg+xml')
    expect(splitIntakeFiles([a, pdf, b, svg])).toEqual({
      images: [a, b],
      uploads: [pdf, svg],
    })
  })
})

describe('intakeComposerFiles', () => {
  const options = () => ({
    addImages: vi.fn(),
    uploadFiles: vi.fn(),
    openUploads: vi.fn(),
  })

  it('adds images inline without opening the uploads manager', () => {
    const o = options()
    const a = file('a.png', 'image/png')
    intakeComposerFiles([a], o)
    expect(o.addImages).toHaveBeenCalledWith([a])
    expect(o.uploadFiles).not.toHaveBeenCalled()
    expect(o.openUploads).not.toHaveBeenCalled()
  })

  it('uploads non-images and opens the manager once', () => {
    const o = options()
    const pdf = file('doc.pdf', 'application/pdf')
    intakeComposerFiles([pdf], o)
    expect(o.addImages).not.toHaveBeenCalled()
    expect(o.openUploads).toHaveBeenCalledOnce()
    expect(o.uploadFiles).toHaveBeenCalledOnce()
    expect(o.uploadFiles).toHaveBeenCalledWith([pdf])
  })

  it('splits a mixed batch and opens the manager for the upload half only', () => {
    const o = options()
    const png = file('a.png', 'image/png')
    const pdf = file('doc.pdf', 'application/pdf')
    const svg = file('v.svg', 'image/svg+xml')
    intakeComposerFiles([png, pdf, svg], o)
    expect(o.addImages).toHaveBeenCalledWith([png])
    expect(o.uploadFiles).toHaveBeenCalledWith([pdf, svg])
    expect(o.openUploads).toHaveBeenCalledOnce()
  })

  it('is a no-op for an empty batch', () => {
    const o = options()
    intakeComposerFiles([], o)
    expect(o.addImages).not.toHaveBeenCalled()
    expect(o.uploadFiles).not.toHaveBeenCalled()
    expect(o.openUploads).not.toHaveBeenCalled()
  })
})