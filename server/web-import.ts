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
 *  "源里没有"（不是"请清空"），必须保留桌面版的现状。
 *
 *  语义边界：true 只表示"磁盘上写了这个键"，**不表示这个值有意义**。
 *  raw `modelList: ['']`（coercion 后整条回退成 fallback）或一个没有任何
 *  tier slot 的 modelGroups 条目都会让 flag 为 true，而 coercion 之后的
 *  值仍是空的/回退的。写入侧不得把 true 当成"值可用"的证据。 */
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

/** 读文件做一次 JSON 校验：不存在 → 返回（下面的 store 会给出空值）；
 *  存在但读不动 → 原样抛出；存在但不是合法 JSON → throw（消息带文件路径
 *  和解析失败原因，与 readSourceCredentials 同一条规则）。
 *
 *  为什么不把这条规则放进 store：store 是 app 自己读写自己文件的组件，
 *  "损坏 → 空" 对它自己是合理的；只有"读别人的目录"才需要把"没有"和
 *  "读不动"分开。文件很小，多读一次的代价可以忽略（这样也不用动 store）。 */
async function assertParseableJson(file: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  try {
    JSON.parse(raw)
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`)
  }
}

/** 源目录里的全局 MCP 服务器。用同一个 McpConfigStore 类读源目录，解析规则
 *  与桌面版自己的 store 完全一致。
 *
 *  两种"读不到"刻意分开，这个不对称是设计，不要"统一"掉：
 *    - 文件不存在 → 空数组（用户就是没配过）
 *    - 存在但不是合法 JSON → throw。store 会把"损坏"也折叠成 [] + warn，
 *      导入页于是只能说"没有可导入的东西"，用户又得手敲一遍——正是本功能
 *      要消灭的场景。
 *    - 合法 JSON 但形状不对（如顶层是数组）→ 仍走 store 的宽容路径 → 空数组。
 *      这与 app 自己的 store 对自己文件的规则一致，也与
 *      /mcp-config/claude-import 对 Claude CLI 文件的规则一致。 */
export async function readSourceMcp(dir: string): Promise<StoredMcpServer[]> {
  await assertParseableJson(join(dir, 'mcp-config.json'))
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

/** 源目录里的 marketplace，含每个市场的启用标志与克隆目录存在性。
 *
 *  与 readSourceMcp 同一条不对称规则（是设计，不是遗漏）：文件不存在 →
 *  空值；存在但不是合法 JSON → throw；合法 JSON 但形状不对 → store 的
 *  宽容路径 → 空值。
 *
 *  `load({ readOnly: true })`：MpStore 的默认 load 会自愈过期缓存（重解析
 *  clone 里的 manifest 并回写 marketplaces.json）。读别人的 state 目录不能
 *  这样——那等于桌面版去改网页版的配置文件。代价是过期缓存会被原样返回。 */
export async function readSourceMarketplaces(dir: string): Promise<SourceMarketplaces> {
  await assertParseableJson(join(dir, 'marketplaces.json'))
  const store = new MpStore({ stateDir: dir })
  const entries = await store.load({ readOnly: true })
  const enabled: Record<string, Record<string, boolean>> = {}
  const cloneExists: Record<string, boolean> = {}
  for (const entry of entries) {
    enabled[entry.id] = store.enabledMapFor(entry.id)
    cloneExists[entry.id] = existsSync(entry.cloneDir)
  }
  return { entries, enabled, cloneExists }
}
