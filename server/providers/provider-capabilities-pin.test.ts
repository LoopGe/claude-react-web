import { describe, it, expect } from 'vitest'
import { providerSupports, LOCKED_FEATURES, type LockedFeature } from '../../shared/provider-capabilities.js'
import { ProviderRegistry } from './registry.js'
import { ClaudeProvider } from './claude/claude-provider.js'
import { NativeProvider } from './native/native-provider.js'
import { makeNativePorts } from './native-host-adapters.js'
import type { ProviderCapabilities } from './types.js'

/**
 * Consistency pin: the pre-create capability map
 * (`shared/provider-capabilities.ts`) must agree with the server's
 * `ProviderCapabilities` literals for every registered provider and every
 * locked feature. The map is a hand-maintained browser-safe copy (shared/ cannot
 * import the server), so this pin is what keeps the two from drifting — a flag
 * flipped on a provider without updating the map (or vice versa) reddens here.
 *
 * The concrete expected values (native false / claude true) are pinned by the
 * shared behavioral test and the providers' own capability tests; this file
 * pins AGREEMENT between the two sources.
 */

/** The ProviderCapabilities flag backing each locked feature. Typed exhaustively
 *  over LockedFeature so adding a feature forces a mapping here (compile error). */
const FLAG: Record<LockedFeature, keyof ProviderCapabilities> = {
  plugins: 'supportsPlugins',
  hooks: 'supportsHooks',
  memory: 'supportsMemory',
  sandbox: 'supportsSandbox',
  account: 'supportsAccountInfo',
}

describe('pre-create capability map agrees with ProviderCapabilities', () => {
  const registry = new ProviderRegistry()
  registry.register(new ClaudeProvider())
  registry.register(new NativeProvider({ ports: makeNativePorts() }))

  for (const provider of registry.list()) {
    for (const feature of LOCKED_FEATURES) {
      it(`${provider.name}.${feature}`, () => {
        expect(providerSupports(provider.name, feature)).toBe(provider.capabilities[FLAG[feature]])
      })
    }
  }
})
