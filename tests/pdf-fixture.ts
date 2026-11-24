/** Deterministic hand-built PDFs for the real-library smoke; no binary test assets. */

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

/** Assemble objects into a complete PDF with an explicit xref table. */
function pdfObjects(objects: readonly string[]): Uint8Array {
  let text = '%PDF-1.7\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(text.length)
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(text)
}
