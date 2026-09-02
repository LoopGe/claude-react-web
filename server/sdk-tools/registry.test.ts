import { describe, expect, it, vi } from 'vitest'
import { FirstPartyToolRegistry } from './registry.js'
import { firstPartyRegistry } from './registry.js'
import type { FirstPartyToolServer } from './types.js'
import { APP_TOOLS_SERVER_NAME, APP_TOOLS_READ_ONLY_TOOLS, APP_TOOLS_MUTATING_TOOLS } from './app-tools.js'

function makeServer(name = 'srv'): FirstPartyToolServer {
  return {
    name,
    description: `desc ${name}`,
    defaultEnabled: true,
    requiresCwd: false,
    buildTools: () => [],
    readOnlyToolNames: new Set([`${name}_ro`]),
    mutatingToolNames: new Set([`${name}_mut`]),
  }
}

describe('FirstPartyToolRegistry', () => {
  it('registers, gets and lists servers; rejects duplicates', () => {
    const r = new FirstPartyToolRegistry()
    r.register(makeServer('a'))
    r.register(makeServer('b'))
    expect(r.get('a')?.name).toBe('a')
    expect(r.get('nope')).toBeUndefined()
    expect(r.list().map((s) => s.name)).toEqual(['a', 'b'])
    expect(() => r.register(makeServer('a'))).toThrow(/already registered/i)
  })

  it('derives FQN sets with the mcp__{server}__ prefix (bare names in, FQNs out)', () => {
    const r = new FirstPartyToolRegistry()
    r.register(makeServer('a'))
    r.register(makeServer('b'))
    expect(r.readOnlyToolFqns()).toEqual(new Set(['mcp__a__a_ro', 'mcp__b__b_ro']))
    expect(r.mutatingToolFqns()).toEqual(new Set(['mcp__a__a_mut', 'mcp__b__b_mut']))
  })

  it('injectAll builds only enabled servers that satisfy requiresCwd', () => {
    const r = new FirstPartyToolRegistry()
    const built = vi.fn(() => [])
    r.register({ ...makeServer('needs-cwd'), requiresCwd: true, buildTools: built })
    r.register({ ...makeServer('no-cwd-needed') })
    r.register({ ...makeServer('disabled'), defaultEnabled: false })

    const enabled = (n: string) => r.get(n)!.defaultEnabled
    // No cwd: needs-cwd skipped, no-cwd-needed injected.
    let map = r.injectAll(null, enabled)
    expect(map).toEqual({ 'no-cwd-needed': expect.anything() })
    // With cwd: needs-cwd injected too; disabled still skipped.
    map = r.injectAll('/repo', enabled)
    expect(Object.keys(map!)).toEqual(['needs-cwd', 'no-cwd-needed'])
    expect(built).toHaveBeenCalledWith('/repo')
  })

  it('injectAll reports per-server build failures via onError and skips only that server', () => {
    const r = new FirstPartyToolRegistry()
    const boom = () => { throw new Error('boom') }
    r.register({ ...makeServer('bad'), buildTools: boom })
    r.register(makeServer('good'))
    const onError = vi.fn()
    const map = r.injectAll('/repo', () => true, onError)
    expect(onError).toHaveBeenCalledWith('bad', 'boom')
    expect(map).toEqual({ good: expect.anything() })
  })

  it('the singleton registers the git apptools server', () => {
    expect(firstPartyRegistry.get(APP_TOOLS_SERVER_NAME)).toBeDefined()
    const names = firstPartyRegistry.list().map((s) => s.name)
    expect(names).toContain(APP_TOOLS_SERVER_NAME)
    const git = firstPartyRegistry.get(APP_TOOLS_SERVER_NAME)!
    expect(git.requiresCwd).toBe(true)
    expect(git.defaultEnabled).toBe(true)
    // Bare-name sets — FQN derivation prefixes them.
    expect(git.readOnlyToolNames).toEqual(APP_TOOLS_READ_ONLY_TOOLS)
    expect(git.mutatingToolNames).toEqual(APP_TOOLS_MUTATING_TOOLS)
    expect(firstPartyRegistry.mutatingToolFqns()).toContain('mcp__apptools__git_stage')
    expect(firstPartyRegistry.readOnlyToolFqns()).toContain('mcp__apptools__git_status')
  })
})