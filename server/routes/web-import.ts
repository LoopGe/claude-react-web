// 桌面版初始化时"从网页版导入配置"的端点。
//
// 只在桌面宿主挂载（server/routes/index.ts），web 宿主上路径不存在 → 404。
// 语义对齐 /api/mcp-config/claude-import：密钥不过线、同名/同 id 跳过、
// 逐项失败隔离、返回 imported/skipped/failed。

import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler, HttpError } from '../errors.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'
import { DEFAULT_PROFILE, LEGACY_PROFILE_KEYS, queueConfigWrite, config as serverConfig } from '../config.js'
import { coerceProfileEntries, maskToken, profileFromLegacyFields, resolveActiveProfile, type LegacyProfileFields } from '../profiles.js'
import { maskSecrets, validateMcpServer } from '../mcp-config.js'
import type { MpStore } from '../mp-store.js'
import type { McpConfigStore, StoredMcpServer } from '../mcp-config.js'
import { readSourceCredentials, readSourceMcp, readSourceMarketplaces, webStateDir } from '../web-import.js'
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
        available: true,
        hasToken: cred.authToken.length > 0,
        profileName: cred.profileName,
        ...(cred.authToken ? { authTokenMasked: maskToken(cred.authToken) } : {}),
        baseUrl: cred.baseUrl,
        modelCount: cred.modelList.length,
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
          ...(masked.command ? { command: masked.command } : {}),
          ...(masked.url ? { url: masked.url } : {}),
          ...(masked.envKeys ? { envKeys: masked.envKeys } : {}),
          exists: deps.mcpStore.get(masked.name) != null,
          importErrors: validateMcpServer(server),
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
          sourceUrl: entry.source.url,
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
        deps.mcpStore.upsert({ ...server, enabled: true })
        result.imported.push(server.name)
      } catch (err) {
        result.failed.push({ name, error: (err as Error).message })
      }
    }
    await deps.mcpStore.flush()
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
      marketplaces: emptyCollection(),
    }
    void mpIds
    return c.json(result)
  })

  return app
}