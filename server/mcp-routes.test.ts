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
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
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
      store.upsert(makeServer({ name: 'u', command: 'node', args: ['a'] }))
      await store.flush()

      const res = await app().request('/u', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'python', args: ['b', 'c'] }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const server = body.server as Record<string, unknown>
      expect(server.command).toBe('python')
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
  // GET /export
  // -------------------------------------------------------------------
  describe('GET /export', () => {
    it('masks env/headers by default and never includes oauth', async () => {
      store.upsert(makeServer({
        name: 'git', command: 'npx', args: ['-y', 'server-git'],
        env: { TOKEN: 'secret' },
      }))
      store.upsert(makeServer({
        name: 'remote', type: 'http', url: 'http://localhost:9999',
        headers: { Auth: 'Bearer xyz' },
        oauth: { tokens: { access_token: 'tok', token_type: 'Bearer' } },
      }))
      await store.flush()

      const res = await app().request('/export')
      expect(res.status).toBe(200)
      const body = await json(res) as Record<string, unknown>
      expect(body.format).toBe('claude-react-web-mcp')
      expect(body.version).toBe(1)
      expect(body.secretScope).toBe('masked')
      const servers = body.servers as Array<Record<string, unknown>>
      expect(servers).toHaveLength(2)
      const git = servers.find((s) => s.name === 'git')!
      expect(git.env).toEqual({ TOKEN: '' })
      expect(git).not.toHaveProperty('oauth')
      expect(git).not.toHaveProperty('createdAt')
      const remote = servers.find((s) => s.name === 'remote')!
      expect(remote.headers).toEqual({ Auth: '' })
      expect(remote).not.toHaveProperty('oauth')
    })

    it('includes real env/headers when includeSecrets=1', async () => {
      store.upsert(makeServer({ name: 'git', command: 'npx', env: { TOKEN: 'secret' } }))
      await store.flush()

      const res = await app().request('/export?includeSecrets=1')
      const body = await json(res) as Record<string, unknown>
      expect(body.secretScope).toBe('full')
      const git = (body.servers as Array<Record<string, unknown>>).find((s) => s.name === 'git')!
      expect(git.env).toEqual({ TOKEN: 'secret' })
    })

    it('filters by names and includes all when names omitted', async () => {
      store.upsert(makeServer({ name: 'a', command: 'node', args: ['a.js'] }))
      store.upsert(makeServer({ name: 'b', command: 'node', args: ['b.js'] }))
      await store.flush()

      const res = await app().request('/export?names=a')
      const body = await json(res) as Record<string, unknown>
      expect((body.servers as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(['a'])

      const all = await app().request('/export')
      const allBody = await json(all) as Record<string, unknown>
      expect((allBody.servers as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(['a', 'b'])
    })
  })

  // -------------------------------------------------------------------
  // POST /import/preview
  // -------------------------------------------------------------------
  describe('POST /import/preview', () => {
    it('parses a bare array and flags exists + invalid entries', async () => {
      store.upsert(makeServer({ name: 'already', command: 'node' }))
      await store.flush()

      const file = JSON.stringify([
        { name: 'fresh', type: 'stdio', command: 'npx', args: ['-y', 'x'] },
        { name: 'already', type: 'stdio', command: 'node' },
        { name: 'bad', type: 'stdio' }, // no command
      ])
      const res = await app().request('/import/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const servers = body.servers as Array<Record<string, unknown>>
      expect(servers).toHaveLength(3)
      const fresh = servers.find((s) => s.name === 'fresh')!
      expect(fresh.exists).toBe(false)
      expect(fresh.errors).toEqual([])
      const already = servers.find((s) => s.name === 'already')!
      expect(already.exists).toBe(true)
      const bad = servers.find((s) => s.name === 'bad')!
      expect((bad.errors as string[]).length).toBeGreaterThan(0)
      // preview never returns secret values
      expect(fresh).not.toHaveProperty('env')
    })

    it('parses the app envelope and a keyed object', async () => {
      const envelope = JSON.stringify({
        format: 'claude-react-web-mcp', version: 1, exportedAt: 1, secretScope: 'masked',
        servers: [{ name: 'env-srv', type: 'stdio', command: 'node', env: { K: '' } }],
      })
      const res1 = await app().request('/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: envelope }),
      })
      const body1 = await json(res1)
      expect((body1.servers as Array<Record<string, unknown>>)[0].name).toBe('env-srv')
      // masked env values keep their KEYS visible so the UI can hint re-entry
      expect((body1.servers as Array<Record<string, unknown>>)[0].envKeys).toEqual(['K'])

      const keyed = JSON.stringify({ 'kv-srv': { type: 'sse', url: 'http://x' } })
      const res2 = await app().request('/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: keyed }),
      })
      const body2 = await json(res2)
      expect((body2.servers as Array<Record<string, unknown>>)[0].name).toBe('kv-srv')
    })

    it('returns 400 for malformed JSON or an empty file', async () => {
      const res = await app().request('/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'not json' }),
      })
      expect(res.status).toBe(400)

      const empty = await app().request('/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: '{}' }),
      })
      expect(empty.status).toBe(400)
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

  // -------------------------------------------------------------------
  // POST /import
  // -------------------------------------------------------------------
  describe('POST /import', () => {
    it('imports new servers, dropping empty env values, enabled default true', async () => {
      const file = JSON.stringify([
        { name: 'a', type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { KEEP: 'v', BLANK: '' } },
      ])
      const res = await app().request('/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, names: ['a'], overwrite: false }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.imported).toEqual(['a'])
      const stored = store.get('a')!
      expect(stored.enabled).toBe(true)
      expect(stored.env).toEqual({ KEEP: 'v' })
    })

    it('skips existing servers unless overwrite, and reports failed invalid entries', async () => {
      store.upsert(makeServer({ name: 'exists', command: 'node', args: ['old'] }))
      await store.flush()

      const file = JSON.stringify([
        { name: 'exists', type: 'stdio', command: 'python', args: ['new.py'] },
        { name: 'bad', type: 'stdio' },
        { name: 'ghost', type: 'stdio', command: 'node' },
      ])
      const res = await app().request('/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, names: ['exists', 'bad', 'ghost'], overwrite: false }),
      })
      const body = await json(res)
      expect(body.skipped).toEqual(['exists'])
      expect((body.failed as Array<{ name: string }>)[0].name).toBe('bad')
      expect(body.imported).toEqual(['ghost'])
      // skipped entry untouched
      expect(store.get('exists')?.args).toEqual(['old'])
    })

    it('overwrite replaces scalars and merges env/headers without clobbering masked blanks', async () => {
      store.upsert(makeServer({
        name: 's', command: 'node', args: ['old'], env: { SECRET: 'keepme', OLD: 'gone' }, enabled: false,
      }))
      await store.flush()

      // masked-style file: env has SECRET blanked to '' (must not clobber)
      const file = JSON.stringify([
        { name: 's', type: 'stdio', command: 'python', args: ['new.py'], env: { SECRET: '', NEW: 'added' }, enabled: true },
      ])
      const res = await app().request('/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, names: ['s'], overwrite: true }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.updated).toEqual(['s'])
      const stored = store.get('s')!
      expect(stored.command).toBe('python')
      expect(stored.args).toEqual(['new.py'])
      expect(stored.enabled).toBe(true)
      expect(stored.env).toEqual({ SECRET: 'keepme', NEW: 'added' })
      expect(stored.createdAt).toBe(1_700_000_000_000) // preserved
    })

    it('rejects non-allowlisted commands', async () => {
      const file = JSON.stringify([{ name: 'evil', type: 'stdio', command: 'rm' }])
      const res = await app().request('/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, names: ['evil'], overwrite: false }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect((body.failed as Array<{ name: string }>)[0].name).toBe('evil')
      expect(store.get('evil')).toBeUndefined()
    })

    it('round-trips a masked export through a fresh store import', async () => {
      store.upsert(makeServer({ name: 'git', command: 'npx', args: ['-y', 'server-git'], env: { TOKEN: 'secret' } }))
      await store.flush()
      const expRes = await app().request('/export')
      const file = await json(expRes)

      const dir2 = tempDir('mcp-roundtrip')
      const store2 = new McpConfigStore({ stateDir: dir2 })
      await store2.load()
      const app2 = buildMcpConfigRouter(store2)
      try {
        const res = await app2.request('/import', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: JSON.stringify(file), names: ['git'], overwrite: false }),
        })
        const body = await json(res)
        expect(body.imported).toEqual(['git'])
        const imported = store2.get('git')!
        expect(imported.name).toBe('git')
        expect(imported.command).toBe('npx')
        expect(imported.env).toBeUndefined() // masked values dropped
      } finally {
        rmSync(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
    })
  })
})
