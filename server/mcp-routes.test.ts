import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { buildMcpConfigRouter } from './mcp-routes.js'
import { McpConfigStore, type StoredMcpServer } from './mcp-config.js'
import { tempDir, json } from './__test-utils__/index.js'

function makeServer(overrides: Partial<StoredMcpServer> = {}): StoredMcpServer {
  return {
    name: 'test-server',
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('mcp-config routes', () => {
  let dir: string
  let store: McpConfigStore

  beforeEach(async () => {
    dir = tempDir('mcp-routes')
    store = new McpConfigStore({ stateDir: dir })
    await store.load()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function app() {
    return buildMcpConfigRouter(store)
  }

  // -------------------------------------------------------------------
  // GET /
  // -------------------------------------------------------------------
  describe('GET /', () => {
    it('returns empty list when no servers configured', async () => {
      const res = await app().request('/')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.servers).toEqual([])
    })

    it('returns all servers with secrets masked', async () => {
      store.upsert(makeServer({ name: 'a', env: { TOKEN: 'secret' } }))
      store.upsert(makeServer({ name: 'b', headers: { Auth: 'Bearer xyz' } }))
      await store.flush()

      const res = await app().request('/')
      const body = await json(res)
      const servers = body.servers as Array<Record<string, unknown>>
      expect(servers).toHaveLength(2)
      // Secrets stripped
      expect(servers.every((s) => !('env' in s))).toBe(true)
      expect(servers.every((s) => !('headers' in s))).toBe(true)
      // Keys preserved
      const a = servers.find((s) => s.name === 'a')!
      expect(a.envKeys).toEqual(['TOKEN'])
      const b = servers.find((s) => s.name === 'b')!
      expect(b.headerKeys).toEqual(['Auth'])
    })
  })

  // -------------------------------------------------------------------
  // GET /:name
  // -------------------------------------------------------------------
  describe('GET /:name', () => {
    it('returns 404 for unknown server', async () => {
      const res = await app().request('/nonexistent')
      expect(res.status).toBe(404)
      const body = await json(res)
      expect(body.error).toContain('not found')
    })

    it('returns a single server with secrets masked', async () => {
      store.upsert(makeServer({ name: 'my-srv', env: { K: 'v' } }))
      await store.flush()

      const res = await app().request('/my-srv')
      expect(res.status).toBe(200)
      const body = await json(res)
      const server = body.server as Record<string, unknown>
      expect(server.name).toBe('my-srv')
      expect(server).not.toHaveProperty('env')
      expect(server.envKeys).toEqual(['K'])
    })
  })

  // -------------------------------------------------------------------
  // POST /
  // -------------------------------------------------------------------
  describe('POST /', () => {
    it('creates a new stdio server', async () => {
      const res = await app().request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'new-srv', type: 'stdio', command: 'npx', args: ['-y', 'serve'] }),
      })
      expect(res.status).toBe(201)
      const body = await json(res)
      const server = body.server as Record<string, unknown>
      expect(server.name).toBe('new-srv')
      expect(server.type).toBe('stdio')
      expect(server.command).toBe('npx')

      // Verify persisted
      expect(store.get('new-srv')).toBeDefined()
    })

    it('creates a new sse server', async () => {
      const res = await app().request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'sse-srv', type: 'sse', url: 'http://localhost:3000' }),
      })
      expect(res.status).toBe(201)
      const body = await json(res)
      expect((body.server as Record<string, unknown>).type).toBe('sse')
    })

    it('returns 400 when name is missing', async () => {
      const res = await app().request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'stdio', command: 'node' }),
      })
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toContain('name')
    })

    it('returns 409 when server already exists', async () => {
      store.upsert(makeServer({ name: 'dup' }))
      await store.flush()

      const res = await app().request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'dup', command: 'node' }),
      })
      expect(res.status).toBe(409)
      const body = await json(res)
      expect(body.error).toContain('already exists')
    })

    it('returns 400 when validation fails (stdio without command)', async () => {
      const res = await app().request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'bad' }),
      })
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toContain('command')
    })

    it('returns 400 for invalid JSON body', async () => {
      const res = await app().request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })

  // -------------------------------------------------------------------
  // PUT /:name
  // -------------------------------------------------------------------
  describe('PUT /:name', () => {
    it('returns 404 for unknown server', async () => {
      const res = await app().request('/nonexistent', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'new' }),
      })
      expect(res.status).toBe(404)
    })

    it('updates mutable fields', async () => {
      store.upsert(makeServer({ name: 'u', command: 'old', args: ['a'] }))
      await store.flush()

      const res = await app().request('/u', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'new', args: ['b', 'c'] }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const server = body.server as Record<string, unknown>
      expect(server.command).toBe('new')
      expect(server.args).toEqual(['b', 'c'])
    })

    it('merges env (not replaces)', async () => {
      store.upsert(makeServer({ name: 'u', env: { KEEP: 'old', OVERWRITE: 'old' } }))
      await store.flush()

      const res = await app().request('/u', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env: { OVERWRITE: 'new', ADDED: 'fresh' } }),
      })
      expect(res.status).toBe(200)

      // Check the stored value directly (not the masked response)
      const stored = store.get('u')!
      expect(stored.env).toEqual({ KEEP: 'old', OVERWRITE: 'new', ADDED: 'fresh' })
    })

    it('merges headers (not replaces)', async () => {
      store.upsert(makeServer({ name: 'u', type: 'sse', url: 'http://x', headers: { Existing: 'val' } }))
      await store.flush()

      await app().request('/u', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ headers: { New: 'val2' } }),
      })

      const stored = store.get('u')!
      expect(stored.headers).toEqual({ Existing: 'val', New: 'val2' })
    })

    it('validates updated config and returns 400 on failure', async () => {
      store.upsert(makeServer({ name: 'u', command: 'node' }))
      await store.flush()

      // Change to sse without url
      const res = await app().request('/u', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'sse' }),
      })
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toContain('url')
    })
  })

  // -------------------------------------------------------------------
  // DELETE /:name
  // -------------------------------------------------------------------
  describe('DELETE /:name', () => {
    it('returns 404 for unknown server', async () => {
      const res = await app().request('/nonexistent', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })

    it('removes an existing server', async () => {
      store.upsert(makeServer({ name: 'del' }))
      await store.flush()

      const res = await app().request('/del', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.ok).toBe(true)
      expect(store.get('del')).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------
  // POST /:name/toggle
  // -------------------------------------------------------------------
  describe('POST /:name/toggle', () => {
    it('returns 404 for unknown server', async () => {
      const res = await app().request('/nonexistent/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      expect(res.status).toBe(404)
    })

    it('disables an enabled server', async () => {
      store.upsert(makeServer({ name: 't', enabled: true }))
      await store.flush()

      const res = await app().request('/t/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect((body.server as Record<string, unknown>).enabled).toBe(false)
      expect(store.get('t')?.enabled).toBe(false)
    })

    it('enables a disabled server', async () => {
      store.upsert(makeServer({ name: 't', enabled: false }))
      await store.flush()

      const res = await app().request('/t/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      expect(res.status).toBe(200)
      expect((store.get('t'))?.enabled).toBe(true)
    })

    it('returns 400 when enabled is not a boolean', async () => {
      store.upsert(makeServer({ name: 't' }))
      await store.flush()

      const res = await app().request('/t/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      })
      expect(res.status).toBe(400)
    })
  })

  // -------------------------------------------------------------------
  // OAuth metadata routes
  // -------------------------------------------------------------------
  describe('DELETE /:name/auth', () => {
    it('clears stored OAuth credentials and keeps them masked in the response', async () => {
      store.upsert(makeServer({
        name: 'remote',
        type: 'http',
        url: 'http://localhost:9999',
        oauth: {
          tokens: { access_token: 'secret', token_type: 'Bearer' },
          lastAuthorizedAt: 1_700_000_000_001,
        },
      }))
      await store.flush()

      const res = await app().request('/remote/auth', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = await json(res)
      const server = body.server as Record<string, unknown>
      expect(server).not.toHaveProperty('oauth')
      expect(server.oauthAuthorized).toBeUndefined()
      expect(store.get('remote')?.oauth).toBeUndefined()
    })
  })

  describe('GET /oauth/callback', () => {
    it('rejects mismatched OAuth state before exchanging a code', async () => {
      store.upsert(makeServer({
        name: 'remote',
        type: 'http',
        url: 'http://localhost:9999',
        oauth: { state: 'expected' },
      }))
      await store.flush()

      const res = await app().request('/oauth/callback?server=remote&code=abc&state=wrong')
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('Authorization state did not match')
    })
  })

  // -------------------------------------------------------------------
  // POST /validate
  // -------------------------------------------------------------------
  describe('POST /validate', () => {
    it('returns {valid: true} for a valid config', async () => {
      const res = await app().request('/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'v', type: 'stdio', command: 'node' }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.valid).toBe(true)
      expect(body.errors).toEqual([])
    })

    it('returns {valid: false} with errors for invalid config', async () => {
      const res = await app().request('/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'sse' }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.valid).toBe(false)
      expect((body.errors as string[]).length).toBeGreaterThan(0)
    })

    it('returns 400 for invalid JSON', async () => {
      const res = await app().request('/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })
})
