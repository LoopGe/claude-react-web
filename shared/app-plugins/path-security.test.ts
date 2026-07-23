import { describe, expect, it } from 'vitest'
import { isPathInside, validateRelativePath } from './path-security.js'

describe('validateRelativePath (posix)', () => {
  it('accepts a simple relative path', () => {
    expect(validateRelativePath('dist/service.mjs')).toBeNull()
    expect(validateRelativePath('ui/index.html')).toBeNull()
  })

  it('rejects absolute paths', () => {
    expect(validateRelativePath('/etc/passwd')).not.toBeNull()
    expect(validateRelativePath('/dist/service.mjs')).not.toBeNull()
  })

  it('rejects parent traversal', () => {
    expect(validateRelativePath('../escape.mjs')).not.toBeNull()
    expect(validateRelativePath('dist/../../escape.mjs')).not.toBeNull()
    // Conservative: ANY `..` segment is rejected, even one that net-resolves
    // inside the root (`a/../b` → `b`). Simpler + safer than partial resolve.
    expect(validateRelativePath('a/../b')).not.toBeNull()
  })

  it('rejects NUL', () => {
    expect(validateRelativePath('dist/service\0.mjs')).not.toBeNull()
  })
})

describe('validateRelativePath (windows)', () => {
  const win = { isWindows: true }

  it('accepts backslash-separated relative path', () => {
    expect(validateRelativePath('dist\\service.mjs', win)).toBeNull()
  })

  it('rejects drive-prefixed paths', () => {
    expect(validateRelativePath('C:\\evil.mjs', win)).not.toBeNull()
    expect(validateRelativePath('D:/evil.mjs', win)).not.toBeNull()
  })

  it('rejects UNC paths', () => {
    expect(validateRelativePath('\\\\share\\evil.mjs', win)).not.toBeNull()
    expect(validateRelativePath('//share/evil.mjs', win)).not.toBeNull()
  })

  it('rejects reserved device names', () => {
    expect(validateRelativePath('CON', win)).not.toBeNull()
    expect(validateRelativePath('NUL.txt', win)).not.toBeNull()
    expect(validateRelativePath('aux/foo', win)).not.toBeNull()
  })

  it('rejects forbidden chars', () => {
    expect(validateRelativePath('a:b.mjs', win)).not.toBeNull()
    expect(validateRelativePath('a<b.mjs', win)).not.toBeNull()
  })
})

describe('isPathInside', () => {
  it('true for a child and equal path', () => {
    expect(isPathInside('/state/app-plugins/data/com.x', '/state/app-plugins/data')).toBe(true)
    expect(isPathInside('/state/app-plugins/data', '/state/app-plugins/data')).toBe(true)
  })

  it('false for a sibling or parent', () => {
    expect(isPathInside('/state/app-plugins', '/state/app-plugins/data')).toBe(false)
    expect(isPathInside('/state/app-plugins/other', '/state/app-plugins/data')).toBe(false)
  })

  it('rejects prefix-but-not-segment tricks', () => {
    // /data-evil is NOT inside /data
    expect(isPathInside('/state/data-evil', '/state/data')).toBe(false)
  })

  it('windows case-insensitive + separators', () => {
    expect(
      isPathInside('C:\\State\\AppPlugins\\Data\\com.x', 'c:/state/appplugins/data', { isWindows: true }),
    ).toBe(true)
  })
})
