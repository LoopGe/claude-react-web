import type { Block } from '../types'

/** Shape of the `source` field on an SDK image block. Deliberately loose —
 *  `Block.source` is `unknown` via the index signature, and this is the one
 *  place that knows the real shape. */
interface ImageSource {
  type?: string
  data?: unknown
  media_type?: string
}

/**
 * Convert an image content block (SDK shape `{ type: 'image', source:
 * { type: 'base64', media_type, data } }`) into a `data:` URL safe for an
 * `<img>` src.
 *
 * Returns null when the block is not an image, the source is missing /
 * malformed, the data is not a non-empty string, or the media type is not
 * `image/*`. Validation is shape-only: it does not attempt to verify the
 * base64 payload itself (the SDK emits valid base64; an invalid payload
 * degrades to a broken img exactly as it does today).
 *
 * Single source of truth for the image-source shape, shared by
 * ToolResultDetails (tool-result screenshots) and BlockView (pasted /
 * streamed image blocks).
 */
export function imageBlockToDataUrl(block: Block | undefined | null): string | null {
  if (!block || block.type !== 'image') return null
  const source = block.source as ImageSource | undefined
  if (
    !source ||
    typeof source !== 'object' ||
    source.type !== 'base64' ||
    typeof source.data !== 'string' ||
    source.data.length === 0 ||
    typeof source.media_type !== 'string' ||
    !/^image\//.test(source.media_type)
  ) {
    return null
  }
  return `data:${source.media_type};base64,${source.data}`
}
