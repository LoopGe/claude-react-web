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