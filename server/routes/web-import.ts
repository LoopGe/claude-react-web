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
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createErrorHandler, HttpError } from '../errors.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'
import { DEFAULT_PROFILE, LEGACY_PROFILE_KEYS, queueConfigWrite, config as serverConfig } from '../config.js'
import { coerceProfileEntries, maskToken, profileFromLegacyFields, resolveActiveProfile, type LegacyProfileFields } from '../profiles.js'
import { maskSecrets, validateMcpServer } from '../mcp-config.js'
import type { MpStore } from '../mp-store.js'
import type { McpConfigStore, StoredMcpServer } from '../mcp-config.js'
import { readSourceCredentials, readSourceMcp, readSourceMarketplaces, webStateDir, hasUsableProfileFields, type SourceMarketplaces } from '../web-import.js'
import type { WebImportCollectionResult, WebImportEnumeration, WebImportMarketplaceView, WebImportMcpView, WebImportResult } from '../../shared/web-import.js'

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

/** body 里的字符串数组字段：给了但不是数组就是调用方错误。刻意不把字符串
 *  逐字符迭代（与 POST /sessions 的 enabledMcpServers 同一约定）。 */
function stringArrayOrThrow(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array of strings`)
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

const emptyCollection = (): WebImportCollectionResult => ({ imported: [], skipped: [], failed: [] })

/** 打码文本里 `scheme://userinfo@` 的 userinfo —— 三处都会碰到它：市场的
 *  `sourceUrl`、远程 MCP 的 `url`、以及 stdio MCP 的 `command`
 *  （`npx -y mcp-remote https://user:tok@host/mcp` 是常见形状）。
 *
 *  刻意**不做 URL 解析**：command 是一整条命令行，解析不了；而且"逐字保留"就是
 *  这里的契约——`new URL(…).toString()` 会给裸 host 补尾斜杠、归一化 `..` 段、
 *  重写百分号编码与主机大小写，屏上出现的就不再是源里那条串。所以只做一次扫描
 *  替换，userinfo 之外一个字符都不动（同一函数也保证三处的规则是同一个）。
 *
 *  规则与 URL 语义一致，两个分支其实是**同一条规则**——userinfo 里**第一个** `:`
 *  之后的**全部**内容才是秘密（WHATWG 的 username / password 正是在第一个冒号处
 *  切分），没有 `:` 就整段 userinfo 都是秘密：
 *    - `user:secret@` → 保留 `user`（用户认得出是哪个账号），`secret` 换成 `***`；
 *    - `user:pa:ss@` → 第一个冒号之后全是密码 → `user:***@`（按**最后**一个冒号切
 *      会只换掉 `ss`，把中间那段 `pa:` 留在屏上）；
 *    - `user:@`（冒号后是空的）→ 同样保留 `user`，输出 `user:***@`：那个位置本来
 *      就没有任何东西，被换掉的空串也不是秘密；
 *    - 裸 `token@`（没有冒号可分）→ 整段 userinfo 都是秘密，输出 `***@`。
 *  没有 `scheme://` 的串（本地路径、普通命令文本）原样返回。 */
function maskUserinfo(text: string): string {
  // scheme 段必须带 `://`；userinfo 段取到**最后一个**仍在 authority 里的 `@`
  // （`[^\s/?#]*@` 贪婪到最后一个可能位置，且不得跨过 `/ ? #` 或空白——跨不过去
  // 正是"还在 authority 里"/"只是 path 里恰好有个 @"的判据）：
  //   - `https://user:p@ss@host/x` → userinfo 是 `user:p@ss`，输出
  //     `https://user:***@host/x`（停在第一个 `@` 会把密码尾巴 `ss@host` 留在线上）；
  //   - `https://host/a@b/c` → 从 `://` 起只到 `host` 就被 `/` 挡住，没有 `@` 可匹配
  //     → 整串原样返回（**不能**把 path 里的 `@` 当成 userinfo）。
  // `@` 取最后、`:` 取最先：两段都是 URL 语义（authority 的 userinfo 到最后一个
  // `@` 为止，username / password 在第一个 `:` 处切分），不是随手挑的。
  return text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*@)/gi,
    (_all, scheme: string, userinfo: string) => {
      const colon = userinfo.indexOf(':')
      return colon === -1 ? `${scheme}***@` : `${scheme}${userinfo.slice(0, colon)}:***@`
    },
  )
}

export function buildWebImportRouter(deps: WebImportRouterDeps): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[web-import]'))
  const sourceDirOf = () => deps.sourceDir ?? webStateDir()

  app.get('/config/web-import', async (c) => {
    const sourceDir = sourceDirOf()
    const exists = PORTABLE_FILES.some((f) => existsSync(join(sourceDir, f)))
    // 三栏各自 try/catch：源里任何一个文件读不动，只塌掉它自己那一栏，
    // 另外两栏照常枚举（spec §7 的逐栏失败隔离）。不 500。
    let credentials: WebImportEnumeration['credentials'] = null
    let credentialsError: string | undefined
    try {
      const cred = await readSourceCredentials(sourceDir)
      credentials = {
        // 不是常量：源 active profile 里一个可写字段都没有时（profiles: []、
        // 字段全空白的 profile、legacy 顶层形状）这一行导不进去，客户端据此
        // 压暗 + 禁用（判据与写入侧的 `imported` 是同一个函数）。
        available: hasUsableProfileFields(cred.present),
        hasToken: cred.authToken.length > 0,
        profileName: cred.profileName,
        ...(cred.authToken ? { authTokenMasked: maskToken(cred.authToken) } : {}),
        baseUrl: cred.baseUrl,
        // 只在源里**确实有**可用列表时报条数：否则 cred.modelList 是 coercion 的
        // fallback（DEFAULT_PROFILE 那份），报出来的是默认值条数，不是用户的。
        ...(cred.present.modelList ? { modelCount: cred.modelList.length } : {}),
      }
    } catch (err) {
      // 没有 / 读不动 源 config.json：这一栏不可用，但 MCP 与 marketplace
      // 两栏照常枚举（它们各自独立）。
      credentialsError = (err as Error).message
      log.debug(`credentials unavailable: ${credentialsError}`)
    }

    const mcp: WebImportMcpView[] = []
    let mcpError: string | undefined
    try {
      for (const server of await readSourceMcp(sourceDir)) {
        const masked = maskSecrets(server)
        mcp.push({
          name: masked.name,
          type: masked.type,
          // 只改**视图**（store 里那条 URL 一个字都不动：导入侧还要靠它去拉
          // 私有仓库、远程 MCP 还要靠它去连），见 maskUserinfo。
          ...(masked.command ? { command: maskUserinfo(masked.command) } : {}),
          ...(masked.url ? { url: maskUserinfo(masked.url) } : {}),
          ...(masked.envKeys ? { envKeys: masked.envKeys } : {}),
          exists: deps.mcpStore.get(masked.name) != null,
          // 校验用的是源里那条原始 server，而它的报错会把违规的 command / url
          // **原样**引回去（"command '…' is not in the allowlist"）——所以报错
          // 文本同样要过一遍 maskUserinfo，否则 command 那一处的打码从这条
          // 缝又漏回线上（行上的红字也照旧显示）。
          importErrors: validateMcpServer(server).map(maskUserinfo),
        })
      }
    } catch (err) {
      // 源 mcp-config.json 存在但读不动：这一栏为空 + 原始错误，凭证与
      // marketplace 两栏不受影响。
      mcpError = (err as Error).message
      log.debug(`mcp servers unavailable: ${mcpError}`)
    }

    const marketplaces: WebImportMarketplaceView[] = []
    let marketplacesError: string | undefined
    try {
      const src = await readSourceMarketplaces(sourceDir)
      for (const entry of src.entries) {
        marketplaces.push({
          id: entry.id,
          displayName: entry.displayName,
          // 带凭证的 URL 只把凭证打掉，仓库本身照旧认得出（见 maskUserinfo）。
          sourceUrl: maskUserinfo(entry.source.url),
          ...(entry.source.ref ? { ref: entry.source.ref } : {}),
          pluginCount: entry.manifest.plugins.length,
          cloneExists: src.cloneExists[entry.id] === true,
          exists: deps.mpStore.has(entry.id),
        })
      }
    } catch (err) {
      marketplacesError = (err as Error).message
      log.debug(`marketplaces unavailable: ${marketplacesError}`)
    }

    const body: WebImportEnumeration = {
      sourceDir,
      exists,
      credentials,
      ...(credentialsError ? { credentialsError } : {}),
      mcp,
      ...(mcpError ? { mcpError } : {}),
      marketplaces,
      ...(marketplacesError ? { marketplacesError } : {}),
    }
    return c.json(body)
  })

  /** 把源 profile 写进桌面版 active profile。
   *
   *  profile 的选点与 heal 逻辑与 POST /config/setup 完全同源（coerceProfileEntries
   *  → resolveActiveProfile → 用 entries 的 raw index 落笔）。不另写一份：读写两侧
   *  的目标 profile 一旦漂移，就是 SetupPage 注释里记的那个 P0 缺陷
   *  （token 写进了 profiles[0]，而读的是 active）。
   *
   *  只写源里确实存在的字段：源没有的保留桌面版现状，不清空。
   *
   *  源里一条**可用** profile 都没有时（`profiles: []`、字段全空白的 profile、
   *  或还是 legacy 顶层形状——readSourceCredentials 根本不看那六个顶层键），
   *  下面写入循环的六个 `if (cred.present.X)` 全为假：源里的值一个都落不到
   *  profile。那种情况必须报 imported: false —— 客户端行上写 Imported 是谎报
   *  （用户以为凭证搬过来了，桌面版其实还是未配置）。
   *  返回 `nothingWritten` 而不是提前 return：config heal 那一整段（与
   *  /config/setup 同源的不变量，见上）不因为"没东西可写"而短路。 */
  async function importCredentials(sourceDir: string): Promise<WebImportResult['credentials']> {
    const cred = await readSourceCredentials(sourceDir)
    const nothingWritten = !hasUsableProfileFields(cred.present)
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
    return { imported: !nothingWritten, configured: !!serverConfig.authToken }
  }

  /** 按名字导入源目录的全局 MCP 服务器。
   *  同名跳过（不覆盖桌面版已有的）、校验不过报该项 failed、其余项继续——
   *  与 POST /api/mcp-config/claude-import 的语义逐条一致。 */
  async function importMcpServers(sourceDir: string, names: string[]): Promise<WebImportCollectionResult> {
    const result = emptyCollection()
    if (names.length === 0) return result
    let servers: StoredMcpServer[]
    try {
      servers = await readSourceMcp(sourceDir)
    } catch (err) {
      // 源 mcp-config.json 存在但读不动：整栏失败（与 GET 的 mcpError 同一语义）。
      // 每个被请求的名字各记一条，POST 本身仍 200 —— 逐项失败隔离，
      // 不因为它坏掉而 500 掉整次请求（凭证那一栏已经可能写成功了）。
      const error = (err as Error).message
      for (const name of names) result.failed.push({ name, error })
      return result
    }
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
        // 刻意不搬 oauth（抛掉它再落 store，不是"顺手"的简化）：
        //   - 枚举屏不上线它，用户看不到有东西跟着来；
        //   - app 自己的导出路径（maskSecrets + 导出信封）也从不吐它；
        //   - 它里面的 redirectUrl 是**宿主相关**的（OAuth 流程从 `c.req.url`
        //     推出来，见 mcp-routes 的 startMcpOAuth），而桌面宿主把 /api/*
        //     走 in-process，根本没有 TCP 端口可回——搬过去就是一个静默坏掉的
        //     回调地址，回调时还会被 `server.oauth?.redirectUrl ?? …` 优先采用。
        // 代价值得：到 MCP 面板点一次授权即可，而半坏的 OAuth 流看不出来。
        const { oauth: _oauth, ...withoutOAuth } = server
        deps.mcpStore.upsert({ ...withoutOAuth, enabled: true })
        result.imported.push(server.name)
      } catch (err) {
        result.failed.push({ name, error: (err as Error).message })
      }
    }
    await deps.mcpStore.flush()
    return result
  }

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
    let src: SourceMarketplaces
    try {
      src = await readSourceMarketplaces(sourceDir)
    } catch (err) {
      // 源 marketplaces.json 存在但读不动：整栏失败（与 GET 的 marketplacesError
      // 同一语义）。每个被请求的 id 各记一条，POST 本身仍 200 —— 逐项失败隔离，
      // 不因为它坏掉而 500 掉整次请求（凭证那一栏已经可能写成功了）。
      const error = (err as Error).message
      for (const id of ids) result.failed.push({ name: id, error })
      return result
    }
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
      mcp: await importMcpServers(sourceDir, mcpNames),
      marketplaces: await importMarketplaces(sourceDir, mpIds),
    }
    return c.json(result)
  })

  return app
}
