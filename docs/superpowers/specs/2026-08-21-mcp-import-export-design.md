# MCP 配置导入 / 导出

Date: 2026-08-21

## Problem

本应用的全局 MCP 服务器配置存在 `~/.claude-react-web/mcp-config.json`，目前只能：
- 逐个通过表单添加 / 编辑（`McpInstaller`）；
- 从 Claude CLI 的 `~/.claude.json` 导入。

没有**批量备份 / 迁移 / 分享**配置的能力。用户换机器、备份、或把一组服务器配置分享给同事时，只能手动重填表单。

## Goal / non-goals

- **Goal (E):** 把当前已配置的 MCP 服务器导出成一个 JSON 文件，可下载保存。
- **Goal (I):** 从一个 JSON 文件批量导入 MCP 服务器，带预览和冲突提示，一次导入多个。
- **Goal (S):** 导出时可选择包含密钥（env/headers 真实值）以支持完整迁移；默认屏蔽，保证分享安全。
- **Non-goal:** OAuth 令牌永不导出（机器 / 会话绑定，不可移植）；换机后重新走 OAuth 授权。
- **Non-goal:** 兼容 Claude Desktop / Cursor 等其它工具格式（`{ "mcpServers": {...} }`）。导入端宽容接受键值对象形状，但仅此而已，不做跨工具格式转换。
- **Non-goal:** 每会话的 MCP 启用列表（`enabledMcpServers`）导出 —— 那是会话状态，不是可分享的配置。
- **Non-goal:** 服务端改动任何 `~/.claude.json`（只读）。

## Design

### 导出文件格式（`shared/mcp-types.ts` 新增类型）

带版本的信封，`format` 固定为 `claude-react-web-mcp`：

```ts
export interface McpExportServer {
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  /** masked 时为 { key: '' }；full 时为真实值 */
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  alwaysLoad?: boolean
  enabled?: boolean
}

export interface McpExportFile {
  format: 'claude-react-web-mcp'
  version: 1
  exportedAt: number
  /** masked: env/headers 值置空串；full: 含真实值 */
  secretScope: 'masked' | 'full'
  servers: McpExportServer[]
}
```

- 不包含 `createdAt` / `updatedAt` / `oauth`（纯配置快照，可读性强）。
- `secretScope` 记录本文件是否带密钥，导入端不依赖它做安全判断（校验总是照常执行），只作展示信息。

### 服务端接口（`server/mcp-routes.ts`）

#### `GET /api/mcp-config/export?includeSecrets=1&names=a,b,c`

- 读 `store.list()`；`names`（可选，逗号分隔）过滤；缺省导出全部（含 disabled）。
- `includeSecrets=1` 时 `env`/`headers` 带真实值，`secretScope: 'full'`；否则值置 `''`，`secretScope: 'masked'`。
- **永不输出 `oauth`**。
- 响应体直接就是信封 JSON（客户端 fetch → Blob 下载）。

#### `POST /api/mcp-config/import/preview` — body `{ file: string }`

- `file` 为文件原文。服务端解析（见下）→ 逐条 `coerceStoredMcpServer` + `validateMcpServer`。
- 响应（全部 masked，`maskSecrets`）：

```jsonc
{
  "servers": [
    { "name": "git", "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-git"],
      "envKeys": ["GIT_TOKEN"], "exists": false, "errors": [] }
  ]
}
```

- `exists`：该名字是否已在全局 store 中（驱动客户端的冲突分区）。
- `errors`：`validateMcpServer` 的失败信息（如命令不在白名单）。整段 JSON 无法解析 / 不是对象 / 服务器数组为空 → `400` 带可读错误。

#### `POST /api/mcp-config/import` — body `{ file: string, names: string[], overwrite: boolean }`

- 服务端**重新解析** `file`（不信任客户端解析结果，与 `claude-import` 同模式），按 `names` 过滤。
- 语义：
  - 解析/校验失败 → `failed: [{ name, error }]`。
  - 已存在且 `!overwrite` → `skipped`。
  - 已存在且 `overwrite` → `updated`：非密钥标量字段（type/command/args/url/alwaysLoad/enabled）整体替换；`env`/`headers` 以文件键集为准（file-authoritative）—— 文件里非空值覆盖，空串视为哨兵（回落到该键已有值，保住已有密钥），**文件未出现的键被删除**。保留原 `createdAt`，`updatedAt` 刷新。
  - 新增 → `imported`：`createdAt`/`updatedAt` 置 now，`enabled` 默认 `true`。
  - **新增服务器导入时丢弃值为空串的 `env`/`headers` 条目**（masked 文件的空值不产生无意义条目）；overwrite 路径下空串作为哨兵保留该键的已有值。
- 落盘立即 `store.flush()`（与 `claude-import` 一致，防未 ref 的 debounce 定时器丢数据）。
- 响应：`{ imported: string[], updated: string[], skipped: string[], failed: [{ name, error }] }`。

#### 服务端解析（三态宽容）

`parseImportFile(file: string): { entries: Array<{ key, raw }> }`，按序识别：

1. **本应用信封**：顶层对象含 `format` 或 `servers` 字段 → 按信封解析，取 `servers` 数组；`servers` 非数组时报格式错误。
2. **裸数组**：`[{ name, ... }]`。
3. **键值对象**：`{ name: { ... } }`（key 作 fallback name）。

每项走 `coerceStoredMcpServer(raw, key)`（已有函数），`null` → 该项记为失败。

### 客户端 UI

入口在 `GlobalSettingsModal.tsx` 的 MCP 标签页头部：`+ Add Server` 旁加 `Import` / `Export` 两个按钮。

#### Export 弹窗（新组件 `McpExportDialog.tsx`）

- 列出 `mcpServers` 全部，每项前勾选框（默认全选）+ 顶部「全选 / 全不选」。
- 勾选「包含密钥值（env/headers）」开关（默认关）；关闭时提示"密钥将被清空，目标机器需重新填写"。
- 「Download」→ `GET /api/mcp-config/export?includeSecrets=1&names=a,b,c`（全选时省略 `names`）→ 用 Blob 下载 `claude-react-web-mcp-servers.json`（复用 `src/utils/exportConversation.ts` 的下载写法，抽一个 `downloadJson(filename, json)` 小工具）。
- Esc / 遮罩关闭。

#### Import 流程（新组件 `McpImportDialog.tsx`）

1. 点 `Import` → 隐藏 `<input type="file" accept=".json,application/json">`。
2. 读文件文本 → `POST /import/preview`。
3. 预览弹窗分三区：
   - **新增**（有效、本机没有）—— 勾选行，默认勾选。
   - **已存在（冲突）** —— 琥珀色警示区，文案"这些服务器已存在，勾选将覆盖"；每行勾选即表示该条覆盖；顶部「覆盖已存在」总开关批量勾/全不勾。
   - **无效**（`errors` 非空）—— 标红禁用，展示错误文本。
4. 「Import」按钮（无有效勾选时禁用）→ `POST /import`，body `{ file, names: [...已勾选], overwrite: 是否存在任何已勾选的冲突行 }` → 展示汇总（导入 N / 覆盖 M / 跳过 K / 失败 N）→ 关闭并 `refreshMcp()`。
5. 整段解析失败 / 空文件 → 弹窗内直接显示错误，不关闭。

### 错误处理

- 导出：`names` 含不存在名字 → 忽略该名（不报错），空结果也照常下载空数组信封。
- 导入：非法 JSON / 非对象 / 无服务器 → `400` 可读信息；每条冲突独立成 `failed`，不中断其余导入。
- 网络/超时沿用现有 `api` fetch 包装。

### 安全

- `includeSecrets` 导出与其余路由同级（受 web access token 保护），无额外门槛；弹窗内明示风险。
- OAuth 令牌任何路径都不导出。
- 导入端服务端强制 `validateMcpServer`（含命令白名单），客户端无法绕过。
- 导入请求中的文件原文会经过本机 HTTP（应用默认 loopback）；`import/preview` 响应一律 masked。

### 测试

**服务端（`server/mcp-routes.test.ts` 或 `server/mcp-config.test.ts`）**
- 导出默认：env/headers 值置空串、`secretScope: 'masked'`、永不出现 `oauth`。
- 导出 `includeSecrets=1`：含真实 env/headers。
- 导出 `names` 过滤；缺省含全部。
- 预览：信封 / 裸数组 / 键值对象三态都能解析；无效项标 `errors`；已存在标 `exists`；非法 JSON → 400。
- 导入：新增默认 `enabled: true`；空值 env/headers 丢弃；overwrite 替换标量 + 合并 env/headers（空值不覆盖已有）；非 overwrite 跳过已存在；命令白名单外拒绝。
- 往返：导出（masked）→ 导入 → 服务器集合一致（无密钥）。

**客户端**
- `McpImportDialog`：预览三区渲染；勾选 → POST body 正确；汇总展示。
- `McpExportDialog`：勾选子集 + includeSecrets → 请求参数正确。

## Files touched

- `shared/mcp-types.ts` — `McpExportFile` / `McpExportServer` 类型
- `server/mcp-routes.ts` — `GET /export`、`POST /import/preview`、`POST /import`、`parseImportFile`
- `src/types.ts` — 客户端复用/再导出共享类型
- `src/components/GlobalSettingsModal.tsx` — MCP 页头加 Import/Export 按钮与弹窗状态
- `src/components/McpExportDialog.tsx`（新）— 导出弹窗
- `src/components/McpImportDialog.tsx`（新）— 导入预览弹窗 + 文件选择
- `src/utils/downloadJson.ts`（新）— `downloadJson(filename, json)` 小工具，复用 `exportConversation.ts` 的 Blob 下载写法
- `server/mcp-routes.test.ts` / `server/mcp-config.test.ts` — 服务端测试
- `src/components/McpImportDialog.test.tsx` / `McpExportDialog.test.tsx`（新）— 客户端测试
