// App-level file references. These are NOT SDK content blocks: the SDK
// receives a text handle projected at dispatch time (shared/upload-handle.ts).
// The structured block is what our ring/broadcast carries; disk history
// persists the projected text, and the UI recovers the same ref by parsing
// that handle, so no sidecar is needed.

/** Durable reference to one uploaded file. `id` is the upload registry id. */
export interface FileAttachmentRef {
  readonly id: string
  readonly name: string
  readonly size: number
  /** sha256 of the stored bytes, when the uploader computed it. */
  readonly digest?: string
}

/** One file occurrence inside user content. */
export interface FileBlock {
  readonly type: 'file'
  readonly attachment: FileAttachmentRef
}

/** Structural check for a wire/ring file block. */
export function isFileBlock(value: unknown): value is FileBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const block = value as { type?: unknown; attachment?: unknown }
  if (block.type !== 'file') return false
  if (typeof block.attachment !== 'object' || block.attachment === null || Array.isArray(block.attachment)) {
    return false
  }
  const ref = block.attachment as { id?: unknown; name?: unknown; size?: unknown; digest?: unknown }
  return typeof ref.id === 'string' && ref.id.length > 0
    && typeof ref.name === 'string' && ref.name.length > 0
    && typeof ref.size === 'number' && Number.isFinite(ref.size) && ref.size >= 0
    && (ref.digest === undefined || typeof ref.digest === 'string')
}