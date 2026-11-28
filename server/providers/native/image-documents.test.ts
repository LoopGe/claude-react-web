// server/providers/native/image-documents.test.ts
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  PREPARED_IMAGE_MAX_BYTES,
  PreparedImageStore,
  estimateImageTokens,
  imageBase64Length,
  imageRefBlockOf,
  sniffNativeMediaKind,
  validateImageForModel,
} from './image-documents.js'
import { PdfBudgetLedger } from './pdf-documents.js'
import { neutralImageOccurrences } from './session-log/neutral-read.js'
import { brandString } from './vocabulary/brand.js'

/** Minimal header-only PNG: real signature + IHDR with the given dimensions.
 *  Good enough for the inspector, which never decodes pixels. */
function pngHeader(width: number, height: number, extraBytes = 0): Buffer {
  const head = Buffer.alloc(24 + extraBytes)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head
}

function digestOf(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}

describe('sniffNativeMediaKind', () => {
  it('identifies the four model-visible image containers by magic, not extension', () => {
    expect(sniffNativeMediaKind(pngHeader(2, 2))).toBe('image')
    expect(sniffNativeMediaKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image')
    expect(sniffNativeMediaKind(Buffer.from('GIF89a0000', 'latin1'))).toBe('image')
    expect(sniffNativeMediaKind(Buffer.from('RIFF0000WEBPVP8 ', 'latin1'))).toBe('image')
  })

  it('separates PDF, text and short heads', () => {
    expect(sniffNativeMediaKind(Buffer.from('%PDF-1.7\n', 'latin1'))).toBe('pdf')
    expect(sniffNativeMediaKind(Buffer.from('hello, world', 'utf8'))).toBe('text')
    expect(sniffNativeMediaKind(Buffer.from([0xff]))).toBe('text')
    expect(sniffNativeMediaKind(Buffer.alloc(0))).toBe('text')
  })
})

describe('validateImageForModel', () => {
  it('declares the measured container and dimensions', () => {
    expect(validateImageForModel(pngHeader(320, 200))).toEqual({
      mediaType: 'image/png',
      width: 320,
      height: 200,
    })
  })

  it('refuses over-cap dimensions with an actionable reason', () => {
    expect(() => validateImageForModel(pngHeader(IMAGE_MAX_DIMENSION + 1, 10)))
      .toThrow(/at most 8000 px per side/)
  })

  it('refuses unsupported and malformed bytes', () => {
    expect(() => validateImageForModel(Buffer.from('not an image at all', 'utf8')))
      .toThrow(/unsupported image format/)
    expect(() => validateImageForModel(pngHeader(4, 4).subarray(0, 20)))
      .toThrow(/truncated or corrupt/)
  })
})

describe('image request-media accounting', () => {
  it('converts bytes to base64 characters and prices by the vision density', () => {
    expect(imageBase64Length(3)).toBe(4)
    expect(imageBase64Length(4)).toBe(8)
    expect(estimateImageTokens(1500, 1500)).toBe(3000)
    expect(estimateImageTokens(1, 1)).toBe(1)
  })

  it('dedupes the same digest and never exceeds the shared ceiling', () => {
    const ledger = new PdfBudgetLedger()
    const digest = digestOf('dedupe')
    expect(ledger.reserveImageBudget('main', 10, digest).ok).toBe(true)
    expect(ledger.reserveImageBudget('main', 10, digest)).toMatchObject({ ok: false, reason: 'duplicate' })
    // PDF and images draw from the same per-history request ceiling.
    expect(ledger.reservePdfBudget('main', 10, digestOf('pdf')).ok).toBe(true)
    // Any size whose base64 exceeds the ceiling is refused on the main
    // partition, while a fresh sidechain partition still has room.
    // Just under the ceiling on a fresh partition, but over it once the main
    // partition already holds the PDF and image above.
    const huge = 20_999_991
    expect(ledger.reserveImageBudget('main', huge, digestOf('huge'))).toMatchObject({ ok: false, reason: 'exhausted' })
    expect(ledger.reserveImageBudget('agent-1', huge, digestOf('huge')).ok).toBe(true)
  })
})

describe('PreparedImageStore', () => {
  const meta = { mediaType: 'image/png' as const, width: 4, height: 4 }

  it('holds one verified image per tool_use and consumes it exactly once', () => {
    const ledger = new PdfBudgetLedger()
    const store = new PreparedImageStore(ledger)
    const attempt = ledger.reserveImageBudget('main', 10, digestOf('img'))
    if (!attempt.ok) throw new Error('expected reservation')
    const reservation = store.reserve('t1', imageRefBlockOf(digestOf('img'), { ...meta, bytes: 10 }).attachment, attempt.reservation)
    store.complete(reservation, { type: 'image', source: { type: 'base64', data: 'AAAAAAAAAAAAAA==', media_type: 'image/png' } })
    expect(() => store.consume('t1', imageRefBlockOf(digestOf('img'), { ...meta, bytes: 10 }).attachment))
      .toThrow(/not ready/)
    store.confirmPersisted('t1')
    const block = store.consume('t1', imageRefBlockOf(digestOf('img'), { ...meta, bytes: 10 }).attachment)
    expect(block?.source.data).toBe('AAAAAAAAAAAAAA==')
    expect(store.consume('t1', imageRefBlockOf(digestOf('img'), { ...meta, bytes: 10 }).attachment)).toBeUndefined()
  })

  it('refuses a base64 payload that does not match the declared byte length', () => {
    const ledger = new PdfBudgetLedger()
    const store = new PreparedImageStore(ledger)
    // 4 bytes encode to 8 base64 characters; a 4-character payload is short.
    const attempt = ledger.reserveImageBudget('main', 4, digestOf('img2'))
    if (!attempt.ok) throw new Error('expected reservation')
    const reservation = store.reserve('t2', imageRefBlockOf(digestOf('img2'), { ...meta, bytes: 4 }).attachment, attempt.reservation)
    expect(() => store.complete(reservation, { type: 'image', source: { type: 'base64', data: 'AA==', media_type: 'image/png' } }))
      .toThrow(/length mismatch/)
  })

  it('bounds the session-wide prepared raw bytes', () => {
    const ledger = new PdfBudgetLedger()
    const store = new PreparedImageStore(ledger)
    const attempt = ledger.reserveImageBudget('main', 1, digestOf('small'))
    if (!attempt.ok) throw new Error('expected reservation')
    // The request ledger's ceiling is larger than the store's session cap;
    // reserve directly to pin the store's own bound.
    expect(() => store.reserve(
      't3',
      imageRefBlockOf(digestOf('big'), { ...meta, bytes: PREPARED_IMAGE_MAX_BYTES + 1 }).attachment,
      attempt.reservation,
    )).toThrow(/session budget exceeded/)
  })

  it('counts a single image at exactly the API per-image byte cap', () => {
    expect(IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024)
  })
})

describe('image occurrences in the neutral log', () => {
  const ref = imageRefBlockOf(digestOf('persisted'), { mediaType: 'image/png', width: 8, height: 8, bytes: 40 })
  const userEvent = (seq: number, parentToolUseId: string | null, content: unknown[]) => ({
    seq,
    type: 'user/message',
    time: 1,
    parentToolUseId,
    data: {
      role: 'user',
      id: brandString<'MessageId'>(`m${seq}`),
      content,
      source: { kind: 'user' },
    },
  })

  it('scans direct and tool_result image refs, ignoring legacy inline base64', () => {
    const events = [
      userEvent(0, null, [ref, { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } }]),
      {
        seq: 1,
        type: 'tool/result',
        time: 1,
        parentToolUseId: 'read-1',
        data: {
          message: {
            role: 'tool',
            id: brandString<'MessageId'>('t1'),
            toolCallId: brandString<'ToolCallId'>('read-1'),
            content: [{ type: 'text', text: 'Image: a.png' }, ref],
          },
        },
      },
    ]
    const occurrences = neutralImageOccurrences(events as never)
    expect(occurrences).toHaveLength(2)
    expect(occurrences[0]).toMatchObject({ messageUuid: 'm0', parentToolUseId: null, blockPath: [0] })
    expect(occurrences[1]).toMatchObject({ messageUuid: 't1', parentToolUseId: 'read-1', blockPath: [0, 1] })
    expect(occurrences[0].attachment.id).toBe(`sha256:${digestOf('persisted')}`)
  })

  it('rebuilds request-media accounting from the post-compact floor', () => {
    const digest = digestOf('persisted')
    const events = [
      userEvent(0, null, [ref]),
      { seq: 1, type: 'session/compact', time: 1, data: { text: 'summary', context: 'context', uuid: 'c', timestamp: '2026-11-28T00:00:00.000Z' } },
      userEvent(2, 'agent-1', [ref]),
    ]
    const ledger = new PdfBudgetLedger()
    ledger.rebuildFromEvents(events as never)
    // The pre-compact occurrence fell below the floor; the sidechain one holds.
    expect(ledger.reserveImageBudget('main', 40, digest)).toMatchObject({ ok: true })
    expect(ledger.reserveImageBudget('agent-1', 40, digest)).toMatchObject({ ok: false, reason: 'duplicate' })
  })
})
