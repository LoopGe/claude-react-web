// Image upload + content routes for durable image references.
//
// POST /uploads/images accepts one already-normalized image as the raw
// request body, verifies the actual bytes (shared/image-inspect), enforces
// the shared image policy, and publishes into the content-addressed image
// store. GET /attachments/images/:digest serves stored bytes behind a
// verified read — the client supplies only the digest, never a path.
//
// The body is buffered, not streamed: publishImage takes the whole normalized
// byte array (capped at MAX_IMAGE_BYTES, well under the app's global body
// limit), so there is no streaming sink to wire. Mounted inside
// buildApiRouter next to the file upload routes, so the same request guard +
// web-access auth gate covers both surfaces.

import { Hono } from 'hono'
import type { SessionManager } from '../session-manager.js'
import {
  AttachmentObjectStore,
  AttachmentStoreError,
  type PublishedImage,
  type StoredImageMeta,
} from '../attachment-object-store.js'
import { createLogger } from '../log.js'
import { inspectImageBytes } from '../../shared/image-inspect.js'
import { imageRefId, type ImageAttachmentRef } from '../../shared/image-attachment.js'
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from '../../shared/upload-limits.js'

const log = createLogger('image-uploads')

/** A bare lowercase sha256 — the object identity in the image tree. Anything
 *  else could escape the store root, so it is refused before any read. */
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

export function buildImageUploadRouter(sm: SessionManager, objects: AttachmentObjectStore): Hono {
  const app = new Hono()

  // Upload one normalized image (raw body). The bytes are authoritative:
  // type and dimensions come from inspectImageBytes, never from headers.
  // Rejection statuses mirror the message route's image admission
  // (server/send-body.ts): over-size 413, invalid/over-policy 400.
  app.post('/uploads/images', async (c) => {
    const sessionId = c.req.query('sessionId')
    if (sessionId) sm.get(sessionId) // throws HttpError(404) for unknown ids

    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return c.json({ error: `image exceeds ${MAX_IMAGE_BYTES} bytes` }, 413)
    }
    const inspected = inspectImageBytes(bytes)
    if (!inspected.ok) {
      return c.json({ error: 'not a valid PNG, JPEG, GIF, or WebP image' }, 400)
    }
    const { mediaType, width, height } = inspected.image
    if (width * height > MAX_IMAGE_PIXELS) {
      return c.json({ error: `image exceeds ${MAX_IMAGE_PIXELS} pixels` }, 400)
    }
    if (Math.max(width, height) > MAX_IMAGE_DIMENSION) {
      return c.json({ error: `image exceeds ${MAX_IMAGE_DIMENSION} pixels per side` }, 400)
    }

    let published: PublishedImage
    try {
      published = await objects.publishImage(bytes, { mediaType, width, height })
    } catch (e) {
      log.error(`image store failure: ${e instanceof Error ? e.message : String(e)}`)
      return c.json({ error: 'failed to store image' }, 500)
    }
    const attachment: ImageAttachmentRef = {
      id: imageRefId(published.digest),
      mediaType,
      bytes: published.bytes,
      width,
      height,
    }
    log.info(`image upload session=${sessionId ?? 'common'} digest=${published.digest} bytes=${published.bytes}`)
    return c.json({ attachment })
  })

  // Serve one stored image. Refs are global to the authenticated server (no
  // ownership check, matching the file store); the digest is the only input.
  app.get('/attachments/images/:digest', async (c) => {
    const digest = c.req.param('digest')
    if (!DIGEST_PATTERN.test(digest)) {
      return c.json({ error: 'invalid image digest' }, 400)
    }
    let stored: { bytes: Uint8Array; meta: StoredImageMeta }
    try {
      stored = await objects.readVerifiedImage(digest)
    } catch (e) {
      if (e instanceof AttachmentStoreError && e.code === 'missing') {
        return c.json({ error: 'image not found' }, 404)
      }
      if (e instanceof AttachmentStoreError && e.code === 'corrupt') {
        log.error(`image integrity verification failed for ${digest}`)
        return c.json({ error: 'image failed integrity verification' }, 500)
      }
      throw e
    }
    // The whole image is verified in memory before anything is sent, so the
    // declared length is a fact about the verified bytes. Content addressing
    // makes the bytes immutable — a long private cache is safe. The copy into
    // a fresh Uint8Array gives the Response an exact ArrayBuffer-backed view
    // (Buffer.concat may return a pool-backed view), bounded by MAX_IMAGE_BYTES.
    return new Response(new Uint8Array(stored.bytes), {
      headers: {
        'Content-Type': stored.meta.mediaType,
        'Content-Length': String(stored.bytes.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  })

  return app
}
