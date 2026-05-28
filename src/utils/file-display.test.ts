import { describe, it, expect } from 'vitest'
import {
  splitFilePath,
  shortenDir,
  getFileLanguage,
  detectLanguage,
} from './file-display'

describe('splitFilePath', () => {
  it('splits unix paths', () => {
    expect(splitFilePath('src/components/Foo.tsx')).toEqual({
      dir: 'src/components',
      base: 'Foo.tsx',
    })
  })

  it('splits windows paths', () => {
    expect(splitFilePath('C:\\Users\\me\\foo.ts')).toEqual({
      dir: 'C:\\Users\\me',
      base: 'foo.ts',
    })
  })

  it('handles bare filename', () => {
    expect(splitFilePath('foo.tsx')).toEqual({ dir: '', base: 'foo.tsx' })
  })

  it('handles empty', () => {
    expect(splitFilePath('')).toEqual({ dir: '', base: '' })
  })

  it('handles mixed separators (model often outputs these)', () => {
    expect(splitFilePath('src/components\\Foo.tsx')).toEqual({
      dir: 'src/components',
      base: 'Foo.tsx',
    })
  })
})

describe('shortenDir', () => {
  it('leaves short dirs alone', () => {
    expect(shortenDir('src/components')).toBe('src/components')
  })

  it('keeps first and last segment when collapsing', () => {
    const result = shortenDir('src/components/foo/bar/baz/quux/extra', 20)
    expect(result.startsWith('src')).toBe(true)
    expect(result.endsWith('extra')).toBe(true)
    expect(result.includes('…')).toBe(true)
  })

  it('preserves separator style', () => {
    const result = shortenDir('C:\\Users\\me\\projects\\foo\\bar', 15)
    expect(result.includes('\\')).toBe(true)
    expect(result.includes('/')).toBe(false)
  })

  it('returns dir untouched when only 2 segments', () => {
    expect(shortenDir('a/b', 5)).toBe('a/b')
  })
})

describe('getFileLanguage', () => {
  it('detects common extensions', () => {
    expect(getFileLanguage('foo.ts')).toBe('typescript')
    expect(getFileLanguage('foo.tsx')).toBe('typescript')
    expect(getFileLanguage('foo.js')).toBe('javascript')
    expect(getFileLanguage('foo.py')).toBe('python')
    expect(getFileLanguage('foo.go')).toBe('go')
  })

  it('returns null for unknown extensions', () => {
    expect(getFileLanguage('foo.xyz')).toBe(null)
  })

  it('returns null for files without extension', () => {
    expect(getFileLanguage('Makefile')).toBe(null)
  })
})

describe('detectLanguage', () => {
  it('handles full paths', () => {
    expect(detectLanguage('src/components/Foo.tsx')).toBe('typescript')
  })

  it('detects Dockerfile by basename', () => {
    expect(detectLanguage('/some/path/Dockerfile')).toBe('dockerfile')
  })

  it('detects Makefile by basename', () => {
    expect(detectLanguage('/some/path/Makefile')).toBe('makefile')
  })

  it('returns null for unknown paths', () => {
    expect(detectLanguage('/some/path/random.xyz')).toBe(null)
  })
})
