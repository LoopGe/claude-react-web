import { describe, expect, it } from 'vitest'
import { promptContentFingerprint } from './prompt-fingerprint'
import { fileHandleText } from './upload-handle'

const ref = { id: '8f1c2d34-0000-4000-8000-000000000004', name: 'a.pdf', size: 3 }

function user(content: unknown[]): { type: string; message: { content: unknown[] } } {
  return { type: 'user', message: { content } }
}

describe('promptContentFingerprint file identity', () => {
  it('matches a live FileBlock with the handle text written to disk', () => {
    const live = user([{ type: 'text', text: 'hi' }, { type: 'file', attachment: ref }])
    const disk = user([{ type: 'text', text: 'hi' }, { type: 'text', text: fileHandleText(ref, '/tmp/a.pdf') }])
    expect(promptContentFingerprint(live)).toBe(promptContentFingerprint(disk))
  })

  it('distinguishes two different files with the same user text', () => {
    const a = user([{ type: 'text', text: 'hi' }, { type: 'file', attachment: ref }])
    const b = user([{
      type: 'text',
      text: 'hi',
    }, {
      type: 'file',
      attachment: { ...ref, id: '8f1c2d34-0000-4000-8000-000000000005' },
    }])
    expect(promptContentFingerprint(a)).not.toBe(promptContentFingerprint(b))
  })
})

describe('promptContentFingerprint image identity', () => {
  const imgRef = {
    id: `sha256:${'ab'.repeat(32)}`,
    mediaType: 'image/webp',
    bytes: 5,
    width: 10,
    height: 20,
  }
  const refBlock = { type: 'image', attachment: imgRef }

  it('matches a live ref block with the recovered disk ref block', () => {
    const live = user([{ type: 'text', text: 'hi' }, refBlock])
    const disk = user([{ type: 'text', text: 'hi' }, { type: 'image', attachment: { ...imgRef } }])
    expect(promptContentFingerprint(live)).toBe(promptContentFingerprint(disk))
  })

  it('distinguishes two different image refs with the same user text', () => {
    const a = user([{ type: 'text', text: 'hi' }, refBlock])
    const b = user([
      { type: 'text', text: 'hi' },
      { type: 'image', attachment: { ...imgRef, id: `sha256:${'cd'.repeat(32)}` } },
    ])
    expect(promptContentFingerprint(a)).not.toBe(promptContentFingerprint(b))
  })

  it('distinguishes image-only prompts carrying different refs', () => {
    const a = user([refBlock])
    const b = user([{ type: 'image', attachment: { ...imgRef, id: `sha256:${'cd'.repeat(32)}` } }])
    expect(promptContentFingerprint(a)).not.toBe(promptContentFingerprint(b))
  })

  it('keeps the legacy base64 digest path for source blocks', () => {
    const a = user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }])
    const b = user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }])
    expect(promptContentFingerprint(a)).not.toBe(promptContentFingerprint(b))
  })
})