import { describe, expect, it } from 'vitest'
import { PERMISSION_MODE_CYCLE, PERMISSION_MODES } from './types'

describe('frontend permission mode lists', () => {
  it('keeps dontAsk and auto selectable but out of the keyboard cycle', () => {
    expect(PERMISSION_MODES).toContain('dontAsk')
    expect(PERMISSION_MODES).toContain('auto')
    expect(PERMISSION_MODE_CYCLE).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    expect(PERMISSION_MODE_CYCLE).not.toContain('auto')
    expect(PERMISSION_MODE_CYCLE).not.toContain('dontAsk')
  })
})
