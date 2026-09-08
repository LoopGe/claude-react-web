import { describe, expect, it } from 'vitest'
import { validateSendBody } from './send-body.js'

describe('validateSendBody', () => {
  it('accepts a non-empty text body', () => {
    const v = validateSendBody({ text: 'hello' })
    expect(v).toEqual({ ok: true, body: { text: 'hello' } })
  })

  it('trims and rejects whitespace-only text', () => {
    const v = validateSendBody({ text: '   ' })
    expect(v).toEqual({ ok: false, status: 400, error: 'text is required' })
  })

  it('rejects missing text', () => {
    expect(validateSendBody({})).toEqual({ ok: false, status: 400, error: 'text is required' })
  })

  it('accepts text + image content blocks', () => {
    const content = [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } },
    ]
    const v = validateSendBody({ content })
    expect(v).toEqual({ ok: true, body: { content } })
  })

  it('rejects an image block missing its base64 source', () => {
    const v = validateSendBody({ content: [{ type: 'image', source: { type: 'url', url: 'x' } }] })
    expect(v).toEqual({ ok: false, status: 400, error: 'invalid image block: missing base64 source' })
  })

  it('rejects an unsupported media type', () => {
    const v = validateSendBody({ content: [{ type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/tiff' } }] })
    expect(v).toEqual({ ok: false, status: 400, error: 'unsupported image type: image/tiff' })
  })

  it('rejects an unsupported block type', () => {
    const v = validateSendBody({ content: [{ type: 'video' }] })
    expect(v).toEqual({ ok: false, status: 400, error: 'unsupported content block type: video' })
  })

  it('rejects a >28MB base64 payload', () => {
    const v = validateSendBody({ content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(28_000_001), media_type: 'image/png' } }] })
    expect(v).toEqual({ ok: false, status: 413, error: 'total image payload too large' })
  })
})
