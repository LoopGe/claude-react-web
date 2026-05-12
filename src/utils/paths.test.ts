import { describe, it, expect } from 'vitest'
import { shortenPath } from './paths'

describe('shortenPath', () => {
  it('returns short paths unchanged', () => {
    expect(shortenPath('/home/user/project')).toBe('/home/user/project')
  })

  it('returns paths <= 36 chars unchanged', () => {
    const p = '/a/b/c/d/e/f/g/h/i/j' // 21 chars
    expect(shortenPath(p)).toBe(p)
  })

  it('collapses long Unix paths to last two segments', () => {
    const p = '/home/user/very/long/nested/project/src/components'
    const result = shortenPath(p)
    expect(result).toBe('…/src/components')
  })

  it('collapses long Windows paths to last two segments', () => {
    const p = 'C:\\Users\\developer\\projects\\my-app\\src\\components'
    const result = shortenPath(p)
    expect(result).toContain('src')
    expect(result).toContain('components')
    // Should not contain the full path.
    expect(result.length).toBeLessThan(p.length)
  })

  it('preserves Windows separator in output', () => {
    const p = 'D:\\alpha\\bravo\\charlie\\delta\\echo\\foxtrot\\golf\\hotel'
    expect(p.length).toBeGreaterThan(36)
    const result = shortenPath(p)
    // Backslash-separated path uses backslash in output.
    const parts = result.split('\\')
    expect(parts.length).toBe(3) // '…', last-1, last
  })

  it('preserves Unix separator in output', () => {
    const p = '/alpha/bravo/charlie/delta/echo/foxtrot/golf/hotel'
    expect(p.length).toBeGreaterThan(36)
    const result = shortenPath(p)
    // Slash-separated path uses slash in output.
    const parts = result.split('/')
    expect(parts.length).toBe(3) // '…', last-1, last
  })

  it('returns short paths with <= 3 segments unchanged even if long', () => {
    // split('/') on "/a/b/c" gives ['','a','b','c'] = 4 parts > 3, so it IS shortened.
    // But a path with exactly 3 segments total (e.g. "aaa/bbb/ccc" without leading slash)
    // stays unchanged.
    const longSeg = 'a'.repeat(20)
    const p = `${longSeg}/${longSeg}/${longSeg}`
    expect(p.length).toBeGreaterThan(36)
    // 3 segments (no leading empty from /) → parts.length = 3 → returned as-is
    expect(shortenPath(p)).toBe(p)
  })

  it('handles empty string', () => {
    expect(shortenPath('')).toBe('')
  })

  it('handles root path', () => {
    expect(shortenPath('/')).toBe('/')
  })
})
