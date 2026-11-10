import { describe, it, expect, vi } from 'vitest'
import type { McpConfigStore } from '../mcp-config.js'
import { createDefaultProviders } from './default-providers.js'
import type { NativeProvider } from './native/native-provider.js'

function makeStore() {
  const table: Record<string, unknown> = {
    'oauth-server': {
      name: 'oauth-server',
      type: 'http',
      url: 'https://x',
      oauth: { redirectUrl: 'http://127.0.0.1:9/cb' },
    },
    plain: { name: 'plain', type: 'stdio', command: 'node' },
  }
  const get = vi.fn((n: string) => table[n])
  const flush = vi.fn(async () => {})
  const store = { get, flush } as unknown as McpConfigStore
  return { store, get, flush }
}

function nativeProvider(opts: Parameters<typeof createDefaultProviders>[0]): NativeProvider {
  return createDefaultProviders(opts).get('native') as NativeProvider
}

describe('createDefaultProviders native authFor wiring', () => {
  it('resolves an OAuth provider only for servers with stored oauth state', () => {
    const { store } = makeStore()
    const provider = nativeProvider({ mcpStore: store })

    expect(provider.authFor).toBeTypeOf('function')
    expect(provider.authFor?.('oauth-server')).toBeDefined()
    expect(provider.authFor?.('plain')).toBeUndefined()
    expect(provider.authFor?.('missing')).toBeUndefined()
  })

  it('flushes the MCP store when the provider saves tokens', () => {
    const { store, flush } = makeStore()
    const provider = nativeProvider({ mcpStore: store })

    provider.authFor?.('oauth-server')?.saveTokens({ access_token: 't', token_type: 'Bearer' })

    expect(flush).toHaveBeenCalled()
  })

  it('leaves authFor undefined when no MCP store is configured', () => {
    const provider = nativeProvider({})

    expect(provider.authFor).toBeUndefined()
  })
})