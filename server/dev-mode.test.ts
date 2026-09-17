import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDevRuntime, enableDevMode } from './dev-mode.js'
import { FirstPartyToolRegistry } from './sdk-tools/registry.js'
import { DEBUG_TOOLS_SERVER_NAME, type DebugHost } from './sdk-tools/app-debug.js'
import { disableLogRing, isLogRingEnabled } from './log.js'

/** A DebugHost whose methods are never called by these assertions. */
function fakeHost(): DebugHost {
  return {
    debugSessions: vi.fn(() => []),
    debugSession: vi.fn(async () => ({}) as never),
    setCliDebug: vi.fn(async () => ({})),
    send: vi.fn(async () => {}),
  }
}

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

describe('enableDevMode', () => {
  afterEach(() => disableLogRing())

  it('enables the ring and registers the appdebug server', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost(), ringCapacity: 7 })
    expect(isLogRingEnabled()).toBe(true)
    expect(registry.get(DEBUG_TOOLS_SERVER_NAME)?.name).toBe(DEBUG_TOOLS_SERVER_NAME)
    expect(registry.list()).toHaveLength(1)
  })

  it('registers the 4 read tools as read-only and injects with no cwd', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost() })
    const server = registry.get(DEBUG_TOOLS_SERVER_NAME)!
    expect([...server.readOnlyToolNames!].sort()).toEqual(['logs', 'metrics', 'session', 'sessions'])
    // requiresCwd:false → injected even without a cwd.
    const injected = registry.injectAll(null, (n) => n === DEBUG_TOOLS_SERVER_NAME)
    expect(Object.keys(injected ?? {})).toEqual([DEBUG_TOOLS_SERVER_NAME])
  })

  it('is idempotent — a second call does not re-register', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost() })
    expect(() => enableDevMode({ registry, sm: fakeHost() })).not.toThrow()
    expect(registry.list()).toHaveLength(1)
    expect(isLogRingEnabled()).toBe(true)
  })
})
