// One normalized-image transfer: POST the raw blob to the image upload
// route and resolve its durable ref. The image twin of upload-file.ts (the
// composer's file primitive); the server verifies the actual bytes
// (shared/image-inspect) and publishes them content-addressed, so the
// response ref is the only thing the composer keeps.

import { isImageRefBlock, type ImageAttachmentRef } from '../../shared/image-attachment'

export interface UploadImageOptions {
  readonly sessionId?: string
  readonly signal?: AbortSignal
}

/** Upload one already-normalized image blob; resolve its store reference.
 *  Rejections carry the server's error text when present; an abort surfaces
 *  as AbortError so the intake queue can drop it silently. */
export async function uploadImage(blob: Blob, opts: UploadImageOptions = {}): Promise<ImageAttachmentRef> {
  const query = opts.sessionId === undefined
    ? ''
    : `?sessionId=${encodeURIComponent(opts.sessionId)}`
  const res = await fetch(`/api/uploads/images${query}`, {
    method: 'POST',
    body: blob,
    signal: opts.signal,
  })
  if (!res.ok) {
    let message = `Image upload failed (HTTP ${res.status})`
    try {
      const body = await res.json() as { error?: unknown }
      if (typeof body.error === 'string' && body.error !== '') message = body.error
    } catch {
      // Fall through to the status text.
    }
    throw new Error(message)
  }
  const parsed = await res.json() as { attachment?: unknown }
  const block = { type: 'image', attachment: parsed.attachment }
  if (!isImageRefBlock(block)) {
    throw new Error('Upload response did not include an image reference')
  }
  return block.attachment
}
