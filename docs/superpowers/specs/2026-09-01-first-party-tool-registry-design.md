# 2026-09-01 · 首方工具注册表(泛化 app-tools 为可管理工具体系)

> **承接**:`2026-09-01-app-tools-inprocess-mcp-design.md`(其首期 A 块「单例首方 git 工具」已在 `server/sdk-tools/app-tools.ts` 落地)。本 spec 是其**后续阶段**:把「一个硬编码的 git MCP server + 一个布尔开关」泛化为「一组可注册、可扩展、像普通 MCP server 一样可管理的首方(first-party)工具体系」,并修复两个只暴露在泛化路径里的接缝(权限注解消费、git-status 广播)。

## 一、背景与动机

现状(调研确认)的收敛点:

- 全部首方(self-built)逻辑集中在**两个单例点 + 一个布尔开关**:
  - `buildAppToolsServer(cwd)`(`app-tools.ts:175`)— 只造 git 一个 server;
  - `injectAppTools()`(`session-manager.ts:3776`)— 只在 `mcpServers` map 里塞 `apptools` 一个键;
  - `appToolsGit`(单布尔,贯穿 `config.ts` / `session-types.ts` / `persistence.ts` / `routes/reset.ts` / `shared/session-info.ts`)。
- 底层机制本身是正确姿势:SDK `createSdkMcpServer` 进程内注入、handler 绑 cwd、复用 `server/git.ts` safe helpers、走 session permission flow。

**要实现"像普通 MCP server 一样可看、可管、可持续注册首方工具",目前欠缺**:

1. **可见性 / 上报缺失**:`mcpServerNames` 硬排除 apptools(`session-manager.ts:3759`);客户端 `SettingsPanel.tsx:563` 硬编码 `.filter(s => s.name !== 'apptools')` 把它从 MCP 列表滤掉。不能 reconnect/toggle、无 server 级 status(online/error/pending)。
2. **开关非即时**:`setAppTools`(`session-manager.ts:3527`)是**纯 UI pref,不调 SDK**,运行中会话切换不生效(等下次 spawn / live setMcpServers)。
3. **不可扩展**:单例构建 + 单布尔,要加第二个首方工具体系必须复制粘贴整个模式。
4. **权限注解没人消费**(接缝一):只读工具打了 `{ readOnlyHint:true }`,但 `permission-broker.ts` 不读注解,把 `mcp__apptools__git_status` 当"未知工具"。后果:在 `dontAsk` 下**只读工具也被自动 deny**;`acceptEdits` 下读写工具都走 prompt。
5. **git-status 广播缺失**(接缝二,且与前 spec「数据流」节声明不符):`git-broadcast.ts` 的 `MUTATING_TOOL_NAMES = {Edit,Write,NotebookEdit,Bash,PowerShell}` 不含 `mcp__apptools__git_discard/commit/stage/…`。模型经 app-tools 写工具改工作树,**不会**触发 `git-status-changed`,已打开 GitPanel 不自动刷新(对照:用户侧 git 写路由都会直接广播)。

## 二、目标 / 非目标

**目标**
- 用**代码内注册的 registry**(重建 `buildAppToolsServer` + `injectAppTools`)取代单例,天然支撑任意多个首方工具 server。
- 首方 server 与普通 MCP server 一样**可看(report)、可开关(toggle,即时)、可重连(reconnect)、有状态(status)**——进入客户端管理面,不再被硬编码排除。
- 每次首方工具开关保留现有「全局默认 + 每会话覆盖」分层语义。
- 修复两个接缝:① permission broker 消费首方只读工具的 `readOnlyHint`;② git-status 广播覆盖首方写工具。
- 首方 server 与用户同名 MCP server 冲突时:**首方优先**(沿用现状)。

**非目标(留待后续/明确不做,对应上一份 spec 的范围守卫 + 本次决策)**
- 用户**在 UI/配置里动态定义新首方工具**(本次=代码内注册;`SdkMcpToolDefinition` 的序列化描述符、配置化注册为未来预留接口,不落地)。
- B(插件→代理工具桥)、C(BGFM 工具重绑定)、逐工具权限 UI。
- 改变普通用户 MCP server 的任何既有行为。

## 三、架构:First-Party Tool Registry

**新模块 `server/sdk-tools/registry.ts` + `server/sdk-tools/types.ts`。**

```ts
// server/sdk-tools/types.ts
export interface FirstPartyToolServer {
  name: string                    // MCP server 名(当前为 'apptools')
  description: string
  defaultEnabled: boolean         // 全局默认(供 config 初始化)
  requiresCwd: boolean            // apptools 为 true:无 cwd 不注入
  buildTools(cwd: string | null): SdkMcpToolDefinition[]
                                  // 统一 builder(createSdkMcpServer)在 registry 内,server 只提供工具定义
  readOnlyToolNames?: ReadonlySet<string>   // 裸工具名(不含 mcp__{server}__ 前缀)里只读者
  mutatingToolNames?: ReadonlySet<string>   // 裸工具名里会改动工作树/文件系统者
}
```
> **工具名定案(审核 C1)**:`readOnlyToolNames`/`mutatingToolNames` 一律存**裸工具名**;消费方(permission-broker / git-broadcast / session-pump)拿到的 SDK 侧名字是 FQN `mcp__{server}__{tool}`,由 registry 的 `readOnlyToolFqns()`/`mutatingToolFqns()` 统一加前缀后给出并集。任何一处都不要混用裸名与 FQN。
> **`namespace` 字段已删除(审核 C4)**:SDK 已用 `mcp__{server}__` 前缀天然隔离多首方 server 的工具名,无需额外命名空间字段。

```ts
// server/sdk-tools/registry.ts
export class FirstPartyToolRegistry {
  private servers = new Map<string, FirstPartyToolServer>()
  register(s: FirstPartyToolServer): void
  get(name: string): FirstPartyToolServer | undefined
  list(): ReadonlyArray<FirstPartyToolServer>
  /** 全部启用且满足前置条件的 server 并入 mcpServers map(泛化 injectAppTools)。
   *  enabled 是「按 server 名解析有效开关」的解析器(审核 C5):由 session-manager
   *  注入 session override ?? global config ?? server.defaultEnabled 的闭包。 */
  injectAll(cwd: string | null, enabled: (name: string) => boolean, onError?: (name: string, message: string) => void): Record<string, unknown> | undefined
  /** 全部只读/可变工具全限定名(FQN,含 mcp__{server}__ 前缀)的并集。 */
  readOnlyToolFqns(): ReadonlySet<string>
  mutatingToolFqns(): ReadonlySet<string>
}
```

**默认注册**(`server/sdk-tools/app-tools.ts` 重构为 `FirstPartyToolServer`,`server/sdk-tools/registry.ts` 顶部导出 `firstPartyRegistry` 单例并 `register(gitAppTools)`):
- 现有 `buildAppToolsTools` → 适配成 `buildTools`;声明(全为裸名)`readOnlyToolNames = {git_status, git_branches, git_stashes, git_log}`、`mutatingToolNames = {git_stage, git_unstage, git_discard, git_commit, git_stash_create, git_stash_pop, git_stash_drop, git_abort_merge, git_abort_rebase, git_branch_create, git_checkout}`。

## 四、配置模型(结构化,替代单布尔)

替代横穿四面的 `appToolsGit: boolean`:

```ts
// 全局:每个首方 server 一个开关
config.firstPartyTools?: Record<string, { enabled: boolean }>   // 默认 { apptools: { enabled: true } }
// 每会话覆盖:null = 继承全局
SessionMeta.firstPartyTools?: Record<string, boolean | null>
```

- **兼容迁移**:保留 `appToolsGit` 的读取,新结构 `firstPartyTools.apptools.enabled` 存在时优先;只写了旧布尔的老配置仍被识别(反向映射到 `firstPartyTools.apptools`)。`WRITABLE_CONFIG_KEYS`、`routes/reset.ts`、`shared/session-info.ts` 随之结构化。
- **有效值**(沿用现有 `??` 链):`session.firstPartyTools?.[name] ?? config.firstPartyTools?.[name]?.enabled ?? server.defaultEnabled`。
- 首方 server 的**实例不可序列化**(进程内 `McpServer`),仍**不**进 JSON `McpConfigStore`;序列化的只有开关/配置这个描述符层。

## 五、注入泛化

`injectAppTools` → `injectAll`(register 里),`session-manager.ts` 双注入点不变:

- spawn(`session-manager.ts:2310`)与 live `setMcpServers`(`:3747`)都改调 `registry.injectAll(cwd, enabled)`。
- 对每个**有效开关为真**且(`requiresCwd` 时)**有 cwd** 的首方 server,`buildServer(cwd)` 塞进 map;首方覆盖同名字段(`copy[name] = …`,首方优先)。
- 无 cwd 的 `requiresCwd` server 跳过;非 git 仓库的 cwd 照常注入(spec A 块既定行为)。

## 六、生效时机修复(toggle 即时)

现状是纯 pref → 改成**即时 + pref 双写**。

- **即时机制定案(审核 C3)**:**不**依赖 SDK `toggleMcpServer`(其对进程内 sdk-type 服务器行为不可靠,CLI 侧不认识注入的 server)。改用**重注入**:① 写 per-session override;② 若会话 live,调既有 `setMcpServers(id, s.dynamicMcpServers ?? {})` 重跑注入路径(`injectAll` 依新 pref 追加/省略 apptools)。`s.dynamicMcpServers` 运行时记录最近一次 `setMcpServers` 收到的用户集(spawn 时初始化为注入前的 mcpServers map)。
- `POST /sessions/:id/tools/:name/toggle { enabled }` → `setFirstPartyTool(id, name, enabled)`:写 override(`null` 清除=继承全局),live 时重注入;若重注入的 SDK 调用失败 → **回滚 pref 并抛错**(审核 C7,避免"UI 显示开但实际关")。
- 兼容保留旧 `POST /sessions/:id/app-tools`(改走泛化路由 `setFirstPartyTool(id,'apptools',…)`,行为升级为即时;`sessions-app-tools.test.ts` 与 SettingsPanel 文案同步更新——不再说「下次启动生效」,审核 C6)。
- 保留「`enabled:null` 清除 override 继承全局」语义。

## 七、可见性 / 状态 / UI(report)

**独立的首方状态源 `toolServerStatus`**(不依赖 SDK `mcpServerStatus` 对进程内 server 的可靠性):

- `SessionManager.toolServerStatus(id): { name, enabled, injected, requiresCwd, hasCwd, error? }[]`,从 registry 的启用状态 + 本次注入结果合成,`GET /sessions/:id/tools` 或并入 `SessionInfo`。
- `mcpServerNames` 维持用户配置集不变;首方 server 走独立状态,不进普通 MCP status 混排。

**UI**(`SettingsPanel.tsx`):
- **保留** `mcpSdkList` 对首方 server 的排除过滤(审核 C2:首方 server 不进用户 MCP 管理列表,避免重复卡片与无意义的 reconnect/toggle;过滤来源从硬编码 `'apptools'` 改为 `GET /sessions/:id/tools` 返回的首方名字集合)。
- MCP tab 内新增「First-party tools」区:每 server 一张卡片(`name`、`toolServerStatus` 的 enabled/injected/hasCwd/error 态、开关 toggle、reconnect 按钮(进程内重连语义 = 重注入))。
- 旧的单一「Let Claude use git tools」布尔开关升格为这张 first-party 卡片(仍显示「继承全局 ON/OFF」态)。

## 八、权限注解消费(接缝一)

`permission-broker.ts` 目前不读注解,把首方只读工具当未知工具。目标:首方只读工具在 `acceptEdits` / `dontAsk` 下按只读豁免。

- registry 提供只读工具 FQN 并集(`readOnlyToolFqns()`);broker 的只读判定并集合并入它(现状 `READONLY_TOOL_NAMES` + `SAFE_AUTO_TOOLS` 并之上;`dontAsk` 的 `isReadOnlyTool` 检查与 `auto` 模式的 SAFE 快路径都并入)。
- **待实现时确认的细节**:先验证 SDK `canUseTool(toolName, input, options)` 的 `options` 是否携带该工具的 `readOnlyHint` / annotations;若携带则直接从权限决策读注解,否则回退到 registry FQN 并集(两者二选一,不重复)。写工具保持现状(按 permissionMode 走 prompt / AI classifier / deny)。
- 首方读工具在 `dontAsk` 下应从「自动 deny」改为「自动 allow」。

## 九、git-status 广播(接缝二)

`git-broadcast.ts` 的 `MUTATING_TOOL_NAMES` 泛化:

- 检测用集:`MUTATING_TOOL_NAMES ∪ registry.mutatingToolFqns()`(即追加 `mcp__apptools__git_stage/unstage/discard/commit/stash_*/abort_*/branch_create/checkout`——FQN,与 pump 拿到的 `b.name` 一致)。
- `session-pump.ts` 的 `mutatingToolUseId` 判定逻辑该用并集;检测机制不变(assistant 消息收集 tool_use id → tool_result 落地时 `scheduleGitBroadcast`)。
- 效果:模型经首方写工具改工作树后,`git-status-changed` 广播触发,已打开 GitPanel 自动刷新——与此前 spec「数据流」节声明的预期一致(修复实现偏差)。

## 十、数据流

agent 调 `mcp__apptools__git_commit` → session permission flow 判定 → handler 调 `commitChanges(cwd,…)` → 文本结果回 agent → 写工具经数字九广播 → 用户面板刷新。

## 十一、错误处理

- registry 构建 server 失败 → 该首方 server 标记 error 态入 `toolServerStatus`,不清空其它首方 server / 用户 MCP。
- 即时 toggle 的 SDK 调用失败 → 返回 4xx/5xx,不回写 pref(不造成"UI 显示开但实际关")。
- 进程内 server 的 handler 异步、有界(默认 ~60s stream-close 上限),守护 A 块既有行为。

## 十二、兼容与迁移

- `appToolsGit` 旧布尔读写仍识别(旧配置不炸);写入侧升级为结构化。
- 旧 `POST /sessions/:id/app-tools` 保留并转发到泛化逻辑。
- 「首方优先」语义、spawn/live 双注入点、无 cwd 不注入——全部保留。

## 十三、测试

- **registry**:注册/dedup、`injectAll` 对 enable+cwd 前置条件的多 server 覆盖、首方优先同名覆盖、只读/可变工具名并集计算。
- **配置**:`firstPartyTools` 结构化 round-trip、`appToolsGit` 兼容读取、per-session override + null 继承、`WRITABLE_CONFIG_KEYS`/`reset`。
- **toggle**:`POST /tools/:name/toggle` 调 SDK `toggleMcpServer` 且持久化 override;`/app-tools` 兼容。
- **状态**:`toolServerStatus` 反映 enabled/injected/hasCwd/error。
- **权限接缝**:只读首方工具在 `acceptEdits`/`dontAsk` 下豁免(单测 broker)。
- **广播接缝**:`mcp__apptools__git_discard` 落地触发 `scheduleGitBroadcast`(单测 pump/git-broadcast)。
- 全量 typecheck(双 tsconfig)/lint/test 全绿。

## 十四、文件清单

- 新增:`server/sdk-tools/types.ts`、`server/sdk-tools/registry.ts`、各首方 server 新文件(如 `server/sdk-tools/builtin/` 下收纳现有 app-tools)
- 改:`server/sdk-tools/app-tools.ts`(适配 `FirstPartyToolServer` + 声明 readOnly/mutating 集合)、`server/session-manager.ts`(`injectAll` + `toolServerStatus` + 即时 toggle + 结构化 override)、`server/permission-broker.ts`、`server/git-broadcast.ts`、`server/session-pump.ts`、`server/config.ts`、`server/session-types.ts`、`server/persistence.ts`、`server/routes/reset.ts`、`server/routes/sessions.ts`、`shared/session-info.ts`
- 客户端:`src/components/SettingsPanel.tsx`(移除硬过滤 + first-party 卡片)、`src/types/config.ts`、相关 hook
- 测试:上述各单测

## 十五、验收

- 新会话 spawn 后,`apptools` 首方 git 工具仍可用(回归),且出现在 `toolServerStatus` / SettingsPanel first-party 区(可看)。
- 即时 toggle 对运行中会话立即生效(对比现状的"下次 spawn")。
- 新增第二个首方工具 server 只需在 registry `register` 一次(扩展性验证)。
- 只读首方工具在 `dontAsk` 下不再被自动 deny;写工具仍走权限 flow。
- 模型经 `mcp__apptools__git_discard` 等改文件后,已打开 GitPanel 自动刷新。
- 旧 `appToolsGit` 配置读得起、不炸;typecheck/lint/test 全绿。