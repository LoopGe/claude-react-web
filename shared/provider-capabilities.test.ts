import { describe, it, expect } from 'vitest'
import { providerSupports, GATED_FEATURES } from './provider-capabilities.js'

describe('providerSupports (pre-create capability source)', () => {
  it('native locks plugins/memory/sandbox/account; claude supports them', () => {
    for (const f of ['plugins', 'memory', 'sandbox', 'account'] as const) {
      expect(providerSupports('native', f)).toBe(false)
      expect(providerSupports('claude', f)).toBe(true)
    }
  })

  it('hooks is supported on both providers (native runs session-scoped hooks)', () => {
    // The native engine executes the session/flag hook config, so the surface
    // must not lock. Source coverage (settings files / plugins / agent
    // frontmatter) is a panel note, not a capability gate.
    expect(providerSupports('native', 'hooks')).toBe(true)
    expect(providerSupports('claude', 'hooks')).toBe(true)
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
