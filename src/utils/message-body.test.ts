import { describe, expect, it } from 'vitest'
import { buildOutgoingBody } from './message-body.js'

const IMG = {
  id: 'img-1',
  data: 'abc123',
  mediaType: 'image/png',
  width: 10,
  height: 10,
  size: 12,
  previewUrl: 'data:image/png;base64,abc123',
} as const

describe('buildOutgoingBody', () => {
  it('returns a plain text body when there are no images', () => {
    expect(buildOutgoingBody('hello', [])).toEqual({ text: 'hello' })
  })

  it('includes the text block only for non-blank text', () => {
    const body = buildOutgoingBody('hi', [IMG])
    expect(body).toEqual({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', source: { type: 'base64', data: 'abc123', media_type: 'image/png' } },
      ],
    })
  })

  it('omits the text block for blank text (image-only message)', () => {
    const body = buildOutgoingBody('   ', [IMG])
    expect(body).toEqual({
      content: [{ type: 'image', source: { type: 'base64', data: 'abc123', media_type: 'image/png' } }],
    })
  })

  it('emits one image block per pasted image, in order', () => {
    const body = buildOutgoingBody('', [IMG, { ...IMG, mediaType: 'image/jpeg' }])
    expect((body as { content: unknown[] }).content).toHaveLength(2)
  })
})
