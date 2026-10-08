import { describe, expect, it } from 'vitest'
import { apiErrorToastOpts } from './useToast'

describe('apiErrorToastOpts', () => {
  it('returns { detail } when the error carries a hint', () => {
    expect(apiErrorToastOpts({ message: 'x', hint: 'Try this.' })).toEqual({ detail: 'Try this.' })
  })

  it('returns undefined when there is no hint — callers keep a single-line toast', () => {
    expect(apiErrorToastOpts(new Error('plain'))).toBeUndefined()
    expect(apiErrorToastOpts('string error')).toBeUndefined()
  })
})
