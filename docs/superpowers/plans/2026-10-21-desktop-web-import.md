# 桌面版从网页版导入配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面版（Electron）首次向导之前加一屏"从网页版导入"，把网页版 `~/.claude-react-web` 里的凭证与模型、全局 MCP、Claude Plugin Marketplace 一次搬进桌面版自己的 state 目录，搬完成即视为已配置、不再弹 setup。

**Architecture:** 一个只读的读取层（`server/web-import.ts`，值语义全部复用既有 coercion）+ 一对聚合端点（`GET/POST /api/config/web-import`，只在桌面宿主挂载）+ 一个前置屏组件（`src/components/SetupWebImport.tsx`，DOM/类名/文案/状态机照抄向导 step 0 与 step 3）。导入是"服务端读源文件 → 直接写入目标"的模型：明文 token 不进任何响应体。

**Tech Stack:** TypeScript / Hono（服务端路由）/ React 19 + Vitest（客户端）/ `node:fs/promises` 的 `cp` + `rename`（克隆目录拷贝）/ `JsonFileStore` 派生 store（`McpConfigStore` / `MpStore`）。

**Spec:** `docs/superpowers/specs/2026-10-21-desktop-web-import-design.md`

## Global Constraints

- 只读网页版 state 目录（`~/.claude-react-web`，即 `server/json-file-store.ts` 的 `DEFAULT_DIR_NAME` 加 `homedir()`）；**唯一写入目标是桌面版自己的 state 目录**。
- 明文 token 绝不进任何响应体、绝不打日志；枚举接口只回 `maskToken()` 的掩码。
- 同名 MCP、同 id marketplace 一律 `skipped`，不覆盖（对齐 `/api/mcp-config/claude-import`）。
- 逐项失败隔离：每项独立 try/catch，原始错误进 `failed[].error`，**不猜测、不加兜底**。
- 不新增任何 CSS；颜色只用主题变量（`var(--…)`）。UI 文案不新造词。
- 路由只在桌面宿主挂载：`host === 'desktop'` 才 `app.route`，web 宿主上导入面根本不存在（**不**依赖状态码：构建过的树里未匹配的 GET 由 SPA fallback 接住，见 spec §4）。
- 不引入新的 `config.json` 字段（`CONFIG.md` 无需改动）。
- 源目录在路由层通过 `sourceDir` 依赖注入（测试用），生产走 `webStateDir()`；读取层函数一律显式接收目录参数，不自己读 `homedir()`。

## Review Focus

Spec 隐含、但逐字实现的测试里不会自动覆盖的输入类别。每一行都在它归属的 Task 里加了对应用例：

1. **源目录存在但三个可移植文件一个都没有**（空目录、或只有 `sessions.json`）→ `GET` 必须报 `exists: false` 并让前置屏走"没找到"态，而不是渲染一张空清单。（Task 2）
2. **源 `marketplaces.json` 里条目的 `cloneDir` 已被删除** → 该项 `failed`、其余项照常成功、且不残留 `.importing` 临时目录。（Task 5）
3. **源 config 的 active profile 不是数组第一项**（用户切换过 profile）→ 导入写的是 active 那一条，不是 `profiles[0]`。这正是 `/config/setup` 注释里记的 P0 缺陷形态。（Task 3）
4. **源 profile 缺 `recapModel`** → 不覆盖桌面版已有的 `recapModel`（"缺失"不等于"请清空"）。（Task 3）
5. **`POST` 的 `mcp` / `marketplaces` 传字符串而非数组**（`"mcp": "a"`）→ 400，绝不逐字符迭代。（Task 4）

---

### Task 1: 读取层 `server/web-import.ts`

只读、纯函数、目录参数显式传入——这样单测可以用临时目录，不需要碰 `homedir()`。

**Files:**
- Create: `server/web-import.ts`
- Test: `server/web-import.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_DIR_NAME`（`server/json-file-store.ts`）、`DEFAULT_PROFILE` / `ModelGroupConfig` / `ProviderProfile`（`server/config.ts`）、`coerceProfileEntries` / `resolveActiveProfile` / `profileFromLegacyFields` / `LegacyProfileFields`（`server/profiles.ts`）、`McpConfigStore` / `StoredMcpServer`（`server/mcp-config.ts`）、`MpStore` / `MpEntry`（`server/mp-store.ts`）
- Produces（后续 Task 全部依赖这些确切名字）：
  - `webStateDir(): string`
  - `interface PresentFields { authToken: boolean; baseUrl: boolean; modelList: boolean; modelGroups: boolean; recapModel: boolean; commitMessageModel: boolean }`
  - `interface SourceCredentials { profileName: string; authToken: string; baseUrl: string; modelList: string[]; modelGroups: ModelGroupConfig[]; recapModel: string; commitMessageModel: string; present: PresentFields }`
  - `readSourceCredentials(dir: string): Promise<SourceCredentials>`（源 config.json 缺失或不可解析时 **throw**）
  - `readSourceMcp(dir: string): Promise<StoredMcpServer[]>`
  - `interface SourceMarketplaces { entries: MpEntry[]; enabled: Record<string, Record<string, boolean>>; cloneExists: Record<string, boolean> }`
  - `readSourceMarketplaces(dir: string): Promise<SourceMarketplaces>`

- [ ] **Step 1: 写失败的测试**

`server/web-import.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from './__test-utils__/index.js'
import { readSourceCredentials, readSourceMcp, readSourceMarketplaces } from './web-import.js'

/** 网页版的 config.json：active profile 是数组里的第二条（用户切换过），
 *  第一条是旧的、带一个假 token —— 导入必须认 active 那条。 */
function seedSourceConfig(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [
      { id: 'old', name: 'Old', authToken: 'sk-ant-old', baseUrl: 'https://old.example.com', modelList: ['old-model'] },
      { id: 'work', name: 'Work', authToken: 'sk-ant-work1234', baseUrl: 'https://work.example.com/', modelList: ['m-a', 'm-b'] },
    ],
    activeProfileId: 'work',
  }), 'utf8')
}

describe('readSourceCredentials', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('web-import-src') })
  afterEach(() => rmRf(dir))

  it('resolves the ACTIVE profile, not profiles[0]', async () => {
    seedSourceConfig(dir)
    const cred = await readSourceCredentials(dir)
    expect(cred.profileName).toBe('Work')
    expect(cred.authToken).toBe('sk-ant-work1234')
    expect(cred.modelList).toEqual(['m-a', 'm-b'])
  })

  it('normalizes a trailing slash off baseUrl (same rule the reader uses)', async () => {
    seedSourceConfig(dir)
    const cred = await readSourceCredentials(dir)
    expect(cred.baseUrl).toBe('https://work.example.com')
  })

  it('reports absence per field — a missing recapModel is NOT present', async () => {
    seedSourceConfig(dir)
    const cred = await readSourceCredentials(dir)
    expect(cred.present.authToken).toBe(true)
    expect(cred.present.modelList).toBe(true)
    expect(cred.present.recapModel).toBe(false)
    expect(cred.present.commitMessageModel).toBe(false)
  })

  it('throws when the source config.json is missing', async () => {
    await expect(readSourceCredentials(dir)).rejects.toThrow(/config\.json/)
  })

  it('throws when the source config.json is not a JSON object', async () => {
    writeFileSync(join(dir, 'config.json'), '["not", "an", "object"]', 'utf8')
    await expect(readSourceCredentials(dir)).rejects.toThrow()
  })
})

describe('readSourceMcp / readSourceMarketplaces', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('web-import-src') })
  afterEach(() => rmRf(dir))

  it('returns [] when the files are absent (never throws)', async () => {
    expect(await readSourceMcp(dir)).toEqual([])
    expect(await readSourceMarketplaces(dir)).toEqual({ entries: [], enabled: {}, cloneExists: {} })
  })

  it('loads MCP servers with their secrets intact server-side', async () => {
    writeFileSync(join(dir, 'mcp-config.json'), JSON.stringify({
      version: 1,
      servers: [{ name: 'ctx7', type: 'stdio', command: 'npx', env: { API_KEY: 'sekret' }, enabled: true }],
    }), 'utf8')
    const servers = await readSourceMcp(dir)
    expect(servers.map((s) => s.name)).toEqual(['ctx7'])
    expect(servers[0].env).toEqual({ API_KEY: 'sekret' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/web-import.test.ts`
Expected: FAIL —— `Failed to resolve import "./web-import.js"`。

- [ ] **Step 3: 实现**

`server/web-import.ts`：

```ts
// 网页版（web 宿主）state 目录里可移植 artifact 的只读读取层。
//
// 只读：本模块不写任何东西，也不读桌面版自己的 state 目录。
// 值语义一律走既有 coercion（coerceProfileEntries / resolveActiveProfile /
// McpConfigStore / MpStore），不另写一套解析——读写两侧漂移正是
// server/routes/config-routes.ts 的 /config/setup 注释里记的那个 P0 缺陷。

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_DIR_NAME } from './json-file-store.js'
import { DEFAULT_PROFILE, type ModelGroupConfig } from './config.js'
import { coerceProfileEntries, resolveActiveProfile } from './profiles.js'
import { McpConfigStore, type StoredMcpServer } from './mcp-config.js'
import { MpStore, type MpEntry } from './mp-store.js'

/** 网页版默认 state 目录：`~/.claude-react-web`（与 server/config.ts 的默认、
 *  以及 CLI `--state-dir` 的缺省值一致）。桌面版只读它。 */
export function webStateDir(): string {
  return join(homedir(), DEFAULT_DIR_NAME)
}

/** 源 profile 里"确实存在"的字段。导入只写为 true 的字段；false 表示
 *  "源里没有"（不是"请清空"），必须保留桌面版的现状。 */
export interface PresentFields {
  authToken: boolean
  baseUrl: boolean
  modelList: boolean
  modelGroups: boolean
  recapModel: boolean
  commitMessageModel: boolean
}

export interface SourceCredentials {
  profileName: string
  /** 明文，只在服务端内存里存在，绝不进响应体。 */
  authToken: string
  baseUrl: string
  modelList: string[]
  modelGroups: ModelGroupConfig[]
  recapModel: string
  commitMessageModel: string
  present: PresentFields
}

/** 读源 config.json 的 active profile。
 *
 *  缺文件 / 不是 JSON 对象 → throw（调用方决定是"这一栏不可用"还是整体失败），
 *  刻意不像 readConfigFile 那样把"没有"和"读不动"折叠成同一个 {} ——
 *  枚举接口要把这两种情况分开告诉用户。
 *
 *  profile 的选点、baseUrl 的尾斜杠归一化、modelList 的过滤全部由
 *  coerceProfileEntries + resolveActiveProfile 决定，与读取侧同源。 */
export async function readSourceCredentials(dir: string): Promise<SourceCredentials> {
  const file = join(dir, 'config.json')
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} is not a JSON object`)
  }
  const obj = raw as Record<string, unknown>
  const entries = coerceProfileEntries(obj.profiles, DEFAULT_PROFILE)
  const rawActiveId = typeof obj.activeProfileId === 'string' ? obj.activeProfileId.trim() : ''
  const active = resolveActiveProfile(
    entries.map((entry) => entry.profile),
    rawActiveId || DEFAULT_PROFILE.id,
    DEFAULT_PROFILE,
  )
  // present 必须从 RAW 条目取：coerceProfileEntries 会用 fallback 把缺失字段
  // 填满，到了 coerced profile 上就分不出"原本没有"和"值恰好等于默认"了。
  // 用 entries 自带的 raw `index`（与 /config/setup 同一手法），不自己按 id
  // 匹配——coerceProfileEntries 会 trim id、重复 id 取后者，手工匹配会错条目。
  const hit = entries.find((entry) => entry.profile === active)
  const rawList = Array.isArray(obj.profiles) ? (obj.profiles as unknown[]) : []
  const rawEntry = hit ? (rawList[hit.index] as Record<string, unknown> | undefined) : undefined
  const hasStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
  return {
    profileName: active.name,
    authToken: active.authToken,
    baseUrl: active.baseUrl,
    modelList: [...active.modelList],
    modelGroups: active.modelGroups.map((g) => ({ ...g })),
    recapModel: active.recapModel,
    commitMessageModel: active.commitMessageModel,
    present: {
      authToken: hasStr(rawEntry?.authToken),
      baseUrl: hasStr(rawEntry?.baseUrl),
      modelList: Array.isArray(rawEntry?.modelList) && rawEntry.modelList.length > 0,
      modelGroups: Array.isArray(rawEntry?.modelGroups) && rawEntry.modelGroups.length > 0,
      recapModel: hasStr(rawEntry?.recapModel),
      commitMessageModel: hasStr(rawEntry?.commitMessageModel),
    },
  }
}

/** 源目录里的全局 MCP 服务器。用同一个 McpConfigStore 类读源目录，解析规则
 *  与桌面版自己的 store 完全一致（ENOENT → []，损坏 → [] + warn）。 */
export async function readSourceMcp(dir: string): Promise<StoredMcpServer[]> {
  return await new McpConfigStore({ stateDir: dir }).load()
}

export interface SourceMarketplaces {
  entries: MpEntry[]
  /** marketplaceId → { pluginName: enabled }。enabledPlugins 是 side state，
   *  不复制它等于"市场搬过去了但一个插件都没启用"。 */
  enabled: Record<string, Record<string, boolean>>
  /** marketplaceId → 源 cloneDir 是否真的存在。 */
  cloneExists: Record<string, boolean>
}

/** 源目录里的 marketplace，含每个市场的启用标志与克隆目录存在性。 */
export async function readSourceMarketplaces(dir: string): Promise<SourceMarketplaces> {
  const store = new MpStore({ stateDir: dir })
  const entries = await store.load()
  const enabled: Record<string, Record<string, boolean>> = {}
  const cloneExists: Record<string, boolean> = {}
  for (const entry of entries) {
    enabled[entry.id] = store.enabledMapFor(entry.id)
    cloneExists[entry.id] = existsSync(entry.cloneDir)
  }
  return { entries, enabled, cloneExists }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/web-import.test.ts`
Expected: PASS（9 个用例）。

- [ ] **Step 5: 提交**

```bash
git add server/web-import.ts server/web-import.test.ts
git commit -m "feat(web-import): read the web build's portable artifacts

只读读取层：源目录解析 + active profile / 全局 MCP / marketplace 三份
artifact，值语义复用既有 coercion，不另写解析。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 宿主门控打通 + `GET /api/config/web-import` 枚举端点

**Files:**
- Create: `shared/web-import.ts`
- Create: `server/routes/web-import.ts`
- Create: `server/routes/web-import.test.ts`
- Modify: `server/bootstrap.ts`（`ServerContextOptions` 加 `host`）
- Modify: `server/app.ts:50-60`（`AppOptions` 加 `host`）、`server/app.ts:248`（传给 `buildApiRouter`）
- Modify: `server/routes/index.ts:101-108`（第 7 个可选参数）、挂载段
- Modify: `desktop/main.ts:282`（传 `host: 'desktop'`）
- Modify: `docs/superpowers/specs/2026-10-21-desktop-web-import-design.md` §6.1（wire 收紧，见 Step 9）

**Interfaces:**
- Consumes: Task 1 的 `webStateDir` / `readSourceCredentials` / `readSourceMcp` / `readSourceMarketplaces`；`maskToken`（`server/profiles.ts`）；`maskSecrets` / `validateMcpServer` / `McpConfigStore`（`server/mcp-config.ts`）；`safeJson`（`server/routes/index.ts`）；`HttpError` / `createErrorHandler`（`server/errors.ts`）；`MpStore`（`server/mp-store.ts`）
- Produces:
  - `shared/web-import.ts`：
    - `interface WebImportCredentialsView { available: boolean; hasToken: boolean; profileName: string; authTokenMasked?: string; baseUrl: string; modelCount: number }`
    - `interface WebImportMcpView { name: string; type: 'stdio' | 'sse' | 'http'; command?: string; url?: string; envKeys?: string[]; exists: boolean; importErrors: string[] }`
    - `interface WebImportMarketplaceView { id: string; displayName: string; sourceUrl: string; ref?: string; pluginCount: number; cloneExists: boolean; exists: boolean }`
    - `interface WebImportEnumeration { sourceDir: string; exists: boolean; credentials: WebImportCredentialsView | null; credentialsError?: string; mcp: WebImportMcpView[]; marketplaces: WebImportMarketplaceView[] }`
    - `interface WebImportCredentialsResult { imported: boolean; configured: boolean }`
    - `interface WebImportCollectionResult { imported: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> }`
    - `interface WebImportResult { credentials: WebImportCredentialsResult | null; mcp: WebImportCollectionResult; marketplaces: WebImportCollectionResult }`
  - `server/routes/web-import.ts`：`buildWebImportRouter(deps: { configDir: string; mpStore: MpStore; mcpStore: McpConfigStore; sourceDir?: string }): Hono`
  - `ServerContextOptions.host?: 'web' | 'desktop'`、`AppOptions.host?: 'web' | 'desktop'`、`buildApiRouter(..., host?: 'web' | 'desktop', mcpConfigStore?: McpConfigStore)`

- [ ] **Step 1: 写失败的测试**

`server/routes/web-import.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** 直接构造路由，并注入临时源目录——handler 的测试不该走 buildApp 的整条装配。 */
async function makeRouter(stateDir: string, sourceDir: string) {
  const mpStore = new MpStore({ stateDir })
  await mpStore.load()
  const mcpStore = new McpConfigStore({ stateDir })
  await mcpStore.load()
  return buildWebImportRouter({ configDir: stateDir, mpStore, mcpStore, sourceDir })
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
    // 不断言状态码（构建过的树里 SPA fallback 会回 index.html）；钉"响应不是枚举体"。
    expect(await webRes.text()).not.toContain('sourceDir')

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
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/routes/web-import.test.ts`
Expected: FAIL —— 404 用例先失败（路由还不存在时 `GET /api/config/web-import` 也回 404，所以真正先失败的是 `exists` 那几个用例拿不到 200）。

- [ ] **Step 3: wire 类型**

`shared/web-import.ts`：

```ts
// 桌面版"从网页版导入"的线上形状。server 与 client 共用。
//
// 枚举只回屏幕真正渲染的字段——不是源文件的完整镜像：模型分组 / recap /
// commit 模型只由服务端在导入时读取，界面不展示，所以不上线；MCP 只带
// 行上要显示的几个键（值 / 密钥永不出现）。

export interface WebImportCredentialsView {
  /** 源里有一条可读 profile。false 时整栏按"不可用"渲染。 */
  available: boolean
  hasToken: boolean
  profileName: string
  /** maskToken() 的结果；源没有 token 时省略。 */
  authTokenMasked?: string
  baseUrl: string
  modelCount: number
}

export interface WebImportMcpView {
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  url?: string
  envKeys?: string[]
  /** 桌面版已经有一台同名服务器 → 行上显示 Already exists。 */
  exists: boolean
  importErrors: string[]
}

export interface WebImportMarketplaceView {
  id: string
  displayName: string
  sourceUrl: string
  ref?: string
  pluginCount: number
  /** 源的克隆目录还在磁盘上；false 时该行不可导入。 */
  cloneExists: boolean
  /** 桌面版已经有同 id 的市场。 */
  exists: boolean
}

export interface WebImportEnumeration {
  /** 服务端实际探测的目录（不是猜的路径）。 */
  sourceDir: string
  /** 三个可移植文件里至少有一个存在。false = 没有可导入的东西。 */
  exists: boolean
  credentials: WebImportCredentialsView | null
  /** 读源 config.json 失败时的原始错误；与 credentials: null 同时出现。 */
  credentialsError?: string
  mcp: WebImportMcpView[]
  marketplaces: WebImportMarketplaceView[]
}

export interface WebImportCredentialsResult {
  imported: boolean
  /** 写入后镜像 GET /config 的 configured —— 客户端据此决定是否收尾。 */
  configured: boolean
}

export interface WebImportCollectionResult {
  imported: string[]
  skipped: string[]
  failed: Array<{ name: string; error: string }>
}

export interface WebImportResult {
  credentials: WebImportCredentialsResult | null
  mcp: WebImportCollectionResult
  marketplaces: WebImportCollectionResult
}
```

- [ ] **Step 4: host 门控打通**

`server/bootstrap.ts` —— `ServerContextOptions` 里 `bind` 那一段之后加：

```ts
  /** Which host is serving the app. Defaults to 'web'. The desktop host passes
   *  'desktop' so desktop-only routes (e.g. /api/config/web-import) mount at all.
   *  Explicit rather than inferred from `!bind`: bind being web-only is a
   *  current accident, not a contract. */
  host?: 'web' | 'desktop'
```

同文件 `buildApp({ … })` 那一处（约 `:191-205`）在 `bind: opts.bind,` 之后加：

```ts
    host: opts.host,
```

`server/app.ts` —— `AppOptions` 里加：

```ts
  /** Which host is serving the app (see ServerContextOptions.host). */
  host?: 'web' | 'desktop'
```

`server/app.ts:248` 改成（注意新增的 `opts.host` 与 `opts.mcpConfigStore`——后者本来就已经传进 SessionManager，这里只是同一个实例再交给 api router）：

```ts
  const apiRouter = buildApiRouter(sessionManager, opts.configDir, opts.mpStore, opts.defaults?.claudeBinary, opts.uploadStore, opts.agentDefinitionStore, opts.host, opts.mcpConfigStore)
```

`server/routes/index.ts` —— `buildApiRouter` 签名末尾加两个可选参数：

```ts
export function buildApiRouter(
  sm: SessionManager,
  configDir?: string,
  mpStore?: MpStore,
  claudeBinary?: string,
  uploadStore?: UploadStore,
  agentDefinitionStore?: AgentDefinitionStore,
  host: 'web' | 'desktop' = 'web',
  mcpConfigStore?: McpConfigStore,
): Hono {
```

同文件挂载段（`if (mpStore) { app.route('/', buildMpRouter(sm, mpStore)) }` 之后）加：

```ts
  // Desktop-only: importing the web build's config into the desktop state dir.
  // Mounted ONLY on the desktop host — the web host has nothing to import from
  // (source and target would be the same dir), so the import surface simply does
  // not exist there. Don't read a status code into that: an unmounted GET is
  // caught by whatever handles unmatched paths, and in a built tree that is
  // app.ts's SPA fallback (index.html, 200), not app.notFound's JSON 404.
  //
  // mcpConfigStore is the SAME instance SessionManager holds (bootstrap hands
  // one BuildApp, which hands it to both) — the import must not construct a
  // second store, or the two would write over each other's mcp-config.json.
  if (host === 'desktop' && configDir && mpStore && mcpConfigStore) {
    app.route('/', buildWebImportRouter({ configDir, mpStore, mcpStore: mcpConfigStore }))
  }
```

`server/routes/index.ts` 顶部 import 区同时补：

```ts
import type { McpConfigStore } from '../mcp-config.js'
```

> `SessionManager.mcpStore` 是 `private` 且没有访问器，所以 store 必须从 `buildApp`
> 传进来（`AppOptions.mcpConfigStore` 已存在，`bootstrap.ts` 本来就传了它）。

并在文件顶部 import 区加：

```ts
import { buildWebImportRouter } from './web-import.js'
```

`desktop/main.ts:282` 改成：

```ts
  ctx = await createServerContext({ stateDir, appPlugins: true, cwd, host: 'desktop' })
```

- [ ] **Step 5: 枚举端点**

`server/routes/web-import.ts`：

```ts
// 桌面版初始化时"从网页版导入配置"的端点。
//
// 只在桌面宿主挂载（server/routes/index.ts）：web 宿主上导入面根本不存在，
// 别把"未挂载"读成某个状态码——构建过的树里未匹配的 GET 由 app.ts 的 SPA
// fallback 接住（index.html, 200），app.notFound 的 JSON 404 只在没构建客户端
// 时成立。
// 语义对齐 /api/mcp-config/claude-import：密钥不过线、同名/同 id 跳过、
// 逐项失败隔离、返回 imported/skipped/failed。

import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler, HttpError } from '../errors.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'
import { maskToken } from '../profiles.js'
import { maskSecrets, validateMcpServer } from '../mcp-config.js'
import type { MpStore } from '../mp-store.js'
import type { McpConfigStore } from '../mcp-config.js'
import { readSourceCredentials, readSourceMcp, readSourceMarketplaces, webStateDir } from '../web-import.js'
import type { WebImportEnumeration, WebImportMarketplaceView, WebImportMcpView } from '../../shared/web-import.js'

const log = createLogger('web-import')

/** 三份可移植文件——`exists` 就是"这三者至少有一个在"。 */
const PORTABLE_FILES = ['config.json', 'mcp-config.json', 'marketplaces.json'] as const

export interface WebImportRouterDeps {
  configDir: string
  mpStore: MpStore
  /** 桌面版自己的 MCP store（判断同名冲突）。必须是 SessionManager 持有的那一个。 */
  mcpStore: McpConfigStore
  /** 源目录覆盖，仅测试用；生产缺省走 webStateDir()。 */
  sourceDir?: string
}

export function buildWebImportRouter(deps: WebImportRouterDeps): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[web-import]'))
  const sourceDirOf = () => deps.sourceDir ?? webStateDir()

  app.get('/config/web-import', async (c) => {
    const sourceDir = sourceDirOf()
    const exists = PORTABLE_FILES.some((f) => existsSync(join(sourceDir, f)))
    let credentials: WebImportEnumeration['credentials'] = null
    let credentialsError: string | undefined
    try {
      const cred = await readSourceCredentials(sourceDir)
      credentials = {
        available: true,
        hasToken: cred.authToken.length > 0,
        profileName: cred.profileName,
        ...(cred.authToken ? { authTokenMasked: maskToken(cred.authToken) } : {}),
        baseUrl: cred.baseUrl,
        modelCount: cred.modelList.length,
      }
    } catch (err) {
      // 没有 / 读不动 源 config.json：这一栏不可用，但 MCP 与 marketplace
      // 两栏照常枚举（它们各自独立）。不 500。
      credentialsError = (err as Error).message
      log.debug(`credentials unavailable: ${credentialsError}`)
    }

    const mcp: WebImportMcpView[] = []
    for (const server of await readSourceMcp(sourceDir)) {
      const masked = maskSecrets(server)
      mcp.push({
        name: masked.name,
        type: masked.type,
        ...(masked.command ? { command: masked.command } : {}),
        ...(masked.url ? { url: masked.url } : {}),
        ...(masked.envKeys ? { envKeys: masked.envKeys } : {}),
        exists: deps.mcpStore.get(masked.name) != null,
        importErrors: validateMcpServer(server),
      })
    }

    const marketplaces: WebImportMarketplaceView[] = []
    const src = await readSourceMarketplaces(sourceDir)
    for (const entry of src.entries) {
      marketplaces.push({
        id: entry.id,
        displayName: entry.displayName,
        sourceUrl: entry.source.url,
        ...(entry.source.ref ? { ref: entry.source.ref } : {}),
        pluginCount: entry.manifest.plugins.length,
        cloneExists: src.cloneExists[entry.id] === true,
        exists: deps.mpStore.has(entry.id),
      })
    }

    const body: WebImportEnumeration = {
      sourceDir,
      exists,
      credentials,
      ...(credentialsError ? { credentialsError } : {}),
      mcp,
      marketplaces,
    }
    return c.json(body)
  })

  return app
}
```

> **注意 Step 5 里的 `exists: !!deps.mpStore && false`**：MCP 的 `exists` 要查
> **桌面版的 MCP store**，而那个 store 是 `buildApiRouter` 从 `SessionManager`
> 拿的，不是 `mpStore`。Task 4 会把 `mcpStore` 加进 `WebImportRouterDeps` 并把这行
> 换成 `deps.mcpStore.get(server.name) != null`。**Step 5 先写成 `false` 是为了让
> 本 Task 只依赖已经打通的 host 门控**；Task 4 会补齐并在测试里断言。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run server/routes/web-import.test.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 7: 跑全量 server 测试与 typecheck**

Run: `npm run typecheck && npx vitest run server/`
Expected: 两个 tsconfig 都无错；server 测试全绿（`buildApiRouter` 多一个可选参数不影响既有调用点）。

- [ ] **Step 8: 提交**

```bash
git add shared/web-import.ts server/routes/web-import.ts server/routes/web-import.test.ts server/bootstrap.ts server/app.ts server/routes/index.ts desktop/main.ts
git commit -m "feat(web-import): enumeration endpoint + explicit host gate

新增 shared/web-import.ts 的线上形状、桌面宿主才挂载的
GET /api/config/web-import，以及 ServerContextOptions/AppOptions/
buildApiRouter 的显式 host 选项（不靠 !bind 隐式推断）。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 9: 更新 spec，让文档与代码一致（三处）**

`docs/superpowers/specs/2026-10-21-desktop-web-import-design.md`：

**(a) §6.1** 把 `credentials` 的 JSON 块换成实际形状（`available / hasToken / profileName / authTokenMasked / baseUrl / modelCount`），并在同段补一句：

```markdown
> 枚举只回屏幕真正渲染的字段：模型分组 / recap / commit 模型只由服务端在导入时
> 读取、界面不展示，因此不上线；MCP 行只带 `name / type / command / url / envKeys /
> exists / importErrors`；marketplace 行只带 `id / displayName / sourceUrl / ref /
> pluginCount / cloneExists / exists`（原本的 `sizeBytes` 不做——每次枚举都整目录
> 遍历不值得）。
```

**(b) §7 的"源 config 无可用 profile"那一行** 与实现不符——实现里 `credentials` 只在**读不动/不存在**时为 `null`；能读但没 token 是 `hasToken: false`。把那行替换为：

```markdown
| 源 config.json 不存在 / 读不动 | `credentials: null` + `credentialsError: <原始错误>`；MCP / marketplace 两栏照常枚举 |
| 源 config 能读但没有 token | `credentials.hasToken: false`（仍是一栏，可以只搬模型）；导入后 `configured` 为 false，客户端继续走向导 |
```

**(c) §8 的状态机那一行** 去掉"useRef 镜像"——前置屏没有任何异步 handler 需要在回调里读最新状态：

```markdown
- **状态机同形**：惰性探测 + `probeCancelRef` 取消竞态 + `Record<name, status>` +
  `Import all` 的 predicate 与提交 filter 同构（这里不需要向导 step 3 那个
  `mcpImportStatusRef` 镜像——没有异步 handler 要在回调里读最新状态）。
```

```bash
git add docs/superpowers/specs/2026-10-21-desktop-web-import-design.md
git commit -m "docs(desktop): align the spec's enumeration wire with what shipped

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `POST` 的 credentials 分支

**Files:**
- Modify: `server/routes/web-import.ts`
- Modify: `server/routes/web-import.test.ts`

**Interfaces:**
- Consumes: `readSourceCredentials`（Task 1）、`queueConfigWrite` / `DEFAULT_PROFILE` / `LEGACY_PROFILE_KEYS` / `config`（`server/config.ts`）、`coerceProfileEntries` / `resolveActiveProfile` / `profileFromLegacyFields` / `LegacyProfileFields`（`server/profiles.ts`）
- Produces: `POST /api/config/web-import` 接受 `{ credentials?: boolean; mcp?: string[]; marketplaces?: string[] }`，返回 `WebImportResult`；本 Task 只实现 `credentials` 分支（`mcp` / `marketplaces` 先返回空结果，Task 4/5 填）

- [ ] **Step 1: 写失败的测试**

追加到 `server/routes/web-import.test.ts`：

```ts
import { loadConfig, config } from '../config.js'

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
    await app.request('/api/config/web-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: true }),
    })
    await loadConfig(stateDir)
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
```

`seedSource` 需要补一行 `mkdirSync(dir, { recursive: true })`（Task 2 已写），确认它不含 recap/commit 字段。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/routes/web-import.test.ts -t credentials`
Expected: FAIL —— `POST /api/config/web-import` 404（还没有这个 handler）。

- [ ] **Step 3: 实现**

在 `server/routes/web-import.ts` 里加 import：

```ts
import { DEFAULT_PROFILE, LEGACY_PROFILE_KEYS, queueConfigWrite, config as serverConfig } from '../config.js'
import { coerceProfileEntries, profileFromLegacyFields, resolveActiveProfile, type LegacyProfileFields } from '../profiles.js'
import type { WebImportCollectionResult, WebImportResult } from '../../shared/web-import.js'
```

在 `buildWebImportRouter` 之前加两个私有函数：

```ts
/** body 里的字符串数组字段：给了但不是数组就是调用方错误。刻意不把字符串
 *  逐字符迭代（与 POST /sessions 的 enabledMcpServers 同一约定）。 */
function stringArrayOrThrow(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array of strings`)
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

const emptyCollection = (): WebImportCollectionResult => ({ imported: [], skipped: [], failed: [] })
```

在 `buildWebImportRouter` 内、`return app` 之前加：

```ts
  /** 把源 profile 写进桌面版 active profile。
   *
   *  profile 的选点与 heal 逻辑与 POST /config/setup 完全同源（coerceProfileEntries
   *  → resolveActiveProfile → 用 entries 的 raw index 落笔）。不另写一份：读写两侧
   *  的目标 profile 一旦漂移，就是 SetupPage 注释里记的那个 P0 缺陷
   *  （token 写进了 profiles[0]，而读的是 active）。
   *
   *  只写源里确实存在的字段：源没有的保留桌面版现状，不清空。 */
  async function importCredentials(sourceDir: string): Promise<WebImportResult['credentials']> {
    const cred = await readSourceCredentials(sourceDir)
    await queueConfigWrite(deps.configDir, (existing) => {
      const rawActiveId = typeof existing.activeProfileId === 'string' ? existing.activeProfileId.trim() : ''
      let entries = coerceProfileEntries(existing.profiles, DEFAULT_PROFILE)
      if (entries.length === 0) {
        // 与 /config/setup 同一手 heal：把读取侧本来就会回退到的那条 profile
        // 实体化，而不是让写入落进一个没人读的位置。
        const seeded = profileFromLegacyFields(existing as unknown as LegacyProfileFields, DEFAULT_PROFILE)
        const raw = Array.isArray(existing.profiles) ? (existing.profiles as unknown[]) : []
        existing.profiles = [seeded, ...raw]
        entries = coerceProfileEntries(existing.profiles, DEFAULT_PROFILE)
      }
      for (const key of LEGACY_PROFILE_KEYS) delete existing[key]
      const active = resolveActiveProfile(
        entries.map((entry) => entry.profile),
        rawActiveId || DEFAULT_PROFILE.id,
        DEFAULT_PROFILE,
      )
      if (existing.activeProfileId !== active.id) existing.activeProfileId = active.id
      const hit = entries.find((entry) => entry.profile === active)
      if (!hit) throw new HttpError(500, 'no resolvable provider profile after config heal')
      const profilesArr = existing.profiles as unknown[]
      const prof = { ...(profilesArr[hit.index] as Record<string, unknown>) }
      if (cred.present.authToken) prof.authToken = cred.authToken
      if (cred.present.baseUrl) prof.baseUrl = cred.baseUrl
      if (cred.present.modelList) prof.modelList = cred.modelList
      if (cred.present.modelGroups) prof.modelGroups = cred.modelGroups
      if (cred.present.recapModel) prof.recapModel = cred.recapModel
      if (cred.present.commitMessageModel) prof.commitMessageModel = cred.commitMessageModel
      profilesArr[hit.index] = prof
    })
    // queueConfigWrite 内部会 applyParsedConfig，所以 serverConfig 已是写入后的
    // 值——`configured` 因此镜像 GET /config 的同名字段（同一个表达式）。
    return { imported: true, configured: !!serverConfig.authToken }
  }

  app.post('/config/web-import', async (c) => {
    const body = await safeJson<{ credentials?: unknown; mcp?: unknown; marketplaces?: unknown }>(c.req)
    if (body.credentials !== undefined && typeof body.credentials !== 'boolean') {
      throw new HttpError(400, 'credentials must be a boolean')
    }
    const mcpNames = stringArrayOrThrow(body.mcp, 'mcp')
    const mpIds = stringArrayOrThrow(body.marketplaces, 'marketplaces')
    const sourceDir = sourceDirOf()

    let credentials: WebImportResult['credentials'] = null
    if (body.credentials === true) {
      // 读源失败是这一项的失败，不是整次请求的失败——其余项照常。
      try {
        credentials = await importCredentials(sourceDir)
      } catch (err) {
        credentials = { imported: false, configured: !!serverConfig.authToken }
        log.warn(`credentials import failed: ${(err as Error).message}`)
      }
    }

    const result: WebImportResult = {
      credentials,
      mcp: emptyCollection(),
      marketplaces: emptyCollection(),
    }
    void mcpNames
    void mpIds
    return c.json(result)
  })
```

> `void mcpNames` / `void mpIds`：Task 4 与 Task 5 会分别删掉其中一个占位。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/routes/web-import.test.ts`
Expected: PASS（Task 2 的 4 个 + 本 Task 的 4 个）。

- [ ] **Step 5: 提交**

```bash
git add server/routes/web-import.ts server/routes/web-import.test.ts
git commit -m "feat(web-import): import credentials into the desktop active profile

写盘路径与 /config/setup 同源（同一 heal + resolveActiveProfile），
只写源里确实存在的字段，configured 镜像 GET /config。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `POST` 的 MCP 分支（含 400 校验用例）

**Files:**
- Modify: `server/routes/web-import.ts`
- Modify: `server/routes/web-import.test.ts`

**Interfaces:**
- Consumes: `readSourceMcp`（Task 1）、`deps.mcpStore`（Task 2 已就位）、`validateMcpServer`（`server/mcp-config.ts`）
- Produces: `POST` 的 `mcp` 分支返回 `WebImportCollectionResult`

- [ ] **Step 1: 写失败的测试**

追加到 `server/routes/web-import.test.ts`：

```ts
describe('POST /api/config/web-import — mcp', () => {
  let stateDir: string
  let sourceDir: string
  beforeEach(() => {
    stateDir = tempDir('web-import-dst')
    sourceDir = tempDir('web-import-src')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'mcp-config.json'), JSON.stringify({
      version: 1,
      servers: [
        { name: 'ctx7', type: 'stdio', command: 'npx', args: ['-y', 'ctx7'], env: { API_KEY: 'sekret' }, enabled: true },
        { name: 'remote', type: 'http', url: 'https://mcp.example.com', enabled: false },
      ],
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

  it('rejects a string where an array is required (no char-by-char iteration)', async () => {
    // Review Focus 5。
    const res = await post({ mcp: 'ctx7' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toContain('mcp must be an array')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/routes/web-import.test.ts -t mcp`
Expected: FAIL —— `imported` 是空数组（分支还没实现），400 用例也不会通过。

- [ ] **Step 3: 实现**

`server/routes/web-import.ts` —— import 区加：

```ts
import { readSourceMcp } from '../web-import.js'
```

> `McpConfigStore` 的类型 import 与 `WebImportRouterDeps.mcpStore` 字段在 Task 2 已经就位，
> 本 Task 不改依赖签名。

在 `importCredentials` 之后加：

```ts
  /** 按名字导入源目录的全局 MCP 服务器。
   *  同名跳过（不覆盖桌面版已有的）、校验不过报该项 failed、其余项继续——
   *  与 POST /api/mcp-config/claude-import 的语义逐条一致。 */
  async function importMcpServers(sourceDir: string, names: string[]): Promise<WebImportCollectionResult> {
    const result = emptyCollection()
    if (names.length === 0) return result
    const servers = await readSourceMcp(sourceDir)
    const byName = new Map(servers.map((s) => [s.name, s]))
    for (const name of names) {
      try {
        const server = byName.get(name)
        if (!server) {
          result.failed.push({ name, error: `not found in ${join(sourceDir, 'mcp-config.json')}` })
          continue
        }
        const errors = validateMcpServer(server)
        if (errors.length > 0) {
          result.failed.push({ name, error: errors.join('; ') })
          continue
        }
        if (deps.mcpStore.get(server.name)) {
          result.skipped.push(server.name)
          continue
        }
        deps.mcpStore.upsert({ ...server, enabled: true })
        result.imported.push(server.name)
      } catch (err) {
        result.failed.push({ name, error: (err as Error).message })
      }
    }
    await deps.mcpStore.flush()
    return result
  }
```

`GET` handler 里那行 MCP `exists` 在 Task 2 已经是最终形态（`deps.mcpStore.get(masked.name) != null`），本 Task 不需要动它。

POST handler 里把 `mcp: emptyCollection(),` 换成：

```ts
      mcp: await importMcpServers(sourceDir, mcpNames),
```

并删掉 `void mcpNames`。

> `deps.mcpStore` 在 Task 2 就已经进了 `WebImportRouterDeps`（挂载点也在那时写好），
> 本 Task 只是让 POST 真正用它——不再改依赖签名、不再改 `server/routes/index.ts`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/routes/web-import.test.ts`
Expected: PASS（4 + 4 + 4）。

- [ ] **Step 5: 提交**

```bash
git add server/routes/web-import.ts server/routes/web-import.test.ts
git commit -m "feat(web-import): import global MCP servers by name

同名跳过、校验失败逐项报告、字符串字段非法即 400（对齐
/api/mcp-config/claude-import 的语义）。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: `POST` 的 marketplace 分支（克隆目录 + 启用标志）

**Files:**
- Modify: `server/routes/web-import.ts`
- Modify: `server/routes/web-import.test.ts`

**Interfaces:**
- Consumes: `readSourceMarketplaces`（Task 1）、`MpStore.cloneDirFor` / `has` / `upsert` / `setEnabled` / `flush`
- Produces: `POST` 的 `marketplaces` 分支返回 `WebImportCollectionResult`

- [ ] **Step 1: 写失败的测试**

追加到 `server/routes/web-import.test.ts`：

```ts
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'

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

  it('rejects a string where an array is required', async () => {
    const res = await post({ marketplaces: 'claude-code' })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/routes/web-import.test.ts -t marketplaces`
Expected: FAIL —— `imported` 为空、`builtin` 目录里什么都没有。

- [ ] **Step 3: 实现**

`server/routes/web-import.ts` —— import 区加：

```ts
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readSourceMarketplaces } from '../web-import.js'
```

在 `importMcpServers` 之后加：

```ts
  /** 按 id 导入 marketplace：把源的克隆目录整份拷到桌面版自己的
   *  `cloneDirFor(id)`，条目 cloneDir 改写后落盘，启用标志随之一并搬。
   *
   *  先拷到 `<目标>.importing` 再 rename 落地：一次中断只会留下临时目录，
   *  不会留下半个 clone 被 store 当真货（失败时临时目录被清掉）。
   *
   *  条目本身直接复用源 store coerce 出来的 MpEntry——它已经满足目标 store
   *  parseItems 的全部约束（40 位 sha、manifest、cloneDir），只有 cloneDir
   *  需要改写。不手改 marketplaces.json：store 的 side state（enabledPlugins）
   *  与并发写保护都在 store 里。 */
  async function importMarketplaces(sourceDir: string, ids: string[]): Promise<WebImportCollectionResult> {
    const result = emptyCollection()
    if (ids.length === 0) return result
    const src = await readSourceMarketplaces(sourceDir)
    const byId = new Map(src.entries.map((e) => [e.id, e]))
    for (const id of ids) {
      const entry = byId.get(id)
      if (!entry) {
        result.failed.push({ name: id, error: `not found in ${join(sourceDir, 'marketplaces.json')}` })
        continue
      }
      if (deps.mpStore.has(id)) {
        result.skipped.push(id)
        continue
      }
      const target = deps.mpStore.cloneDirFor(id)
      const staging = `${target}.importing`
      try {
        if (!src.cloneExists[id]) throw new Error(`clone dir is missing: ${entry.cloneDir}`)
        await mkdir(dirname(target), { recursive: true })
        await rm(staging, { recursive: true, force: true })
        await cp(entry.cloneDir, staging, { recursive: true })
        await rename(staging, target)
      } catch (err) {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
        result.failed.push({ name: id, error: (err as Error).message })
        continue
      }
      deps.mpStore.upsert({ ...entry, cloneDir: target })
      for (const [plugin, on] of Object.entries(src.enabled[id] ?? {})) {
        if (on) deps.mpStore.setEnabled(plugin, id, true)
      }
      result.imported.push(id)
    }
    await deps.mpStore.flush()
    return result
  }
```

POST handler 里把 `marketplaces: emptyCollection(),` 换成：

```ts
      marketplaces: await importMarketplaces(sourceDir, mpIds),
```

并删掉 `void mpIds`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/routes/web-import.test.ts`
Expected: PASS（4 + 4 + 4 + 5）。

- [ ] **Step 5: 跑全量 server 测试与 typecheck**

Run: `npm run typecheck && npx vitest run server/`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add server/routes/web-import.ts server/routes/web-import.test.ts
git commit -m "feat(web-import): import marketplaces with their clone dirs

clone 目录 fs.cp 到 cloneDirFor(id) 并改写条目 cloneDir，先 staging 再
rename 落地；启用标志随市场一起搬；同 id 跳过、单项失败隔离。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 前置屏组件 `src/components/SetupWebImport.tsx`

> **交互模型已被验收裁定取代（读本 Task 的代码片段前先看这条）**：下面写的是当时
> 落地的"行内 checkbox 即时导入 + `Import all`"。验收时用户裁定它有两个缺陷——
> 勾选即写盘、撤不回来；扁平清单也看不出每行属于哪一类。**现行模型**是：三类各自
> `.setup-label` + 计数 + 一行 `.setup-hint`；勾选只增删 `selected` 集合（零副作用、
> 可完整撤回）；唯一的写盘动作是 `Import selected (n)`（body 只带选中子集），
> `Select all importable` 一键勾上所有可导入行；`Skip` 仍是唯一交接口（此按钮原先叫 `Next`，验收时因"读起来像带着勾选继续"被改名）。判据以
> spec §8 的那条规则为准，别照抄本 Task 的 `Import all` 片段。

**Files:**
- Create: `src/components/SetupWebImport.tsx`
- Test: `src/components/SetupWebImport.test.tsx`

**Interfaces:**
- Consumes: `api`（`src/hooks/useApi.ts`）、`useOverlayScrollbar`、`IconCheck`（`src/components/icons/ToolIcons.tsx`）、`shared/web-import.ts` 的 `WebImportEnumeration` / `WebImportResult`
- Produces: `export function SetupWebImport({ onContinue, onConfigured }: Props)`，`Props = { onContinue: () => void; onConfigured: () => void | Promise<void> }`

- [ ] **Step 1: 写失败的测试**

`src/components/SetupWebImport.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../hooks/useOverlayScrollbar', () => ({ useOverlayScrollbar: () => () => {} }))

// 延迟 import：组件在模块顶层没有 host 判断，这里直接用静态 import 即可。
import { SetupWebImport } from './SetupWebImport'

const ENUMERATION = {
  sourceDir: '/home/me/.claude-react-web',
  exists: true,
  credentials: { available: true, hasToken: true, profileName: 'Work', authTokenMasked: '****1234', baseUrl: 'https://api.example.com', modelCount: 2 },
  mcp: [{ name: 'ctx7', type: 'stdio' as const, command: 'npx', envKeys: ['API_KEY'], exists: false, importErrors: [] }],
  marketplaces: [{ id: 'claude-code', displayName: 'claude-code', sourceUrl: 'https://github.com/example/claude-code', pluginCount: 3, cloneExists: true, exists: true }],
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue(ENUMERATION)
  vi.mocked(api.post).mockResolvedValue({ credentials: null, mcp: { imported: [], skipped: [], failed: [] }, marketplaces: { imported: [], skipped: [], failed: [] } })
})
afterEach(() => vi.clearAllMocks())

describe('SetupWebImport', () => {
  it('shows the probe row first, then the three sections', async () => {
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(screen.getByText(/Reading your Claude Web config/)).toBeTruthy()
    expect(await screen.findByText('Work')).toBeTruthy()
    expect(screen.getByText('ctx7')).toBeTruthy()
    expect(screen.getByText('claude-code')).toBeTruthy()
    // 已有同 id 的市场 → 状态位显示既有措辞。
    expect(screen.getByText('Already exists')).toBeTruthy()
  })

  it('reports "not found" instead of an empty list when the source has nothing', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...ENUMERATION, exists: false, credentials: null, mcp: [], marketplaces: [] })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(await screen.findByText(/未找到网页版配置|No Claude Web config found/)).toBeTruthy()
  })

  it('offers Retry when the probe itself fails', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(await screen.findByText('Retry')).toBeTruthy()
  })

  it('posts every not-yet-imported item from the bulk button, then hands over to onConfigured', async () => {
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: ['ctx7'], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: ['claude-code'], failed: [] },
    })
    const onConfigured = vi.fn()
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: ['ctx7'],
      marketplaces: [],
    })
  })

  it('stays on the screen when the import leaves the server unconfigured', async () => {
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: false },
      mcp: { imported: [], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: [], failed: [] },
    })
    const onConfigured = vi.fn()
    const onContinue = vi.fn()
    render(<SetupWebImport onContinue={onContinue} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled())
    expect(onConfigured).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Next'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/SetupWebImport.test.tsx`
Expected: FAIL —— 组件文件不存在。

- [ ] **Step 3: 实现**

`src/components/SetupWebImport.tsx`：

```tsx
// 桌面版首启的"从网页版导入"前置屏。
//
// 它不是向导的一步（不进 setup-steps.ts 的 STEPS），SetupPage 里早返回渲染，
// 所以进度点 / 步数计数器天然不出现。
//
// DOM / 类名 / 文案 / 状态机照抄既有两处模式：
//   - step 0 与 step 3 的 health 行：探测中 / 失败 + Retry，且都允许继续；
//   - step 3 的 MCP 导入清单：行内 checkbox 即时导入、Import all 批量导入、
//     状态位文案 Importing… / Imported / Already exists / Failed。
// 不新增 CSS，颜色只用主题变量。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../hooks/useApi'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { IconCheck } from './icons/ToolIcons'
import type { WebImportEnumeration, WebImportResult } from '../../shared/web-import'

type RowStatus = 'idle' | 'importing' | 'imported' | 'exists' | 'failed'

interface Props {
  /** 用户没导入凭证（或只导了 MCP / 市场）→ 走向导第一步。 */
  onContinue: () => void
  /** 凭证已写入且服务端 configured → 交给 SetupPage 走既有收尾路径。 */
  onConfigured: () => void | Promise<void>
}

/** 行 key：credentials / mcp:<name> / mp:<id> —— 一个字典管三栏的状态位。 */
const CREDENTIALS_ROW = 'credentials'
const mcpRow = (name: string) => `mcp:${name}`
const mpRow = (id: string) => `mp:${id}`

export function SetupWebImport({ onContinue, onConfigured }: Props) {
  const setPageOs = useOverlayScrollbar({ autoHide: 'leave' })
  const [data, setData] = useState<WebImportEnumeration | undefined>(undefined)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, RowStatus>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const probeCancelRef = useRef<(() => void) | null>(null)

  /** 探测：与 step 3 的 probeClaudeMcp 同形（可取消 + Retry 复用同一条路径）。 */
  const probe = useCallback(() => {
    probeCancelRef.current?.()
    let cancelled = false
    probeCancelRef.current = () => { cancelled = true }
    setProbeError(null)
    void api
      .get<WebImportEnumeration>('/config/web-import')
      .then((r) => {
        if (cancelled) return
        setData(r)
        // 桌面版已有的 MCP / 市场直接落成终态，勾选框像 step 3 一样禁用。
        setStatus((prev) => {
          const next = { ...prev }
          for (const s of r.mcp) if (s.exists) next[mcpRow(s.name)] = 'exists'
          for (const m of r.marketplaces) if (m.exists) next[mpRow(m.id)] = 'exists'
          return next
        })
      })
      .catch((err) => {
        if (cancelled) return
        setProbeError(err instanceof Error ? err.message : 'Failed to read the Claude Web config')
      })
  }, [])

  useEffect(() => {
    probe()
    return () => { probeCancelRef.current?.() }
  }, [probe])

  /** 发一次导入请求：只导入并落状态位，**不做任何跳转**——收尾是用户按 Next 时
   *  才发生的导航决定（见 handleNext；收尾时机在验收实测后改过一次）。 */
  const runImport = useCallback(async (sel: { credentials: boolean; mcp: string[]; marketplaces: string[] }) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    setStatus((prev) => {
      const next = { ...prev }
      if (sel.credentials) next[CREDENTIALS_ROW] = 'importing'
      for (const n of sel.mcp) next[mcpRow(n)] = 'importing'
      for (const id of sel.marketplaces) next[mpRow(id)] = 'importing'
      return next
    })
    try {
      const res = await api.post<WebImportResult>('/config/web-import', sel)
      setStatus((prev) => {
        const next = { ...prev }
        if (sel.credentials) next[CREDENTIALS_ROW] = res.credentials?.imported ? 'imported' : 'failed'
        for (const n of res.mcp.imported) next[mcpRow(n)] = 'imported'
        for (const n of res.mcp.skipped) next[mcpRow(n)] = 'exists'
        for (const f of res.mcp.failed) next[mcpRow(f.name)] = 'failed'
        for (const id of res.marketplaces.imported) next[mpRow(id)] = 'imported'
        for (const id of res.marketplaces.skipped) next[mpRow(id)] = 'exists'
        for (const f of res.marketplaces.failed) next[mpRow(f.name)] = 'failed'
        return next
      })
      // 逐项失败不弹错、不阻断：行上的 Failed 就是信号（与 step 3 一致）。
      if (res.credentials?.configured) {
        await onConfigured()
        return
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    }
    setSubmitting(false)
  }, [submitting, onConfigured])

  /** 渲染期一律读 state，不读 ref：ref 是给异步 handler 读"最新值"用的，在这里
   *  没有任何异步 handler 需要它，用 ref 反而会慢一帧（anyImportable 这类派生值
   *  会因此算错）。 */
  const statusOf = (key: string): RowStatus => status[key] ?? 'idle'
  const doneOrRunning = (key: string) => {
    const s = statusOf(key)
    return s === 'importing' || s === 'imported' || s === 'exists'
  }

  const importing = submitting
  const nothingToImport = data !== undefined && !probeError && (
    !data.credentials && data.mcp.length === 0 && data.marketplaces.length === 0
  )

  /** 批量导入：把还没导入 / 还没存在的项一次 POST 出去。 */
  const importAll = () => {
    const sel = {
      credentials: !doneOrRunning(CREDENTIALS_ROW) && data?.credentials != null,
      mcp: (data?.mcp ?? []).filter((s) => statusOf(mcpRow(s.name)) === 'idle').map((s) => s.name),
      marketplaces: (data?.marketplaces ?? []).filter((m) => statusOf(mpRow(m.id)) === 'idle').map((m) => m.id),
    }
    if (!sel.credentials && sel.mcp.length === 0 && sel.marketplaces.length === 0) return
    void runImport(sel)
  }

  /** 任意一项可导入 ⇒ Import all 有活干（predicate 与 importAll 的 filter 同构）。 */
  const anyImportable = data !== undefined && (
    (data.credentials != null && !doneOrRunning(CREDENTIALS_ROW))
    || data.mcp.some((s) => statusOf(mcpRow(s.name)) === 'idle')
    || data.marketplaces.some((m) => statusOf(mpRow(m.id)) === 'idle')
  )

  const statusLabel = (key: string) => {
    const s = statusOf(key)
    if (s === 'importing') return 'Importing…'
    if (s === 'imported') return <span style={styles.ok}><IconCheck size={12} /> Imported</span>
    if (s === 'exists') return 'Already exists'
    if (s === 'failed') return <span style={styles.fail}>Failed</span>
    return null
  }

  const checkbox = (key: string, label: string, onCheck: () => void) => {
    const s = statusOf(key)
    const done = s === 'imported' || s === 'exists'
    return (
      <input
        type="checkbox"
        checked={done}
        disabled={done || s === 'importing' || submitting}
        onChange={onCheck}
        style={{ marginTop: 3, flexShrink: 0 }}
        aria-label={label}
      />
    )
  }

  return (
    <div className="setup-page" ref={setPageOs}>
      <div className="setup-card">
        <h1 className="setup-title">Welcome to Claude Web</h1>
        <p className="setup-subtitle">Import your existing Claude Web configuration from the web version.</p>

        {/* 探测中 —— 与 step 3 的 "Reading your Claude CLI config…" 同形。 */}
        {data === undefined && !probeError && (
          <div className="setup-health-row setup-health-row-checking">
            <span className="setup-spinner spinner" aria-hidden="true" />
            <span className="setup-hint">Reading your Claude Web config…</span>
          </div>
        )}

        {/* 探测失败 —— 与 step 0 / step 3 的失败行同形，且允许继续。 */}
        {probeError && (
          <div className="setup-health-row setup-health-row-fail">
            <span className="setup-health-icon" aria-hidden="true">!</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ ...styles.hint, color: 'var(--fg)' }}>Could not read your Claude Web config.</p>
              <p className="setup-prefilled-hint">{probeError}</p>
            </div>
            <button type="button" onClick={probe} style={styles.secondaryBtn}>Retry</button>
          </div>
        )}

        {/* 源里什么都没有 —— 明确说明，而不是渲染一张空清单。 */}
        {data !== undefined && nothingToImport && (
          <>
            <div className="setup-health-row setup-health-row-fail">
              <span className="setup-health-icon" aria-hidden="true">!</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ ...styles.hint, color: 'var(--fg)' }}>No Claude Web config found.</p>
                <p className="setup-prefilled-hint">{data.sourceDir}</p>
              </div>
            </div>
            <p className="setup-hint">
              You can keep going and configure this app by hand — nothing to import here.
            </p>
          </>
        )}

        {data !== undefined && data.exists && (
          <>
            <div className="setup-field">
              <label className="setup-label">From the web version</label>
              <p className="setup-hint">
                Read from <code style={styles.code}>{data.sourceDir}</code>. Everything you
                import is copied into this app; the web version is left untouched.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {/* 凭证与模型 */}
                {data.credentials && (
                  <div style={styles.row}>
                    {checkbox(CREDENTIALS_ROW, 'Import credentials', () => void runImport({ credentials: true, mcp: [], marketplaces: [] }))}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <code style={{ ...styles.code, fontSize: 'var(--fs-sm)' }}>{data.credentials.profileName}</code>
                        <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)' }}>
                          credentials + models
                          {data.credentials.authTokenMasked ? ` · ${data.credentials.authTokenMasked}` : ''}
                          {` · ${data.credentials.modelCount} model(s)`}
                        </span>
                      </div>
                    </div>
                    <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)', flexShrink: 0, marginTop: 2 }}>
                      {statusLabel(CREDENTIALS_ROW)}
                    </span>
                  </div>
                )}
                {data.credentialsError && (
                  <p className="setup-hint">Credentials unavailable: {data.credentialsError}</p>
                )}

                {/* 全局 MCP */}
                {data.mcp.map((s) => (
                  <div key={s.name} style={styles.row}>
                    {checkbox(mcpRow(s.name), `Import ${s.name}`, () => void runImport({ credentials: false, mcp: [s.name], marketplaces: [] }))}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <code style={{ ...styles.code, fontSize: 'var(--fs-sm)' }}>{s.name}</code>
                        <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)' }}>
                          {s.type}
                          {s.command ? ` · ${s.command}` : ''}
                          {s.url ? ` · ${s.url}` : ''}
                        </span>
                      </div>
                      {s.envKeys && s.envKeys.length > 0 && (
                        <p className="setup-hint" style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>
                          env: {s.envKeys.join(', ')}
                        </p>
                      )}
                      {s.importErrors.length > 0 && (
                        <p className="setup-hint" style={{ fontSize: 'var(--fs-xs)', marginTop: 2, color: 'var(--msg-error-fg)' }}>
                          {s.importErrors.join('; ')}
                        </p>
                      )}
                    </div>
                    <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)', flexShrink: 0, marginTop: 2 }}>
                      {statusLabel(mcpRow(s.name))}
                    </span>
                  </div>
                ))}

                {/* Marketplaces */}
                {data.marketplaces.map((m) => (
                  <div key={m.id} style={styles.row}>
                    {checkbox(mpRow(m.id), `Import ${m.id}`, () => void runImport({ credentials: false, mcp: [], marketplaces: [m.id] }))}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <code style={{ ...styles.code, fontSize: 'var(--fs-sm)' }}>{m.id}</code>
                        <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)' }}>
                          {`${m.pluginCount} plugin(s)`}
                          {m.cloneExists ? '' : ' · clone missing'}
                        </span>
                      </div>
                      <p className="setup-hint" style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>{m.sourceUrl}</p>
                    </div>
                    <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)', flexShrink: 0, marginTop: 2 }}>
                      {statusLabel(mpRow(m.id))}
                    </span>
                  </div>
                ))}

                {anyImportable && (
                  <button
                    type="button"
                    onClick={importAll}
                    disabled={importing}
                    style={{ ...styles.secondaryBtn, alignSelf: 'flex-start', marginTop: 4 }}
                  >
                    {importing ? 'Importing…' : 'Import all'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {error && <p role="alert" className="setup-field-error">{error}</p>}

        <div style={styles.footer}>
          <div style={styles.footerLeft} />
          <div style={styles.footerRight}>
            <button
              type="button"
              onClick={onContinue}
              disabled={submitting}
              style={styles.submitBtn}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  hint: { margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)', lineHeight: 1.4 },
  code: {
    fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)', padding: '1px 5px',
    background: 'var(--bg-elev-2)', borderRadius: 'var(--radius-xs)',
  },
  row: {
    display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px',
    background: 'var(--bg-elev-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)',
  },
  ok: { display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent)' },
  fail: { color: 'var(--msg-error-fg)' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 4 },
  footerLeft: { display: 'flex', gap: 8 },
  footerRight: { display: 'flex', gap: 8 },
  submitBtn: {
    minHeight: 44, padding: '0 16px', fontSize: 'var(--fs-md)', fontWeight: 600, fontFamily: 'inherit',
    background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--on-accent)',
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  secondaryBtn: {
    minHeight: 44, padding: '0 14px', fontSize: 'var(--fs-base)', fontFamily: 'inherit',
    background: 'var(--bg-elev-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    color: 'var(--fg)', cursor: 'pointer',
  },
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/SetupWebImport.test.tsx`
Expected: PASS（5 个用例）。

- [ ] **Step 5: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 无错。`styles` 里的 CSSProperties 与既有 SetupPage 同风格；`React` 命名空间类型在本仓库既有文件里可用。

- [ ] **Step 6: 提交**

```bash
git add src/components/SetupWebImport.tsx src/components/SetupWebImport.test.tsx
git commit -m "feat(setup): desktop web-import pre-screen

三态（探测中 / 清单 / 没找到）+ 行内 checkbox 即时导入 + Import all，
DOM、类名、状态位文案全部照抄向导 step 0 与 step 3；不新增 CSS。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: SetupPage 接线 + 更新桌面向导测试

**Files:**
- Modify: `src/components/SetupPage.tsx`（前置屏状态与早返回）
- Modify: `src/components/SetupPage.desktop.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `SetupWebImport`、既有 `isDesktopHost()`（`src/host-capabilities.ts`）、既有 `Props.onConfigured`
- Produces: 桌面宿主上 `SetupPage` 先渲染前置屏；点 `Skip` 进 step 0；导入（勾选 + `Import selected (n)`，**只导入不跳转**）之后按 `Skip` 才调 `onConfigured({ openNewSession: true })`（收尾时机由验收实测改过一次；交互模型又在验收后改过一次，见 Task 6 顶部与 spec §2 需求基线和 §8；按钮标签随后由 `Next` 改为 `Skip`）

- [ ] **Step 1: 改桌面向导测试（先让它红）**

`src/components/SetupPage.desktop.test.tsx`：

1. `beforeEach` 的 `api.get` mock 里补一条（放在 `/profiles` 那条之前）：

```ts
    if (url === '/config/web-import')
      return Promise.resolve({ sourceDir: '/tmp/.claude-react-web', exists: false, credentials: null, mcp: [], marketplaces: [] })
```

2. `walkToFinish` 前面加一步跳过前置屏，并把 Next 的点击次数改成 6：

```ts
/** 桌面宿主的向导之前有一屏"从网页版导入"（SetupWebImport）——先点 Next 跳过它。 */
async function walkToFinish() {
  fireEvent.click(await screen.findByText('Next'))          // 前置屏 → step 0
  fireEvent.click(await screen.findByText('Continue'))      // step 0 → step 1
  fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), { target: { value: 'sk-test' } })
  // Desktop: 1→2→3→4→5→7 —— 前置屏已经占用了一次 Next，这里仍是 5 次。
  for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('Next'))
}
```

3. 新增一个用例，钉住前置屏只在桌面宿主出现、且"跳过"后序数不变：

```ts
  it('renders the web-import pre-screen first, and Next reveals step 1 of 7', async () => {
    const SetupPage = await importDesktopSetupPage()
    render(<SetupPage onConfigured={vi.fn(async () => {})} />)

    // 前置屏：没有进度点、没有步数计数器。
    expect(await screen.findByText(/Reading your Claude Web config|No Claude Web config found/)).toBeTruthy()
    expect(screen.queryByText(/^Step \d+ of \d+$/)).toBeNull()

    fireEvent.click(screen.getByText('Next'))
    expect(await screen.findByText('Step 1 of 7')).toBeTruthy()
    expect(screen.getByText('Continue')).toBeTruthy()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/SetupPage.desktop.test.tsx`
Expected: FAIL —— 前置屏还没接进 SetupPage，`findByText('Next')` 找不到（向导 step 0 的按钮是 Continue）。

- [ ] **Step 3: 实现接线**

`src/components/SetupPage.tsx` —— import 区加：

```tsx
import { SetupWebImport } from './SetupWebImport'
```

在组件内、`probeClaudeHealth` 相关 hook 之后（第一个 `return` 之前）加状态：

```tsx
  // ── 前置屏：从网页版导入（仅桌面宿主）──
  // 桌面版与网页版的 state 目录刻意隔离（desktop/main.ts），所以已配好网页版的
  // 用户打开桌面版必然重走向导。这一屏让他一次搬过来。
  //
  // 刻意不做成 STEPS 里的一步：那需要把现有 id 1..7 整体后移，并改掉本文件里
  // 所有 `step === N` 字面比较。做成一屏早返回，进度点与步数计数器天然不出现。
  const [showImport, setShowImport] = useState(() => isDesktopHost())
```

在组件第一个 `return (` 之前加早返回：

```tsx
  if (showImport) {
    return (
      <SetupWebImport
        onContinue={() => setShowImport(false)}
        // 导入已把 config.json 写好（服务端 configured:true），所以直接走既有
        // 收尾路径：App 的 handleConfigured 会 refreshConfig + setIsConfigured，
        // 并自动开 New session 对话框。
        onConfigured={() => onConfigured({ openNewSession: true })}
      />
    )
  }
```

- [ ] **Step 4: 跑客户端测试确认通过**

Run: `npx vitest run src/components/SetupPage.desktop.test.tsx src/components/SetupPage.test.tsx src/components/SetupWebImport.test.tsx`
Expected: 全绿。网页版 `SetupPage.test.tsx` 无桌面 bridge → 不出现前置屏，不受影响。

- [ ] **Step 5: 跑全量门禁**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: 两个 tsconfig 无错、全部测试通过、lint 干净。

- [ ] **Step 6: 提交**

```bash
git add src/components/SetupPage.tsx src/components/SetupPage.desktop.test.tsx
git commit -m "feat(setup): show the web-import pre-screen on the desktop host

前置屏做成早返回而不是新增一步——不改 STEPS、不改序数、不动
SetupPage 里既有的 step === N 比较。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 实机验收（不是自动化，必须真跑）

**Files:** 无（只验证）

**Interfaces:**
- Consumes: 前面全部
- Produces: 验收证据（命令输出）

- [ ] **Step 1: 起桌面宿主（开发态）**

Run: `npm run desktop`（实测确认：`package.json` 里是 `desktop: npm run build:client && npm run build:desktop && electron dist/desktop/main.mjs`；`dev:desktop` 不存在，其形状是与 `dev` 不同的"先 build 再起 Electron"）

预期：窗口打开即出现导入前置屏，副标题为 Import your existing Claude Web configuration…，且探测行随后变成三栏清单（本机应能列出 Mify 的凭证行、若干 MCP 行、6 个市场行）。

> 注意：`npm run desktop` 从本 worktree 启动 Electron，但 Electron 的 userData 是按 app 名解析的，所以它读写的是**你真实的** `%APPDATA%/claude-react-web/state`——这正是要验收的目标，但意味着这一步会改动真实数据（下面的备份步骤就是为此）。

- [ ] **Step 2: 验证"本地复制克隆目录"这一条（本机数据是真的）**

Run（在导入之前先记下目标目录为空）：

```bash
ls "$APPDATA/claude-react-web/state/marketplace-cache" 2>/dev/null || echo "(empty — expected)"
```

点 **`Select all importable` → `Import selected (n)`**（现行模型；原先是一击
`Import all`，见 Task 6 顶部）。预期：按钮变 Importing…（市场克隆约 122 MB，会停留数秒）→ 随后窗口直接进入主界面（导入凭证成功 ⇒ configured）。

再验证：

```bash
ls "$APPDATA/claude-react-web/state/marketplace-cache"
node dist/cli.mjs doctor --state-dir "$APPDATA/claude-react-web/state"
```

预期：每个市场一个目录、且**没有** `*.importing` 残留；doctor 的 `authToken` 由 FAIL 变成 `ok`。

- [ ] **Step 3: 验证"不再弹 setup"**

关掉窗口、重新打开桌面版。预期：直接进主界面，**不再出现**导入屏或向导。

再打开 Settings → Profiles：应能看到从网页版搬过来的 profile（模型列表 = 源的那份）。

- [ ] **Step 4: 验证只导 MCP / 市场时的走向导分支**

把桌面版 state 目录挪走（保留备份）造出"未配置"状态：

```bash
mv "$APPDATA/claude-react-web/state" "$APPDATA/claude-react-web/state.bak"
```

重启桌面版 → 前置屏出现 → 只勾 MCP 那一行（**不**勾凭证）→ 行上变 Imported，界面**留在本屏**（因为 configured 仍为 false）→ 点 `Skip` → 走进向导 step 0/1/2 → 到 step 3 时，刚导入的服务器应显示 **Already exists**。

跑完把备份恢复：

```bash
rm -rf "$APPDATA/claude-react-web/state" && mv "$APPDATA/claude-react-web/state.bak" "$APPDATA/claude-react-web/state"
```

- [ ] **Step 5: 记录验收结果**

把 Step 1-4 的实际观察（含 `ls` / `doctor` 的输出）写进 `.agents/tasks/desktop-web-import/verification.md`（沿用该目录既有任务的记录格式），提交：

```bash
git add .agents/tasks/desktop-web-import/verification.md
git commit -m "test(desktop): real-device acceptance for the web-import pre-screen

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 完成后

跑一次全量门禁并做一次完整 diff 的代码评审（CLAUDE.md 要求：未评审的代码不得入库）：

```bash
npm run typecheck && npm run test && npm run lint
```

然后对 `git diff <本次分支起点>..HEAD` 跑 `code-review`，逐条核对发现再修。