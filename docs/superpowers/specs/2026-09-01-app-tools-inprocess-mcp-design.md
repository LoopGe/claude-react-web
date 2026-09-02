# 2026-09-01 · 首方 git 工具（进程内 SDK MCP 服务器）

## 背景与目标

项目已能连接**外部** MCP 服务器，但缺少「宿主自产工具」这一层——即 SDK 官方推荐的 `createSdkMcpServer()`（进程内 MCP 服务器），让宿主把自定义能力直接注入给代理。本设计首期实现 **A 块**：一套**首方 git 工具**，代理可通过 `mcp__apptools__*` 直接执行 git 读写，复用现有 `server/git.ts`（零新增 shell 路径）。注入采用「**全局默认可配 + 每会话可覆盖**」。

## 关键决策

- **进程内注册，非 JSON 存储**：`createSdkMcpServer()` 在会话进程内创建，返回 `McpSdkServerConfigWithInstance`（带活 `McpServer` 实例，**不可序列化**）→ **不能**进 JSON `McpConfigStore`、走不了用户配置链路。每个会话在 spawn 时构建自己的实例（handler 闭包绑定该会话 `cwd`）。
- **双注入点（spawn + live）共用 `injectAppTools`**：spawn 在 `provider.createSession` 前把 apptools 并入 `fullOpts.mcpServers`（在 `snapshotMeta` 之后，故持久化的 `mcpServerNames` 保持用户配置集）；live `setMcpServers`（replace 语义）在转发前同样注入。两条路径都经 `SessionManager.injectAppTools`，开/关行为一致，无第三条逻辑。
- **权限沿用会话 permission flow**：`mcp__apptools__*` 不预批准，destructive 动词按会话 permissionMode 弹窗/放行，与其它 MCP 工具一致。
- **zod 提为直接依赖**：`tool()` 的输入 schema 用 zod（现为 SDK 传递依赖、可解析但未声明），跟随官方 API。
- **范围守卫**：只做首方 git 工具与注入链路；插件→代理工具桥 (B)、BGFM 工具重绑定 (C)、逐工具权限 UI 均**不做**。

## 暴露的工具集

服务器名 `apptools`；工具全限定名 `mcp__apptools__{name}`。

只读（`annotations.readOnlyHint: true`）：
- `git_status` — 工作树状态
- `git_branches` — 分支列表
- `git_stashes` — stash 列表
- `git_log` — 提交历史（limit 1..100）

写工具（无 hint）：
- `git_stage(paths[])` / `git_unstage(paths[])`
- `git_discard(paths[])` — 按文件状态分发：tracked → `discardTracked`（revert 到 HEAD），untracked → `discardUntracked`（从磁盘删除）
- `git_checkout(branch, create?)` — 切到分支；`create:true` → `git checkout -b <branch>`（无 autoStash，冲突时返回 isError）
- `git_branch_create(name)` — 新建分支（不切换，复用 GitPanel 的 branch 动词）
- `git_commit(message)`（非 amend）
- `git_stash_create(?message)` / `git_stash_pop`（弹 0）/ `git_stash_drop(index?)`
- `git_abort_merge` / `git_abort_rebase`

全部：handler 走 `server/git.ts` 高层 helper（`getStatus`/`stageFiles`/…，**绝不**调用未导出的 `runGit`）+ `validateRepoRelativePath`/`validateBranchName` + `--` 前缀（与 GitPanel 同安全姿态）；返回 `{ content: [{ type:'text', text }] }`，错误 `isError:true` + 消息。每个 handler 包 `try/catch`，绝不让 MCP call reject。

## 架构 / 组件

**新模块 `server/sdk-tools/app-tools.ts`**
- `buildAppToolsTools(cwd): SdkMcpToolDefinition[]` — 纯函数，导出以便单测直接断言工具集（name / description / `annotations.readOnlyHint`）并调用 handler。
- `buildAppToolsServer(cwd): McpSdkServerConfigWithInstance` — `createSdkMcpServer({ name:'apptools', tools: buildAppToolsTools(cwd) })`。
- handler 闭包绑定 `cwd`；每个会话 spawn / live 注入时调用。

**注册（双注入点，单一 helper）**
- `SessionManager.injectAppTools(servers, s)`：有效开关为真且 `s.cwd` 有值时把 `buildAppToolsServer(s.cwd)` 并入 map（覆盖同名用户服务器）；关或无 cwd 时原样返回。
- spawn：`provider.createSession` 前 `fullOpts.mcpServers = this.injectAppTools(...)`。
- live：`setMcpServers` 转发前注入。
- 无 cwd 的会话不注入；非 git 仓库的 cwd 照常注入——读工具由 `getStatus` 返回 `{isRepo:false}`，写工具在调用时报「not a git repository」（isError）。`gitStartSha` 等既有机制不动。

## 配置 / 会话双层

- **全局默认**：config.json `appToolsGit?: boolean`（默认 `true`），入 `server/config.ts`（扁平布尔，与 `autoRecap` 同款）。
- **每会话覆盖**：`SessionMeta.appToolsGit?: boolean`（新增字段），写入 `SessionInfo`（镜像 `showPinnedUserMessage` 的 `session.X ?? global.X` 语义）。
- **有效值** = `session.appToolsGit ?? config.appToolsGit ?? true`。
- **UI**：SettingsPanel MCP 区加「Let Claude use git tools」开关（会话覆盖 on/off/继承全局/重置），沿用 showPinned 交互；文案注明「下次会话启动生效」（注入在 spawn / live setMcpServers 时读取，运行中会话不即时变更）。
- **MCP 服务器列表过滤**：`apptools` 不出现在 SettingsPanel 的 MCP 服务器管理列表（它由自己的开关管理，reconnect/toggle 对进程内服务器无意义）；`mcpServerNames` 也保持用户配置集（不混入 apptools）。

## 数据流

agent 调用 `mcp__apptools__git_commit` → session permission flow 判定 → handler 调 `commitChanges(cwd, msg, false)` → 文本结果回 agent。写工具落地后经既有 git-broadcast 触发 `git-status-changed`。进程内 handler 必须 async、有界（遵守默认 ~60s stream-close 上限）。

## 错误处理

- 写 helper（`stageFiles`/`commitChanges`/…）对非仓库 `cwd` 抛 `HttpError('Not a git repository')` → `isError:true` + 消息。
- `validateRepoRelativePath` / `validateBranchName` 拒绝（`..` / 绝对路径 / 非法分支名）→ `isError:true`。
- 读工具对非仓库返回 `{isRepo:false}` 的 JSON。
- handler 内任意异常（如 git 未安装）→ catch → `isError:true`（避免把原始异常泄漏/挂起 turn）。

## 依赖 / 影响

- package.json 新增直接依赖 `zod`（版本对齐传递依赖）。
- `server/session-manager.ts`：`injectAppTools` 双注入点；`setAppTools`（每会话覆盖）+ `writeStore`/`info()` 透出 `appToolsGit`。
- `server/config.ts`：读 `appToolsGit` 全局默认（并入 `WRITABLE_CONFIG_KEYS`）。
- `shared/session-info.ts` / `server/session-types.ts` / `server/persistence.ts`：`appToolsGit` 字段（跨重启保留）。
- 客户端 `SettingsPanel` MCP 区开关；`globalPrefs` 增 `appToolsGit`。

## 测试

- **工具构建**：`buildAppToolsTools` 产工具集正确；只读工具带 `readOnlyHint`；handler 直接调用（mock `../git.js`）。
- **handler**：各工具传给 git helper 的参数正确；`git_discard` 按状态分发 tracked/untracked；错误 `isError:true`。
- **注入**：spawn 有 cwd 时 `mcpServers.apptools` 存在、无 cwd 时省略；live `setMcpServers` 注入且 `mcpServerNames` 不含 apptools；会话覆盖关时省略。
- **双层开关**：全局默认开/关、会话覆盖路由（`POST /sessions/:id/app-tools`）、`SessionInfo` 透出、重启保留（持久化 round-trip）。
- 全量 typecheck（双 tsconfig）/lint/test。

## 验收

- 新会话（git 仓库 cwd）spawn 后可让代理 `mcp__apptools__git_status` / `git_commit` 等生效。
- 全局关掉或会话覆盖关掉 → 工具不注入。
- 权限 flow 对写动词生效（manual 弹窗、bypass 直跑）。
- 重启保留每会话覆盖。
- typecheck/lint/test 全绿。