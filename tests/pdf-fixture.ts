/** Deterministic hand-built PDFs for the real-library smoke and browser E2E;
 *  no binary test assets. */

import { PDF_PREVIEW_MAX_BYTES } from '../shared/read-file'

/**
 * Two pages with distinct colored rectangles and selectable text.
 * @param userUnit - page-coordinate unit size as a multiple of 1/72 inch.
 * @param rotation - clockwise page rotation in degrees.
 * @returns complete PDF bytes; no clocks, external fonts, images, or network references.
 */
export function pdfFixture(userUnit = 1, rotation = 0): Uint8Array {
  const streams = ['0.9 0.1 0.1 rg 10 10 100 80 re f', '0.1 0.1 0.9 rg 10 10 100 80 re f'].map(
    (stream) => `${stream}\nBT /F1 8 Tf 0 0 0 rg 10 92 Td (Selectable PDF text) Tj ET`,
  )
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /UserUnit ${userUnit} /Rotate ${rotation} /MediaBox [0 0 120 100] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${streams[0]!.length} >>\nstream\n${streams[0]}\nendstream`,
    `<< /Type /Page /Parent 2 0 R /UserUnit ${userUnit} /Rotate ${rotation} /MediaBox [0 0 120 100] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`,
    `<< /Length ${streams[1]!.length} >>\nstream\n${streams[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  return pdfObjects(objects)
}

/** The text the CJK fixture draws, 中国你好 ("hello China"). */
export const CJK_FIXTURE_TEXT = '中国你好'

/**
 * One page drawing 中国你好 through a NON-EMBEDDED CID font (STSong-Light,
 * Adobe-GB1, GBK-EUC-H encoding). Decoding it requires the GBK-EUC-H bcmap and
 * the Adobe-GB1-UCS2 CID→Unicode map; drawing it requires the system-font
 * fallback — exactly the offline CJK path the inlined asset map guarantees.
 * @returns complete PDF bytes with the GBK-encoded hex string <D6D0 B9FA C4E3 BAC3>.
 */
export function cjkPdfFixture(): Uint8Array {
  const stream = 'BT /F1 24 Tf 20 50 Td <D6D0B9FAC4E3BAC3> Tj ET'
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /GBK-EUC-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>',
  ])
}

/**
 * One page whose only content is a 16×16 uncompressed RGB image XObject —
 * left half dark (tone 20), right half light (tone 220). A "scanned" page:
 * pixels to render, no text to select.
 * @returns complete PDF bytes drawing the image over (10,10)-(110,90).
 */
export function scannedPdfFixture(): Uint8Array {
  const width = 16
  const height = 16
  const pixels = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tone = x < width / 2 ? 20 : 220
      const at = (y * width + x) * 3
      pixels[at] = tone
      pixels[at + 1] = tone
      pixels[at + 2] = tone
    }
  }
  const encoder = new TextEncoder()
  const imageObject = concatBytes(
    encoder.encode(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`,
    ),
    pixels,
    encoder.encode('\nendstream'),
  )
  const stream = 'q 100 0 0 80 10 10 cm /Im1 Do Q'
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 100] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    imageObject,
  ])
}

/**
 * A structurally valid PDF padded past the preview cap: one page whose content
 * stream opens with PDF_PREVIEW_MAX_BYTES + 1 MiB of whitespace (a no-op in a
 * content stream) before a single drawing command. The capped read truncates
 * it, so the preview must refuse — never decode partial bytes.
 * @returns complete PDF bytes larger than PDF_PREVIEW_MAX_BYTES.
 */
export function oversizePdfFixture(): Uint8Array {
  const stream = `${' '.repeat(PDF_PREVIEW_MAX_BYTES + 1024 * 1024)}\n0.9 0.1 0.1 rg 10 10 100 80 re f`
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 100] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ])
}

/** Concatenate byte chunks into one buffer. */
function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** Assemble objects into a complete PDF with an explicit xref table. Objects
 *  are strings or raw byte chunks (an uncompressed image stream); offsets are
 *  byte offsets, so binary content keeps the xref exact. */
function pdfObjects(objects: readonly (string | Uint8Array)[]): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  let length = 0
  const push = (part: string | Uint8Array): void => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    parts.push(bytes)
    length += bytes.length
  }
  push('%PDF-1.7\n')
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(length)
    push(`${index + 1} 0 obj\n`)
    push(object)
    push('\nendobj\n')
  })
  const xref = length
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
  for (const offset of offsets) push(`${String(offset).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return concatBytes(...parts)
}
