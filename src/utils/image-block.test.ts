import { describe, it, expect } from 'vitest'
import { imageBlockToDataUrl } from './image-block'
import type { Block } from '../types'

/** Build an image block, letting tests override any field. `source` is
 *  `unknown` via Block's index signature, so overrides stay loose. */
const imageBlock = (overrides: Record<string, unknown> = {}): Block => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
  ...overrides,
})

describe('imageBlockToDataUrl', () => {
  it('converts a base64 image block to a data URL', () => {
    expect(imageBlockToDataUrl(imageBlock())).toBe('data:image/jpeg;base64,AAAA')
  })

  it('returns null for a non-image block', () => {
    expect(imageBlockToDataUrl({ type: 'text', text: 'hi' })).toBeNull()
  })

  it('returns null for undefined / null input', () => {
    expect(imageBlockToDataUrl(undefined)).toBeNull()
    expect(imageBlockToDataUrl(null)).toBeNull()
  })

  it('returns null when source is missing', () => {
    expect(imageBlockToDataUrl({ type: 'image' })).toBeNull()
  })

  it('returns null for a non-base64 source type', () => {
    expect(imageBlockToDataUrl(imageBlock({ source: { type: 'url', url: 'http://x' } }))).toBeNull()
  })

  it('returns null for an empty data payload', () => {
    expect(imageBlockToDataUrl(imageBlock({ source: { type: 'base64', media_type: 'image/png', data: '' } }))).toBeNull()
  })

  it('returns null when data is not a string', () => {
    expect(imageBlockToDataUrl(imageBlock({ source: { type: 'base64', media_type: 'image/png', data: 123 } }))).toBeNull()
  })

  it('returns null for a missing media type', () => {
    expect(imageBlockToDataUrl(imageBlock({ source: { type: 'base64', data: 'AAAA' } }))).toBeNull()
  })

  it('returns null for a non-image media type', () => {
    expect(imageBlockToDataUrl(imageBlock({ source: { type: 'base64', media_type: 'text/plain', data: 'AAAA' } }))).toBeNull()
  })
})
