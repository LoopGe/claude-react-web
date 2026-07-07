import { describe, it, expect } from 'vitest'
import { shortenPath, splitDrive, buildCrumbs, isAbsolutePath, resolveAbsolutePath } from './paths'

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

// ── isAbsolutePath ─────────────────────────────────────────────────

describe('isAbsolutePath', () => {
  it('treats Unix roots as absolute', () => {
    expect(isAbsolutePath('/home/me/foo.ts')).toBe(true)
    expect(isAbsolutePath('/foo')).toBe(true)
  })

  it('treats Windows drive roots as absolute', () => {
    expect(isAbsolutePath('C:\\Users\\me\\foo.ts')).toBe(true)
    expect(isAbsolutePath('C:/Users/me/foo.ts')).toBe(true)
  })

  it('treats UNC paths as absolute', () => {
    expect(isAbsolutePath('\\\\fileserver\\share\\foo')).toBe(true)
  })

  it('treats relative paths and bare drive letters as relative', () => {
    expect(isAbsolutePath('src/foo.ts')).toBe(false)
    expect(isAbsolutePath('foo.ts')).toBe(false)
    expect(isAbsolutePath('C:foo.ts')).toBe(false) // bare drive, no sep → relative on Windows
    expect(isAbsolutePath('')).toBe(false)
  })
})

// ── resolveAbsolutePath ────────────────────────────────────────────

describe('resolveAbsolutePath', () => {
  it('joins a relative path under a Unix cwd', () => {
    expect(resolveAbsolutePath('/home/me/proj', 'src/components/Foo.tsx'))
      .toBe('/home/me/proj/src/components/Foo.tsx')
  })

  it('joins a relative path under a Windows cwd, normalising to backslash', () => {
    expect(resolveAbsolutePath('C:\\Users\\me\\proj', 'src/components/Foo.tsx'))
      .toBe('C:\\Users\\me\\proj\\src\\components\\Foo.tsx')
  })

  it('returns an already-absolute Unix path unchanged', () => {
    expect(resolveAbsolutePath('/home/me/proj', '/etc/hosts')).toBe('/etc/hosts')
  })

  it('returns an already-absolute path VERBATIM (no separator rewrite)', () => {
    // Absolute paths are returned as-is — rewriting `/` → `\` would corrupt a
    // Unix path like /etc/hosts into a UNC path (\etc\hosts) on a Windows cwd.
    // Windows accepts forward slashes, so C:/Users/me/foo.ts stays as-is.
    expect(resolveAbsolutePath('C:\\proj', 'C:/Users/me/foo.ts'))
      .toBe('C:/Users/me/foo.ts')
    expect(resolveAbsolutePath('C:\\proj', '/etc/hosts')).toBe('/etc/hosts')
    expect(resolveAbsolutePath('/home/me/proj', 'C:\\Windows\\system32'))
      .toBe('C:\\Windows\\system32')
  })

  it('trims a trailing separator on cwd before joining', () => {
    expect(resolveAbsolutePath('/home/me/proj/', 'src/foo.ts'))
      .toBe('/home/me/proj/src/foo.ts')
  })

  it('returns the raw path when cwd is missing (cannot fabricate a parent)', () => {
    expect(resolveAbsolutePath(undefined, 'src/foo.ts')).toBe('src/foo.ts')
    expect(resolveAbsolutePath(undefined, '/abs/foo.ts')).toBe('/abs/foo.ts')
  })

  it('returns cwd when path is empty', () => {
    expect(resolveAbsolutePath('/home/me/proj', '')).toBe('/home/me/proj')
  })
})
