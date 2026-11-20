// The model-facing reference for one stored image.
//
// Mirrors shared/upload-handle.ts: the SDK copy carries this deterministic
// text block immediately before the base64 image block, and the same text is
// written to the SDK transcript. `parseImageHandle` recovers the structured
// reference for replay/restart, with no separate sidecar. Keep the format
// stable: a parser failure degrades to showing the raw text (and keeping the
// legacy base64 block), never to a broken message.
//
// Grammar:
//   [Image "<label>" (<width>x<height>, <mediaType>, <bytes> bytes,
//    sha256:<64hex>, attachment:sha256:<64hex>): normalized read-only copy
//    saved at "<host path>". Read that path with your file tools ...]
//
// The quoted label is COSMETIC only — ImageAttachmentRef has no name, and the
// parser never recovers the label. Every recoverable field lives in the
// parenthetical; both identity slots carry the FULL 64-hex digest (the digest
// IS the image identity, unlike the file handle's 8-char preview + upload id).

import { isImageRefBlock, type ImageAttachmentRef } from './image-attachment'

/** One parsed handle: the image reference plus its read-only host path. */
export interface ParsedImageHandle {
  readonly attachment: ImageAttachmentRef
  readonly path: string
}

const PREFIX = '[Image '
const SUFFIX = '. Read that path with your file tools'

/** Cosmetic display label derived from the media type (`image.png` etc.).
 *  Not part of the ref and not parsed back — see the module docblock. */
function cosmeticLabel(mediaType: ImageAttachmentRef['mediaType']): string {
  return `image.${mediaType.slice('image/'.length)}`
}

/**
 * Build the deterministic handle text for one image occurrence.
 * @param ref - stored-image reference (id/mediaType/bytes/width/height).
 * @param path - absolute read-only host path of the stored object.
 */
export function imageHandleText(ref: ImageAttachmentRef, path: string): string {
  const parts = [
    `${ref.width}x${ref.height}`,
    ref.mediaType,
    `${ref.bytes} bytes`,
    ref.id,
    `attachment:${ref.id}`,
  ]
  const identity = `Image ${JSON.stringify(cosmeticLabel(ref.mediaType))} (${parts.join(', ')})`
  return `[${identity}: normalized read-only copy saved at ${JSON.stringify(path)}${SUFFIX} when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

/** Read one JSON string literal starting at `start` (which must be a quote).
 *  Same approach as upload-handle's readQuoted: scan for the unescaped closing
 *  quote, then JSON.parse the literal so escapes decode exactly. */
function readQuoted(input: string, start: number): { value: string; end: number } | null {
  if (input[start] !== '"') return null
  let escaped = false
  for (let i = start + 1; i < input.length; i++) {
    const ch = input[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      try {
        return { value: JSON.parse(input.slice(start, i + 1)) as string, end: i + 1 }
      } catch {
        return null
      }
    }
  }
  return null
}

// The media-type slot matches any `image/<subtype>` shape; the supported-type
// allowlist is enforced by isImageRefBlock below (single source:
// shared/image-media.ts), so the parser never keeps a second copy of it.
const META = /^ \((\d+)x(\d+), (image\/[a-z]+), (\d+) bytes, (sha256:[a-f0-9]{64}), attachment:(sha256:[a-f0-9]{64})\): normalized read-only copy saved at /

/**
 * Recover one image reference from a handle text block.
 * @param text - a text block from a user message.
 * @returns the structured reference and host path, or null when the text is
 *   not a well-formed handle (never throws).
 */
export function parseImageHandle(text: string): ParsedImageHandle | null {
  if (!text.startsWith(PREFIX)) return null
  const label = readQuoted(text, PREFIX.length)
  if (label === null) return null
  const meta = META.exec(text.slice(label.end))
  if (meta === null) return null
  const [, width, height, mediaType, bytes, digestSlot, idSlot] = meta
  // Both identity slots must agree — a handle whose digests disagree is not a
  // trustworthy ref carrier.
  if (digestSlot !== idSlot) return null
  const path = readQuoted(text, label.end + meta[0].length)
  if (path === null) return null
  if (!text.startsWith(SUFFIX, path.end)) return null
  const block = {
    type: 'image',
    attachment: {
      id: idSlot,
      mediaType: mediaType as ImageAttachmentRef['mediaType'],
      bytes: Number(bytes),
      width: Number(width),
      height: Number(height),
    },
  }
  // The structural gate is the single source of ref validity (positive
  // integer dimensions, finite byte count, supported media type).
  if (!isImageRefBlock(block)) return null
  return { attachment: block.attachment, path: path.value }
}
