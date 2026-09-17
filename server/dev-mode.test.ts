import { describe, expect, it } from 'vitest'
import { isDevRuntime } from './dev-mode.js'

describe('isDevRuntime', () => {
  it('is true for a .ts / .tsx entry (npm run dev:server, direct tsx)', () => {
    expect(isDevRuntime('C:\\codes\\claude-react-web\\server\\cli.ts', {})).toBe(true)
    expect(isDevRuntime('/repo/server/cli.tsx', {})).toBe(true)
  })

  it('is true from source even when npm reports a non-dev lifecycle', () => {
    expect(isDevRuntime('/repo/server/cli.ts', { npm_lifecycle_event: 'start' })).toBe(true)
  })

  it('is true for an npm dev/dev:* lifecycle even without a .ts entry', () => {
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'dev' })).toBe(true)
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'dev:server' })).toBe(true)
  })

  it('is FALSE for the bundled .mjs entry — the published path', () => {
    expect(
      isDevRuntime('C:\\x\\node_modules\\claude-react-web\\dist\\cli.mjs', {
        npm_lifecycle_event: 'start',
      }),
    ).toBe(false)
    expect(isDevRuntime('/repo/dist/cli.mjs', {})).toBe(false)
  })

  it('is FALSE for npm run start / preview (lifecycle set, but not dev)', () => {
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'start' })).toBe(false)
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'preview' })).toBe(false)
  })

  it('does not treat a dev-PREFIXED script as dev', () => {
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'developed' })).toBe(false)
  })

  it('is false when argv[1] is undefined and no lifecycle is set', () => {
    expect(isDevRuntime(undefined, {})).toBe(false)
  })
})
