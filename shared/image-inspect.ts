// Header-only raster inspection for message admission.
//
// A full pixel decode would need a native image library; the server only needs
// the actual container type and intrinsic dimensions to reject malformed or
// oversized input before the SDK sends it to a model provider. The module is
// browser-safe so the composer can reuse it for early feedback.

import type { SupportedImageMediaType } from './image-media'

export interface InspectedImage {
  readonly mediaType: SupportedImageMediaType
  readonly width: number
  readonly height: number
}

export type ImageInspectResult =
  | { readonly ok: true; readonly image: InspectedImage }
  | { readonly ok: false; readonly reason: 'unsupported' | 'malformed' }

const MALFORMED: ImageInspectResult = { ok: false, reason: 'malformed' }
const UNSUPPORTED: ImageInspectResult = { ok: false, reason: 'unsupported' }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** JPEG markers that carry the frame dimensions. */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  ) >>> 0
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = ''
  for (let i = 0; i < length; i++) value += String.fromCharCode(bytes[offset + i])
  return value
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false
  }
  return true
}

function inspected(mediaType: SupportedImageMediaType, width: number, height: number): ImageInspectResult {
  if (width <= 0 || height <= 0) return MALFORMED
  return { ok: true, image: { mediaType, width, height } }
}

function inspectJpeg(bytes: Uint8Array): ImageInspectResult {
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return MALFORMED
    // JPEG permits any number of 0xFF fill bytes before a marker.
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return MALFORMED
    const marker = bytes[offset]
    offset++
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    // SOS or EOI before any SOF means the frame dimensions were never declared.
    if (marker === 0xd9 || marker === 0xda) return MALFORMED
    if (offset + 2 > bytes.length) return MALFORMED
    const length = u16be(bytes, offset)
    if (length < 2 || offset + length > bytes.length) return MALFORMED
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return MALFORMED
      return inspected('image/jpeg', u16be(bytes, offset + 5), u16be(bytes, offset + 3))
    }
    offset += length
  }
  return MALFORMED
}

function inspectWebp(bytes: Uint8Array): ImageInspectResult {
  if (bytes.length < 20) return MALFORMED
  const fourcc = ascii(bytes, 12, 4)
  if (fourcc === 'VP8X') {
    if (bytes.length < 30) return MALFORMED
    return inspected('image/webp', u24le(bytes, 24) + 1, u24le(bytes, 27) + 1)
  }
  if (fourcc === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return MALFORMED
    const packed = u32le(bytes, 21)
    return inspected(
      'image/webp',
      (packed & 0x3fff) + 1,
      ((packed >>> 14) & 0x3fff) + 1,
    )
  }
  if (fourcc === 'VP8 ') {
    if (bytes.length < 30) return MALFORMED
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return MALFORMED
    return inspected('image/webp', u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff)
  }
  return MALFORMED
}

/**
 * Inspect one encoded raster without decoding its pixels.
 * @param bytes - complete encoded image bytes.
 * @returns the verified container type and intrinsic dimensions, or a stable
 *          failure reason for the admission layer to map to a 400.
 */
export function inspectImageBytes(bytes: Uint8Array): ImageInspectResult {
  if (bytes.length < 12) return MALFORMED

  if (startsWith(bytes, PNG_SIGNATURE)) {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return MALFORMED
    return inspected('image/png', u32be(bytes, 16), u32be(bytes, 20))
  }

  const magic6 = ascii(bytes, 0, 6)
  if (magic6 === 'GIF87a' || magic6 === 'GIF89a') {
    return inspected('image/gif', u16le(bytes, 6), u16le(bytes, 8))
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes)

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return inspectWebp(bytes)

  return UNSUPPORTED
}