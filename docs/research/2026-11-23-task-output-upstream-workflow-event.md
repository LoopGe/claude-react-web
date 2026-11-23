# 任务输出实时流上游阻塞调研：workflow_event（SDK 0.3.311 / CLI 2.1.311）

> 2026-11-23。对象：backlog #5「task-output streaming」phase 2 的上游阻塞是否仍然成立。
> 一手来源：pinned SDK 包 `node_modules/@anthropic-ai/claude-agent-sdk`（**0.3.311**）、
> 其默认 spawn 的 bundled CLI 二进制
> `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`（**2.1.311**）、
> 提案 note `.agents/notes/proposed/architecture/2026-11-14-task-output-streaming.md`
> 与完整 spec `docs/superpowers/specs/2026-11-14-task-output-architecture-design.md`。
>
> **版本与身份记录**：`claude.exe` 298,870,432 字节，sha256
> `966f4b2ce962298f5dee6a942e8c47c8f97392e69e728e622319a98b259c0680`，与 SDK 包
> `manifest.json` 的 `platforms["win32-x64"]`（version 2.1.311，commit
> `e7d3b8365a0ffbe2f5dd032feb28e9fd9c7de025`，buildDate 2026-10-26）完全一致；
> 直接运行 `claude.exe --version` 输出 `2.1.311 (Claude Code)`。
>
> **方法**：静态调研。对 SDK 全部 `.d.ts` / `.mjs` 与 CLI 二进制做字符串/代码片段检索
> （二进制为 Bun standalone，内嵌 `B:/~BUN/root/chunk-*.js` 模块图，JS 源码以明文内嵌，
> 可直接 `grep -a -o` 提取上下文；本次直接在包内二进制上检索，未做提取复制，
> 也未修改任何产品代码）。唯一执行的二进制命令是 `--version`。
> 二进制证据以「chunk 名 + minified 函数标识符 + 原文片段」引用；minified 标识符
> （如 `H$n`、`Ghe`、`Yyo`）只在该 build 内有意义，跨版本不可移植。
> 行号引用以当前 checkout 的文件为准。

---

## 0. 一句话结论

**阻塞仍然成立，上游没有变化。** pinned CLI 2.1.311 在 workflow progress 通往 SDK 流的
**唯一实时发射路径**上显式过滤 `workflow_log`（脚本 `log()` 与 `console` 两个 API 产生的
都是 `workflow_log`），终态 SDK 事件同样过滤；resume journal 只保存 `agent()` 调用的
memoization 记录（launched/started/result/failed 四种），不含任何日志；SDK 与 CLI 中
均不存在 `system/workflow_event` 帧，也没有 `event_seq` / 绝对 offset / `byteLength` /
`source_revision` / `run_generation` / `workflow_output_chunk` 任何契约字段。
spec §9 要求的上游能力一项都不满足，phase 2 冻结不应解除。

| 契约要求（note 验收标准 / spec §9.1） | pinned 上游现状 | 证据 |
|---|---|---|
| 实时 `workflow_log/console` 不被过滤 | **被过滤**（实时与终态 SDK 事件都滤掉） | §2.2、§2.3 |
| `system/workflow_event` 帧 | **不存在**（SDK 类型与 CLI subtype 全集均无） | §1.1、§2.1 |
| 连续 `event_seq` / 显式 gap | **不存在**（二进制 0 命中） | §2.1 |
| 每块绝对 offset / byteLength / source_revision | **不存在**（`source_revision` 仅 git 远端错误名） | §2.1、§2.6 |
| 终态前 flush、resume/reset 语义 | journal 仅 agent memoization，无法补回日志 | §2.4 |
| shell/Monitor 连续原始字节流或可 tail 路径 | 仅 `get_task_output` 最后 8 KiB、UTF-8 解码文本 | §1.3、§2.7 |
| 失败/中断/缺失终态 artifact 仍可读日志 | 失败路径不写 artifact 文件（静态）；运行时行为需探针 | §2.3、§4 |

---

## 1. 问题一：SDK 类型面暴露了什么

### 1.1 契约字符串检索：全部为零

对 `sdk.d.ts`（10,333 行）、`agentSdkTypes.d.ts`（仅 `export * from './sdk.js'`）、
`core.d.ts`、`sdk-tools.d.ts`、`bridge.d.ts`、`browser-sdk.d.ts`、`extractFromBunfs.d.ts`
及全部 `*.mjs` bundle 检索
`workflow_event|workflow_log|workflowEvent|task_output|output_ring|event_seq|source_revision`
（大小写不敏感）：**唯一命中是 `sdk.d.ts:4355` 的 control subtype `get_task_output`**。
没有任何 workflow 实时事件类型、没有输出流帧、没有契约字段。

`SDKMessage` 联合（`sdk.d.ts:5587`）列出了全部 38 个消息成员，其中没有 workflow 事件成员。
CLI 侧的 system subtype 全集（§2.1）与之对应，同样没有 `workflow_event`。

### 1.2 SDK 实际暴露的 workflow 相关帧（task_* 家族）

workflow 运行以 `task_type: 'local_workflow'` 注册为普通后台任务，复用 task_* 帧：

- **`SDKTaskStartedMessage`**（`sdk.d.ts:6363-6406`）：`task_id`、`run_id?`、`tool_use_id?`、
  `is_backgrounded?`、`parent_task_id?`、`task_type?`，以及
  `workflow_name?`（`:6391-6394`，注释明确「Only set when task_type is 'local_workflow'」）。
- **`SDKTaskProgressMessage`**（`sdk.d.ts:6334-6361`）：`description`、`usage`、
  `last_tool_name?`、`summary?`。**类型上没有 `workflow_progress` 字段，也没有任何输出正文
  payload**——而 CLI 实际发射的 task_progress 携带未声明的 `workflow_progress`（§2.2），
  属于 undocumented 字段；本仓 `shared/`、`server/`、`src/` 对
  `workflow_progress|workflowProgress` 的检索为零命中，应用目前完全不消费它。
- **`SDKTaskUpdatedMessage`**（`sdk.d.ts:6408-6429`）：`patch`（status/description/error/
  is_backgrounded 等），注释明确「Excludes abortController, messages, result」。
- **`SDKTaskNotificationMessage`**（`sdk.d.ts:6298-6332`）：终态信号，
  `status: 'completed'|'failed'|'stopped'`、`output_file: string`（`:6312`）、`summary`、
  `usage?`、`reason?: 'worker_restart'`。日志正文只能经 `output_file` 指向的终态 artifact
  间接恢复（§2.3）。
- **run 身份**：`run_id?` 已存在（`:6303-6305` 等），注释承诺「run ids of one task sort, by
  plain string comparison, in the order the runs opened」——这是 spec §9.1 第 10 条要求的
  跨 run 可比顺序的**部分**上游基础，但它是 task 级 run 标识，不是 per-chunk event fence，
  也没有 `run_generation`/`source_revision`。
- **`background_tasks_changed`**（`sdk.d.ts:3797` 注释）：level 信号，非输出通道。

### 1.3 shell/Monitor 输出读取：8 KiB 尾部轮询

`SDKControlGetTaskOutputRequest`（`sdk.d.ts:4351-4360`）注释原文：
「Reads the end of one background shell or Monitor task's output: **at most the last 8 KiB**
the command wrote … a host **polls** it while the task runs」。
响应（`:4365-4378`）：`output`（「decoded as UTF-8」）、`total_bytes`、`truncated`。
这正是 spec §3 第 5 条与 §9.1 第 8 条判定不合格的接口：解码文本 + 尾部窗口，
不是 byte-preserving 连续流，也没有绝对起始 offset。

### 1.4 tool_progress 不含 stdout

`SDKToolProgressMessage`（`sdk.d.ts:6447-6466`）字段为
`tool_use_id/tool_name/parent_tool_use_id/elapsed_time_seconds/task_id?/heartbeat?/
subagent_type?/subagent_retry?`——**没有任何输出 payload**，印证 spec §3 第 3 条。

### 1.5 Workflow 工具本身的输入/输出类型

`sdk-tools.d.ts:2871-2901`（`WorkflowInput`）：`script`/`name`/`args`/`scriptPath`/
`resumeFromRunId`。其中 `resumeFromRunId` 注释（`:2899`）是 journal 语义的 SDK 侧一手文档：
「**Completed agent() calls with unchanged (prompt, opts) return their cached results
instantly; only edited or new calls re-run.**」——resume 恢复的是 agent 调用结果缓存，
不是日志。
`WorkflowOutput`（`sdk-tools.d.ts:4144-4174`）只有启动元数据
（`status: 'async_launched'|'remote_launched'`、`taskId`、`runId?`、`transcriptDir?`、
`scriptPath?`、`sessionUrl?`），没有输出流或日志字段。
workflow 开关设置见 `sdk.d.ts:7559-7581`（`disableWorkflows`/`enableWorkflows`/
`workflowSizeGuideline`/`workflowKeywordTriggerEnabled`）。

---

## 2. 问题二：CLI 二进制对 workflow log/console 做了什么

### 2.1 不存在 workflow_event 帧；契约字段为零

对 `claude.exe` 全文检索：

- `subtype:"workflow_event"`：**0 命中**。二进制内全部 `subtype:"…"` 字面量枚举中，
  task 家族只有 `task_started` / `task_updated` / `task_progress` / `task_notification` /
  `task_summary`，没有 workflow_event。
- `workflow_event` 的 3 处命中**全部是 `workflow_event_launch`**——远端 workflow 启动事件
  的遥测/ledger 名（上下文含 `tengu_workflow_launch_event`、`isRemoteTransport()`、
  `CLAUDE_CODE_REMOTE`、`ackProcessed`），与实时输出帧无关。
- `event_seq`：**0 命中**；`run_generation`：**0 命中**；`workflow_output_chunk`：**0 命中**。
- `source_revision`：2 处命中，均为 git 远端启动错误名
  `source_revision_not_on_remote_error` / `source_revision_stale_on_remote_error`
  （上下文是「This branch is not on the remote」、`unpushed_commit_count`），
  **不是** spec 要求的 per-chunk source fence。

### 2.2 实时 SDK 发射路径显式过滤 workflow_log（核心证据）

workflow 脚本运行时的 `log()` 与 `console` 两个 API 产生**同一种**内部 progress 事件。
vmContext 构造（chunk 含 `xTr`，导入自 `B:/~BUN/root/chunk-zg26cwk1.js` 等）：

```js
// console API → workflow_log progress
p = ho((Pe) => se({ type: "progress", toolUseID: "workflow_log",
                    data: { type: "workflow_log", message: Pe } }), r)
// 暴露给脚本的 API 对象
{ log: WZ(y.log), phase: WZ(y.phase), console: p, budget: s, setTimeout: … }
// log() 同样发 workflow_log
ss = Jt((M) => { o({ type: "progress", toolUseID: "workflow_log",
                     data: { type: "workflow_log", message: qrt(M) } }) })
```

过滤谓词与实时发射路径（同一 chunk 族）：

```js
function H$n(e){ return e.type !== "workflow_log" }        // chunk-zg26cwk1.js

onSdkEmit: (ge) => {
  let Ve = ge.filter(H$n);                                  // ← 逐批滤掉全部 workflow_log
  if (Ve.length === 0) return;                              // ← 纯 log 批直接不发
  let Me = L.getAppState()?.tasks?.[n];
  if (Me?.type !== "local_workflow" || Me.status !== "running") return;
  …
  let tn = ln ? Me.workflowProgress.filter(H$n) : void 0;   // ← 累积进度再滤一次
  Ghe({ taskId: n, toolUseId: me, description: …,
        workflowProgress: e.withholdScriptFromSdkEvents && tn ? MTr(tn) : tn })
}
```

`Ghe` 是唯一的 workflow → SDK 帧构造器：

```js
function Ghe(e){ ea({ type: "system", subtype: "task_progress",
  task_id: e.taskId, run_id: $N(e.taskId), tool_use_id: e.toolUseId,
  description: e.description, …, workflow_progress: e.workflowProgress }) }
```

结论：**`log/console` 文本在实时 SDK 流中被双重过滤**（当批 `ge.filter(H$n)` +
累积 `workflowProgress.filter(H$n)`），能活着到达 SDK 的只有 `workflow_phase` /
`workflow_agent` 元数据条目，且 riding 在 SDK 类型未声明的 `workflow_progress` 字段上。
纯 progress-only 批还有节流（`kn = Ve.every(jt => jt.type === "workflow_agent" &&
jt.state === "progress")`，`ln = !kn || yn - oe >= ki`）。
这正是 note 第 24 行拒绝的降级形态：「phase/agent/tool 事件实时、log/console 终态补齐」。

### 2.3 终态路径：artifact 里有日志，SDK 事件里仍然没有；失败路径不写 artifact

completed 路径 `Yyo`（chunk-zg26cwk1.js）：

```js
function Yyo(e,n,r,o,s,a){ let l = b(e,s,"completed",{result:n,agentCount:r,logs:o,terminal:a});
  if (l) { let p = l.withholdScriptFromSdkEvents === !0,
    c = l.workflowProgress.filter(H$n),                     // ← 终态同样滤掉 workflow_log
    k = { summary:l.summary, agentCount:r, logs: p ? [] : o, result:n,
          workflowProgress: p ? MTr(c) : c, totalTokens:…, totalToolCalls:… },
    i = _(k);
    TVo(l.outputFile, …).catch(u => t(`Failed to write workflow output for ${e}: …`));
    … } }
```

- 终态 artifact（`task_notification.output_file` 指向的 JSON）**含 `logs` 字段**
  （hidden workflow 时被置空），`workflowProgress` 仍滤掉 log。artifact 写入是
  fire-and-forget（`TVo` = truncate(0)+writeFile，失败仅打日志）。
- 日志收集有硬上限：运行包装器 `Nr` 中 `var si = 1000`，
  `if (ie.type === "progress" && ie.data.type === "workflow_log" && h.length < si)
  h.push(ie.data.message)`——终态 `logs` 最多 1000 条。
- **failed 路径 `DTr` 只更新任务注册表，不写任何 artifact 文件**：
  `function DTr(e,n,r,o,s,a){ let l = b(e,s,"failed",{error:n,agentCount:r,logs:o,terminal:a});
  if (Pf(e), l) m("task_local_workflow","task_local_workflow_failed") }`——没有 `TVo` 调用。
  killed 路径同样只构造 `{status:"killed"}` 结果对象。这静态印证 spec §3 第 4 条
  「失败或进程终止路径不保证存在（artifact）」；failed 通知是否内联携带 logs、
  进程被杀时 artifact 是否缺失，需运行时探针确认（§4）。
- 内存进度环也优先丢弃 log：`var H = 500`，当 `s.length > H*2` 时
  `if (i > 0 && T.type === "workflow_log") { i--; continue }`（先淘汰 workflow_log）。

### 2.4 resume journal 只有 agent() memoization，无法补回日志

二进制内 journal 的 append 调用**只有四种记录类型**（全文 `append({type:"…"}` 枚举）：
`launched`、`started`、`result`、`failed`。result 记录原文：

```js
await v.append({ type:"result", key:he, agentId:Ue??"", result:De,
                 ...lt && {foreignArtifactContent:!0},
                 ...ft(Ue).length > 0 && {toolsUsed:ft(Ue)} })
```

配套告警字符串直接说明语义：
「**workflow journal: did not save an agent() result, so a resumed run will re-run from
this call**」。没有任何 log/console 记录类型。SDK 侧文档同证（§1.5，
`sdk-tools.d.ts:2899`）。note 第 25 行「resume journal 也无法补回」成立。

### 2.5 redaction 语义（供 §9.1 第 5 条对照）

hidden workflow（`withholdScriptFromSdkEvents`）下：`zyo` 剥掉 `promptPreview`、把
`phaseTitle` 改写为 `phase N`、error 替换为常量
`"error details withheld for this workflow"`；`MTr` 批量映射 phase 标题；终态 `logs`
置空（§2.3）。v2 run 禁止 withhold（「A workflow v2 run cannot withhold its script」）。
即上游已有脱敏机制，未来 workflow_event 必须沿用——现状本身不构成额外阻塞，
但说明过滤是**有意设计**而非疏漏。

### 2.6 二进制身份与 spawn 路径确认

- SDK 默认 executable 解析器 `u6`（`sdk.mjs`）按
  `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude.exe` 逐候选
  `require.resolve`（`Vc = "@anthropic-ai/claude-agent-sdk"`），失败报错
  「Native CLI binary for … not found. Reinstall … without --omit=optional, or set
  options.pathToClaudeCodeExecutable」。本机 win32-x64 可选依赖已安装，
  应用 config 未设 `claudeBinary`（`~/.claude-react-web/config.json` 无该键），
  因此 **pinned SDK 默认 spawn 的就是本次检索的 `claude.exe`**。
- `extractFromBunfs.js` 只服务于「SDK 自身被 Bun 编译成单文件」的场景
  （`$bunfs`/`~BUN` 路径提取到 `%TEMP%/claude-agent-sdk/claude-agent-sdk-<hash16>/`）；
  npm 安装形态下平台包里的 `claude.exe` 是真实文件，直接 spawn。本机当前无提取副本，
  本次直接在包内二进制检索，字节即 spawn 字节（sha256 已对 manifest 验证）。
- 补充观察（**非 pinned 对象**）：本机 npm 全局另装有 `@anthropic-ai/claude-code`
  **2.1.322**（`AppData/Roaming/npm/node_modules/.../bin/claude.exe`，346,496,160 字节）。
  对其检索 `type!=="workflow_log"` 仍命中 2 处、`workflow_event"` 0 命中——
  更新的 CLI 也没有移除该过滤。此条仅作趋势佐证，结论仍以 pinned 2.1.311 为准。

### 2.7 get_task_output 的 8 KiB 契约在 CLI 侧同证

二进制内 zod schema 描述与 SDK 类型逐字一致：
「Reads the end of one background shell or Monitor task's output: at most the last 8 KiB …」、
响应字段 `output`（UTF-8 解码）/`total_bytes`/`truncated`（「the last 8 KiB」）。
`Query.getTaskOutput` 即发 `{subtype:"get_task_output",task_id}` control request。

---

## 3. 问题三：spec 的探针契约与已记录结果

spec §9（`docs/superpowers/specs/2026-11-14-task-output-architecture-design.md:235-302`）
是唯一的上游验收定义；note（`:29-31`）将其列为 phase 2 解冻前置。

**§9.1 事件与字节契约**（`:237-276`）：建议形态 `system/workflow_event { task_id, run_id,
run_generation, tool_use_id, source_revision, channel, event_seq,
event: workflow_log|workflow_phase|workflow_agent|workflow_output_chunk, offset,
byteLength, payload }`，外加 18 条必须满足项：实时 log/console 不被过滤（1）、
连续 event_seq 或显式 gap + 绝对 offset/byteLength + 非输出事件携带 per-channel 高水位（2）、
任何 terminal frame 前 flush（3）、local/remote/nested/forwarding 覆盖声明（4）、
保留脱敏（5）、字节级 stdout 需 workflow_output_chunk（6）、可定位终态 snapshot（7）、
shell/Monitor 连续原始字节流或可增量 tail 路径 + 绝对起始 offset，8 KiB 轮询不合格（8）、
终态帧携带 source revision/event fence（9）、稳定 run ID + 跨 run run_generation（10）、
独立 channel/credit 背压不得阻塞共享 SDK 控制面（11）、单事件 64 KiB 硬上限 + producer
分块（12）、per-channel 编码元数据（13）、大 notification/tool_result 的 output_file/
reference 有界重组（14）、CLI-owned TaskOutput 的 host bridge 与参数扩展（15）、
current-run snapshot API（16）、原子 stopTaskExpected（17）、终态帧显式
resultIsError/exitCode（18）。

**§9.2 强制验收探针**（`:278-302`）：bundled CLI + loopback fake Anthropic Messages
server，不依赖外部模型；19 项探针，核心包括：脚本含 phase/log/console/workflow agent/
nested agent（1）、**终态通知前收到真实 workflow_log/console**（2）、Workflow 根与侧链
join 不依赖 parent_task_id（3）、event_seq/run_generation/重连/resume/reset/flush 顺序
**必须在真实 CLI 输出中验证，模拟器通过不算生产证明**（4）、forwardSubagentText 与
redacted 场景（5）、**失败/中断/进程退出/缺失终态 artifact 时已产生日志仍可读**（6）、
workflow 内 stdout → workflow_output_chunk 含非 ASCII 与跨 chunk 字符边界（7）、
shell/Monitor 非 UTF-8 字节与远超 8 KiB/轮询速率无未标记缺口（8）、source revision reset
fence（9）、背压期间控制面不阻塞且需真实 CLI 高吞吐复验（10）、>1 MiB 前台输出 Ctrl+B
后从执行开始重放（11）、超单事件上限 payload 的 producer 分块内存证明（12）、
snapshot 一致性/冲突/缺失（13）、大 notification/tool_result 引用化（14）、
CLI TaskOutput 旧 run 读取与 pages 模式（15）、current-run snapshot API（16）、
模拟器丢事件 → 高水位表显式 gap（17）、expected-run Stop 竞争 fence（18）、
无输出 exit 的 resultIsError/exitCode null 语义（19）。

**已记录的探针结果：无。** spec 状态仍为 proposed（`:3`），note 状态 proposed（`:3`），
§10 明确「探针全部通过后，才重新进入详细 TDD 实施规划」（`:302`）。仓库内不存在
workflow_event 探针脚本或结果记录（`tests/`、`scripts/`、`.agents/notes/` 检索均无；
`~/.claude/cl_probe/` 是无关的 Android 仓库数据调研，见 §5）。
已落地的只有与实时数据无关的 phase 1（有界 roster 投影 + 分页读取 + 64M 最后保护，
spec §1 `:13`、note `:15`）。

---

## 4. 问题四：裁决——阻塞仍然成立

**裁决：BLOCKER STILL REAL（上游未变）。** 对 pinned SDK 0.3.311 / CLI 2.1.311：

**静态证据已证明（无需运行时即可定论）：**

1. SDK 类型面与 CLI subtype 全集中**不存在 `workflow_event`** 或任何等价实时输出帧
   （§1.1、§2.1）。`workflow_event_launch` 是远端启动遥测，不是帧。
2. workflow `log()` 与 `console` 产生的 `workflow_log` 在**唯一实时 SDK 发射路径**上被
   `H$n` 双重过滤（§2.2）；能实时到达的只有 phase/agent 元数据（且 riding 在未声明的
   `workflow_progress` 字段、带节流）。这是有意设计（与 hidden-workflow 脱敏同族），
   不是可配置疏漏——二进制中未发现任何开关能放行 workflow_log。
3. 终态 SDK 事件同样过滤；日志只存在于终态 artifact 的 `logs`（≤1000 条，hidden 时置空）
   （§2.3）。
4. resume journal 只有 agent() memoization 四种记录，**无法补回实时日志**（§2.4）。
5. `event_seq`/`run_generation`/`workflow_output_chunk` 零命中；`source_revision` 仅 git
   错误名——spec §9.1 的顺序/坐标/fence 契约字段全部缺失（§2.1）。
6. shell/Monitor 只有 8 KiB UTF-8 尾部轮询（§1.3、§2.7）；tool_progress 无 stdout（§1.4）。
7. failed/killed 路径不写 artifact 文件（`DTr` 无 `TVo`，§2.3）——终态 artifact 不是
   可靠的日志恢复源。
8. 补充：更新的 2.1.322 全局 CLI 仍含同一过滤（§2.6），上游短期没有自行解锁的迹象。

**需要 LIVE 探针才能定论（静态证据不能替代，spec §9.2 自己也这么要求）：**

- 运行时端到端确认：真实 workflow 运行中 SDK 流确实收不到 log/console 文本
  （静态过滤代码存在 ≠ 排除了某条未发现的旁路；探针 2 的预期结果是**阴性**）。
- failed/stopped 通知是否内联携带 logs、进程被杀/中断时 artifact 与已产生日志的可读性
  （探针 6）。
- 终态前 flush 顺序、task_progress 节流实际节奏、`workflow_progress` 未声明字段的
  实际内容与稳定性。
- 背压/缓冲行为（探针 10）——静态检索无法观测 async iterator 与进程缓冲。
- 未来上游若交付 workflow_event：§9.2 全部 19 项仍须逐一通过，且身份字段必须在
  真实 CLI 输出中验证（探针 4/9/10 明确「模拟器通过不算生产证明」）。

**对 phase 2 的含义**：note 的拒绝降级立场（「不接受 phase/agent 实时、log/console
终态补齐」）与上游现状精确吻合——现状恰好就是被拒绝的那种降级。冻结继续有效；
phase 1 已交付部分不受本调研影响。

---

## 5. 问题五：探针可行性

**可行，且本仓有同 pinned 版本的探针先例，但没有现成的 fake Messages server 脚手架。**

- **先例**：`.agents/notes/implemented/architecture/2026-11-19-user-frame-origin-identity.md:26`
  记录了「Probed against the pinned SDK 0.3.311 / bundled CLI 2.1.311 with a standalone
  `query()` harness（four option variants …）」——同一 SDK/CLI 组合已被独立 harness
  驱动过，方法可复用。
- **env 注入机制现成**：`server/providers/claude/claude-provider.ts:238-240` 展示了
  `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 注入 SDK 子进程的既有路径；
  独立 harness 直接以 env 指向 loopback 即可，无需改产品代码。
- **仓库现状**：`tests/` 只有 browser specs 与 `fixtures/app-panel-state-server.mjs`
  （app-state fixture，非 Messages server）；`scripts/` 无 probe harness；
  server 侧测试用 fake provider handle / mock fetch（native provider），
  都不是「CLI 子进程 + loopback HTTP」形态。**需要新写**：
  1. loopback HTTP server 实现 `/v1/messages`（SSE），按脚本返回确定性响应：
     诱导模型发出 `Workflow` tool_use（script 含 `phase()`/`log()`/`console.log()`/
     `agent()`/nested agent），并驱动 agent 子调用收敛；
  2. 独立 `query()` harness（temp 目录，不入产品代码），env 指向 loopback，
     录制全部 SDK 帧 + 时间戳，断言终态前是否出现 log/console 文本（预期阴性）、
     终态 artifact `logs` 内容、failed/interrupt/kill 路径的 artifact 与通知形态；
  3. workflow 特性门控：`enableWorkflows` 设置（`sdk.d.ts:7571-7573`，unset 时按 plan
     默认）与 `CLAUDE_CODE_DISABLE_WORKFLOWS` 环境变量（二进制内存在该 gate 字符串）
     需在 harness 中显式打开/排除；fake server 场景下 plan 门控行为本身也是探针要
     确认的一项。
- **确定性**：模型响应完全由 fake server 脚本化，workflow 脚本固定，无外部依赖；
  唯一非确定源是 CLI 内部节流/时序，用时间戳录制 + 宽松断言窗口处理。
- **成本边界**：验证「阻塞仍成立」只需探针 1/2/6 的最小集（一个 harness + 一个 fake
  server + 一个 workflow 脚本）；§9.2 全 19 项是**上游交付 workflow_event 之后**的
  解冻验收，现在不必实现。
- 无关项澄清：`~/.claude/cl_probe/`（build_probe2.py 等）是 Android 仓库映射数据调研，
  与本项目上游探针无关，不可复用。

---

## 6. 建议下一步

1. **维持 phase 2 冻结**，把本文件作为 note/spec 引用的上游现状证据
   （note `:9/:25`、spec §3 的每条缺口现在都有 pinned 二进制级出处）。
2. 若要把「静态证明」升级为 spec 要求的「探针证明」，按 §5 最小集跑一次阴性探针
   （终态前无 log/console + failed 路径 artifact 缺失），结果回写 spec §9.2 作为
   首条已记录探针结果；harness 放 temp/独立目录，不进产品代码。
3. 向上游（claude-agent-sdk-typescript / Claude Code）提 feature request 时直接引用
   spec §9.1 的 `system/workflow_event` 契约与 §2.2 的过滤代码位置
   （`H$n` + `onSdkEmit` + `Ghe`，CLI 2.1.311 commit `e7d3b836`），说明需要的是
   带 run 标识、严格顺序、绝对字节坐标与终态前 flush 的实时事件，而非放开过滤 alone
   （放开过滤仍缺 §9.1 第 2/3/9-13 条）。
4. 每次升级 pinned SDK/CLI 时重跑本文件的检索清单（§1.1 字符串集 + §2.1 subtype 枚举 +
   `type!=="workflow_log"` 过滤检索）作为解冻哨兵；注意 minified 标识符跨版本失效，
   应以字符串模式（`workflow_log`、`workflow_event`、`event_seq` 等）为准。