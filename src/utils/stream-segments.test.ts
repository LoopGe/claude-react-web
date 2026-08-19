import { describe, it, expect } from 'vitest'
import { splitStreamSegments, type StreamSegment } from './stream-segments'

function rebuild(segments: StreamSegment[]): string {
  return segments
    .map((s) =>
      s.type === 'text'
        ? s.content
        : '```' + (s.lang ?? '') + '\n' + s.content + '\n' + '```' + '\n',
    )
    .join('')
}

describe('splitStreamSegments', () => {
  it('returns [] for empty input', () => {
    expect(splitStreamSegments('')).toEqual([])
  })

  it('keeps fence-free text as one text segment', () => {
    expect(splitStreamSegments('hello\nworld')).toEqual([
      { type: 'text', content: 'hello\nworld' },
    ])
  })

  it('splits a complete fenced block with a language out of surrounding text', () => {
    expect(splitStreamSegments('a\n```js\nx=1\n```\nb')).toEqual([
      { type: 'text', content: 'a\n' },
      { type: 'code', lang: 'js', content: 'x=1', closed: true },
      { type: 'text', content: 'b' },
    ])
  })

  it('renders a language-less fence as lang null', () => {
    expect(splitStreamSegments('```\nx\n```\n')).toEqual([
      { type: 'code', lang: null, content: 'x', closed: true },
    ])
  })

  it('leaves an unclosed trailing fence open', () => {
    expect(splitStreamSegments('```js\nx=1')).toEqual([
      { type: 'code', lang: 'js', content: 'x=1', closed: false },
    ])
  })

  it('keeps an empty just-opened fence open', () => {
    expect(splitStreamSegments('```js\n')).toEqual([
      { type: 'code', lang: 'js', content: '', closed: false },
    ])
  })

  it('holds a partial opener (no trailing newline) so it never flashes as text', () => {
    expect(splitStreamSegments('hello\n```')).toEqual([
      { type: 'text', content: 'hello\n' },
    ])
  })

  it('holds a partial closer inside a fence, keeping the segment open', () => {
    expect(splitStreamSegments('```js\nx=1\n```')).toEqual([
      { type: 'code', lang: 'js', content: 'x=1', closed: false },
    ])
  })

  it('treats a quadruple-backtick opener as longer, so an inner triple run is content', () => {
    expect(splitStreamSegments('````\n```\nx\n````\n')).toEqual([
      { type: 'code', lang: null, content: '```\nx', closed: true },
    ])
  })

  it('treats a backtick run shorter than the opener as content', () => {
    expect(splitStreamSegments('````js\n```x\n````\n')).toEqual([
      { type: 'code', lang: 'js', content: '```x', closed: true },
    ])
  })

  it('does not close on a fence line with a non-whitespace suffix', () => {
    expect(splitStreamSegments('```\n``` hello ```\n```\n')).toEqual([
      { type: 'code', lang: null, content: '``` hello ```', closed: true },
    ])
  })

  it('renders tilde fences as plain text (documented degradation)', () => {
    expect(splitStreamSegments('~~~\nx\n~~~')).toEqual([
      { type: 'text', content: '~~~\nx\n~~~' },
    ])
  })

  it('renders trailing backticks not at line start as text', () => {
    expect(splitStreamSegments('abc```')).toEqual([
      { type: 'text', content: 'abc```' },
    ])
  })

  it('extracts the language for 1-3 space indented fence openers', () => {
    for (const indent of [' ', '  ', '   ']) {
      expect(splitStreamSegments(`${indent}\`\`\`js\nx=1\n${indent}\`\`\`\n`)).toEqual([
        { type: 'code', lang: 'js', content: 'x=1', closed: true },
      ])
    }
  })

  it('honors the recovery invariant: rebuilding fully-closed inputs reproduces the input', () => {
    // NOTE: only triple-backtick fences round-trip byte-exactly. A
    // quadruple-backtick fence is elided and rebuilt as a triple fence (the
    // segment does not carry fenceRun), so it is deliberately excluded here —
    // its own test above covers the run-length rule instead. Likewise 1–3 space
    // indented fences are normalized away on rebuild (covered by their own
    // shape test above).
    const fixtures = [
      '',
      'a\n```js\nx=1\n```\nb',
      '```\nx\n```\n',
      'plain text only',
    ]
    for (const f of fixtures) {
      expect(rebuild(splitStreamSegments(f))).toBe(f)
    }
  })
})
