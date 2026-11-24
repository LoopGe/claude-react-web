import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPdfBinaryDataFactory, type PdfAssetMap } from './pdf-assets'

// Small synthetic map: the factory contract is about lookup/decoding, not the
// real multi-MB asset payload (the last test exercises the real default map).
const assets: PdfAssetMap = {
  cMapUrl: { 'UniGB-UCS2-H.bcmap': btoa('cmap bytes') },
  standardFontDataUrl: { 'FoxitFixed.pfb': btoa('font bytes') },
  wasmUrl: { 'jbig2.wasm': btoa('wasm bytes') },
}

const bytesOf = (text: string) => new TextEncoder().encode(text)

describe('createPdfBinaryDataFactory', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves exact filenames for every asset kind', async () => {
    const Factory = createPdfBinaryDataFactory(assets)
    const factory = new Factory()
    await expect(factory.fetch({ kind: 'cMapUrl', filename: 'UniGB-UCS2-H.bcmap' })).resolves.toEqual(
      bytesOf('cmap bytes'),
    )
    await expect(factory.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitFixed.pfb' })).resolves.toEqual(
      bytesOf('font bytes'),
    )
    await expect(factory.fetch({ kind: 'wasmUrl', filename: 'jbig2.wasm' })).resolves.toEqual(
      bytesOf('wasm bytes'),
    )
  })

  it('rejects prototype keys (exact-name Object.hasOwn lookup)', async () => {
    const factory = new (createPdfBinaryDataFactory(assets))()
    for (const filename of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      await expect(factory.fetch({ kind: 'cMapUrl', filename })).rejects.toThrow(
        `PDF.js asset is not bundled: cMapUrl/${filename}`,
      )
    }
  })

  it('rejects path-shaped names', async () => {
    const factory = new (createPdfBinaryDataFactory(assets))()
    for (const filename of [
      '../UniGB-UCS2-H.bcmap',
      './UniGB-UCS2-H.bcmap',
      'cmaps/UniGB-UCS2-H.bcmap',
      'UniGB-UCS2-H.bcmap/../jbig2.wasm',
    ]) {
      await expect(factory.fetch({ kind: 'cMapUrl', filename })).rejects.toThrow(
        'PDF.js asset is not bundled',
      )
    }
  })

  it('returns a fresh transferable buffer per call', async () => {
    const factory = new (createPdfBinaryDataFactory(assets))()
    const request = { kind: 'cMapUrl', filename: 'UniGB-UCS2-H.bcmap' } as const
    const first = await factory.fetch(request)
    const second = await factory.fetch(request)
    expect(first).not.toBe(second)
    expect(first.buffer).not.toBe(second.buffer)
    expect(first).toEqual(second)
    // pdf.js may transfer the buffer away to the worker; a later fetch must
    // still decode the full asset from the map.
    structuredClone(first.buffer, { transfer: [first.buffer] })
    expect(first.byteLength).toBe(0)
    await expect(factory.fetch(request)).resolves.toEqual(bytesOf('cmap bytes'))
  })

  it('throws loudly on an unbundled name and never falls back to fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const factory = new (createPdfBinaryDataFactory(assets))()
    await expect(factory.fetch({ kind: 'wasmUrl', filename: 'missing.wasm' })).rejects.toThrow(
      'PDF.js asset is not bundled: wasmUrl/missing.wasm',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('serves the build-inlined default assets from virtual:pdfjs-assets', async () => {
    const factory = new (createPdfBinaryDataFactory())()
    const bytes = await factory.fetch({ kind: 'cMapUrl', filename: 'UniGB-UCS2-H.bcmap' })
    expect(bytes.byteLength).toBeGreaterThan(0)
  })
})
