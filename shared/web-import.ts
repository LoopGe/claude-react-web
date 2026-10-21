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
  /** 读源 mcp-config.json 失败时的原始错误；与 mcp: [] 同时出现。
   *  逐栏失败隔离——它坏掉不影响另外两栏。 */
  mcpError?: string
  marketplaces: WebImportMarketplaceView[]
  /** 读源 marketplaces.json 失败时的原始错误；与 marketplaces: [] 同时出现。 */
  marketplacesError?: string
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