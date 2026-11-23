import { describe, expect, it } from 'vitest'
import { fileHandleText } from '../../shared/upload-handle'
import { imageHandleText } from '../../shared/image-handle'
import { splitUserBlocks, splitUserContentSegments } from './file-blocks'
import type { Block } from '../types'

const ref = { id: '8f1c2d34-0000-4000-8000-000000000003', name: 'a.pdf', size: 3, digest: 'a'.repeat(64) }
const handle = fileHandleText(ref, '/tmp/a.pdf')
const imageHandle = imageHandleText(
  { id: `sha256:${'b'.repeat(64)}`, mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
  `/store/images/bb/${'b'.repeat(64)}`,
)

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
  it('recovers a valid handle whose filename contains the terminator text', () => {
    const tricky = { id: 'upload-tricky', name: 'quarterly read it.] report.pdf', size: 42 }
    const trickyHandle = fileHandleText(tricky, '/tmp/quarterly.pdf')
    expect(splitUserContentSegments([{ type: 'text', text: `before${trickyHandle}after` }])).toEqual([
      { type: 'text', text: 'before' },
      { type: 'file', file: tricky },
      { type: 'text', text: 'after' },
    ])
  })
})

describe('splitUserContentSegments mention split', () => {
  it('splits text into text/mention pieces in document order', () => {
    expect(splitUserContentSegments([{ type: 'text', text: 'see @src/a.ts and @bob' }])).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'mention', text: '@src/a.ts', path: 'src/a.ts', dir: false },
      { type: 'text', text: ' and ' },
      { type: 'mention', text: '@bob', path: 'bob', dir: false },
    ])
  })

  it('parses a quoted path with spaces and the directory marker', () => {
    expect(splitUserContentSegments([{ type: 'text', text: '@"my dir/" x' }])).toEqual([
      { type: 'mention', text: '@"my dir/"', path: 'my dir', dir: true },
      { type: 'text', text: ' x' },
    ])
  })

  it('splits mentions after the file-handle split, keeping both in place', () => {
    expect(splitUserContentSegments([{ type: 'text', text: `see ${handle} @src/a.ts` }])).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'file', file: { id: ref.id, name: ref.name, size: ref.size } },
      { type: 'text', text: ' ' },
      { type: 'mention', text: '@src/a.ts', path: 'src/a.ts', dir: false },
    ])
  })

  it('leaves an email address alone (no whitespace boundary before the @)', () => {
    expect(splitUserContentSegments([{ type: 'text', text: 'mail bob@x.com please' }])).toEqual([
      { type: 'text', text: 'mail bob@x.com please' },
    ])
  })

  it('keeps bash-mode XML intact — BashMessage parses the raw tags', () => {
    // A `@run` inside the command or stdout is code/output, not a user
    // reference; fragmenting the tags would break extractTag's slicing.
    const bash = '<bash-input>cat @src/a.ts</bash-input>\n<bash-stdout>@out</bash-stdout>'
    expect(splitUserContentSegments([{ type: 'text', text: bash }])).toEqual([
      { type: 'text', text: bash },
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

  it('drops image-handle plumbing text (the image block renders instead)', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'A', media_type: 'image/png' } } as Block
    const parts = splitUserBlocks([{ type: 'text', text: imageHandle }, image])
    expect(parts).toEqual({ text: null, images: [image], files: [] })
  })
})