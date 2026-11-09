import { describe, expect, it } from 'vitest'
import { inspectImageBytes } from './image-inspect'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function u16le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff]
}

function u24le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >>> 16) & 0xff]
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
}

function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8) // length 13, 'IHDR'
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

function gifHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...new TextEncoder().encode('GIF89a'),
    ...u16le(width),
    ...u16le(height),
    0,
    0,
  ])
}

function jpegHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0),
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ])
}

function webpVp8x(width: number, height: number): Uint8Array {
  const data = new Uint8Array(10)
  data.set(u24le(width - 1), 4)
  data.set(u24le(height - 1), 7)
  return Uint8Array.from([
    ...new TextEncoder().encode('RIFF'),
    ...u32le(4 + 8 + 10),
    ...new TextEncoder().encode('WEBP'),
    ...new TextEncoder().encode('VP8X'),
    ...u32le(10),
    ...data,
  ])
}

function webpVp8l(width: number, height: number): Uint8Array {
  const packed = (((height - 1) << 14) | (width - 1)) >>> 0
  const data = new Uint8Array(5)
  data[0] = 0x2f
  data.set(u32le(packed), 1)
  return Uint8Array.from([
    ...new TextEncoder().encode('RIFF'),
    ...u32le(4 + 8 + 5),
    ...new TextEncoder().encode('WEBP'),
    ...new TextEncoder().encode('VP8L'),
    ...u32le(5),
    ...data,
  ])
}

function webpVp8(width: number, height: number): Uint8Array {
  const data = new Uint8Array(10)
  data[3] = 0x9d
  data[4] = 0x01
  data[5] = 0x2a
  data.set(u16le(width & 0x3fff), 6)
  data.set(u16le(height & 0x3fff), 8)
  return Uint8Array.from([
    ...new TextEncoder().encode('RIFF'),
    ...u32le(4 + 8 + 10),
    ...new TextEncoder().encode('WEBP'),
    ...new TextEncoder().encode('VP8 '),
    ...u32le(10),
    ...data,
  ])
}

describe('inspectImageBytes', () => {
  it('reads a real 1x1 PNG', () => {
    expect(inspectImageBytes(Uint8Array.from(Buffer.from(PNG_1X1, 'base64')))).toEqual({
      ok: true,
      image: { mediaType: 'image/png', width: 1, height: 1 },
    })
  })

  it('reads PNG dimensions from the IHDR header', () => {
    expect(inspectImageBytes(pngHeader(2, 3))).toEqual({
      ok: true,
      image: { mediaType: 'image/png', width: 2, height: 3 },
    })
  })

  it('reads GIF dimensions', () => {
    expect(inspectImageBytes(gifHeader(7, 9))).toEqual({
      ok: true,
      image: { mediaType: 'image/gif', width: 7, height: 9 },
    })
  })

  it('reads JPEG dimensions from the SOF header', () => {
    expect(inspectImageBytes(jpegHeader(11, 13))).toEqual({
      ok: true,
      image: { mediaType: 'image/jpeg', width: 11, height: 13 },
    })
  })

  it('reads WebP VP8X dimensions', () => {
    expect(inspectImageBytes(webpVp8x(15, 17))).toEqual({
      ok: true,
      image: { mediaType: 'image/webp', width: 15, height: 17 },
    })
  })

  it('reads WebP VP8L dimensions', () => {
    expect(inspectImageBytes(webpVp8l(19, 21))).toEqual({
      ok: true,
      image: { mediaType: 'image/webp', width: 19, height: 21 },
    })
  })

  it('reads WebP lossy VP8 dimensions', () => {
    expect(inspectImageBytes(webpVp8(23, 25))).toEqual({
      ok: true,
      image: { mediaType: 'image/webp', width: 23, height: 25 },
    })
  })

  it('rejects unknown bytes as unsupported', () => {
    expect(inspectImageBytes(new TextEncoder().encode('not an image'))).toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })

  it('rejects a truncated PNG header as malformed', () => {
    expect(inspectImageBytes(pngHeader(2, 3).slice(0, 16))).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('rejects a zero dimension as malformed', () => {
    expect(inspectImageBytes(pngHeader(0, 1))).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('rejects a truncated JPEG before SOF as malformed', () => {
    expect(inspectImageBytes(jpegHeader(11, 13).slice(0, 20))).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })
})