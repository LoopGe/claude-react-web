import { describe, expect, it } from 'vitest'
import { PERMISSION_MODE_CYCLE, PERMISSION_MODES } from './types'

describe('frontend permission mode lists', () => {
  it('keeps dontAsk selectable but out of the keyboard cycle', () => {
    expect(PERMISSION_MODES).toContain('dontAsk')
    expect(PERMISSION_MODE_CYCLE).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
  })

  it('does not expose auto while the backend lacks an auto classifier', () => {
    expect(PERMISSION_MODES).not.toContain('auto')
    expect(PERMISSION_MODE_CYCLE).not.toContain('auto')
  })
})
