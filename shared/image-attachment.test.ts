import { describe, expect, it } from 'vitest'
import {
  digestOfImageRef,
  imageRefId,
  isImageRefBlock,
  type AnyImageBlock,
  type ImageRefBlock,
  type LegacyImageBlock,
} from './image-attachment'

const DIGEST = 'a1b2c3d4'.repeat(8) // 64 lowercase hex chars
const ref = { id: imageRefId(DIGEST), mediaType: 'image/png' as const, bytes: 1234, width: 8, height: 6 }
const refBlock: ImageRefBlock = { type: 'image', attachment: ref }
const legacyBlock: LegacyImageBlock = {
  type: 'image',
  source: { type: 'base64', data: 'AAAA', media_type: 'image/png' },
}

describe('imageRefId / digestOfImageRef', () => {
  it('round-trips a valid digest', () => {
    expect(imageRefId(DIGEST)).toBe(`sha256:${DIGEST}`)
    expect(digestOfImageRef(imageRefId(DIGEST))).toBe(DIGEST)
  })

  it('rejects malformed ids', () => {
    expect(digestOfImageRef(`sha256:${'a'.repeat(63)}`)).toBeNull() // too short
    expect(digestOfImageRef(`sha256:${'a'.repeat(65)}`)).toBeNull() // too long
    expect(digestOfImageRef(`sha256:${'A'.repeat(64)}`)).toBeNull() // uppercase
    expect(digestOfImageRef(`sha256:${'g'.repeat(64)}`)).toBeNull() // non-hex
    expect(digestOfImageRef(`md5:${'a'.repeat(64)}`)).toBeNull() // wrong prefix
    expect(digestOfImageRef(DIGEST)).toBeNull() // bare digest, no prefix
    expect(digestOfImageRef('')).toBeNull()
    expect(digestOfImageRef(`sha256:../../${'a'.repeat(58)}`)).toBeNull() // path escape attempt
  })
})

describe('isImageRefBlock', () => {
  it('accepts a well-formed ref block', () => {
    expect(isImageRefBlock(refBlock)).toBe(true)
  })

  it('rejects the legacy inline base64 block', () => {
    expect(isImageRefBlock(legacyBlock)).toBe(false)
  })

  it('rejects non-objects and non-image types', () => {
    for (const v of [null, undefined, 'image', 42, [], { type: 'text' }, { type: 'file', attachment: ref }]) {
      expect(isImageRefBlock(v)).toBe(false)
    }
  })

  it('rejects a missing or malformed attachment', () => {
    expect(isImageRefBlock({ type: 'image' })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: null })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: 'x' })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: [] })).toBe(false)
  })

  it('rejects a malformed ref id', () => {
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, id: 'sha256:xyz' } })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, id: 'upload:1' } })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, id: 42 } })).toBe(false)
  })

  it('rejects unsupported media types', () => {
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, mediaType: 'image/bmp' } })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, mediaType: 'text/plain' } })).toBe(false)
  })

  it('rejects malformed numeric fields', () => {
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, bytes: -1 } })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, bytes: NaN } })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, bytes: '1234' } })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, width: 0 } })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, height: -3 } })).toBe(false)
    expect(isImageRefBlock({ type: 'image', attachment: { ...ref, width: 1.5 } })).toBe(false)
  })

  it('narrows a mixed AnyImageBlock list to the ref blocks', () => {
    const blocks: AnyImageBlock[] = [refBlock, legacyBlock]
    const refs = blocks.filter(isImageRefBlock)
    expect(refs).toHaveLength(1)
    expect(refs[0].attachment.id).toBe(imageRefId(DIGEST))
  })
})
