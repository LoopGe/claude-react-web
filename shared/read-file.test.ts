import { describe, expect, it } from 'vitest'
import { coerceReadFileOutput } from './read-file.js'

describe('coerceReadFileOutput', () => {
  it('passes through a well-formed success result', () => {
    expect(coerceReadFileOutput({ contents: 'hello' })).toEqual({
      available: true,
      contents: 'hello',
    })
  })

  it('keeps truncated and encoding fields when type-correct', () => {
    expect(coerceReadFileOutput({
      contents: 'hi',
      truncated: true,
      encoding: 'base64',
    })).toEqual({ available: true, contents: 'hi', truncated: true, encoding: 'base64' })
  })

  it('accepts an empty contents string as available', () => {
    expect(coerceReadFileOutput({ contents: '' })).toEqual({ available: true, contents: '' })
  })

  it('treats null (SDK denial/missing) as unavailable', () => {
    expect(coerceReadFileOutput(null)).toEqual({ available: false })
    expect(coerceReadFileOutput(undefined)).toEqual({ available: false })
  })

  it('collapses entirely malformed input to available:false', () => {
    expect(coerceReadFileOutput('ok')).toEqual({ available: false })
    expect(coerceReadFileOutput(42)).toEqual({ available: false })
  })

  it('ignores a non-string contents field', () => {
    expect(coerceReadFileOutput({ contents: 42 })).toEqual({ available: false })
  })

  it('drops unknown keys and invalid optional fields', () => {
    expect(coerceReadFileOutput({ contents: 'x', extra: 'junk', nested: { a: 1 } }))
      .toEqual({ available: true, contents: 'x' })
    expect(coerceReadFileOutput({ contents: 'x', truncated: 'yes', encoding: 'latin1' }))
      .toEqual({ available: true, contents: 'x' })
  })
})