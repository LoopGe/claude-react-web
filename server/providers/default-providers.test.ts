import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpConfigStore } from '../mcp-config.js'
import { createDefaultProviders } from './default-providers.js'
import type { NativeProvider } from './native/native-provider.js'

function nativeProvider(opts: Parameters<typeof createDefaultProviders>[0]): NativeProvider {
  return createDefaultProviders(opts).get('native') as NativeProvider
}

/** A real store on a temp dir with one OAuth-enabled remote server. */
async function seededStore() {
  const dir = await mkdtemp(join(tmpdir(), 'crw-default-providers-'))
  const store = new McpConfigStore({ stateDir: dir })
  await store.load()
  store.upsert({
    name: 'oauth-server',
    type: 'http',
    url: 'https://x',
    oauth: { redirectUrl: 'http://127.0.0.1:9/cb' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await store.flush()
  return { dir, store }
}

describe('createDefaultProviders native authFor wiring', () => {
  it('resolves an OAuth provider only for servers with stored oauth state', () => {
    const table: Record<string, unknown> = {
      'oauth-server': {
        name: 'oauth-server',
        type: 'http',
        url: 'https://x',
        oauth: { redirectUrl: 'http://127.0.0.1:9/cb' },
      },
      plain: { name: 'plain', type: 'stdio', command: 'node' },
    }
    const store = { get: vi.fn((n: string) => table[n]) } as unknown as McpConfigStore
    const provider = nativeProvider({ mcpStore: store })

    expect(provider.authFor).toBeTypeOf('function')
    expect(provider.authFor?.('oauth-server')).toBeDefined()
    expect(provider.authFor?.('plain')).toBeUndefined()
    expect(provider.authFor?.('missing')).toBeUndefined()
  })

  it('leaves authFor undefined when no MCP store is configured', () => {
    const provider = nativeProvider({})

    expect(provider.authFor).toBeUndefined()
  })
})

describe('createDefaultProviders native OAuth persistence', () => {
  it('persists tokens saved through the resolved provider', async () => {
    const { dir, store } = await seededStore()
    try {
      const provider = nativeProvider({ mcpStore: store })
      provider.authFor?.('oauth-server')?.saveTokens({ access_token: 'tok', token_type: 'Bearer' })

      // onTokensSaved queues the write; flush() is a no-op once the store is
      // no longer dirty, so poll until the queued atomic write lands.
      await vi.waitFor(async () => {
        const raw = JSON.parse(await readFile(join(dir, 'mcp-config.json'), 'utf8'))
        expect(raw['oauth-server'].oauth.tokens.access_token).toBe('tok')
        expect(raw['oauth-server'].oauth.lastAuthorizedAt).toBeTypeOf('number')
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not re-insert a server deleted after the provider was resolved', async () => {
    const { dir, store } = await seededStore()
    try {
      const provider = nativeProvider({ mcpStore: store })
      const auth = provider.authFor?.('oauth-server')
      expect(auth).toBeDefined()

      store.remove('oauth-server')
      await store.flush()
      auth?.saveTokens({ access_token: 'tok', token_type: 'Bearer' })

      const raw = JSON.parse(await readFile(join(dir, 'mcp-config.json'), 'utf8'))
      expect(raw['oauth-server']).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
