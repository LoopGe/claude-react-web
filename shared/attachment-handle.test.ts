import { describe, expect, it } from 'vitest'
import { stripHandles } from './attachment-handle'
import { fileHandleText, stripFileHandles } from './upload-handle'
import { imageHandleText } from './image-handle'
import type { ImageAttachmentRef } from './image-attachment'

const FILE_HANDLE = fileHandleText(
  { id: '8f1c2d34-0000-4000-8000-000000000001', name: 'report.pdf', size: 523001, digest: '4a7d1234abcdef' },
  '/tmp/uploads/report.pdf',
)

const DIGEST = '0123456789abcdef'.repeat(4)
const IMAGE_REF: ImageAttachmentRef = {
  id: `sha256:${DIGEST}`,
  mediaType: 'image/webp',
  bytes: 234567,
  width: 1024,
  height: 768,
}
const IMAGE_HANDLE = imageHandleText(IMAGE_REF, `/state/claude-web-attachments/v1/images/01/${DIGEST}`)

describe('stripHandles', () => {
  it('strips a file handle', () => {
    expect(stripHandles(`look ${FILE_HANDLE}`)).toBe('look')
  })

  it('strips an image handle', () => {
    expect(stripHandles(`look ${IMAGE_HANDLE}`)).toBe('look')
  })

  it('strips both kinds mixed in one text', () => {
    expect(stripHandles(`look ${FILE_HANDLE}${IMAGE_HANDLE}`)).toBe('look')
    expect(stripHandles(`${FILE_HANDLE} ${IMAGE_HANDLE} after`)).toBe('after')
  })

  it('condenses a handle-only prompt to empty', () => {
    expect(stripHandles(FILE_HANDLE)).toBe('')
    expect(stripHandles(IMAGE_HANDLE)).toBe('')
    expect(stripHandles(`  ${FILE_HANDLE} ${IMAGE_HANDLE}  `)).toBe('')
  })

  it('leaves plain text intact (trimmed)', () => {
    expect(stripHandles('  just text  ')).toBe('just text')
    expect(stripHandles('see [Image attached] and [File "x" notes] below')).toBe(
      'see [Image attached] and [File "x" notes] below',
    )
  })

  it('strips multiple handles of both kinds', () => {
    const otherFile = fileHandleText({ id: 'u2', name: 'b.pdf', size: 3 }, '/tmp/b.pdf')
    const otherImage = imageHandleText({ ...IMAGE_REF, id: `sha256:${'f'.repeat(64)}` }, '/state/other')
    expect(stripHandles(`${FILE_HANDLE} ${otherFile} ${IMAGE_HANDLE} ${otherImage} after`)).toBe('after')
  })

  it('never throws on malformed handles and leaves them as raw text', () => {
    for (const text of [
      '[File ',
      '[File "x" (',
      '[Image ',
      '[Image "',
      '[Image "x" (1x1, image/png, 1 bytes, sha256:zz, attachment:sha256:zz): normalized read-only copy saved at "unterminated',
      `${FILE_HANDLE.slice(0, 40)} ${IMAGE_HANDLE.slice(0, 40)}`,
    ]) {
      expect(() => stripHandles(text)).not.toThrow()
      expect(stripHandles(text)).toBe(text.trim())
    }
  })

  it('never throws on truncated input', () => {
    const text = `${FILE_HANDLE} ${IMAGE_HANDLE}`
    for (let end = 0; end < text.length; end += 7) {
      expect(() => stripHandles(text.slice(0, end))).not.toThrow()
    }
  })

  // Legacy parity: with no image handle present the combined helper must be
  // byte-identical to stripFileHandles, including the terminator-in-filename
  // case the file parser handles specially.
  it('matches stripFileHandles byte-for-byte when no image handle is present', () => {
    const tricky = fileHandleText(
      { id: 'u1', name: 'quarterly read it.] report.pdf', size: 42 },
      '/tmp/quarterly.pdf',
    )
    for (const text of [
      '',
      '  plain  ',
      `look ${FILE_HANDLE}`,
      `${FILE_HANDLE} ${FILE_HANDLE}`,
      `before${tricky}after`,
      '[File "x" is not a handle]',
    ]) {
      expect(stripHandles(text)).toBe(stripFileHandles(text))
    }
  })
})
