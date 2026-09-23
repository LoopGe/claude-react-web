import { describe, expect, it } from 'vitest'
import { formatError } from './format-error.js'

describe('formatError', () => {
  it('returns the message for Error instances', () => {
    expect(formatError(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error values', () => {
    expect(formatError('plain')).toBe('plain')
    expect(formatError(42)).toBe('42')
  })
})
