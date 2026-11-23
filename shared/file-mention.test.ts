import { describe, expect, it } from 'vitest'
import {
  MENTION_PATTERN,
  MENTION_PATTERN_G,
  formatFileMention,
  isMentionExpressible,
  normalizeMentionPath,
  parseFileMention,
} from './file-mention'

describe('formatFileMention', () => {
  it('formats a plain file path bare', () => {
    expect(formatFileMention('src/a.ts', false)).toBe('@src/a.ts')
  })

  it('quotes a file path containing whitespace', () => {
    expect(formatFileMention('my dir/a.ts', false)).toBe('@"my dir/a.ts"')
  })

  it('marks a directory with a single trailing slash', () => {
    expect(formatFileMention('src/utils', true)).toBe('@src/utils/')
  })

  it('quotes a directory with spaces and normalizes before quoting (no \\" collision)', () => {
    expect(formatFileMention('my dir', true)).toBe('@"my dir/"')
  })

  it('normalizes a Windows backslash directory to a quoted POSIX trailing slash', () => {
    expect(formatFileMention('my dir\\', true)).toBe('@"my dir/"')
  })

  it('normalizes backslashes to the canonical separator', () => {
    expect(formatFileMention('src\\a.ts', false)).toBe('@src/a.ts')
  })

  it('preserves a drive-letter absolute path while normalizing separators', () => {
    expect(formatFileMention('D:\\codes\\x.ts', false)).toBe('@D:/codes/x.ts')
  })

  it('does not double the trailing slash when the dir already ends in one', () => {
    expect(formatFileMention('src/utils/', true)).toBe('@src/utils/')
    expect(formatFileMention('src/utils//', true)).toBe('@src/utils/')
  })

  it('throws on a control character', () => {
    expect(() => formatFileMention('a\tb', false)).toThrow()
    expect(() => formatFileMention('a\nb', false)).toThrow()
    expect(() => formatFileMention('a\u0000b', false)).toThrow()
  })

  it('throws on an embedded quote', () => {
    expect(() => formatFileMention('a"b', false)).toThrow()
  })
})

describe('parseFileMention', () => {
  it('parses a bare file mention', () => {
    expect(parseFileMention('@src/a.ts')).toEqual({ path: 'src/a.ts', dir: false })
  })

  it('parses a quoted directory mention, stripping the trailing slash marker', () => {
    expect(parseFileMention('@"my dir/"')).toEqual({ path: 'my dir', dir: true })
  })

  it('parses prose mentions (DSH parity: any @non-space)', () => {
    expect(parseFileMention('@bob')).toEqual({ path: 'bob', dir: false })
  })

  it('parses a bare directory mention', () => {
    expect(parseFileMention('@src/utils/')).toEqual({ path: 'src/utils', dir: true })
  })

  it('returns null for a non-mention', () => {
    expect(parseFileMention('hello')).toBeNull()
    expect(parseFileMention('@')).toBeNull()
    expect(parseFileMention('')).toBeNull()
  })

  it('normalizes backslashes in a hand-typed mention', () => {
    expect(parseFileMention('@src\\a.ts')).toEqual({ path: 'src/a.ts', dir: false })
  })
})

describe('format/parse round-trip', () => {
  const cases: Array<[string, boolean]> = [
    ['src/a.ts', false],
    ['my dir/a.ts', false],
    ['src/utils', true],
    ['my dir', true],
    ['src\\a.ts', false],
    ['D:\\codes\\x.ts', false],
    ['my dir\\', true],
  ]

  for (const [path, dir] of cases) {
    it(`recovers the normalized path and dir flag for ${JSON.stringify(path)} (${dir})`, () => {
      const token = formatFileMention(path, dir)
      expect(parseFileMention(token)).toEqual({ path: normalizeMentionPath(path).replace(/\/$/, ''), dir })
    })
  }
})

describe('MENTION_PATTERN / MENTION_PATTERN_G', () => {
  it('finds every mention in mixed prose', () => {
    const text = 'hi @bob see @src/a.ts and @"my dir/"'
    const matches = text.match(MENTION_PATTERN_G)
    expect(matches).toEqual(['@bob', '@src/a.ts', '@"my dir/"'])
  })

  it('does not match an @ embedded in a word (no whitespace boundary)', () => {
    expect('email@x'.match(MENTION_PATTERN_G)).toBeNull()
    expect('hi email@x @bob'.match(MENTION_PATTERN_G)).toEqual(['@bob'])
  })

  it('matches a mention at the start of the text', () => {
    expect('@src/a.ts rest'.match(MENTION_PATTERN_G)).toEqual(['@src/a.ts'])
  })

  it('exposes a non-global single-match variant', () => {
    expect(MENTION_PATTERN.global).toBe(false)
    expect(MENTION_PATTERN_G.global).toBe(true)
    expect(MENTION_PATTERN.test('hi @bob')).toBe(true)
  })
})

describe('normalizeMentionPath', () => {
  it('converts backslashes to the canonical separator', () => {
    expect(normalizeMentionPath('src\\a.ts')).toBe('src/a.ts')
  })

  it('collapses redundant separators', () => {
    expect(normalizeMentionPath('a//b')).toBe('a/b')
    expect(normalizeMentionPath('a\\\\b')).toBe('a/b')
    expect(normalizeMentionPath('a/\\b')).toBe('a/b')
  })

  it('preserves a drive-letter absolute path', () => {
    expect(normalizeMentionPath('D:\\codes\\x.ts')).toBe('D:/codes/x.ts')
  })

  it('does not resolve .. (containment is the server’s job)', () => {
    expect(normalizeMentionPath('a/../b')).toBe('a/../b')
    expect(normalizeMentionPath('../../etc')).toBe('../../etc')
  })

  it('keeps a single trailing separator but collapses a trailing run', () => {
    expect(normalizeMentionPath('a/b/')).toBe('a/b/')
    expect(normalizeMentionPath('a/b//')).toBe('a/b/')
  })
})

describe('isMentionExpressible', () => {
  it('accepts ordinary paths (spaces, backslashes, drive letters)', () => {
    expect(isMentionExpressible('src/a.ts')).toBe(true)
    expect(isMentionExpressible('my dir/a.ts')).toBe(true)
    expect(isMentionExpressible('D:\\codes\\x.ts')).toBe(true)
  })

  it('rejects embedded quotes and control characters', () => {
    expect(isMentionExpressible('we"ird.txt')).toBe(false)
    expect(isMentionExpressible('bad\x01name.txt')).toBe(false)
    expect(isMentionExpressible('tab\tname.txt')).toBe(false)
    expect(isMentionExpressible('del\x7f.txt')).toBe(false)
  })

  it('agrees with formatFileMention on what is formattable', () => {
    for (const p of ['a.ts', 'my dir/a.ts', 'we"ird.txt', 'bad\x01name.txt']) {
      let formattable = true
      try {
        formatFileMention(p, false)
      } catch {
        formattable = false
      }
      expect(isMentionExpressible(p)).toBe(formattable)
    }
  })
})
