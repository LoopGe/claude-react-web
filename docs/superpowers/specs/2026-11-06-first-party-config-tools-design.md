# 2026-11-06 · 首方配置工具（skills / mcp / marketplace）

> **意图**：让模型在会话里直接完成配置，用户不必再去 Settings 面板手点。典型原话：
> - “帮我配一下 playwright 的 MCP”
> - “从这个 git 链接装插件”（Claude 插件市场，例如 `https://github.com/anthropics/skills`）
> - “给我建个处理 XX 的 skill”

## 一、现状（调研结论）

三套管理能力在服务端都完整存在，但**只挂在 REST 路由上，模型侧零入口**：

| 域 | 服务层 | 关键语义 |
|---|---|---|
| skills | `server/skills.ts`（user/project CRUD、validate、import）、`server/skills-remote.ts`（GitHub 目录搜索/预览/安装/更新） | 项目作用域根 = `<session.cwd>/.claude/skills`；写后需 `reloadSkillsForCwd` 才能让 live 会话看到 |
| MCP | `server/mcp-config.ts`（全局 `mcp-config.json`、命令白名单、OAuth、`validateMcpServer`/`maskSecrets`/`testMcpConnection`）、`server/session-manager-mcp.ts`（live `setMcpServers`/toggle/reconnect） | 全局配置与“会话是否使用它”是两层：`SessionMeta.mcpServerNames` 才是会话真值；新会话默认取全局启用集合 |
| marketplace | `server/mp-store.ts`、`server/mp-ops.ts`、`server/routes/mp-marketplace.ts` | `addMarketplaceByUrl` 克隆并解析 `.claude-plugin/marketplace.json`；enable 插件 = 安装（git-subdir 会惰性克隆外部仓库），并 `applyFlagSettings` 推到 live 会话 |

first-party registry 目前只注册了 `git-tools`；`appdebug` / `history-tools` 是 dev-only，但它们的“代码内注册 + 窄 host 接口 + `readOnlyToolNames` 标注”模式正是本方案要复用的。

已确认 `anthropics/skills` 是标准 mp 市场（`.claude-plugin/marketplace.json`，5 个 in-repo 插件，`source: "./"`），现有解析器无需改动。

## 二、目标 / 非目标

**目标**
- 注册三个生产首方工具 server：`skills-tools`、`mcp-tools`、`marketplace-tools`，默认启用，可在 Settings 的 first-party 区按 server 关闭。
- MCP：全局配置 CRUD，并在**同一次调用**里把 server 应用到调用它的当前会话（写全局 + 并进 `mcpServerNames` + 重注入）。
- Skills：user/project 作用域的独立管理（list/get/validate/create/update/delete）；project 作用域绑定调用会话 cwd；写后触发受影响会话 reload。
- Marketplace：Claude 插件市场 add/list/plugins/enable；enable 即安装并推到 live 会话。
- 读工具自动放行（`readOnlyToolNames`），写工具走现有权限审批流。

**非目标**
- App Plugins（Mods）市场（`/api/app-plugins/*`）。
- 会话内完成 MCP OAuth 浏览器授权（只返回提示，指向 Settings）。
- 用户配置化注册新的首方工具 server（仍然代码内注册）。
- 逐工具权限 UI。
- 在工具输出里回显 MCP secrets（读路径统一 `maskSecrets`）。

## 三、架构决策

### 3.1 三个 server，而不是一个大 server

理由：registry 的 enabled / readOnly / mutating 都是 **server 粒度**；三个域依赖的 store 不同；用户可能只想开其中一个。工具用短裸名，FQN 形如 `mcp__skills-tools__list`、`mcp__mcp-tools__add`。

### 3.2 把会话上下文注入 `buildTools`（框架改动）

**问题**：现在 `FirstPartyToolServer.buildTools(cwd)` 只拿得到 cwd。“把 MCP 应用进当前会话”需要 session id；用 cwd 推断会把同 cwd 的多个会话串在一起。

**方案**
- `server/sdk-tools/types.ts`：
  ```ts
  export interface FirstPartyToolBuildContext {
    /** 真实会话构建时存在；`listToolDefs()` 的元数据构建不存在。 */
    sessionId?: string
  }
  buildTools(cwd: string | null, ctx?: FirstPartyToolBuildContext): SdkMcpToolDefinition<any>[]
  ```
- `registry.injectAll(cwd, enabled, onError?, ctx?)` 透传。
- `SessionMcpManager.injectAll(servers, s)` 传 `{ sessionId: s.id }`（这里本来就有 `s`）。
- `registry.listToolDefs()` 仍调用 `buildTools(null)`，ctx 缺失；handler 永不执行。
- 需要 session 的 handler 在 `ctx?.sessionId` 缺失时抛出明确错误（元数据构建不会触发）。

**否决的替代**：让模型传 sessionId（它不知道）；用 cwd 推断（同 cwd 多会话会串）。

### 3.3 生产注册点

`createServerContext` 在 stores 与 `SessionManager` 就绪后调用：

```ts
registerConfigToolServers({
  registry: firstPartyRegistry,
  sm: sessionManager,
  mcpStore,
  mpStore,
})
```

- **幂等**：按 server 名跳过已注册项（与 `enableDevMode` 同款）。
- registry 是进程单例；测试要构造 fresh `FirstPartyToolRegistry` 直接注册，不走 bootstrap（避免复用上一个 context 的 host）。

### 3.4 复用与提取

- `validateMcpServer` / `maskSecrets` / `testMcpConnection` 已从 `mcp-config.ts` 导出，直接用。
- 新增 `server/mcp-ops.ts`：承载 create/update/remove/toggle 的 store 映射与校验。**P1 就把 `server/mcp-routes.ts` 的对应 handler 改到这套 helper 上**，响应体、状态码、secret masking 保持逐字节一致（现有路由测试是安全网）。不允许工具和路由各留一份 create/update 语义——那正是会漂移的地方。
- 新增 `SessionMcpManager.attachGlobalMcpServer(id, name)`（`setMcpServers` 增加 `{ stampNames?: boolean }` 选项）：
  - `s.mcpServerNames !== undefined`：沿用 UI 的 own-list 语义——把 name 并进列表并持久化。
  - `s.mcpServerNames === undefined`（继承全局态的会话）：**不得静默 pin**。运行时合并当前全局启用集 + name 后 `setMcpServers`，但传 `stampNames: false`，保持 `mcpServerNames` 为 undefined，让会话继续跟随后续全局变化。
  - 保留 `s.dynamicMcpServers` 里的非全局内联项，避免 replace 语义把它们丢掉。
  - 幂等：name 已在**运行时集合**（`Object.keys(s.dynamicMcpServers ?? {})`）里则不做任何写入。不能用全局启用集判断——全局新增的 server 在 spawn 后并不在 live 会话里。
  - 与 `POST /sessions/:id/mcp/servers` 的 merge + setMcpServers 序列同源；REST 侧后续可改为调用同一方法。
- 把 `applyToggleToLiveSessions` 从 `server/routes/mp-marketplace.ts` 提取到 `server/mp-ops.ts`；`toListItem` / `toPluginListItem` 的 DTO 映射一并提取。P1 同时把 `mp-marketplace.ts` 改为调用提取后的函数（保留现有行为，含“不 materialize”）。

## 四、工具面

所有 handler 通过 `ok / err / guard / json`（`server/sdk-tools/call-result.ts`）返回。

### 4.1 `skills-tools`（绑定调用会话 cwd）

| tool | 参数 | 读/写 | 行为 |
|---|---|---|---|
| `list` | `{ scope?: 'user'\|'project' }` | 读 | `listSkills(cwd)`；project 无 cwd 时只返回 user |
| `get` | `{ scope, name }` | 读 | `getSkill(scope, name, cwd)`（含 content） |
| `validate` | `{ content, name? }` | 读 | `validateSkillContent`，纯函数 |
| `create` | `{ scope, name, description?, content? }` | 写 | `createSkill` + reload |
| `update` | `{ scope, name, content }` | 写 | `updateSkill` + reload |
| `delete` | `{ scope, name }` | 写 | `deleteSkill` + reload；描述里写明不可逆 |

- project 作用域且会话无 cwd → 明确报错。
- reload 完全复用 REST 的语义：`sm.reloadSkillsForCwd(scope === 'project' ? cwd : undefined)`。
- `create/update/delete` 进 `mutatingToolNames`（project 作用域会改工作树，需要触发 git-snapshot）。

### 4.2 `mcp-tools`

| tool | 参数 | 读/写 | 行为 |
|---|---|---|---|
| `list` | `{}` | 读 | 全局配置列表，`maskSecrets` 后返回 |
| `get` | `{ name }` | 读 | 单个配置，`maskSecrets` |
| `add` | `{ name, type?, command?, args?, env?, url?, headers?, alwaysLoad?, enabled?, attachToSession? }` | 写 | 校验 + upsert 全局；默认 `attachToSession: true` → `attachGlobalMcpServer` |
| `update` | `{ name, ...partial }` | 写 | env/headers 合并语义（与 REST 一致）；校验后 upsert |
| `remove` | `{ name }` | 写 | 从全局配置移除 |
| `set_enabled` | `{ name, enabled }` | 写 | 全局 `enabled` 开关（影响后续 spawn） |
| `test` | `{ name }` | 写（会 spawn 进程） | `testMcpConnection`，返回连接结果与工具列表 |

- `add` 的返回体：`{ saved: true, added, removed, errors, sessionAttached: true }`，其中 `added/removed/errors` 直接来自 `setMcpServers`（§6.1 已证明可同步 await）。失败不回滚全局配置（写全局是用户意图），但必须把原因回给模型，避免“看起来配好了、本会话没生效”。
- `add` 幂等：server 已在全局配置且已 attach 到当前会话 → 返回 `{ saved: true, alreadyAttached: true }`，不重复 `setMcpServers`。
- `remove` / `set_enabled(false)`：改全局配置的同时把当前会话 detach（见 §6.3）；其他 live 会话保持现状。
- `test` 故意**不**进 `readOnlyToolNames`：它会启动 MCP server 进程。
- OAuth 需要浏览器跳转，工具不尝试完成；检测到远程 server 需要授权时返回指引，让用户去 Settings。

### 4.3 `marketplace-tools`

| tool | 参数 | 读/写 | 行为 |
|---|---|---|---|
| `list` | `{}` | 读 | 市场列表（不含完整 manifest） |
| `plugins` | `{ id }` | 读 | 某市场的插件 + enabled |
| `add` | `{ url, ref? }` | 写 | `addMarketplaceByUrl`；返回 id、插件、warnings |
| `check_updates` | `{}` | 读 | `git ls-remote` 对比 lastSha，逐市场隔离错误 |
| `set_plugin_enabled` | `{ id, plugin, enabled }` | 写 | 提取后的 `applyPluginToggle`：git-subdir 先克隆；持久化；推到 live 会话；disable 后 GC |

- `id` / `plugin` 复用 `assertSafeName` 规则。
- P2 再补 `refresh`、`remove`（remove 需要 `confirm: true`，对齐 REST）。

## 五、权限与安全

- **只读集合**：`skills-tools` 的 `list/get/validate`、`mcp-tools` 的 `list/get`、`marketplace-tools` 的 `list/plugins/check_updates`。
- 其余写工具不在集合里 → 走权限 broker 的正常审批；`dontAsk` 下写工具会被拦，符合现有语义。
- 网络入口全部复用既有校验：skills remote 用 `parseOwnerRepo`；marketplace 用 `assertHttpsUrl` + manifest 解析；MCP 命令走 `validateMcpServer` 白名单。
- **秘密**：读路径统一 `maskSecrets`。写路径的 `env` / `headers` 会出现在 tool_use 输入里（权限卡本来就会展示），不在工具结果里二次回显。
- 破坏性操作（`delete` skill、后续 `marketplace remove`）在 description 里写明不可逆，并依赖权限审批。

## 六、生效时机与副作用时序

### 6.1 写工具同步施加 live 副作用（已由 spike 证明）

原设计假设：handler 内 `await` control 请求可能 deadlock，且 `setMcpServers` 的 replace 语义会重建正在执行本次 tool call 的 server。**2026-11-06 的独立 spike 已把这两点证伪。**

Spike 形态（throwaway，`spike/handler-control.mjs` + `spike/echo-server.mjs`，不进入 P1）：直接开一个 SDK `query`，注入进程内 MCP server `spike-tools`；其 handler 内同步 `await q.setMcpServers(...)`（payload 同时包含 `spike-tools` 自身和一个进程型 stdio server `spike-echo`），并调用 `applyFlagSettings`。

实测结果：

- `setMcpServers` 在 tool handler 内正常 resolve：`{"added":["spike-echo"],"removed":[],"errors":{}}`，round-trip ~0.9s；
- `applyFlagSettings` 正常 resolve，~20ms；
- 返回后，模型在**同一用户轮的下一次 assistant 请求**里就能看到并调用新 server 的工具（`mcp__spike-echo__echo` → `ECHO:hello`）。
  有一次运行模型自行预判“工具不可见”而没有尝试；在 prompt 里强制“先尝试再判断”后连续成功，说明那是模型行为，不是 CLI 的 schema 没刷新。

SDK 源码也确认了“替换在途 server”的担心不成立：`Query.setMcpServers` 对**同名 SDK server 只做 settings diff，不重连、不替换实例**；只有新增/移除的名字才 connect/disconnect。

因此写工具的契约是：

1. handler 内直接 `await` live 施加，不做延迟队列；
2. `setMcpServers` 的 payload 必须包含**所有**首方 server（宿主 `injectAll` 已经保证），否则 replace 语义会把它们移除；
3. 返回真实结果 `{ added, removed, errors }`，模型可以在同一轮内立即使用新工具；
4. 不引入 `deferAfterResult` / `wait_ready`。

残余风险：

- 新 server 首次连接可能较慢（`npx` 下载等）；`setMcpServers` 会等连接完成或返回 `errors`，工具调用耗时随之增加，但不会挂死。
- `remove` / `set_enabled(false)` 只操作用户 MCP server；当前 handler 属于 `mcp-tools`，不会被自己断开，payload 仍包含首方 server。
- 如果未来出现“删除当前正在执行的 server”这一需求，再单独引入延迟/下次生效语义。

### 6.2 注入的会话上下文

当前会话必然 live（工具由它的子进程调用），所以 `add` 的 attach 步骤不需要“会话不可用”的降级分支；真正需要处理的是 `sessionId` 缺失（只可能来自 `listToolDefs()` 的元数据构建，而那里不会执行 handler）。

### 6.3 各域的作用域边界

- **MCP `add`**：全局配置 + 当前会话 attach。其他会话不受影响（沿用 own-list / 继承语义）。
- **MCP `remove` / `set_enabled(false)`**：全局配置先改；**当前会话同时 detach**（从 `mcpServerNames` 移除，继承态会话则用 `stampNames: false` 重新施加全局启用集）。其他 live 会话保持连接，直到下一次 spawn 自愈——这是现有全局配置的既定语义，不在本方案扩大。
- **Skills**：写后 reload 受影响会话（user 作用域全部，project 作用域同 cwd），与 REST 完全一致。
- **Marketplace**：enable 走 `applyToggleToLiveSessions`（**不 materialize**）。全局 `MpStore.enabledPlugins` 是持久化真值；live 会话的 SDK 子进程立即收到 flag，但 `SessionInfo.enabledPlugins`（per-session pin）不会因此变化——它只记录用户显式 pin 的会话级覆盖。验收断言要读全局 store + SDK 状态，不能读 `SessionInfo.enabledPlugins`。

## 七、错误处理

- 服务层的 `HttpError` message 原样返回给模型（例如命令不在白名单、skill 名非法、marketplace 解析失败）。
- `addMarketplaceByUrl` 失败的临时 clone 由既有实现清理。
- skills project 作用域无 cwd → 明确报错，不静默降级到 user。
- 不做投机性兜底；只处理已证明会发生的状态。

## 八、分期

**P1（本设计落地范围）**
- 框架：`buildTools` ctx 透传 + `attachGlobalMcpServer`（含 `stampNames`）+ `mcp-ops` / mp 辅助提取，并把对应 REST 路由改到提取后的 helper。
- 三个 server 的上述工具面（skills 本地 CRUD；MCP 全局 + attach/detach；marketplace add/enable）。
- bootstrap 注册 + 默认启用 + 权限分类 + 测试。

**P2（后续）**
- skills 远程目录：`search` / `preview_remote` / `install_remote` / `check_updates` / `update_remote`；`import_path` / `import_files`。
- marketplace `refresh` / `remove`。
- MCP 远程 OAuth 的引导体验（仍不在会话内完成授权）。

## 九、测试

- `registry`：ctx 透传；`listToolDefs()` 在无 ctx 下仍可构建；FQN 集合包含新 server 的读/写工具。
- `skills-tools`：临时 cwd 下 CRUD round-trip、project 无 cwd 报错、写后 reload 被调用（fake host 断言）。
- `mcp-tools`：add/update 的合并语义与 `validateMcpServer` 拒绝路径；`maskSecrets` 不回显 env/headers；attach 同步走 `attachGlobalMcpServer`，`setMcpServers` 的 `added/removed/errors` 原样返回。
- `marketplace-tools`：add 用 fake clone（或注入）返回插件；enable 调用提取后的 `applyPluginToggle`；git-subdir 先克隆后持久化。
- `attachGlobalMcpServer`：保留内联 server、幂等、own-list 会话持久化 names、继承态会话（`mcpServerNames === undefined`）保持 undefined（`stampNames: false`）。
- `remove` / `set_enabled(false)`：当前会话 detach，其他会话不受影响。
- 同步施加：fake host 断言 handler 内调用了 live 控制并 awaited，返回值携带 `added/removed/errors`；live 控制失败时持久化仍保留，错误回给模型。
- REST 回归：改到 `mcp-ops` / mp helper 后，现有 `mcp-routes.test.ts` / `mp-marketplace.test.ts` 的响应体与状态码保持不变。
- 全量 `npm run typecheck` / `npm run lint` / `npm run test`。

## 十、文件清单

新增：
- `server/sdk-tools/config-tools.ts`（注册入口 `registerConfigToolServers`）
- `server/sdk-tools/skills-tools.ts`
- `server/sdk-tools/mcp-tools.ts`
- `server/sdk-tools/marketplace-tools.ts`
- `server/mcp-ops.ts`
- 对应 `*.test.ts`

修改：
- `server/sdk-tools/types.ts`（ctx）
- `server/sdk-tools/registry.ts`（`injectAll` ctx 透传；已注册幂等由注册入口负责）
- `server/session-manager-mcp.ts`（传 ctx；新增 `attachGlobalMcpServer` + `stampNames`）
- `server/session-manager.ts`（公开代理方法）
- `server/bootstrap.ts`（生产注册）
- `server/routes/mp-marketplace.ts`（改用提取后的辅助）
- `server/mcp-routes.ts`（create/update/remove/toggle 改用 `mcp-ops`）

## 十一、验收

- 说“帮我配 playwright 的 MCP”：全局 `mcp-config.json` 出现该 server；当前会话的 `mcp-status` 能看到连接结果，且**同一用户轮内**模型就能调用它的工具（spike 已验证）。own-list 会话的 `mcpServerNames` 包含它；继承态会话保持 `undefined` 且运行时注入包含它。
- 说“从 https://github.com/anthropics/skills 装 document-skills”：市场被克隆，全局 `MpStore.enabledPlugins` 含 `<plugin>@<marketplace>`，live 会话的子进程收到该 flag（插件新增的 skill/command 从下一轮起可用）。`SessionInfo.enabledPlugins` 不作为断言对象（未 materialize）。
- 说“在项目里建个 XX skill”：`<cwd>/.claude/skills/xx/SKILL.md` 落盘，受影响会话 reload 成功。
- 三个首方 server 在 Settings 的 first-party 区可见、可单独关闭。
- typecheck / lint / test 全绿。

## 十二、决策记录

实施时在 `.agents/notes/implemented/architecture/` 写一条决策记录，内容包括：为什么是三个 server、为什么把 sessionId 放进 `buildTools` ctx、为什么 MCP `add` 采用“全局 + 当前会话”两段式而不是只写全局。