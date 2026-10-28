import { describe, it, expect } from 'vitest'
import { splitStreamBlocks, splitStreamSegments, type StreamSegment } from './stream-segments'

function rebuild(segments: StreamSegment[]): string {
  return segments
    .map((s) =>
      s.type === 'text'
        ? s.content
        : '```' +
          (s.lang ?? '') +
          '\n' +
          s.content +
          // An empty code block has no interior line, so the blank line between
          // opener and closer must be omitted for the round-trip to be exact.
          (s.content ? '\n' : '') +
          '```' +
          '\n',
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

  it('renders a partial tail opener as an open code block immediately (typed chars never vanish)', () => {
    // The opener line is already an opener in settled markdown; hiding it
    // until its newline lands made typing feel stuck. The stateless rescan
    // reconciles if the line grows into a non-opener.
    expect(splitStreamSegments('hello\n```')).toEqual([
      { type: 'text', content: 'hello\n' },
      { type: 'code', lang: null, content: '', closed: false },
    ])
  })

  it('shows a partial tail closer as content (a completed closer line drops it on rescan)', () => {
    expect(splitStreamSegments('```js\nx=1\n```')).toEqual([
      { type: 'code', lang: 'js', content: 'x=1\n```', closed: false },
    ])
    // The same input plus the newline closes the block and the backticks are
    // gone from content — the rescan is stateless, so no bookkeeping leaks.
    expect(splitStreamSegments('```js\nx=1\n```\n')).toEqual([
      { type: 'code', lang: 'js', content: 'x=1', closed: true },
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

  it('keeps an indented fence with no language as lang null', () => {
    expect(splitStreamSegments('  ```\nx\n  ```\n')).toEqual([
      { type: 'code', lang: null, content: 'x', closed: true },
    ])
  })

  it('closes a fenced block under CRLF line endings (closer not swallowed)', () => {
    expect(splitStreamSegments('a\r\n```js\r\nx\r\n```\r\nb')).toEqual([
      { type: 'text', content: 'a\r\n' },
      { type: 'code', lang: 'js', content: 'x\r', closed: true },
      { type: 'text', content: 'b' },
    ])
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
      '```js\n```\n',
    ]
    for (const f of fixtures) {
      expect(rebuild(splitStreamSegments(f))).toBe(f)
    }
  })
})

describe('splitStreamBlocks', () => {
  it('returns [] for empty input', () => {
    expect(splitStreamBlocks('')).toEqual([])
  })

  it('splits prose on blank-line runs, keeping the run with the preceding block', () => {
    expect(splitStreamBlocks('para one\n\npara two')).toEqual([
      { type: 'text', content: 'para one\n\n' },
      { type: 'text', content: 'para two' },
    ])
  })

  it('keeps soft line breaks inside one block', () => {
    expect(splitStreamBlocks('a\nb\nc')).toEqual([{ type: 'text', content: 'a\nb\nc' }])
  })

  it('merges a loose list across blank lines into one block (no numbering restart)', () => {
    expect(splitStreamBlocks('- a\n\n- b')).toEqual([{ type: 'text', content: '- a\n\n- b' }])
    expect(splitStreamBlocks('1. a\n\n2. b')).toEqual([{ type: 'text', content: '1. a\n\n2. b' }])
  })

  it('merges a multi-paragraph blockquote into one block', () => {
    expect(splitStreamBlocks('> a\n\n> b')).toEqual([{ type: 'text', content: '> a\n\n> b' }])
  })

  it('merges on the block CONSTRUCT, not the last line (wrapping items do not fork the list)', () => {
    // The item's indented wrap continuation is a plain line — keying the
    // merge on the last line would fork the list here and restart numbering
    // live. Keyed on the opening line (a bullet), the merge holds.
    expect(splitStreamBlocks('- item one wrapped\n  over two lines\n\n- item two')).toEqual([
      { type: 'text', content: '- item one wrapped\n  over two lines\n\n- item two' },
    ])
    expect(splitStreamBlocks('> quote lazy\nwrapped\n\n> second')).toEqual([
      { type: 'text', content: '> quote lazy\nwrapped\n\n> second' },
    ])
  })

  it('keeps a multi-paragraph list item whole (indented continuation never restarts numbering)', () => {
    // The common model pattern: every item written as "N." with indented
    // detail paragraphs in between. The detail line is indented content of
    // the item, not a new block — splitting there renders the second "N." as
    // a fresh <ol start=1> live.
    expect(splitStreamBlocks('1. First\n\n   more detail\n\n1. Second')).toEqual([
      { type: 'text', content: '1. First\n\n   more detail\n\n1. Second' },
    ])
  })

  it('keeps display math that spans blank lines whole', () => {
    expect(splitStreamBlocks('para\n\n$$\nx\n\ny\n$$\n\npara2')).toEqual([
      { type: 'text', content: 'para\n\n' },
      { type: 'text', content: '$$\nx\n\ny\n$$\n\n' },
      { type: 'text', content: 'para2' },
    ])
    expect(splitStreamBlocks('$$\\begin{align}\nx\n\ny\n\\end{align}$$')).toEqual([
      { type: 'text', content: '$$\\begin{align}\nx\n\ny\n\\end{align}$$' },
    ])
  })

  it('does not merge across constructs (paragraph → list, list → paragraph)', () => {
    expect(splitStreamBlocks('text\n\n- a')).toEqual([
      { type: 'text', content: 'text\n\n' },
      { type: 'text', content: '- a' },
    ])
    expect(splitStreamBlocks('- a\n\ntext')).toEqual([
      { type: 'text', content: '- a\n\n' },
      { type: 'text', content: 'text' },
    ])
  })

  it('keeps a fenced code block whole — blank lines inside the fence never split', () => {
    expect(splitStreamBlocks('intro\n\n```js\nx\n\ny\n```\noutro')).toEqual([
      { type: 'text', content: 'intro\n\n' },
      { type: 'code', lang: 'js', content: 'x\n\ny', closed: true },
      { type: 'text', content: 'outro' },
    ])
  })

  it('leaves an open tail fence open', () => {
    expect(splitStreamBlocks('pre\n\n```py\nno end')).toEqual([
      { type: 'text', content: 'pre\n\n' },
      { type: 'code', lang: 'py', content: 'no end', closed: false },
    ])
  })

  it('honors the recovery invariant: blocks rebuild to the exact input', () => {
    const fixtures = [
      '',
      'a\n```js\nx=1\n```\nb',
      'para\n\n- list\n\n- items\n\nend',
      '```\nx\n```\n',
    ]
    for (const f of fixtures) {
      expect(rebuild(splitStreamBlocks(f))).toBe(f)
    }
  })

  it('freezes every non-tail block across appends (the perf foundation)', () => {
    // The streaming renderer memoizes closed blocks by their text; that only
    // works because append-only streaming never revisits them. If a non-tail
    // block ever changed, closed markdown blocks would silently re-parse.
    const cases: Array<[string, string]> = [
      ['p1\n\np2', '\n\np3'],
      ['- a\n\n- b\n\np', '\n\n- c'],
      ['> q1\n\nplain', '\n\n> q2'],
      ['pre\n\n```js\nx', '\n```\n\nafter'],
    ]
    for (const [s, t] of cases) {
      const before = splitStreamBlocks(s)
      const after = splitStreamBlocks(s + t)
      expect(before.length).toBeGreaterThan(1) // the prefix must have a frozen block
      for (let i = 0; i < before.length - 1; i++) {
        expect(after[i]).toEqual(before[i])
      }
    }
  })
})
