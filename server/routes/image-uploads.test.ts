// Tests for the image upload + content routes: byte-verified admission with
// the shared image policy, content-addressed dedupe, immutable content
// serving, and fail-closed missing/corrupt reads.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler, HttpError } from '../errors.js'
import { buildImageUploadRouter } from './image-uploads.js'
import { AttachmentObjectStore } from '../attachment-object-store.js'
import { attachmentRoot, imageMetaPathOf, imageObjectPathOf } from '../attachment-paths.js'
import { digestOfImageRef, type ImageAttachmentRef } from '../../shared/image-attachment.js'
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from '../../shared/upload-limits.js'
import { tempDir } from '../__test-utils__/index.js'
import { buildApp } from '../app.js'
import { SessionStore } from '../persistence.js'
import type { SessionManager } from '../session-manager.js'

/** A real 1x1 PNG (same fixture as shared/image-inspect.test.ts). */
const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
)

/** Header-only PNG with declared dimensions — inspectImageBytes reads the
 *  IHDR facts without decoding pixels, so limit tests need no real raster. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8) // length 13, 'IHDR'
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

function makeSm(): SessionManager {
  // The router only uses sm.get(id) to validate a supplied sessionId.
  return {
    get: (id: string) => {
      if (id !== 's1') throw new HttpError(404, `session ${id} not found`)
      return { cwd: process.cwd(), title: 'T' }
    },
  } as unknown as SessionManager
}

/** Published objects are 0o400, and Windows refuses to delete a read-only
 *  file, so clear the attribute before removing the tree. */
function cleanup(dir: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) cleanup(path)
    else chmodSync(path, 0o600)
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

/** rmSync a single published file (0o400 on Windows) by clearing it first. */
function removeFile(path: string): void {
  chmodSync(path, 0o600)
  rmSync(path)
}

function digestOf(ref: ImageAttachmentRef): string {
  const digest = digestOfImageRef(ref.id)
  if (digest === null) throw new Error(`ref id is not a sha256 reference: ${ref.id}`)
  return digest
}

describe('image upload routes', () => {
  let stateDir: string
  let app: Hono

  beforeEach(() => {
    stateDir = tempDir('image-uploads')
    app = new Hono()
    app.onError(createErrorHandler('[test]'))
    app.route('/', buildImageUploadRouter(makeSm(), new AttachmentObjectStore(stateDir)))
  })
  afterEach(() => {
    cleanup(stateDir)
  })

  async function upload(bytes: Uint8Array, query = '', headers?: Record<string, string>): Promise<Response> {
    return app.request(`/uploads/images${query}`, { method: 'POST', body: bytes, headers })
  }

  async function uploadOk(bytes: Uint8Array, query = ''): Promise<ImageAttachmentRef> {
    const res = await upload(bytes, query)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { attachment: ImageAttachmentRef }
    return body.attachment
  }

  async function content(digest: string): Promise<Response> {
    return app.request(`/attachments/images/${digest}`)
  }

  describe('POST /uploads/images', () => {
    it('publishes verified bytes and returns a ref with the inspected facts', async () => {
      const ref = await uploadOk(PNG_1X1)
      expect(ref.id).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(ref.mediaType).toBe('image/png')
      expect(ref.width).toBe(1)
      expect(ref.height).toBe(1)
      expect(ref.bytes).toBe(PNG_1X1.byteLength)
      const root = attachmentRoot(stateDir)
      expect(existsSync(imageObjectPathOf(root, digestOf(ref)))).toBe(true)
      expect(existsSync(imageMetaPathOf(root, digestOf(ref)))).toBe(true)
    })

    it('derives mediaType from the bytes, not the declared Content-Type', async () => {
      const res = await upload(PNG_1X1, '', { 'content-type': 'image/jpeg' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { attachment: ImageAttachmentRef }
      expect(body.attachment.mediaType).toBe('image/png')
    })

    it('rejects unsupported bytes with 400', async () => {
      const res = await upload(new TextEncoder().encode('this is definitely not an image'))
      expect(res.status).toBe(400)
    })

    it('rejects malformed bytes with 400', async () => {
      const truncated = new Uint8Array(24)
      truncated.set(PNG_1X1.subarray(0, 8)) // PNG signature, no IHDR
      expect((await upload(truncated)).status).toBe(400)
      expect((await upload(new Uint8Array(0))).status).toBe(400)
    })

    it('413s bytes over MAX_IMAGE_BYTES and stores nothing', async () => {
      const res = await upload(new Uint8Array(MAX_IMAGE_BYTES + 1))
      expect(res.status).toBe(413)
      expect(existsSync(join(attachmentRoot(stateDir), 'images'))).toBe(false)
    })

    it('400s images over the pixel cap', async () => {
      expect(8001 * 8000).toBeGreaterThan(MAX_IMAGE_PIXELS)
      const res = await upload(pngHeader(8001, 8000))
      expect(res.status).toBe(400)
    })

    it('400s images over the per-side cap', async () => {
      const res = await upload(pngHeader(MAX_IMAGE_DIMENSION + 1, 1))
      expect(res.status).toBe(400)
    })

    it('dedupes identical bytes to one ref and one object', async () => {
      const a = await uploadOk(PNG_1X1)
      const b = await uploadOk(PNG_1X1)
      expect(b).toEqual(a)
      const digest = digestOf(a)
      const shard = join(attachmentRoot(stateDir), 'images', digest.slice(0, 2))
      expect(readdirSync(shard).filter((name) => name === digest)).toHaveLength(1)
    })

    it('accepts a known sessionId', async () => {
      await uploadOk(PNG_1X1, '?sessionId=s1')
    })

    it('404s an unknown sessionId and stores nothing', async () => {
      const res = await upload(PNG_1X1, '?sessionId=nope')
      expect(res.status).toBe(404)
      expect(existsSync(join(attachmentRoot(stateDir), 'images'))).toBe(false)
    })
  })

  describe('GET /attachments/images/:digest', () => {
    it('serves the stored bytes with the meta Content-Type and immutable cache', async () => {
      const ref = await uploadOk(PNG_1X1)
      const res = await content(digestOf(ref))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
      expect(res.headers.get('content-length')).toBe(String(PNG_1X1.byteLength))
      expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG_1X1))).toBe(true)
    })

    it('400s a malformed digest', async () => {
      for (const bad of ['not-a-digest', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}x`]) {
        expect((await content(bad)).status).toBe(400)
      }
    })

    it('404s a digest that was never published', async () => {
      expect((await content('a'.repeat(64))).status).toBe(404)
    })

    it('404s when the object was removed', async () => {
      const ref = await uploadOk(PNG_1X1)
      removeFile(imageObjectPathOf(attachmentRoot(stateDir), digestOf(ref)))
      expect((await content(digestOf(ref))).status).toBe(404)
    })

    it('404s when the meta sidecar was removed', async () => {
      const ref = await uploadOk(PNG_1X1)
      removeFile(imageMetaPathOf(attachmentRoot(stateDir), digestOf(ref)))
      expect((await content(digestOf(ref))).status).toBe(404)
    })

    it('500s a same-length tampered object', async () => {
      const ref = await uploadOk(PNG_1X1)
      const objectPath = imageObjectPathOf(attachmentRoot(stateDir), digestOf(ref))
      const tampered = Uint8Array.from(PNG_1X1)
      tampered[0] ^= 0xff
      chmodSync(objectPath, 0o600)
      writeFileSync(objectPath, tampered)
      expect((await content(digestOf(ref))).status).toBe(500)
    })

    it('500s a different-length tampered object', async () => {
      const ref = await uploadOk(PNG_1X1)
      const objectPath = imageObjectPathOf(attachmentRoot(stateDir), digestOf(ref))
      chmodSync(objectPath, 0o600)
      writeFileSync(objectPath, 'tampered')
      expect((await content(digestOf(ref))).status).toBe(500)
    })
  })

  describe('mount in buildApp', () => {
    it('serves upload + content under /api when a state dir is wired', async () => {
      const { app: full, sessionManager } = buildApp({
        configDir: stateDir,
        sessionStore: new SessionStore({ stateDir }),
      })
      try {
        const res = await full.request('/api/uploads/images', { method: 'POST', body: PNG_1X1 })
        expect(res.status).toBe(200)
        const { attachment } = (await res.json()) as { attachment: ImageAttachmentRef }
        const served = await full.request(`/api/attachments/images/${digestOf(attachment)}`)
        expect(served.status).toBe(200)
        expect(served.headers.get('content-type')).toBe('image/png')
      } finally {
        await sessionManager.shutdown()
      }
    })

    it('does not mount without a state dir', async () => {
      const { app: full, sessionManager } = buildApp({
        sessionStore: new SessionStore({ stateDir }),
      })
      try {
        const res = await full.request('/api/uploads/images', { method: 'POST', body: PNG_1X1 })
        expect(res.status).toBe(404)
      } finally {
        await sessionManager.shutdown()
      }
    })
  })
})
