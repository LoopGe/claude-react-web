import { describe, it, expect } from 'vitest'
import { shortenPath, splitDrive, buildCrumbs } from './paths'

// ── splitDrive ──────────────────────────────────────────────────────

describe('splitDrive', () => {
  it('detects C:\\ backslash drive', () => {
    expect(splitDrive('C:\\Users\\john')).toEqual({
      drive: 'C:\\',
      rest: 'Users\\john',
      sep: '\\',
    })
  })

  it('detects C:/ forward-slash drive', () => {
    expect(splitDrive('C:/Users/john')).toEqual({
      drive: 'C:/',
      rest: 'Users/john',
      sep: '/',
    })
  })

  it('detects bare drive letter with no separator', () => {
    const result = splitDrive('D:')
    expect(result).not.toBeNull()
    expect(result!.drive).toBe('D:\\') // defaults to backslash
    expect(result!.rest).toBe('')
  })

  it('detects drive with root only', () => {
    expect(splitDrive('C:\\')).toEqual({ drive: 'C:\\', rest: '', sep: '\\' })
  })

  it('returns null for Unix paths', () => {
    expect(splitDrive('/home/user')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(splitDrive('')).toBeNull()
  })

  it('returns null for relative paths', () => {
    expect(splitDrive('src/components')).toBeNull()
  })
})

// ── buildCrumbs ─────────────────────────────────────────────────────

describe('buildCrumbs', () => {
  it('returns empty array for empty string', () => {
    expect(buildCrumbs('')).toEqual([])
  })

  // -- Unix --

  it('Unix root "/"', () => {
    expect(buildCrumbs('/')).toEqual([{ label: '/', path: '/' }])
  })

  it('Unix path /home/user', () => {
    expect(buildCrumbs('/home/user')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'user', path: '/home/user' },
    ])
  })

  // -- Windows backslash --

  it('Windows C:\\ backslash root', () => {
    expect(buildCrumbs('C:\\')).toEqual([{ label: 'C:\\', path: 'C:\\' }])
  })

  it('Windows C:\\Users\\john backslash path', () => {
    expect(buildCrumbs('C:\\Users\\john')).toEqual([
      { label: 'C:\\', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'john', path: 'C:\\Users\\john' },
    ])
  })

  // -- Windows forward-slash --

  it('Windows C:/ forward-slash root', () => {
    expect(buildCrumbs('C:/')).toEqual([{ label: 'C:/', path: 'C:/' }])
  })

  it('Windows C:/Users/john forward-slash path', () => {
    expect(buildCrumbs('C:/Users/john')).toEqual([
      { label: 'C:/', path: 'C:/' },
      { label: 'Users', path: 'C:/Users' },
      { label: 'john', path: 'C:/Users/john' },
    ])
  })

  // -- Mixed separators --

  it('Windows C:\\Users/john mixed separator normalises to backslash', () => {
    expect(buildCrumbs('C:\\Users/john')).toEqual([
      { label: 'C:\\', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'john', path: 'C:\\Users\\john' },
    ])
  })

  // -- Other drive letters --

  it('D:\\ drive works', () => {
    expect(buildCrumbs('D:\\work\\src')).toEqual([
      { label: 'D:\\', path: 'D:\\' },
      { label: 'work', path: 'D:\\work' },
      { label: 'src', path: 'D:\\work\\src' },
    ])
  })
})

// ── shortenPath ─────────────────────────────────────────────────────

describe('shortenPath', () => {
  // -- Short paths left alone --

  it('returns short paths unchanged', () => {
    expect(shortenPath('/home/user/project')).toBe('/home/user/project')
  })

  it('returns paths <= 36 chars unchanged', () => {
    const p = '/a/b/c/d/e/f/g/h/i/j' // 21 chars
    expect(shortenPath(p)).toBe(p)
  })

  it('short Windows backslash path unchanged', () => {
    expect(shortenPath('C:\\Users\\john')).toBe('C:\\Users\\john')
  })

  it('short Windows forward-slash path unchanged', () => {
    expect(shortenPath('C:/Users/john')).toBe('C:/Users/john')
  })

  // -- Long Unix paths --

  it('collapses long Unix paths to last two segments', () => {
    const p = '/home/user/very/long/nested/project/src/components'
    const result = shortenPath(p)
    expect(result).toBe('…/src/components')
  })

  it('preserves Unix separator in output', () => {
    const p = '/alpha/bravo/charlie/delta/echo/foxtrot/golf/hotel'
    expect(p.length).toBeGreaterThan(36)
    const result = shortenPath(p)
    const parts = result.split('/')
    expect(parts.length).toBe(3) // '…', last-1, last
  })

  // -- Long Windows backslash paths --

  it('collapses long Windows backslash paths and preserves drive prefix', () => {
    const p = 'C:\\Users\\developer\\projects\\my-app\\src\\components'
    const result = shortenPath(p)
    expect(result).toBe('C:\\…\\src\\components')
    expect(result).toMatch(/^C:\\/)
  })

  it('preserves Windows backslash separator and drive in output', () => {
    const p = 'D:\\alpha\\bravo\\charlie\\delta\\echo\\foxtrot\\golf\\hotel'
    expect(p.length).toBeGreaterThan(36)
    const result = shortenPath(p)
    const parts = result.split('\\')
    expect(parts.length).toBe(4) // 'D:', '…', last-1, last
    expect(result).toMatch(/^D:\\/)
  })

  // -- Long Windows forward-slash paths --

  it('collapses long Windows forward-slash path and preserves drive', () => {
    const p = 'C:/Users/developer/projects/my-app/src/components'
    expect(p.length).toBeGreaterThan(36)
    const result = shortenPath(p)
    // Drive is detected → output always uses backslash (matches path.resolve)
    expect(result).toBe('C:\\…\\src\\components')
    expect(result).toMatch(/^C:\\/)
  })

  // -- Edge cases --

  it('returns short paths with <= 3 segments unchanged even if long', () => {
    const longSeg = 'a'.repeat(20)
    const p = `${longSeg}/${longSeg}/${longSeg}`
    expect(p.length).toBeGreaterThan(36)
    // 3 segments (no leading empty from /) → segs.length = 3 → returned as-is
    expect(shortenPath(p)).toBe(p)
  })

  it('handles empty string', () => {
    expect(shortenPath('')).toBe('')
  })

  it('handles root path', () => {
    expect(shortenPath('/')).toBe('/')
  })

  it('handles Windows root path', () => {
    expect(shortenPath('C:\\')).toBe('C:\\')
  })

  it('collapses long UNC paths', () => {
    const p = '\\\\fileserver\\dept\\projects\\2025\\alpha\\src\\components'
    expect(p.length).toBeGreaterThan(36)
    expect(shortenPath(p)).toBe('…\\src\\components')
  })
})
