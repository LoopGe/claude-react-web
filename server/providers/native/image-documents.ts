// server/providers/native/image-documents.ts
// Image media for the native provider: the model-facing caps, the neutral
// ref-block builder, and the session-wide store that hands one just-read
// image to the projection that immediately follows (so a 5 MiB read is not
// repeated and re-verified on the same round).
//
// Host-free: no fs, no stores. Bytes reach and leave through ports; this
// module owns shape and limits only. Caps mirror the Anthropic API's vision
// limits (5 MB per image, 8000 px per side); the native provider has no
// decoder, so an over-cap image is refused with an actionable message
// instead of being downscaled (see the decision record).

import type { ImageAttachmentRef } from '../../../shared/image-attachment.js'
import type { SupportedImageMediaType } from '../../../shared/image-media.js'
import { inspectImageBytes } from '../../../shared/image-inspect.js'
import type { ImageMeta } from './ports.js'
import type { PdfBudgetReservation, PdfBudgetLedger } from './pdf-documents.js'

/** Raw bytes accepted for one model-visible image (the API per-image limit). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** Pixel cap per side (the API image dimension limit). */
export const IMAGE_MAX_DIMENSION = 8000

/** Session-wide raw-byte hold for prepared images between a read and its
 *  projection. Independent of the per-history request budget. */
export const PREPARED_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** API base64 payload for one image: 4 chars per 3 bytes, ceiled. */
export function imageBase64Length(size: number): number {
  return 4 * Math.ceil(size / 3)
}

/** Anthropic's vision pricing: one token per 750 pixels, floored at 1. Used by
 *  the context estimator so an image prices like an image, never like its
 *  base64 characters. */
export function estimateImageTokens(width: number, height: number): number {
  return Math.max(1, Math.ceil((width * height) / 750))
}

/** Which media family a file is, from its first bytes. Extension-independent:
 *  a PNG renamed .txt is still an image, and a PDF with no extension is still
 *  a PDF. Anything unrecognized falls through to the text reader, which keeps
 *  its own NUL/UTF-8 validation as the authoritative binary rejection. */
export function sniffNativeMediaKind(head: Buffer): 'image' | 'pdf' | 'text' {
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image'
  if (head.length >= 6) {
    const gif = head.subarray(0, 6).toString('latin1')
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image'
  }
  if (head.length >= 12
    && head.subarray(0, 4).toString('latin1') === 'RIFF'
    && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image'
  return 'text'
}

/** Validate model-facing image bytes against the API limits and return the
 *  declared metadata, or throw the neutral reason (never a raw path). */
export function validateImageForModel(bytes: Buffer): ImageMeta {
  if (bytes.length > IMAGE_MAX_BYTES) {
    throw new ImageReadError('size', 'image exceeds the 5 MiB per-image limit; resize or re-encode it before reading')
  }
  const inspected = inspectImageBytes(bytes)
  if (!inspected.ok) {
    throw new ImageReadError(
      inspected.reason === 'unsupported' ? 'unsupported' : 'malformed',
      inspected.reason === 'unsupported'
        ? 'unsupported image format; the model reads JPEG, PNG, GIF and WebP'
        : 'image bytes are truncated or corrupt',
    )
  }
  const image = inspected.image
  if (image.width > IMAGE_MAX_DIMENSION || image.height > IMAGE_MAX_DIMENSION) {
    throw new ImageReadError(
      'dimensions',
      `image is ${image.width}x${image.height} px; the API accepts at most ${IMAGE_MAX_DIMENSION} px per side, so resize it before reading`,
    )
  }
  return { mediaType: image.mediaType, width: image.width, height: image.height }
}

export class ImageReadError extends Error {
  constructor(
    readonly reason: 'size' | 'dimensions' | 'unsupported' | 'malformed',
    message: string,
  ) {
    super(message)
    this.name = 'ImageReadError'
  }
}

/** Model-safe reason text; raw paths never enter model history. */
export function safeImageReadReason(err: unknown): string {
  if (err instanceof ImageReadError) return err.message
  return 'the image could not be read'
}

/** The neutral ref occurrence for a published image. `id` is the CAS identity
 *  (`sha256:<digest>`), so replay, dedupe and the object store agree without a
 *  second naming scheme. */
export function imageRefBlockOf(
  digest: string,
  meta: ImageMeta & { bytes: number },
): { type: 'image'; attachment: ImageAttachmentRef; offloaded: true } {
  return {
    type: 'image',
    attachment: {
      id: `sha256:${digest}`,
      mediaType: meta.mediaType,
      bytes: meta.bytes,
      width: meta.width,
      height: meta.height,
    },
    offloaded: true,
  }
}

/** The API-shaped image block for one verified occurrence. */
export function imageModelBlockOf(mediaType: SupportedImageMediaType, base64: string): {
  type: 'image'
  source: { type: 'base64'; data: string; media_type: SupportedImageMediaType }
} {
  return { type: 'image', source: { type: 'base64', data: base64, media_type: mediaType } }
}

interface PreparedImageSlot {
  readonly toolUseId: string
  readonly attachment: ImageAttachmentRef
  readonly budget: PdfBudgetReservation
  readonly base64Chars: number
  block?: ReturnType<typeof imageModelBlockOf>
  persisted: boolean
}

/** Opaque handle for one in-flight image preparation. */
export class PreparedImageReservation {
  constructor(/** @internal */ readonly _slot: PreparedImageSlot) {}
}

/** Session-wide backpressure for verified image bytes held between a read and
 *  the immediately following projection. Mirrors PreparedPdfStore: the caller
 *  reserves, completes with the API block, confirms at persistence, and the
 *  projection consumes exactly once. */
export class PreparedImageStore {
  private readonly slots = new Map<string, PreparedImageSlot>()
  private rawBytes = 0
  private base64Chars = 0

  constructor(private readonly ledger: PdfBudgetLedger) {}

  reserve(
    toolUseId: string,
    attachment: ImageAttachmentRef,
    budget: PdfBudgetReservation,
  ): PreparedImageReservation {
    if (!toolUseId) throw new Error('PreparedImage requires a tool_use id')
    if (this.slots.has(toolUseId)) throw new Error(`PreparedImage already exists for tool_use: ${toolUseId}`)
    const encodedChars = imageBase64Length(attachment.bytes)
    if (this.rawBytes + attachment.bytes > PREPARED_IMAGE_MAX_BYTES) {
      throw new Error('PreparedImage session budget exceeded: 20 MiB raw bytes')
    }
    const slot: PreparedImageSlot = {
      toolUseId,
      attachment: { ...attachment },
      budget,
      base64Chars: encodedChars,
      persisted: false,
    }
    this.slots.set(toolUseId, slot)
    this.rawBytes += attachment.bytes
    this.base64Chars += encodedChars
    return new PreparedImageReservation(slot)
  }

  complete(reservation: PreparedImageReservation, block: ReturnType<typeof imageModelBlockOf>): void {
    const slot = reservation._slot
    if (this.slots.get(slot.toolUseId) !== slot) throw new Error('PreparedImage reservation is no longer active')
    if (slot.block) throw new Error(`PreparedImage is already complete for tool_use: ${slot.toolUseId}`)
    if (block.source.data.length !== slot.base64Chars) {
      throw new Error(`PreparedImage base64 length mismatch for tool_use: ${slot.toolUseId}`)
    }
    slot.block = block
  }

  confirmPersisted(toolUseId: string): void {
    const slot = this.slots.get(toolUseId)
    if (!slot || slot.persisted) return
    this.ledger.confirm(slot.budget)
    slot.persisted = true
  }

  consume(toolUseId: string, attachment: ImageAttachmentRef): ReturnType<typeof imageModelBlockOf> | undefined {
    const slot = this.slots.get(toolUseId)
    if (!slot) return undefined
    if (!slot.persisted || !slot.block) throw new Error(`PreparedImage is not ready for tool_use: ${toolUseId}`)
    if (slot.attachment.id !== attachment.id || slot.attachment.bytes !== attachment.bytes) {
      throw new Error(`PreparedImage attachment mismatch for tool_use: ${toolUseId}`)
    }
    const block = slot.block
    this.remove(slot)
    return block
  }

  release(toolUseId: string): void {
    const slot = this.slots.get(toolUseId)
    if (!slot) return
    if (!slot.persisted) this.ledger.release(slot.budget)
    this.remove(slot)
  }

  clearHistory(historyKey: string): void {
    for (const slot of [...this.slots.values()]) {
      if (slot.budget.historyKey === historyKey) this.release(slot.toolUseId)
    }
  }

  private remove(slot: PreparedImageSlot): void {
    this.slots.delete(slot.toolUseId)
    this.rawBytes -= slot.attachment.bytes
    this.base64Chars -= slot.base64Chars
  }
}
