# 宿主模型配置 vs `~/.claude/settings.json` 的 env 优先级

> 2026-11-04。回答：claude-react-web 如何让「每会话模型配置」稳定压过用户全局
> `~/.claude/settings.json` 的 `env` 块。评估两个候选机制（`CLAUDE_CODE_ENVIRONMENT_KIND=byoc`、
> SDK `settingSources`）并给出更窄的替代方案。
>
> 来源分级：**CLI 实现**（`claude-agent-sdk-win32-x64/claude.exe` 反编译 grep）> **SDK 源码/类型契约**
> （`sdk.mjs` / `sdk.d.ts`）> **本 app 实现**（`server/`）。每条结论标注 CONFIRMED（代码或运行日志直接证明）
> 或 HYPOTHESIS（推理/需运行时验证）。
> 所有二进制片段为压缩后原文，标识符保持原样。

---

## 0. 结论先行

| 机制 | 一句话结论 | 置信度 |
|---|---|---|
| **A. `CLAUDE_CODE_ENVIRONMENT_KIND=byoc`** | 确实生效，且是**唯一被完整追踪到端到端**的机制：它让 `hostOrchestrated=true`，从而把「启动进程 env 里已有的 key」视为宿主权威，设置文件里同名 env 被**静默丢弃**（包括 policy 层）。但 byoc 同时翻转十余个 byoc-only 行为分支（见 §3.2），语义上是「自建远程 runner」，副作用面明显大于需求。 | 机制 CONFIRMED；副作用清单 CONFIRMED（逐条代码）；风险评级 HYPOTHESIS |
| **B. `settingSources: ['project','local']`** | 确实能屏蔽 user settings 的 env（policy 仍加载），但代价是**整层用户设置被禁用**：`~/.claude/CLAUDE.md`、用户 plugins/hooks/statusLine/`modelSettings`、`effortLevel`、`permissions.defaultMode` 等全部静默消失。属于"大锤"，不推荐。 | CONFIRMED |
| **C1. `Options.settings = { env: {...} }`（flagSettings 层）** | **最窄的候选**：设置源优先级 `userSettings < projectSettings < localSettings < flagSettings < policySettings`，flag 层 env 在 user 层之后写入，能压过用户 env，且保留用户其它设置。已确认 SDK 在 **spawn 时以 `--settings <inline-json>` 命令行参数**下发（§5.1），flag 层在 argv 解析时即就位。**已实现并运行验证（§6.2）**：auto 分类器与子代理全部使用本会话 tier 模型，`mimo` 零出现。 | 全部 CONFIRMED（§6.2 运行探针） |
| **C2. `Options.managedSettings`** | **不可用**：sdk.d.ts 明言 `env` 属非限制性 key，会被静默丢弃。 | CONFIRMED（文档） |
| **C3. 魔改 env var（`*_ENV_WINS` 之类）** | **不存在**：对候选名字做了穷举搜索，无命中。 | CONFIRMED（不存在） |
| **D. 只检测 + 提示** | 可行且零侵入：CLI 已经就冲突模型在 stderr 打出 `[claude-code:unrecognized_model]`，本 app 的 process-monitor 已把它写进 `cli-stderr-*.jsonl` 与 server 日志。 | CONFIRMED |

**建议**：先按 §5.1 已确认的下发通道做一次 5 分钟的运行验证（确认 `Options.settings.env` 在启动期生效）；若成立就用它（最窄、不丢用户设置）。若时序不成立，退而用 **byoc**（它是唯一保证生效的机制），但必须接受 §3.2 的行为面变化。`settingSources` 只在「本产品明确决定不继承用户 CLI 配置」时才考虑。

---

## 1. 证据基线（现有现象）

用户 `~/.claude/settings.json`（只读检查，未修改）的实际内容：

```json
"env": {
  "ANTHROPIC_BASE_URL": "http://model.mify.ai.srv/anthropic",
  "ANTHROPIC_API_KEY": "sk-...",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "zhipuai/glm-5.2",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "xiaomi/mimo-v2.5-pro",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "xiaomi/mimo-v2-omni",
  "GERRIT_USERNAME": "...", "GERRIT_PASSWORD": "..."
},
"permissions": { "defaultMode": "auto" },
"model": "opus[1m]",
"effortLevel": "high",
"modelSettings": { "moonshot/kimi-k3.1-pro": { "autoCompactWindow": 840000 }, ... },
"enabledPlugins": {},
"skipAutoPermissionPrompt": true
```

App 侧注入（`server/providers/claude/claude-provider.ts`）：

- L885-888（model group）：`ANTHROPIC_DEFAULT_OPUS_MODEL / _SONNET_ / _HAIKU_ / ANTHROPIC_SMALL_FAST_MODEL`
  写进 `opts.env`（注释明确写着 "stay in the per-session opts.env"）。
- L909-912（非 group）：四个变量全部收敛为 `effectiveModel`。
- L180-235 `buildProfileEnv()`：`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`，并把 server 进程里所有
  `ANTHROPIC_*`（除 `ANTHROPIC_API_KEY`）拷进子进程 env，再设 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`、
  `DISABLE_AUTOUPDATER` 等。

探针 session `02e27050-4697-47ff-b2ad-beb1a4652e0f` 的运行证据（两个不同 query_source 走了不同模型）：

```
server-2026-11-04.log:
  [process-monitor] stderr[02e27050-...]: [claude-code:unrecognized_model]
      {"model":"moonshot/kimi-k3.1-pro","query_source":"sdk"}
cli-stderr-02e27050-....jsonl:
  {"ts":...,"line":"[claude-code:unrecognized_model]
      {\"model\":\"xiaomi/mimo-v2.5-pro\",\"query_source\":\"agent:builtin:general-purpose\"}"}
```

即：主查询用 `--model`（Options.model，不经 env）→ kimi；**子代理/分类器走 tier 别名 → env → 被用户
settings 覆盖成 mimo**。CLI 里 tier 别名确实是直接读 `process.env` 的（CONFIRMED）：

```js
function yg(){let e=i.ANTHROPIC_DEFAULT_SONNET_MODEL;
  if(e!==void 0)return oP(c2(e)); return wi("sonnet")??pu()}
```

自动模式分类器同样读取该变量，并在不适合时打印：

```
Auto mode classifier: ANTHROPIC_DEFAULT_SONNET_MODEL=<v> cannot serve as the classifier; using the Sonnet 5 default instead
```

---

## 2. 为什么今天的宿主 env 会被覆盖

SDK 子进程 env 是**替换**而非合并（`sdk.mjs`，CONFIRMED）：

```js
let Kv=...,pt=L?{...L}:{...process.env};        // L = options.env
if(!pt.CLAUDE_CODE_ENTRYPOINT)pt.CLAUDE_CODE_ENTRYPOINT="sdk-ts";
```

CLI 启动后，settings 管理器在 `Object.assign(process.env, settingsEnv)` 之前先计算
`hostSpawnEnvKeys`；当它不做「宿主编排」判定时该值为 `null`，过滤函数直接放行全部 settings env，
于是 settings 后写覆盖宿主值（CONFIRMED，原文见 §3.1）。SDK spawn 的 entrypoint 是 `sdk-ts`，
`hostOrchestrated` 为 false，所以今天 settings 赢。

---

## 3. 机制 A：`CLAUDE_CODE_ENVIRONMENT_KIND=byoc`

### 3.1 端到端证据（CONFIRMED）

**(1) 判定 `hostOrchestrated`** —— 全二进制只有这一处读取它（grep `hostOrchestrated` 仅命中此定义与
`hostSpawnEnvKeys` 使用点）：

```js
function v(){let e=Ne(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST),n=zc(),
  s=process.env.CLAUDE_CODE_ENVIRONMENT_KIND;
  return{coworkCloud:xu(),managedByHost:e||!!process.env.CLAUDE_CODE_HOST_AUTH_ENV_VAR,
    managedByHostFlag:e,desktopHost:n,hostOrchestrated:n||s==="byoc",storedLoginPinned:GO()}}
```

**(2) 采集宿主 env key 集合**：

```js
applySafeConfigEnvironmentVariables(){
  this.getPreSettingsEnvSnapshot(), this.providerStripContext=v();
  let e=un("userSettings");
  if(this.hostSpawnEnvKeys===void 0){
    if(this.hostSpawnEnvKeys=this.providerStripContext.hostOrchestrated
        ? new Set(Object.keys(process.env).map((r)=>r.toUpperCase())) : null, v9r())
      this.hostSpawnEnvKeys?.delete("FORCE_COLOR")
  }
  ...
```

注意：集合来自 `process.env` 的**现状**，而 SDK 子进程 env 就是 app 的 `Options.env`
（§2），所以四个 tier 变量必然在集合内。

**(3) 过滤 settings env**（`strippedSettingsEnv` 链的最外层是 `oe(...)`）：

```js
keptSettingsEnv(e,n,s,r){return this.withholdsEnvFrom(n,s)?{}:this.strippedSettingsEnv(e,n,s,r)}

strippedSettingsEnv(e,n,s,r){
  let a=oe(re(H(te(ie(y(ze(this.asFromAFolderNobodyTrusted(e,n,r!==void 0),n),
    n,r&&this.invalidEnvKeyWarned),n,r&&this.projectScopeDropWarned,
    ()=>this.envAboveProjectSettings(),r?.onGitKeyDropped))),n,s,r&&this.hostManagedDropWarned),
    n,this.hostSpawnEnvKeys,r&&this.hostSpawnEnvDropWarned);
  ...
```

```js
function oe(e,n,s,r){
  if(!e||!s)return e||{};
  let a={},_=[];
  for(let[E,C]of Object.entries(e)){
    if(!s.has(E.toUpperCase())||xe(E,C,n)){a[E]=C;continue}   // s 里没有该 key → 放行
    if(r&&process.env[E]!==C)_.push(E)
  }
  if(r&&_.length>0)We(_,n,r);
  return a }
```

结论：
- `s = hostSpawnEnvKeys`；命中集合的 key 被**丢弃**。`xe()` 的豁免只对 `source==="policySettings"`
  且属于 TLS/代理 key 集合（`Ke`）生效，模型变量永不豁免 → **连 managed/policy 层的同名 env 也会被丢弃**。
- `We()` 的告警文案（"Ignoring … from userSettings: the environment this session was launched with
  already sets it …"）只在 `r`（warn 集合）被传入时触发；正常启动路径 `filterSettingsEnv(...)` 不传
  第 4 参 → **byoc 下的丢弃是静默的**。
- 两条启动路径都过同一过滤器：`applySafeConfigEnvironmentVariables()`（信任对话框未接受时的安全子集）
  与 `applyConfigEnvironmentVariables()`（完整路径）内部都调用 `filterSettingsEnv` → `keptSettingsEnv`
  → `strippedSettingsEnv` → `oe`。

**(4) 语义边界**：只丢「宿主 env 里已经存在的 key」。用户 settings 里不冲突的 env（例如上面
`GERRIT_USERNAME`）仍然生效。验证方式：把用户 settings 的 4 个 tier 变量设成 X，宿主设成 Y，
CLI 实际请求 Y（可通过 `unrecognized_model` 或网关日志观察）。

### 3.2 `CLAUDE_CODE_ENVIRONMENT_KIND` 的**全部**使用点与 byoc 副作用

共 54 处字符串出现（36 行）。除「环境变量名表 / 定义导出」外，逐条如下。**风险评级是对本 app
（本机、无 `CLAUDE_CODE_REMOTE`、SDK 入口、已 `DISABLE_AUTOUPDATER=1`）的影响判断。**

| # | 代码 | 行为（byoc 时） | 本 app 影响 |
|---|---|---|---|
| 1 | `Hpi(){return KIND==="byoc"&&!CLAUDE_CODE_BYOC_ENABLE_DATADOG}` → `initializeDatadog` | Datadog 遥测**关闭** | 低（未启用 Datadog） |
| 2 | `_Tr(){if(DC("fanout"))return!0;if(KIND==="byoc")return!0;...}` → `yEi()` 加 `"ccr"` | 会话环境标记多一个 `ccr` | 低（遥测/标记用途） |
| 3 | `Tee(){return KIND!=="byoc"||CCR_BYOC_RESOURCE_WATCHDOG_TELEMETRY}`（配 `tZe()`） | 资源看门狗（磁盘/内存告警）**关闭** | 低 |
| 4 | `Sz()`：`KIND!==void 0` 直接返回 null | Linux 下「看起来像本机路径」的拒绝保护**失效** | 低（Windows 为主；但这是安全相关面） |
| 5 | 技能提案：`if(!CLAUDE_CODE_SKILL_PROPOSALS&&KIND!==void 0)return!1` | 技能提案**关闭** | 低/中（若以后启用该特性） |
| 6 | 会话种类：`if(KIND===void 0&&REMOTE!==!0)return"local";return"unknown"` | 会话标签从 `local` 变 `unknown` | 低（遥测/状态标签） |
| 7 | `let Ie=Boolean(P.sdkUrl)&&Boolean(REMOTE_SESSION_ID)&&KIND===void 0&&!DISABLE_WORKING_SYNC` | SDK 下的 "working sync" **关闭** | 低（本机无远程 UI） |
| 8 | `let w=KIND===void 0`（事件过滤器/交接） | turn-handoff 事件过滤分支改变 | 低（无 remote link 时该通道不活跃） |
| 9 | `OSt()` / 会话类型判定：`if(KIND==="byoc")return!1`、`remote===!0&&(!y||y==="anthropic_cloud")`、`...||KIND||!Tf()` | claude.ai connector / MCP 复用判定变严 | 低（app 自带 MCP 配置） |
| 10 | bridge 载体：`KIND==="byoc"&&Ne(REMOTE)` 时删除 `CLAUDE_CODE_BRIDGE_MCP_CARRIER` | 仅远程 bridge 分支 | 无（`REMOTE` 未设） |
| 11 | `TT(){return KIND==="bridge"}` | 不受 byoc 影响 | 无 |
| 12 | 远程会话检测 `u5t()` / `SZr()` / `Dn()` / `Ip()` / `n0()` / `L3e()` / `lbi()` | 需要 `REMOTE===true` 或 `REMOTE_SESSION_ID`；本机为 false，byoc 不改变结果 | 无 |
| 13 | `myn()` / `tB()` / `_Zs()` / 暂存根 / `/outputs/` / project_write 白名单 | 需要 `REMOTE_SESSION_ID`；本机不触发 | 无 |
| 14 | `zo()` / `Oe()` / `GC()` / `L3e` 轮询 | 需要 `REMOTE===true` | 无 |
| 15 | agent proxy：`KIND!=="byoc"` 时报 `not_byoc` 失败 | 仅「要求走自建代理」的远程会话 | 无 |
| 16 | 三处 env 透传白名单集合包含 `CLAUDE_CODE_ENVIRONMENT_KIND` | 子/孙进程会继承该变量 | 低（但孙进程也会进入 byoc 语义，注意） |
| 17 | `Lvr()` hosting 信息、`Rvr`、`enabledPluginForwarding` 等携带 `environmentKind` | 交接/遥测元数据 | 低 |
| 18 | `Sz`/`lbi`/`Q8t` 等其余同族判定 | 均带 `REMOTE`/`IS()` 前置 | 无 |

**没有发现** byoc 影响：认证/token 来源、模型目录、beta header、自动更新（且 app 已设
`DISABLE_AUTOUPDATER=1`）、OTEL 端点、config 目录、UI 文案。唯一「可能被用户感知」的是
§3.2 #5（技能提案）与 #3/#4（安全网关闭），都属于边缘功能。

**额外收益**：由于宿主 env 含 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`，byoc 同时也让
「用户 settings 里的 base URL / API key」不再覆盖 app profile 的网关与凭据 —— 与本次 bug 同源，
是同一处修复的副作用。

---

## 4. 机制 B：SDK `settingSources`

### 4.1 传输方式（CONFIRMED）

- SDK 类型（`sdk.d.ts` L2315-2324）：
  > `'user'` - Global user settings (`~/.claude/settings.json`) … When omitted, all sources are
  > loaded (matches CLI defaults). **Pass `[]` to disable filesystem settings (SDK isolation mode).**
  > Must include `'project'` to load CLAUDE.md files.

- 传输有两条等价通道：
  1. CLI 参数（`sdk.mjs`）：`if(D!==void 0)W.push(We("--setting-sources",D.join(",")));`
     其中 `We(e,t)=>\`${e}=${t}\`` → `--setting-sources=project,local`；`[]` → `--setting-sources=`。
  2. initialize 载荷（`sdk.mjs` 的 `Fv`）：对象里含 `settingSources:c`，随启动握手下发。

- CLI 解析（CONFIRMED）：

```js
function Uts(e){if(e==="")return[];let n=e.split(",").map((o)=>o.trim()),t=[];
  for(let o of n){let i=r.find(([s])=>s===o);
    if(!i){let s=r.map(([c])=>c).join(", ");throw Error(`Invalid setting source: ${o}. Valid options are: ${s}`)}
    t.push(i[1])}
  return t}
// 调用点：function g(e){try{let r=Uts(e);Rto(r),or()}catch(r){...}}
```

  → `Rto()` 写入 `allowedSettingSources()`；`Oo()` 把它与 `flagSettings`、`policySettings` 合并：

```js
function Oo(){let e=I6e(),n=Ko();...let t=new Set(e);
  t.add("flagSettings");t.add("policySettings");
  let o=Ds.filter((i)=>t.has(i));...}
function Jt(e){return Oo().includes(e)}          // 源是否启用
var Ds=["userSettings","projectSettings","localSettings","flagSettings","policySettings"];
```

  结论：**`[]` ≠ 省略**。省略 = 三者全load；`[]` = 只剩 flag + policy。policy/managed 层
  **不受 settingSources 影响**（始终加载）。

### 4.2 排除 `'user'` 的损失清单

`Ds` 的 5 个源里，`userSettings` 被禁用后消失的是**整个 `~/.claude/settings.json`** 以及以
`'user'` 源为门控的资产：

| 用户级能力 | 来源 | 本 app 是否已自带替代 | 判定 |
|---|---|---|---|
| `env`（4 个 tier 变量、base URL、API key） | settings.json `env` | ✅ 自带（`buildProfileEnv` + L885-912） | 无关紧要 |
| `model` / `env.ANTHROPIC_MODEL` | settings.json | ✅ 每会话 `Options.model` | 无关紧要 |
| `permissions.defaultMode` / allow-deny 规则 | settings.json | ✅ app 传 `permissionMode` + 自带 broker | 无关紧要（但用户自定义 allow/deny 规则会丢） |
| `effortLevel` | settings.json | ⚠️ 仅当会话显式设置时；否则**丢** | **真实损失** |
| `modelSettings.<model>.autoCompactWindow` | settings.json | ❌ CLI 侧读取；app 只在 `Options.settings` 显式设过窗口时覆盖 | **真实损失**（用户的按模型窗口失效） |
| `enabledPlugins`（Claude 插件） | settings.json | ❌ app 的插件走自家 `mpStore` → `Options.plugins`，不读用户插件 | **真实损失** |
| `hooks`（用户级 hooks） | settings.json | ⚠️ app 自带 `buildInProcessHooks` + `Options.settings.hooks`，但用户自己的 hooks 会丢 | **真实损失** |
| `statusLine` / `outputStyle` / `spinnerTips` 等 UI 设置 | settings.json | ❌ | 真实损失（本 app 不渲染这些） |
| `skipAutoPermissionPrompt`、`modelSettings` 其它键、`cleanupPeriodDays` 等 | settings.json | ❌ | 真实损失 |
| `~/.claude/CLAUDE.md` | `'user'` 源 | ❌ | **真实损失**（用户全局指令失效） |
| 用户 skills / commands / agents（`~/.claude/skills` 等目录） | 目录发现，是否受 settingSources 门控 | — | **HYPOTHESIS**：d.ts 只明确 "Must include `'project'` to load CLAUDE.md files"；目录发现是否同样受限未验证 |
| 用户 MCP（`~/.claude.json` 的 `mcpServers`） | 非 settings 文件 | — | **HYPOTHESIS**：大概率不受 settingSources 门控（另有文件），未验证 |
| 认证（`~/.claude/.credentials.json`） | 非 settings 源 | ✅ app 自带 token | 不受影响 |

保留项：project `.claude/settings.json`、local `.claude/settings.local.json`、项目 `CLAUDE.md`、
flag 层（`Options.settings`）与 policy/managed 层。

### 4.3 本仓库对用户级设置的依赖（grep 结果）

- `server/routes/config-routes.ts` L196-235：`GET /api/config/claude-defaults` **直接读**
  `claudeConfigDir()/settings.json`（用于 Setup 页预填 token/baseUrl/modelList）。这是 server 侧
  文件读取，**不受 CLI settingSources 影响**，不会因 B 破坏。
- `server/skills.ts` L72：`scope==='user'` → `claudeConfigDir()/skills`（写入/导入路径）。
  若 CLI 侧不再发现用户 skills，UI 里「已安装的用户技能」会与实际可用技能不一致 —— 需实测。
- `server/history-reader.ts`、`server/subagent-watcher.ts`：只读 `claudeConfigDir()/projects` 下的
  转录，与 settings 源无关。
- `server/` 与 `shared/` 中**没有任何** `settingSources` / `managedSettings` 使用（grep 为空），
  即当前行为是 SDK 默认「全部源加载」。

---

## 5. 机制 C：其它路径

### 5.1 `Options.settings`（flagSettings 层）—— 最窄的候选

**优先级顺序 CONFIRMED**：`Ds=["userSettings","projectSettings","localSettings","flagSettings","policySettings"]`，
应用循环用 `Map` 以大写 key 覆盖写入，**后出现者胜**：

```js
let n=new Map;
for(let r of Oo()){let a=this.filterSettingsEnv(pe(r)?.env,r);
  for(let[_,E]of Object.entries(a))n.set(_.toUpperCase(),{key:_,value:E,source:r})}
for(let{key:r,value:a,source:_}of n.values()){if(!qRt(r,a))continue;
  if(uwe(_)){let E=Ies(r);process.env[r]=a,E()}else process.env[r]=a,Mes(r)}
```

SDK 契约（`sdk.d.ts` L2255-2271）：
> Additional settings to apply. … These are loaded into the **"flag settings" layer, which has the
> highest priority among user-controlled settings**. Equivalent to the `--settings` CLI flag.

CLI 侧把它并进 flag 源，通道标签为 `SDK inline settings`：

```js
if(L==="flagSettings"){let{settings:j,errors:V}=sAt(e);if(g(V),j)
  S("SDK inline settings",j,{channelLabel:!0}),s=WB(s,Qt(L,j,e),Q9)}
```

flag 层 env 同样经过 `filterSettingsEnv`；在**不设 byoc** 时 `hostSpawnEnvKeys===null`，`oe()` 直接
放行 → flag 值会覆盖 user 值。app 已经在这一层传过设置（`server/session-manager.ts` L2934-2941：

```ts
settings: meta.hooks || meta.autoCompactWindow !== undefined
  ? ({ ...(meta.hooks ? { hooks: toSdkHooksSettings(meta.hooks) } : {}),
       ...(meta.autoCompactWindow !== undefined ? { autoCompactWindow: meta.autoCompactWindow } : {}) } as Settings)
  : undefined,
```

）所以只需把 `env: { ANTHROPIC_DEFAULT_*_MODEL, ANTHROPIC_SMALL_FAST_MODEL }` 合进这个对象即可。

**下发通道（CONFIRMED）**：SDK 在 spawn 的参数构造里把它作为 CLI 参数传下去。`core.mjs` 的
`ProcessTransport.initialize()`：

```js
let pe={...h??{}};                       // h = options.extraArgs
if(this.options.settings) pe.settings=this.options.settings;
let Rt=Yr(pe,rt);                        // rt = options.sandbox
for(let[M,Y]of Object.entries(Rt))
  if(Y===null) R.push(`--${M}`); else Xr(R,M,Y);   // → --settings <value>
```

CLI 侧 `vEt()` 对以 `{` 开头的值按 **inline JSON** 处理（否则当文件路径）：

```js
function vEt(n,e){let r=(t,g)=>t===""||g&&t.trimStart().startsWith("{")?t:e(t);
  return{settings:n.settings===void 0?void 0:r(n.settings,!0), ...}}
```

因此 `flagInline`（`Np()→e.flagInline`）在 **argv 解析时**就有值；而 `Oo()` 恒包含
`flagSettings`（`t.add("flagSettings")`），`applyConfigEnvironmentVariables()` 的 Map 按
`user → project → local → flag → policy` 顺序后写覆盖。也就是说，在不设 byoc 时
`hostSpawnEnvKeys===null`，`oe()` 直接放行 flag 值 → **flag 层的 4 个 tier 变量会覆盖 user 层**。

**唯一未直接追踪的点（高置信结构性判断）**：argv 解析与首次 `applyConfigEnvironmentVariables()`
的先后。CLI 必然先解析命令行再应用设置，故理论上成立；仍建议用 §6.1 的运行探针做最终确认。
若运行时仍失败，则改用 A（byoc），或退到 D。

**顺带确认**：`apply_flag_settings` 控制通道有键限制（"only effortLevel and ultracode can" 的
Remote-Control 分支，以及 repo 文档 `2026-10-30-autocompact-semantics.md` 记录的 `autoCompactWindow`
在该通道 inert）→ **不建议**用 `applyFlagSettings({env})` 做运行时修复（HYPOTHESIS，未验证 env 是否被接受）。

### 5.2 `Options.managedSettings` —— 不可用（CONFIRMED，文档）

`sdk.d.ts` L3416-3421：
> Restrictive policy-tier settings — … filtered through a restrictive-key allowlist … non-restrictive
> keys such as `model`, **`env`**, `cleanupPeriodDays` are silently dropped.

### 5.3 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` —— 不影响 env 优先级（CONFIRMED）

`v()` 中：`managedByHost: e||!!CLAUDE_CODE_HOST_AUTH_ENV_VAR`，而 `hostOrchestrated: n||s==="byoc"`
—— **managedByHost 不参与 hostOrchestrated**。它的实际作用（全部使用点已 grep）：
- `re()`：当 `managedByHost || (desktopHost && source∈{policy,project,local})` 时丢弃 settings 里的
  provider/auth 类 key（`U`/`hCn`/`Tit` 集合），打印 "this session's provider routing is managed by the host"；
- CA 证书 / 代理 / git TLS 的 settings 来源被跳过（`NODE_EXTRA_CA_CERTS` 等）；
- auth 环境（`CLAUDE_CODE_HOST_AUTH_ENV_VAR`）、host creds 文件、`CLAUDE_CODE_HOST_CREDS_FILE`；
- 模型覆盖/探测器（`Lfn` 在 managedByHost 时直接 return；bedrock inference profile 列表为空）；
- 自动模式服务端分类器默认值。

结论：**单独设它不能修 env 覆盖**，且会附带一堆 provider/auth 行为变化。不推荐。

### 5.4 不存在的"权威 env"开关（CONFIRMED 不存在）

对二进制做穷举模式匹配 `[A-Z_]*{PATTERN}[A-Z_]*`，候选：
`ENV_WINS` / `HOST_ENV` / `SETTINGS_ENV` / `DISABLE_SETTINGS` / `NO_SETTINGS` / `ENV_OVERRIDE` /
`SETTINGS_OVERRIDE` —— 除无关的 `LOGIN_SUCCESS_ENV_OVERRIDE_WARNING` 外**零命中**。
即没有 `CLAUDE_CODE_HOST_ENV_WINS` / `CLAUDE_CODE_DISABLE_SETTINGS_ENV` 这类后门。

### 5.5 只检测、不改优先级（零侵入）

CLI 对「不认识的模型 id」有稳定信号（CONFIRMED，代码 + 运行日志）：

```js
var mcr="[claude-code:unrecognized_model]";
function mve(e,n){...a("tengu_api_unrecognized_model",{model:St(e),querySource:ws(n)});
  let s=`${mcr} ${_({model:e,query_source:n})}`...; dV(`${s}\n...`)}
```

本 app 的 `server/process-monitor.ts` 已把每条 stderr 写盘（`cli-stderr-<session>.jsonl`）
并同时 `log` 一行；`summarizeSpawn()`（`claude-provider.ts` L134-178）已经把 spawn env 里的
`RELEVANT_ENV_KEY` 记进 `createSession` 日志（敏感值 redacted）。因此可以在**不改 CLI 行为**的前提下：
1. 启动时读 `claudeConfigDir()/settings.json` 的 `env`（已有先例：`config-routes.ts` L197-210），
   与当前 profile 的四个 tier 值比对；
2. 冲突时在 UI 顶部/Settings 里提示，跳转到「覆盖 / 忽略 / 修改 ~/.claude/settings.json」；
3. 或直接收集 `unrecognized_model` 的 `query_source=agent:builtin:*` 帧，事后告警。

代价：仍是「用户看到警告后自己处理」，不解决自动化场景。

---

## 6. 推荐矩阵

| 机制 | 精确改动 | 修好什么 | 副作用 | 风险 | 验证步骤 |
|---|---|---|---|---|---|
| **A. byoc** | 在 `applyStandardQueryOpts`（`claude-provider.ts` L880 附近）的 `opts.env` 里加 `CLAUDE_CODE_ENVIRONMENT_KIND: 'byoc'`（必须在 customEnv 之后，防止被覆盖） | 4 个 tier 变量、`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 等宿主已设 key 不再被 user **和 policy** settings 覆盖 | §3.2 表：Datadog 关、资源看门狗关、技能提案关、Linux 路径保护关、会话标签 `unknown`、working-sync 关、`ccr` 标记、孙进程继承 byoc | **中**：语义上是"自建远程 runner"，副作用多但多为边缘；静默丢 settings env（无告警） | spawn 后检查 `cli-stderr` 不再出现 `query_source:"agent:builtin:*"` 的用户模型；再跑一次 `/status`、一个子代理、一次自动模式分类，确认无远程 runner 行为 |
| **B. settingSources** | `sdkOptions.settingSources = ['project','local']` | 整体禁用用户 settings（含 env） | §4.2 损失清单：用户 CLAUDE.md、用户 plugins/hooks/statusLine、`effortLevel`、`modelSettings.*.autoCompactWindow`、`skipAutoPermissionPrompt` 等全部丢失 | **高**：静默改变产品语义，且用户无感 | 对比开启前后 `/status` 的 setting sources；检查 `~/.claude/CLAUDE.md` 是否仍被注入；检查用户插件是否仍加载 |
| **C1. `Options.settings.env`（推荐候选）** | 在 `session-manager.ts` L2934 组装的 `settings` 对象里加 `env: { ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_SMALL_FAST_MODEL }`（值取本会话 tiers） | 只覆盖这 4 个 key；user 层一键不动 | 无（除非用户显式依赖 settings 里这 4 个值） | **低**：优先级路径与下发通道均 CONFIRMED（spawn 时 `--settings`）；仅 argv 解析与首次 env 应用的先后建议运行探针 | §6.1 的运行探针；确认 `query_source:"agent:builtin:general-purpose"` 用宿主模型；同时确认 `~/.claude/CLAUDE.md`/用户插件仍生效 |
| **C2. managedSettings** | 不可行 | — | — | — | 文档已排除 `env` |
| **C3. 魔改 env var** | 不存在 | — | — | — | 穷举搜索无命中 |
| **D. 检测+提示** | 读 `claudeConfigDir()/settings.json` 的 `env` 与 profile tiers 比对；或消费 `unrecognized_model` stderr | 不修行为，只暴露冲突 | 无 | **无** | 造一个冲突 settings，确认 UI 告警出现 |

### 6.1 必做的运行探针（验证 C1 时序，约 5 分钟）

1. 在 `Options.settings` 里加 `env: { ANTHROPIC_DEFAULT_SONNET_MODEL: '<本会话 sonnet>' }`（其余不动）。
2. 保持用户 `~/.claude/settings.json` 原样（冲突值 `xiaomi/mimo-v2.5-pro`）。
3. 新开一个会话，跑一个会派发 `general-purpose` 子代理的简单任务（或强制 `Task` 工具）。
4. 观察 `~/.claude-react-web/logs/cli-stderr-<sid>.jsonl`：
   - 若出现 `query_source:"agent:builtin:general-purpose"` 且 `model` = 本会话模型 → **C1 成立**；
   - 若仍是 `xiaomi/mimo-v2.5-pro` → C1 的启动时序不成立，改用 A（byoc），或退到 D。
5. 反向对照：同一会话 `summarizeSpawn` 日志里的 4 个 tier 值应与实际请求一致。

### 6.2 运行探针结果（2026-11-04，CONFIRMED）

C1 已实现于 `server/providers/claude/claude-provider.ts`（`mergeTierEnvIntoSettings` +
`applyStandardQueryOpts` 末尾的镜像调用），并有单测覆盖（
`server/providers/claude/claude-provider.test.ts` 的 `mergeTierEnvIntoSettings (C1 …)` 三条）。

隔离探针（不触碰主 server，沿用主 `~/.claude/settings.json` 的冲突值）：

- 启动：`tsx server/cli.ts -p 3499 --no-open --state-dir <tmp>`（临时 state dir 只复制了
  `config.json`，profile = Mify）。
- 会话 `b965aeb1-b206-4410-8fe8-a35acdb01362`：`modelGroupId=81d175f7-…`、`permissionMode=auto`，
  group main = `deepseek/deepseek-v4-pro`、sonnet = `zhipuai/glm-5.3-flash`、
  haiku = `deepseek/deepseek-v4-flash`。
- **子进程 argv 实证**（`Win32_Process.CommandLine`）：

  ```
  --settings "{\"env\":{\"ANTHROPIC_DEFAULT_OPUS_MODEL\":\"deepseek/deepseek-v4-pro\",
  \"ANTHROPIC_DEFAULT_SONNET_MODEL\":\"zhipuai/glm-5.3-flash\",
  \"ANTHROPIC_DEFAULT_HAIKU_MODEL\":\"deepseek/deepseek-v4-flash\",
  \"ANTHROPIC_SMALL_FAST_MODEL\":\"deepseek/deepseek-v4-flash\"}}"
  ```

- **CLI stderr 实证**：

  ```
  {"model":"deepseek/deepseek-v4-pro","query_source":"sdk"}          ← 主查询
  {"model":"zhipuai/glm-5.3-flash","query_source":"auto_mode"}       ← 分类器 = group sonnet 档
  ```

  该会话 `cli-stderr` 中 `mimo` 出现次数为 **0**（此前同一路径是 `xiaomi/mimo-v2.5-pro`）。
- 子代理：`Agent` 工具调用成功（"Async agent launched successfully"），后台子代理回复 `OK`，
  分类器没有拦截；用户 settings 未做任何修改。

结论：C1 的优先级、`--settings` 下发通道、以及“用户 settings env 被绕过”均在运行时成立。

---

## 7. 一句话回答

**能保证生效的是 byoc（A）**：`hostOrchestrated=true` → `hostSpawnEnvKeys=Set(Object.keys(process.env))`
→ `oe()` 丢弃 settings 里同名 env（含 policy），代价是一组 byoc-only 的远程-runner 行为切换。
**最窄的是 `Options.settings.env`（C1）**：只压 4 个 key、保留用户全部设置，优先级顺序与
`--settings` 下发通道均已在代码中证实，只差一次运行探针确认 argv 解析早于首次 env 应用。**`settingSources`（B）是"大锤"**：能修，但会静默丢掉用户级
CLAUDE.md / plugins / hooks / effort / modelSettings，不建议。**不存在**隐藏的 `*_ENV_WINS` 开关；
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 不改变 env 优先级；`managedSettings` 按文档丢弃 `env`。

---

## 附：证据索引

- 二进制：`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`
  - `function v()`（providerStripContext / hostOrchestrated）
  - `applySafeConfigEnvironmentVariables()` / `applyConfigEnvironmentVariables()`
  - `strippedSettingsEnv` / `keptSettingsEnv` / `function oe(e,n,s,r)` / `function We(e,n,s)`
  - `function Oo()` / `function Jt(e)` / `var Ds=[...]`
  - `function Uts(e)`（`--setting-sources` 解析）/ `Rto()`
  - `var mcr="[claude-code:unrecognized_model]"` / `function mve`
  - `Auto mode classifier: ANTHROPIC_DEFAULT_SONNET_MODEL=` 日志
  - `if(L==="flagSettings"){... S("SDK inline settings",...)}`
- SDK：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` L2255-2272（`settings`）、L2314-2324
  （`settingSources`）、L3410-3421（`settingSources` / `managedSettings`）；
  `core.mjs`（`ProcessTransport.initialize()` 的 `pe.settings=this.options.settings` +
  `for(...)Xr(R,M,Y)` → `--settings`、`--setting-sources` 参数构造、`pt=L?{...L}:{...process.env}`、
  `function to(s)` / `function vEt(n,e)` 的 inline-JSON 判定）。
- CLI（补充）：`claude.exe` 中 `function Afe(n)` 的 `["--settings", n.settings]`、
  `function vEt(n,e)`（`{` 开头 → inline）。
- App：`server/providers/claude/claude-provider.ts` L134-178（summarizeSpawn）、L180-235
  （buildProfileEnv）、L861-912（applyStandardQueryOpts 的 tier env）；`server/session-manager.ts` L2934-2941（Options.settings 组装）；
  `server/routes/config-routes.ts` L197-235（读 settings.json）；`server/skills.ts` L72。
- 运行证据：`~/.claude-react-web/logs/server-2026-11-04.log`、
  `~/.claude-react-web/logs/cli-stderr-02e27050-4697-47ff-b2ad-beb1a4652e0f.jsonl`；
  用户 `~/.claude/settings.json`（只读检查，未修改）。