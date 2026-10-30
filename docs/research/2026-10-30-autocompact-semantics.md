# Claude Code auto-compact 官方语义考据

> 2026-10-30。回答：`autoCompactWindow` 与 threshold 的关系、触发时机、per-model 设置、
> `/autocompact` 与 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 的优先级。
> 来源分级：**官方文档**（code.claude.com/docs）> **CLI 自身实现**（claude.exe 2.1.278 反编译 +
> CHANGELOG）> **SDK 类型契约**（sdk.d.ts）> **本 app 实现**（shared/auto-compact.ts，仅对照，非官方）。
> 实测结论来自 2026-10-30 的现场实验（本仓 claude-react-web 对 CLI 2.1.278）。

---

## 1. window 与 threshold：两个概念，官方文档只承诺一个

**官方定义（window）**——`autoCompactWindow` 设置项：

> Set how full the context window gets before Claude Code compacts automatically.
> **Type**: number of tokens, from `100000` to `1000000`. Claude Code caps the value at your
> model's context window. **Default**: unset, so Claude Code picks a window tuned for your model.
>
> — [Settings reference · autoCompactWindow](https://code.claude.com/docs/en/settings-reference.md#autocompactwindow)

`modelSettings.<model>.autoCompactWindow`（per-model 形式）：

> `autoCompactWindow`: a number of tokens from `100000` to `1000000`, or `"auto"` for the window
> tuned for the model. `/autocompact` saves here. For that model, the value takes precedence over
> a top-level `autoCompactWindow` in the same settings file. Requires Claude Code v2.1.288 or later.
>
> — [Settings reference · modelSettings](https://code.claude.com/docs/en/settings-reference.md#modelsettings)

即：**window = "上下文允许涨到多满才自动 compaction"的一个 token 数**，取值 100k–1M，
超过模型真实窗口时被 clamp（"Whichever way you set the window, Claude Code caps it at the model's
context window"，[model-config](https://code.claude.com/docs/en/model-config.md#set-the-auto-compact-window)）。

**threshold（实际触发点）不在官方文档里**。文档不公布任何公式；CLI 内部在 window 之下再留
headroom 提前触发（precompute）：

```
threshold = window − min(maxOutputTokens, 20000) − 13000   // buffer
```

- 来源：CLI 2.1.278 二进制（`KW()`/`MZ()`/`Bfo()`，触发日志 `autocompact: tokens=… effectiveWindow=…`）
  与本 app 的复刻 `shared/auto-compact.ts`（`AUTOCOMPACT_MAX_OUTPUT_FLOOR=20000`、
  `AUTOCOMPACT_BUFFER_TOKENS=13000`）。
- **官方旁证**：文档明说 1M 原生窗口模型 "compact before the window fills, at about **967K**
  tokens by default"（[model-config · Default auto-compact thresholds](https://code.claude.com/docs/en/model-config.md#default-auto-compact-thresholds)）——
  恰好 = 1,000,000 − 20,000 − 13,000，与公式吻合。
- ⚠️ 该公式是 CLI 内部实现，常量随版本可漂移；本 app 的 drift 告警（pump 里
  "threshold drift: CLI reports …, local formula derived …"）就是为此存在，修 app 时应继续
  以 CLI 回报值为准。

## 2. 触发语义

- **何时触发**："Claude Code compacts automatically as you approach the limit"（[context-window · When your context fills up](https://code.claude.com/docs/en/context-window.md#when-your-context-fills-up)）。
  实现上每回合开始重新解析（二进制 `remote_autocompact_state` 帧注释："re-checked at each turn
  start"），token 计数越过 threshold 即触发；另见 [`idleCompaction`](https://code.claude.com/docs/en/settings-reference#idlecompaction)（闲置会话的 compaction）。
- **触发后做什么**："summarizes the conversation history to fit the context window"——结构化摘要替换
  历史；摘要请求继承会话的 extended thinking 配置（v2.1.198+）。哪些内容存活（CLAUDE.md 重注入、
  最近 5 个文件重读、skills 重注入等）见 [What survives compaction](https://code.claude.com/docs/en/context-window.md#what-survives-compaction)。
- **默认阈值**（未设置任何 window 时，[Default auto-compact thresholds](https://code.claude.com/docs/en/model-config.md#default-auto-compact-thresholds)）：
  - 一般：对话涨到模型 context limit 才 compact；
  - 1M 原生窗口模型（Fable、Sonnet 5+、Haiku 5.5、Opus 4.7+）：**~967K** 就 compact；
  - Sonnet 4.6/Opus 4.6 无 extended context：200K 边界；
  - `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`：1M 模型压到 200K 边界；
  - 未识别 model ID（LLM gateway 别名等）：按假定窗口 compact（默认假定 200K）；
  - cloud 会话：接近 limit 时 compact。
- **reactive 路由**：`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` 后，未识别 ID
  **不做 proactive compaction**，只在 API 抛出可识别的 "Prompt is too long" 后做 reactive
  recovery（[env-vars](https://code.claude.com/docs/en/env-vars.md)、model-config）。二进制里还有
  reactive 阈值路由（`l5n`：`thresholdSource !== 'auto'` 时 "routing through reactive"）与
  rapid-refill breaker、prefix-overflow 检测等内部机制（非文档）。
- **状态广播**（CLI 内部，非文档）：`autocompact_state` 帧
  `{enabled, effective_window, threshold, enforced, source}`——"emitted by CCR workers at boot,
  whenever the resolved state changes (/autocompact, model switch, settings change), re-checked
  at each turn start"，thin client 用它把 "% until auto-compact" 指示器对准真实触发点。

## 3. 设置途径与优先级（官方）

设置 window 的全部官方途径（[Set the auto-compact window](https://code.claude.com/docs/en/model-config.md#set-the-auto-compact-window)）：

| 途径 | 作用域 | 说明 |
|---|---|---|
| `/autocompact <值>` | 当前模型，本会话 + 以后 | "saves it to your user settings under the current model in `modelSettings` **and applies it to the current session**"（**live 生效**）。`/autocompact auto` 恢复模型调优值；无参数打开查看对话框（[commands](https://code.claude.com/docs/en/commands.md)，v2.1.221+） |
| `autoCompactWindow` 设置键 | 所有模型 | settings 文件任意层（user/project/local/managed，"Scope: Any file"） |
| `--autocompact <值>` | 一次启动 | 覆盖已存设置且不写回；**不被 managed 等更高优先级 scope 抢占**（与 `/autocompact` 不同） |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 脚本/云环境 | 优先于命令、flag、设置键，除非值被忽略（见下） |
| subagent frontmatter `autoCompactWindow` | 单个 subagent | 只降不升子代理窗口（[sub-agents](https://code.claude.com/docs/en/sub-agents.md#subagent-auto-compact-window)；2.1.312 起对 env 窗口也生效，CHANGELOG） |

**优先级链**（合并 settings.md 的通用 precedence 与本键的特例）：

```
CLAUDE_CODE_AUTO_COMPACT_WINDOW（env，除非值不可用被忽略）
  > --autocompact（flag，per-launch；不被 managed 抢占）
    > modelSettings.<model>.autoCompactWindow（同文件内 > 顶层 autoCompactWindow）
      > 顶层 autoCompactWindow（跨文件按 managed > --settings > local > project > user 取最高层）
        > "auto"（模型调优默认；1M 模型 ≈ 967K threshold）
```

- 跨文件解析按 **model 维度**："Claude Code resolves it one model at a time"（settings.md · modelSettings）。
- `/autocompact` 与更高优先级冲突时："the command saves your value but the session keeps that
  scope's window, and the command says so"。
- **per-model 保存是 v2.1.288 起的行为**："Before v2.1.288, the command saved one window for every
  model, as the top-level `autoCompactWindow`"；键按 canonical model name 存，"matches that
  model's alias, date-suffixed, `[1m]`, and recognized provider-specific IDs"。相关修复：
  2.1.302（gateway 前缀模型存错）、2.1.305（modelOverrides 大小写/`[1m]` 差异导致不生效）——
  CHANGELOG。
- **值的解析**（[CLAUDE_CODE_AUTO_COMPACT_WINDOW 的取值](https://code.claude.com/docs/en/model-config.md#claude_code_auto_compact_window-values)）：
  `/autocompact`/flag 接受 `200000` / `500k` / `1M` / 裸数 100–1000 = 千（`200`→200,000）；
  env 变量的裸数按**字面 token**（`200` = 200 tokens！），k/M 后缀要 v2.1.304+；越界告警
  （<100k → 按 100k 下限；过大 → 1M 上限；不可用 → 忽略并回落到其他途径）。

## 4. 开关类变量 / 设置

| 名称 | 官方语义 |
|---|---|
| `autoCompactEnabled`（设置键） | 自动 compaction 总开关，**默认 `true`**；`/config` 的 "Auto-compact" 写此键。"whichever of the two turns it off, the other can't turn it back on"（与 `DISABLE_AUTO_COMPACT` 互锁）。[settings-reference](https://code.claude.com/docs/en/settings-reference#autocompactenabled) |
| `DISABLE_AUTO_COMPACT`（env） | 关自动 compaction（含 idle compaction），**手动 `/compact` 仍可用**；覆盖 `autoCompactEnabled` |
| `DISABLE_COMPACT`（env） | 关**一切** compaction（自动 + 手动 `/compact`） |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | 关 1M 窗口支持，1M 模型压到 200K |
| `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` | 未识别 model ID 跳过 proactive compaction，仅 reactive（v2.1.223+） |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 声明 gateway/自定义 model ID 的真实窗口（未识别 ID 默认假定 200K 并告警；修正途径见 [Correct the window](https://code.claude.com/docs/en/model-config.md#correct-the-window-for-a-gateway-or-custom-model-id)，含 `modelOverrides` / `modelPicker.behavesAs` / `[1m]` 后缀） |

另注意官方对 percentage 的定性（与本 app ContextBar 分母直接相关）：
> "the status line's `used_percentage` measures against the model's full context window, so while
> the variable is set, that percentage doesn't indicate when compaction will run."
（即 env 窗口生效时，百分比 ≠ compaction 时机。）

## 5. SDK 契约 vs 实测（本节为 2026-10-30 实测，非官方文档）

**官方文档的途径清单里没有 `applyFlagSettings`**（第 3 节五条就是全部）。但 SDK 类型契约更宽：

- `sdk.d.ts` `Query.applyFlagSettings(settings)`（约 L2990–3010）：接受任意 `Settings` 键
  （含 `autoCompactWindow`）合并进 "the session-scoped **flag layer**"，`null` 清除；
- `sdk.d.ts` `Query.updateSettings(source, settings)`（L3012）：只允许
  `localSettings: outputStyle` / `userSettings: effortLevel` 的 **allowlist**，字符串值、不支持删除。

**2.1.278 实测（claude-react-web 环境，xiaomi/mimo-v2.6-pro，1M 窗口）**：

| 通道 | 结果 |
|---|---|
| `applyFlagSettings({autoCompactWindow})`（即 app 拖动走的路） | **惰性**：控制请求返回 success、flag 层有值（二进制 `gy` → `replaceFlagSettingsInline`），但 trigger/report 的 `resolveAutoCompactWindow` 始终 `source:"auto"`。实验：POST window=500000 后 `/autocompact` 查询仍打印 `Auto-compact window: auto` |
| `updateSettings('userSettings', {autoCompactWindow})` | **被 allowlist 拒**（二进制 `$w = {localSettings: Set["outputStyle"], userSettings: Set["effortLevel"]}`） |
| spawn 时 `Options.settings.autoCompactWindow`（≈ `--settings`） | **有效**：`500k tokens (from settings)`，threshold 467000，`autocompactSource:"settings"` |
| `/autocompact 883k`（CLI 内部 writer） | **live 有效**：立即 `source:"settings"`、threshold 850000，写入 `~/.claude/settings.json` 的 `modelSettings["xiaomi/mimo-v2.6-pro"].autoCompactWindow` |

→ **结论**：文档口径（/autocompact、设置键、flag、env）与实测一致——live 通道就是 settings 层；
SDK 的 applyFlagSettings "任意 Settings 键"承诺对 `autoCompactWindow` 在 2.1.278 **不兑现**
（值进了 flag 层但 `resolveAutoCompactWindow` 不读它）。这属于 SDK 文档与 CLI 实现的 contract
gap，值得上报。CLI 内部的 resolve 源枚举（`["env","settings","clientdata","experiment",
"model-default","unknown-model","auto"]`，二进制 `ME()`）中 `"settings"` 对应 settings/flag 解析出的
显式窗口，`"auto"` 是纯公式兜底——与官方文档的优先级叙述兼容。

## 6. 与本 app 的映射（app-side，非官方）

- `shared/auto-compact.ts`：复刻 threshold 公式（20000/13000 常量）+ `DEFAULT_AUTO_COMPACT_THRESHOLD_PCT = 85`
  + `autoCompactWindowForPct`（app 的 "85%" = threshold 落在模型窗口 85% 处 → window = 0.85W + 33k）。
  ⚠️ 注意官方语义里 **window 本身就是"多满才压"的口径**（第 1 节）；app 把拖动条做成 threshold 百分比
  是产品转译，不是 CLI 语义。
- `CONFIG.md` `autoCompactThresholdPct`：app 的 create-time 默认 pin 机制（本次排查确认其
  probe-skip 缺陷 + pin 通道惰性，见 2026-10-30 排查记录）。
- app 侧修复方向与官方语义对齐的做法：pin 走 **spawn `Options.settings`**（或 CLI args `--autocompact`），
  live 变更走 `/autocompact` 语义等价通道（内部 writer 不可及 → 只能 respawn 或提示），
  并按 `autocompactSource` 区分"CLI 侧真自定义"与"纯 auto"。

## 7. 来源清单

官方文档（primary）：
- https://code.claude.com/docs/en/settings-reference.md — `autoCompactWindow` / `modelSettings` / `autoCompactEnabled` / `idleCompaction`
- https://code.claude.com/docs/en/model-config.md — "Set the auto-compact window" / "Default auto-compact thresholds" / "CLAUDE_CODE_AUTO_COMPACT_WINDOW 的取值与告警" / "Correct the window for a gateway or custom model ID"
- https://code.claude.com/docs/en/context-window.md — "When your context fills up" / "What survives compaction"
- https://code.claude.com/docs/en/commands.md — `/autocompact`、`/compact` 条目
- https://code.claude.com/docs/en/env-vars.md — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` / `CLAUDE_CODE_DISABLE_1M_CONTEXT` / `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`
- https://code.claude.com/docs/en/settings.md — settings 文件层级与 precedence、modelSettings 跨文件解析
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md — 2.1.285（set_model 后窗口/限额到重启才生效的修复、gateway 1M）、2.1.288（per-model 保存）、2.1.302（gateway 前缀存错）、2.1.304（env k/M 后缀）、2.1.305（大小写/`[1m]` 修复）、2.1.312（subagent window vs env）

CLI 实现（2.1.278 二进制，`%APPDATA%/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`）：
- `resolveAutoCompactWindow`（`ME()`）与 source 枚举；`/autocompact` 命令 handler（`en("userSettings", …)` 内部 writer + `apply_flag_settings` 事件）；`$w` update_settings allowlist；`gy`→`replaceFlagSettingsInline`；`autocompact_state` 帧 schema；threshold 公式（`KW`/`MZ`/`Bfo`）。
- SDK 契约：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`Settings.autoCompactWindow` L9167、`modelSettings` L9154–9156、`applyFlagSettings` L2990–3010、`updateSettings` L3012）。

app 侧（对照用）：`shared/auto-compact.ts`、`CONFIG.md`（`autoCompactThresholdPct`）。
