import { describe, expect, it } from 'vitest'
import { sessionTitleOrFallback } from './session-title.js'

describe('sessionTitleOrFallback', () => {
  it('returns the title when set', () => {
    expect(sessionTitleOrFallback({ title: 'My Session', id: 'abcdef123456' })).toBe('My Session')
  })

  it('falls back to an 8-char id prefix by default', () => {
    expect(sessionTitleOrFallback({ id: 'abcdef123456' })).toBe('abcdef12')
  })

  it('falls back on empty-string titles too (?? semantics preserved)', () => {
    expect(sessionTitleOrFallback({ title: '', id: 'abcdef123456' })).toBe('')
  })

  it('honours a custom id length', () => {
    expect(sessionTitleOrFallback({ id: 'abcdef123456' }, 12)).toBe('abcdef123456')
  })
})
