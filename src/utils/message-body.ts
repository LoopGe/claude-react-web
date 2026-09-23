import type { PastedImage } from '../types'

/** One content block of a POST /sessions/:id/messages body — same shape as
 *  shared/scheduled-send.ts's ScheduledSendContentBlock (plain text, or a
 *  base64 image). */
export type OutgoingContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }

/** Body accepted by POST /sessions/:id/messages: legacy `{ text }` string, or
 *  a multimodal `{ content }` array (text + image blocks). */
export type OutgoingMessageBody = { text: string } | { content: OutgoingContentBlock[] }

/** Build the request body for an outgoing message. The single builder for
 *  the send path, the scheduled-send body, and the side-chat drawer — the
 *  three previously hand-kept-in-sync copies (the "KEEP IN SYNC" comment is
 *  now enforced by construction). Multimodal bodies include the text block
 *  only when the text has non-whitespace content. */
export function buildOutgoingBody(text: string, images: readonly PastedImage[]): OutgoingMessageBody {
  if (images.length === 0) return { text }
  const content: OutgoingContentBlock[] = []
  if (text.trim()) content.push({ type: 'text', text })
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', data: img.data, media_type: img.mediaType } })
  }
  return { content }
}
