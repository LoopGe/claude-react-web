import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  McpConfigStore,
  maskSecrets,
  coerceStoredMcpServer,
  validateMcpServer,
  type StoredMcpServer,
} from './mcp-config.js'
import { tempDir } from './__test-utils__/index.js'

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

describe('McpConfigStore', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('mcp')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty list when file does not exist', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    expect(await store.load()).toEqual([])
    expect(store.list()).toEqual([])
  })

  it('is tolerant to a corrupt JSON file', async () => {
    writeFileSync(join(dir, 'mcp-config.json'), '{not json')
    const store = new McpConfigStore({ stateDir: dir })
    expect(await store.load()).toEqual([])
  })

  it('ignores non-object top-level JSON', async () => {
    writeFileSync(join(dir, 'mcp-config.json'), '"just a string"')
    const store = new McpConfigStore({ stateDir: dir })
    expect(await store.load()).toEqual([])
  })

  it('ignores array top-level JSON', async () => {
    writeFileSync(join(dir, 'mcp-config.json'), '[]')
    const store = new McpConfigStore({ stateDir: dir })
    expect(await store.load()).toEqual([])
  })

  it('upsert + flush writes atomically and round-trips', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 'alpha', command: 'node' }))
    store.upsert(makeServer({ name: 'beta', command: 'python' }))
    await store.flush()

    const raw = readFileSync(join(dir, 'mcp-config.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, StoredMcpServer>
    expect(Object.keys(parsed).sort()).toEqual(['alpha', 'beta'])
    expect(parsed.alpha.command).toBe('node')
    expect(parsed.beta.command).toBe('python')

    // Fresh store round-trips
    const store2 = new McpConfigStore({ stateDir: dir })
    const loaded = await store2.load()
    expect(loaded).toHaveLength(2)
    expect(store2.get('alpha')?.command).toBe('node')
  })

  it('remove() drops the entry from the next flush', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 'alpha' }))
    store.upsert(makeServer({ name: 'beta' }))
    await store.flush()
    store.remove('alpha')
    await store.flush()

    const store2 = new McpConfigStore({ stateDir: dir })
    const loaded = await store2.load()
    expect(loaded.map((s) => s.name)).toEqual(['beta'])
  })

  it('flush() with nothing dirty is a no-op', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    await store.flush()
    expect(() => readFileSync(join(dir, 'mcp-config.json'))).toThrow()
  })

  it('sets file permissions to 0o600', async () => {
    // Windows NTFS does not support POSIX permission bits — chmod is a no-op
    // and stat() always returns the synthesized default mode (0o666).
    if (process.platform === 'win32') return

    const { statSync } = await import('node:fs')
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer())
    await store.flush()

    const stat = statSync(join(dir, 'mcp-config.json'))
    // Check that owner has read+write (0o600) and group/other have nothing
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('get() returns undefined for unknown name', () => {
    const store = new McpConfigStore({ stateDir: dir })
    expect(store.get('nonexistent')).toBeUndefined()
  })

  it('upsert replaces existing entry with same name', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 's', command: 'old' }))
    store.upsert(makeServer({ name: 's', command: 'new' }))
    await store.flush()

    const store2 = new McpConfigStore({ stateDir: dir })
    await store2.load()
    expect(store2.get('s')?.command).toBe('new')
  })
})

describe('McpConfigStore.toSdkConfig', () => {
  let dir: string

  beforeEach(() => { dir = tempDir('mcp') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('maps stdio servers to SDK config shape', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 's', command: 'npx', args: ['-y', 'mcp-serve'], env: { TOKEN: 'abc' } }))
    await store.flush()

    const cfg = store.toSdkConfig()
    expect(cfg.s).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'mcp-serve'], env: { TOKEN: 'abc' } })
  })

  it('maps sse servers to SDK config shape', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 'sse', type: 'sse', url: 'http://localhost:3000', headers: { Auth: 'Bearer xyz' } }))
    await store.flush()

    const cfg = store.toSdkConfig()
    expect(cfg.sse).toEqual({ type: 'sse', url: 'http://localhost:3000', headers: { Auth: 'Bearer xyz' } })
  })

  it('maps http servers to SDK config shape', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 'http', type: 'http', url: 'http://localhost:8080' }))
    await store.flush()

    const cfg = store.toSdkConfig()
    expect(cfg.http).toEqual({ type: 'http', url: 'http://localhost:8080' })
  })

  it('injects stored OAuth bearer token when no Authorization header exists', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({
      name: 'oauth-http',
      type: 'http',
      url: 'http://localhost:8080',
      headers: { 'X-Custom': 'v' },
      oauth: { tokens: { access_token: 'tok', token_type: 'Bearer' } },
    }))

    const cfg = store.toSdkConfig()
    expect(cfg['oauth-http']).toEqual({
      type: 'http',
      url: 'http://localhost:8080',
      headers: { 'X-Custom': 'v', Authorization: 'Bearer tok' },
    })
  })

  it('keeps an explicit Authorization header over stored OAuth token', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({
      name: 'explicit-auth',
      type: 'sse',
      url: 'http://localhost:3000',
      headers: { authorization: 'Bearer manual' },
      oauth: { tokens: { access_token: 'tok', token_type: 'Bearer' } },
    }))

    const cfg = store.toSdkConfig()
    expect(cfg['explicit-auth']).toEqual({
      type: 'sse',
      url: 'http://localhost:3000',
      headers: { authorization: 'Bearer manual' },
    })
  })

  it('includes alwaysLoad flag when true', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 'al', command: 'node', alwaysLoad: true }))
    await store.flush()

    const cfg = store.toSdkConfig()
    expect(cfg.al).toHaveProperty('alwaysLoad', true)
  })

  it('includes per-server timeout when set', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 'to', command: 'node', timeout: 30000 }))
    await store.flush()

    const cfg = store.toSdkConfig()
    expect(cfg.to).toHaveProperty('timeout', 30000)
  })

  it('omits timeout when unset', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 'noto', command: 'node' }))
    await store.flush()

    const cfg = store.toSdkConfig()
    expect(cfg.noto).not.toHaveProperty('timeout')
  })

  it('skips disabled servers', async () => {
    const store = new McpConfigStore({ stateDir: dir })
    await store.load()
    store.upsert(makeServer({ name: 'on', command: 'a' }))
    store.upsert(makeServer({ name: 'off', command: 'b', enabled: false }))
    await store.flush()

    const cfg = store.toSdkConfig()
    expect(Object.keys(cfg)).toEqual(['on'])
  })

  it('skips stdio servers without command', () => {
    const store = new McpConfigStore({ stateDir: dir })
    // Directly manipulate internal state via upsert
    store.upsert({ name: 'broken', type: 'stdio', createdAt: 0, updatedAt: 0 })
    const cfg = store.toSdkConfig()
    expect(cfg.broken).toBeUndefined()
  })

  it('skips sse/http servers without url', () => {
    const store = new McpConfigStore({ stateDir: dir })
    store.upsert({ name: 'broken-sse', type: 'sse', createdAt: 0, updatedAt: 0 })
    store.upsert({ name: 'broken-http', type: 'http', createdAt: 0, updatedAt: 0 })
    const cfg = store.toSdkConfig()
    expect(cfg['broken-sse']).toBeUndefined()
    expect(cfg['broken-http']).toBeUndefined()
  })

  it('omits empty args, env, headers from SDK config', () => {
    const store = new McpConfigStore({ stateDir: dir })
    store.upsert(makeServer({ name: 'clean', command: 'node', args: [], env: {}, headers: {} }))
    const cfg = store.toSdkConfig()
    expect(cfg.clean).toEqual({ type: 'stdio', command: 'node' })
  })
})

describe('maskSecrets', () => {
  it('strips env values, keeps keys', () => {
    const masked = maskSecrets(makeServer({ env: { TOKEN: 'secret', KEY: 'also-secret' } }))
    expect(masked).not.toHaveProperty('env')
    expect(masked.envKeys).toEqual(['TOKEN', 'KEY'])
  })

  it('strips header values, keeps keys', () => {
    const masked = maskSecrets(makeServer({ headers: { Authorization: 'Bearer tok' } }))
    expect(masked).not.toHaveProperty('headers')
    expect(masked.headerKeys).toEqual(['Authorization'])
  })

  it('strips raw OAuth state and exposes only auth metadata', () => {
    const masked = maskSecrets(makeServer({
      oauth: {
        tokens: { access_token: 'secret-token', token_type: 'Bearer' },
        lastAuthorizedAt: 1_700_000_000_001,
      },
    }))
    expect(masked).not.toHaveProperty('oauth')
    expect(masked.oauthAuthorized).toBe(true)
    expect(masked.oauthLastAuthorizedAt).toBe(1_700_000_000_001)
  })

  it('omits envKeys when env is empty or undefined', () => {
    expect(maskSecrets(makeServer({}))).not.toHaveProperty('envKeys')
    expect(maskSecrets(makeServer({ env: {} }))).not.toHaveProperty('envKeys')
  })

  it('omits headerKeys when headers is empty or undefined', () => {
    expect(maskSecrets(makeServer({}))).not.toHaveProperty('headerKeys')
    expect(maskSecrets(makeServer({ headers: {} }))).not.toHaveProperty('headerKeys')
  })

  it('preserves all non-secret fields', () => {
    const masked = maskSecrets(makeServer({ name: 'x', type: 'sse', url: 'http://localhost' }))
    expect(masked.name).toBe('x')
    expect(masked.type).toBe('sse')
    expect(masked.url).toBe('http://localhost')
  })
})

describe('coerceStoredMcpServer', () => {
  it('returns null for non-object input', () => {
    expect(coerceStoredMcpServer(null)).toBeNull()
    expect(coerceStoredMcpServer(undefined)).toBeNull()
    expect(coerceStoredMcpServer('string')).toBeNull()
    expect(coerceStoredMcpServer(42)).toBeNull()
  })

  it('uses fallbackName when name is missing', () => {
    const result = coerceStoredMcpServer({ command: 'node' }, 'fallback')
    expect(result?.name).toBe('fallback')
  })

  it('prefers explicit name over fallback', () => {
    const result = coerceStoredMcpServer({ name: 'explicit', command: 'node' }, 'fallback')
    expect(result?.name).toBe('explicit')
  })

  it('returns null when neither name nor fallback is provided', () => {
    expect(coerceStoredMcpServer({ command: 'node' })).toBeNull()
  })

  it('defaults type to stdio when missing', () => {
    const result = coerceStoredMcpServer({ name: 'x', command: 'node' })
    expect(result?.type).toBe('stdio')
  })

  it('defaults type to stdio for invalid type value', () => {
    const result = coerceStoredMcpServer({ name: 'x', type: 'invalid', command: 'node' })
    expect(result?.type).toBe('stdio')
  })

  it('preserves valid type values', () => {
    expect(coerceStoredMcpServer({ name: 'x', type: 'sse', url: 'http://x' })?.type).toBe('sse')
    expect(coerceStoredMcpServer({ name: 'x', type: 'http', url: 'http://x' })?.type).toBe('http')
  })

  it('includes optional fields when present', () => {
    const result = coerceStoredMcpServer({
      name: 'x', type: 'stdio', command: 'npx',
      args: ['-y', 'serve'], env: { T: 'v' },
      alwaysLoad: true, enabled: false,
      createdAt: 100, updatedAt: 200,
    })
    expect(result).toMatchObject({
      name: 'x', type: 'stdio', command: 'npx',
      args: ['-y', 'serve'], env: { T: 'v' },
      alwaysLoad: true, enabled: false,
      createdAt: 100, updatedAt: 200,
    })
  })

  it('ignores non-string args elements', () => {
    const result = coerceStoredMcpServer({ name: 'x', command: 'node', args: ['ok', 42] })
    expect(result?.args).toBeUndefined()
  })

  it('ignores non-string-record env/headers', () => {
    const result = coerceStoredMcpServer({
      name: 'x', command: 'node',
      env: { good: 'val', bad: 42 },
      headers: { good: 'val', bad: null },
    })
    expect(result?.env).toBeUndefined()
    expect(result?.headers).toBeUndefined()
  })

  it('assigns default timestamps when missing', () => {
    const before = Date.now()
    const result = coerceStoredMcpServer({ name: 'x', command: 'node' })
    const after = Date.now()
    expect(result!.createdAt).toBeGreaterThanOrEqual(before)
    expect(result!.createdAt).toBeLessThanOrEqual(after)
    expect(result!.updatedAt).toBeGreaterThanOrEqual(before)
    expect(result!.updatedAt).toBeLessThanOrEqual(after)
  })
})

describe('validateMcpServer', () => {
  it('returns no errors for valid stdio server', () => {
    expect(validateMcpServer({ name: 'x', type: 'stdio', command: 'node' })).toEqual([])
  })

  it('returns no errors for valid sse server', () => {
    expect(validateMcpServer({ name: 'x', type: 'sse', url: 'http://localhost' })).toEqual([])
  })

  it('returns no errors for valid http server', () => {
    expect(validateMcpServer({ name: 'x', type: 'http', url: 'http://localhost' })).toEqual([])
  })

  it('requires name', () => {
    const errors = validateMcpServer({ type: 'stdio', command: 'node' })
    expect(errors).toContain('name is required')
  })

  it('requires command for stdio', () => {
    const errors = validateMcpServer({ name: 'x', type: 'stdio' })
    expect(errors).toContain('command is required for stdio type')
  })

  it('defaults to stdio when type is omitted and requires command', () => {
    const errors = validateMcpServer({ name: 'x' })
    expect(errors).toContain('command is required for stdio type')
  })

  it('requires url for sse', () => {
    const errors = validateMcpServer({ name: 'x', type: 'sse' })
    expect(errors).toContain('url is required for sse type')
  })

  it('requires url for http', () => {
    const errors = validateMcpServer({ name: 'x', type: 'http' })
    expect(errors).toContain('url is required for http type')
  })

  it('rejects non-array args', () => {
    const errors = validateMcpServer({ name: 'x', command: 'node', args: 'not-array' as unknown as string[] })
    expect(errors).toContain('args must be an array')
  })

  it('rejects non-string-record env', () => {
    const errors = validateMcpServer({ name: 'x', command: 'node', env: { bad: 42 } as unknown as Record<string, string> })
    expect(errors).toContain('env must be a record of strings')
  })

  it('rejects non-string-record headers', () => {
    const errors = validateMcpServer({
      name: 'x', type: 'sse', url: 'http://localhost',
      headers: { bad: true } as unknown as Record<string, string>,
    })
    expect(errors).toContain('headers must be a record of strings')
  })

  it('accepts empty args array', () => {
    expect(validateMcpServer({ name: 'x', command: 'node', args: [] })).toEqual([])
  })
})
