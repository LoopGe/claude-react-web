import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { buildApp } from '../app.js'
import { buildWebImportRouter } from './web-import.js'
import { MpStore } from '../mp-store.js'
import { McpConfigStore } from '../mcp-config.js'
import { SessionStore } from '../persistence.js'
import { loadConfig, config } from '../config.js'

/** 造一份"网页版"的 state 目录。 */
function seedSource(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Work', authToken: 'sk-ant-abcd1234', baseUrl: 'https://api.example.com', modelList: ['m-a'] }],
    activeProfileId: 'default',
  }), 'utf8')
}

/** 直接构造路由，并注入临时源目录——handler 的测试不该走 buildApp 的整条装配。
 *  以外层 Hono 挂在 '/api' 下（生产里 buildApiRouter 正是把这个 sub-router 以
 *  '/' 挂在 '/api' 上的），这样用例里的 URL 与真实 URL 同形。 */
async function makeRouter(stateDir: string, sourceDir: string) {
  const mpStore = new MpStore({ stateDir })
  await mpStore.load()
  const mcpStore = new McpConfigStore({ stateDir })
  await mcpStore.load()
  const app = new Hono()
  app.route('/api', buildWebImportRouter({ configDir: stateDir, mpStore, mcpStore, sourceDir }))
  return app
}

/** 只用于门控那两个断言：真正的挂载发生在 buildApiRouter 里，所以必须走
 *  buildApp。sessionStore 必须显式指向临时目录——SessionManager 缺省会自己
 *  new SessionStore()，那会写到用户的真实 ~/.claude-react-web
 *  （见 .agents/tasks/arch-audit-2026-10-10/server.md 的记录）。 */
function makeGateApp(stateDir: string, host: 'web' | 'desktop') {
  return buildApp({
    configDir: stateDir,
    mpStore: new MpStore({ stateDir }),
    mcpConfigStore: new McpConfigStore({ stateDir }),
    sessionStore: new SessionStore({ stateDir }),
    host,
  }).app
}

describe('GET /api/config/web-import', () => {
  let stateDir: string
  let sourceDir: string
  beforeEach(() => { stateDir = tempDir('web-import-dst'); sourceDir = tempDir('web-import-src') })
  afterEach(() => { rmRf(stateDir); rmRf(sourceDir) })

  it('mounts on the desktop host only (web host answers a JSON 404)', async () => {
    const web = makeGateApp(stateDir, 'web')
    const webRes = await web.request('/api/config/web-import')
    expect(webRes.status).toBe(404)
    expect((await webRes.json() as { error: string }).error).toContain('not found')

    const desktop = makeGateApp(stateDir, 'desktop')
    expect((await desktop.request('/api/config/web-import')).status).toBe(200)
  })

  it('reports exists:false when the source dir has none of the three files', async () => {
    // Review Focus 1：目录存在但什么都没有，必须走"没找到"而不是空清单。
    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.exists).toBe(false)
    expect(body.credentials).toBeNull()
    expect(body.mcp).toEqual([])
    expect(body.marketplaces).toEqual([])
  })

  it('enumerates credentials with a masked token and no plaintext', async () => {
    seedSource(sourceDir)
    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import')
    const body = await res.json() as Record<string, never>
    expect(body.exists).toBe(true)
    const cred = body.credentials as Record<string, unknown>
    expect(cred.profileName).toBe('Work')
    expect(cred.hasToken).toBe(true)
    expect(cred.authTokenMasked).toBe('****1234')
    expect(cred.modelCount).toBe(1)
    // 明文 token 绝不能出现在响应体里。
    expect(JSON.stringify(body)).not.toContain('sk-ant-abcd1234')
  })

  it('reports a corrupt source config as credentialsError, not a 500', async () => {
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), 'not json', 'utf8')
    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.credentials).toBeNull()
    expect(typeof body.credentialsError).toBe('string')
  })

  // 三栏各自独立：损坏的 mcp-config.json 只塌掉 mcp 那一栏，凭证与市场照常。
  it('isolates a corrupt source mcp-config.json to the mcp section', async () => {
    seedSource(sourceDir)
    writeFileSync(join(sourceDir, 'mcp-config.json'), 'not json', 'utf8')
    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.mcp).toEqual([])
    expect(typeof body.mcpError).toBe('string')
    expect(body.credentialsError).toBeUndefined()
    expect((body.credentials as Record<string, unknown>).profileName).toBe('Work')
  })

  it('isolates a corrupt source marketplaces.json to the marketplaces section', async () => {
    seedSource(sourceDir)
    writeFileSync(join(sourceDir, 'marketplaces.json'), 'not json', 'utf8')
    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.marketplaces).toEqual([])
    expect(typeof body.marketplacesError).toBe('string')
    expect(body.credentialsError).toBeUndefined()
    expect((body.credentials as Record<string, unknown>).profileName).toBe('Work')
  })
})

describe('POST /api/config/web-import — credentials', () => {
  let stateDir: string
  let sourceDir: string
  beforeEach(async () => {
    stateDir = tempDir('web-import-dst')
    sourceDir = tempDir('web-import-src')
    // 桌面版自己的 config.json：一个脚手架留下的空 profile（真实场景）。
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      profiles: [{ id: 'default', name: 'Default', authToken: '', baseUrl: 'https://api.anthropic.com', modelList: ['claude-haiku-3-5-20241022'], recapModel: 'keep-me' }],
      activeProfileId: 'default',
    }), 'utf8')
    await loadConfig(stateDir)
  })
  afterEach(() => { rmRf(stateDir); rmRf(sourceDir) })

  it('writes the source ACTIVE profile and flips configured to true', async () => {
    // Review Focus 3：源 active 是数组第二条，不是 profiles[0]。
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      profiles: [
        { id: 'old', name: 'Old', authToken: 'sk-ant-wrong', baseUrl: 'https://old.example.com', modelList: ['wrong-model'] },
        { id: 'work', name: 'Work', authToken: 'sk-ant-right', baseUrl: 'https://work.example.com', modelList: ['m-a', 'm-b'] },
      ],
      activeProfileId: 'work',
    }), 'utf8')

    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: true }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { credentials: { imported: boolean; configured: boolean } }
    expect(body.credentials).toEqual({ imported: true, configured: true })

    await loadConfig(stateDir)
    expect(config.authToken).toBe('sk-ant-right')
    expect(config.baseUrl).toBe('https://work.example.com')
    expect(config.modelList).toEqual(['m-a', 'm-b'])
  })

  it('does not clobber a destination field the source does not have', async () => {
    // Review Focus 4：源没有 recapModel → 桌面版的 recapModel 必须原样保留。
    seedSource(sourceDir) // 该 fixture 不含 recapModel / commitMessageModel
    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: true }),
    })
    // 这条用例必须同时钉住两半意图，缺任一半都会在"handler 什么都没做"时通过：
    //   1) 写入确实发生了 —— 响应 200，且源携带的 token / baseUrl 真的落到了
    //      桌面版 active profile（`loadConfig` 后从 config 读回）；
    //   2) 源没有的字段没被清空 —— recapModel 保持桌面版的现状。
    expect(res.status).toBe(200)
    const body = await res.json() as { credentials: { imported: boolean } }
    expect(body.credentials.imported).toBe(true)
    await loadConfig(stateDir)
    expect(config.authToken).toBe('sk-ant-abcd1234')
    expect(config.baseUrl).toBe('https://api.example.com')
    expect(config.recapModel).toBe('keep-me')
  })

  it('leaves configured false when the source carries no token', async () => {
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      profiles: [{ id: 'default', name: 'Empty', authToken: '', baseUrl: 'https://api.example.com', modelList: ['m-a'] }],
      activeProfileId: 'default',
    }), 'utf8')
    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: true }),
    })
    const body = await res.json() as { credentials: { imported: boolean; configured: boolean } }
    // modelList 被搬过来了，但没有 token → configured 仍为 false，
    // 客户端据此继续走向导而不是收尾。
    expect(body.credentials.configured).toBe(false)
    await loadConfig(stateDir)
    expect(config.modelList).toEqual(['m-a'])
  })

  it('rejects a non-boolean credentials flag', async () => {
    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: 'yes' }),
    })
    expect(res.status).toBe(400)
  })

  // 上面那条 "writes the source ACTIVE profile…" 钉的是**源侧**的选点；这条钉
  // **目的侧**：桌面版 active 不是 profiles[0] 时，落笔必须命中 active 那一条。
  // 这正是 /config/setup 注释里记的 P0（token 写进了 profiles[0]，而读的是
  // active）—— 只覆盖源侧是测不到它的。
  it('writes into the destination ACTIVE profile, not the destination profiles[0]', async () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      profiles: [
        { id: 'first', name: 'First', authToken: 'sk-ant-dst-first', baseUrl: 'https://first.example.com', modelList: ['keep-first'], recapModel: 'first-recap' },
        { id: 'active', name: 'Active', authToken: '', baseUrl: 'https://api.anthropic.com', modelList: ['keep-active'], recapModel: 'keep-me' },
      ],
      activeProfileId: 'active',
    }), 'utf8')
    await loadConfig(stateDir)
    seedSource(sourceDir)

    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: true }),
    })
    expect(res.status).toBe(200)
    await loadConfig(stateDir)
    // 源的值读回来时来自第二条（active），不是第一条。
    expect(config.authToken).toBe('sk-ant-abcd1234')
    expect(config.modelList).toEqual(['m-a'])
    expect(config.recapModel).toBe('keep-me')

    const raw = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')) as {
      profiles: Array<Record<string, unknown>>
      activeProfileId: string
    }
    // profiles[0] 必须原封不动 —— 写错条目的实现会在这里露出来。
    expect(raw.profiles[0].authToken).toBe('sk-ant-dst-first')
    expect(raw.profiles[0].modelList).toEqual(['keep-first'])
    expect(raw.profiles[0].recapModel).toBe('first-recap')
    // 选点没被写入改掉：还是 active 那条。
    expect(raw.profiles[1].authToken).toBe('sk-ant-abcd1234')
    expect(raw.activeProfileId).toBe('active')
  })

  // 没要求导入凭证 → credentials 为 null（与 GET 的 credentials: null 同形），
  // 且另外两栏回完整的空集合形状（Task 4/5 往里面填）。
  it('leaves credentials null when the flag is false or absent', async () => {
    seedSource(sourceDir)
    const app = await makeRouter(stateDir, sourceDir)
    for (const body of [{ credentials: false }, {}]) {
      const res = await app.request('/api/config/web-import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { credentials: unknown; mcp: unknown; marketplaces: unknown }
      expect(json.credentials).toBeNull()
      expect(json.mcp).toEqual({ imported: [], skipped: [], failed: [] })
      expect(json.marketplaces).toEqual({ imported: [], skipped: [], failed: [] })
    }
    // 没被要求导入 → 桌面版自己的 config.json 一个字都没动（token 仍是未配置态：
    // applyParsedConfig 把空白 token 落成 undefined，不是 ''）。
    await loadConfig(stateDir)
    expect(config.authToken).toBeUndefined()
    expect(config.recapModel).toBe('keep-me')
  })
})

describe('POST /api/config/web-import — mcp', () => {
  let stateDir: string
  let sourceDir: string
  beforeEach(() => {
    stateDir = tempDir('web-import-dst')
    sourceDir = tempDir('web-import-src')
    mkdirSync(sourceDir, { recursive: true })
    // 源 mcp-config.json 的真实形状：**扁平键值对象**（键就是 name），不是
    // 导出用的 `{version, servers: []}` 信封——信封会被 store 读成一台名叫
    // "servers" 的假服务器。
    writeFileSync(join(sourceDir, 'mcp-config.json'), JSON.stringify({
      ctx7: { name: 'ctx7', type: 'stdio', command: 'npx', args: ['-y', 'ctx7'], env: { API_KEY: 'sekret' }, enabled: true },
      remote: { name: 'remote', type: 'http', url: 'https://mcp.example.com', enabled: false },
    }), 'utf8')
  })
  afterEach(() => { rmRf(stateDir); rmRf(sourceDir) })

  async function post(body: unknown) {
    const app = await makeRouter(stateDir, sourceDir)
    return await app.request('/api/config/web-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('imports the named servers with their secrets, enabled', async () => {
    const res = await post({ mcp: ['ctx7'] })
    const body = await res.json() as { mcp: { imported: string[]; skipped: string[]; failed: unknown[] } }
    expect(body.mcp.imported).toEqual(['ctx7'])
    expect(body.mcp.failed).toEqual([])
    // 密钥值绝不进响应体（只在服务端内存 / 桌面版自己的 store 里）。
    expect(JSON.stringify(body)).not.toContain('sekret')

    const store = new McpConfigStore({ stateDir })
    const loaded = await store.load()
    expect(loaded.map((s) => s.name)).toEqual(['ctx7'])
    expect(loaded[0].env).toEqual({ API_KEY: 'sekret' })
    expect(loaded[0].enabled).toBe(true)
  })

  it('skips a name the desktop store already has', async () => {
    // 预置一台同名服务器：导入必须跳过它、保留桌面版的版本，不覆盖。
    const seeded = new McpConfigStore({ stateDir })
    await seeded.load()
    seeded.upsert({ name: 'ctx7', type: 'stdio', command: 'other', enabled: true, createdAt: 1, updatedAt: 1 })
    await seeded.flush()

    const res = await post({ mcp: ['ctx7'] })
    const body = await res.json() as { mcp: { imported: string[]; skipped: string[] } }
    expect(body.mcp.skipped).toEqual(['ctx7'])
    expect(body.mcp.imported).toEqual([])
    const after = await new McpConfigStore({ stateDir }).load()
    expect(after[0].command).toBe('other')
    expect(after[0].env).toBeUndefined()
  })

  it('fails the missing name without failing the request', async () => {
    const res = await post({ mcp: ['nope', 'ctx7'] })
    const body = await res.json() as { mcp: { imported: string[]; failed: Array<{ name: string; error: string }> } }
    expect(body.mcp.failed).toEqual([{ name: 'nope', error: expect.stringContaining('not found') }])
    expect(body.mcp.imported).toEqual(['ctx7'])
  })

  // 源的 mcp-config.json 存在但读不动：与 GET 的 mcpError 同一语义——整栏失败，
  // 每个被请求的名字各记一条，POST 仍是 200（逐项失败隔离，不 500 整次请求）。
  it('reports every requested name as failed when the source file is corrupt', async () => {
    writeFileSync(join(sourceDir, 'mcp-config.json'), 'not json', 'utf8')
    const res = await post({ mcp: ['ctx7', 'remote'] })
    expect(res.status).toBe(200)
    const body = await res.json() as { mcp: { imported: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> } }
    expect(body.mcp.failed.map((f) => f.name)).toEqual(['ctx7', 'remote'])
    for (const f of body.mcp.failed) expect(f.error).toContain('mcp-config.json')
    expect(body.mcp.imported).toEqual([])
    expect(body.mcp.skipped).toEqual([])
  })

  it('rejects a string where an array is required (no char-by-char iteration)', async () => {
    // Review Focus 5。
    const res = await post({ mcp: 'ctx7' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toContain('mcp must be an array')
  })
})

/** 造一个最小的 marketplace 克隆目录（足以让 MpStore 的 coerceMpEntry 接受
 *  这条条目：40 位 sha + 合法 manifest）。 */
function seedMarketplace(sourceDir: string, id: string, pluginNames: string[]): string {
  const cloneDir = join(sourceDir, 'marketplace-cache', id)
  mkdirSync(cloneDir, { recursive: true })
  writeFileSync(join(cloneDir, 'README.md'), 'clone payload', 'utf8')
  const manifest = { name: id, plugins: pluginNames.map((n) => ({ name: n, description: `${n} plugin` })) }
  mkdirSync(sourceDir, { recursive: true })
  const file = join(sourceDir, 'marketplaces.json')
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, marketplaces: {}, enabledPlugins: {} }
  existing.marketplaces[id] = {
    id,
    displayName: id,
    source: { type: 'https', url: `https://github.com/example/${id}` },
    cloneDir,
    addedAt: 1,
    lastRefreshedAt: 1,
    lastSha: 'a'.repeat(40),
    manifest,
  }
  writeFileSync(file, JSON.stringify(existing), 'utf8')
  return cloneDir
}

describe('POST /api/config/web-import — marketplaces', () => {
  let stateDir: string
  let sourceDir: string
  beforeEach(() => { stateDir = tempDir('web-import-dst'); sourceDir = tempDir('web-import-src') })
  afterEach(() => { rmRf(stateDir); rmRf(sourceDir) })

  async function post(body: unknown) {
    const app = await makeRouter(stateDir, sourceDir)
    return await app.request('/api/config/web-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('copies the clone into the desktop cache and rewrites cloneDir', async () => {
    const srcClone = seedMarketplace(sourceDir, 'claude-code', ['review'])
    const res = await post({ marketplaces: ['claude-code'] })
    const body = await res.json() as { marketplaces: { imported: string[]; failed: unknown[] } }
    expect(body.marketplaces).toEqual({ imported: ['claude-code'], skipped: [], failed: [] })

    const store = new MpStore({ stateDir })
    const entries = await store.load()
    expect(entries.map((e) => e.id)).toEqual(['claude-code'])
    expect(entries[0].cloneDir).toBe(store.cloneDirFor('claude-code'))
    expect(entries[0].cloneDir).not.toBe(srcClone)
    // 内容真的拷过来了，且没有 .importing 残留。
    expect(readdirSync(entries[0].cloneDir)).toContain('README.md')
    expect(readdirSync(join(stateDir, 'marketplace-cache'))).toEqual(['claude-code'])
  })

  it('carries the enabled-plugin flags for that marketplace', async () => {
    seedMarketplace(sourceDir, 'claude-code', ['review', 'docs'])
    // 源侧启用其中一个插件。
    const srcStore = new MpStore({ stateDir: sourceDir })
    await srcStore.load()
    srcStore.setEnabled('review', 'claude-code', true)
    await srcStore.flush()

    await post({ marketplaces: ['claude-code'] })
    const dst = new MpStore({ stateDir })
    await dst.load()
    expect(dst.enabledMapFor('claude-code')).toEqual({ review: true })
  })

  it('fails one marketplace whose clone dir is gone, importing the rest', async () => {
    // Review Focus 2：源 clone 被删 → 该项 failed、其余成功、无临时残留。
    seedMarketplace(sourceDir, 'gone', ['a'])
    seedMarketplace(sourceDir, 'alive', ['b'])
    rmRf(join(sourceDir, 'marketplace-cache', 'gone'))

    const res = await post({ marketplaces: ['gone', 'alive'] })
    const body = await res.json() as { marketplaces: { imported: string[]; failed: Array<{ name: string; error: string }> } }
    expect(body.marketplaces.imported).toEqual(['alive'])
    expect(body.marketplaces.failed).toEqual([{ name: 'gone', error: expect.stringContaining('clone dir is missing') }])
    const cacheEntries = readdirSync(join(stateDir, 'marketplace-cache'))
    expect(cacheEntries).toEqual(['alive'])
    expect(cacheEntries.some((n) => n.endsWith('.importing'))).toBe(false)
  })

  it('skips an id the desktop already has', async () => {
    seedMarketplace(sourceDir, 'claude-code', ['review'])
    const dst = new MpStore({ stateDir })
    await dst.load()
    dst.upsert({
      id: 'claude-code', displayName: 'local', source: { type: 'https', url: 'https://github.com/example/x' },
      cloneDir: dst.cloneDirFor('claude-code'), addedAt: 1, lastRefreshedAt: 1, lastSha: 'b'.repeat(40),
      manifest: { name: 'local', plugins: [] },
    })
    await dst.flush()

    const res = await post({ marketplaces: ['claude-code'] })
    const body = await res.json() as { marketplaces: { imported: string[]; skipped: string[] } }
    expect(body.marketplaces.skipped).toEqual(['claude-code'])
    expect(body.marketplaces.imported).toEqual([])
  })

  // 源的 marketplaces.json 存在但读不动：与 GET 的 marketplacesError 同一语义——
  // 整栏失败，每个被请求的 id 各记一条，POST 仍是 200（逐项失败隔离，
  // 不因为它坏掉而 500 掉整次请求）。
  it('reports every requested id as failed when the source file is corrupt', async () => {
    writeFileSync(join(sourceDir, 'marketplaces.json'), 'not json', 'utf8')
    const res = await post({ marketplaces: ['a', 'b'] })
    expect(res.status).toBe(200)
    const body = await res.json() as { marketplaces: { imported: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> } }
    expect(body.marketplaces.failed.map((f) => f.name)).toEqual(['a', 'b'])
    for (const f of body.marketplaces.failed) expect(f.error).toContain('marketplaces.json')
    expect(body.marketplaces.imported).toEqual([])
    expect(body.marketplaces.skipped).toEqual([])
  })

  it('rejects a string where an array is required', async () => {
    const res = await post({ marketplaces: 'claude-code' })
    expect(res.status).toBe(400)
  })
})
