import { describe, expect, it, vi } from 'vitest'
import { ImageNormalizeError, preparePastedImage, type ImageNormalizeDeps } from './image-normalize'

function sourcePng(width: number, height: number): ArrayBuffer {
  const buffer = new ArrayBuffer(24)
  const b = new Uint8Array(buffer)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  new DataView(buffer).setUint32(16, width)
  new DataView(buffer).setUint32(20, height)
  return buffer
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

function sourceJpeg(width: number, height: number): ArrayBuffer {
  const header = jpegHeader(width, height)
  const buffer = new ArrayBuffer(header.length)
  new Uint8Array(buffer).set(header)
  return buffer
}

function sourceGif(width: number, height: number): ArrayBuffer {
  const header = Uint8Array.from([
    ...new TextEncoder().encode('GIF89a'),
    width & 0xff, (width >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
    0, 0,
  ])
  const buffer = new ArrayBuffer(header.length)
  new Uint8Array(buffer).set(header)
  return buffer
}

function sourceWebp(width: number, height: number): ArrayBuffer {
  const header = webpHeader(width, height)
  const buffer = new ArrayBuffer(header.length)
  new Uint8Array(buffer).set(header)
  return buffer
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
}

function webpHeader(width: number, height: number): Uint8Array {
  const data = new Uint8Array(10)
  data.set([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff], 4)
  data.set([(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff], 7)
  return Uint8Array.from([
    ...new TextEncoder().encode('RIFF'),
    ...u32le(4 + 8 + 10),
    ...new TextEncoder().encode('WEBP'),
    ...new TextEncoder().encode('VP8X'),
    ...u32le(10),
    ...data,
  ])
}

function outputBlob(type: string, width: number, height: number, size: number): Blob {
  const header = type === 'image/jpeg'
    ? jpegHeader(width, height)
    : type === 'image/webp'
      ? webpHeader(width, height)
      : new Uint8Array(sourcePng(width, height))
  const out = new Uint8Array(Math.max(header.length, size))
  out.set(header)
  return new Blob([out], { type })
}

function fakeDeps(opts: {
  source: ArrayBuffer
  imageWidth: number
  imageHeight: number
  alpha?: number
  outputs: Array<{ type: string; size: number }>
  draw?: (image: unknown, dx: number, dy: number, dw: number, dh: number) => void
  outputBytes?: (type: string, width: number, height: number) => Blob
}): {
  deps: ImageNormalizeDeps
  qualities: Array<{ type: string; quality: number }>
  contexts: Array<{ imageSmoothingQuality: 'low' | 'medium' | 'high' }>
  close: ReturnType<typeof vi.fn>
} {
  const qualities: Array<{ type: string; quality: number }> = []
  const contexts: Array<{ imageSmoothingQuality: 'low' | 'medium' | 'high' }> = []
  let next = 0
  const close = vi.fn()
  return {
    qualities,
    contexts,
    close,
    deps: {
      readFile: async () => opts.source,
      loadImage: async () => ({
        image: {} as CanvasImageSource,
        width: opts.imageWidth,
        height: opts.imageHeight,
        close,
      }),
      createCanvas: (width: number, height: number) => ({
        width,
        height,
        getContext: () => {
          const ctx = {
            imageSmoothingQuality: 'low' as 'low' | 'medium' | 'high',
            drawImage: opts.draw ?? (() => {}),
            getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, opts.alpha ?? 255]) }),
          }
          contexts.push(ctx)
          return ctx
        },
        toBlob: (cb: (blob: Blob | null) => void, type?: string, quality?: number) => {
          qualities.push({ type: type ?? '', quality: quality ?? 0 })
          const spec = opts.outputs[next++] ?? opts.outputs[opts.outputs.length - 1]
          cb(opts.outputBytes?.(spec.type, width, height) ?? outputBlob(spec.type, width, height, spec.size))
        },
      }),
      // FileReader is browser-only; the test never needs the encoded string.
      toBase64: async () => 'BASE64',
    },
  }
}

describe('preparePastedImage', () => {
  it('decodes, normalizes, and returns normalized dimensions', async () => {
    const { deps, qualities, close } = fakeDeps({
      source: sourcePng(4000, 3000),
      imageWidth: 4000,
      imageHeight: 3000,
      alpha: 255,
      outputs: [{ type: 'image/jpeg', size: 1000 }],
    })
    const out = await preparePastedImage(new Blob(['source']), { maxBytes: 10_000, deps })
    expect(out.width).toBe(2364)
    expect(out.height).toBe(1773)
    expect(out.mediaType).toBe('image/jpeg')
    expect(out.original).toEqual({ mediaType: 'image/png', width: 4000, height: 3000, size: 6 })
    expect(qualities).toEqual([{ type: 'image/jpeg', quality: 0.85 }])
    expect(close).toHaveBeenCalled()
  })

  it('uses the decoded (oriented) dimensions, not the header dimensions', async () => {
    const draw = vi.fn()
    const { deps } = fakeDeps({
      source: sourcePng(4000, 3000),
      imageWidth: 3000,
      imageHeight: 4000,
      alpha: 255,
      draw,
      outputs: [{ type: 'image/jpeg', size: 1000 }],
    })
    const out = await preparePastedImage(new Blob(['source']), { maxBytes: 10_000, deps })
    expect(out.original.width).toBe(3000)
    expect(out.original.height).toBe(4000)
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 1773, 2364)
  })

  it('skips the alpha scan for a JPEG source', async () => {
    const { deps, qualities } = fakeDeps({
      source: sourceJpeg(10, 10),
      imageWidth: 10,
      imageHeight: 10,
      alpha: 0,
      outputs: [{ type: 'image/jpeg', size: 100 }],
    })
    const out = await preparePastedImage(new Blob(['source']), { maxBytes: 10_000, deps })
    expect(out.mediaType).toBe('image/jpeg')
    expect(qualities[0]?.type).toBe('image/jpeg')
  })

  it.each([
    ['GIF', sourceGif(10, 10)],
    ['WebP', sourceWebp(10, 10)],
  ])('routes a %s alpha source to WebP', async (_name, source) => {
    const { deps, qualities } = fakeDeps({
      source,
      imageWidth: 10,
      imageHeight: 10,
      alpha: 0,
      outputs: [{ type: 'image/webp', size: 100 }],
    })
    const out = await preparePastedImage(new Blob(['source']), { maxBytes: 10_000, deps })
    expect(out.mediaType).toBe('image/webp')
    expect(qualities[0]?.type).toBe('image/webp')
  })

  it('stops the ladder when the browser falls back to another codec', async () => {
    const { deps, qualities } = fakeDeps({
      source: sourcePng(10, 10),
      imageWidth: 10,
      imageHeight: 10,
      alpha: 0,
      outputs: [{ type: 'image/webp', size: 120 }],
      outputBytes: () => outputBlob('image/png', 10, 10, 120),
    })
    const out = await preparePastedImage(new Blob(['source']), { maxBytes: 100, deps })
    expect(out.mediaType).toBe('image/png')
    expect(out.size).toBe(120)
    expect(qualities).toHaveLength(1)
  })

  it('rejects a fallback output above the server per-image cap', async () => {
    const { deps } = fakeDeps({
      source: sourcePng(10, 10),
      imageWidth: 10,
      imageHeight: 10,
      alpha: 0,
      outputs: [{ type: 'image/webp', size: 10 * 1024 * 1024 + 1 }],
      outputBytes: () => outputBlob('image/png', 10, 10, 10 * 1024 * 1024 + 1),
    })
    await expect(preparePastedImage(new Blob(['source']), { maxBytes: 100, deps }))
      .rejects.toThrow(/too large/i)
  })

  it('uses high-quality image smoothing', async () => {
    const { deps, contexts } = fakeDeps({
      source: sourcePng(10, 10),
      imageWidth: 10,
      imageHeight: 10,
      alpha: 255,
      outputs: [{ type: 'image/jpeg', size: 100 }],
    })
    await preparePastedImage(new Blob(['source']), { maxBytes: 10_000, deps })
    expect(contexts[0]?.imageSmoothingQuality).toBe('high')
  })

  it('routes alpha sources to WebP and opaque PNG sources to JPEG', async () => {
    const alpha = fakeDeps({
      source: sourcePng(10, 10),
      imageWidth: 10,
      imageHeight: 10,
      alpha: 0,
      outputs: [{ type: 'image/webp', size: 100 }],
    })
    const webp = await preparePastedImage(new Blob(['source']), { maxBytes: 10_000, deps: alpha.deps })
    expect(webp.mediaType).toBe('image/webp')
    expect(alpha.qualities[0]?.type).toBe('image/webp')

    const opaque = fakeDeps({
      source: sourcePng(10, 10),
      imageWidth: 10,
      imageHeight: 10,
      alpha: 255,
      outputs: [{ type: 'image/jpeg', size: 100 }],
    })
    const jpeg = await preparePastedImage(new Blob(['source']), { maxBytes: 10_000, deps: opaque.deps })
    expect(jpeg.mediaType).toBe('image/jpeg')
    expect(opaque.qualities[0]?.type).toBe('image/jpeg')
  })

  it('walks the quality ladder and stops at the first fitting output', async () => {
    const { deps, qualities } = fakeDeps({
      source: sourcePng(10, 10),
      imageWidth: 10,
      imageHeight: 10,
      alpha: 255,
      outputs: [
        { type: 'image/jpeg', size: 120 },
        { type: 'image/jpeg', size: 80 },
        { type: 'image/jpeg', size: 50 },
      ],
    })
    const out = await preparePastedImage(new Blob(['source']), { maxBytes: 100, deps })
    expect(out.size).toBe(80)
    expect(qualities.map((q) => q.quality)).toEqual([0.85, 0.75])
  })

  it('keeps the smallest output when every quality misses', async () => {
    const { deps, qualities } = fakeDeps({
      source: sourcePng(10, 10),
      imageWidth: 10,
      imageHeight: 10,
      alpha: 255,
      outputs: [
        { type: 'image/jpeg', size: 120 },
        { type: 'image/jpeg', size: 110 },
        { type: 'image/jpeg', size: 90 },
      ],
    })
    const out = await preparePastedImage(new Blob(['source']), { maxBytes: 100, deps })
    expect(out.size).toBe(90)
    expect(qualities).toHaveLength(3)
  })

  it('refuses malformed source bytes and source pixel/side caps', async () => {
    await expect(preparePastedImage(new Blob(['source']), {
      deps: { readFile: async () => new TextEncoder().encode('not an image').buffer as ArrayBuffer },
    })).rejects.toBeInstanceOf(ImageNormalizeError)

    await expect(preparePastedImage(new Blob(['source']), {
      deps: { readFile: async () => sourcePng(10_000, 10_000) },
    })).rejects.toThrow(/pixels/)

    await expect(preparePastedImage(new Blob(['source']), {
      deps: { readFile: async () => sourcePng(70_000, 1) },
    })).rejects.toThrow(/per side/)
  })

  it('rejects an output that is not a supported image', async () => {
    const { deps } = fakeDeps({
      source: sourcePng(10, 10),
      imageWidth: 10,
      imageHeight: 10,
      alpha: 255,
      outputs: [{ type: 'image/jpeg', size: 4 }],
      outputBytes: () => new Blob(['AAAA'], { type: 'image/jpeg' }),
    })
    await expect(preparePastedImage(new Blob(['source']), { maxBytes: 10_000, deps }))
      .rejects.toBeInstanceOf(ImageNormalizeError)
  })
})