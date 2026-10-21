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