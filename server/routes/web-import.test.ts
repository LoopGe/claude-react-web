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

  it('mounts on the desktop host only (no import surface on the web host)', async () => {
    const web = makeGateApp(stateDir, 'web')
    const webRes = await web.request('/api/config/web-import')
    // web 宿主上这条路由**没有挂载** ⇒ 响应不是那份枚举。
    //
    // 刻意不断言状态码：未匹配的 GET 由谁接住取决于客户端有没有构建——构建过的
    // 树里 `dist/client` 存在，SPA fallback（`server/app.ts` 的 `app.get('*')`）
    // 会先接住它并回 index.html（200），`app.notFound` 的 JSON 404 只在**没构建**
    // 时成立。路由顺序是既有行为，不在这条用例的射程内；这里钉的是
    // "导入面在 web 宿主不存在"。
    expect(await webRes.text()).not.toContain('sourceDir')

    // 同一个标记在桌面宿主上必须在 —— 否则上面那条断言在"路由整个消失"时也会通过。
    const desktop = makeGateApp(stateDir, 'desktop')
    const desktopRes = await desktop.request('/api/config/web-import')
    expect(desktopRes.status).toBe(200)
    expect(await desktopRes.text()).toContain('sourceDir')
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

  // 枚举行的映射此前完全没有覆盖。真实 state 目录里的 mcp-config.json 是
  // **扁平键值对象**（键就是 name，见 McpConfigStore.parseItems），不是导出用的
  // `{version, servers: []}` 信封——写成信封会被读成一台名叫 "servers" 的假服务器。
  it('maps each source MCP server onto a row, with the secret values withheld', async () => {
    seedSource(sourceDir)
    writeFileSync(join(sourceDir, 'mcp-config.json'), JSON.stringify({
      ctx7: { name: 'ctx7', type: 'stdio', command: 'npx', args: ['-y', 'ctx7'], env: { API_KEY: 'sekret' }, enabled: true },
      remote: { name: 'remote', type: 'http', url: 'https://mcp.example.com', enabled: false },
      authed: { name: 'authed', type: 'http', url: 'https://user:mcp-tok-abc123@mcp.example.com/mcp', enabled: false },
      // stdio 的 command 里塞一整个远程 URL 是常见形状（`npx -y mcp-remote
      // https://user:tok@host/mcp`），而 command 是**整串**上线的——同一类泄漏。
      wrapped: { name: 'wrapped', type: 'stdio', command: 'npx -y mcp-remote https://user:cmd-tok-xyz@mcp.example.com/mcp', enabled: false },
      // 同一条规则在**命令文本**里的形状：密码里带 `@`，而命令还在 URL 之后继续
      // （贪婪取到最后一个 `@` 才不会把 `ss@mcp…/mcp --flag` 留在线上）。
      padded: { name: 'padded', type: 'stdio', command: 'npx -y mcp-remote https://user:q@ss@mcp.example.com/mcp --transport http', enabled: false },
      broken: { name: 'broken', type: 'stdio' },
    }), 'utf8')
    // 桌面版已有同名服务器：exists 必须反映**桌面** store（它就是"Already exists"
    // 那半条），不是源里有没有。
    const dst = new McpConfigStore({ stateDir })
    await dst.load()
    dst.upsert({ name: 'ctx7', type: 'stdio', command: 'other', enabled: true, createdAt: 1, updatedAt: 1 })
    await dst.flush()

    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import')
    expect(res.status).toBe(200)
    const body = await res.json() as { mcp: Array<Record<string, unknown>> }
    const byName = new Map(body.mcp.map((s) => [s.name as string, s]))

    // command 型：command 上线、env 只说键名、args 不上线（行上不展示）。
    expect(byName.get('ctx7')).toEqual({
      name: 'ctx7', type: 'stdio', command: 'npx', envKeys: ['API_KEY'], exists: true, importErrors: [],
    })
    // command 里的 `scheme://userinfo@` 与 url 同一处置：只打掉 userinfo，命令文本
    // 其余部分逐字保留。这一行照旧带校验错误（`npx -y …` 不是白名单里的可执行
    // 名），但**打码与校验无关**——校验用的是源里那条原始 server，而压暗的行
    // 也照样把 command 显示出来，所以它同样要打码。
    expect(byName.get('wrapped')?.command)
      .toBe('npx -y mcp-remote https://user:***@mcp.example.com/mcp')
    expect((byName.get('wrapped')?.importErrors as string[]).length).toBeGreaterThan(0)
    // 密码里的 `@`：userinfo 贪婪到最后一个 `@`，URL 后面的命令文本逐字保留。
    expect(byName.get('padded')?.command)
      .toBe('npx -y mcp-remote https://user:***@mcp.example.com/mcp --transport http')
    // url 型：没有 command 键（而不是空串）。
    expect(byName.get('remote')).toEqual({
      name: 'remote', type: 'http', url: 'https://mcp.example.com', exists: false, importErrors: [],
    })
    // 带 userinfo 的 url 型：与 marketplace 的 sourceUrl 同一处置（同一个
    // maskUrlUserinfo）——秘密不上线，主机与路径照旧认得出。视图只用于展示，
    // POST 是按名字从**源 store** 导入，所以打码不影响真正搬过去的那条 url。
    expect(byName.get('authed')).toEqual({
      name: 'authed', type: 'http', url: 'https://user:***@mcp.example.com/mcp', exists: false, importErrors: [],
    })
    // 校验不过的行照常枚举：importErrors 就是行压暗 + 禁用勾选框的判据。
    expect(byName.get('broken')).toEqual({
      name: 'broken', type: 'stdio', exists: false, importErrors: ['command is required for stdio type'],
    })
    // 密钥的**值**绝不进响应体（env 的键名才上线；url / command 里的 userinfo 也不上线）。
    expect(JSON.stringify(body)).not.toContain('sekret')
    expect(JSON.stringify(body)).not.toContain('mcp-tok-abc123')
    expect(JSON.stringify(body)).not.toContain('cmd-tok-xyz')
    expect(JSON.stringify(body)).not.toContain('q@ss@mcp.example.com')
  })

  it('maps each source marketplace onto a row, flagging a missing clone', async () => {
    seedMarketplace(sourceDir, 'alive', ['a', 'b'])
    seedMarketplace(sourceDir, 'gone', ['c'])
    // gone 的克隆目录被删掉 → cloneExists false（行不可导入 + `· clone missing`）。
    rmRf(join(sourceDir, 'marketplace-cache', 'gone'))
    // 桌面版已有 alive：exists 必须反映**桌面** store。
    const dst = new MpStore({ stateDir })
    await dst.load()
    dst.upsert({
      id: 'alive', displayName: 'local', source: { type: 'https', url: 'https://github.com/example/x' },
      cloneDir: dst.cloneDirFor('alive'), addedAt: 1, lastRefreshedAt: 1, lastSha: 'b'.repeat(40),
      manifest: { name: 'local', plugins: [] },
    })
    await dst.flush()

    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import')
    expect(res.status).toBe(200)
    const body = await res.json() as { marketplaces: Array<Record<string, unknown>> }
    const byId = new Map(body.marketplaces.map((m) => [m.id as string, m]))

    expect(byId.get('alive')).toEqual({
      id: 'alive', displayName: 'alive', sourceUrl: 'https://github.com/example/alive',
      pluginCount: 2, cloneExists: true, exists: true,
    })
    expect(byId.get('gone')).toEqual({
      id: 'gone', displayName: 'gone', sourceUrl: 'https://github.com/example/gone',
      pluginCount: 1, cloneExists: false, exists: false,
    })
  })

  // marketplace 的 sourceUrl 可以带 userinfo（`https://oauth2:<token>@host/owner/repo`），
  // 截图里就是明文令牌上屏的。枚举是给人看的，用户只需要认出"是哪个仓库"，
  // 所以秘密不上线——但**只改视图**：store 里那条 URL 一个字都不动（导入侧
  // 还要靠它去拉私有仓库）。
  it('masks the userinfo in a marketplace source url, keeping scheme and host', async () => {
    seedMarketplace(sourceDir, 'private', ['a'])
    seedMarketplace(sourceDir, 'bare', ['b'])
    seedMarketplace(sourceDir, 'noslash', ['c'])
    seedMarketplace(sourceDir, 'atpass', ['d'])
    seedMarketplace(sourceDir, 'atpath', ['e'])
    seedMarketplace(sourceDir, 'emptysecret', ['f'])
    const file = join(sourceDir, 'marketplaces.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      marketplaces: Record<string, { source: { url: string } }>
    }
    raw.marketplaces.private.source.url = 'https://oauth2:ghp_supersecrettoken@git.example.com/owner/repo'
    raw.marketplaces.bare.source.url = 'https://ghp_baretoken@git.example.com/owner/other'
    // 裸 host + 凭证（没有 path）：逐字保留的判据 —— 按 URL 往返一次会补出尾斜杠
    // （`https://***@git.example.com/`），屏上就不该是源里那条串了。
    raw.marketplaces.noslash.source.url = 'https://ghp_noslashtoken@git.example.com'
    // 密码里带 `@`：userinfo 必须取到**最后一个**仍在 authority 里的 `@`，否则
    // 只换掉第一个 `@` 之前那半截，密码尾巴 `ss@host` 会留在线上。
    raw.marketplaces.atpass.source.url = 'https://user:p@ss@git.example.com/owner/repo'
    // 负向对照：`@` 在 **path** 里（不是 userinfo）→ 整串逐字返回，不许把
    // `a@b` 当 userinfo 打码。它是上面那条贪婪规则的界线。
    raw.marketplaces.atpath.source.url = 'https://git.example.com/a@b/c'
    // `user:@`（冒号后是空的）：判据是"有没有冒号"，不是"冒号后有没有东西"——
    // 保留 user，那个空串换成 ***（它与裸 token 两种形状各有各的分支）。
    raw.marketplaces.emptysecret.source.url = 'https://user:@git.example.com/owner/repo'
    writeFileSync(file, JSON.stringify(raw), 'utf8')

    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import')
    const body = await res.json() as { marketplaces: Array<Record<string, unknown>> }
    const byId = new Map(body.marketplaces.map((m) => [m.id as string, m]))

    // `user:secret@` → 保留 user（用户认得出是哪个账号），秘密换成 ***。
    expect(byId.get('private')?.sourceUrl).toBe('https://oauth2:***@git.example.com/owner/repo')
    // 裸 `token@` → 整段 userinfo 都是秘密。
    expect(byId.get('bare')?.sourceUrl).toBe('https://***@git.example.com/owner/other')
    // userinfo 之外一个字符都没动（没有尾斜杠）。
    expect(byId.get('noslash')?.sourceUrl).toBe('https://***@git.example.com')
    // 密码里的 `@` 不截断 userinfo：主机与 path 照旧，前半截用户名保留。
    expect(byId.get('atpass')?.sourceUrl).toBe('https://user:***@git.example.com/owner/repo')
    // 负向对照：path 里的 `@` 不进 userinfo → 原样。
    expect(byId.get('atpath')?.sourceUrl).toBe('https://git.example.com/a@b/c')
    // 空 secret（`user:@`）与 `user:secret@` 同一分支：保留 user。
    expect(byId.get('emptysecret')?.sourceUrl).toBe('https://user:***@git.example.com/owner/repo')
    // 令牌在响应体里任何位置都不出现（`p@ss` 那半截尾巴同样不许出现）。
    const text = JSON.stringify(body)
    expect(text).not.toContain('ghp_supersecrettoken')
    expect(text).not.toContain('ghp_baretoken')
    expect(text).not.toContain('ghp_noslashtoken')
    expect(text).not.toContain('ss@git.example.com')

    // 只改视图：源 store 里那条 URL 原样保留。
    const stored = await new MpStore({ stateDir: sourceDir }).load({ readOnly: true })
    expect(stored.find((e) => e.id === 'private')?.source.url)
      .toBe('https://oauth2:ghp_supersecrettoken@git.example.com/owner/repo')
  })

  // 源里一条可写字段都没有（`profiles: []` / 字段全空白的 profile / legacy 顶层
  // 形状）时，凭证那一行导入写不出任何东西——枚举侧必须如实说：
  //   - `available: false`（客户端据此压暗 + 禁用那一行；判据与写入侧的
  //     `imported` 是同一个函数）；
  //   - **不报** modelCount：那时的 modelList 是 coercion 的 fallback，
  //     报出来是默认值条数，不是用户的。
  it('reports an unusable source profile as unavailable, without a model count', async () => {
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      profiles: [{ id: 'default', name: 'Blank' }],
    }), 'utf8')

    const app = await makeRouter(stateDir, sourceDir)
    const res = await app.request('/api/config/web-import')
    expect(res.status).toBe(200)
    const body = await res.json() as { credentials: Record<string, unknown> }
    expect(body.credentials.available).toBe(false)
    expect(body.credentials.hasToken).toBe(false)
    expect(body.credentials.modelCount).toBeUndefined()
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

  // 源里一条**可用** profile 都没有时（`profiles: []`、字段全空白的 profile、或
  // 还是 legacy 顶层形状——readSourceCredentials 根本不看那六个顶层键），
  // 写入循环的六个 `if (cred.present.X)` 全为假：源里的值一个都落不到 profile。
  // 那种情况必须报 imported: false —— 客户端行上写 Imported 是谎报（用户以为
  // 凭证搬过来了，桌面版其实还是未配置）。
  it('reports imported:false when the source has no usable profile to write', async () => {
    for (const raw of [
      { profiles: [] },
      { profiles: [{ id: 'default', name: 'Blank' }] },
      { authToken: 'sk-ant-legacy', baseUrl: 'https://legacy.example.com', modelList: ['legacy-model'] },
    ]) {
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(raw), 'utf8')
      const before = readFileSync(join(stateDir, 'config.json'), 'utf8')

      const app = await makeRouter(stateDir, sourceDir)
      const res = await app.request('/api/config/web-import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credentials: true }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { credentials: { imported: boolean; configured: boolean } }
      // 没写出东西 → imported: false；configured 仍镜像 GET /config（源里没有
      // token，桌面版本来就是未配置）。legacy 顶层那份的令牌绝不能顺带搬过来。
      expect(body.credentials).toEqual({ imported: false, configured: false })
      // 内容一个字都没变：桌面版自己的 config.json 没有任何字段被源改写
      // （也没有被 heal 出一个新 profile 的内容差异）。这里比的是解析后的
      // 结构——queueConfigWrite 落盘时会重新格式化，格式差异不是"写了东西"。
      expect(JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')))
        .toEqual(JSON.parse(before))
      await loadConfig(stateDir)
      expect(config.authToken).toBeUndefined()
      expect(config.recapModel).toBe('keep-me')
    }
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

  // 刻意不搬 oauth：枚举屏不上线这个块（用户看不到有东西跟着来），而里面的
  // redirectUrl 是**宿主相关**的——桌面宿主把 /api/* 走 in-process、没有 TCP
  // 端口可回，搬过去就是一个静默坏掉的回调地址（回调时还会被
  // `server.oauth?.redirectUrl ?? …` 优先采用）。代价只是去面板点一次授权。
  it('does not carry the source oauth block into the desktop store', async () => {
    const src = new McpConfigStore({ stateDir: sourceDir })
    await src.load()
    src.upsert({
      name: 'remote', type: 'http', url: 'https://mcp.example.com', enabled: true, createdAt: 1, updatedAt: 1,
      oauth: {
        redirectUrl: 'http://127.0.0.1:3456/api/mcp/oauth/callback',
        lastAuthorizedAt: 1,
        tokens: { access_token: 'tok-abc', token_type: 'Bearer' },
      },
    })
    await src.flush()
    // 先证明源那一侧真的有 oauth —— 否则"目的侧没有"可能只是因为 fixture 没造出来。
    const srcLoaded = await new McpConfigStore({ stateDir: sourceDir }).load()
    expect(srcLoaded.find((s) => s.name === 'remote')?.oauth).toBeDefined()

    const res = await post({ mcp: ['remote'] })
    const body = await res.json() as { mcp: { imported: string[] } }
    expect(body.mcp.imported).toEqual(['remote'])
    expect(JSON.stringify(body)).not.toContain('tok-abc')

    const loaded = await new McpConfigStore({ stateDir }).load()
    const imported = loaded.find((s) => s.name === 'remote')
    expect(imported?.oauth).toBeUndefined()
    // 其余字段照常搬过来（只丢 oauth 这一个块）。
    expect(imported?.url).toBe('https://mcp.example.com')
    expect(imported?.enabled).toBe(true)
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

    // 跳过的语义是"桌面版已经有了就不动它"，不是"用源的覆盖它"：既有条目必须
    // **原封不动**（displayName / cloneDir / lastSha / source 都是桌面版那份），
    // 源里那份克隆也没有先拷过来再作废。
    const after = new MpStore({ stateDir })
    const entries = await after.load()
    expect(entries).toHaveLength(1)
    expect(entries[0].displayName).toBe('local')
    expect(entries[0].cloneDir).toBe(after.cloneDirFor('claude-code'))
    expect(entries[0].lastSha).toBe('b'.repeat(40))
    expect(entries[0].source).toEqual({ type: 'https', url: 'https://github.com/example/x' })
    expect(existsSync(join(stateDir, 'marketplace-cache'))).toBe(false)
  })

  // 失败路径的清理此前够不着（`clone dir is missing` 在 cp 之前就 throw，走的
  // 是另一条分支）：把目标目录**预先建成非空**、且不登记进桌面 store 的索引，
  // cp 就会成功、rename 才失败（POSIX 与 Windows 都拒绝把目录 rename 到已存在
  // 的非空目录上）。
  it('cleans staging up and registers nothing when the rename onto an existing dir fails', async () => {
    seedMarketplace(sourceDir, 'claude-code', ['review'])
    const target = join(stateDir, 'marketplace-cache', 'claude-code')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'stale.txt'), 'stale', 'utf8')

    const res = await post({ marketplaces: ['claude-code'] })
    expect(res.status).toBe(200)
    const body = await res.json() as { marketplaces: { imported: string[]; failed: Array<{ name: string; error: string }> } }
    expect(body.marketplaces.imported).toEqual([])
    expect(body.marketplaces.failed.map((f) => f.name)).toEqual(['claude-code'])
    expect(body.marketplaces.failed[0].error).toBeTruthy()

    // 条目没被登记（store 索引里没有它）。
    const store = new MpStore({ stateDir })
    expect(await store.load()).toEqual([])
    // 没有 .importing 残留；预先存在的那份也没被当成成功结果（半个 clone 不落地）。
    expect(readdirSync(join(stateDir, 'marketplace-cache'))).toEqual(['claude-code'])
    expect(readdirSync(target)).toEqual(['stale.txt'])
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
