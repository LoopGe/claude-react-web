# Claude CLI Hook 执行语义调研（native hook engine 设计的一手依据）

> 2026-11-26。背景：为 `native` provider 设计 hook engine，要求与 `claude` provider（真实 CLI 子进程）
> **行为完全一致**——同一份 hooks 配置在两个 provider 上必须同义。本文查清 CLI 的**真实** hook 执行语义
> （输出契约、逐事件输入/决策、matcher/if/once/async/timeout/env/shell、与权限系统的先后、prompt/agent/http
> 类型的求值方式、settings 门禁），并给出 native 现有代码的逐事件触发缝盘点（layer-1/layer-2 划分）。
> **CLI 的实际行为是规格**，不是 `shared/hooks.ts` 的注释，也不是我们的近似。
>
> **版本记录**（只读调查，未修改任何被调查包/二进制）：
> - SDK pin **0.3.311**，内嵌 CLI **2.1.311**（`node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`
>   `"version":"2.1.311"`，`package.json` `claudeCodeVersion:"2.1.311"`）。
> - 类型契约：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（下文行号均指此文件）。
> - SDK 运行时：同目录 `sdk.mjs` / `core.mjs`。
> - **CLI 二进制**：`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`
>   （Bun 编译原生二进制，内嵌 minified JS，`rg -a` 直接搜；zod `describe` 字符串与内嵌文档完整保留）。
>   CRW 经 `pathToClaudeCodeExecutable` 解析到它（`server/providers/claude/claude-provider.ts:677,907`，
>   `--claude-binary` 覆盖）。minified 函数名跨 chunk 撞名，**引用时以函数体为准**，下文给出复现 grep。
> - 官方文档核对：https://code.claude.com/docs/en/hooks-reference.md（2026-11-26 抓取，仅用于交叉验证
>   timeout 默认值与 once 作用域，**不作为行为规格**；与二进制一致处注明）。
>
> **验证级别标记**（每条结论都带）：
> - `[type-contract]`：sdk.d.ts 明文声明（行号）。
> - `[source-verified]`：在 SDK/CLI 运行时源码中读到（给出符号/函数体 + 复现命令）。
> - `[live-probed-prior]`：本仓既有的 live 实测记录（注明出处，本次未重跑）。
> - `[doc-verified]`：官方文档明文，且与二进制证据一致。
> - `[unverified — needs probe]`：源码未能定论，说明需要什么实测。
> - `[analysis]`：本文的推断/设计对照，不是 CLI 事实。

---

## 0. 一句话结论（TL;DR）

**CLI hook 是一个"stdin 收事件 JSON → stdout 回决策 JSON（或 plain text）→ exit code 定阻断"的进程契约，
叠加 matcher（工具名/字面列表/非锚定正则）、`if`（权限规则语法，仅工具事件）、`once`（仅 skill frontmatter，
成功后从会话注册表移除）、async/asyncRewake（后台跑，exit 2 经通知队列唤醒模型）、逐事件不同的 exit-2 语义。
PreToolUse hook 先于权限系统跑，其 allow/deny 短路 canUseTool，ask 才进权限询问。native 现有 13 个事件有
无条件触发缝，4 个（SessionEnd/ConfigChange/TaskCreated/TaskCompleted）有缝但语义需产品裁决，10 个无机制。**

设计最关键的几条：

1. **输出契约**：`SyncHookJSONOutput`（continue/suppressOutput/stopReason/decision/reason/systemMessage/
   terminalSequence/hookSpecificOutput）+ `AsyncHookJSONOutput`（`{async:true, asyncTimeout?}`）。stdout 以 `{`
   开头才尝试 JSON 解析，否则 plain text；JSON 非法/校验失败 → 降级 plain text + 报错（不是崩溃）。
   exit 0 正常、**exit 2 阻断**（逐事件语义不同）、其他码非阻断错误。JSON 阻断 reason 压过 stderr；
   exit 2 压过 `permissionDecision:"allow"`；Stop 上 `continue:false` 压过 exit 2。§2。
2. **PreToolUse vs 权限**：PreToolUse hook 先跑；allow/deny 直接成为权限决策、**短路 canUseTool**；
   ask（或无决策）才走 canUseTool/权限询问；PermissionRequest hook 在权限请求流程内跑（受 `hooksMayAllow`
   门禁）。`updatedInput` 经校验后替换工具输入。§5。
3. **asyncRewake**：async hook 后台跑，exit 2 时把 stderr/stdout 包成通知 `enqueuePendingNotification`
   （summary 默认 "Stop hook feedback"，priority "next"，stopHookActive:true）唤醒模型——不是直接续跑当前回合。§4.4。
4. **prompt/agent 默认模型**：都是 `Mb()` = `ANTHROPIC_SMALL_FAST_MODEL` 否则 Haiku 类小快模型；
   prompt 是单轮无工具 LLM（json_schema `{ok,reason,impossible?}`，30s），agent 是带会话工具+裁决工具的
   agentic loop（≤50 轮，60s，gateway 无 haiku env 时回退会话模型）。§6。
5. **timeout 默认**：command/http/mcp_tool **600s**、prompt **30s**、agent **60s**；UserPromptSubmit/
   PreModelSwitch/PostModelSwitch 降到 30s、MessageDisplay 10s、SessionEnd 共享 1.5s（上限 60s）。
   `once` **仅 skill frontmatter 生效，settings/agent hooks 忽略**——CRW 经 `Options.settings.hooks` 传的
   用户 hooks 里 `once` 在 claude 侧本就是 inert 的。§4.3/§4.5。
6. **native 划分**：13 个无条件 layer-1（PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/Stop/
   StopFailure/SessionStart/SubagentStart/SubagentStop/PreCompact/PostCompact/PermissionRequest/
   PermissionDenied）；SessionEnd/ConfigChange/TaskCreated/TaskCompleted 有缝但语义错位需裁决；
   其余 10 个无机制（layer-2）。§9。

---

## 1. 方法与源映射

| 源 | 路径 | 用途 |
|---|---|---|
| SDK 类型 | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | 逐事件 stdin/决策 schema、Options.hooks、settings 门禁字段 |
| SDK 运行时 | 同目录 `sdk.mjs` / `core.mjs` | callback 注册/编号/响应包装 |
| CLI 二进制 | `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` | hook runner 全部执行语义（minified，`rg -a -o` 取证） |
| 配置契约 | `shared/hooks.ts` | app 接受的 27 事件 / 4 类型 / 字段 |
| native 代码 | `server/providers/native/` | 触发缝盘点 |
| 既有实测 | `server/providers/claude/inprocess-hooks.ts:139-159` 注释、`.agents/notes/implemented/bug-fix/2026-11-24-hook-noop-output-object.md` | SDK 栈下哪些事件不触发、`{}` 契约 |

二进制取证手法（沿用 `2026-11-25-claude-cli-auto-compact.md` 的约定）：`rg -a -o '<锚点>.{0,N}' claude.exe`；
多行内嵌文档用 `rg -a -U -o '(?s)…'`。minified 名撞名严重（如 `nP`/`Wvn`/`uS`/`Hsr` 各有多个无关同名函数），
下文每个符号都附函数体特征以便辨认。完整复现命令索引见 §11。

---

## 2. 输出契约（所有 hook 类型共用）

### 2.1 JSON 输出 schema

`SyncHookJSONOutput`（sdk.d.ts:10008-10022）`[type-contract]`：

| 字段 | 类型 | 语义（CLI zod describe 原文，`EL()` schema）`[source-verified]` |
|---|---|---|
| `continue` | boolean? | "Whether Claude should continue after hook (default: true)" |
| `suppressOutput` | boolean? | "Hide stdout from transcript (default: false)" |
| `stopReason` | string? | "Message shown when continue is false" |
| `decision` | `'approve'\|'block'`? | 顶层遗留决策字段（PreToolUse 已弃用，改用 hookSpecificOutput.permissionDecision） |
| `reason` | string? | "Explanation for the decision" |
| `systemMessage` | string? | "Warning message shown to the user" |
| `terminalSequence` | string? | 终端转义序列（仅 OSC 0/1/2/9/99/777 + BEL，其余丢弃） |
| `hookSpecificOutput` | object? | 逐事件决策，**必须带匹配的 `hookEventName`**（§3） |

`AsyncHookJSONOutput`（sdk.d.ts:137-140）：`{async: true, asyncTimeout?: number}`。`[type-contract]`

**wire 上还有两个 d.ts 未声明的字段**：`metrics`、`rewakeSummary`（CLI 校验白名单
`kgo = ["continue","suppressOutput","stopReason","decision","systemMessage","terminalSequence","reason",
"metrics","rewakeSummary","hookSpecificOutput"]`）。`[source-verified]`（`rg -a -o '"reason","metrics","rewakeSummary".{0,120}'`）。
`rewakeSummary` 是 asyncRewake 唤醒时给用户看的一行摘要（§4.4）。

CLI 校验 schema：`Lce = union({async:literal(true), asyncTimeout:number?}, EL())`；`EL()` 即上表。
`hookSpecificOutput` 是 22 个逐事件 schema 的 union。`[source-verified]`
（`rg -a -o 'Lce=p\(\(\)=>.{0,200}'`、`rg -a -o 'EL=p\(\(\)=>u\(\{continue.{0,900}'`）。

### 2.2 stdout 解析：JSON vs plain text

`zY(stdout)`（主 runner 的 stdout 解析器）`[source-verified]`（`rg -a -U -o '(?s)function zY\(e\)\{.{0,1500}'`）：

1. trim 后**不以 `{` 开头 → plain text**（log "Hook output does not start with {, treating as plain text"）。
2. 以 `{` 开头且能解析出 `{async:true}` → 识别为 async 应答（`KFr`），hook 转后台。
3. 否则 `Wvn`：`JSON.parse` + `Lce().safeParse`。成功 → 决策 JSON；失败 → **plain text + validationError**
   （log 附 "Expected schema: …"），**不崩溃、不阻断**（除非 onFailure:'block'，§2.4）。
4. `JSON.parse` 抛错时：不以 `}` 结尾 → plain text；是"多个 JSON 文档/JSON lines"（`Avr`）→ plain text；
   否则 → validationError "looks like a JSON object but is not valid JSON — … Emit the payload with a JSON
   encoder (jq, ConvertTo-Json, json.dumps) rather than string concatenation…"。

**plain text 的去处逐事件不同**（§3 表）：UserPromptSubmit/SessionStart 的 exit-0 plain stdout 进模型上下文；
PreToolUse/Stop 的 exit-0 stdout 不展示；PostToolUse 的 exit-0 stdout 仅 transcript 模式（ctrl+o）可见。
`[source-verified]`（内嵌事件目录 `QIt`，§3）。

### 2.3 exit code 契约

CLI 内嵌的逐事件目录 `QIt(event)` 给出每个事件的 exit 语义（`[source-verified]`，
`rg -a -U -o '(?s).{0,3600}Exit code 2 - show stderr to model and block tool call.{0,3600}'`）。通则：

- **exit 0**：成功；stdout 按事件决定展示/进上下文；JSON 决策生效。
- **exit 2**：阻断错误。**阻断消息 = stderr**；若 stdout 同时打印了做出阻断决策的 JSON，**用 JSON 的 reason
  压过 stderr**。`[doc-verified]`（hooks-reference："The message that comes with the block is your hook's
  stderr. If your hook also printed JSON that makes a blocking decision, Claude Code uses that decision's
  reason instead."）逐事件阻断对象见 §3。
- **其他 exit code**：非阻断错误，stderr 仅给用户看，动作照常继续。`[source-verified]`（QIt 各事件
  "Other exit codes - show stderr to user only…"）。
- **exit 2 压过 allow**：即使 JSON 给 `permissionDecision:"allow"`，exit 2 仍阻断。`[doc-verified]`
  （"Even a permissionDecision of 'allow' doesn't let the action through."）
- **Stop/SubagentStop 上 `continue:false` 压过 exit 2**。`[doc-verified]`。
- 非零 exit 的 stderr 会被拼进展示消息：`Iyt(e,n,r)` = `n!==0 && stderr ? `${e}\nHook exited ${n} with
  stderr:\n${stderr}` : e`。`[source-verified]`（`rg -a -o 'function Iyt\(.{0,200}'`）。

### 2.4 onFailure: continue | block

`Pje(hook)`（onFailure 生效谓词）`[source-verified]`（`rg -a -o 'function Pje\(e\)\{switch.{0,250}'`）：

```js
case "command": return hook.onFailure==="block" && hook.async!==true && hook.asyncRewake!==true;
case "http":    return hook.onFailure==="block";
default:        return false;   // prompt / agent / mcp_tool 不支持 onFailure
```

`e0t(hook, result)`：若 `Pje` 为真且结果既非 succeeded/blocked/cancelled → 把结果改写成
`blocked:true, output:"failed; blocking because onFailure is \"block\"…"`（cancelled 特判为 "timed out; …"）。
`[source-verified]`（`rg -a -o 'function e0t\(e,n\)\{if\(!Pje.{0,400}'`）。

即 **onFailure:'block' 把"启动失败/超时/非 0 非 2 退出/非法 JSON"等同于 exit 2**。schema describe 原文：
"Ignored for async hooks and on Stop, SubagentStop, TaskCompleted and TeammateIdle."
`[source-verified]`（`rg -a -o 'What a failure of this hook does.{0,400}'`）。
`shared/hooks.ts:45-53` 的注释与此**一致**。

---

## 3. 逐事件参考表

 stdin 公共字段 `BaseHookInput`（sdk.d.ts:175-201）`[type-contract]`：`session_id`、`transcript_path`、
`cwd`、`prompt_id?`、`permission_mode?`、`agent_id?`（仅子代理内）、`agent_type?`、`effort?{level}`。
CLI 实际构造器 `tf()` 还塞了 **`scratchpad_dir?`**（d.ts 未声明），served/remote 会话 `session_id` 形如
`served:<callerSessionId>`、`transcript_path:""`。`[source-verified]`（`rg -a -o 'function tf\(e,n,r,s\)\{.{0,700}'`）。

matcher 目标映射 `qZe(input)`（`[source-verified]`，`rg -a -o 'function qZe\(e\)\{switch.{0,1200}'`）：
工具五事件→`tool_name`；UserPromptExpansion→`command_name`；SessionStart→`source`；Setup→`trigger`；
Pre/PostCompact→`trigger`；Pre/PostModelSwitch→`to_model`（规范化）；Notification→`notification_type`；
SessionEnd→`reason`；StopFailure→`error`；SubagentStart/Stop→`agent_type`；Elicitation/ElicitationResult→
`mcp_server_name`；ConfigChange/DirectoryAdded→`source`；InstructionsLoaded→`load_reason`；
FileChanged→文件名（`WZe(file_path)`）；**TeammateIdle/TaskCreated/TaskCompleted/Stop/UserPromptSubmit/
WorktreeCreate/WorktreeRemove/CwdChanged/MessageDisplay/PostToolBatch → 无 matcher 目标**。
matcher 有意义的事件集 `Hee`（21 个，含上述有目标者；FileChanged 单独走 watch 列表，不在 Hee）。

下表"exit 2"列引自 CLI 内嵌目录 `QIt`（`[source-verified]`）；"specific output"引自 sdk.d.ts
（`[type-contract]`）；"native 缝"见 §9（行号已自验）。

| 事件 | stdin 事件字段（d.ts 行） | hookSpecificOutput 可决策 | matcher | exit 2 语义 | native 缝 |
|---|---|---|---|---|---|
| **PreToolUse** | tool_name/tool_input/tool_use_id/mcp_server?（2812-2818） | permissionDecision(allow/deny/ask/defer)/permissionDecisionReason/updatedInput/additionalContext（2820-2827） | tool_name | 阻断工具调用，stderr 给模型 | ✅ loop.ts:205-217 |
| **PostToolUse** | tool_name/tool_input/tool_response/tool_use_id/duration_ms?/mcp_server?（2729-2740） | additionalContext/classifierContext/updatedToolOutput/updatedMCPToolOutput（2742-2757） | tool_name | stderr 立即给模型（工具已跑） | ✅ loop.ts:250-291 |
| **PostToolUseFailure** | tool_name/tool_input/tool_use_id/error/is_interrupt?/duration_ms?（2710-2722）；QIt 文案另提 error_type/is_timeout | additionalContext（2724-2727） | tool_name | stderr 立即给模型 | ✅ loop.ts:256-259（+软 isError 255，见 §9 注） |
| **PostToolBatch** | tool_calls[]{tool_name/tool_input/tool_use_id/tool_response?}（2693-2708） | additionalContext（2698-2701） | 无 | 停止 agentic loop，stderr 仅用户 | ❌ 不在 app 27；native 无批次缝 |
| **UserPromptSubmit** | prompt/source?/session_title?（10276-10284） | additionalContext/sessionTitle/suppressOriginalPrompt（10286-10294） | 无 | 阻断处理、**抹掉原 prompt**、stderr 仅用户 | ✅ native-session.ts:1573/1659 |
| **UserPromptExpansion** | expansion_type/command_name/command_args/command_source?/prompt（10258-10265） | additionalContext/suppressOriginalPrompt（10267-10274） | command_name | 阻断展开，stderr 仅用户 | ❌ 不在 app 27 |
| **SessionStart** | source(startup/resume/clear/compact/fork)/agent_type?/model?/session_title?/seconds_since_last_response?/context_tokens?/…（6818-6840） | additionalContext/initialUserMessage/sessionTitle/watchPaths/reloadSkills（6842-6852） | source | stderr 仅用户（不阻断） | ✅ native-session.ts:608-627 |
| **SessionEnd** | reason(clear/resume/logout/prompt_input_exit/other)（6757-6760, 784-786） | 无 | reason | 无 exit-2 阻断；其他码 stderr 仅用户 | ⚠️ destroy 2521-2554 有缝，但 SDK 栈不触发（§9） |
| **Stop** | stop_hook_active/last_assistant_message?/background_tasks?/session_crons?（9940-9957） | additionalContext（9962-9965，非错误反馈，续跑） | 无 | **stderr 给模型并继续对话**（阻止停止） | ✅ loop.ts:188-192/294-307 |
| **StopFailure** | error(SDKAssistantMessageError)/error_details?/last_assistant_message?（9933-9938） | 无 | error | **fire-and-forget，输出与 exit code 全忽略** | ✅ native-session.ts:1766-1812 |
| **SubagentStart** | agent_id/agent_type（9967-9971） | additionalContext（9973-9976，给子代理） | agent_type | stderr 仅用户 | ✅ subagent.ts:192-207 |
| **SubagentStop** | stop_hook_active/agent_id/agent_transcript_path/agent_type/last_assistant_message?/background_tasks?/session_crons?（9978-9998） | additionalContext（10003-10006，给子代理续跑） | agent_type | stderr 给子代理并让它继续跑 | ✅ subagent.ts:249-260 |
| **PreCompact** | trigger(manual/auto)/custom_instructions(string\|null)（2759-2763） | 无（exit-0 plain stdout 追加为自定义压缩指令） | trigger | **阻断压缩** | ✅ native-session.ts:1994-2007 |
| **PostCompact** | trigger/compact_summary（2635-2642） | 无（exit-0 stdout 给用户） | trigger | 无阻断；其他码 stderr 仅用户 | ✅ native-session.ts:2011-2017 |
| **PermissionRequest** | tool_name/tool_input/permission_suggestions?/mcp_server?（2558-2564） | decision{behavior:allow,updatedInput?,updatedPermissions?}\|{behavior:deny,message?,interrupt?}（2566-2577） | tool_name | 无 exit-2 阻断；exit 0 用 hook 决策 | ✅ loop.ts:217→broker |
| **PermissionDenied** | tool_name/tool_input/tool_use_id/reason/mcp_server?（2539-2546） | retry?:boolean（2548-2551，告诉模型可重试） | tool_name | 无 exit-2 阻断 | ✅ broker deny 642-655 |
| **Notification** | message/title?/notification_type（1508-1513） | additionalContext（1515-1518） | notification_type | 无 exit-2 阻断 | ❌ native 无发射；SDK 栈也不触发 |
| **Elicitation** | mcp_server_name/message/mode?/url?/elicitation_id?/requested_schema?（714-722） | action(accept/decline/cancel)/content?（727-731） | mcp_server_name | **拒绝 elicitation** | ❌ native MCP 无 elicitation |
| **ElicitationResult** | mcp_server_name/elicitation_id?/mode?/action/content?（766-773） | action?/content?（778-782，覆盖响应） | mcp_server_name | 阻断响应（action 变 decline） | ❌ 同上 |
| **TaskCreated** | task_id/task_subject/task_description?/teammate_name?/team_name?（10055-10065） | 无 | 无 | stderr 给模型并**阻止任务创建** | ⚠️ 语义错位（§9） |
| **TaskCompleted** | task_id/task_subject/task_description?/teammate_name?/team_name?（10043-10053） | 无 | 无 | stderr 给模型并**阻止任务完成** | ⚠️ 语义错位（§9） |
| **TeammateIdle** | teammate_name/team_name（10067-10074） | 无 | 无 | stderr 给 teammate 并阻止 idle | ❌ native 无 team |
| **Setup** | trigger(init/maintenance)（9698-9701） | additionalContext（9703-9706） | trigger | stderr 仅用户 | ❌ native 无 setup 阶段 |
| **ConfigChange** | source(user_settings/project_settings/local_settings/policy_settings/skills)/file_path?（383-387） | 无（exit 0 允许变更） | source | **阻止变更应用到会话**（policy_settings 不可阻断） | ⚠️ applyFlagSettings 缝，语义不同（§9） |
| **InstructionsLoaded** | file_path/memory_type/load_reason/globs?/trigger_file_path?/parent_file_path?（1081-1089） | 无 | load_reason | **仅观测，不支持阻断** | ❌ native 不加载指令文件 |
| **CwdChanged** | old_cwd/new_cwd（665-669） | watchPaths?（671-674） | 无 | 无阻断；CLAUDE_ENV_FILE 可写 env | ❌ native cwd 固定 |
| **FileChanged** | file_path/event(change/add/unlink)（798-802） | watchPaths?（804-807） | 文件名（watch 列表） | 无阻断；CLAUDE_ENV_FILE 可写 env | ❌ native 无 watcher |
| **WorktreeCreate** | name（10315-10318） | worktreePath（10323-10326；command 用 stdout 输出路径） | 无 | 任何非零码 = 创建失败 | ❌ host-only |
| **WorktreeRemove** | worktree_path（10328-10331） | 无 | 无 | 其他码 stderr 仅用户 | ❌ host-only |
| **DirectoryAdded** | directory/source(slash_command/register_repo_root)（692-702） | 无 | source | 无阻断 | ❌ 不在 app 27 |
| **MessageDisplay** | turn_id/message_id/index/final/delta（1389-1411） | displayContent（1416-1422，仅替换屏幕显示） | 无 | 其他码显示原 delta | ❌ 不在 app 27 |
| **PreModelSwitch** | from_model/to_model/requested_model/source/context_tokens/…（2765-2801） | permissionDecision(allow/deny/ask)/permissionDecisionReason（2803-2810） | to_model | 阻断切换，stderr 给用户 | ❌ 不在 app 27 |
| **PostModelSwitch** | 同上 + source 多 auto/resume（2644-2680） | additionalContext（2682-2688，下次请求给模型） | to_model | 无阻断 | ❌ 不在 app 27 |

**app 27 vs CLI 33**：`HookEvent` 全集 33 个（sdk.d.ts:996）。app `SUPPORTED_HOOK_EVENTS`（shared/hooks.ts:3-31）
的 27 个之外，CLI 还有 **PostToolBatch、UserPromptExpansion、PreModelSwitch、PostModelSwitch、
DirectoryAdded、MessageDisplay** 6 个。`[type-contract]`

---

## 4. 横切机制

### 4.1 matcher 语言

`Lvn(matcher, query, tools, input, aliases)` → `Fee(query, XZe(event,matcher), Hee.has(event), …)`。
`[source-verified]`（`rg -a -o 'function Lvn\(e,n,r,s,h\)\{.{0,250}'`、`rg -a -o 'function Fee\(e,n,r,s,h,y\)\{.{0,700}'`）：

- **空 / `"*"` → 匹配一切**（`if(!n||n==="*")return!0`；收集器另认 `".*"` 为 match-all）。
- **字面列表**：matcher 仅含 `[a-zA-Z0-9_|, -]`（`Nvr`/`u2e`）→ 按 `|` 或 `,` 拆分、trim，**精确等于**工具名
  （或其别名）才匹配。
- **否则按正则**：`new RegExp(matcher)`（`GJn`），**非锚定、大小写敏感**（JS 默认），`.test(工具名)`；
  也测工具别名（`Kie`/`r4`）与 MCP stand-in 名。**非法正则 → log "Invalid regex pattern in hook matcher" +
  不匹配**（不抛）。
- 匹配目标逐事件不同（§3 qZe 映射）；无目标的事件 matcher 被忽略。

### 4.2 `if` 条件

schema describe：**"Permission rule syntax to filter when this hook runs (e.g., 'Bash(git *)'). Only runs
if the tool call matches the pattern."**（`pe()`）`[source-verified]`（`rg -a -o 'Permission rule syntax to filter.{0,200}'`）。

求值器 `Pvn(input, tools)` / `iEn`：**仅 PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/
PermissionDenied 五个工具事件可求值**；用权限规则解析器 `Bn(rule)` 拆 toolName+ruleContent，工具名命中后
**用该工具自己的 `preparePermissionMatcher`**（如 Bash 命令前缀匹配）判 ruleContent。非工具事件设了 `if` →
log "Hook if condition … cannot be evaluated for non-tool event …" 并**跳过该 hook**。
`[source-verified]`（`rg -a -o 'function Pvn\(e,n,r=!1\)\{.{0,500}'`、`rg -a -o 'cannot be evaluated for non-tool event.{0,120}'`）。

→ `if` 不是布尔表达式语言，是**权限规则语法**，且只对工具事件有效。`shared/hooks.ts` 未对此设限（任意事件
都可填 if）——native 实现须复刻"非工具事件跳过"语义。`[analysis]`

### 4.3 `once`

**仅 skill frontmatter 声明的 hook 生效；settings 文件与 agent frontmatter 忽略。**
`[doc-verified]`（hooks-reference："Only honored for hooks declared in skill frontmatter; ignored in settings
files and agent frontmatter"）+ `[source-verified]`：skill hook 注册 `Ct()` 给每个 `once` hook 挂
`onHookSuccess` 回调，回调里 `registry.remove(...)`（log "Removing one-shot hook for event … in skill '…'"）；
注册表在 `outcome==="success" && !notStarted` 时才调 onHookSuccess。**失败/exit-2 阻断/超时不移除**，下次还跑。
（`rg -a -o 'Removing one-shot hook for event \$\{P\}.{0,300}'`、`rg -a -o 'onHookSuccess&&Zo.outcome==="success".{0,150}'`）。
settings hooks 每次事件从快照重新收集（§7），不经注册表 onHookSuccess，故无移除路径。

→ **CRW 用户 hooks 经 `Options.settings.hooks`（flag settings 层）传入，`once` 在 claude 侧 inert**。
native 要"完全一致"就也应忽略 settings 形 hook 的 once（或产品裁决另做）。`[analysis]`

### 4.4 async / asyncRewake

- `async:true`：hook 后台跑，**立即返回 `{async:true, asyncTimeout}`**（asyncTimeout = hook.timeout*1000 否则
  xf=600000），不阻塞当前动作；timeout 不在阻断路径上强制执行。`[source-verified]`
  （`rg -a -o 'asyncResponse:\{async:!0,asyncTimeout.{0,200}'`）+ `[doc-verified]`。
- command hook 也可在 stdout 打印 `{async:true}` 运行时转 async（`KFr` 检测，§2.2）。`[source-verified]`
- **asyncRewake:true（蕴含 async）**：后台 hook **exit 2** 时唤醒模型。完成 handler（`$Ze` 内
  `r.result.then(...)`）：取 stdout/stderr → 若识别为"脚本打不开"的安装损坏（`I0t`）则只报一次不唤醒；
  否则 `Pin({summary, body, priority:"next", stopHookActive:true, turnAttribution:"inherit"})`，
  `Pin` = `enqueuePendingNotification(...)`——**把唤醒塞进会话通知队列**（与 task notification 同机制），
  body = `rewakeMessage ?? 'Stop hook blocking error from command "<name>":'` + (stderr||stdout)，
  summary = `rewakeSummary ?? 'Stop hook feedback'`。`[source-verified]`
  （`rg -a -U -o '(?s)let we=r\.result\.then\(async\(Ce\)=>\{.{0,2900}'`、`rg -a -o 'function Pin\(.{0,300}'`）。
  schema describe："wakes the model on exit code 2 (blocking error). Implies async."
- 非 rewake 的 async hook：注册进后台任务表（`C0t`），输出 fire-and-forget。`[source-verified]`

→ native 复刻 asyncRewake 需要一个"通知队列 → 空闲时注入系统回合"的机制；native 现有 task/notification
（task-manager.ts:101-109）是最近的类比，但唤醒投递路径需新建。`[analysis]`

### 4.5 timeout

默认值（CLI 常量，chunk-ghynyejs：`xf=600000, jFo=30000, nzs=1500, Tvr=60000`）`[source-verified]`
（`rg -a -o 'xf=600000,FVs=\["SessionStart","Setup"\].{0,80}'`）+ `[doc-verified]`（hooks-reference 一致）：

| 类型/事件 | 默认 |
|---|---|
| command / http / mcp_tool | **600s**（xf=600000；各事件 generator 默认参 `w=xf`/`S=xf`，如 `_ze(e,n,r,s,h,y,S=xf,w,L)`） |
| prompt | **30s**（`e.timeout?e.timeout*1000:30000`） |
| agent | **60s**（`e.timeout?e.timeout*1000:60000`） |
| UserPromptSubmit | **30s**（GFr/Oyt 传 `timeoutMs:jFo`，jFo=30000） |
| PreModelSwitch / PostModelSwitch | 30s（doc；常量未逐一定位） |
| MessageDisplay | 10s（doc；常量未定位）`[doc-verified]` |
| SessionEnd | **共享 1.5s 预算**（nzs=1500），settings 设了更长 per-hook timeout 则抬到该值、上限 60s（Tvr=60000）（`Math.max(nzs,Math.min(r,Tvr),e)`） |

per-hook 上限 clamp：`Math.min(hook.timeout*1000, tc)`，`tc=2147483647`（setTimeout 32-bit 上限）。
`[source-verified]`（`rg -a -o 'fs=ar\.timeout\?Math\.min.{0,120}'`、`rg -a -o 'tc=2147483647'`）。
timeout 经 `Ss(signal,{timeoutMs})` 的 abort signal 执行；超时 → cancelled 结果（onFailure:'block' 时算 exit 2）。

### 4.6 statusMessage

schema describe："Custom status message to display in spinner while hook runs"。`[source-verified]`
TUI spinner 文案；SDK 流不携带（hook_progress 帧只有 stdout/stderr/output）。native 侧可作为 hook-run
记录的展示提示，无 CLI 行为可复刻。`[analysis]`

### 4.7 command hook 的环境变量

spawn env = 继承进程 env（`Mo()`，sandbox 时另构造）+ `RZe(context)` + `CLAUDE_PROJECT_DIR` + 插件变量。
`RZe` 实测构造（`[source-verified]`，`rg -a -o 'function RZe\(e\)\{.{0,450}'`）：

```
CLAUDECODE="1", CLAUDE_CODE_SESSION_ID=<sessionId>, CLAUDE_CODE_CHILD_SESSION="1",
CLAUDE_CODE_SESSION_ATTENDED="1"/"0", CLAUDE_PID=<pid>,
CLAUDE_EFFORT=<effortLevel>（有 effort 时）, AI_AGENT（source==="agent" 时）, TRACEPARENT（otel 时）
```

外加（spawn 函数体，`rg -a -o '.{0,3200}CLAUDE_PROJECT_DIR:Qt\(mo\).{0,500}'`）：
`CLAUDE_PROJECT_DIR`（win32 bash 下 `\`→`/`）、`COLUMNS`/`LINES`（取自 process.stdout）、
插件 hook 的 `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`/`CLAUDE_PLUGIN_OPTION_<KEY>`、
**`CLAUDE_ENV_FILE`**（仅 SessionStart/Setup/CwdChanged/FileChanged 事件——hook 往里写 bash export 即可
给后续 BashTool 注入 env）。

**没有 `CLAUDE_TOOL_NAME`/`CLAUDE_TOOL_INPUT`/`CLAUDE_TOOL_USE_ID`/`CLAUDE_HOOK_EVENT_NAME`**——
全二进制零命中；工具事实**只走 stdin JSON**。`[source-verified]`（`rg -a -c 'CLAUDE_TOOL_NAME'` = 0 等）。
任务提示里列举的这些名字不是本 CLI 的真实 env 面。

### 4.8 shell 解析

`shell: 'bash'|'powershell'`，默认 `OG()`（平台探测）：POSIX bash（$SHELL，bash/zsh/sh）；
**Windows 无 Git Bash → powershell**。`[source-verified]`（schema describe + spawn `Kt=e.shell??OG()`）。
- powershell：找 pwsh 或 powershell（PATH），找不到 → 抛错 "…no PowerShell executable (pwsh or powershell)
  was found on PATH…"。命令经 `yEr` 转换；`$CLAUDE_PROJECT_DIR` 在 PowerShell 读作 $null，CLI 告警建议
  `$env:CLAUDE_PROJECT_DIR` 或 `${CLAUDE_PROJECT_DIR}`。
- **exec form（`args` 字段，shared/hooks.ts 未接受）**：`command` 解析为可执行文件直接 spawn，**不经 shell**；
  `${CLAUDE_PROJECT_DIR}`/`${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`/`${user_config.*}` 按元素纯字符串替换。
  `[source-verified]`（schema describe "Argument list for exec form…" + spawn `Xt=e.args!==void 0` 分支）。

### 4.9 并发与序列化

`LTn(hooks, Oee)`：`Oee(h)=h.type==="prompt"||h.type==="agent"`。**command/http/mcp_tool 并行**（混合 runner
并发上限 `_Ze=12`）；**prompt/agent 串行**（promise 链逐个 await）。`[source-verified]`
（`rg -a -o 'function Oee\(e\)\{return e\.type==="prompt".{0,300}'`）。
PostToolUse 的多个 rewrite hook **并行跑在原始 output 上，last-write-wins**（d.ts:2746 注释 +
DNr 循环 `if("updatedToolOutput" in Vi)Ra=Vi.updatedToolOutput` 顺序覆盖）。`[type-contract]`+`[source-verified]`。

---

## 5. 与权限系统的先后（ordering）

**PreToolUse hook 先于权限系统**，其决策喂给权限判定。`[source-verified]`（工具管线 `FNr` 阶段 +
权限决策函数，`rg -a -o '.{0,950}_ze\(n\.name,s,r,e,ae\(e\)\.mode.{0,1600}'`）：

1. `FNr` 迭代 PreToolUse dispatch `_ze(...)`：
   - `blockingError` → 权限决策 `{behavior:"deny", decisionReason:{type:"hook",…}}`。
   - `updatedInput` → `EWe` 校验（含工具 inputSchema）；非法 → deny；**内部保留键（`_` 前缀等）拒绝**
     （"Only Claude Code sets such keys… The tool was not run."）。
   - `permissionBehavior` allow/deny/ask/defer 分别处理；defer → 交回权限系统。
2. 权限决策函数：`behavior==="allow" && requireCanUseTool` 或 `behavior==="ask"` → **调 canUseTool**
   （SDK 权限回调 / UI 询问）；`behavior!=="ask"`（allow/deny）→ **直接返回，短路 canUseTool**。
3. **PermissionRequest hook（`bze`）在权限请求流程内跑**（"When a permission dialog is displayed"），
   受 `hooksMayAllow`/`hooksMayRefuse` 门禁（**此门禁仅限 pre-ask `dLr` 一路**；取值推导 + SDK 主路径 `qMt` 不受其限、能 auto-allow，见 §13.1）；allow 需 `hooksMayAllow===true` 且 updatedInput 过校验；
   deny → `{behavior:"deny",message}`，`interrupt:true` 触发 abort。`[source-verified]`
   （`rg -a -o '.{0,140}hooksMayAllow.{0,180}'`）。

→ 顺序：**PreToolUse hooks → （allow/deny 短路 | ask→权限规则/PermissionRequest hooks→canUseTool 询问）→
工具执行 → PostToolUse（成功）/ PostToolUseFailure（抛错路径）**。PermissionDenied（`tOo`）在权限拒绝
解析处触发（`tr.decisionReason.reason ?? "Permission denied"`，retry:true 置可重试标志）。
`[source-verified]`（`rg -a -o '[^a-zA-Z_$0-9]tOo\(.{0,180}'`）。

**PostToolUse / PostToolUseFailure 相对 tool result**：PostToolUse（`DNr`/`HKn`）在结果消息构造后跑；
PostToolUseFailure（`LNr`/`eOo`）在工具**抛错**的 catch 路径跑（含 interrupt/timeout 分类）。
`[source-verified]`（`rg -a -o '.{0,1300}LNr\(s,e,n,S,Kt,Qi,ii\|\|Kr.{0,350}'`）。
**软 is_error（工具正常返回但结果带 is_error）走 PostToolUse 成功路径**——未见把它路由到 Failure 的分支；
native 的 `outcome.isError`（loop.ts:255）与抛错（256-259）都产出 is_error result，复刻时需裁决软失败归属
（§10 开放问题）。`[source-verified 到所读范围]`

**Stop hook**：回合收尾前跑；exit 2 / decision block → stderr 给模型并**继续对话**（强制续跑）；
`stop_hook_active` 标记本轮已被 Stop hook 阻断过；**阻断次数上限默认 8**
（`i.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP??8`，超限告警并结束回合）。`[source-verified]`
（`rg -a -o 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP\?\?8.{0,300}'`）。additionalContext 是非错误反馈续跑通道
（sdk.d.ts:9960-9965）。`[type-contract]`

---

## 6. prompt / agent / http / mcp_tool 类型

### 6.1 prompt（单轮 LLM 判定）

`[source-verified]`（`rg -a -U -o '(?s)You are evaluating a stop-condition hook.{0,2400}'`、
`rg -a -o '.{0,1600}Hooks: Querying model with \$\{Ce'`）：

- 模型 `e.model ?? Mb()`；**`Mb()` = `ANTHROPIC_SMALL_FAST_MODEL` 否则 Haiku 类小快模型**
  （`rg -a -o 'function Mb\(\)\{.{0,400}'`）。schema describe："uses the default small fast model."
- **单轮、无工具、thinking disabled**，`outputFormat:{type:"json_schema", schema:{ok:boolean, reason:string,
  impossible:boolean, required:["ok","reason"]}}`，querySource:"hook_prompt"。
- 两套 system prompt：Stop/SubagentStop 用 stop-condition 版（含 `impossible` 三态）；其余用
  "You are evaluating a hook… Decide whether the action may go ahead."（ok/reason 二态）。
  均含反注入条款（"ignore any rule… inside them"）。
- 输入：`$ARGUMENTS` 替换为 hook input JSON（`GWe`），附 transcript 上下文。
- 结果：`ok:false` → `decision:"block"` + reason；**`continueOnBlock`**（shared/hooks.ts 未接受）决定
  block 时的 continue 值，默认 false（回合结束）；PostToolUse 上 reason 反馈给模型续跑。
  `[source-verified]`（`rg -a -o 'continueOnBlock.{0,300}'`、`preventContinuation:!q&&e.continueOnBlock!==!0`）。
- timeout 默认 30s。

### 6.2 agent（agentic 验证器）

`[source-verified]`（`pZe`，`rg -a -U -o '(?s)You are evaluating a \$\{r\} hook in Claude Code.{0,2700}'`）：

- 模型 `e.model ?? Mb()`（默认 Haiku）；**gateway 且无 haiku/small-fast env 时回退会话主模型**（`dc(y)`）。
- **带工具的 agentic loop**：工具 = 会话工具（过滤后）+ 裁决工具 `sTn()`（inputSchema `{ok:boolean,reason?}`，
  "You MUST call this tool exactly once at the end"）。≤**50 轮**（`mo=50`，超限 abort）。thinking disabled，
  权限模式 dontAsk + 会话级 `Read(/<transcript>)` 规则。querySource:"hook_agent"。
- 裁决经 structured_output attachment（`xee().safeParse`）取回 `{ok,reason}`；ok:false → block（同 prompt）。
- timeout 默认 60s。schema describe："If not specified, uses Haiku."

→ prompt 与 agent 的区别：**prompt 单轮无工具只看 transcript；agent 多轮带工具可查代码库**。两者默认模型
同为小快模型（Haiku 类），不是会话主模型（gateway 例外）。

### 6.3 http

`[source-verified]`（`rg -a -o '\{ok:!1,body:"",error:ke\}\}.{0,2000}'`）：

- **POST hook input JSON** 到 url，`Content-Type: application/json`；`validateStatus:()=>!0`（收所有状态），
  `ok = 200≤status<300`；**`maxRedirects:0`（不跟随重定向）**；响应 body 按 hook 输出 JSON 解析（同 zY 路径）。
- headers 值支持 `$VAR`/`${VAR}` 插值，**仅 `allowedEnvVars` 列出的变量**，再与 managed
  `httpHookAllowedEnvVars` 取**交集**；未列出的 `$VAR` 留空串。
- URL 门禁 `allowedHttpHookUrls`（通配 `*`；undefined=全允许，[]=全禁，跨源 union）；不匹配 → 拒发。
- 非 2xx / 网络错 → 失败结果（onFailure:'block' 时算 exit 2）。timeout 默认 600s。

### 6.4 mcp_tool（app 未接受的第五类型）

`type:"mcp_tool"`，`server`/`tool`/`input`（`${path}` 从 hook input JSON 插值，如 `${tool_input.file_path}`）。
`[source-verified]`（`rg -a -o 'type:C\("mcp_tool"\).{0,400}'`）。**仅特定事件可用**（`j_` 集：
UserPromptSubmit/UserPromptExpansion/PreToolUse/PermissionRequest/PermissionDenied/PostToolUse/
PostToolUseFailure/PostToolBatch/SubagentStart/SubagentStop/TaskCreated/TaskCompleted/Elicitation/
ElicitationResult/WorktreeCreate/WorktreeRemove）。`[source-verified]`（`rg -a -o 'j_=new Set\(\[.{0,300}'`）。
shared/hooks.ts 只接受 command/http/prompt/agent 四类型——mcp_tool 与 command 的 `args`、prompt 的
`continueOnBlock` 都是 app 契约缺口。`[analysis]`

---

## 7. Settings 门禁与合并

字段（sdk.d.ts）`[type-contract]`：
- `disableAllHooks`（7549）："Disable all hooks and statusLine execution: the hooks defined in settings files
  and by installed plugins. Features built into Claude Code are not hooks in this sense and keep working."
- `allowManagedHooksOnly`（7609）：仅 managed settings + managed 启用的插件的 hook 跑；user/project/local
  及用户自装插件的 hook 忽略。
- `allowedHttpHookUrls`（7613）/`httpHookAllowedEnvVars`（~7617）：见 §6.3。
- hook 诊断 policy（4288-4304）：managed disableAllHooks → 全不跑；**非 managed disableAllHooks → managed
  hooks 仍跑**（policyHookCount）；policyUnreadable → fail-closed 拒编辑。

收集与合并（`c(event)`/`fG`，`[source-verified]`，`rg -a -o 'function fG\(o\)\{return qJn\(c\(o\)\)\}.{0,2300}'`）：
`dr("hooks")`（disableAllHooks）→ []；否则按序拼接 **`NG()`（initialHooksConfig，会话启动时的 settings
快照，含 flag 层）→ `cgn()`（插件 hooks，按 settings 源）→ `Bte()`（mainThreadAgentHooks，agent 定义；
managedOnly 时跳过）→ `VR()`（registeredHooks：SDK host callback + 会话注册，按插件信任过滤）**，`qJn` 去重。
managed pass 单独先跑（`zL(...,{managedHooksOnly:true})`，读 policySettings + managed 插件）。
同一 hook 跨源重复时 `a2` 去重、**优先 flagSettings/policySettings 副本**。`[source-verified]`
（`rg -a -o 'function a2\(e,n,r\)\{.{0,600}'`）。

SDK 嵌入层 lockdown（sdk.d.ts:2291-2299）`[type-contract]`：`disableAllHooks:true` 绑定为
`allowManagedHooksOnly:true`；`allowedHttpHookUrls`/`httpHookAllowedEnvVars` 仅以空列表绑定（非空丢弃，
因跨源 union 会放宽 admin 限制）。

CRW 接线：spawn 经 `Options.settings.hooks = toSdkHooksSettings(meta.hooks)`
（session-manager.ts:3374，shared/hooks.ts:333-345）；live 更新经 `applyHooks` →
`applyFlagSettingAndPersist({hooks})`（session-manager.ts:6757-6767）。CLI 有 flagSettings hooks 的
dispatch 读取分支（`jLt` 读 `pe("flagSettings")?.hooks`），但 live 生效性本次未实测。`[source-verified 分支存在]`

---

## 8. SDK in-process callback 契约（与 settings hooks 共享输出契约）

- `Options.hooks`（sdk.d.ts:1776）注册 `HookCallbackMatcher[]`；SDK 编号 `hook_${nextCallbackId++}`，
  按 `Object.entries(hooks)` 插入序（noop note 已溯）。`[source-verified]`（sdk.mjs
  `HooksPayload[m]=...hook_${this.nextCallbackId++}`）。
- CLI 侧 `createHookCallback(id, timeout)` 发 `hook_callback` 控制请求，**响应经 `Lce()` 校验**；
  校验失败/异常 → `console.error("Error in hook callback hook_N:", err)` 并**返回 `{}`**（无决策）。
  `[source-verified]`（`rg -a -o 'createHookCallback\(e,s\)\{.{0,500}'`）。这正是 noop note 里 stderr 噪声的来源。
- `handleHookCallbacks`（sdk.mjs/core.mjs）仅按 id 查表调回调；响应原样进
  `{type:"control_response",response:{subtype:"success",request_id,response:r}}`。`[source-verified]`。
- **no-op 必须返回 `{}`**（合法空 SyncHookJSONOutput），不能 undefined（JSON.stringify 丢弃 → CLI 校验
  invalid_union）。`[live-probed-prior]`（noop note）。
- `includeHookEvents`（sdk.d.ts:1903）：true 时发 hook_started/hook_progress/hook_response 系统帧；
  **SessionStart/Setup 恒发**。hook_response 带 exit_code?/outcome(success/error/cancelled)。`[type-contract]`
- **SDK 栈下不触发的事件**：SessionEnd、Notification（`inprocess-hooks.ts:139-143` probe-verified）；
  Stop 仅在输入 iterable 保持打开时逐回合触发（generator 完成关闭 stdin 则该回合 Stop 跳过，probe-verified）；
  SubagentStart 触发但无可操作载荷。`[live-probed-prior]`

---

## 9. native 触发缝盘点（layer-1 / layer-2）

native 代码行号已自验（loop.ts/native-session.ts/subagent.ts/task-manager.ts 关键段读过）。
缝点描述与 Explore 盘点一致处不再重复展开。

### 9.1 无条件 layer-1（13 个，有真实触发缝）

| 事件 | native 缝（file:line） | 备注 |
|---|---|---|
| PreToolUse | loop.ts:205-217（requestPermission 前） | 决策须先于 217 的权限请求 |
| PostToolUse | loop.ts:250-260 + 273-291（结果 persist/emit） | 成功结果路径 |
| PostToolUseFailure | loop.ts:256-259（catch） | 软 isError(255) 归属需裁决（§10） |
| UserPromptSubmit | native-session.ts:1573（pump 取 FIFO 头）/1659（user/message 落盘前） | source 对应 'sdk' |
| Stop | loop.ts:188-192（零工具回合 break）/294-307（result 帧） | 需 stop_hook_active + 阻断上限 8 |
| StopFailure | native-session.ts:1766-1812（pump catch，error result） | fire-and-forget |
| SessionStart | native-session.ts:608-627（fresh/resume/fork 分支 + init 帧） | source 映射 startup/resume/fork；clear/compact 另议 → **已决议 §13.2：SDK 栈触发集 {startup,resume,fork,compact}，compact 入列、clear 不入** |
| SubagentStart | subagent.ts:192-207（descriptor 落盘 → runTurn） | |
| SubagentStop | subagent.ts:249-260（finalReport 取回） | 后台子代理经 task-manager settle |
| PreCompact | native-session.ts:1994-2007（compactInPlace 入口） | host 驱动（session-manager maybeAutoCompact）；**缝须前移到摘要前，见 §13.3** |
| PostCompact | native-session.ts:2011-2017（history splice 后） | |
| PermissionRequest | loop.ts:217 → native-session.ts:1072 → permission-broker.ts:208-210 | |
| PermissionDenied | permission-broker.ts:642-655（deny 解析）/loop.ts:218-228 | 与 Request 分离的缝 |

### 9.2 有缝但语义错位，需产品裁决（4 个）

- **SessionEnd**：native `destroy(reason)`（native-session.ts:2521-2554）是天然缝，**但 claude SDK 栈在
  unload/terminate 时不触发 SessionEnd**（§8，probe-verified；CLI 的 SessionEnd 只在 clear/resume/
  prompt_input_exit 等交互退出路径触发，`MUt` 调用点）。"完全一致"意味着 native destroy 也**不应**触发
  SessionEnd——或产品裁决 native 额外触发（偏离 parity）。`[live-probed-prior]`+`[source-verified]`
- **ConfigChange**：CLI 由 **settings 文件 watcher** 触发（`H0o`，source=user_settings/project_settings/
  local_settings/policy_settings/skills + file_path，policy_settings 不可阻断）。native 的
  `applyFlagSettings`（native-session.ts:2418-2476）是 **SDK flag 设置**，不是文件变更——语义不同。
  复刻需裁决：native 无 settings 文件 watcher，此事件大概率 layer-2。`[source-verified]`
- **TaskCreated / TaskCompleted**：CLI 这两个事件是 **team 任务系统**（TaskCreate/TaskUpdate 工具，
  stdin 带 task_subject/task_description/teammate_name/team_name；`zFr`/`DUt` 调用点传 `ht.subject`）。
  native task-manager 的 TaskRecord（67-79 创建 / 91-112 settle）是**后台工具运行**，概念不同；native 无
  TaskCreate/TaskUpdate 类 team 任务工具。结构上有生命周期缝，但**语义指称错位**——直接映射会把"后台 shell
  完成"当成"team task 完成"。需产品裁决（大概率 layer-2，或等 native 引入 team 任务）。`[source-verified]`

### 9.3 无机制（layer-2，10 个）

| 事件 | 缺什么 |
|---|---|
| Setup | native 无 init/maintenance 阶段（构造期 skill 发现/MCP 重建是普通 init） |
| TeammateIdle | native 无 team/teammate 机制（子代理是一次性嵌套 run） |
| InstructionsLoaded | **native 不加载 CLAUDE.md/AGENTS.md/memory**——renderSystem（native-provider.ts:96-110）仅静态 section + systemPromptAppend；contextSnapshot 只有 cwd+时间 |
| CwdChanged | cwd 构造期固定（native-provider.ts:283），无 setCwd |
| FileChanged | 无 fs watcher；文件变更只在 tool.run 内 |
| WorktreeCreate / WorktreeRemove | worktree 操作仅 host 侧（session-manager.ts:2068-2082/2249/3097/10951），native 工具集无 worktree 工具 |
| Notification | native 无 idle/permission 通知发射；claude SDK 栈也不触发（§8）。task/notification 是 TaskCompleted 类比，不是 Notification |
| Elicitation / ElicitationResult | native MCP 有 OAuth（connections.ts:564/580）但**无 elicitation 请求处理**（全 native 零 elicit* 命中）；AskUserQuestion 答案走权限拒绝通道，非 MCP elicitation |

（MessageDisplay/DirectoryAdded/PostToolBatch/UserPromptExpansion/Pre/PostModelSwitch 不在 app 27，
native 亦无对应机制，不计入 27 的划分。）

**计数核对**：13（无条件）+ 4（裁决）+ 10（无机制）= 27。✓
任务假设的"~15 有缝"修正为 **13 无条件 + 4 条件**；Notification/Elicitation/ElicitationResult 经核实
native 无机制（且 Notification 在 claude SDK 栈也不触发）。

---

## 10. 矛盾与开放问题

**与 shared/hooks.ts 注释/契约的对照**：
- onFailure 注释（shared/hooks.ts:45-53）与 CLI schema describe **一致**。✓
- `once`：app 对所有 hook 接受 once，但 **CLI 仅 skill frontmatter 生效**，settings 形（CRW 用户 hooks）
  忽略。parity 下 native 也应忽略（或产品裁决）。§4.3。
- app 缺 CLI 字段：command `args`（exec form）、prompt `continueOnBlock`、`mcp_tool` 类型、
  wire 的 `metrics`/`rewakeSummary`。§4.8/§6。
- `if`：app 任意事件可填，CLI 仅工具事件可求值、非工具事件跳过该 hook。§4.2。
- 任务提示列举的 `CLAUDE_TOOL_NAME`/`CLAUDE_TOOL_INPUT` 等 env **不存在**于本 CLI；真实 env 面见 §4.7。

**需 live probe 或产品裁决**：
1. **PostToolUseFailure 软失败归属**：CLI 在抛错 catch 路径触发 Failure；正常返回的 is_error 结果走
   PostToolUse。native 的 `outcome.isError`（软）与抛错都产 is_error result——软失败该触发哪个事件？
   源码读到的是"抛错→Failure"。**已决议，见 §12.1**：路由只看 tool.call 抛错与否，软 is_error 正常返回走
   PostToolUse；MCP isError 在 call 层被转成抛错故进 Failure。`[source-verified]`
2. **SessionEnd / ConfigChange / TaskCreated / TaskCompleted 的 parity 取舍**（§9.2）——产品裁决。
3. **prompt/agent 的事件可用矩阵**：内嵌简化文档称 prompt/agent "Only available for tool events:
   PreToolUse, PostToolUse, PermissionRequest"，但 runner 明确有 Stop/SubagentStop 的 stop-condition
   变体（/goal 用 Stop prompt hook，`QKe` 收集 Stop prompt hooks）——简化文档与代码矛盾。**已决议，见 §12.2**：
   简化文档是过期帮助文本，代码按"会话上下文有无 / REPL 内外"门禁，Stop/SubagentStop/UserPromptSubmit 均支持。`[source-verified]`
4. **applyFlagSettings({hooks}) live 生效性**：CLI 有 flagSettings hooks 读取分支。**已决议，见 §12.3**：live 更新
   下一事件即生效、无需 respawn——NG() 快照随 flagSettings notifyChange 重建（区别于 autoCompactWindow 的 inert gap）。`[source-verified]`
5. **MessageDisplay/Pre/PostModelSwitch 的 timeout 常量**：doc 给 10s/30s，二进制常量未逐一定位
   （不影响 layer-1，这些事件不在 app 27）。`[doc-verified]`

---

## 11. 关键证据索引（复现命令）

CLI 二进制：`D:\codes\claude-react-web\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`
（2.1.311；minified 名跨 chunk 撞名，以函数体辨认）。

| 关注点 | 复现（rg -a -o，对 exe） |
|---|---|
| 逐事件 exit-code 目录 QIt | `'.{0,3600}Exit code 2 - show stderr to model and block tool call.{0,3600}'`（-U）；尾段 `'WorktreeRemove:\{summary:"Remove a previously created worktree".{0,3300}'`（-U） |
| 输出 schema EL / Lce | `'EL=p\(\(\)=>u\(\{continue.{0,1300}'`；`'Lce=p\(\(\)=>.{0,200}'` |
| stdout 解析 zY / Wvn / KFr / Avr | `'function zY\(e\)\{.{0,1500}'`（-U）；`'function Wvn\(e\)\{let n=te.{0,300}'` |
| onFailure Pje / e0t | `'function Pje\(e\)\{switch.{0,250}'`；`'function e0t\(e,n\)\{if\(!Pje.{0,400}'` |
| matcher qZe/Hee/Nvr/Fee/GJn/Lvn | `'function qZe\(e\)\{switch.{0,1400}'`；`'Hee=new Set\(\[.{0,450}'`；`'function Fee\(e,n,r,s,h,y\)\{.{0,850}'`；`'function GJn\(e\)\{.{0,550}'` |
| if Pvn/iEn | `'function Pvn\(e,n,r=!1\)\{.{0,750}'`；`'cannot be evaluated for non-tool event.{0,120}'` |
| once（skill 注册 + 成功移除） | `'Removing one-shot hook for event \$\{P\}.{0,500}'`；`'onHookSuccess&&Zo.outcome==="success".{0,150}'` |
| async/asyncRewake $Ze / I0t / Pin | `'let we=r\.result\.then\(async\(Ce\)=>\{.{0,2900}'`（-U）；`'function I0t\(.{0,400}'`；`'function Pin\(.{0,300}'` |
| timeout 常量 | `'xf=600000,FVs=\["SessionStart","Setup"\].{0,80}'`；`'nzs=[0-9]+|Tvr=[0-9]+'`；`'fs=ar\.timeout\?Math\.min.{0,120}'` |
| env RZe / spawn | `'function RZe\(e\)\{.{0,550}'`；`'.{0,3200}CLAUDE_PROJECT_DIR:Qt\(mo\).{0,500}'`；`'CLAUDE_ENV_FILE=await.{0,2300}'` |
| 并发 LTn / Oee | `'function Oee\(e\)\{return e\.type==="prompt".{0,300}'` |
| PreToolUse 管线 FNr / _ze / fvr | `'.{0,950}_ze\(n\.name,s,r,e,ae\(e\)\.mode.{0,1600}'`；`'async function\*_ze\(e,n,r,s,h,y,S=xf.{0,200}'` |
| PermissionRequest bze / hooksMayAllow | `'.{0,140}hooksMayAllow.{0,180}'`；`'[^a-zA-Z_$0-9]bze\(.{0,200}'` |
| PostToolUse/Failure DNr/LNr/HKn/eOo | `'.{0,1300}LNr\(s,e,n,S,Kt,Qi,ii\|\|Kr.{0,350}'`；`'[^a-zA-Z_$0-9]DNr\(.{0,200}'` |
| Stop 阻断上限 | `'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP\?\?8.{0,300}'` |
| prompt 求值 / Mb | `'You are evaluating a stop-condition hook.{0,2400}'`（-U）；`'function Mb\(\)\{.{0,400}'` |
| agent 求值 pZe / sTn | `'You are evaluating a \$\{r\} hook in Claude Code.{0,2700}'`（-U）；`'function sTn\(\)\{.{0,800}'` |
| http runner | `'\{ok:!1,body:"",error:ke\}\}.{0,2000}'` |
| settings 收集 c/fG/NG/Bte/cgn/a2 | `'function fG\(o\)\{return qJn\(c\(o\)\)\}.{0,2300}'`；`'function NG\(\)\{let o=e\(\).current.{0,300}'`；`'function a2\(e,n,r\)\{.{0,600}'` |
| ConfigChange H0o / SessionEnd MUt | `'function H0o\(e,n,r.{0,400}'`；`'[^a-zA-Z_$0-9]MUt\(.{0,180}'` |
| TaskCreated/Completed zFr/DUt | `'[^a-zA-Z_$0-9]DUt\(.{0,170}'`（调用点传 ht.subject） |
| SDK callback 校验 createHookCallback | `'createHookCallback\(e,s\)\{.{0,500}'` |
| mcp_tool 事件集 j_ | `'j_=new Set\(\[.{0,300}'` |
| notification 类型 qyi | `'qyi=\[.{0,220}'` |

SDK d.ts（0.3.311）关键行：AsyncHookJSONOutput 137-140；BaseHookInput 175-201；HookCallback 982-984；
HookEvent 996；HookInput 998；HookPermissionDecision 1002；SyncHookJSONOutput 10008-10022；
PreToolUse 2812-2827；PostToolUse 2729-2757；PostToolUseFailure 2710-2727；PostToolBatch 2693-2708；
PreCompact 2759-2763；PostCompact 2635-2642；PermissionRequest 2558-2577；PermissionDenied 2539-2551；
SessionStart 6818-6852；SessionEnd 6757-6760；ExitReason 784-786；Stop 9940-9965；StopFailure 9933-9938；
SubagentStart 9967-9976；SubagentStop 9978-10006；UserPromptSubmit 10276-10294；TaskCreated 10055-10065；
TaskCompleted 10043-10053；TeammateIdle 10067-10074；Notification 1508-1518；Elicitation 714-731；
ElicitationResult 766-782；ConfigChange 383-387；InstructionsLoaded 1081-1089；CwdChanged 665-674；
FileChanged 798-807；Setup 9698-9706；WorktreeCreate 10315-10326；WorktreeRemove 10328-10331；
DirectoryAdded 692-702；MessageDisplay 1389-1422；PreModelSwitch 2765-2810；PostModelSwitch 2644-2688；
Options.hooks 1776；includeHookEvents 1903；disableAllHooks 7549；allowManagedHooksOnly 7609；
allowedHttpHookUrls 7613；OnElicitation 1521-1537；TerminalReason 10079。

本仓对照：`shared/hooks.ts:3-31,35-83,333-345`；`server/session-manager.ts:3374,6757-6767`；
`server/providers/claude/claude-provider.ts:677,907`；`server/providers/claude/inprocess-hooks.ts:139-159`；
`.agents/notes/implemented/bug-fix/2026-11-24-hook-noop-output-object.md`；
`docs/superpowers/specs/2026-10-14-mid-run-steering-design.md`（§5.3 {} 契约）；
native 缝：`server/providers/native/loop.ts:188-309`、`native-session.ts:608-627,1573,1659-1669,1994-2017,2418-2476,2521-2554`、
`subagent.ts:192-260`、`task-manager.ts:67-112,185-203`、`native-provider.ts:96-110,225-242,283`、
`server/permission-broker.ts:208-210,642-655`、`server/providers/native-host-frame-adapter.ts:40-45`。

官方文档（2026-11-26 核对，仅交叉验证）：https://code.claude.com/docs/en/hooks-reference.md
（timeout 默认 600/30/60、逐事件 override、SessionEnd 1.5s 预算、once 仅 skill frontmatter、exit-2 stderr/JSON
reason 优先级、continue:false 压过 exit 2）。

---

## 12. 开放问题实测决议（follow-up probe）

> 2026-11-26 follow-up。对 §10 的三个开放问题（软 is_error 路由 / prompt·agent 逐事件可用性 /
> applyFlagSettings({hooks}) live 生效性）做**穷尽源码追踪**，三者全部 `[source-verified]` 定论，**无需 live probe**。
> 二进制同 §1（SDK 0.3.311 / CLI 2.1.311）。minified 名跨 chunk 撞名严重，下文每个符号以**函数体**辨认并附复现 grep
> （对 `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`，`rg -a -o`，多行加 `-U`+`(?s)`）。

### 12.1 Q1 — PostToolUseFailure 软 is_error 路由（§10.1 / §5）

**决议：路由分支只看 `tool.call` 是否抛错（try/catch），完全不看结果上的 `is_error` 标志。**
正常返回 → **PostToolUse**（成功路径），即使该工具自己的 `mapToolResultToToolResultBlockParam` 产出
`is_error:true`；抛错 → **PostToolUseFailure**。**MCP 是唯一把"软 isError"转成抛错的层**：MCP 结果
`isError:true` 在 call 层被规范化函数 `ys` 转成 `throw new Hv`，因此 MCP 错误经**抛错路径**进 Failure——
这与"抛错→Failure"一致，而不是"按 is_error 标志路由"。`[source-verified]`

**证据链**：

1. **主管线成功路径全窗无 is_error 分支**。从 `Kr=await …call(…)` 返回，经 telemetry、结果消息构造 `Ba`、到
   `DNr`（PostToolUse）循环及其后，**没有任何依据 `is_error` 改道 `LNr` 的分支**。`Ba` 内唯一读 `Pc.is_error`
   的地方只是决定是否追加 feedback 文本（`!Pc.is_error && typeof Pc.content==="string"`），与 hook 路由无关。
   复现：`rg -a -U -o '(?s).{0,7000}DNr\(s,e,n,y\.message\.id,Kt,Ra,w,L,z,Js'`（成功路径全窗）。
2. **`LNr`（Failure）调用点穷尽 = 仅两处 catch**：主管线工具抛错 catch（§11 已录）+ artifact REPL `innerCall`
   第二管线的 catch（`LNr(a,m,y,s.message.id,W,d(w),Ge(w),…)`）。**成功路径零调用**。第二管线同样只按
   throw/return 路由（`w=await m.call(…)` 正常返回 → `DNr(…,w.data,…)`，不查 is_error）。
   复现：`rg -a -o '[^a-zA-Z_$0-9]LNr\(.{0,160}'`（3 命中：生成器定义 + 两处 catch）。
3. **软 is_error 正常返回的真实实例**：memory-store 工具的 mapper 对 `outcome:"conflict"/"missing"/"refused"/"failed"`
   直接 `return {…, is_error:!0, …}`（正常 return，不抛错）→ 走 PostToolUse。
   复现：`rg -a -o 'mapToolResultToToolResultBlockParam\(e,n\)\{switch\(e\.outcome\).{0,400}'`。
4. **MCP isError→throw**：规范化函数 `function ys(e,r,n){if(!e.isError)return; … throw new Hv(s,"MCP tool returned error",…)}`；
   调用点在标准 MCP call（带 `mcp_progress`）`Ne=await Promise.race([ce.callTool(…),…]).finally(…); ys(Ne,B,ie);`——
   **每次 MCP 结果无条件过 ys**，isError 即抛。复现：`rg -a -o 'function ys\(e,r,n\)\{if\(!e\.isError\)return'`、
   `rg -a -U -o '(?s).{0,40};ys\(Ne,B,ie\);'`、`rg -a -U -o '(?s).{0,900}throw new Hv\(s,"MCP tool returned error"'`。
   （§5 的 `Hv` catch 分支 `Or instanceof Hv` 即此错误的落点。）

**设计最关键后果**：native **不能**把"结果带 is_error"一律路由到 PostToolUseFailure。必须复刻 CLI 的**机制本身**
（抛错→Failure / 正常返回→PostToolUse），而不是按 is_error 标志分支：
- native 内置工具的软 `outcome.isError`（loop.ts:255，正常返回）对应 CLI 内置工具的软 is_error mapper → **PostToolUse**；
- native MCP 适配层应像 CLI 的 `ys` 一样把 isError **转成抛错**，使其自然落入 catch → **PostToolUseFailure**。
最干净的 parity = 按 throw/return 路由 + MCP isError→throw，两处都不引入"is_error 标志"这一额外判据。

### 12.2 Q2 — prompt/agent 逐事件可用性矩阵（§10.3）

**决议：内嵌简化文档（"Only available for tool events: PreToolUse, PostToolUse, PermissionRequest"）是过期帮助文本，
代码才是规格。** 该句仅出现在内嵌 markdown 帮助文档（两份拷贝），**不在 zod describe、也不在任何执行门禁**。
真实门禁在执行器，按**"有无会话上下文 / 是否 REPL 内"**分三档，而非按"是否工具事件"。`[source-verified]`

**门禁机制**（REPL runner `nO`→`_En`→`$vn`→`dEr` 的逐 hook 分派）：
- `type:"prompt"`：需 `toolUseContext`（记 `w`）；`if(!w)throw Error("prompt-type hooks are not supported for ${lt} events
  (no conversation context is available). Use a command-type hook instead.")`。
- `type:"agent"`：同样需 `w`；且 **`PermissionRequest` 显式 throw**（"agent-type hooks are not supported for
  PermissionRequest events (an agent hook answers ok or not ok, and cannot return the allow / deny decision…)"）。
- 两者在 `w.agentId?.startsWith(fPt)`（`fPt="hook-agent-"`，即 hook 求值器自身的子代理）内被 **cancelled**（递归守卫）。
- 上述 throw 被逐 hook `catch(fl)` 捕获 → log "Hook failed to run" → **non_blocking_error**（prompt/agent 不支持
  onFailure:'block'，§2.4，故不阻断）。
- 复现：`rg -a -U -o '(?s).{0,1800}agent-type hooks are not supported for PermissionRequest.{0,1800}'`、
  `rg -a -o 'fPt="hook-agent-"'`。

**非 REPL runner `lN`（executeHooksOutsideREPL）**：`type:"prompt"` → `{succeeded:!1, output:"Prompt stop hooks are not
yet supported outside REPL", blocked:!1}`；`type:"agent"` → `"Agent stop hooks are not yet supported outside REPL"`。
均**非阻断失败**。复现：`rg -a -o 'Prompt stop hooks are not yet supported outside REPL.{0,400}'`（含 agent 变体）。

**逐事件矩阵**（按各事件 dispatcher 是否传 `toolUseContext` / 是否走 `lN` 归类；复现：
`rg -a -o 'nO\(\{session:[a-zA-Z_$0-9.]+,hookInput:[a-zA-Z_$0-9]+,.{0,220}'` 逐一核对 `toolUseContext` 有无）：

| 档 | 事件 | prompt | agent |
|---|---|---|---|
| **nO 带 toolUseContext** | PreToolUse / PostToolUse / PostToolUseFailure / PostToolBatch / PermissionDenied / UserPromptSubmit(主路径 `Oyt`) / UserPromptExpansion / **Stop / SubagentStop**(`_ye`) / TaskCreated / TaskCompleted / TeammateIdle | ✅ | ✅ |
| 同上，但 **PermissionRequest** | PermissionRequest(`bze`) | ✅ | ❌ 显式 throw |
| **nO 无 toolUseContext** | SessionStart(`ivr`) / Setup / SubagentStart(`jFr`) / MessageDisplay / PreModelSwitch / PostModelSwitch / UserPromptSubmit(`GFr` 变体) | ❌ "no conversation context" | ❌ 同左 |
| **lN（非 REPL）** | SessionEnd(`MUt`) / StopFailure / PreCompact / PostCompact / ConfigChange / DirectoryAdded / Notification / Elicitation / ElicitationResult / CwdChanged / FileChanged / InstructionsLoaded / WorktreeCreate / WorktreeRemove | ❌ "outside REPL" | ❌ 同左 |

（PostToolBatch/UserPromptExpansion/Pre/PostModelSwitch/MessageDisplay/DirectoryAdded 不在 app 27，列出仅为矩阵完整。）

**简化文档错在三处**：漏了 PostToolUseFailure/PermissionDenied（工具事件，支持）；把 PermissionRequest 算进 agent
可用（实际 agent 显式拒绝）；排除了 Stop/SubagentStop/UserPromptSubmit（实际支持——`/goal` 正是经
`sessionHooksRegistry.add(…,"Stop","",{type:"prompt",…})` 注册 Stop prompt hook，`QKe` 收集）。
复现（/goal 注册）：`rg -a -o 'sessionHooksRegistry\.add\(s,"Stop","",\{type:"prompt".{0,80}'`。

**设计最关键后果**：native 的 prompt/agent 可用性须按**"会话上下文有无 + REPL 内外"**复刻，不能照抄简化文档的
"仅工具事件"。尤其 **Stop/SubagentStop/UserPromptSubmit 必须支持 prompt/agent**，**PermissionRequest 必须拒绝 agent**；
SessionStart/SubagentStart/PreCompact/PostCompact/SessionEnd 等无会话上下文或非 REPL 事件上，prompt/agent 应产生
**非阻断错误/失败**而非静默成功。

### 12.3 Q3 — applyFlagSettings({hooks}) live 生效性（§10.4 / §7）

**决议：live 更新即时生效——下一个 hook 事件即用新 hooks，无需 respawn。** `NG()` **不是冻结的启动快照**：
它在 flagSettings 变更（notifyChange）时被**重建**。§7 所谓"会话启动时的 settings 快照"仅指**首次**捕获于启动，
之后随 settings 变更刷新。`[source-verified]`

**证据链（CRW applyHooks → 下一事件生效）**：

1. CRW `applyHooks`→`applyFlagSettingAndPersist({hooks})`→SDK `applyFlagSettings`→control `apply_flag_settings`→
   handler `ke`→`KI(ht,…)`。`KI`：并入当前 flagSettings（`Np()`），`zR(h)` + `Zi.notifyChange("flagSettings")`。
   复现：`rg -a -o 'function KI\(e,n\)\{let r=\{\.\.\.GI\(e\)\}.{0,500}'`、`rg -a -o 'zR\(h\),Zi\.notifyChange\("flagSettings"\)'`。
2. `zR(e)=settingsSource.replaceFlagSettingsInline(e)`（替换 inline flag 层）；`Np()=flagSettingsInline()`。
   复现：`rg -a -o 'function zR\(e\)\{n\(\)\.host\.settingsSource\.replaceFlagSettingsInline\(e\)\}'`。
3. **headless（SDK）订阅**：`function j(dt){SE({session:e,source:dt,…})}` + `Zi.subscribe(j)`（runHeadless_entry）。
   `SE` 无条件调 `DJt(e,n,o,d,u)`，其中 **`LG({userLayer:"retain"})`**。复现：
   `rg -a -o 'function j\(dt\)\{SE\(\{session:e,source:dt'`、`rg -a -o 'function DJt\(e,n,o,d,u\)\{.{0,160}'`。
4. **`LG(o)=or(o), e().store(r()), $te()`**；`or(e)=Ko().invalidateAll(e)`（清 `mergedSettings`/`perSource` 缓存）；
   `r()` 读 `yr().hooks`，而 **`var yr=pt; function pt(){return ig().settings||{}}`**，`ig()` 缓存 miss → `VQr` 重新合并
   各层（含新的 inline flagSettings）。复现：`rg -a -o 'function or\(e\)\{Ko\(\)\.invalidateAll\(e\)\}'`、
   `rg -a -o 'function pt\(\)\{return ig\(\)\.settings\|\|\{\}\}var yr=pt'`、
   `rg -a -U -o '(?s).{0,3000}function NG\(\)\{let o=e\(\).current'`（含 `r()`/`LG`/`F4o`/`store`）。
5. inline flagSettings 经 `sAt(e){let n=e.flagInline; …}` 读回（`pe("flagSettings")` 命中新值）。
   复现：`rg -a -o 'function sAt\(e\)\{let n=e\.flagInline.{0,300}'`。
6. **下一事件**收集 `hEn`/`zL`/`c(event)` 读 `NG()` → 返回**重建后的快照** → 新 hooks 生效。`NG()` 仅在
   `initialHooksConfig===null` 时 lazy-init，否则直接返回已刷新的存储值。

**与 autoCompactWindow inert gap 的对比**：hooks 之所以 live 生效，是因为 **(a)** 收集**逐事件重读** `NG()`，且
**(b)** `NG()` 快照在 flagSettings notifyChange 时**重建**。autoCompactWindow 无此"逐事件重收集 + 快照刷新"，故 inert
（见 `2026-11-25-claude-cli-auto-compact.md`）。**hooks 不是 autoCompactWindow 那类 inert key。**

**设计最关键后果**：native 的 live `applyHooks` 必须**逐事件重收集**（立即生效），不能只在 respawn 时应用——
这才与 CLI 一致。若 native 把 hooks 固化在 spawn 快照、live 更新只写不读，就会复刻出 autoCompactWindow 式的 inert gap，
违背 parity。

---

## 13. 项目1收尾实测（hooksMayAllow / SessionStart 生命周期 / PreCompact 时序）

> 2026-11-26 收尾 follow-up。对 native hook engine parity 设计遗留的三个行为事实做**穷尽源码追踪**：
> **Q-A** `hooksMayAllow`/`hooksMayRefuse` 门禁的取值推导（§5 只点名、未推导）；**Q-B** SDK/headless 栈 SessionStart
> 的真实触发集（§9.1 把 clear/compact"另议"）；**Q-C** PreCompact 相对摘要 LLM 调用的时序（为 native PreCompact 缝位提供依据）。
> 三者核心结论均 `[source-verified]`，**无需 live probe**。二进制同 §1（SDK 0.3.311 / CLI 2.1.311）；minified 名跨 chunk 撞名，
> 下文每个符号以**函数体**辨认并附复现 grep（对 `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`，`rg -a -o`，多行加 `-U`+`(?s)`）。
> CRW host 对照：`server/session-manager.ts`（clear / runAutoCompact）、`server/providers/claude/claude-provider.ts`、`server/providers/native/native-session.ts`。

### 13.1 Q-A — hooksMayAllow / hooksMayRefuse：插件-ask 决策上的字段，不是全局 allow 门禁

**决议：这两个字段是"ask"权限决策对象上的属性，唯一正向赋值点是插件-ask 包装器 `Y6`，唯一消费点是 pre-ask 运行器 `dLr`。
SDK 栈的 PermissionRequest hook 主路径是 `qMt`（ask 路径内、与权限询问并行跑），它对任何非 personOnly 的 ask 都认 allow，
**不受 hooksMayAllow 门禁**。因此 PermissionRequest hook **能** auto-allow 工具；hooksMayAllow 不是"hook 可否放行"的全局开关。** `[source-verified]`

**取值推导（唯一正向赋值点 `Y6`）**：

```js
function Y6(e){return{...e,suggestions:void 0,personOnly:!0,hooksMayRefuse:!0,hooksMayAllow:e.personOnly!==!0,suppressAlwaysAllowRule:!0}}
```

（`rg -a -o 'function Y6\(e\)\{return\{\.\.\.e,suggestions:void 0,personOnly:!0,hooksMayRefuse:!0.{0,120}'`；
注意与零参 `Y6()`（policy 加载错误函数）撞名，以**单参 + 此函数体**辨认。）

- `hooksMayRefuse:!0` 恒定；`hooksMayAllow = (被包装决策).personOnly !== true`。
- `Y6` 仅由 `FPo`（插件 tool.check 决策合并）在**插件决策为 ask** 时套用：`case"ask":{let we={behavior:"ask",…};return S?Y6(we):we}`，
  其中 `S=e.decision==="ask"&&e.plugin!==void 0`。（`rg -a -o 'function FPo\(\{result:e,decided:n.{0,1400}'`）
- 即 **hooksMayAllow=true ⇔ 插件 ask 包装了一个非 personOnly 的引擎 ask**；若引擎 ask 本身 personOnly
  （safetyCheck / plan mode "Enter plan mode?" / access_change 分类器 / ToolHost person-only ask），则 hooksMayAllow=false。
  personOnly 来源：`rg -a -o '.{0,100}personOnly:!0.{0,140}'`（safetyCheck "Enter plan mode?"、access_change、`srn` 模板等）。

**显式置 false 的三处覆盖**：
1. auto-mode 分类器 chrome-floor 阻断：`{...we,personOnly:!0,hooksMayAllow:!1,defaultToNo:!0,…}`
   （`rg -a -o 'permission_chrome_block_prompt"\),\{\.\.\.we,personOnly:!0,hooksMayAllow:!1.{0,100}'`）。
2. `mLr` 插件门禁（remoteSessionMcp / coworkWeb / planModeWriteFloor）：`if(S&&h.behavior==="ask")return{...h,hooksMayAllow:!1}`。
3. `mLr` 引擎 ask + 插件 personOnly ask + 门禁：`{...Y6(Se),hooksMayAllow:!1}`。
   （`rg -a -o 'if\(S&&h\.behavior==="ask"\)return\{\.\.\.h,hooksMayAllow:!1\}.{0,200}'`）

**消费点 `dLr`（pre-ask 运行器，唯一用 hooksMayAllow 门禁处）**：

```js
async function dLr(e,{tool:n,input:r,context:s,toolUseID:h,answers:y}){
  let S=ae(s);
  if(e.behavior!=="ask"||e.hooksMayRefuse!==!0||s.forRemoteExecution===!0||S.servedCall===!0)return e; // hooksMayRefuse!==true 直接不跑
  …for await(…bze(…)){
    if(z?.behavior==="allow"&&e.hooksMayAllow===!0&&!Man(n,z.updatedInput)&&U0e(z.updatedInput,w))L??=z; // allow 需 hooksMayAllow===true
    if(z?.behavior==="deny"){…return{behavior:"deny",…}}                                                  // deny 恒生效
  }…
}
```

（`rg -a -o 'async function dLr\(e,\{tool:n,input:r,context:s,toolUseID:h,answers:y\}\)\{.{0,700}'`）
因 hooksMayRefuse 仅由 Y6（插件 ask）置位，**dLr 只对插件-ask 决策跑**；普通（非插件）ask 的 hooksMayRefuse 为 undefined，dLr 立即返回。
dLr 调用点：`dDe`（引擎 pre-ask）与 `hxe`（PreToolUse 决策解析）。（`rg -a -o '[^a-zA-Z_$0-9]dLr\(.{0,140}'`）

**主路径 `qMt` 不用此门禁（SDK 栈能 auto-allow 的关键）**：

```js
// ask 路径编排 zks→m：引擎返回 ask 后，qMt 与权限询问并行跑（谁先决出谁生效）
let H=(c.personOnly===!0||Z.has(c)?Promise.resolve(void 0):qMt(r,n,f,P,s,w,c,()=>K||b.aborted)).then((R)=>({source:"hook",outcome:R}));
```

（`rg -a -o 'c\.personOnly===!0\|\|Z\.has\(c\)\?Promise\.resolve\(void 0\):qMt.{0,90}'`）
`qMt` 对任何非 personOnly ask 认 allow（经 updatedInput / 内部保留键 `Man` / 权限规则复检后）：
`if(y.behavior==="allow"){…return{decision:{behavior:"allow",…,hookName:"PermissionRequest"}}}`；门禁仅 `forRemoteExecution` 与 `personOnly`。
（`rg -a -o 'async function qMt\(r,e,m,n,d,s,h,f\)\{.{0,1700}'`）
另有 `Lgr`/`lLr`（headless `shouldAvoidPermissionPrompts` 路径，经 `$ve`）同样认 allow
（log "PermissionRequest hook failed for headless agent"，`rg -a -o 'PermissionRequest hook failed for headless agent.{0,120}'`）。

**门禁由什么输入决定（任务所问）**：**不**由 permission mode / settings trust / bypassPermissions / managed policy 直接决定，而是——
- hooksMayRefuse：插件 ask 恒 true；
- hooksMayAllow：被包装引擎 ask 的 personOnly（间接受 plan mode / safetyCheck / access_change 分类器影响），
  加上 mLr 门禁（remoteSessionMcp / coworkWeb / planModeWriteFloor）与 auto-mode chrome-floor 强制置 false；
- bypassPermissions：不注册 canUseTool、不产生权限请求，PermissionRequest hook 根本不触发（边界情形）。

**设计最关键后果**：native **不能**把全部 PermissionRequest allow 门禁在 `hooksMayAllow===true` 上——普通 ask 该字段为 undefined，
如此门禁会错误禁用 auto-allow；也不能恒置 true（那会让 personOnly ask 被 hook 放行，击穿安全底线）。正确复刻：
**主路径对非 personOnly ask 认 allow（qMt 语义）；personOnly 底线（safety / plan-mode ask 不可被 hook 放行）才是真实安全边界；
hooksMayAllow/hooksMayRefuse 仅适用于插件-ask 的 pre-ask 复检（dLr 语义）**。native 若不实现插件 tool.check ask 决策，
dLr/Y6 分支可整体省略，但 personOnly 底线与主路径 allow 必须保留。

### 13.2 Q-B — SessionStart 生命周期：SDK 栈触发集 = {startup, resume, fork, compact}，clear 不是独立触发

**决议：SDK/headless 栈（CRW claude provider 的用法）下，SessionStart 在 startup（fresh 创建）/ resume / fork / compact（auto+manual）
四类转移触发；CRW 的 /clear 是 host 驱动"spawn 新会话"，从不把 /clear 发给 CLI，故 clear 转移以新会话的 SessionStart(startup) 呈现——
SessionStart(clear) 不在 CRW 代码路径上。** `[source-verified]`

**派发链**：`Nre(session,source,opts)` → `B0o`（构造 hookInput，source=第 2 参）→ `ivr` generator（nO 无 toolUseContext，§12.2）。
（`rg -a -o 'function B0o\(e,n,r,s,h,y,S,w=xf.{0,400}'`；`rg -a -o 'async function Nre\(e,n,\{sessionId:r.{0,400}'`）
sdk.d.ts:6820 `source:'startup'|'resume'|'clear'|'compact'|'fork'` `[type-contract]`。Nre 调用点穷尽：`rg -a -o '[^a-zA-Z_$0-9]Nre\(.{0,160}'`。

**逐 source 证据**：
1. **startup**：headless 入口对 fresh 会话触发（continue/resume 跳过）：
   `wt=r.continue||r.resume||Xe||mt||oI()?void 0:Ale(Q,{kind:"session-start",source:"startup",…})`，同函数带 `j!=="json"&&j!=="stream-json"`
   输出格式门禁（headless 特征）。（`rg -a -o 'r\.continue\|\|r\.resume\|\|Xe\|\|mt\|\|oI\(\)\?void 0:Ale\(Q,\{kind:"session-start",source:"startup".{0,60}'`）
2. **resume/fork**：SDK resume 路径 `st=r.forkSession||je||q!==void 0&&!hZn(q,r)?"fork":"resume"` → `Nre(aK(),st,{…resumedMessages,orphaned,…})`
   （上下文带 `r.replyOnResume` / `r.hostAnswerableToolUseIds` 等 SDK host 字段）。
   （`rg -a -o 'st=r\.forkSession\|\|je\|\|q!==void 0&&!hZn\(q,r\)\?"fork":"resume".{0,60}'`）
3. **compact（auto+manual，摘要后触发）**：两处——
   - `m0o`（replacement 应用）：`if(!z){…PostCompact(xUt)…if(!Is(L.agentContext)&&!L.options.settingsHooksOff)…Nre(L.session,"compact",…)}`，
     `z=coreBoundary!==void 0`。（`rg -a -o '.{0,200}Nre\(L\.session,"compact".{0,120}'`；`rg -a -o 'coreBoundary:w\}=e,\{toolUseContext:L\}=s,z=w!==void 0.{0,60}'`）
     调用方传 `trigger:"auto"`（`rg -a -o 'm0o\(\{replacement:Vt\?\?\[\],preCompactMessages:h,cacheSafeParams:y,querySource:r,trigger:"auto".{0,80}'`）；
     reactive 路径已产出 compacted 结果（coreBoundary 非空）时 m0o 跳过 SessionStart，避免双发。
   - `jbe`（compact 后上下文重建）：`if(!w){if(!n.options.settingsHooksOff)…Nre(n.session,"compact",…)}`，`w=Is(agentContext)`；
     调用点带 `"reactive_compact"`/`"compact_full"`/`"compact_partial"`。（`rg -a -o '.{0,200}Nre\(n\.session,"compact".{0,120}'`；`rg -a -o 'jbe\(De,we,st,"reactive_compact".{0,60}'`）
   两处门禁均为"非子代理 + hooks 开启"，**非 TUI 专属**；claude provider 无 compactInPlace（仅 `autoCompactEnabled:true`，claude-provider.ts:584），
   compact 由 CLI 内部驱动，故该 SessionStart(compact) 在 SDK 栈触发。
4. **clear（仅 /clear 命令 handler，不在 CRW 路径）**：仅有的两处 `Nre(o,"clear",…)` 都在 /clear handler generator 内
   （yield `conversation_reset`、React 状态 / coordinator mode）。（`rg -a -o 'Nre\(o,"clear".{0,120}'`）
   **CRW clear() 是 host 驱动 fresh spawn**："The headless claude binary refuses the /clear slash command … we drive the reset ourselves …
   spawn a brand-new fresh conversation Y under a new id"（session-manager.ts:5520-5546）；客户端 /clear 由 src/local-commands.ts 拦截并
   POST /sessions/:id/clear，从不把 "/clear" 文本发给 CLI。故新会话 Y 触发 SessionStart(startup)，而非 clear。

**/clear 元数据出入的诚实注记**：/clear 命令定义为 `supportsNonInteractive:!0, thinClientDispatch:"post-text"`
（`rg -a -o 'var BYo=\{type:"local",name:"clear".{0,300}'`），非交互命令过滤器
`Zje(e)=e.type==="prompt"&&!e.disableNonInteractive||e.type==="local"&&e.supportsNonInteractive` 将其纳入。
故 session-manager.ts 注释的"REPL-only / headless refuses" characterization **对 2.1.311 的命令元数据不成立**（疑为历史注记）。
但这对 **CRW parity 无影响**——CRW 从不发 /clear，headless 是否会把收到的 /clear 派发到 handler（从而触发 SessionStart(clear)）不在 CRW 代码路径上。
native 若欲实现"就地 clear"（仿 CLI /clear）属偏离 parity，需产品裁决；当前 CRW 机制下 clear=fresh spawn=startup。
`[source-verified 到命令元数据；headless 派发路径未穷尽追踪，但对 CRW 无涉]`

**设计最关键后果**：native SessionStart 触发集应为 **{startup, resume, fork, compact}**——**补 compact**（摘要后 / PostCompact 后触发，
对齐 m0o 的"PostCompact→SessionStart(compact)"顺序），**不补 clear**（CRW clear=fresh spawn，已由 startup 覆盖；补 clear source 会偏离
claude provider 实际行为）。此即 §9.1"clear/compact 另议"的决议：**compact 入 layer-1，clear 不入**。

### 13.3 Q-C — PreCompact 先于摘要；exit-0 stdout 塑形摘要，exit-2 阻断摘要

**决议：CLI 在 auto 与 manual 两条路径上都先触发 PreCompact、后做摘要 LLM 调用。PreCompact hook 的 exit-0 plain stdout 被并入自定义压缩指令
（塑形摘要）；exit-2（blockedBy）在摘要前终止压缩。** `[source-verified]`

**PreCompact 派发器 `TDe`**（lN 非 REPL runner，与 §12.2 一致）：

```js
async function TDe(e,n,r,s,h=xf){
  if(r.options?.settingsHooksOff===!0)return{};
  let y=Is(r.agentContext),S={...tf(e,Lg()),hook_event_name:"PreCompact",trigger:n.trigger,custom_instructions:n.customInstructions},
      w=await lN({session:e,hookInput:S,matchQuery:n.trigger,…});
  …
  let L=w.filter(ke=>ke.succeeded&&!ke.blocked&&ke.output.trim().length>0).map(ke=>ke.output.trim()), // exit-0 stdout
      q=w.filter(ke=>ke.blocked),Q=q.length>0?…join("\n"):void 0;                                    // exit-2
  if(y)return{...Q!==void 0&&{blockedBy:Q}};                                                        // 子代理：仅 blockedBy
  return{newCustomInstructions:L.length>0?L.join("\n"):void 0,userDisplayMessage:…,…Q!==void 0&&{blockedBy:Q}}
}
```

（`rg -a -o 'async function TDe\(e,n,r,s,h=xf\)\{.{0,400}'`；`rg -a -U -o '(?s)let q=w\.filter\(\(ke\)=>ke\.blocked\).{0,500}'`）

**auto（reactive）路径时序**：

```js
let Yn=await TDe(De.session,{trigger:"auto",customInstructions:qn??null},…);
if(Yn.blockedBy)return t(`Reactive compact blocked by PreCompact hook: …`),{skip:…};        // exit-2 阻断
…let po=await p0o(ln,y,{customInstructions:Ryt(qn,Yn.newCustomInstructions),…});            // p0o=摘要（内调 Ibe）
```

（`rg -a -o 'TDe\(De\.session,\{trigger:"auto".{0,700}'`；`rg -a -o 'async function p0o\(e,n,r\)\{.{0,300}'`）

**主 auto/manual 路径时序**：

```js
n.onCompactEvent?.({hookType:"pre_compact"});
let Qe=await TDe(n.session,{trigger:S?"auto":"manual",customInstructions:y??null},…);
xon(Qe,q,{suppressNotification:S}),                          // blockedBy → throw
y=Ryt(y,Qe.newCustomInstructions);                           // 并入 hook 指令
…let vt=LJ(y,…),dt=Oe({content:vt});                         // 构造 summaryRequest
for(;;){let dn=await Mon({messages:wt,summaryRequest:dt,…}); // Mon=摘要 LLM 调用
```

（`rg -a -o '.{0,100}TDe\(n\.session,\{trigger:S\?"auto":"manual".{0,500}'`）

**xon（exit-2 阻断）**：`function xon(e,n,r){if(!e.blockedBy)return;…throw new z8(`${Wz}: ${e.blockedBy}`)}` —— 摘要前抛错。
（`rg -a -o 'function xon\(e,n,r\)\{.{0,300}'`）
**Ryt（指令合并）**：`function Ryt(e,n){if(!n)return e||void 0;if(!e)return n;return `${e}\n${n}`}` —— hook exit-0 stdout 追加在既有指令后。
（`rg -a -U -o '(?s)function Ryt\(e,n\)\{.{0,120}'`）

**设计最关键后果**：CRW host `runAutoCompact` 先 `summarizeMergedForCompact`（session-manager.ts:6142）后 `compactInPlace`（6161）。
要对齐 CLI，native 的 PreCompact 缝必须放在**摘要之前（6142 之前）**，而非现在的 compactInPlace 入口（native-session.ts:1994）。
完整顺序：**PreCompact →（exit-2 阻断 / exit-0 stdout 并入指令）→ summarizeMergedForCompact → compactInPlace → PostCompact → SessionStart(compact)**。
把 PreCompact 放在 compactInPlace 会是"先摘要后 hook"，hook 的自定义指令无法塑形已生成的摘要、exit-2 也无法阻止摘要——违背 parity。