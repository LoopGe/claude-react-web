import { describe, expect, it } from 'vitest'
import { validateSendBody, MAX_MESSAGE_BASE64 } from './send-body.js'
import { MAX_PASTED_IMAGE_BYTES } from './config.js'
import { MAX_IMAGE_BYTES } from '../shared/upload-limits.js'
import type { ImageAttachmentRef } from '../shared/image-attachment.js'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Minimal PNG header: signature, IHDR length/type, width and height. The
 *  inspector reads only these fields, so no CRC or pixel data is needed. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

describe('image size caps', () => {
  it('keeps the largest accepted raw image batch representable in base64', () => {
    // The client caps raw file bytes; the wire carries base64. Per-image
    // padding can only make the real payload larger, so this is a
    // lower-bound guard against the two caps drifting apart.
    expect(Math.ceil(MAX_PASTED_IMAGE_BYTES / 3) * 4).toBeLessThanOrEqual(MAX_MESSAGE_BASE64)
  })
})

describe('validateSendBody', () => {
  it('accepts a non-empty text body', () => {
    const v = validateSendBody({ text: 'hello' })
    expect(v).toEqual({ ok: true, body: { text: 'hello' } })
  })

  it('trims and rejects whitespace-only text', () => {
    const v = validateSendBody({ text: '   ' })
    expect(v).toEqual({ ok: false, status: 400, error: 'text is required' })
  })

  it('rejects missing text', () => {
    expect(validateSendBody({})).toEqual({ ok: false, status: 400, error: 'text is required' })
  })

  it('accepts text + image content blocks', () => {
    const content = [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', data: PNG_1X1, media_type: 'image/png' } },
    ]
    const v = validateSendBody({ content })
    expect(v).toEqual({ ok: true, body: { content } })
  })

  it('rejects an image block missing its base64 source', () => {
    const v = validateSendBody({ content: [{ type: 'image', source: { type: 'url', url: 'x' } }] })
    expect(v).toEqual({ ok: false, status: 400, error: 'invalid image block: missing base64 source' })
  })

  it('rejects an unsupported media type', () => {
    const v = validateSendBody({ content: [{ type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/tiff' } }] })
    expect(v).toEqual({ ok: false, status: 400, error: 'unsupported image type: image/tiff' })
  })

  it('accepts a file block', () => {
    const content = [{ type: 'file', attachment: { id: 'u1', name: 'a.pdf', size: 3 } }]
    expect(validateSendBody({ content })).toEqual({ ok: true, body: { content } })
  })

  it('rejects a malformed file block', () => {
    expect(validateSendBody({ content: [{ type: 'file', attachment: { id: '', name: 'a', size: 1 } }] }))
      .toEqual({ ok: false, status: 400, error: 'invalid file block' })
  })

  it('rejects more than 20 file blocks', () => {
    const content = Array.from({ length: 21 }, (_, i) => ({
      type: 'file',
      attachment: { id: `u${i}`, name: 'a.pdf', size: 1 },
    }))
    expect(validateSendBody({ content }))
      .toEqual({ ok: false, status: 400, error: 'at most 20 file attachments per message' })
  })

  it('rejects an unsupported block type', () => {
    const v = validateSendBody({ content: [{ type: 'video' }] })
    expect(v).toEqual({ ok: false, status: 400, error: 'unsupported content block type: video' })
  })

  it('rejects a >28MB base64 payload', () => {
    const v = validateSendBody({ content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(28_000_001), media_type: 'image/png' } }] })
    expect(v).toEqual({ ok: false, status: 413, error: 'total image payload too large' })
  })

  it('rejects more than 20 images in one message', () => {
    const content = Array.from({ length: 21 }, () => ({
      type: 'image',
      source: { type: 'base64', data: 'AAAA', media_type: 'image/png' },
    }))
    expect(validateSendBody({ content })).toEqual({
      ok: false,
      status: 400,
      error: 'at most 20 images per message',
    })
  })

  it('rejects one image above the per-image byte limit', () => {
    const data = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')
    expect(validateSendBody({
      content: [{ type: 'image', source: { type: 'base64', data, media_type: 'image/png' } }],
    })).toEqual({
      ok: false,
      status: 413,
      error: 'image #1 exceeds 10485760 bytes',
    })
  })

  it('rejects bytes that do not match the declared image type', () => {
    const content = [{ type: 'image', source: { type: 'base64', data: PNG_1X1, media_type: 'image/jpeg' } }]
    expect(validateSendBody({ content })).toEqual({
      ok: false,
      status: 400,
      error: 'image #1 bytes do not match declared type image/jpeg',
    })
  })

  it('rejects non-image bytes declared as an image', () => {
    const content = [{ type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } }]
    expect(validateSendBody({ content })).toEqual({
      ok: false,
      status: 400,
      error: 'image #1 is not a valid PNG, JPEG, GIF, or WebP image',
    })
  })

  it('rejects an image above the decoded-pixel limit', () => {
    const data = Buffer.from(pngHeader(10_000, 10_000)).toString('base64')
    const content = [{ type: 'image', source: { type: 'base64', data, media_type: 'image/png' } }]
    expect(validateSendBody({ content })).toEqual({
      ok: false,
      status: 400,
      error: 'image #1 exceeds 64000000 pixels',
    })
  })

  it('rejects an image above the per-side pixel limit', () => {
    const data = Buffer.from(pngHeader(70_000, 1)).toString('base64')
    const content = [{ type: 'image', source: { type: 'base64', data, media_type: 'image/png' } }]
    expect(validateSendBody({ content })).toEqual({
      ok: false,
      status: 400,
      error: 'image #1 exceeds 65535 pixels per side',
    })
  })
})

describe('validateSendBody clientOperationId (spec §8.3)', () => {
  it('passes through a valid clientOperationId on a text body', () => {
    const v = validateSendBody({ text: 'hi', clientOperationId: 'op-1' })
    expect(v).toEqual({ ok: true, body: { text: 'hi' }, clientOperationId: 'op-1' })
  })

  it('passes through a valid clientOperationId on a content body', () => {
    const v = validateSendBody({ content: [{ type: 'text', text: 'hi' }], clientOperationId: 'op-2' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.clientOperationId).toBe('op-2')
  })

  it('omits an absent, non-string, empty, or over-long clientOperationId', () => {
    for (const raw of [{}, { clientOperationId: 5 }, { clientOperationId: '' }, { clientOperationId: 'x'.repeat(129) }]) {
      const v = validateSendBody({ text: 'hi', ...raw })
      expect(v.ok).toBe(true)
      if (v.ok) expect(v.clientOperationId).toBeUndefined()
    }
  })
})

describe('validateSendBody image reference blocks (Task 4)', () => {
  const REF: ImageAttachmentRef = {
    id: `sha256:${'0123456789abcdef'.repeat(4)}`,
    mediaType: 'image/png',
    bytes: 68,
    width: 1,
    height: 1,
  }
  const refBlock = { type: 'image', attachment: REF }

  it('admits text + image ref blocks', () => {
    const content = [{ type: 'text', text: 'look' }, refBlock]
    expect(validateSendBody({ content })).toEqual({ ok: true, body: { content } })
  })

  it('admits an image-ref-only body', () => {
    const content = [refBlock]
    expect(validateSendBody({ content })).toEqual({ ok: true, body: { content } })
  })

  it('admits a mixed legacy base64 + ref batch', () => {
    const content = [
      refBlock,
      { type: 'image', source: { type: 'base64', data: PNG_1X1, media_type: 'image/png' } },
    ]
    expect(validateSendBody({ content })).toEqual({ ok: true, body: { content } })
  })

  it.each([
    { ...REF, id: 'sha256:xyz' },
    { ...REF, id: '0123456789abcdef'.repeat(4) },
    { ...REF, id: `sha256:${'0'.repeat(63)}` },
    { ...REF, id: `sha256:${'A'.repeat(64)}` },
    { ...REF, mediaType: 'image/tiff' },
    { ...REF, bytes: -1 },
    { ...REF, bytes: Number.NaN },
    { ...REF, width: 0 },
    { ...REF, height: 1.5 },
  ])('rejects a malformed ref %j', (attachment) => {
    expect(validateSendBody({ content: [{ type: 'image', attachment }] }))
      .toEqual({ ok: false, status: 400, error: 'invalid image reference block' })
  })

  it('rejects a non-object attachment', () => {
    for (const attachment of [null, 'x', 5, []]) {
      expect(validateSendBody({ content: [{ type: 'image', attachment }] }))
        .toEqual({ ok: false, status: 400, error: 'invalid image reference block' })
    }
  })

  it('counts refs and legacy images toward one shared image cap', () => {
    const legacy = { type: 'image', source: { type: 'base64', data: PNG_1X1, media_type: 'image/png' } }
    const content = [...Array.from({ length: 20 }, () => refBlock), legacy]
    expect(validateSendBody({ content }))
      .toEqual({ ok: false, status: 400, error: 'at most 20 images per message' })
    expect(validateSendBody({ content: Array.from({ length: 21 }, () => refBlock) }))
      .toEqual({ ok: false, status: 400, error: 'at most 20 images per message' })
  })

  it('rejects a ref whose declared bytes exceed the per-image limit', () => {
    const content = [{ type: 'image', attachment: { ...REF, bytes: MAX_IMAGE_BYTES + 1 } }]
    expect(validateSendBody({ content }))
      .toEqual({ ok: false, status: 413, error: 'image #1 exceeds 10485760 bytes' })
  })

  it('does not count ref bytes toward the base64 transport cap', () => {
    // 20 refs × 2 MB of stored bytes = 40 MB > MAX_MESSAGE_BASE64, but the
    // body carries no base64 at all — the cap only bounds inline payloads.
    const content = Array.from({ length: 20 }, () => ({
      type: 'image',
      attachment: { ...REF, bytes: 2_000_000 },
    }))
    expect(validateSendBody({ content })).toEqual({ ok: true, body: { content } })
  })

  it('keeps the legacy missing-source rejection for blocks without an attachment', () => {
    expect(validateSendBody({ content: [{ type: 'image' }] }))
      .toEqual({ ok: false, status: 400, error: 'invalid image block: missing base64 source' })
  })
})
