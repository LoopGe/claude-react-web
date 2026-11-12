# Native 阶段 B：子代理目录、Transcript 与工具角色设计

日期：2026-11-12
状态：待确认；阶段 A 已实现，本文不声明阶段 B 已实现
前置设计：`docs/superpowers/specs/2026-11-11-native-agent-skill-preset-parity-design.md`

## 1. 目的与范围

阶段 A 已统一主线程和嵌套 Agent 的 profile、权限、工具、Skill、effort 与 maxTurns。阶段 B 补齐这些执行记录的**可发现性和可恢复展示**：每次真实嵌套执行都有稳定身份，live、resume、fork 和 dormant 会话都能列出并打开对应 transcript，现有 Claude UI 不需要新增一套 native 展示协议。

同时增加 Claude 兼容的 `Task` 调用别名和内置 `Explore` 只读 agent profile。沿用单一 `session.v1.jsonl`、同步 final-report、depth=1 和现有后台 detach，不引入独立 child Session 或新的执行生命周期。

### 目标

- descriptor 在 nested 首次网络请求前持久化，toolUseId 在 resume/fork 后保持稳定。
- 新旧日志都能生成目录；无 descriptor 的旧 sidechain 不隐藏，也不伪造 profile。
- list/read/live watch 走 provider-aware 路径，Claude 现有文件读取与 watch 行为不回归。
- native standalone transcript 复用现有 REST/WS、normalize、scratch store 和 UI，disk 与 live 使用同一投影。
- `Task` 复用 Agent runner；`Explore` 通过 `Agent(subagent_type: 'Explore')` 获得真实只读工具面。
- 目录不复制 TasksPanel 的执行状态权威，transcript 不复制主日志到 sidecar。

### 非目标

- 不实现 continuable child、launch-time background、跨进程接管、自动完成唤醒或 `send_message`。
- 不实现 forked Skill、`session/skill`、插件技能、可配置多层 delegation 或周期 progressSummary。
- 不复制 Claude 的 `subagents/agent-<id>.jsonl` 文件布局，也不引入 DSH Cordis、activation、runId 或独立 Session。
- 不新增目录管理页面；现有 TasksPanel、Resource 视图、SubagentOverlay 和 transcript dialog 已足够。
- 不把 `READONLY_TOOL_NAMES` 权限提示集合当作 Explore 的执行边界。

### 反目标

- descriptor 尚未持久化就发起模型请求，或写入失败后仍留下“正在执行”的目录项。
- 为目录项编造不存在的定义、状态或嵌套关系。
- native sidechain 原样送入 root-only `MessageList`，导致 standalone transcript 空白。
- descriptor-only 日志追加后，缓存仍返回旧目录。
- `Task` 或 `Explore` 意外重新打开 depth>1 的 delegation。

## 2. 三方行为对照与设计结论

| 主题         | Claude Provider（SDK 0.3.311 / CLI 2.1.311）                                                                                                                    | DSH                                          | native 阶段 B 决策                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行模型     | Agent sidechain；同步和 async 均有 CLI 生命周期                                                                                                                 | 独立 child Session + activation              | 保留同步 nested `runTurn` 和 mid-flight detach                                                                                                                      |
| `Task`       | SDK 有 `Task: 'Agent'` 映射，客户端兼容 Task wire 名称                                                                                                          | 可配置 delegation tool 名称                  | 增加同 runner 的 `Task` ToolDef 别名，保留原始 toolName                                                                                                             |
| `Explore`    | 内置 agent profile，经 `Agent(subagent_type:'Explore')` 调用；denylist 禁止 Agent/Edit/Write/NotebookEdit 等，但仍允许 Bash、Skill 与一般 MCP，不是严格只读沙箱 | 通过 preset/prompt/tool policy 组合          | 增加内置 `Explore` profile，不新增 Explore ToolDef；保留原方案的 `readOnlyHint` 硬过滤，作为比 Claude 更强的有意安全边界；legacy reader 仍识别历史 Explore tool_use |
| 身份         | sidechain parent 是 toolUseId；CLI agentId 可与其不同                                                                                                           | 稳定 child id，residency 另有 runId          | native 对 API 暴露的 agentId 是本 provider 的 toolUseId；不宣称它与 Claude agentId 全局同义                                                                         |
| 日志         | live 主消息流 + 每 agent 独立 JSONL                                                                                                                             | child descriptor + parent catalog            | 单日志 descriptor；parent membership 由 descriptor/parentage 表达                                                                                                   |
| 目录状态     | task/watcher 负责执行状态                                                                                                                                       | catalog、residency、timing、outcome 分开     | 目录只管身份与元数据；TasksSnapshot 继续独占 running/async 状态权威                                                                                                 |
| transcript   | 每 agent 文件是该 agent 的直接对话，disk 行通常无 persisted parent                                                                                              | child Session 复用通用 Conversation 管线     | native 输出 standalone 直接对话投影；depth=1 时与 subtree 相同，未来不扁平拼接 descendant 对话                                                                      |
| 首条 prompt  | 独立文件包含真实 user prompt；主 mirror 可合成                                                                                                                  | child 自有 user/message                      | native 从原始 tool_use `input.prompt` 生成稳定 standalone prompt，不改写主日志或重复主 mirror                                                                       |
| live watch   | 每目录共享 fs.watch，先 watch 后 snapshot，reset+增量                                                                                                           | subscribe-first、cursor cut、去重和 gap 检测 | Claude 保留文件 hub；native 先 manager.subscribe 再读日志，UUID 去重                                                                                                |
| dormant/fork | 文件可读；plain-fork sidecar 对齐并非完整                                                                                                                       | 有自己的 own-cut/catalog 语义                | native 直接读同一日志或 fork 已复制前缀，不强迫 resume，也不套用 DSH 的独立树规则                                                                                   |
| compact      | sidecar 独立于主 compact                                                                                                                                        | projection 与模型历史分离                    | 目录/transcript 读完整日志，不应用主模型 compact floor                                                                                                              |

关键现有实现：

- Claude：`server/subagent-transcripts.ts`、`server/subagent-transcript-hub.ts`、`server/subagent-watcher.ts`、`server/routes/sessions.ts`、`src/hooks/useSubagentTranscriptStore.ts`。
- DSH：`packages/subagent/subagent/src/descriptor.ts`、`catalog.ts`、`list-children.ts`、`projection.ts`，以及 `packages/api/session-controller/src/history/listener.ts`。
- native：`server/providers/native/subagent.ts`、`native-session.ts`、`session-log/{format,replay,reader,cache,fork}.ts`、`server/session-manager.ts`。

## 3. 身份、目录与生命周期不变量

1. native `agentId = toolUseId = taskId` 只是当前 provider 的内部映射。provider-neutral 接口把它们当作不透明字符串；不得反向推导 Claude 的 CLI agentId。
2. `parent_tool_use_id` 继续表示 sidechain 父子关系，不使用 SDK task 事件里的 `parent_task_id` 替代。
3. descriptor 是目录身份事实，不是执行成功证明。首次请求后的失败可以留下 descriptor，结果由 outer tool_result 和现有 task 记录呈现。
4. 未通过输入/profile 校验、权限拒绝、pre-abort 或 descriptor 写入失败的调用不发起 nested 请求，也不产生新目录项。legacy 推导必须有真实 sidechain 证据，避免把这些失败调用重新捞回目录。
5. 目录只保存可恢复元数据。`running`、`isAsync`、完成通知和结果文本仍分别由 `TASKS_SNAPSHOT`、原 tool_result 与 assistant report 负责，不新增第二套状态机。
6. descriptor、catalog 和 transcript 都不进入主模型 history、普通 history page、搜索或 seq backfill。

## 4. Durable descriptor

### 4.1 事件形状

在 `NativeLogEvent` strict union 中新增：

```ts
{
  type: 'subagent/descriptor'
  toolUseId: string
  parentToolUseId: string | null
  kind: 'agent' | 'skill'
  toolName: 'Agent' | 'Task' | 'Explore'
  label: string
  depth: number
  profile: NativeAgentProfile | null
  timestamp: string
}
```

- `toolUseId` 是稳定目录 id，必须与 originating tool_use 完全一致。
- 阶段 B 只发射 `kind:'agent'`；`skill` 仅为后续 forked Skill 保留，不在本阶段实现。
- `toolName` 保留实际调用名。当前只发射 `Agent` 或 `Task`；`Explore` 用于旧日志兼容，新 Explore profile 经 Agent 调用时仍记录 `Agent`。
- root direct child 的 `parentToolUseId` 为 `null`、`depth` 为 `1`。字段允许未来表达更深层级，但本阶段执行器仍禁止 depth>1。
- `profile` 是实际执行快照，数组必须 detach。默认 general-purpose 可为 `null`；内置 Explore 和自定义 profile 必须保留名称、instruction 与实际字段，不从后续 store 重新解析。
- `label` 取 trim 后的 `description`；空值回退到 `subagent_type`，再回退到 `Subagent`。
- `toolName` 是对原总设计 descriptor 的补充，避免目录读取时猜角色；它必须与 originating tool_use 交叉校验，不一致按日志损坏处理。

### 4.2 写入时机与失败语义

`createAgentTool` 通过显式 `appendDescriptor` 依赖调用 `NativeSessionLog.appendDurable`，不能经 `AgentToolDeps.emit` 广播。顺序固定为：

1. 校验输入、agent/profile、pre-abort 和 depth。
2. 构造本次 nested system/tools/profile 快照。
3. `await appendDurable(descriptor)`。
4. 只允许在成功后进入 `runTurn`，因此首次网络请求一定晚于 durable descriptor。

写入失败返回 `isError:true` 的 outer tool_result，不发起 stream。outer assistant/tool_use 与错误 tool_result 仍按现有主回合协议存在，但没有 sidechain 证据，故不会形成 legacy 目录项。descriptor 成功后的 stream/tool/maxTurns/abort 失败不删除目录项。

strict v1 继续拒绝未知事件；因此含 descriptor 的日志不支持降级到旧 server 读取，格式测试必须明确这一兼容性，而不是宽松跳过未知类型。

## 5. 目录投影与缓存

### 5.1 单一缓存事实

扩展 `nativeHistoryCache` 的同一条目，在 full parse 和 incremental append 中同步维护：

- renderable user/assistant lines；
- descriptor 与目录投影；
- 供 transcript 选择的 sidechain parentage 索引。

freshness 仍由 `(path,size,mtimeMs)` 决定。descriptor-only 追加即使不产生 renderable line，也必须产生新的目录版本；禁止用 `loaded.lines` 引用判断目录是否变化。full parse、append parse、delete invalidate 必须更新同一条目，避免复制 `compactMemo` 的独立失效问题。

目录投影是纯 fold，可从日志重放重建，不是第二个持久化事实来源。compact 只影响主模型 history，不裁剪目录或 transcript。

### 5.2 新 descriptor 项

新项按 descriptor 顺序排列，并保存：

```ts
{
  agentId: string
  parentToolUseId: string | null
  toolName: 'Agent' | 'Task' | 'Explore'
  label: string
  depth: number
  profile: NativeAgentProfile | null
  metadataComplete: true
}
```

originating tool_use 用于交叉校验和取得首条 prompt，不替代 descriptor 的元数据权威。

### 5.3 Legacy 推导

没有 descriptor 时，从主 assistant 的 `Agent`/`Task`/`Explore` tool_use 与 durable sidechain parentage 推导：

- 必须同时存在 originating tool_use 和至少一条以该 id 为 parent 的 durable user/assistant sidechain；没有实际执行证据的调用不列入目录。
- `agentId` 取 toolUseId，`toolName` 保留原名，`label` 取 `input.description`，缺省 `Subagent`。
- `profile:null`、`metadataComplete:false`，即使部分字段可猜也不补造定义快照。
- depth 沿 parent 链计算；无法确定时回退 1，检测到 cycle 或断链时不虚构更深关系。
- legacy 项以 originating tool_use 的顺序排列。descriptor 与 legacy 同 id 时 descriptor 优先，列表只出现一次。
- `Skill` 不进入本阶段 legacy Agent 目录；forked Skill 属于后续项目。

REST 继续返回 `{ subagents: string[] }`，丰富元数据仅用于 provider 内部读取与 watch，不改变现有客户端发现路径。

## 6. Standalone transcript 投影

### 6.1 选择直接对话

目录可以沿 parent 链识别关系，但单个 transcript 只返回目标 agent 的直接对话，即 persisted `parent_tool_use_id === agentId` 的 durable 消息。depth=1 时这也等于整个 subtree；未来出现 descendants 时，各自打开自己的 transcript，不把多层对话扁平混入一个视图。

unknown agent 返回 `{ messages: [] }`，与 Claude 缺文件时的普通空态一致。已知 agent 只要有合法 `input.prompt`，即使 descriptor 已写入而 nested 尚无输出，也返回 prompt-only transcript；没有合法 prompt 且没有输出时才是空数组。真实读取/解析错误仍然抛出，不能伪装为空。

### 6.2 重投影 parentage

native persisted parent 是 outer Agent toolUseId，而 standalone `MessageList` 默认只渲染 root 行。输出前必须做仅用于 standalone 的投影：

- assistant 与真实 user prompt 的 `parent_tool_use_id` 改为 `null`。
- tool_result user frame 的 parent 由自身 `tool_use_id` 决定，与 Claude 独立文件的 normalize 结果一致。
- descriptor、task/system 生命周期事件不送入 transcript frame。
- 主 history page 和 SubagentOverlay 仍保留真实 parentage，不能共用此重写。

REST snapshot、WS initial reset 和后续 live increment 必须调用同一个 projection/normalize 函数，客户端不出现 provider 分支。

### 6.3 首条 prompt 与最终报告

native 当前只把 nested prompt 放进模型 history，没有 durable sidechain user frame。阶段 B 从 originating tool_use 的 `input.prompt` 合成 standalone 首条 user message：

- `uuid = 'native-subagent-prompt:' + agentId`，保证 REST 与 WS 去重稳定。
- `session_id` 使用当前会话，`parent_tool_use_id:null`，正文严格等于原 prompt。
- timestamp 取 descriptor；legacy 取 originating assistant 的 timestamp。
- 仅在存在真实字符串 prompt 时生成，不为损坏/缺失输入编造文本。若未来日志已有真实 sidechain prompt，以真实消息为准，不再合成。

该合成只存在于 standalone 读取层，避免现有主 mirror 的合成 prompt 与新增 durable user frame 重复。最终 assistant report 已在日志中，source 不再追加第二份结果；现有组件的 trailing fallback 继续处理缺失报告的旧记录。

## 7. Provider-aware list/read 与 REST

在 `AgentProvider` 增加可选 provider-level reader，而不是依赖 live `ProviderSessionHandle`：

```ts
interface ProviderSubagentReader {
  listSubagents(session: ProviderSessionRef): Promise<string[]>
  readTranscript(session: ProviderSessionRef, agentId: string): Promise<unknown[]>
}
```

- Claude reader 复用现有 SDK standalone scan 和 `readSubagentTranscript` 文件 helper；native 的丰富 catalog 仅留在 provider 内部，不要求 Claude 编造 toolName、depth 或 profile。
- Native reader 从 `stateDir` 与同一缓存读取，不需要 live Query，也不恢复 dormant session。
- `SessionManager` 从 live session 或 persisted metadata 解析 provider，统一检查 `supportsSubagentTranscripts`，再返回 list 的 string[] 或 read 的 messages。
- `GET /sessions/:id/subagents` 和 `GET /sessions/:id/subagents/:agentId` 都经 manager，不再由 route 直接 import Claude 文件 helper。
- list 去掉不必要的 `requireLive`，使 Claude/native dormant 都遵守原有 disk-read 语义；未知 session/provider/capability 仍走明确 404/501，而非空列表。
- 现有 handle `listSubagents` 可在兼容期保留，但新 manager 路径不能再次要求 live。

只有 list/read/watch 验收全部通过后，才把 native `supportsSubagentTranscripts` 置为 true。

## 8. Provider-neutral live source

保留当前 WS 协议：`reset:true` 全量 snapshot，随后 append batch；客户端 REST bootstrap、WS reset、UUID 去重和重连逻辑不改。

```ts
interface SubagentTranscriptSource {
  snapshot(sessionId: string, agentId: string): Promise<unknown[]>
  watch(sessionId: string, agentId: string, emit: (frames: unknown[]) => void): () => void
}
```

### Claude source

现有 `SubagentTranscriptHub` 继续负责文件 tail：watch-before-snapshot、complete-line、debounce、offset、shrink/replace reset、目录重试和 UUID 重叠。completion watcher 是另一条生命周期，不能并入展示 hub。

### Native source

1. 对 live session 先调用 `SessionManager.subscribe`（live-only，不 replay），把到达帧放入该订阅者自己的缓冲区。
2. 再读取同一日志 snapshot，应用 standalone 投影并发出 initial reset。
3. 按到达顺序处理缓冲帧，筛选目标直接对话、做同一投影，并按 UUID 去掉 snapshot 与 live 的重叠。
4. 每个 watch 记录合成 prompt 是否已发送或已确定无合法 prompt。若订阅建立时 descriptor 尚未可见，initial reset 可以是空数组；prompt 状态未决期间，每个后续 live frame（包括不输出的 stream_event 和 outer tool_result）都先触发一次目录重读。descriptor/legacy 项一旦可见，立即发送合成 prompt，再发送同批首个可渲染 frame，因此请求失败或尚无 assistant 输出时也不依赖重连。若 initial reset 已含 prompt-only transcript，后续只发实际增量。
5. 后续帧继续以 append batch 推送；每个订阅者有独立队列，慢客户端不能阻塞主 pump。
6. 不得再次迭代 `NativeSession.messages`；它是单 consumer stream，只能使用 manager fan-out。
7. dormant watch 返回 disk snapshot，不强迫 resume；之后要建立 live watch必须重新订阅。session delete/unload 后由订阅清理函数释放监听。
8. 重连由客户端重新执行 subscribe-first + snapshot，服务端不把内存 hint 当作比日志更新的权威。

`frame-bridge` 按 session provider/capability 选择 source，不再接收一个无条件 Claude hub。native 在 capability 开启前的读写订阅都明确拒绝，而不是落到 Claude reader 后显示空内容。

## 9. Task 与 Explore 工具角色

### 9.1 共享 runner

`createAgentTool` 改为可指定 `toolName:'Agent'|'Task'` 的同一工厂。两者共享 schema、profile 解析、descriptor、fresh history、parentage、final report、maxTurns、后台 detach 和错误语义。

nested 工具列表同时移除 `Agent` 和 `Task`，对应 prompt guidance 也一并省略。`Explore` 不是 ToolDef，因此不存在第三个可递归入口。profile allowlist 继续按真实工具名工作：`tools:['Agent']` 不会隐式获得 Task。

### 9.2 内置 Explore profile

`subagent_type:'Explore'` 是保留的内置名称，不能被自定义 store 定义覆盖。它使用固定探索 instruction 和只读 role filter；`model` 输入仍可覆盖，未指定时继承父模型。主 preset 的 store 校验不因该内置名称而自动接受 Explore 为主会话 preset。

工具过滤顺序为：depth → baseToolProfile/profile allow → deny → MCP ownership → Explore read-only role。即使父会话或 nested permission 是 bypass，写工具也不会出现在 Explore 请求中。

在 `ToolDef` 增加 `readOnlyHint?: boolean`，缺省为 false：

- Read、Grep、Glob、LS、WebFetch、WebSearch、Skill、TaskOutput 只有在其当前 native 实现确实不产生写副作用时才标记 true；Bash、Write、Edit、NotebookEdit、TodoWrite、AskUserQuestion 等不得凭名称或“也可用于读取”放行。
- MCP adapter 把 `annotations.readOnlyHint === true` 传入 ToolDef；缺省或其他 annotation 值一律 false。
- 这里不以 Claude Explore 的 denylist 反推 native 工具面：Claude 仍允许 Bash、Skill 和一般 MCP，而本阶段沿用原总设计的更强只读边界。Skill/TaskOutput 的标记只声明工具自身不执行写入，不保证其返回文本不会建议模型采取后续动作。
- Explore role filter 只接受 `readOnlyHint === true`，所以自定义 MCP 写工具和未声明工具都被 fail-closed 排除。

`supportedAgents` 增加内置 Explore 的描述，使其与 general-purpose 一样可发现；descriptor 保存该内置 profile 快照。

## 10. 实施单元边界

后续实现计划按以下可独立审查的单元拆分，不在本设计写产品代码：

1. **Descriptor 与格式**：strict event、appendDurable 接线、首次请求顺序、失败回归。
2. **目录与缓存**：descriptor/legacy fold、同条目增量缓存、compact/fork/cycle 兼容。
3. **Standalone reader**：直接对话选择、parent 重投影、稳定 prompt、空态与错误。
4. **Provider list/read + live source**：manager/route/provider capability、Claude 保持、native subscribe-first watch。
5. **Task 与 Explore**：共享工厂、depth 关闭、readOnlyHint 与 MCP 传播、内置 profile。
6. **端到端验收**：真实 SessionManager/Provider、REST/WS、live/dormant/resume/fork、后台 detach 和 UI normalize 契约，最后开启 capability 并更新文档/Agent Note。

## 11. 验收标准

### Descriptor 与目录

- descriptor 先于首次 nested 请求落盘；写入失败、未知/unsupported agent、权限拒绝和 pre-abort 均无请求、无新目录项。
- descriptor-only 追加立即可见；同 id descriptor/legacy 不重复，compact 后旧目录仍可读。
- live、dormant、resume、fork 的 list/read 使用同一 agentId 和直接对话，fork 切点后的记录不泄漏。
- 旧 sidechain 得到 `metadataComplete:false` 项，缺 profile 不补造；无 sidechain 证据的 tool_use 不列入。

### Transcript 与 live watch

- native standalone 首条是稳定 prompt，后续 assistant/tool_result 在现有 root-only `MessageList` 中实际可见，final report 不重复。
- descriptor 已写入但尚无 nested 输出时返回 prompt-only transcript；descriptor 前订阅处于空 reset 时，后续 frame 触发目录重读并补发合成 prompt，首个可渲染 sidechain 与 prompt 同批到达，失败只有 outer tool_result 时也能补上 prompt，重连后仍不重复。
- subscribe 与 snapshot 之间到达的帧不丢失、不重复；慢订阅者不阻塞 pump，断线重连可恢复。
- unknown id 返回普通空 transcript；损坏日志仍响亮报错。
- Claude 现有 REST/文件 watch/offset/reset 测试全绿，dormant list/read 不再被 live-only guard 截断。

### Task 与 Explore

- Agent/Task 各只产生一个原始 outer tool_result 和一个顶层 result，descriptor toolName 不丢失，后台 detach 后继续推送 transcript。
- nested 不出现 Agent/Task 或其 guidance，depth=1 不被别名绕过。
- Explore 在 parent bypass、profile allow 和 MCP 混合条件下仍只获得 `readOnlyHint:true` 工具；未声明 MCP 和写工具不可见。
- AgentDefinitionStore 不能覆盖内置 Explore；profile 快照在定义后续变化时仍稳定。

### 最终门禁

- 新增 native descriptor/cache/reader/watch/role 单元测试和真实 manager E2E。
- Claude transcript 相关现有测试、完整 native suite、SessionManager、route/WS、client transcript store 测试通过。
- `npm run typecheck`、`npx vitest run`、`npm run lint`、`npm run verify:agent-notes` 和 `git diff --check` 通过。
- 最终 whole-workstream review 通过后才开启 capability 的文档完成声明；不提前声明 Stage C 或后续能力。

## 12. 明确取舍

- 采用 descriptor + 单日志投影，而非 DSH 独立 Session/catalog 事务或 Claude 文件布局，换取最小事实来源和可靠 fork/resume。
- 目录不复制 DSH timing/status，也不模拟 Claude watcher；现有 task 生命周期已覆盖这些职责。
- standalone prompt 从原 tool_use 推导，而非新增 durable prompt frame，避免改变主 mirror 和写放大的同时保留完整展示。
- Explore 按当前 Claude 实现作为 profile，而非按旧总设计新增 ToolDef；历史 Explore tool_use 仅作为兼容输入保留。其工具面不复制 Claude 允许 Bash/任意 MCP 的宽松残余能力，而保留原方案已批准的 `readOnlyHint` 硬过滤，优先消除绕过写边界的歧义。
- native fork 保留已复制子代理记录，不套用 DSH ordinary-fork 独立 catalog 树规则，因为本应用 fork 的用户语义是延续同一会话历史。
