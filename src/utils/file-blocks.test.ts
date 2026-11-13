import { describe, expect, it } from 'vitest'
import { fileHandleText } from '../../shared/upload-handle'
import { splitUserBlocks, splitUserContentSegments } from './file-blocks'
import type { Block } from '../types'

const ref = { id: '8f1c2d34-0000-4000-8000-000000000003', name: 'a.pdf', size: 3, digest: 'a'.repeat(64) }
const handle = fileHandleText(ref, '/tmp/a.pdf')

describe('splitUserContentSegments', () => {
  it('preserves text, file, and image order including repeated upload ids', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'A', media_type: 'image/png' } } as Block
    const segments = splitUserContentSegments([
      { type: 'text', text: 'before' },
      { type: 'file', attachment: ref },
      { type: 'text', text: 'after' },
      { type: 'file', attachment: ref },
      image,
    ])

    expect(segments).toEqual([
      { type: 'text', text: 'before' },
      { type: 'file', file: ref },
      { type: 'text', text: 'after' },
      { type: 'file', file: ref },
      { type: 'image', block: image },
    ])
  })

  it('places a recovered legacy handle between its surrounding text', () => {
    expect(splitUserContentSegments([{ type: 'text', text: `before${handle}after` }])).toEqual([
      { type: 'text', text: 'before' },
      { type: 'file', file: { id: ref.id, name: ref.name, size: ref.size } },
      { type: 'text', text: 'after' },
    ])
  })
})

describe('splitUserBlocks', () => {
  it('separates text, images, and structured FileBlocks in source order', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'A', media_type: 'image/png' } } as Block
    const parts = splitUserBlocks([
      { type: 'text', text: 'look' },
      { type: 'file', attachment: ref },
      image,
    ])
    expect(parts).toEqual({
      text: 'look',
      images: [image],
      files: [ref],
    })
  })

  it('recovers a file from the handle text the SDK persisted', () => {
    const parts = splitUserBlocks([{ type: 'text', text: handle }])
    expect(parts).toEqual({
      text: null,
      images: [],
      files: [{ id: ref.id, name: ref.name, size: ref.size }],
    })
  })

  it('keeps ordinary text that merely mentions File', () => {
    const parts = splitUserBlocks([{ type: 'text', text: '[File "x" is not a handle]' }])
    expect(parts.text).toBe('[File "x" is not a handle]')
    expect(parts.files).toEqual([])
  })
})