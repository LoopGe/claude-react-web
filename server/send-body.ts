import type { ScheduledSendBody, ScheduledSendContentBlock } from '../shared/scheduled-send.js'

const VALID_IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
export const MAX_MESSAGE_BASE64 = 28_000_000

export type SendBodyValidation =
  | { ok: true; body: ScheduledSendBody }
  | { ok: false; status: 400 | 413; error: string }

/** Validate a user-turn body shared by `POST /sessions/:id/messages` and
 *  `POST /sessions/:id/schedules`. The two routes must stay byte-identical
 *  in accepted shapes and error strings. */
export function validateSendBody(raw: { text?: unknown; content?: unknown }): SendBodyValidation {
  if (Array.isArray(raw.content) && raw.content.length > 0) {
    let totalBase64 = 0
    for (const block of raw.content) {
      const b = block as Record<string, unknown>
      if (b.type === 'image') {
        const source = b.source as Record<string, unknown> | undefined
        if (!source || source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
          return { ok: false, status: 400, error: 'invalid image block: missing base64 source' }
        }
        if (!VALID_IMG_TYPES.has(source.media_type as string)) {
          return { ok: false, status: 400, error: `unsupported image type: ${source.media_type}` }
        }
        totalBase64 += (source.data as string).length
      } else if (b.type !== 'text') {
        return { ok: false, status: 400, error: `unsupported content block type: ${b.type}` }
      }
    }
    if (totalBase64 > MAX_MESSAGE_BASE64) {
      return { ok: false, status: 413, error: 'total image payload too large' }
    }
    return { ok: true, body: { content: raw.content as ScheduledSendContentBlock[] } }
  }
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (!text.trim()) return { ok: false, status: 400, error: 'text is required' }
  return { ok: true, body: { text } }
}
