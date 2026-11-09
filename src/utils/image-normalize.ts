// Browser-side image normalization.
//
// The composer decodes the source through an <img> element (modern browsers
// apply EXIF orientation and report oriented natural dimensions), draws it to
// a canvas, scans the alpha channel, and re-encodes through the shared quality
// ladder. The encoded output is verified with the header inspector before it
// becomes a PastedImage payload.

import { inspectImageBytes } from '../../shared/image-inspect'
import { isSupportedImageMediaType, type SupportedImageMediaType } from '../../shared/image-media'
import {
  NORMALIZED_IMAGE_MAX_BYTES,
  NORMALIZED_IMAGE_QUALITIES,
  normalizedImageDimensions,
} from '../../shared/image-normalize'
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from '../../shared/upload-limits'
import type { PastedImageOriginal } from '../types'
import { fileToBase64 } from './file-to-base64'

export class ImageNormalizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageNormalizeError'
  }
}

export interface LoadedImage {
  readonly image: CanvasImageSource
  readonly width: number
  readonly height: number
  close(): void
}

interface Canvas2DLike {
  imageSmoothingQuality: 'low' | 'medium' | 'high'
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray }
}

export interface CanvasLike {
  readonly width: number
  readonly height: number
  getContext(contextId: '2d', options?: { willReadFrequently?: boolean }): Canvas2DLike | null
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void
}

export interface ImageNormalizeDeps {
  readFile?: (file: Blob) => Promise<ArrayBuffer>
  loadImage?: (file: Blob) => Promise<LoadedImage>
  createCanvas?: (width: number, height: number) => CanvasLike
  toBase64?: (blob: Blob) => Promise<string>
}

export interface NormalizedImage {
  data: string
  mediaType: SupportedImageMediaType
  width: number
  height: number
  size: number
  original: PastedImageOriginal
}

export interface PreparePastedImageOptions {
  /** Encoded-byte target; defaults to the shared 4 MiB policy. */
  maxBytes?: number
  /** Injectable browser seams (tests). */
  deps?: ImageNormalizeDeps
}

async function defaultLoadImage(file: Blob): Promise<LoadedImage> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new ImageNormalizeError('This image could not be decoded.')
    }
    return {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err instanceof ImageNormalizeError
      ? err
      : new ImageNormalizeError('This image could not be decoded.')
  }
}

function defaultCreateCanvas(width: number, height: number): CanvasLike {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** True when any pixel is not fully opaque. A read failure is treated as
 *  potentially transparent so WebP (the alpha-capable codec) is chosen. */
function scanAlpha(ctx: Canvas2DLike, width: number, height: number): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, width, height)
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true
    }
    return false
  } catch {
    return true
  }
}

function canvasToBlob(canvas: CanvasLike, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new ImageNormalizeError('Image encoding failed.'))
      else resolve(blob)
    }, type, quality)
  })
}

/**
 * Normalize one composer image: verify the source, decode with EXIF
 * orientation, downscale under the shared pixel budget, walk the quality
 * ladder, and return the verified output plus the source facts.
 * @param file - source image blob.
 * @param options - encoded-byte target and injectable browser seams.
 * @returns verified normalized bytes and metadata.
 */
export async function preparePastedImage(
  file: Blob,
  options: PreparePastedImageOptions = {},
): Promise<NormalizedImage> {
  const maxBytes = options.maxBytes ?? NORMALIZED_IMAGE_MAX_BYTES
  const deps = options.deps ?? {}
  const readFile = deps.readFile ?? ((value: Blob) => value.arrayBuffer())
  const loadImage = deps.loadImage ?? defaultLoadImage
  const createCanvas = deps.createCanvas ?? defaultCreateCanvas
  const toBase64 = deps.toBase64 ?? fileToBase64

  const bytes = new Uint8Array(await readFile(file))
  const inspected = inspectImageBytes(bytes)
  if (!inspected.ok) {
    throw new ImageNormalizeError('This file is not a valid PNG, JPEG, GIF, or WebP image.')
  }
  const source = inspected.image
  if (source.width * source.height > MAX_IMAGE_PIXELS) {
    throw new ImageNormalizeError(`This image is too large to process. Max ${MAX_IMAGE_PIXELS} pixels.`)
  }
  if (Math.max(source.width, source.height) > MAX_IMAGE_DIMENSION) {
    throw new ImageNormalizeError(`This image is too large to process. Max ${MAX_IMAGE_DIMENSION} pixels per side.`)
  }

  const loaded = await loadImage(file)
  try {
    const normalized = normalizedImageDimensions(loaded.width, loaded.height)
    const canvas = createCanvas(normalized.width, normalized.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx === null) throw new ImageNormalizeError('Image processing is not supported in this browser.')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(loaded.image, 0, 0, normalized.width, normalized.height)

    const hasAlpha = source.mediaType === 'image/jpeg'
      ? false
      : scanAlpha(ctx, normalized.width, normalized.height)
    const requestedType = hasAlpha ? 'image/webp' : 'image/jpeg'

    let smallest: Blob | undefined
    for (const quality of NORMALIZED_IMAGE_QUALITIES) {
      const blob = await canvasToBlob(canvas, requestedType, quality)
      if (smallest === undefined || blob.size < smallest.size) smallest = blob
      if (blob.size <= maxBytes) break
      // The browser ignored the requested codec (for example WebP fell back
      // to PNG); lower qualities cannot shrink that output.
      if (blob.type !== requestedType) break
    }
    if (smallest === undefined) throw new ImageNormalizeError('Image encoding failed.')
    // A browser that fell back to PNG can still exceed the server's per-image
    // cap; surfacing it at paste time beats a 413 on Send.
    if (smallest.size > MAX_IMAGE_BYTES) {
      throw new ImageNormalizeError(
        `The normalized image is too large to send. Max ${MAX_IMAGE_BYTES} bytes.`,
      )
    }

    const outBytes = new Uint8Array(await smallest.arrayBuffer())
    const verified = inspectImageBytes(outBytes)
    if (!verified.ok || !isSupportedImageMediaType(verified.image.mediaType)) {
      throw new ImageNormalizeError('The normalized image could not be verified.')
    }

    return {
      data: await toBase64(smallest),
      mediaType: verified.image.mediaType,
      width: verified.image.width,
      height: verified.image.height,
      size: smallest.size,
      original: {
        mediaType: source.mediaType,
        width: loaded.width,
        height: loaded.height,
        size: file.size,
      },
    }
  } finally {
    loaded.close()
  }
}