import { describe, it, expect } from 'vitest'
import { coerceThinkingSetting, firstPartyOverridesForCreate } from './session-info.js'

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

  it('narrows the display field on adaptive/enabled variants', () => {
    expect(coerceThinkingSetting({ type: 'adaptive', display: 'summarized' }))
      .toEqual({ type: 'adaptive', display: 'summarized' })
    expect(coerceThinkingSetting({ type: 'adaptive', display: 'omitted' }))
      .toEqual({ type: 'adaptive', display: 'omitted' })
    expect(coerceThinkingSetting({ type: 'enabled', budgetTokens: 1024, display: 'omitted' }))
      .toEqual({ type: 'enabled', budgetTokens: 1024, display: 'omitted' })
    // Bare enabled can carry a display too.
    expect(coerceThinkingSetting({ type: 'enabled', display: 'summarized' }))
      .toEqual({ type: 'enabled', display: 'summarized' })
  })

  it('drops display on disabled (SDK ThinkingDisabled omits the field)', () => {
    expect(coerceThinkingSetting({ type: 'disabled', display: 'omitted' }))
      .toEqual({ type: 'disabled' })
  })

  it('strips an invalid display value (setting kept — persistence must not lose the intent)', () => {
    expect(coerceThinkingSetting({ type: 'adaptive', display: 'redacted' }))
      .toEqual({ type: 'adaptive' })
    expect(coerceThinkingSetting({ type: 'adaptive', display: 1 }))
      .toEqual({ type: 'adaptive' })
    expect(coerceThinkingSetting({ type: 'enabled', budgetTokens: 1024, display: null }))
      .toEqual({ type: 'enabled', budgetTokens: 1024 })
  })
})

describe('firstPartyOverridesForCreate', () => {
  it('carries boolean overrides through', () => {
    expect(firstPartyOverridesForCreate({ firstPartyTools: { 'git-tools': false, other: true } }))
      .toEqual({ 'git-tools': false, other: true })
  })

  it('drops null entries (live-session "inherit" markers, not create-body values)', () => {
    expect(firstPartyOverridesForCreate({ firstPartyTools: { 'git-tools': null } })).toBeUndefined()
  })

  it('folds the legacy appToolsGit boolean into the git-tools entry', () => {
    expect(firstPartyOverridesForCreate({ appToolsGit: false })).toEqual({ 'git-tools': false })
    // True is an explicit ON pin too (global default may be OFF) — preserve it.
    expect(firstPartyOverridesForCreate({ appToolsGit: true })).toEqual({ 'git-tools': true })
  })

  it('lets the structured map win over the legacy boolean', () => {
    expect(firstPartyOverridesForCreate({ appToolsGit: false, firstPartyTools: { 'git-tools': true } }))
      .toEqual({ 'git-tools': true })
  })

  it('migrates a pre-rename apptools key to git-tools', () => {
    expect(firstPartyOverridesForCreate({ firstPartyTools: { apptools: false } }))
      .toEqual({ 'git-tools': false })
  })

  it('lets an explicit null on git-tools win over a legacy apptools pin', () => {
    // null is the live-session inherit marker — migration must not treat it
    // as absent and resurrect the legacy false.
    expect(firstPartyOverridesForCreate({ firstPartyTools: { 'git-tools': null, apptools: false } }))
      .toBeUndefined()
  })

  it('returns undefined when there is nothing to preserve', () => {
    expect(firstPartyOverridesForCreate({})).toBeUndefined()
    expect(firstPartyOverridesForCreate({ firstPartyTools: {} })).toBeUndefined()
  })
})
