import { describe, it, expect } from 'vitest'
import { coerceThinkingSetting } from './session-info.js'

describe('coerceThinkingSetting', () => {
  it('passes through the three valid variants', () => {
    expect(coerceThinkingSetting({ type: 'adaptive' })).toEqual({ type: 'adaptive' })
    expect(coerceThinkingSetting({ type: 'disabled' })).toEqual({ type: 'disabled' })
    expect(coerceThinkingSetting({ type: 'enabled', budgetTokens: 4096 }))
      .toEqual({ type: 'enabled', budgetTokens: 4096 })
    // Bare enabled (no budget) is valid — the client's menu always sends a
    // budget, but the create body may omit it.
    expect(coerceThinkingSetting({ type: 'enabled' })).toEqual({ type: 'enabled' })
  })

  it('rounds fractional budgets', () => {
    expect(coerceThinkingSetting({ type: 'enabled', budgetTokens: 8191.6 }))
      .toEqual({ type: 'enabled', budgetTokens: 8192 })
  })

  it('drops unknown / malformed values', () => {
    expect(coerceThinkingSetting(undefined)).toBeUndefined()
    expect(coerceThinkingSetting(null)).toBeUndefined()
    expect(coerceThinkingSetting('adaptive')).toBeUndefined()
    expect(coerceThinkingSetting(42)).toBeUndefined()
    expect(coerceThinkingSetting({})).toBeUndefined()
    expect(coerceThinkingSetting({ type: 'wild' })).toBeUndefined()
    // A present-but-invalid budget invalidates the whole value (silently
    // degrading to bare enabled would change the user's meaning).
    expect(coerceThinkingSetting({ type: 'enabled', budgetTokens: 0 })).toBeUndefined()
    expect(coerceThinkingSetting({ type: 'enabled', budgetTokens: -5 })).toBeUndefined()
    expect(coerceThinkingSetting({ type: 'enabled', budgetTokens: 'lots' })).toBeUndefined()
  })

  it('strips unknown extra keys (e.g. SDK display field)', () => {
    expect(coerceThinkingSetting({ type: 'adaptive', display: 'summarized' }))
      .toEqual({ type: 'adaptive' })
    expect(coerceThinkingSetting({ type: 'enabled', budgetTokens: 1024, display: 'omitted' }))
      .toEqual({ type: 'enabled', budgetTokens: 1024 })
  })
})
