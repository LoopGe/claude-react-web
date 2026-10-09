import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDevRuntime, enableDevMode } from './dev-mode.js'
import { FirstPartyToolRegistry } from './sdk-tools/registry.js'
import { DEBUG_TOOLS_SERVER_NAME, type DebugHost } from './sdk-tools/app-debug.js'
import { HISTORY_TOOLS_SERVER_NAME } from './sdk-tools/history-tools.js'
import type { HistoryHost } from './sdk-tools/history-tools.js'
import { disableLogRing, isLogRingEnabled } from './log.js'

/** A DebugHost & HistoryHost whose methods are never called by these
 *  assertions. */
function fakeHost(): DebugHost & HistoryHost {
  return {
    debugSessions: vi.fn(() => []),
    debugSession: vi.fn(async () => ({}) as never),
    setCliDebug: vi.fn(async () => ({})),
    send: vi.fn(async () => {}),
    clientDebugRequest: vi.fn(async () => ({})),
    list: vi.fn(() => []),
    searchMessages: vi.fn(async () => []),
    getHistoryPage: vi.fn(async () => ({ messages: [], totalCount: 0, startIndex: 0, hasMore: false })),
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

  it('enables the ring and registers the appdebug + history-tools servers', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost(), ringCapacity: 7 })
    expect(isLogRingEnabled()).toBe(true)
    expect(registry.get(DEBUG_TOOLS_SERVER_NAME)?.name).toBe(DEBUG_TOOLS_SERVER_NAME)
    expect(registry.get(HISTORY_TOOLS_SERVER_NAME)?.name).toBe(HISTORY_TOOLS_SERVER_NAME)
    expect(registry.list()).toHaveLength(2)
  })

  it('registers the 7 read tools as read-only and injects with no cwd', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost() })
    const server = registry.get(DEBUG_TOOLS_SERVER_NAME)!
    expect([...server.readOnlyToolNames!].sort()).toEqual([
      'dom_computed_styles', 'dom_query', 'dom_screenshot', 'logs', 'metrics', 'session', 'sessions',
    ])
    // requiresCwd:false → injected even without a cwd.
    const injected = registry.injectAll(null, (n) => n === DEBUG_TOOLS_SERVER_NAME)
    expect(Object.keys(injected ?? {})).toEqual([DEBUG_TOOLS_SERVER_NAME])
  })

  it('is idempotent — a second call does not re-register', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost() })
    expect(() => enableDevMode({ registry, sm: fakeHost() })).not.toThrow()
    expect(registry.list()).toHaveLength(2)
    expect(isLogRingEnabled()).toBe(true)
  })

  it('registers the 3 history tools as read-only and injects with no cwd', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost() })
    const server = registry.get(HISTORY_TOOLS_SERVER_NAME)!
    expect([...server.readOnlyToolNames!].sort()).toEqual([
      'history_list_sessions', 'history_read_context', 'history_search',
    ])
    // requiresCwd:false → injected even without a cwd.
    const injected = registry.injectAll(null, (n) => n === HISTORY_TOOLS_SERVER_NAME)
    expect(Object.keys(injected ?? {})).toEqual([HISTORY_TOOLS_SERVER_NAME])
  })
})
