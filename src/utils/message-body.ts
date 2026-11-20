import type { FileAttachmentRef } from '../../shared/attachments'
import type { ImageAttachmentRef } from '../../shared/image-attachment'
import type { PastedImage } from '../types'

/** One content block of a POST /sessions/:id/messages body — text, a durable
 *  image ref (or the legacy base64 image), or an app-level FileBlock (the
 *  server resolves both attachment kinds before the SDK sees them). */
export type OutgoingContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }
  | { type: 'image'; attachment: ImageAttachmentRef }
  | { type: 'file'; attachment: FileAttachmentRef }

/** Body accepted by POST /sessions/:id/messages: legacy `{ text }` string, or
 *  a multimodal `{ content }` array (text + image blocks). */
export type OutgoingMessageBody = { text: string } | { content: OutgoingContentBlock[] }

/** Build the request body for an outgoing message. The single builder for
 *  the send path, the scheduled-send body, and the side-chat drawer — the
 *  three previously hand-kept-in-sync copies (the "KEEP IN SYNC" comment is
 *  now enforced by construction). Multimodal bodies include the text block
 *  only when the text has non-whitespace content. */
export function buildOutgoingBody(
  text: string,
  images: readonly PastedImage[],
  files: readonly FileAttachmentRef[] = [],
): OutgoingMessageBody {
  if (images.length === 0 && files.length === 0) return { text }
  const content: OutgoingContentBlock[] = []
  if (text.trim()) content.push({ type: 'text', text })
  for (const img of images) {
    // A published image rides as its durable ref; the bytes stay in the object
    // store and the server verifies them at dispatch. The legacy base64 shape
    // stays for restored pre-ref drafts (no attachment).
    if (img.attachment !== undefined) {
      content.push({ type: 'image', attachment: img.attachment })
    } else {
      content.push({ type: 'image', source: { type: 'base64', data: img.data, media_type: img.mediaType } })
    }
  }
  for (const file of files) content.push({ type: 'file', attachment: file })
  return { content }
}
