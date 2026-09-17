# 2026-09-17 · dev 运行环境专属的 `appdebug` 首方调试工具

## 背景与目标

`apptools` 目前只给代理 git 能力。但本仓库的开发常态是「**用 claude-react-web 开发 claude-react-web**」：`npm run dev` 起服务，然后在一个会话里改代码 / 查 bug。此时代理最缺的恰恰是**宿主自身的运行时可观测性**——`CLAUDE.md` 明确要求「定位 bug 必须用日志实测证明根因，不能猜、不能加兜底代码」，而今天这条规则只能靠人肉中转：人开 Performance 面板看指标、人翻 `<stateDir>/logs/server-*.log`、人把日志粘进对话。代理看不见 server 进程内部，`server/routes/diagnostics.ts` 已有会话级 CLI 诊断（`stderrTail` / cli debug log）也从未暴露给代理。

本设计让**只有从源码跑的 dev 运行时**向代理注入一个首方 MCP 服务器 `appdebug`，把「读日志 / 读指标 / 读会话内部状态 / 改运行时配置」变成代理可自行调用的工具，把那条工作流从「人肉中转」变成 agent 闭环。非 dev 运行（`npx claude-react-web`、`npm run start` / `npm run preview` 跑的 `dist/cli.mjs`）**绝不注册**这些工具。

## 关键决策

1. **独立服务器 `appdebug`，不并入 `apptools`**。三条理由：`apptools` 是 `requiresCwd: true`，而调试对象是 server 进程、与 cwd 无关；独立服务器才能用现有 `firstPartyTools.<name>.enabled` 链条单独关掉；UI 的 MCP tab 由 `GET /api/first-party-tools` 泛化渲染，新服务器**零 UI 改动**即可出现并带启用开关，同时不动 git 服务器的工具集与 `registry.test.ts` 里「15 个工具 / 4 个只读」的断言。

2. **dev 判定：从源码跑就是 dev**。主判据 `isDevRuntime(argv1)` = `/\.tsx?$/.test(argv1)`；辅判据 `npm_lifecycle_event` 以 `dev` 或 `dev:` 开头。实测（win32 / node 24 / tsx，见「已验证事实」）：`npm run dev:server`（`tsx watch server/cli.ts --port 3456 --no-open`）下 tsx fork 出的子进程里 `argv[1]` 仍是 `...\server\cli.ts`、`npm_lifecycle_event` 仍是 `dev:server`，两个信号都存活；而 `node dist/cli.mjs` 下 `argv[1]` 是 `.mjs`、`npm run start` 给的 `npm_lifecycle_event` 是 `start`。**只认 `npm_lifecycle_event` 有值是不够的**（`npm run start` 也有值），所以主判据必须是入口扩展名。

3. **不读 `NODE_ENV`**：仓库里没有任何地方设置它（`server/config.ts` 甚至不读 `process.env`），等于没有信号，引入它只会制造一个假接口。

4. **日志环形缓冲的 capture 点在 `passes()` 之后——只收已经打印出来的行**。语义诚实（就是「服务器打印了什么」），且**零性能失真**：反过来在过滤前 capture，会让每条被压掉的 trace 都走 `formatArg` / `JSON.stringify`，插桩本身拖慢你正在排查的性能问题。代价是看不到「被 level 压掉的历史」，因此 `logs` 会先回报当前 level / scopes，代理的固定循环是 `set_log {level:'debug', scopes:['pump']}` → 让人复现 → `logs {since}` → 收回。

5. **读工具进 `readOnlyToolNames`，写工具走正常权限流**。broker 对 registry 声明的只读 FQN 自动放行（`permission-broker.ts` 三处：`FIRST_PARTY_READ_ONLY_TOOLS` 判定），所以「看日志 / 指标 / 会话状态」不弹权限卡、在 `dontAsk` 与 auto 模式下也算只读；而「改日志级别 / 开关 cliDebug / 往会话注入消息」有副作用，**先弹权限卡**，与 `git_stage` 等写工具同一姿态。

6. **依赖注入靠闭包，不改首方工具契约**。`createDebugAppTools(host: DebugHost): FirstPartyToolServer`，其 `buildTools()` 忽略 cwd、只闭包 `host`；`server/sdk-tools/types.ts` 与 `registry.ts` **一行不改**。host 是个窄接口（4 个方法），`SessionManager` 结构上满足它，测试传 fake。

7. **宿主机内省的实现放在 `SessionManager` 里，快照类型放 `session-types.ts`**。历史环、`pending` map、`withdrawnUuids`、`promptUuids`、`tasks` 都是私有内部态，只有 manager 能读；工具模块只负责 zod schema 与文本格式化，不碰内部态。这样两模块无环，fake host 也只需 4 个方法。

## 已验证事实（写此 spec 时实测，非推测）

| 事实 | 验证方式 |
|---|---|
| `npm run dev:server` 下 `argv[1]` = `...\server\cli.ts`、`npm_lifecycle_event` = `dev:server`，且 tsx watch fork 后仍成立（pid/ppid 不同） | 临时探针脚本经 `npm run` + `tsx watch` 实跑 |
| `node x.mjs` → `argv[1]` 为 `.mjs`；经 `npm run start` → `npm_lifecycle_event` = `start` | 同一探针 |
| SDK 子进程 env 是白名单（`buildProfileEnv` 只透传 PATH/HOME/… + `ANTHROPIC_*`） | 读 `server/providers/claude/claude-provider.ts` |
| 只读首方工具在 broker 自动放行（normal / dontAsk / auto 三处） | 读 `server/permission-broker.ts` |
| `metrics` 单例 = `{ observe, count, gauge, snapshot, reset }`，`snapshot()` → `MetricsSnapshot{uptimeSec, gauges, counters, histograms}`（直方图含 p50/p95/p99/max） | 读 `server/metrics.ts` / `shared/metrics.ts` |
| `SessionInfo` 只有 `running` / `terminated`，**没有** `phase` 字段 | 读 `shared/session-info.ts` |
| 公开可用：`list()`、`get(id)`（live-or-meta，未知 id 抛 404）、`getHistory(id)`、`contextUsage(id)`（内部 `requireLive`，**非 live 会抛**）、`toolServerStatus(id)`、`getDiagnostics(id)`、`setCliDebug(id, body)`、`send(id, text)` | 读 `server/session-manager.ts` |
| `require(id)` 是 **private 且 live-only**（只看 `this.sessions`，对 store 里的会话抛 404）—— 所以调试深挖必须走公开的 `get(id)` | 读 `server/session-manager.ts:5161` |
| `send(id, text)` 是**同步**方法（`SentUserMessage`，不返回 Promise），内部 `requireSendable` 同步抛错 | 读 `server/session-manager.ts:2483` |
| `promptUuids` 的未配对条目在 **dispatch 时**就写入（`recordPromptUuid`），不等 SDK 回显 | 读 `server/session-manager.ts:2572` |
| 排队未消费输入的判据 = `receivedAt != null && consumedAt == null` | `server/history-utils.ts` 的 `deriveDeliveryStatus` 注释与实现 |
| `TaskRecordUi` = `{ taskId, toolUseId?, description, subagentType?, taskType?, workflowName?, status, isBackgrounded?, progressSummary?, lastToolName?, startedAt?, endedAt?, updatedAt }` | 读 `shared/tasks.ts` |
| `config.firstPartyTools` 是开放的 `Record<string, { enabled }>` 映射，加 `appdebug` 这个 key 无需改 `server/config.ts` | 读 `server/config.ts` |

## 工具集

服务器名 `appdebug`，FQN `mcp__appdebug__{name}`。`requiresCwd: false`，`defaultEnabled: true`（但仅在 dev 注册）。

只读（进 `readOnlyToolNames` → broker 自动放行）：

| 工具 | 入参 | 返回 |
|---|---|---|
| `logs` | `level?`, `scope?`, `since?`(epoch ms), `grep?`, `limit?`(默认 200，范围 1..1000) | `{ level, scopes, fileLogging: { enabled, path? }, ringEnabled, ringLines, dropped, lines: [{ ts, level, scope, msg }] }`，其中 `ringLines` = 环形缓冲当前**未过滤**总行数，`lines` = 过滤+截断后返回的页，`dropped` = 累计被容量淘汰的行数 |
| `metrics` | `series?`（子串过滤，匹配 histogram / counter / gauge 名） | `MetricsSnapshot` 原样（`uptimeSec` / `gauges` / `counters` / `histograms`） |
| `sessions` | 无 | `{ sessions: DebugSessionSummary[], process: { pid, uptimeSec, rssMb, nodeVersion } }` |
| `session` | `id`, `history?`（尾部条数，默认 30，范围 0..200） | `DebugSessionDetail` |

`logs` 的过滤语义（四个条件全部为「与」，**先过滤、后按 `limit` 取最新的 N 条**）：

- `level`：**严重程度不低于**该级别（复用 `log.ts` 的 `LEVELS` 序），即 `level:'warn'` 保留 `error` 与 `warn`。省略 = 不过滤。
- `scope`：**精确匹配** logger 的 scope（如 `pump`、`ws`），不支持通配；模糊匹配交给 `grep`。省略 = 不过滤。
- `since`：保留 `ts >= since` 的行。省略 = 不过滤。
- `grep`：对 `msg` 做**大小写不敏感**的子串匹配。省略 = 不过滤。

`DebugSessionSummary`：
`id, title, phase('live'|'dormant'|'terminated'), terminatedReason?, cwd?, model?, permissionMode?, running, terminated, subscribers, messageCount, pendingTurns, pendingPermissions, queuedInputs, gitStartSha?, firstPartyErrors?`

- `phase` **是派生量，不是字段**：`terminated === true` → `'terminated'`；否则 `running === true` → `'live'`；否则 `'dormant'`。
- `queuedInputs` **是派生量**：扫 `s.history`（主环，不是 `getHistory` 的合并排序结果——排队输入一定是顶层 user 消息）中 `receivedAt != null && consumedAt == null` 的条目数。这是客户端渲染「排队中」的同一判据。
- `messageCount` 直接取 `SessionInfo`，**不再另出 `historyLength`**（`SessionInfo.messageCount` 就是 `history.length + subagentHistory.length`，重复暴露等于制造两个真值源）。
- `pendingPermissions` = `s.pending.size`；`pendingTurns` = `s.pendingTurns`（二者都不在 `SessionInfo` 里，是本次新增的可见性）。

`DebugSessionDetail` = 上述字段 + 深挖项：

- `historyTail`: 尾部 N 条，每条仅 `{ type, subtype?, uuid?, parentToolUseId?, receivedAt?, consumedAt? }`——**只出摘要，绝不整包序列化 SDK 消息**（历史环上限 500 且含大 payload）。
- `withdrawnUuids`: `string[]`
- `promptUuids`: `{ u, v }[]`（app 级 uuid ↔ SDK 磁盘 uuid 配对，即 `rewind-files` 的映射表）
- `tasks`: `{ taskId, taskType?, status, isBackgrounded?, progressSummary?, lastToolName?, startedAt?, endedAt? }[]`
- `contextUsage`: `contextUsage(id)` 的结果，**非 live 会话为 `null`**（见错误处理）
- `cli` / `toolServers`: 同 `contextUsage`——**live-only，非 live 会话为 `null`**

写（走正常权限流，先弹卡）：

| 工具 | 入参 | 行为 |
|---|---|---|
| `set_log` | `level?`, `scopes?` | `setLogConfig({ level, scopes })`，回显新快照 |
| `set_cli_debug` | `sessionId`, `cliDebug: boolean \| null` | `sm.setCliDebug`，`null` 清除 per-session 覆盖 |
| `send_message` | `sessionId`, `text` | `sm.send(sessionId, text)`，往任意会话注入一条消息（与 `POST /sessions/:id/messages` 同一条路径） |

`set_log` 的 `scopes` 语义必须与 `setLogConfig` 完全一致，并在工具描述里写明：**省略该键 = 不改**；传 `[]` = 清空过滤（等价 `null`）；传 `['pump','ws']` = 只放行这些 scope。zod 用 `scopes: z.array(z.string()).optional()`。

## 架构 / 组件

### 新模块 `server/dev-mode.ts`

- `isDevRuntime(argv1 = process.argv[1], env = process.env): boolean` —— 纯函数，两个入参可注入以便测真值表。
- `enableDevMode(deps: { registry: FirstPartyToolRegistry; sm: DebugHost; ringCapacity?: number }): void` —— 做两件事：`enableLogRing(deps.ringCapacity ?? 1000)`；若 `registry.get(DEBUG_TOOLS_SERVER_NAME) === undefined` 则 `registry.register(createDebugAppTools(deps.sm))`（幂等，重复调用不抛）。registry 作依赖注入 → 测试传 `new FirstPartyToolRegistry()`，无需给生产代码加 `unregister`。

### `server/log.ts` 增环形 sink（对称于既有 `enableFileLogging`）

- `enableLogRing(capacity = 1000): void` / `disableLogRing(): void` / `isLogRingEnabled(): boolean`
- `readLogRing(opts?: { level?; scope?; since?; grep?; limit? }): { lines: LogRingLine[]; total: number; dropped: number }`（`total` = 环形当前行数，`dropped` = 累计淘汰数；`lines` 是过滤+截断后的页，语义与上面「`logs` 的过滤语义」逐条对应）
- `LogRingLine = { ts: number; level: LogLevel; scope: string; msg: string }`
- `emit()` 里在既有 `writeToFile(tag, args)` 旁加一次 `writeToRing(scope, level, args)`——**同一位置，同样在 `passes()` 之后**。`msg` = `args.map(formatArg).join(' ')`，每行**截断 4096 字符**（超出追加 `…`）。容量满时从头部淘汰，`dropped` 记累计淘汰条数（`disableLogRing()` 时归零）。
- `disableLogRing()` 释放缓冲，之后不再收集。

### 新模块 `server/sdk-tools/app-debug.ts`

- `export const DEBUG_TOOLS_SERVER_NAME = 'appdebug'`
- `export const DEBUG_READ_ONLY_TOOLS: ReadonlySet<string>` = `{ logs, metrics, sessions, session }`
- `export interface DebugHost {`
  `  debugSessions(): DebugSessionSummary[];`
  `  debugSession(id: string): DebugSessionDetail;`
  `  setCliDebug(id: string, body: { cliDebug?: boolean | null }): Promise<unknown>;`
  `  send(id: string, text: string): Promise<void>;`
  `}`
  ——`metrics` / `logs` / `set_log` 三个工具直接用 `metrics` 与 `log.ts` 的模块级单例，不经过 host。
- `export function buildDebugTools(host: DebugHost): SdkMcpToolDefinition<any>[]`
- `export function createDebugAppTools(host: DebugHost): FirstPartyToolServer` → `{ name: DEBUG_TOOLS_SERVER_NAME, description, defaultEnabled: true, requiresCwd: false, buildTools: () => buildDebugTools(host), readOnlyToolNames: DEBUG_READ_ONLY_TOOLS }`
- 复用 `app-tools.ts` 的 `ok(text)` / `err(message)` / `guard(fn)` 三件套：异常一律变成 `isError: true` 的文本结果，**绝不 reject MCP call**（reject 会挂住 turn）。

### `server/session-manager.ts` 增两个只读内省方法

- `debugSessions(): DebugSessionSummary[]` —— 复用 `this.list()` 拿公开字段，叠加 `s.pending.size` / `s.pendingTurns` / 扫 `s.history` 得出的 `queuedInputs` / `s.firstPartyErrors`。每个会话只做一次线性扫描，不排序。
- `debugSession(id: string): DebugSessionDetail` —— 用公开的 **`this.get(id)`**（live-or-meta，未知 id 抛 404）解析，**不是** `this.require(id)`（后者只解析 live，会对 store 里的会话误报 404）；live-only 的三个段落（`cli` / `toolServers` / `contextUsage`）在非 live 时为 `null`，其余内存态退化为空集合。
- `setCliDebug` / `send` **已存在**，直接用，不新增。
- 快照类型 `DebugSessionSummary` / `DebugSessionDetail` 定义在 `server/session-types.ts`。

### `server/cli/args.ts`

`CliArgs` 加 `dev?: boolean`（默认 `undefined` = 自动判定），解析 `--dev` / `--no-dev`，并加进 `HELP` 文本。

### `server/cli.ts`

`runServer()` 里 `new SessionManager(...)` 之后：

```ts
if (args.dev ?? isDevRuntime()) {
  enableDevMode({ registry: firstPartyRegistry, sm: sessionManager })
  log.info('dev mode: appdebug tools registered')
}
```

注册发生在任何 spawn 之前。**已在运行的会话**用现有 per-session 首方开关即可立刻生效（`setFirstPartyTool` 会重跑注入路径，无需重启）；dormant 会话留到下次 spawn。

## 配置 / 开关链

沿用既有三级解析（`session-manager-mcp.ts` 的 `firstPartyEnabled`），**不新增配置字段**：

```
session.firstPartyTools.appdebug  ??  config.firstPartyTools.appdebug.enabled  ??  server defaultEnabled(true)
```

因为服务器**只在 dev 注册**，非 dev 下 `firstPartyEnabled` 永远拿不到它（`injectAll` 只遍历已注册的服务器）——**「非 dev 绝不暴露」由注册环节保证，不依赖配置**。这是本设计最重要的安全性质：没有一行配置能让正式包暴露这些工具。

同时 `GET /api/first-party-tools`、`GET /api/sessions/:id/tools`、SettingsPanel 的 MCP tab 会自动列出 `appdebug` 及其 7 个工具，用户可全局或按会话关掉。

## 数据流

代理调 `mcp__appdebug__logs { scope:'pump', since }` → broker 判定只读 → 自动放行 → handler 读 `log.ts` 环形缓冲 → 按 level/scope/since/grep/limit 过滤 → JSON 文本回代理。

代理调 `mcp__appdebug__set_cli_debug` → broker 走正常权限流（弹卡）→ 用户允许 → `sm.setCliDebug` → 文本结果回代理。

`session` 深挖先 `getHistory(id)`，再**只投影 uuid / 时间戳 / 类型**，SDK 消息体不进结果。

## 错误处理

- 所有 handler 包 `guard()`：`HttpError`（未知 sessionId 等）与任意异常都变成 `isError: true` 文本，绝不 reject。
- `logs` 在环形未启用时返回空 `lines` + `ringEnabled: false` + `ringLines: 0`，并在文本里说明「环形缓冲未启用」，而**不是报错**。
- `session` 对 dormant / terminated 会话：**从 store 解析**（走公开的 `get(id)` live-or-meta 解析器，而不是 live-only 的 `require(id)`，后者会对 store 里的会话报 404）；`historyTail` / `withdrawnUuids` / `promptUuids` / `tasks` 这些内存态退化为空数组；`cli` / `toolServers` / `contextUsage` 三个 **live-only 段落为 `null`**（它们都需要活着的 Query 或活的 Session，且不值得为它们去放宽既有 endpoint 的行为）。
- 输出全部有界：`history` ≤ 200、`logs.limit` ≤ 1000、每行 4KB、环形 1000 行。
- `enableDevMode` 幂等；重复注册不抛。

## 依赖 / 影响

- **新增**：`server/dev-mode.ts`、`server/sdk-tools/app-debug.ts`、`server/dev-mode.test.ts`、`server/sdk-tools/app-debug.test.ts`。
- **改动**：`server/log.ts`（+环形 sink）、`server/session-manager.ts`（+2 个只读方法）、`server/session-types.ts`（+2 个快照类型）、`server/cli/args.ts`（+2 个 flag）、`server/cli.ts`（+3 行接线）、`server/log.test.ts`（+用例）。
- **不动**：`server/sdk-tools/types.ts`、`server/sdk-tools/registry.ts`、`server/permission-broker.ts`、全部客户端代码（UI 泛化渲染，自动出现）。
- 无新依赖。

## 非目标（YAGNI）

- 不做日志 follow / stream —— MCP 是请求-响应，代理用 `since` 轮询即可。
- 不做重启 / 杀进程 / 触发 GC / 改 permissionMode —— `tsx watch` 自己会重启；这类工具交到代理手里风险远大于收益。
- 不做浏览器端状态 —— 那是另一套 surface（客户端已有 `error-capture` 与 Performance 面板）。
- 不做 `broadcast_git` —— 写路径本来就会推 `git-snapshot`。
- 不做「过滤前 capture」的环形 —— 见关键决策 4。
- 不改 `FirstPartyToolServer` 契约、不给 registry 加 `unregister`。

## 测试

**`server/dev-mode.test.ts`**

- `isDevRuntime` 真值表：`argv1` ∈ { `C:\...\server\cli.ts`, `.../x.tsx`, `C:\...\dist\cli.mjs`, `undefined` } × `npm_lifecycle_event` ∈ { `dev:server`, `dev`, `start`, `preview`, `undefined` }。含两条关键反例：`.mjs` + `start` → `false`；`.ts` + `start` → `true`（从源码跑就是 dev）。
- `enableDevMode` 往注入的 registry 注册名为 `appdebug` 的服务器，其 `readOnlyToolNames` 恰为那 4 个；重复调用不抛且只注册一次；`isLogRingEnabled()` 为 true（测试后 `disableLogRing()` 清理）。
- 非 dev 时 registry 保持为空（no-op）。

**`server/sdk-tools/app-debug.test.ts`**（照 `app-tools.test.ts` 的 `vi.hoisted` + `vi.mock` 写法，handlers 直调）

- 工具集：7 个名字正确；4 个只读带 `annotations.readOnlyHint`；`createDebugAppTools(host).requiresCwd === false`、`defaultEnabled === true`。
- 每个 handler 用 fake `DebugHost` 直调：happy path 返回 `content[0].text`；host 抛错 → `isError: true` 且不 reject。
- `set_log`：省略 `scopes` 不改动、传 `[]` 清空（用 `getLogConfig()` 断言）。
- `logs`：level / scope / since / grep / limit 过滤各一条用例；未启用环形时返回空结果且不报错。
- `session`：dormant 会话（`contextUsage` 抛 `requireLive`）时该字段为 `null` 而非报错。

**`server/log.test.ts` 增补**

- 容量淘汰 + `dropped` 累计；按 level / scope / since / grep 读；4KB 截断；`disableLogRing` 后不再收集。
- **仅 capture `passes()` 之后的行**：把 level 设为 `warn` 时 `log.info(...)` 不进环形（这是关键决策 4 的回归护栏）。

**全量**：`npm run typecheck`（双 tsconfig）、`npm run lint`、`npm run test`、`npm run build`（确认新增模块在 esbuild 下打包通过、无 node-only 意外）。

## 验收

- `npm run dev:server` 起服务 → 新会话里代理可见 `mcp__appdebug__{logs,metrics,sessions,session,set_log,set_cli_debug,send_message}`；只读 4 个不弹权限卡，写 3 个弹卡。
- `node dist/cli.mjs` / `npm run start` → 这 7 个工具**完全不存在**，`GET /api/first-party-tools` 不含 `appdebug`。
- `npm run dev:server -- --no-dev` → 同样不存在；`npm run start -- --dev` → 存在。
- SettingsPanel 的 MCP tab 出现 `appdebug` 一栏（7 个工具 + 启用开关），**无任何 UI 代码改动**。
- 闭环可用：`set_log {level:'debug', scopes:['pump']}` → 复现 → `logs {scope:'pump', since}` 拿到实测值。
- typecheck / lint / test / build 全绿。