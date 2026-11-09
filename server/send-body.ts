import type { ScheduledSendBody, ScheduledSendContentBlock } from '../shared/scheduled-send.js'
import { isSupportedImageMediaType } from '../shared/image-media.js'
import { isFileBlock } from '../shared/attachments.js'
import {
  MAX_FILES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_BASE64,
} from '../shared/upload-limits.js'

export { MAX_FILES_PER_MESSAGE, MAX_MESSAGE_BASE64 }

export type SendBodyValidation =
  | { ok: true; body: ScheduledSendBody }
  | { ok: false; status: 400 | 413; error: string }

/** Validate a user-turn body shared by `POST /sessions/:id/messages` and
 *  `POST /sessions/:id/schedules`. The two routes must stay byte-identical
 *  in accepted shapes and error strings. */
export function validateSendBody(raw: { text?: unknown; content?: unknown }): SendBodyValidation {
  if (Array.isArray(raw.content) && raw.content.length > 0) {
    let totalBase64 = 0
    let fileCount = 0
    let imageCount = 0
    const images: Array<{ data: string; mediaType: string }> = []
    for (const block of raw.content) {
      const b = block as Record<string, unknown>
      if (b.type === 'image') {
        const source = b.source as Record<string, unknown> | undefined
        if (!source || source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
          return { ok: false, status: 400, error: 'invalid image block: missing base64 source' }
        }
        if (!isSupportedImageMediaType(source.media_type as string)) {
          return { ok: false, status: 400, error: `unsupported image type: ${source.media_type}` }
        }
        imageCount += 1
        if (imageCount > MAX_IMAGES_PER_MESSAGE) {
          return { ok: false, status: 400, error: `at most ${MAX_IMAGES_PER_MESSAGE} images per message` }
        }
        images.push({ data: source.data as string, mediaType: source.media_type as string })
        totalBase64 += (source.data as string).length
      } else if (b.type === 'file') {
        if (!isFileBlock(block)) {
          return { ok: false, status: 400, error: 'invalid file block' }
        }
        fileCount += 1
        if (fileCount > MAX_FILES_PER_MESSAGE) {
          return { ok: false, status: 400, error: `at most ${MAX_FILES_PER_MESSAGE} file attachments per message` }
        }
      } else if (b.type !== 'text') {
        return { ok: false, status: 400, error: `unsupported content block type: ${b.type}` }
      }
    }
    if (totalBase64 > MAX_MESSAGE_BASE64) {
      return { ok: false, status: 413, error: 'total image payload too large' }
    }
    for (const [index, image] of images.entries()) {
      if (Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) {
        return { ok: false, status: 413, error: `image #${index + 1} exceeds ${MAX_IMAGE_BYTES} bytes` }
      }
    }
    return { ok: true, body: { content: raw.content as ScheduledSendContentBlock[] } }
  }
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (!text.trim()) return { ok: false, status: 400, error: 'text is required' }
  return { ok: true, body: { text } }
}
