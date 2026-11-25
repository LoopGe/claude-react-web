# Prompt Prediction（prompt suggestions / 预测下一条用户输入）机制调研

> 2026-11-25。对象：(a) `D:\codes\deepseek-harness`（下称 **DSH**）是否具备"每轮回复后预测用户下一条输入"
> 的功能；(b) **Claude CLI / Claude Agent SDK** 的 `promptSuggestions` / `prompt_suggestion` 完整实现。
> 目的：为本仓 `native` provider（直连 Anthropic 兼容 API、无 CLI 子进程）实现同等行为提供可复刻的事实基础。
>
> **版本记录**：
> - DSH：只读调研，未修改、未 pull。工作树干净，分支 `master`，HEAD 固定在
>   **`39163dd30f703a79079e2d2446545cff3c453738`**（2026-11-13，merge PR #8422），与
>   `2026-11-25-dsh-context-size.md` 的 pinned commit 相同。DSH 路径与行号以该 commit 为准。
> - SDK：本仓已安装 `@anthropic-ai/claude-agent-sdk` **0.3.311**
>   （`node_modules/@anthropic-ai/claude-agent-sdk/package.json`），其 manifest 声明 CLI **2.1.311**
>   （`manifest.json`：`version: "2.1.311"`，`commit: e7d3b8365a0ffbe2f5dd032feb28e9fd9c7de025`，
>   `buildDate: 2026-10-26T19:03:46Z`）。SDK 实际 spawn 的 CLI 是平台包
>   `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`（Bun 单文件可执行，win32-x64，
>   manifest checksum `966f4b2ce962…`）。
> - 官方文档仅作佐证（§5），与本地源码冲突时以本地源码为准。
>
> **方法**：静态源码调研。CLI 是约 300 MB 的 Bun 打包二进制，其中嵌入的 JS 模块大部分为**明文 minified
> 代码**（少数模块标注 `// @bun @bytecode`，不可读；prompt-suggestion 相关模块全部是明文）。用
> `rg -a -b -o` 定位字节偏移、`dd` 开窗提取后阅读。下文 CLI 引用一律写作
> **`claude.exe @ <十进制字节偏移>`**（针对上述 2.1.311 win32-x64 二进制）；minified 标识符
> （`ico`/`TR`/`Rx` 等）是该 build 的局部名字，**不是稳定 API**，引用时同时给出语义描述。
> 凡属推断而非直接读到的事实，均显式标注 **[推断]**。

---

## 0. 一句话结论（TL;DR）

**DSH 没有 prompt prediction 功能**（§1 给出搜索证据）。**Claude CLI 有完整实现**：每轮 `result`
之后，用**会话主模型**（不是 haiku 之类的小模型）发起一次**fork 请求**——完整复用父对话的消息前缀 +
系统提示 + 工具表，仅在末尾追加一条固定的 `[SUGGESTION MODE: …]` user 消息（提示词全文见 §3.3），
工具调用一律 deny、不写 transcript、不写新 cache 断点；**只在父对话 prompt cache 仍然温热时才生成**
（多重 cache-cold 抑制，§3.4），产出经一组长度/语气/多语言过滤（§3.5）后以
`{type:'prompt_suggestion', suggestion, uuid, session_id}` 帧发给 SDK 宿主。

"几乎免费（piggybacks on prompt cache）"的说法**方向正确但有条件**：官方文档的措辞是"计入用量限额 /
API 成本；因为复用对话 prompt cache，主要是 cache read + 少量输出 token，附加成本很小"
（§5 引文）；CLI 用 cache-warm 门槛保证这一点，而不是无条件免费（§3.4、§6.3）。

对本仓 native provider 最关键的三件事：
1. **消费侧零改动**：pump / WS / client 已完整消费 `prompt_suggestion`（§6.1），native 只需在 turn
   结束后经 handle 消息流发出同形状帧。
2. **生成请求 = 主模型 + 完整对话前缀 + 固定 user 提示词 + 禁工具 + 不落盘**；native 的
   `buildRequestBody` 已有 ephemeral cache 断点（`anthropic-stream.ts:140-165`），piggyback 机制可复刻，
   但必须保持 system/tools/messages 前缀逐字节一致（§6.2）。
3. **成本控制靠抑制而非小模型**：cache 冷则跳过、上一轮出错则跳过、plan mode / 限流 / 首轮均跳过
   （§3.2、§3.4）；失败静默跳过、不重试、不发帧（§3.6）。

---

## 1. DSH：没有 prompt prediction 功能（缺席证据）

在 pinned commit 上对 `packages/`、`apps/`、`docs/`、`native/`、`python/`、`vendor/`、`scripts/`、
`packages/bundle/` 运行了以下搜索（均排除 node_modules），**没有找到任何"预测下一条用户输入"的实现**：

| 搜索词（大小写不敏感） | 范围 | 结果 |
|---|---|---|
| `promptSuggestion` / `prompt_suggestion` / `prompt-suggestion` / `nextPrompt` / `next_prompt` | packages | 仅 1 个文件：`packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts:334` 的循环变量 `nextPrompt`（compaction 测试里遍历不同 prompt 字符串，与预测无关） |
| `suggestion` | packages | 28 个文件，全部是无关功能：插件推荐（`packages/experimental/plugin-recommendations/package.json` 描述 "Official plugin suggestions with explicit user activation…"）、触发菜单 aria 标签（`packages/client/ui-input-trigger/src/client/locales.ts:17,33` "触发候选建议 / Trigger suggestions"）、下载建议文件名（`packages/client/ui-file-actions/src/types.ts:17`）、session-inspector 类型过滤等 |
| `predict` / `预测` / `followup` / `follow-up` / `follow_up` | packages | "predictable/unpredictable" 类注释（文件名不可预测等）；`followup()` 是 agent inbox 的**用户输入入队 API**（"queues an ordinary next-turn prompt and wakes the driver"，`packages/core/agent/README.md:58`），入队的是用户自己写的内容，不是模型预测 |
| `prompt.?suggest` / `suggest.?prompt` / `predict.{0,20}prompt` / `下一(条\|句).{0,6}(提示\|预测)` 等 | docs、apps、bundle、native、python、vendor、scripts | 无命中 |
| `ghost` / `inline.?suggest` / `autocomplete` / `tab.?completion` | packages | 命中均为无关代码（终端补全、测试断言等），无 composer 幽灵文本预测 |

两个容易误认的命中，澄清如下：

- **`prompt.suggest`** 只出现在 `packages/experimental/claude-code-mods/src/matcher.ts:13`。该包是
  Claude Code mods API 的兼容桥，`ENGINE_EVENTS`/`KNOWN_EVENTS` 列出的是 **Claude Code 的事件名**，
  模块 doc 明确："Event names are Claude Code's; a hook on a name this bridge never raises registers
  fine and never runs"（`matcher.ts:1-6`）。对 `engine.ts` 及其余源文件 grep `prompt.suggest` /
  `prompt.fill` 均无 raise 点——**DSH 引擎从不触发该事件**，它只是注册兼容名单里的一个名字。
- **`next-turn`** 在 `packages/client/ui-chat/src/client/conversation-nodes/inbox.ts:120,138-139`
  等处是 inbox/队列机制（"Persistent next-turn claims identify messages that wake a new Turn"），
  与预测无关。

**结论**：DSH（0.2.2-rc.3，pinned commit）不具备该功能，无生成模型、提示词、帧形状或配置可引用。
本调研的其余部分全部来自 Claude CLI / SDK。

---

## 2. SDK 表面：类型定义、选项传递与控制请求

### 2.1 `Options.promptSuggestions`（spawn 选项）

`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2102-2118`，注释全文（这是 SDK 侧最完整的
语义合同）：

```ts
/**
 * Enable prompt suggestions. When true, the agent emits a `prompt_suggestion`
 * message after each turn with a predicted next user prompt.
 *
 * Delivery semantics:
 * - At most one `prompt_suggestion` per turn; arrives after the `result` message.
 * - Consumers must keep iterating the stream after `result` to receive it.
 * - Suppressed on the first turn, after API errors, in plan mode, by the
 *   `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` env var, and when the user
 *   has `promptSuggestionEnabled: false` in settings.json (the env var wins
 *   over the setting).
 * - Also suppressed while the account is near or at its plan usage limit.
 *   `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true` keeps them on in the
 *   near-limit case; at the limit they stay off.
 * - Suggestions piggyback on the parent's prompt cache, making them nearly free.
 */
promptSuggestions?: boolean;
```

注意最后一条正是本仓 `claude-provider.ts:480-482` 注释的出处；§3.4 / §5 给出它在 CLI 实现与官方
文档中的精确化。

### 2.2 消息类型与联合

```ts
// sdk.d.ts:5888-5896
/** Predicted next user prompt, emitted after each turn when promptSuggestions is enabled. */
export declare type SDKPromptSuggestionMessage = {
    type: 'prompt_suggestion';
    suggestion: string;
    uuid: UUID;
    session_id: string;
};
```

`SDKMessage` 联合包含 `SDKPromptSuggestionMessage`（`sdk.d.ts:5587`）。**没有** subtype、没有
usage/cost 字段、没有候选列表——一帧一条建议字符串。

### 2.3 用户设置键

```ts
// sdk.d.ts:9373-9376（Settings 类型内）
/** When false, prompt suggestions are disabled. When absent or true, prompt suggestions are enabled. */
promptSuggestionEnabled?: boolean;
```

### 2.4 initialize 控制请求与运行时暂停

- `SDKControlInitializeRequest`（`subtype: 'initialize'`，`sdk.d.ts:4676`）携带
  `promptSuggestions?: boolean`（`sdk.d.ts:4742`）。SDK wrapper 把 spawn 选项原样透传：
  `sdk.mjs` 中 `promptSuggestions: this.initConfig?.promptSuggestions`（initialize 与 re-initialize
  两处，minified 窗口提取）。CLI 侧收到后写入会话选项：
  `if (e.promptSuggestions !== void 0) w.promptSuggestions = e.promptSuggestions`
  （`claude.exe @ 283,872,758`）。
- **re-initialize 的 opt-in 有额外门槛**：`let Ot = e.promptSuggestions === true,
  vt = Ot && !w.promptSuggestions && Qy(); if (vt) w.promptSuggestions = true`
  （`claude.exe @ 283,870,292`，遥测 `prompt_suggestions_requested` / `prompt_suggestions_opt_in_applied`）。
  `Qy` 从 `chunk-50nc53tm.js` 导入（`import{Qy}from"B:/~BUN/root/chunk-50nc53tm.js"`），该 chunk 中
  唯一的零参 `Qy` 定义是 `function Qy(){return i.CLAUDE_CODE_ENTRYPOINT==="remote_cowork"}`
  （`claude.exe @ 245,708,820`）**[推断：绑定关系由 import 名单与定义形状匹配得出，未逐字节追踪
  chunk 边界]**——即普通 SDK 宿主的 re-initialize 不会替用户自动 opt-in，只有 remote_cowork 入口会。
- **运行时暂停控制请求** `set_prompt_suggestions_paused`（`{paused: boolean}`）。CLI 内 zod schema 的
  describe 全文（`claude.exe @ 247,777,443`）：

  > "@internal Pauses (true) or un-pauses (false) the session's prompt suggestions at runtime, for a
  > host whose composer is not on screen: while paused, no turn end starts a suggestion, and the first
  > turn end after paused is set back to false does. The state is one boolean in this CLI process, on
  > top of the initialize request's promptSuggestions option and the user's own setting, neither of
  > which it changes: a respawned or resumed session starts unpaused, so the host must send it again,
  > and with two clients attached one client's pause applies to both. Acknowledged with an empty
  > success; a CLI build where this is not yet enabled acknowledges and keeps generating, and an older
  > CLI answers an unknown-subtype error."

  SDK wrapper 暴露为 `Query.setPromptSuggestionsPaused(paused)`（`sdk.mjs` / `core.mjs`：
  `async setPromptSuggestionsPaused(e){await this.request({subtype:"set_prompt_suggestions_paused",paused:e})}`）。
  本仓目前**没有**调用该方法（grep 无命中）——native 实现无需复刻，除非要做"composer 不在屏就暂停"。

### 2.5 CLI 命令行旗标

`--prompt-suggestions [value]`（choices `true/false/1/0/yes/no/on/off`，preset `"true"`；
`claude.exe @ 265,232,535`）。帮助文本："Enable prompt suggestions. In print/SDK mode, emits a
prompt_suggestion message after each turn with a predicted next user prompt"。校验：必须同时有
`--print` 与 `--output-format=stream-json`，否则报错退出（`claude.exe @ 265,004,321`）。
即 **print 模式默认不生成**，需显式开启；SDK 模式经 initialize 选项开启。

### 2.6 SDK 输出白名单

CLI 的 `-p`/SDK stdout 帧类型白名单中 `prompt_suggestion: true`（允许输出）：
`Un={assistant:!0,user:!0,result:!0,system:!0,stream_event:!0,tool_progress:!0,tool_use_summary:!0,
rate_limit_event:!0,prompt_suggestion:!0,conversation_reset:!0,command_lifecycle:!0,
transcript_mirror:!1,auth_status:!1,…}`（`claude.exe @ 283,943,598`）。SDK wrapper 本身不过滤该类型，
原样 yield 给消费者。

---

## 3. CLI 实现（claude.exe 2.1.311 嵌入 JS）

实现分两条路径，共享同一个生成编排器：

- **SDK / print 路径**：会话循环里的发射器类 `TR`（`claude.exe @ 283,249,203`），由工厂 `RR`
  （`@ 283,251,875`）构造，在 `afterTurn` 回调里触发（§3.1）。
- **交互式 REPL 路径**：`hws`（`@ 263,538,340`）在 stop-hook 阶段结束后触发，生成后走幽灵文本
  展示（§3.7）。
- 两者都调用编排器 `ico`（`@ 263,537,652`）→ 生成 `M`（`@ 263,541,210`）→ fork 执行器
  `Rx`/`vtr`（`@ 256,874,438`）。

### 3.1 触发时机（SDK 路径）

会话循环的回调接线（`claude.exe @ 283,753,017` 附近）：

```js
beforeArm: ({batch:{command:O, members:Q}, input:ce}) => { …; nr.onCommand(O, ce) },
afterTurn: ({batch:O, signal:Q, turnEnd:ce}) => {
  …;
  if (!Or) nr.afterResult(O.command);   // ← 生成触发点
  Mg.route();                            // result 帧路由
  …
},
```

- `nr` 是发射器：`nr = RR({emit:(O)=>kn.enqueue(O), promptSuggestions:()=>x.promptSuggestions,
  shuttingDown:bs, holdsResults:()=>Rg.holdsResults(), messages:y, getAppState:w})`
  （`@ 283,683,128`）。`promptSuggestions` 是**活读**会话选项的闭包，re-initialize 改选项即时生效。
- `Or` 是 refuseStart 标志：`onCommitted` 置 `Or=false`；`Ci.refuseStart` 门槛返回拒绝结果时置
  true（`@ 283,752,286` 附近；`Ci` 的具体归属未逐行追踪，上下文与 ccrRecap/远程会话相关）——
  被拒绝启动的 turn 不生成建议。
- **`afterResult(e)`**（`@ 283,250,097`）的守卫与动作：
  1. `promptSuggestions()` 为 false、`e.shouldQuery === false`（非查询命令，如 `/clear`）、
     正在 shutdown、或 env `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === false` → 直接返回；
  2. abort 上一次仍在飞的生成（每轮至多一条的来源）；
  3. `bR({paused, turnOrigin})` 抑制检查（见下）；
  4. 取 `cacheSafeParams()`（= `tO`，§3.4），取不到 → 遥测 `sdk_no_params` 后返回；
  5. 异步 `generate(...)`，成功后构造帧
     `{type:"prompt_suggestion", suggestion, uuid: randomUUID(), session_id: V()}`；
  6. **若 result 路由正持有 result**（`holdsResults()`，如有后台任务未结束）→ 存入
     `pendingSuggestion`；否则立即 `emit`。
- **帧一定在 result 之后**：result 路由器 `s_` 的 `emitHeldResults()` 在发出所有被持有的 result 后
  调用 `this.emitPendingSuggestion()`（`@ 283,236,422` 附近），接线为
  `emitPendingSuggestion: () => nr.emitPending()`（`@ 283,745,108`）。`emitPending()` 发出
  pending 帧并记录 `lastEmitted`（供接受/忽略遥测）。
- **`onCommand`**（新用户命令入队时，`beforeArm`）：abort 在飞生成、清空 pending；若存在
  `lastEmitted` 且命令是 prompt，把**用户实际发送的文本**与建议文本做大小写不精确比较，
  记 `tengu_prompt_suggestion` 遥测（outcome accepted/ignored + similarity + timeToAcceptMs/
  timeToIgnoreMs，`yws`，`@ 263,545,332` 附近）。
- **中止/清理**：interrupt 路径 `jm()` 调 `nr.discard()`（`@ 283,762,911`）；`end_session` 调
  `nr.discard()`（`@ 283,770,064`）；teardown 调 `nr.settle()`（`@ 283,743,476`）——等待在飞生成
  最多 **30 s**（`cH = 30000`，`@ 283,249,203` 类前）再 abort。
- **turnOrigin 抑制**（`bR`/`lH`，`@ 283,249,203` 前）：`paused` → reason `host_paused`；
  turnOrigin ∈ {`scheduled`, `task_notification`, `auto_continuation`, `host_synthetic`, `system`}
  → reason `not_user_started`。**但两者都只在 GrowthBook 旗标 `tengu_chomp_sable`（默认 false）
  打开时才真正抑制**——默认配置下非用户发起的 turn 也会生成。turnOrigin 读自最后一条 user 消息的
  `turnOrigin` 字段（`B3n`，`@ 259,480,294`）。

**交互式 REPL 路径的触发点**：stop-hook 阶段生成器 `ad`（`@ 263,643,255` 附近）在主 API 循环
`sd` 结束后：

```js
if (kf(y.agentContext) && (S.startsWith("repl_main_thread") || S === "sdk")) mYn(W8(X)); // 重存 post-turn 前缀
if (yield* sd(C, X.messages, n, y, S), !Sr()) {           // !Sr() = 非 subagent
  if (!ms(process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION))
    if (sLt() && kf(y.agentContext)) y.session.promptSuggestion.arm();  // 插件接管展示
    else hws(X, C?.lastResult);                           // ← CLI 生成+展示
  …
}
```

`hws`（`@ 263,538,340`）额外要求 `querySource.startsWith("repl_main_thread")`、终端处于 focused
（blurred → 遥测 `unfocused`/`bg_unattached` 后跳过），然后走同一个 `ico`。

### 3.2 编排器 `ico`：逐轮抑制检查

`ico(e, n, t, o, s, r)`（`@ 263,537,652`；e=abort 包装、n=消息列表、t=getAppState、
o=cacheSafeParams、s=来源 "cli"/"sdk"、r=CLI 的 unused-streak 状态，SDK 路径不传）：

| 顺序 | 检查 | 跳过原因（遥测 reason） |
|---|---|---|
| 1 | `e.signal.aborted` | `aborted` |
| 2 | 对话中 assistant 消息数 `< 2`（`H(n, S=>S.type==="assistant") < 2`） | `early_conversation`（即"首轮抑制"的实现：第一轮只有 1 条 assistant） |
| 3 | 最后一条 assistant 是 API 错误消息（`Iy(n)?.isApiErrorMessage`） | `last_response_error` |
| 4 | `L(getAppState(), cacheSafeParams.toolUseContext.queryTracking?.billedToUsageCredits)`（下表） | 各自 reason |
| 5 | `O(最后一条assistant)` cache-cold 检查（§3.4） | `cache_cold`（附 `cacheColdBy`） |
| 6 | CLI 且 backoff 生效时：`eligibleTurns % 10 !== 0` | `unused_streak`（§3.6） |
| 7 | 调 `N(e, o)` 生成；空结果 | `empty` |
| 8 | `q(suggestion, source)` 内容过滤（§3.5） | 各过滤 reason |

**`L` 逐轮门槛**（`@ 263,537,119`，读 appState）：

```js
function L(e, n) {
  if (!e.promptSuggestionEnabled) return "disabled";                 // 用户设置（appState 投影）
  if (e.pendingWorkerRequest || e.pendingSandboxRequest) return "pending_permission";
  if (e.mcp.clients.some(t => t.type === "connected" && (t.transportErrorState?.pendingElicitations ?? 0) > 0))
    return "elicitation_active";
  if (e.toolPermissionContext.mode === "plan") return "plan_mode";
  { let {status: t, overageInUse: o} = mi(),
        s = t === "allowed_warning" && i.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === true;
    if (t !== "allowed" && !s) return "rate_limit";                  // 接近/达到限额
    if ((n ?? o === true) && j7n()) return "usage_credits"; }
  return null;
}
```

即：权限请求挂起、MCP elicitation 挂起、plan mode、限流（`allowed_warning` 时 env=true 可豁免，
`allowed` 以外一律抑制）都跳过。与 sdk.d.ts 注释和官方文档一致。

### 3.3 生成请求：模型、提示词、参数

**`M(e, n, t)`**（`@ 263,541,210`；e=提示词常量 `I`、n=abort 包装、t=cacheSafeParams）：

```js
let o = async () => ({behavior: "deny", message: "No tools needed for suggestion",
                      decisionReason: {type: "other", reason: "suggestion only"}}),
    s = await Rx({promptMessages: [Oe({content: e})], cacheSafeParams: t, canUseTool: o,
                  querySource: "prompt_suggestion", forkLabel: "prompt_suggestion",
                  overrides: {abortController: n}, skipTranscript: true, skipCacheWrite: true}),
    …
// 收集所有非错误 assistant 消息里的 text block 作为 candidates；
// generationRequestId = 第一条 assistant 消息的 requestId
```

**`Rx` = `runForkedAgent`（`vtr`，`@ 256,874,438/504`）** 的关键行为：

- 请求消息 = `[...cacheSafeParams.forkContextMessages, ...promptMessages]`——**完整父对话前缀 +
  一条普通 user 消息**（`Oe({content: I})`，无 isMeta 标记）。
- `systemPrompt` / `userContext` / `systemContext` / `toolUseContext` 全部继承 cacheSafeParams；
  **工具表不变**（overrides 只给了 abortController，没改 options.tools）——工具定义仍随请求发送
  （保持 cache 前缀一致），只是 `canUseTool` 对任何工具调用返回 deny。
- `maxTurns: L ?? Wtn`，`Wtn = 50`（`@ 256,863,902`）——suggestion 调用不传 maxTurns，
  落到默认 50；实际因 deny-all + 提示词约束，一轮即止。
- `maxOutputTokensOverride: w`——suggestion 调用**不传**，即无建议专用输出上限，走会话/模型常规
  输出预算。**[推断：未找到任何按 querySource 区分 maxTokens 的代码（对
  `querySource==="prompt_suggestion"` 与 maxTokens/haiku 组合的全文搜索均无命中）；输出规模靠提示词
  "2-12 words" 与 §3.5 过滤约束。]**
- `skipCacheWrite: true` 透传给 runQuery——fork **不写新的 cache 断点**；`skipTranscript: true`——
  fork 的消息**不写 transcript**（`Yn = ke ? void 0 : F_(y)`，transcript 记录器整个不创建）。
- **模型**：`cacheSafeParams.model` 若存在则覆盖 mainLoopModel；suggestion 路径的 cacheSafeParams
  由 `W8` 构造（`@ 256,865,888`）：`{systemPrompt, userContext, systemContext, toolUseContext,
  forkContextMessages: e.messages, advisorModel, stickyBetas}`——**不含 model 字段**，因此用会话
  当前主模型。`tO`（`@ 256,865,108`）在会话模型已切换时把 `mainLoopModel` 补丁为当前模型。
  官方文档明文佐证："a short background request to **the same model your session is using**"（§5）。
- **thinking**：未找到 suggestion 专用的 thinking 禁用/裁剪（fork 的 `thinkingStripPlan` 传
  undefined；请求路径的 `Scr` 只是清洗 `{type:'disabled'}` 的多余键，`@ 257,281,169`）。
  **[推断：fork 继承会话的 thinking 配置；thinking 开启的会话，建议请求可能产生 thinking token
  成本。未能逐行追踪 runQuery 的 thinking 装配，此点标注为推断。]**
- querySource `prompt_suggestion` 的其它待遇：属于集合
  `{prompt_suggestion, away_summary, agent_summary, hook_prompt}`（`j2e`，`@ 254,347,103`），
  该集合**不触发 auto-compaction**（`Isr`：`if (j2e(s)) return false`，`@ 257,087,969`）、
  不参与 prompt-too-long 的 precomputed-swap 恢复（`fYn`，`@ 256,779,282`）；也属于 memory-recall
  排除集合 `$wr`（`@ 257,969,702`）——建议请求不召回记忆。

**提示词常量 `I` 全文**（`@ 263,539,803`，逐字恢复；原文为模板字符串，`→`/`—` 为原文
`→`/`—` 转义）：

```text
[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Claude offers options → suggest the one the user would likely pick, based on conversation
Claude asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate — including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security or cybersecurity work, do not predict potentially unsafe actions.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.
```

**候选归一化 `W`**（`@ 263,541,210` 后）：trim；剥掉整段 `<suggestion>…</suggestion>` /
`<response>` / `<output>` / `<answer>` / `<result>` 包裹；剥掉行首标签
`suggested response/reply/input/prompt`、`suggestion:`、`response:`、`reply:`、`answer:`、
`output:`、`result:` 及 CJK 标签 **提案/回答/返信/応答/出力/結果/建議/回復/答案/輸出/結果**、
韩文 **제안/답변/응답/출력/결과**（后跟 `:` 或 `：`）。`N`（`@ 263,542,525` 附近）按顺序取第一个
归一化后非空的候选；全空 → suggestion=null（遥测 `empty`）。

### 3.4 cache / 成本策略："nearly free" 的验证

cacheSafeParams 的存取链（fork 模块，`@ 256,864,465`–`256,865,888`）：

- `mYn(params)` 保存快照 + `savedAt = Date.now()` + 当时会话模型；主线程请求发起时存一次
  （`Zs` 生成器，`@ 263,636,999` 附近），stop-hook 阶段用 **post-turn 完整消息**重存
  （`ad`，`@ 263,643,255`）；compaction 重写对话后 `vUt` 更新 `forkContextMessages`
  （`@ 256,864,843` 定义；调用点如 `@ 276,772,135`）。
- `tO()` 读取快照；会话模型变了则补丁 mainLoopModel；无快照/会话不匹配 → null。

**SDK 路径的 cache-warm 门槛 `zln`**（`@ 256,865,364`）：

```js
function zln(e = Date.now()) {
  let {last: n} = Vq();
  if (n.savedAt === null || !Ytn()) return false;
  let r = RJ();                       // requestJournal.lastMainThreadCacheTtlMs()
  if (r === null) return false;
  let s = Math.max(n.savedAt, Xxt() ?? -Infinity);  // Xxt = lastMainThreadCacheRenewedAt()
  return e - s < r * 0.9;             // 距上次主线程请求/cache 续期 < TTL × 0.9
}
```

`RJ`/`Xxt` 是 requestJournal 的访问器（`@ 245,047,219` 附近）：TTL 与续期时间来自**父请求实际
使用的 cache TTL**（5m / 1h ephemeral）。不满足 → 遥测 `cache_cold`（`cacheColdBy:
"prefix_not_warm"`），**不发请求**。`RR` 工厂的 generate 包装（`@ 283,251,875`）：

```js
generate: (s, h) => {
  if (!zln()) return FL("cache_cold", "sdk", {cacheColdBy: "prefix_not_warm"}), Promise.resolve(null);
  return ico(s, e, n, h, "sdk");
}
```

**编排器内的第二道 cache 检查 `O`**（`@ 263,539,560/570`，阈值 `P = 1e4` = 10,000 token）：

```js
function O(e) {                       // e = 最后一条 assistant 消息
  if (!e) return null;
  let n = e.message.usage,
      t = (n.input_tokens ?? 0) + (n.output_tokens ?? 0);
  if (t > P) return "uncached";       // 上轮 uncached 输入+输出 > 10K → 跳过
  let o = n.cache_creation_input_tokens ?? 0;
  if (t + o <= P) return null;        // 总量小 → 放行
  return E("tengu_chomp_thaw", false) ? null : "cache_write";  // 上轮大量 cache 写入 → 跳过（旗标可豁免）
}
```

**[推断：`O` 的意图是用上轮 usage 估算 fork 要新读的 uncached 内容——父请求最后一个 cache 断点
之后的内容（含上轮 assistant 输出）对 fork 是 uncached 输入；超过 10K 就不值得生成。"cache_write"
分支抑制刚发生大量 cache 写入的场景（此时前缀刚变化，cache 可能尚不可读）；未找到注释说明，意图为
推断。]**

**结论（对本仓 `claude-provider.ts:480-482` 注释的验证）**："nearly free (piggybacks on prompt
cache)" 与 SDK d.ts 措辞一致，且被 CLI 实现强制——**cache 冷时根本不生成**。但精确说法应照官方
文档：请求**计入用量限额/API 成本**，warm 时主要是 cache read（0.1× 价）+ 建议提示词本身
（约 300 token 量级 **[推断：按 §3.3 提示词长度估算]**）+ ≤10K 的 uncached 尾部 + 少量主模型输出
token；thinking 开启时还可能含 thinking token（§3.3 推断）。**不是无条件免费，也没有用小模型。**

### 3.5 内容过滤 `q`（多语言）

`q(e, n)`（`@ 263,542,670`）按序检查，命中即丢弃并记遥测 reason：

| reason | 规则（ essence ） |
|---|---|
| `empty` | 空串 |
| `done` | 整句等于 "done"，或 CJK"完成"类：`完了(しました)?` / `完成了?` / `완료됨?`（允许首尾非字母字符） |
| `meta_text` | "nothing found(.)"、以 "nothing to suggest"/"no suggestion" 开头、"silence is"/"stay(s/ing) silent"、整句 silence；CJK：沉默/沈黙/静默/침묵、提案なし/提案はありません、特になし/特にありません、[无没沒]有?建[议議]、(제안\|해당) 없음 |
| `meta_wrapped` | 整段被 `()`/`[]`/全角（）［］【】〔〕 包裹 |
| `error_message` | 以 "api error:"/"prompt is too long"/"request timed out"/"invalid api key"/"image was too large" 开头 |
| `prefixed_label` | `/^\w+:\s/`（带标签前缀） |
| `too_few_words` | 词数 < 2；豁免：以 `/` 开头（slash 命令）、CJK 按字符数（≥2）、单词白名单 yes/yeah/yep/yea/yup/sure/ok/okay/push/commit/deploy/stop/continue/check/exit/quit/no |
| `too_many_words` | 词数 > 12 |
| `too_long` | 长度 ≥ 100 字符 |
| `multiple_sentences` | `/[.!?]\s+[A-Z]/` 或 CJK 句读 `[。！？]\s*[\p{L}\p{N}]` |
| `has_formatting` | 含换行或 `*`（含 `**`） |
| `evaluative` | thanks/thank you/looks good/sounds good/that works/that worked/that's all/nice/great/perfect/makes sense/awesome/excellent；CJK：ありがとう(ございます/ました)?/助かりました/谢谢[你您]?/感謝…/감사합니다/고마워/良さそう/よさそう/いいですね/看起来不错/太好了/完美/完美/좋네요 |
| `claude_voice` | 以 let me/i'll/i've/i'm/i can/i would/i think/i notice/here's/here is/here are/that's/this is/this will/you can/you should/you could/sure,/of course/certainly/让我(?!们)/我来/我会/我将 开头 |

**CJK 过滤是内建的核心部分**（中/日/韩三语覆盖），不是边缘补丁——与本仓"CJK 是核心"的约定一致，
native 移植时应整套保留。

### 3.6 失败处理、遥测与 CLI 侧 backoff

- **失败处理**（`TR.afterResult` 与 `hws` 的 catch）：`AbortError`/`APIUserAbortError` → 遥测
  `aborted` 后静默返回；其它异常 → 仅日志（`l(F(y))`）/CLI 侧记 `prompt_suggestion_generate`
  api_error 事件。**不发错误帧、不重试、不影响主 turn**。生成空/被过滤 → 同样静默（只有遥测）。
- **遥测**：`tengu_prompt_suggestion`（outcome accepted/ignored/suppressed + reason + source
  cli/sdk/fleetview_peek + acceptMethod tab/enter + timeToAcceptMs/timeToIgnoreMs + similarity +
  generationRequestId）、`tengu_prompt_suggestion_init`（enabled + source env/growthbook/
  non_interactive/swarm_teammate/setting）、`prompt_suggestion_generate`、
  `tengu_fork_agent_query`（forkLabel/querySource/cacheHitRate/durationMs，`Rtr`，`@ 256,874,438`
  后）。**系列标签不含 session id**（与本仓 metrics 约定同形）。
- **unused-streak backoff（仅 CLI 交互路径）**（`@ 263,527,705` 附近）：常量 `r = 20`（连续忽略
  阈值）、`CIs = 10`（backoff 后每 10 个合格 turn 才尝试一次）、`_ = 1209600000`（14 天，账号
  firstStartTime 门槛）。`gAr()` 生效条件：streak ≥ 20 且 env ≠ true 且账号年龄 ≥ 14 天。
  提示文案："Showing fewer prompt suggestions · use one to bring them back"。接受一条即清零
  （`nnn`/`RIs`）。**SDK 路径不传 streak 参数（`ico` 第 6 参 undefined）→ 无 backoff**。
  native 实现可省略这套（宿主是 GUI，不是终端幽灵文本）。

### 3.7 CLI 交互式 UX（对照参考）

- 建议以**幽灵文本**显示在空 composer 里；状态机 generated → shown → accepted/empty
  （`@ 281,119,689` 附近的 hook：`markShown`/`markAccepted`/`logOutcomeAtSubmission`）。
- 接受方式：**Tab 或右方向键**填入输入框，Enter 发送；开始打字即消失（官方文档 §5；遥测
  acceptMethod tab/enter 佐证）。
- 终端 blurred 不生成/不展示（`hws` 的 focus 检查）；插件接管 composer 时让位（`plugin_owns`）。
- 本仓 CRW 的对应 UX 是 **placeholder + 裸 Tab 填充**（`src/components/Composer.tsx:182-185`），
  语义等价。

### 3.8 初始化门槛 `RLn`（CLI 交互模式为何默认关）

`RLn()`（`@ 263,536,346`）按序：

1. env `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === false` → off（source env）；
2. env `=== true` → on（source env）；
3. GrowthBook 旗标 **`tengu_chomp_inflection`（默认 false）** 未开 → off（source growthbook）；
4. 非交互会话 → off（source non_interactive）；
5. swarm teammate → off（source swarm_teammate）；
6. 用户设置 `promptSuggestionEnabled !== false` → 按设置（source setting）。

另有 `ALn()`（同模块）：env 有值取 env，否则取设置——不含 growthbook 检查。
**SDK/print 路径不走 `RLn`**：由 initialize 选项 / `--prompt-suggestions` 旗标直接控制
（§2.4/§2.5），`afterResult` 只额外检查 env ≠ false。官方文档"交互模式默认关、print 模式需显式
开启"与此一致（§5）。

---

## 4. 帧形状与投递合同（汇总）

```jsonc
// CLI → SDK stdout（stream-json），每轮至多一条，位于 result 之后
{ "type": "prompt_suggestion",
  "suggestion": "run the tests",     // 已过 §3.5 过滤，2-12 词，<100 字符
  "uuid": "<fresh randomUUID>",      // 不是 fork 消息的 uuid
  "session_id": "<current session>" }
```

- 消费者必须在 `result` 之后继续迭代流（sdk.d.ts:2107-2108）。
- 无建议的 turn **不发帧**（抑制/空/过滤都是静默 + 遥测）。
- 帧不进 transcript（fork skipTranscript；SDK 侧也不写入会话历史）。
- 运行时暂停：`set_prompt_suggestions_paused` 控制请求（§2.4），进程内布尔，respawn/resume 复位。

---

## 5. 官方文档佐证

- **Agent SDK TypeScript 参考**（<https://code.claude.com/docs/en/agent-sdk/typescript>，
  经 docs.claude.com → platform.claude.com 重定向到达；Options 表）：

  > `promptSuggestions` | `boolean` | `false` | Enable prompt suggestions. After a turn, Claude Code
  > emits a `prompt_suggestion` message carrying a predicted next user prompt. Claude Code generates
  > no suggestion for some turns, such as while your account is close to or at its usage limit.

  注意文档标注**默认 false**——本仓 `claude-provider.ts:482` 的 `?? true` 是 CRW 自己的产品默认，
  不是 SDK 默认。
- **Interactive mode**（<https://code.claude.com/docs/en/interactive-mode>，"Prompt suggestions" /
  "When Claude Code skips suggestions" 节）：
  - UX："Press `Tab` or `Right arrow` to place the suggestion in the prompt input, then `Enter` to
    submit. Start typing to dismiss it."
  - **成本与模型（最关键引文）**："Claude Code generates each of these next-prompt suggestions with
    a short background request to **the same model your session is using**. The request **counts
    toward your plan's usage limits or your API costs**. Because it reuses the conversation's prompt
    cache, it is mostly cache reads plus a few output tokens, so the added cost is small."
  - 跳过条件：cache 冷（"to avoid unnecessary cost"）、首轮（部分会话）、上轮出错、plan mode、
    接近/达到用量限额（env=true 可豁免"接近"分支；v2.1.238 前 env=true 也被跳过）、agent team
    的 teammate 会话。
  - backoff 提示文案与恢复方式（用一条建议或 env=true）与 §3.6 代码一致。
  - print 模式："Pass `--prompt-suggestions` with `-p \"<prompt>\" --output-format stream-json
    --verbose` … The generator skips very short conversations and cold prompt caches here too, so a
    single short `-p` query can emit none."
  - 关闭方式：`/config` 开关、settings `promptSuggestionEnabled: false`、env
    `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`（env 优先）；组织级用 managed settings + managed
    env 双关。
  - 交互模式默认关、第三方 provider/网关会话（不拉 feature flag）隐藏 `/config` 开关——与 §3.8
    的 growthbook 门槛一致。

---

## 6. 对 CRW native provider 的对照与实现要点（分析，非 CLI 事实）

> 本节是本仓视角的分析。CRW 侧引用均为本仓源码（已读）；CLI 侧引用见上文各节。

### 6.1 消费侧合同：已就绪，零改动

native 只要经 handle 的 `messages` 流发出 SDK 形状的 `prompt_suggestion` 消息，下游全通：

- `AgentMessage = SDKMessage`（`server/agent-message.ts:6`），`SDKPromptSuggestionMessage` 在联合内。
- pump 早续（early-continue）：`server/session-pump.ts:1468-1479`——不进 history ring、不进消息
  广播，写 `session.lastPromptSuggestion` 并推给 `promptSuggestionSubscribers`。
- frame-bridge 专设 psug 通道：订阅时以 `lastPromptSuggestion` 快照种子
  （`server/frame-bridge.ts:947,988-989`），live 帧 `@ 1205`；WS 帧
  `WsPromptSuggestion {kind:'prompt-suggestion', sessionId, suggestion}`
  （`shared/ws-protocol.ts:432-439`，注释明确 ephemeral、重连不重放旧建议）。
- client：`mirror.promptSuggestion`（`src/session-store/types.ts:495-497`，发送新消息或清
  transcript 时清除；reducer `src/session-store/reducer.ts:97`）→ `Chat.tsx:747,2519` →
  Composer placeholder + 裸 Tab 填充（`src/components/Composer.tsx:182-185`）。
- 选项已存在：`ProviderSessionOptions.promptSuggestions`（`server/providers/types.ts:117-119`），
  目前仅 claude provider 读取（`claude-provider.ts:480-482`）。
- 缺口声明：`server/providers/native-host-frame-adapter.ts:39-42`（R6 scope）明列
  `prompt_suggestion` 为"claude-only、native 无投影"——实现时需在 core 增加中性发射 + adapter
  投影（或 adapter 侧 turn-end 合成），并更新该注释。

### 6.2 生成请求的可复刻配方

对照 CLI（§3.3）与 native 现有设施：

| 维度 | CLI 事实 | native 对应 |
|---|---|---|
| 触发 | turn 的 result 之后（afterTurn → afterResult）；shouldQuery=false 不触发 | native loop 在 terminal result 帧后（`loop.ts` 的 emitTerminalResult 路径）；adapter 持 lease/abort |
| 模型 | 会话主模型（cacheSafeParams 无 model 覆盖） | 当前路由模型（`NativeModelContextResolver` 同路由） |
| 请求内容 | system + tools + 完整消息前缀 + 末尾一条 user 提示词（§3.3 全文可逐字复用） | neutral model history 经 wire-projection 投影 + 追加一条 neutral user message；**不得 append 进 v3 log**（skipTranscript 等价） |
| 工具 | 工具表照发（cache 前缀一致），canUseTool 全 deny | 请求保留相同 tools 定义；不执行任何 tool_use（或 deny 后终止）；提示词本身要求纯文本 |
| cache | 父请求断点可 cache_read；fork `skipCacheWrite` 不写新断点 | `buildRequestBody`（`server/providers/native/anthropic-stream.ts:112-168`）已在 system / 最后一个 tool / 最后一条消息末块打 `cache_control: ephemeral`。**fork 请求必须保持 system/tools/messages 前缀逐字节一致到最后断点**，建议 user 消息追加在断点之后；fork 自身不打新断点（否则建议提示词会触发 cache_write 1.25×） |
| 输出预算 | 无专用 max_tokens（常规预算）；提示词 + 过滤约束规模 | native `StreamRequest.maxTokens` 必填——需自选；**[分析：CLI 不设上限，但 native 可设小值省成本；若继承 thinking 配置，max_tokens 必须大于 thinking budget（本仓 generateTitle 刚因同类问题把 64 提到 1024，commit f79dee9b）]** |
| thinking | 未找到专用禁用 **[推断：继承会话配置]** | native `buildRequestBody:126-128` 按模型门控 thinking；实现者可**选择对建议请求禁用 thinking**（偏离 CLI 但更省，属产品决策） |
| 历史 mutation | fork 不改父对话 | native loop 跨 turn 复用 history（anthropic-stream.ts:110-111 注释）；`buildRequestBody` 已保证不改 caller 对象 |

### 6.3 成本控制：移植抑制链，而不是换小模型

CLI 的"便宜"来自**抑制 + cache piggyback**（§3.4），native 应移植：

1. **cache-warm 门槛**（`zln` 等价）：距上次主请求 < 实际 cache TTL × 0.9 才生成。native 目前
   未记录 cache TTL/续期时间——需新增一个 per-session 的"最后主请求时间 + TTL"槽位（TTL 固定
   5m ephemeral 即可起步 **[分析]**）。
2. **uncached 尾部阈值**（`O` 等价）：上轮 usage 的 input+output > 10K token → 跳过；
   cache_creation 大量写入 → 跳过。native 的 usage 已在 neutral 词汇里（`Usage`），可直接读。
3. **逐轮抑制**（`L` + `ico` 等价）：首轮（assistant < 2）、上轮 API 错误、plan mode、权限/
   elicitation 挂起、限流接近/达到。native 无 GrowthBook，`tengu_chomp_*` 旗标分支全部省略
   （默认值即关闭那些豁免/抑制）。
4. **内容过滤**（`q` + `W`）：整套移植，含 CJK/韩文规则（§3.5）——这是产出质量的护栏，不是可选项。
5. **失败合同**：静默跳过 + 日志（走 `createLogger`），不重试、不发错误帧、不影响主 turn；
   新命令/interrupt/shutdown 时 abort 在飞生成；teardown 等待上限 30 s（`cH`）。

### 6.4 可省略 / 需决策的部分

- **CLI-only**：unused-streak backoff（§3.6）、终端 focus 门槛、幽灵文本状态机、swarm teammate
  抑制、growthbook 初始化门槛——native 宿主是 GUI，均不适用。
- **宿主可选**：`set_prompt_suggestions_paused` 等价（composer 不在屏暂停）——CRW 的 keep-alive
  面板模型下有价值，但非首期必需。
- **产品决策**：默认开/关（CRW claude provider 默认开；SDK 文档默认 false）；建议请求是否禁用
  thinking；max_tokens 取值；是否给 native 也做"接受/忽略"遥测（CLI 用发送文本与建议文本的精确
  匹配判 accepted，§3.1 onCommand）。
- **已知差异风险**：native 的 cache 断点布局（system + 末 tool + 末消息末块）与 CLI 的断点布局
  不同，但 piggyback 原理相同——只要 fork 前缀与父请求一致即可 cache_read；**若 native 主请求
  与 fork 请求之间发生了 compact/模型切换，前缀失效，应走 cache-cold 抑制**（CLI 用
  `Ytn()`/会话模型比对处理同类情形，§3.4）。

---

## 7. 关键文件索引

| 关注点 | 位置 |
|---|---|
| DSH 缺席证据 | `packages/experimental/claude-code-mods/src/matcher.ts:1-6,13`；`packages/core/agent/README.md:58`；`packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts:334`；`packages/experimental/plugin-recommendations/package.json`（description） |
| SDK 选项语义合同 | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2102-2118` |
| SDK 消息类型 / 联合 | 同上 `:5888-5896` / `:5587` |
| SDK 设置键 / initialize 选项 | 同上 `:9373-9376` / `:4676,4742` |
| SDK wrapper 透传 / 暂停方法 | `sdk.mjs`（`promptSuggestions:this.initConfig?.promptSuggestions`；`setPromptSuggestionsPaused`）；`core.mjs` 同 |
| CLI 版本 / 二进制 | `manifest.json`（2.1.311 / commit e7d3b836 / 2026-10-26）；`claude-agent-sdk-win32-x64/claude.exe` |
| CLI 初始化门槛 RLn / ALn | `claude.exe @ 263,536,346`（RLn）；同模块 ALn |
| CLI 逐轮门槛 L | `claude.exe @ 263,537,119` |
| CLI 编排器 ico / cache 检查 O | `claude.exe @ 263,537,652` / `@ 263,539,560-570`（P=1e4） |
| CLI 提示词常量 I（全文） | `claude.exe @ 263,539,803` |
| CLI 生成 M / 归一化 W / 候选 N | `claude.exe @ 263,541,210` / 同窗 / `@ 263,542,525` 附近 |
| CLI 内容过滤 q（多语言） | `claude.exe @ 263,542,670` |
| CLI fork 执行器 Rx/vtr | `claude.exe @ 256,874,438`（Wtn=50 默认 maxTurns） |
| cacheSafeParams 存取 mYn/tO/W8/vUt | `claude.exe @ 256,864,465 / 256,865,108 / 256,865,888 / 256,864,843` |
| cache-warm 门槛 zln / TTL 访问器 | `claude.exe @ 256,865,364` / `@ 245,047,219`（RJ/Xxt） |
| querySource 排除集合 j2e / Isr / $wr | `claude.exe @ 254,347,103 / 257,087,969 / 257,969,702` |
| SDK 发射器类 TR / afterResult / 工厂 RR | `claude.exe @ 283,249,203 / 283,250,097 / 283,251,875` |
| 发射器接线 nr=RR / emitPendingSuggestion | `claude.exe @ 283,683,128 / 283,745,108` |
| 触发回调 beforeArm/afterTurn / refuseStart | `claude.exe @ 283,753,017 / 283,752,286` 附近 |
| settle/discard（teardown/interrupt/end_session） | `claude.exe @ 283,743,476 / 283,762,911 / 283,770,064`（cH=30000） |
| initialize 选项写入 / re-init opt-in / Qy | `claude.exe @ 283,872,758 / 283,870,292 / 245,708,820` |
| 暂停控制请求 schema（describe 全文） | `claude.exe @ 247,777,443` |
| prompt_suggestion zod schema / stdout 白名单 | `claude.exe @ 247,569,303 / 283,943,598` |
| CLI 旗标 --prompt-suggestions / 校验 | `claude.exe @ 265,232,535 / 265,004,321` |
| CLI 交互触发 ad / hws / focus 门槛 | `claude.exe @ 263,643,255 / 263,538,340` |
| CLI backoff 常量 / 文案 | `claude.exe @ 263,527,705`（r=20, CIs=10, 14 天） |
| CLI 幽灵文本状态机 / 接受遥测 | `claude.exe @ 281,119,689` 附近；`yws` @ 263,545,332 附近 |
| 官方文档 | <https://code.claude.com/docs/en/agent-sdk/typescript>（Options 表）；<https://code.claude.com/docs/en/interactive-mode>（Prompt suggestions / When Claude Code skips suggestions） |
| CRW claude provider 默认开 | `server/providers/claude/claude-provider.ts:480-482` |
| CRW pump 早续 / psug 通道 / WS 帧 | `server/session-pump.ts:1468-1479`；`server/frame-bridge.ts:947,988-989,1205`；`shared/ws-protocol.ts:432-439` |
| CRW client 状态 / UX | `src/session-store/types.ts:495-497`；`reducer.ts:97`；`src/components/Composer.tsx:182-185`；`Chat.tsx:747,2519` |
| CRW native 缺口 / 消息类型 / 选项 | `server/providers/native-host-frame-adapter.ts:39-42`；`server/agent-message.ts:6`；`server/providers/types.ts:117-119` |
| CRW native cache 断点 | `server/providers/native/anthropic-stream.ts:112-168`（buildRequestBody） |