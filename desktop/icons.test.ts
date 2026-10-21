import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The generated icon binaries are committed (desktop/build/*, public/*). This
// suite pins the two failure modes that already happened once in this repo:
//
//  1. A text-SVG placeholder masquerading as a .png — the old
//     public/icon-192.png was literally an <svg> document named .png. sw.js
//     loads it as a notification image, where the wrong body under an
//     image/png Content-Type silently fails to render.
//  2. No electron-builder icon at all — with desktop/build/ absent the
//     packaged exe/installer fall back to the default Electron atom icon.
//
// desktop/*.test.ts runs under vitest (see the include entry in
// vitest.config.ts) but is deliberately outside every tsc project, same as
// plugins/**/*.test.ts.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

const read = (p: string) => readFile(join(root, p))

/** PNG IHDR dimensions: 8-byte signature + 4-byte length + 'IHDR' + W/H as BE u32. */
function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

describe('generated app icons', () => {
  it('public/icon-192.png is a real 192x192 PNG (not an SVG in disguise)', async () => {
    const buf = await read('public/icon-192.png')
    expect([...buf.subarray(0, 4)]).toEqual(PNG_MAGIC)
    expect(pngSize(buf)).toEqual({ w: 192, h: 192 })
  })

  it('desktop/build/icon.png is a real 512x512 PNG (Linux)', async () => {
    const buf = await read('desktop/build/icon.png')
    expect([...buf.subarray(0, 4)]).toEqual(PNG_MAGIC)
    expect(pngSize(buf)).toEqual({ w: 512, h: 512 })
  })

  it('desktop/build/icon.ico is a real multi-size ICO (Windows exe/installer)', async () => {
    const buf = await read('desktop/build/icon.ico')
    // ICO header: reserved u16 = 0, type u16 = 1, image-count u16.
    expect(buf.readUInt16LE(0)).toBe(0)
    expect(buf.readUInt16LE(2)).toBe(1)
    expect(buf.readUInt16LE(4)).toBeGreaterThanOrEqual(4)
  })

  it('desktop/build/icon.icns is a real ICNS container (macOS)', async () => {
    const buf = await read('desktop/build/icon.icns')
    expect(buf.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(buf.readUInt32BE(4)).toBe(buf.length)
  })

  it('desktop/build/icon.svg is the C1-A master (accent bg, no text glyph)', async () => {
    const svg = (await read('desktop/build/icon.svg')).toString('utf8')
    expect(svg.toLowerCase()).toContain('#7b8cde')
    expect(svg).not.toMatch(/<text/i)
  })

  it('public/favicon.svg exists for the browser tab', async () => {
    const svg = (await read('public/favicon.svg')).toString('utf8')
    expect(svg).toContain('<svg')
  })
})
