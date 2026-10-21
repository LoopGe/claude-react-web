// 桌面版初始化时"从网页版导入配置"的端点。
//
// 只在桌面宿主挂载（server/routes/index.ts），web 宿主上路径不存在 → 404。
// 语义对齐 /api/mcp-config/claude-import：密钥不过线、同名/同 id 跳过、
// 逐项失败隔离、返回 imported/skipped/failed。

import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler } from '../errors.js'
import { createLogger } from '../log.js'
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

  return app
}