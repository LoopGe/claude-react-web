import { describe, expect, it } from 'vitest'
import { cx } from './cx.js'

describe('cx', () => {
  it('joins truthy parts with spaces', () => {
    expect(cx('a', 'b', 'c')).toBe('a b c')
  })

  it('skips false/null/undefined/empty-string parts', () => {
    const off: boolean = false
    expect(cx('a', off && 'b', null, undefined, '', 'c')).toBe('a c')
  })

  it('flattens nested arrays', () => {
    const off: boolean = false
    expect(cx('a', ['b', off && 'c', ['d']])).toBe('a b d')
  })

  it('returns an empty string when nothing is truthy', () => {
    expect(cx(false, null, undefined, '')).toBe('')
  })
})
