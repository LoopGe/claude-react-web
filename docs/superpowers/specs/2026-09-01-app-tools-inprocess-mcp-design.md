# 2026-09-01 · 首方 git 工具（进程内 SDK MCP 服务器）

## 背景与目标

项目已能连接**外部** MCP 服务器，但缺少「宿主自产工具」这一层——即 SDK 官方推荐的 `createSdkMcpServer()`（进程内 MCP 服务器），让宿主把自定义能力直接注入给代理。本设计首期实现 **A 块**：一套**首方 git 工具**，代理可通过 `mcp__apptools__*` 直接执行 git 读写，复用现有 `server/git.ts`（零新增 shell 路径）。注入采用「**全局默认可配 + 每会话可覆盖**」。

## 关键决策

- **进程内注册，非 JSON 存储**：`createSdkMcpServer()` 在会话进程内创建，返回 `McpSdkServerConfigWithInstance`（带活 `McpServer` 实例，**不可序列化**）→ **不能**进 JSON `McpConfigStore`、走不了用户配置链路。每个会话在 spawn 时构建自己的实例（handler 闭包绑定该会话 `cwd`）。
- **单一合入口 `mergeMcpServers`**：现有 spawn 与 live `setMcpServers` 都走它（replace 语义覆盖动态集）。在此处依「有效开关」追加/省略 apptools 实例 → spawn 与实时天然一致，无第二条逻辑。
- **权限沿用会话 permission flow**：`mcp__apptools__*` 不预批准，destructive 动词按会话 permissionMode 弹窗/放行，与其它 MCP 工具一致。
- **zod 提为直接依赖**：`tool()` 的输入 schema 用 zod（现为 SDK 传递依赖、可解析但未声明），跟随官方 API。
- **范围守卫**：只做首方 git 工具与注入链路；插件→代理工具桥 (B)、BGFM 工具重绑定 (C)、逐工具权限 UI 均**不做**。

## 暴露的工具集

服务器名 `apptools`；工具全限定名 `mcp__apptools__{name}`。

只读（`readOnlyHint: true`）：
- `git_status` — 工作树状态
- `git_branches` — 分支列表
- `git_stashes` — stash 列表
- `git_log` — 提交历史

写工具（无 hint）：
- `git_stage(paths[])` / `git_unstage(paths[])`
- `git_discard(paths[])`
- `git_checkout(branch, create?)` / `git_branch(?name)`
- `git_commit(message)`
- `git_stash(?message)` / `git_stash_pop` / `git_stash_drop(index?)`
- `git_abort_merge` / `git_abort_rebase`

全部：handler 走 `runGit(cwd, args, opts)` + `validateRepoRelativePath` + `--` 前缀（与 GitPanel 同安全姿态）；返回 `{ content: [{ type:'text', text }] }`，错误 `isError:true` + 消息。

## 架构 / 组件

**新模块 `server/sdk-tools/app-tools.ts`**
- `buildAppToolsServer(cwd: string, git: GitDeps): McpServerConfig` — 用 `createSdkMcpServer({ name:'apptools', tools:[…] })`，handler 闭包绑定 `cwd`。`GitDeps` 注入 `runGit`/`validateRepoRelativePath` 以便单测 mock。
- 纯函数，无副作用调用；每个会话 spawn 时调用。

**注册（单一入口）**
- session-manager `mergeMcpServers()`：有效开关为真时，把 `buildAppToolsServer(session.cwd)` 追加进最终 map（覆盖任何同名）；关时省略。spawn（`sdkOptions.mcpServers` → provider）与 live `setMcpServers` 都经此，行为一致。对非 git 仓库/无 `cwd` 的会话：只追加 `git_status` 等读工具仍安全（`runGit` 已会 `{isRepo:false}`），故统一注入；`gitStartSha` 等既有机制不动。

## 配置 / 会话双层

- **全局默认**：config.json `appTools.git?: boolean`（默认 `true`），入 `server/config.ts`。
- **每会话覆盖**：`SessionMeta.appToolsGit?: boolean`（新增字段），写入 `SessionInfo`（镜像 `showPinnedUserMessage` 的 `session.X ?? global.X` 语义）。
- **有效值** = `session.appToolsGit ?? config.appTools.git ?? true`。
- **UI**：SettingsPanel MCP 区加「让 Claude 使用 git 工具」开关（会话覆盖 on/off/继承全局/重置），沿用 showPinned 交互。

## 数据流

agent 调用 `mcp__apptools__git_commit` → session permission flow 判定 → handler `runGit(cwd,['commit','-m',msg])` → 文本结果回 agent。写工具落地后经既有 git-broadcast 触发 `git-status-changed`。带死锁/超时：`runGit` 沿用既有 execFile 行为；进程内 handler 必须 async、有界（遵守默认 ~60s stream-close 上限）。

## 错误处理

- `runGit` 非零退出 → `isError:true` + stderr 摘要。
- `validateRepoRelativePath` 拒绝（`..` / 绝对路径）→ `isError:true`。
- 非仓库 `cwd` → 各工具返回明确消息（读工具 `{isRepo:false}` 语义；写工具报「not a git repo」）。
- handler 内异常（如 git 未安装）→ catch → `isError:true`（避免把原始异常泄漏/挂起 turn）。

## 依赖 / 影响

- package.json 新增直接依赖 `zod`。
- `server/session-manager.ts`：`mergeMcpServers` 追加 apptools；`snapshotMeta`/写 store/`info()` 透出 `appToolsGit`。
- `server/config.ts`：读 `appTools.git` 全局默认。
- `shared/session-info.ts` / `server/session-types.ts` / `server/persistence.ts`：`appToolsGit` 字段（跨重启保留）。
- 客户端 `SettingsPanel` MCP 区开关。

## 测试

- **工具构建**：`buildAppToolsServer` 产 `name:'apptools'`、工具集正确；只读工具带 `readOnlyHint`。
- **handler**：各工具传给 `runGit` 的 argv 正确；路径校验拒绝 `..`/绝对路径；错误 `isError:true`。
- **合并**：`mergeMcpServers` 开→追加、关→省略；与 live `setMcpServers` 结果一致。
- **双层开关**：全局默认开/关、会话覆盖、`SessionInfo` 透出、重启保留（持久化 round-trip，避免 sandbox 的同款坑）。
- 全量 typecheck（双 tsconfig）/lint/test。

## 验收

- 新会话（git 仓库 cwd）spawn 后可让代理 `mcp__apptools__git_status` / `git_commit` 等生效。
- 全局关掉或会话覆盖关掉 → 工具不注入。
- 权限 flow 对写动词生效（manual 弹窗、bypass 直跑）。
- 重启保留每会话覆盖。
- typecheck/lint/test 全绿。