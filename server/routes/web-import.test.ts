import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
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
})