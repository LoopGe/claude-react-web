import type { FileAttachmentRef } from '../../shared/attachments'
import type { PastedImage } from '../types'

/** One content block of a POST /sessions/:id/messages body — text, a base64
 *  image, or an app-level FileBlock (the server resolves it to a handle). */
export type OutgoingContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }
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
    content.push({ type: 'image', source: { type: 'base64', data: img.data, media_type: img.mediaType } })
  }
  for (const file of files) content.push({ type: 'file', attachment: file })
  return { content }
}
