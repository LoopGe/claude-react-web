import { describe, it, expect } from 'vitest'
import { providerSupports, GATED_FEATURES } from './provider-capabilities.js'

describe('providerSupports (pre-create capability source)', () => {
  it('native locks hooks/memory/sandbox/account; both providers support plugins', () => {
    for (const f of ['plugins', 'hooks', 'memory', 'sandbox', 'account'] as const) {
      expect(providerSupports('native', f)).toBe(f === 'plugins')
      expect(providerSupports('claude', f)).toBe(true)
    }
  })

  it('pluginSkills is true for native and claude', () => {
    // Plugin-SKILL discovery is functional on both providers (native consumes
    // enabledPlugins to narrow its plugin-skill catalog). The roster pin below
    // keeps this a real map row, not the unknown-feature default.
    expect(providerSupports('native', 'pluginSkills')).toBe(true)
    expect(providerSupports('claude', 'pluginSkills')).toBe(true)
  })

  it('unknown/undefined provider defaults claude-compatible (legacy safety)', () => {
    for (const f of GATED_FEATURES) {
      expect(providerSupports(undefined, f)).toBe(true)
      expect(providerSupports('some-future-provider', f)).toBe(true)
      // Object.prototype key names must still hit the unknown-provider default
      // (a plain-object lookup would resolve these to prototype members).
      expect(providerSupports('constructor', f)).toBe(true)
      expect(providerSupports('__proto__', f)).toBe(true)
    }
  })

  it('exposes exactly the gated features', () => {
    expect([...GATED_FEATURES]).toEqual(['plugins', 'hooks', 'memory', 'sandbox', 'account', 'pluginSkills'])
  })
})
