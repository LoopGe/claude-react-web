// Icon generator — renders every shipped app-icon size from the master SVG
// (desktop/build/icon.svg, the C1-A artwork) and writes the binaries that the
// packaged app and the web client consume. Run via `npm run build:icons`.
//
// Outputs (all committed to git, so neither CI nor a fresh checkout needs to
// re-run this to package):
//   desktop/build/icon.ico   Windows — picked up automatically by
//                            electron-builder (exe / NSIS installer / taskbar);
//                            buildResources already points at desktop/build/
//   desktop/build/icon.icns  macOS
//   desktop/build/icon.png   Linux (512)
//   public/favicon.svg       browser tab (vector)
//   public/icon-192.png      notification icon referenced by public/sw.js
//                            (replaces the old SVG-masquerading-as-.png
//                            placeholder, which could never render)
//
// desktop/icons.test.ts pins the outputs' magic bytes, so a placeholder or a
// missed generation turns the suite red instead of shipping.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MASTER = join(root, 'desktop', 'build', 'icon.svg')
const MASTER_SIZE = 512

// Windows ICO: classic small sizes + Vista+ PNG-compressed large entries.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
// macOS ICNS: non-retina ladders; macOS picks what it needs.
const ICNS_SIZES = [
  [16, 'icp4'],
  [32, 'icp5'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
]

/** Rasterize the master SVG natively at `size` px. */
async function renderPng(masterSvg, size) {
  // librsvg scales the SVG's intrinsic 512px box by density/72, so
  // density 72·n/512 rasterizes directly at n px — crisper for the tiny sizes
  // than downscaling a 512 render.
  return sharp(masterSvg, { density: (72 * size) / MASTER_SIZE })
    .png()
    .toBuffer()
}

/**
 * Encode an ICNS container: 'icns' + BE u32 total length, then a tagged chunk
 * (type + BE u32 length + PNG data) per size. PNG payloads are valid for these
 * chunk types on every macOS version that still runs Electron 33.
 */
function encodeIcns(entries) {
  const chunks = entries.map(([type, data]) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([head, data])
  })
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0)
  const out = Buffer.alloc(8)
  out.write('icns', 0, 'ascii')
  out.writeUInt32BE(total, 4)
  return Buffer.concat([out, ...chunks])
}

async function writeIfChanged(file, data) {
  const prev = await readFile(file).catch(() => null)
  if (prev && Buffer.compare(prev, data) === 0) {
    console.log(`[icons] unchanged  ${file}`)
    return
  }
  await writeFile(file, data)
  console.log(`[icons] wrote      ${file}  (${(data.length / 1024).toFixed(1)} kB)`)
}

const masterSvg = await readFile(MASTER)
const png = new Map()
const allSizes = new Set([...ICO_SIZES, ...ICNS_SIZES.map(([s]) => s), 192])
for (const size of allSizes) {
  png.set(size, await renderPng(masterSvg, size))
}

await writeIfChanged(
  join(root, 'desktop', 'build', 'icon.ico'),
  await pngToIco(ICO_SIZES.map((s) => png.get(s))),
)
await writeIfChanged(
  join(root, 'desktop', 'build', 'icon.icns'),
  encodeIcns(ICNS_SIZES.map(([s, type]) => [type, png.get(s)])),
)
await writeIfChanged(join(root, 'desktop', 'build', 'icon.png'), png.get(512))
await writeIfChanged(join(root, 'public', 'icon-192.png'), png.get(192))
await writeIfChanged(join(root, 'public', 'favicon.svg'), masterSvg)
