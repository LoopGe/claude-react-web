import { describe, it, expect } from 'vitest'
import { providerSupports, LOCKED_FEATURES } from './provider-capabilities.js'

describe('providerSupports (pre-create capability source)', () => {
  it('native locks the five features; claude supports them', () => {
    for (const f of LOCKED_FEATURES) {
      expect(providerSupports('native', f)).toBe(false)
      expect(providerSupports('claude', f)).toBe(true)
    }
  })

  it('unknown/undefined provider defaults claude-compatible (legacy safety)', () => {
    for (const f of LOCKED_FEATURES) {
      expect(providerSupports(undefined, f)).toBe(true)
      expect(providerSupports('some-future-provider', f)).toBe(true)
      // Object.prototype key names must still hit the unknown-provider default
      // (a plain-object lookup would resolve these to prototype members).
      expect(providerSupports('constructor', f)).toBe(true)
      expect(providerSupports('__proto__', f)).toBe(true)
    }
  })

  it('exposes exactly the five locked features', () => {
    expect([...LOCKED_FEATURES]).toEqual(['plugins', 'hooks', 'memory', 'sandbox', 'account'])
  })
})
