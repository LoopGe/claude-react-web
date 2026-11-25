# Claude CLI `/autocompact` 命令调研：它到底调整什么

> 2026-11-25。背景：对比各 harness 如何获得/调整模型 context size（DSH 侧见
> `2026-11-25-dsh-context-size.md`）。用户口径是 "Claude CLI 可以通过 /auto-compact 来调整"——
> 本文查清该命令的**真实名称、调整对象、参数形态、触发计算链、持久化位置与 SDK 面**。
>
> **版本记录**（只读调查，未修改任何被调查包/二进制）：
> - 全局 CLI **2.1.322**：`C:\Users\Ge Zelin\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
>   （Bun 编译原生二进制，内嵌 minified JS，`rg -a` 直接搜；`package.json` version 2.1.322）。
> - SDK pin **0.3.311** 内嵌 CLI **2.1.311**：`node_modules\@anthropic-ai\claude-agent-sdk\manifest.json`
>   （`"version":"2.1.311"`）；实际二进制在平台包
>   `node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`（package version 0.3.311）。
>   两个版本都含本命令与同一套 flag-merge 分支（§4.2），下文二进制证据默认引 2.1.322，差异处注明。
> - 前作 `2026-10-30-autocompact-semantics.md` 针对 CLI **2.1.278** 做过 live 实测；本文是它的
>   命令专题深化 + 版本推进复核，不重复其全部结论，冲突处（§4.2）明确标注。
>
> **方法**：二进制字符串/代码片段静态分析（minified 函数名跨 chunk 会撞名，引用时以函数体为准）+
> SDK d.ts 行号 + 官方文档核对 + **2026-11-25 对 pin 的 2.1.311 的 live 复验**（§4.2.1）。
> 凡属静态推断而非实测的结论均标注。§6 的 DSH/CRW 对照是分析，不是 CLI 事实。

---

## 0. 一句话结论（TL;DR）

**命令真名是 `/autocompact`（无连字符；二进制与文档中都不存在 `/auto-compact` 这个名字或别名）。
它调整的不是模型 context window 本身，而是 auto-compact 的"策略窗口" `autoCompactWindow`
——"上下文允许涨到多满才自动压缩"的一个 token 数（100k–1M），永远被 clamp 到模型真实窗口之下。**

- 形态：`/autocompact [auto|<tokens>]`。交互 TUI 无参数打开一个**左右步进选择器**（auto ↔ 100k…1M，
  步长 100k，回绕）；带参数直接设值；非交互（print/SDK/thin client）无参数打印当前状态文本。
- 持久化：写 **`~/.claude/settings.json`（userSettings）的 `modelSettings.<canonical model>.autoCompactWindow`**
  （v2.1.288 起 per-model；之前写顶层 `autoCompactWindow`），**user 作用域、跨重启保留、当前会话立即生效**。
- 触发链：`resolvedWindow − min(maxOutputTokens, 20000) − 13000 = threshold`。
  1M 原生窗口模型默认 ≈ **967K** 触发（官方文档数字与公式吻合）。
- 开关是**另一个键** `autoCompactEnabled`（`/config` 切换，默认 true）；`/autocompact` 不管开关。
- SDK 面：spawn 走 `Options.settings.autoCompactWindow`（live 有效）；运行时
  `applyFlagSettings({autoCompactWindow})` 虽然 2.1.311/2.1.322 二进制里有显式 merge 分支，
  **2026-11-25 对 pin 的 2.1.311 live 复验仍 inert**（§4.2.1）——2.1.278 的 contract gap 在 SDK 面依旧；
  `getContextUsage` 回报 `autoCompactThreshold` / `isAutoCompactEnabled` / `autocompactSource`。

与 DSH 的本质差异（分析）：**DSH 让用户调"分母"（模型容量本身），Claude CLI 让用户调"分母之下的
策略上限"**——模型窗口是 CLI 的内置知识，不可由该命令抬高。

---

## 1. 命令行为与参数

### 1.1 注册形态：一个名字，两套实现

二进制里 `autocompact` 有两条命令注册（2.1.322；2.1.311 同构，minified 名不同）：

```js
// 交互 TUI 版（local-jsx，渲染对话框；immediate: 不打断当前回合）
phn = { type: "local-jsx", name: "autocompact",
  description: "Set how full the context gets before auto-summarizing",
  immediate: !0, isEnabled: () => !ye(), isHidden: !1,
  argumentHint: "[auto|<tokens>]", userFacingName() { return "autocompact" } }
// 非交互 / thin-client 版（纯文本）
lPe = { type: "local", name: "autocompact", supportsNonInteractive: !0,
  thinClientDispatch: "post-text", description: "Configure the auto-compact window size",
  get isHidden() { return !ye() && !An() }, isEnabled() { return ye() || An() },
  argumentHint: "[auto|<tokens>]", load: () => import("B:/~BUN/root/chunk-6w6qnn4k.js"), … }
```

`ye()` 即"非交互模式"（`function ye(){return!t().host.launchOptions.isInteractive()}`）：
交互终端走对话框版，print/SDK/remote 走文本版。复现：

```bash
rg -a -o '.{0,250}name:"autocompact",supportsNonInteractive.{0,80}' bin/claude.exe
rg -a -o '.{0,400}Set how full the context gets before auto-summarizing.{0,100}' bin/claude.exe
```

**没有 `/auto-compact` 别名**：`rg -a -o '.{0,60}name:"auto-compact".{0,60}' bin/claude.exe` 零命中。
官方 commands 表同样只列 `/autocompact [auto|<tokens>]`，"Requires Claude Code v2.1.221 or later"
（https://code.claude.com/docs/en/commands.md）。

### 1.2 参数解析

命令实现 `idt(arg, ctx, route)`（route ∈ `"dialog" | "noninteractive"`）：

```js
async function idt(e, o, s) {
  let n = fc(o.options.mainLoopModel);
  if (uS(n, void 0).source === "env")
    return "CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset it to change this setting.";
  let r = e.trim().toLowerCase(),
      t = r === "reset" || r === "unset" || r === "default" ? "auto" : Kxn(r);
  if (t === void 0)
    return `Couldn't parse '${e}'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)`;
  …
}
```

- **接受值**：`auto`；`reset` / `unset` / `default` 三个同义词也归一到 `auto`；token 数。
- **token 解析** `Kxn` → `EAe(e, {bareThousands: true})`：`k`/`M` 后缀（`500k`、`1M`）；
  **裸数 100–1000 按"千"解释**（`200` → 200,000）；范围 `cI = 1e5` 到 `dW = 1e6`
  （`var …cI=1e5,dW=1e6;`），越界/不可解析 → 拒绝并给出期望文案。
- **env 抢占**：`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 已设置时命令**直接拒绝写入**（上面第一行），
  对话框里同样显示 "…is set and takes precedence. Unset it to change this setting here." 且禁用调整。
- 注意 env 变量自身的裸数语义**不同**：`CLAUDE_CODE_AUTO_COMPACT_WINDOW=200` 是 200 tokens
  （官方文档明说；`spn` 对 env 走不带 bareThousands 的解析，越界 clamp 到 100k/1M 并告警）。

### 1.3 交互对话框：左右步进选择器，不是预设列表

无参数交互态打开 `he({onDone, caller})` 组件（chunk-6w6qnn4k.js）：

```js
var m = 1e5, p = 1e5, f = 1e6, t = 0;   // 步长 100k，下限 100k，上限 1M，auto 哨兵 = 0
// 初值：来源不是 env/settings 时从 auto 起步；否则 round(configured/100k)*100k clamp 到 [100k, 1M]
// 左/右：auto 态右键 → 100k、左键 → 1M；数值态 ±100k；跌破 100k 或涨破 1M 都回绕到 auto
// Enter → idt(u === 0 ? "auto" : String(u), caller, "dialog")；Esc → "…unchanged: …"
```

UI 文案（均为二进制字符串证据）：
- 标题 "Auto-compact window"，当前值行 "Current setting for <model>: …"，
  选择行 "Select auto-compact window: <值>"；快捷键提示 left/right "adjust"、enter "apply"、escape "cancel"。
- 说明："This command configures when auto-compaction happens. The actual threshold is the minimum
  of this setting and your model's maximum context window."
- auto 推荐语（仅对已有调优窗口的模型 `_ir(settingsKey)`）："The auto setting picks a window tuned
  for your model and is **strongly recommended** for the best cost and performance."
- 警告：选值超过 auto 调优窗口（`bir(e,o){return Math.min(e.contextWindow,o)>Vis(e).window}`）→
  "Overriding auto may result in high token usage, especially when resuming long sessions."；
  配置值大于模型窗口 → "· capped to <X> by model"；auto-compact 被关闭 →
  "Auto-compact is currently disabled (see /config)"。

复现：`rg -a -o '.{0,1400}let Ae=Re,oe=a==="auto"' bin/claude.exe`（组件头部含常量与步进函数）。

### 1.4 无参数非交互态与结果文案

`PCa`（文本版 handler）：无参数 → 打印当前状态；有参数 → `idt(arg, ctx, "noninteractive")`。
状态文本由 `A(model, options.autoCompactWindow)` 组装：

```
Auto-compact window for <model>: <N> tokens (from settings|from CLAUDE_CODE_AUTO_COMPACT_WINDOW|
    default for this model|default for an unrecognized model|auto) [· capped to <X> by model]
[env 告警行]
[Auto-compact is currently disabled (see /config)]
Auto-compact summarizes the conversation when context usage approaches this limit. The actual
  threshold is the minimum of this setting and your model's maximum context window.
[auto 推荐语]
```

设值成功的回显区分三种情况（`idt` 尾部）：
- `… set to <N> tokens`；
- `… set to <N> tokens (capped to model limit of <X>)`（解析出的窗口 < 请求值）；
- `… set to <N> tokens, but a higher-priority override is active (<X> tokens)`
  （写入成功但更高优先级来源仍在生效——例如 CRW 的 spawn pin，见 §6.2）；`auto` 同理两分支。

另有 CLI 启动 flag **`--autocompact <auto|tokens>`**（"Auto-compact window size (auto, or 100k–1M
tokens)"，同一 `Kxn` 解析；一次启动有效、不写回、**不被 managed settings 抢占**——官方文档口径），
以及压缩进行时的 spinner 提示 "Compacting at auto window (<N> tokens) · /autocompact to configure"。
遥测事件 `tengu_autocompact_command`（action/tokens/window_model/previous_tokens/resulting_tokens/
overridden/route）。

---

## 2. 压缩触发计算链（window → threshold → 何时触发）

### 2.1 窗口解析 `uS`（resolveAutoCompactWindow）：优先级与 clamp

```js
function uS(e, n, r = Up()) {           // e = 模型事实{contextWindow, settingsKey, …}，n = 会话覆盖
  let { contextWindow: s } = e;
  if (G9t(n)) {                          // {ceiling} 包装 = subagent 定义（§4.4），只降不升
    let S = uS(e, n.inner, r), { ceiling: w } = n;
    if (S.window <= w) return S;
    return { window: Math.min(s, w), configured: w, source: "settings" };
  }
  let h = spn(i.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (h !== void 0) return { window: Math.min(s, h), configured: h, source: "env" };
  let y = typeof n !== "object" ? n                       // 标量 = 会话覆盖（--autocompact / flag 层）
        : Object.hasOwn(n.byModel, e.settingsKey) ? n.byModel[e.settingsKey] : n.default;
  if (y !== void 0 && y !== "auto")
    return { window: Math.min(s, y), configured: y, source: "settings" };
  return Vis(e, r);                      // auto 兜底链
}
```

**每一层都 `Math.min(modelContextWindow, configured)`——该命令只能把窗口往小调，不能抬高模型窗口。**
`Vis`（auto 链，高 → 低）：clientdata 下发窗口 → experiment（含 desktop 的 600k/500k 表 `Zur`）→
model-default（`CLAUDE_CODE_DISABLE_1M_CONTEXT` 时 `VBt = 200000` 封顶；`_bt` 命中时 `FH = 200000`；
per-model 调优表 `gpn`，如 `{"claude-sonnet-5":{surfaces:{remote_cowork:{default:500000},
"local-agent":{default:500000}},default:1e6}}`）→ 长上下文/opt-in 边界 → unknown-model 假定窗口
（`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` 可跳过 proactive）→ 最终 `window = contextWindow`
（source `"auto"`）。source 枚举与 `autocompact_state` 帧 schema 一致：
`["env","settings","clientdata","experiment","model-default","unknown-model","auto"]`。

会话覆盖的来源标签由 `K9t` 细分：`session_override`（标量）/ `agent_definition`（ceiling）/
`settings_per_model` / `settings_top_level`。settings 对象由 `V9t()` 跨文件合并：逐文件读
`modelSettings.*.autoCompactWindow`（canonical 化键 `Ej`）与顶层 `autoCompactWindow`；
**同一文件内 per-model 替换顶层**（与 d.ts/文档口径一致）。

### 2.2 threshold 公式（CLI 内部，非文档承诺）

```js
var xoo = 20000;                                    // 输出预留下限
function Noe(e, n) {                                // effectiveWindow
  let r = Math.min(e.maxOutputTokens, xoo), { window: h } = uS(e, np() ? n : void 0);
  return h - r;
}
function O4(e, n) {                                 // threshold
  let r = e - 13000, s = n.testPctOverride;         // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE（测试用）
  if (s !== void 0 && !isNaN(s) && s > 0 && s <= 100) return Math.min(Math.floor(e * (s / 100)), r);
  return r;
}
function HI(e, n) { return O4(Noe(e, n), Mre(e, n)) }   // → getContextUsage 的 autoCompactThreshold
function att(e, n) {                                // precompute（背景预摘要）触发点，更早
  return Math.min(e - Math.round(e * n.precomputeBufferFraction), O4(e, n));
}
```

即：

```
effectiveWindow = resolvedWindow − min(maxOutputTokens, 20000)
threshold       = effectiveWindow − 13000
precomputeAt    = min(effectiveWindow × (1 − fraction), threshold)   // fraction 默认 CAe = 0.2
```

- **官方旁证**：1M 原生窗口模型 "compact … at about **967K** tokens by default"
  （model-config · Default auto-compact thresholds）= 1,000,000 − 20,000 − 13,000，精确吻合。
  200K 窗口 → threshold 167,000。
- `Mre` 给出 `{enabled, precomputeBufferFraction, testPctOverride, testBlockingOverride}`；
  `enabled = np()`：`function np(){if(n())return!1;return Ii("autoCompactEnabled",!0).value}`
  ——`autoCompactEnabled` 设置键（默认 true）与 `DISABLE_AUTO_COMPACT`/`DISABLE_COMPACT` env 互锁
  （`autocompact_state` 帧 describe："DISABLE_COMPACT also disables manual /compact"）。
  precompute fraction 可被 experiment `tengu_amber_rokovoko` / per-window arm 表覆盖（`ptt`/`ytt`）。
- 分级 `ltt`：`ok` → `warn`（≥ effectiveWindow − 20000）→ `compact`（≥ threshold 且 enabled）→
  `blocked`（≥ (contextWindow − min(maxOutput,20000)) − 3000，硬阻塞边界）。
- **每回合开始重解析**：`autocompact_state` 帧 describe "re-checked at each turn start"；
  触发路径（`slo`/`lHr`/`O3r` 等）全部读 `n.options.autoCompactWindow` 现算。
- 相邻机制（同一代码域）：rapid-refill 断路器（`Ooo`：连续 3 次快速 refill → trip，
  `autocompact: circuit breaker tripped after …`）、reactive 路由（"routing through reactive
  (thresholdSource=…)"，prompt-too-long 后的恢复压缩）、`idleCompaction`（闲置压缩）、
  `precomputeCompactionEnabled`（背景预摘要开关）。

复现（2.1.322）：

```bash
rg -a -o 'function O4\(e,n\)\{let r=e-13000.{0,300}' bin/claude.exe
rg -a -o 'function Noe\(.{0,300}' bin/claude.exe        # 取含 xoo 的那条
rg -a -o 'var xoo=.{0,40}' bin/claude.exe               # var xoo=20000
rg -a -o 'CAe=0\..{0,30}' bin/claude.exe               # CAe=0.2
```

---

## 3. 持久化与作用域

### 3.1 写入路径：userSettings 的 per-model 键

`idt` 的写入段（2.1.322）：

```js
let { error: m } = await Vn("userSettings",
  sIs(n.model, { autoCompactWindow: t }, { autoCompactWindow: d }), void 0, o.storageV5);
if (m) return `Couldn't save setting: ${m.message}`;
zCi(n.settingsKey, t);                                 // CCR/remote 元数据同步（auto_compact_windows）
let { window: c, configured: C, source: y } = uS(n, V9t());
o.onQueryEvent?.({ type: "apply_flag_settings", settings: { autoCompactWindow: null } });
```

- `sIs(model, patch, fallback)` = `{ modelSettings: { [Ej(model)]: patch } }`（`Ej` = canonical 模型名）。
  即 **`~/.claude/settings.json` → `modelSettings.<canonical model>.autoCompactWindow: <number|"auto">`**。
  d.ts 原文（sdk.d.ts:9347）："…**/autocompact saves here**. The canonical model name as key also
  matches its dated, [1m], Bedrock and Vertex spellings."
- **作用域 = user**（本机所有项目），**按模型**区分；重启保留。官方 commands 表："Claude Code saves
  the value to user settings and applies it to the current session."
- **版本分界**：v2.1.288 起 per-model；"Before v2.1.288, the command saved one window for every model,
  as the top-level `autoCompactWindow`"（model-config 文档）。per-model 键本身要求 v2.1.288+。
- **当前会话立即生效的机制**：写入后发内部 QueryEvent `apply_flag_settings {autoCompactWindow: null}`，
  经 `T5e` 把会话的标量覆盖重置为 `V9t()`（重新合并后的 settings，含刚写入的值）——不是靠重启。
- 与更高优先级冲突时：**值照写，会话不生效**，回显 "higher-priority override is active"
  （managed settings、env、会话 flag 覆盖都可能压过它；文档同口径）。

### 3.2 相关键的全景

| 键/变量 | 位置 | 语义 |
|---|---|---|
| `modelSettings.<model>.autoCompactWindow` | settings 任意层（"Any file"） | per-model 策略窗口，`'auto' \| 100000..1000000`；同文件内压过顶层键 |
| `autoCompactWindow`（顶层） | settings 任意层 | 所有模型的策略窗口（number）；跨文件按 managed > --settings > local > project > user |
| `autoCompactEnabled` | settings 键（sdk.d.ts:9600），默认 true | 自动压缩总开关；`/config` 切换；旧值可在 `~/.claude.json`（legacyGlobalConfig），二进制有迁移分支（`lbs`：false 值迁写 userSettings） |
| `precomputeCompactionEnabled` / `idleCompaction` | settings 键（9604/9608 附近） | 背景预摘要 / 闲置压缩，均只在 auto-compact 开启时相关 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | env | 最高优先级（压过命令/flag/settings）；裸数按字面 token；k/M 后缀 v2.1.304+；越界 clamp+告警 |
| `--autocompact <auto\|tokens>` | CLI flag | 一次启动；不被 managed 抢占；不写回 |
| `DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT` | env | 关自动（手动 /compact 仍可用）/ 关一切压缩 |
| subagent frontmatter `autoCompactWindow` | agent 定义 | 只降不升子代理继承窗口（§4.4） |

---

## 4. SDK 面（@anthropic-ai/claude-agent-sdk 0.3.311）

### 4.1 spawn 时：`Options.settings`

`sdk.d.ts:2272` `settings?: string | Settings`（Options 类型起于 :1566）——"loaded into the
'flag settings' layer, which has the highest priority among user-controlled settings.
Equivalent to the `--settings` CLI flag."。`Settings.autoCompactWindow`（:9360，"Auto-compact window
size"）与 `Settings.modelSettings.<model>.autoCompactWindow`（:9347–9349）都在该层可达。
**这是 CRW 目前使用的通道**（§6.2），2.1.278 实测有效（前作 §5）。

### 4.2 运行时：`applyFlagSettings` —— 2.1.278 的 inert gap 在新版本看起来已修

- 类型面：`Query.applyFlagSettings(settings: { [K in keyof Settings]?: … | null })`
  （sdk.d.ts:3028–3031），控制请求 `SDKControlApplyFlagSettingsRequest { subtype:
  'apply_flag_settings', settings }`（:3965–3969）。会话级 flag 层，`null` 清除；**不写 settings 文件**。
- **二进制证据（2.1.322 与 2.1.311 均有）**：flag-merge 函数 `T5e` 里有显式分支：

```js
if ("autoCompactWindow" in a) {
  let e = a.autoCompactWindow, n = e == null ? V9t() : Number(e);   // 2.1.311 里 V9t 名为 qHt
  if (!t(o.autoCompactWindow, n)) o = { ...o, autoCompactWindow: n };
}
```

  且 SDK 控制回路直接接线 `applyFlagSettings: (dn) => T5e(dn, It.setState)`；触发路径读
  `options.autoCompactWindow`（§2.2）。即：**数值 → 会话标量覆盖（uS 的 session_override，
  source "settings"）；null → 重置为合并 settings**。
- **与前作的冲突已裁决（live）**：2026-10-30 在 CLI 2.1.278 上 live 实测该通道 inert（值进 flag 层
  但 resolve 不读，前作 §5）。本次在 2.1.311/2.1.322 二进制中找到了上述显式分支，但
  **2026-11-25 对 pin 的 2.1.311 的 live 复验表明 SDK 面仍 inert**（§4.2.1）——静态分支存在 ≠
  SDK 会话生效（假设：该分支接线的是交互 host 的状态存储，SDK worker 的窗口解析读另一份快照；
  未证实，标注为假设）。CRW 代码里 "applyFlagSettings is inert for this key" 的注释
  （`server/providers/claude/claude-provider.ts:597–599`、`src/types.ts:144–148`、
  `server/persistence.ts:81–85`、`shared/auto-compact.ts:12–16`）**继续成立**。

#### 4.2.1 Live 复验记录（2026-11-25，SDK 0.3.311 / CLI 2.1.311）

**方法**：独立 tsx 探针，复用 CRW 自己的 `loadConfig` + `buildProfileEnv`（active profile：
gateway `xiaomi/mimo-v2.6-flash`，`maxOutputTokens=128000`），`query({ prompt: asyncIterable, … })`
最小 spawn（无 systemPrompt/agents/MCP 附加项）。**方法学陷阱**：async-iterable prompt 时 SDK
`deferSpawn:!0`（sdk.mjs，`Fv(…,{deferSpawn:!0})`）——子进程在**第一条用户消息写入时才 spawn**；
等 init 再发消息会死锁。探针每阶段先发一条 "Reply with the single word: ok" 触发 spawn。

| 阶段 | 操作 | rawMaxTokens | maxTokens | autoCompactThreshold | autocompactSource |
|---|---|---|---|---|---|
| A 无 spawn pin | turn 1 后基线 | 200000 | 200000 | 167000 | `unknown-model` |
| A | `applyFlagSettings({autoCompactWindow:120000})`（控制请求被接受，返回 null） | 200000 | 200000 | 167000 | `unknown-model` |
| A | 再跑一条真实 turn（触发路径回合开始重解析） | 200000 | 200000 | 167000 | `unknown-model` |
| A | `applyFlagSettings({autoCompactWindow:null})` | 200000 | 200000 | 167000 | `unknown-model` |
| B spawn pin 150000（`Options.settings`） | turn 1 后基线 | **150000** | **150000** | **117000** | `settings` |
| B | `applyFlagSettings({autoCompactWindow:120000})` | 150000 | 150000 | 117000 | `settings` |
| B | `applyFlagSettings({autoCompactWindow:null})` | 150000 | 150000 | 117000 | `settings` |

**结论**：
1. **运行时通道 inert 复验成立**：数值与 null 都不移动解析结果（A、B 两阶段，含真实 turn 后）。
   B 阶段尤其有力——解析明明在读 settings 层（source `settings`、pin 生效），运行时 merge 仍不覆盖。
2. **spawn pin 有效**，且 threshold 公式精确吻合：150000 − min(128000,20000) − 13000 = 117000；
   200000 − 20000 − 13000 = 167000。
3. **分母 = 策略窗口**（§4.3 的 d.ts 口径 live 证实）：pin 后 `rawMaxTokens == maxTokens == 150000`，
   不是裸模型窗口。
4. **gateway 模型被 CLI 视为 unknown**：stderr `[claude-code:unrecognized_model]`，source
   `unknown-model`，假定窗口 200000——gateway 模型的真实窗口对 CLI 是猜测（CRW 侧启示见 §6.2）。
5. 附带 sanity：一条 "ok" turn 后 `totalTokens=80232`（system prompt + 工具 schema 的真实开销量级），
   `percentage = totalTokens / rawMaxTokens`。
6. SDK 响应实际键名是 camelCase（`rawMaxTokens`/`maxTokens`/`autocompactSource`），d.ts 的
   `raw_max_tokens` 是 wire 名；`autocompactSource` 枚举与 §2.1 的 source 枚举一致。
- `Query.updateSettings(source, settings)`（sdk.d.ts:3043 附近）是写文件的通道，但 allowlist
  只有 `localSettings: outputStyle` / `userSettings: effortLevel`——**不能经它持久化 autoCompactWindow**
  （2.1.278 实测被拒，前作 §5；d.ts 注释同口径）。

### 4.3 读回：`getContextUsage`

`SDKContextUsage`（sdk.d.ts:3880 起）：
- `raw_max_tokens`（:3894）："The window usage is measured against: **the resolved autocompact
  window** — the model's believed limit, or a smaller compaction-policy window…"——分母是策略窗口，
  不是裸模型窗口；
- `autoCompactThreshold?: number`（:4160）与 `isAutoCompactEnabled: boolean`（:4161）——
  CLI 自己算好的触发点与开关事实（§2.2 的 `HI`/`np`）；
- 分类行 id 含 `autocompact_buffer` / `compact_buffer`（:4063）——`/context` 网格里的压缩预留行。

另有内部帧 **`autocompact_state`**：sdk.mjs 将其原样 enqueue 进消息流
（`if(e.type==="autocompact_state"){this.inputStream.enqueue(e);continue}`），但**公共 d.ts 未声明该类型**。
二进制 describe：`{enabled, effective_window, threshold, source}`，"@internal Worker-resolved
auto-compact state, emitted by CCR workers at boot, whenever the resolved state changes
(/autocompact, model switch, settings change), re-checked at each turn start…"——thin client 用它
对齐 "% until auto-compact" 指示器；`effective_window` 明说是 "resolveAutoCompactWindow output
clamped to the model window, honoring /autocompact, CLAUDE_CODE_AUTO_COMPACT_WINDOW, clientdata
and experiment overrides"。

### 4.4 subagent：`AgentDefinition.autoCompactWindow`

sdk.d.ts:79："Token count at which this agent compacts its own conversation when it runs as a
subagent. **It only lowers the window the subagent would otherwise inherit.** No effect on the
main session agent."。二进制对应 `uS` 的 `{ceiling}` 包装分支（§2.1）与
`q9r(options.autoCompactWindow, agentDef.autoCompactWindow)` 接线。

### 4.5 与 `/compact`、`/context` 的关系

- `/compact [instructions]`：手动压缩，与 `/autocompact` 共用压缩执行域但**不共享窗口设置**；
  `DISABLE_COMPACT` 同时关掉两者，`DISABLE_AUTO_COMPACT` 只关自动（帧 describe + 文档）。
- `/context`：可视化占用，其 buffer 行与阈值就是 §4.3 的 `autocompact_buffer` /
  `autoCompactThreshold`；`/autocompact` 改窗口后 `/context` 的分母与预留行随之变化。
- `/config`：`autoCompactEnabled` 开关的入口（命令回显与对话框都指向 "see /config"）。

---

## 5. 版本核对小结

| 事实 | 2.1.311（SDK pin） | 2.1.322（全局） |
|---|---|---|
| `/autocompact` 命令（双注册、`[auto|<tokens>]`） | 有（`rg -a -c autocompact claude.exe` = 78 处） | 有 |
| `--autocompact` flag、reset/unset/default 同义词 | 有 | 有 |
| flag-merge 的 `"autoCompactWindow" in a` 分支 | 有（`qHt()`） | 有（`V9t()`） |
| `applyFlagSettings({autoCompactWindow})` 运行时生效（live） | **inert**（§4.2.1，2026-11-25 实测） | 未测（静态分支同构） |
| threshold 公式常量 20000/13000 | 与 CRW `shared/auto-compact.ts` 复刻一致（2.1.278 起未漂移） | 同左 |
| per-model 保存（v2.1.288+） | 有 | 有 |

2.1.278 → 2.1.311 之间与本命令相关的 CHANGELOG 修复（前作已录）：2.1.288 per-model 保存、
2.1.302 gateway 前缀存错、2.1.304 env k/M 后缀、2.1.305 大小写/[1m] 匹配、2.1.312 subagent 窗口 vs env。

---

## 6. 与 DSH / CRW 的对照（分析，非 CLI 事实）

### 6.1 与 DSH：调"分母" vs 调"分母之下的策略上限"

| 维度 | DSH（见对照笔记） | Claude CLI `/autocompact` |
|---|---|---|
| 用户可调的量 | **模型容量本身**（`modelOverrides.contextWindow` / profile `models` 条目），是解析链顶层 | **压缩策略窗口** `autoCompactWindow`，永远 ≤ 模型窗口（`Math.min` clamp） |
| 模型窗口来源 | provider-owned 精确路由元数据（listing 发现 / 静态目录 / 兜底） | CLI 内置模型知识 + gateway 修正（`modelOverrides` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS`），**不经该命令** |
| 阈值公式 | `floor(min(W×0.8, W−输出预留−65536))`，比例+headroom 可配 | `W' − min(maxOutput,20000) − 13000`，固定 buffer，比例不可配（仅测试 env） |
| 调整入口 | 设置页 UI 编辑器 / 配置文件 | 斜杠命令（写 user settings）/ settings 键 / flag / env |
| 持久化 | profile 配置 + session log 的 `request/context` 事件 | `~/.claude/settings.json` per-model 键；会话级覆盖不持久 |

结论：用户说 "CLI 可以通过 /auto-compact 来调整 context size" 是**近似正确的口语**——它调的是
"有效压缩窗口"，在 auto-compact 开启时确实决定了会话实际可用的上下文上限（ContextBar 的分母
`raw_max_tokens` 就是它），但它**不能把模型窗口调大**，且与模型真实容量是两层概念。

### 6.2 CRW 现状：已接的面与未接的面

已接（本仓源码核对）：
- **spawn pin**：New session 表单的绝对 token 输入（`src/components/session-list/NewSessionDialog.tsx:186,486–540`）
  → `Options.settings.autoCompactWindow`（`server/session-manager.ts:3384–3387`），持久化在
  `SessionMeta.autoCompactWindow`（`server/persistence.ts:81–85`），**每次 spawn（create/resume/fork/
  clear/restart）重新注入**。flag 层是 user-controlled 最高优先级，所以 CRW pin 会压过用户在
  CLI 侧 `/autocompact` 存的 per-model 值——在该会话里跑 `/autocompact` 会命中 §1.4 的
  "higher-priority override is active" 分支（值照写、会话不变）。
- **开关产品规则**：spawn 后 `applyFlagSettings({autoCompactEnabled:true})`
  （`claude-provider.ts:597–605`）；`applySettings` 把客户端传来的 `false` 强制 coerce 为 `true`
  （`session-manager.ts:6789–6791`）。
- **读回 CLI 事实**：`getContextUsage` 顺带收割 `autoCompactThreshold`/`isAutoCompactEnabled`
  （`session-manager.ts:7530–7560`，`parseSdkAutoCompactFacts`/`probeAutoCompactFacts`），
  ContextBar 以 CLI 回报值为准；`shared/auto-compact.ts` 复刻 20000/13000 公式仅作漂移告警的本地近似。
- **native provider 自有压力检查**：manager 的 `maybeAutoCompact` 用
  `s.autoCompactWindow ?? usage.autoCompactThreshold ?? maxTokens×nativeAutoCompactRatio(0.8)`
  （`session-manager.ts:6126–6175`、`server/config.ts:87–90`）——这是 CRW 自己的压缩决策，
  与 CLI 的 `/autocompact` 无直接关系，但复用了同一个显式窗口字段。

未接 / 待复核：
- **live 窗口调整**：2026-11-25 复验裁决——运行时通道在 pin 的 2.1.311 **仍 inert**（§4.2.1），
  claude 会话改窗口仍只能 respawn（或走 CLI 自己的 `/autocompact`，但会被 CRW spawn pin 压过）；
  四处 inert 注释继续成立。**native provider 无此 contract gap**（CRW 自有代码）——若要做
  "会话内拖窗口"，native 侧可以直接实现 live setter，claude 侧只能 respawn。
- **`/autocompact` 透传**：CRW 未做该命令的专门 UI；用户经 CLI 侧执行时写的是共享的
  `~/.claude/settings.json`，会影响该模型的**所有**后续会话（除非被 CRW spawn pin 覆盖）。
- **native 面板的分母与 pin 脱节**（2026-11-25 代码核对，分析）：CLI 的分母是**生效策略窗口**
  （§4.2.1 live 证实），而 native 的 `getContextUsage` 回报 `maxTokens = 裸模型窗口`、
  `autoCompactThreshold = min(floor(window × nativeAutoCompactRatio), outputReservedWindow)`
  （`native-session.ts:1965–1972`），**完全不感知会话 pin**——pin 只活在 manager 的压缩决策里
  （`session-manager.ts:6172` `s.autoCompactWindow ?? usage.autoCompactThreshold ?? ratio`）。
  后果：pinned native 会话的 Context tab buffer/free 行与实际压缩触发点不一致。且同一个 pin
  数字跨 provider 语义不同：claude 侧经 CLI 当**窗口**（threshold = pin − min(maxOutput,20000) − 13000），
  native 侧被 manager 直接当 **threshold**。借鉴方向：把 pin 线进 NativeSession，按 CLI 的
  "每层 Math.min" 纪律 clamp 窗口并派生 threshold，让回报值 = 生效策略；顺带统一 pin 语义。
- **gateway 模型窗口校正**（§4.2.1 第 4 条 live 证据）：CLI 对 unrecognized gateway 模型假定 200K。
  CLI 有校正面（`modelOverrides` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，model-config 文档）；
  CRW native resolver 已有 profile override + discovery 的窗口知识，同一份知识可注入 claude
  provider 的 spawn（settings/env），让 claude 面板的分母不再是猜测。follow-up feature。

---

## 7. 关键证据索引

二进制（全局 2.1.322：`C:\Users\Ge Zelin\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`；
SDK pin 2.1.311：`D:\codes\claude-react-web\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`。
minified 名跨 chunk 撞名，以函数体辨认）：

| 关注点 | 复现命令（rg -a -o，对 exe） |
|---|---|
| 命令双注册 / argumentHint | `'.{0,250}name:"autocompact",supportsNonInteractive.{0,80}'`；`'.{0,400}Set how full the context gets before auto-summarizing.{0,100}'` |
| 命令 handler `idt`（env 拒绝/reset 同义词/写入/回显） | `'function idt\(e,o,s\).{0,1600}'` |
| 非交互 handler `PCa` / 状态文本 | `'Auto-compact summarizes.{0,250}'`（前文含 `A` 的组装） |
| 对话框常量与步进 | `'.{0,1400}let Ae=Re,oe=a==="auto"'`；`'function bir\(e,o\).{0,120}'` |
| token 解析 / 范围 | `'function Kxn\(.{0,300}'`；`'function EAe\(e,\{bareThousands.{0,600}'`；`'cI=1e5,dW=1e6'` |
| 窗口解析 `uS` / auto 链 `Vis` / 调优表 `gpn` | `'function uS\(e,n,r=Up\(\)\).{0,900}'`；`'gpn=\{"claude-sonnet-5".{0,400}'`；`'var gbt=200000,FH=200000.{0,120}'` |
| settings 合并 `V9t` / 写入 patch `sIs` / CCR 同步 `zCi` | `'function V9t\(\).{0,400}'`；`'function sIs\(.{0,200}'`；`'function zCi\(.{0,300}'` |
| threshold 公式 | `'function O4\(e,n\)\{let r=e-13000.{0,300}'`；`'function Noe\(.{0,300}'`（含 xoo 条）；`'var xoo=.{0,40}'`；`'function att\(e,n\).{0,150}'`；`'CAe=0\..{0,30}'` |
| 开关 `np` / legacy 迁移 | `'function np\(\)\{if\(n\(\)\)return!1.{0,200}'` |
| flag-merge 分支（§4.2） | `'.{0,120}"autoCompactWindow"in.{0,200}'`；`'.{0,200}T5e\(.{0,120}'`（取 `applyFlagSettings:(dn)=>T5e(dn,It.setState)` 条） |
| `--autocompact` flag | `'.{0,60}--autocompact <auto\|tokens>.{0,150}'` |
| `autocompact_state` 帧 schema | `'.{0,100}Worker-resolved auto-compact state.{0,400}'` |
| 无 `/auto-compact` 别名 | `'.{0,60}name:"auto-compact".{0,60}'`（零命中） |

SDK d.ts（`D:\codes\claude-react-web\node_modules\@anthropic-ai\claude-agent-sdk\sdk.d.ts`，0.3.311）：

| 字段 | 行号 |
|---|---|
| `AgentDefinition.autoCompactWindow`（subagent，只降不升） | 79 |
| `Options`（类型起点）/ `Options.settings`（flag 层，--settings 等价） | 1566 / 2255–2272 |
| `Query.applyFlagSettings` / `Query.updateSettings`（allowlist 注释） | 3028–3031 / 3033–3045 |
| `SDKControlApplyFlagSettingsRequest` | 3965–3969 |
| `SDKContextUsage.raw_max_tokens`（resolved autocompact window） | 3894 |
| `SDKContextUsage.autoCompactThreshold` / `isAutoCompactEnabled` | 4160 / 4161 |
| context 分类行 `autocompact_buffer` / `compact_buffer` | 4063 |
| `Settings.modelSettings.<model>.autoCompactWindow`（"/autocompact saves here"） | 9347–9349 |
| `Settings.autoCompactWindow`（顶层） | 9360 |
| `Settings.autoCompactEnabled` / `precomputeCompactionEnabled` / `idleCompaction` | 9600 / 9604 / 9608 |
| sdk.mjs：`autocompact_state` 透传；settings zod schema（auto\|number） | `rg -o '.{0,80}autocompact_state.{0,120}' sdk.mjs` |

官方文档（2026-11-25 核对）：
- https://code.claude.com/docs/en/commands.md — `/autocompact [auto|<tokens>]` 行（v2.1.221+，
  存 user settings、当前会话生效、无参数开对话框）、`/compact`、`/context` 行
- https://code.claude.com/docs/en/model-config.md — "Set the auto-compact window"（五条设置途径与优先级、
  值形态、v2.1.288 分界）、"Default auto-compact thresholds"（967K）、
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW 的取值与告警"、"Correct the window for a gateway or custom model ID"
- https://code.claude.com/docs/en/settings-reference.md — `autoCompactWindow` / `autoCompactEnabled`
  索引行（Scope: Any file）、`modelSettings` 完整条目（per-model autoCompactWindow，v2.1.288+）
- https://code.claude.com/docs/en/settings.md — settings 文件层级与 precedence、modelSettings 跨文件按模型解析

本仓对照（分析用）：`shared/auto-compact.ts`、`server/providers/claude/claude-provider.ts:585–605`、
`server/session-manager.ts:3384–3387,6126–6175,6789–6840,7530–7560`、`server/persistence.ts:75–90`、
`server/config.ts:87–90`、`src/types.ts:144–149`、`src/components/session-list/NewSessionDialog.tsx:186,486–540`；
前作 `docs/research/2026-10-30-autocompact-semantics.md`（CLI 2.1.278 live 实测）。