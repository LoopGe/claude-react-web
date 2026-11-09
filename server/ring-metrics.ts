// Image-payload measurement for retained session rings.
//
// The decisive input for the image-persistence decision is how much base64
// image data the in-memory rings retain. This walks both rings and sums the
// image blocks; base64 length is the wire/ring byte cost for ASCII payloads.

import { imagePayloadOfMessage } from '../shared/user-frames.js'

/** The subset of a session this measurement needs. */
export interface RingImageSource {
  history: readonly unknown[]
  subagentHistory: readonly unknown[]
}

/** Sum image blocks and base64 bytes across every session's two rings. */
export function ringImagePayload(
  sessions: Iterable<RingImageSource>,
): { images: number; bytes: number } {
  let images = 0
  let bytes = 0
  for (const session of sessions) {
    for (const ring of [session.history, session.subagentHistory]) {
      for (const message of ring) {
        const payload = imagePayloadOfMessage(message)
        images += payload.images
        bytes += payload.bytes
      }
    }
  }
  return { images, bytes }
}