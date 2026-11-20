import { describe, expect, it } from 'vitest'
import { imageHandleText, parseImageHandle } from './image-handle'
import type { ImageAttachmentRef } from './image-attachment'

const DIGEST = '0123456789abcdef'.repeat(4)

const REF: ImageAttachmentRef = {
  id: `sha256:${DIGEST}`,
  mediaType: 'image/webp',
  bytes: 234567,
  width: 1024,
  height: 768,
}

const PATH = '/state/claude-web-attachments/v1/images/01/0123456789abcdef'

/** The pinned grammar. The quoted label is cosmetic (the ref has no name);
 *  the parenthetical carries every recoverable field, with the FULL digest
 *  in both identity slots. */
const EXPECTED_TEXT =
  `[Image "image.webp" (1024x768, image/webp, 234567 bytes, sha256:${DIGEST}, attachment:sha256:${DIGEST}): ` +
  `normalized read-only copy saved at ${JSON.stringify(PATH)}. Read that path with your file tools when its contents ` +
  'are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path ' +
  'in the delegation prompt; only subagents sharing this execution environment can read it.]'

describe('imageHandleText', () => {
  it('pins the handle grammar', () => {
    expect(imageHandleText(REF, PATH)).toBe(EXPECTED_TEXT)
  })

  it('is deterministic for the same ref and path', () => {
    expect(imageHandleText(REF, PATH)).toBe(imageHandleText(REF, PATH))
  })

  it('carries the full 64-hex digest, never a truncation', () => {
    const text = imageHandleText(REF, PATH)
    expect(text).toContain(`sha256:${DIGEST}`)
    expect(text).toContain(`attachment:sha256:${DIGEST}`)
    expect(text).not.toContain(`sha256:${DIGEST.slice(0, 8)},`)
  })
})

describe('parseImageHandle', () => {
  it('round-trips every ref field and the path (binding invariant)', () => {
    expect(parseImageHandle(imageHandleText(REF, PATH))).toEqual({ attachment: REF, path: PATH })
  })

  it.each([
    'C:\\state\\claude-web-attachments\\v1\\images\\01\\digest',
    '/tmp/with "quotes" inside.png',
    '/tmp/with \\backslash and "quote".png',
    '/tmp/unicode-画像-🖼.png',
    '/tmp/paren (and) brackets [ok].png',
    // The suffix marker inside the JSON path string must not end the parse
    // early: readQuoted finds the real closing quote first.
    '/tmp/trap. Read that path with your file tools.png',
    '',
  ])('round-trips path %j', (path) => {
    expect(parseImageHandle(imageHandleText(REF, path))).toEqual({ attachment: REF, path })
  })

  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const)(
    'round-trips media type %s',
    (mediaType) => {
      const ref: ImageAttachmentRef = { ...REF, mediaType }
      expect(parseImageHandle(imageHandleText(ref, PATH))).toEqual({ attachment: ref, path: PATH })
    },
  )

  it('recovers the id untruncated (the digest IS the identity)', () => {
    const parsed = parseImageHandle(imageHandleText(REF, PATH))
    expect(parsed?.attachment.id).toBe(REF.id)
    expect(parsed?.attachment.id).toHaveLength('sha256:'.length + 64)
  })

  it('treats the quoted label as cosmetic, not data', () => {
    const text = imageHandleText(REF, PATH).replace('"image.webp"', '"screenshot.webp"')
    expect(parseImageHandle(text)).toEqual({ attachment: REF, path: PATH })
  })

  it('returns null for text that is not an image handle', () => {
    for (const text of [
      '',
      'plain user text',
      '[File "a.pdf" (3 bytes, upload:u1): verbatim read-only copy saved at "/x". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]',
      '[Image unquoted (1x1, image/png, 1 bytes, sha256:x, attachment:sha256:x): nope]',
    ]) {
      expect(parseImageHandle(text)).toBeNull()
    }
  })

  it('returns null when the two digest slots disagree', () => {
    const other = 'f'.repeat(64)
    const text = imageHandleText(REF, PATH).replace(`attachment:sha256:${DIGEST}`, `attachment:sha256:${other}`)
    expect(parseImageHandle(text)).toBeNull()
  })

  it('returns null for a truncated digest slot', () => {
    const text = imageHandleText(REF, PATH).replace(`sha256:${DIGEST},`, `sha256:${DIGEST.slice(0, 8)},`)
    expect(parseImageHandle(text)).toBeNull()
  })

  it('returns null for zero dimensions (isImageRefBlock gate)', () => {
    const text = imageHandleText({ ...REF, width: 0 }, PATH)
    expect(parseImageHandle(text)).toBeNull()
  })

  it('returns null for an unsupported media type', () => {
    const text = imageHandleText(REF, PATH).replaceAll('image/webp', 'image/tiff')
    expect(parseImageHandle(text)).toBeNull()
  })

  it('returns null when the suffix is missing or altered', () => {
    const text = imageHandleText(REF, PATH)
    expect(parseImageHandle(text.slice(0, text.indexOf('. Read that path')))).toBeNull()
    expect(parseImageHandle(text.replace('. Read that path with your file tools', '. Read it'))).toBeNull()
  })

  it('never throws on a truncated handle', () => {
    const text = imageHandleText(REF, PATH)
    for (let end = 0; end < text.length; end += 7) {
      expect(() => parseImageHandle(text.slice(0, end))).not.toThrow()
    }
    // Like parseFileHandle, the advisory tail after the suffix is not data:
    // losing the final ']' still recovers the ref (leniency is deliberate).
    expect(parseImageHandle(text.slice(0, text.length - 1))).toEqual({ attachment: REF, path: PATH })
    // Losing the suffix itself IS a parse failure.
    expect(parseImageHandle(text.slice(0, text.indexOf('. Read that path')))).toBeNull()
  })

  it('never throws on malformed input', () => {
    for (const text of [
      '[Image ',
      '[Image "',
      '[Image "x" (',
      '[Image "x" (1x1, image/png, 1 bytes, sha256:zz, attachment:sha256:zz): normalized read-only copy saved at "unterminated',
      '[Image "x" (1.5x1, image/png, 1 bytes, sha256:' + DIGEST + ', attachment:sha256:' + DIGEST + '): normalized read-only copy saved at "/p". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]',
    ]) {
      expect(() => parseImageHandle(text)).not.toThrow()
      expect(parseImageHandle(text)).toBeNull()
    }
  })
})
