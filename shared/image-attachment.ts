// App-level image references. Like FileBlock (shared/attachments.ts), the
// structured ref block is what the ring/broadcast carries; the legacy inline
// base64 block stays readable for old transcripts. The durable bytes live in
// the content-addressed image store (server/attachment-object-store.ts), keyed
// by `sha256:<digest>` — no filename alias, the digest is the identity.

import { isSupportedImageMediaType, type SupportedImageMediaType } from './image-media'

/** Durable reference to one stored image. `id` is `sha256:<64hex>`. */
export interface ImageAttachmentRef {
  id: string
  mediaType: SupportedImageMediaType
  bytes: number
  width: number
  height: number
}

/** One image occurrence backed by the object store. */
export interface ImageRefBlock {
  type: 'image'
  attachment: ImageAttachmentRef
}

/** The legacy inline base64 image block (SDK shape), still readable on replay. */
export type LegacyImageBlock = {
  type: 'image'
  source: { type: 'base64'; data: string; media_type: string }
}

export type AnyImageBlock = ImageRefBlock | LegacyImageBlock

const IMAGE_REF_ID = /^sha256:[a-f0-9]{64}$/

/** Build the store reference id for a bare lowercase sha256 digest. */
export function imageRefId(digest: string): string {
  return `sha256:${digest}`
}

/** Recover the bare digest from a reference id, or null when malformed. */
export function digestOfImageRef(id: string): string | null {
  return IMAGE_REF_ID.test(id) ? id.slice('sha256:'.length) : null
}

/** Structural check for a wire/ring image ref block (vs the legacy base64
 *  block, which carries `source` and no `attachment`). */
export function isImageRefBlock(value: unknown): value is ImageRefBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const block = value as { type?: unknown; attachment?: unknown }
  if (block.type !== 'image') return false
  if (typeof block.attachment !== 'object' || block.attachment === null || Array.isArray(block.attachment)) {
    return false
  }
  const ref = block.attachment as {
    id?: unknown
    mediaType?: unknown
    bytes?: unknown
    width?: unknown
    height?: unknown
  }
  return typeof ref.id === 'string' && digestOfImageRef(ref.id) !== null
    && typeof ref.mediaType === 'string' && isSupportedImageMediaType(ref.mediaType)
    && typeof ref.bytes === 'number' && Number.isFinite(ref.bytes) && ref.bytes >= 0
    && typeof ref.width === 'number' && Number.isInteger(ref.width) && ref.width > 0
    && typeof ref.height === 'number' && Number.isInteger(ref.height) && ref.height > 0
}
