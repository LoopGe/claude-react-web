# Native 子代理、技能与 Preset 对齐设计

日期：2026-11-11
状态：阶段 A/B/C 已实现；controller 的 whole-workstream 最终 review 与后续 push 未在本实现任务中声明完成
阶段 B 详细设计与实现记录：[Native 阶段 B：子代理目录、Transcript 与工具角色设计](2026-11-12-native-subagent-transcript-design.md)

## 1. 背景与问题

native 已具备单层同步 Agent、本地技能目录和自定义 `subagent_type` 的基本执行能力，但当前存在三类问题：

1. **行为可能误导用户**：主线程 `opts.agent` 被 manager 校验和持久化，却没有应用到 native 会话；自定义 agent 的多数约束字段被静默忽略。
2. **持久化视图不完整**：sidechain 已在 `session.v1.jsonl` 中，但没有正式的子代理目录、按 agentId 读取 transcript 的接口和实时订阅适配器。
3. **技能的用户输入与模型输入被写在同一事件里**：live ring 保存 `/demo args`，磁盘却保存展开正文，导致 resume/fork 展示和搜索与 Claude 不一致。

本设计先修正这些正确性和可恢复性问题，不追求一次性实现 Claude/DSH 的全部高级编排能力。

## 2. DSH 实际行为对照

以下结论来自 DSH 当前实现，而不是由功能名称推断。

| 行为                   | DSH                                                                                               | native 当前                                   | 设计结论                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 子代理工具名           | `tool-subagent` 的 `toolName` 可配置，默认 `subagent`；没有固定的 Agent/Task/Explore 三件套       | 只有 `Agent`                                  | Task/Explore 是 Claude 兼容项，不是 DSH 对齐的前置项                                      |
| 默认嵌套深度           | Host 默认 `maxDepth=1`；depth 持久化且只能加深不能减小                                            | 子代理工具列表移除 Agent，固定一层            | 当前一层限制与 DSH 默认一致；本批不扩层，只把 depth 显式记录                              |
| 同步结果与后台激活     | `startActivation` 立即返回 child name，完成通知随后自动投递；工具可并发                           | 同步嵌套 `runTurn`，最终报告作为 tool_result  | 不用 DSH activation 替换现有 Claude 同步语义；continuable/launch-background 另项          |
| fresh / fork 子代理    | spawn fresh history；fork 以最后一个已完成 `turn/end` 为界继承父日志前缀                          | 只有 fresh nested history                     | forked 上下文继承属于后续执行模式，不与普通 Agent 混写                                    |
| 子代理目录             | 父日志有 `subagent/catalog`，每个 local child 有独立 Session；支持 direct children 和 descendants | sidechain 与主消息共用一个日志，无正式目录    | 保留单日志，增加 history-only descriptor/catalog，派生子代理视图，不复制独立 Session 架构 |
| 子代理 timing/progress | 有 descriptor、catalog 和 turn timing projection；未发现 Claude 式周期 `progressSummary`          | 有 sidechain 和后台 task 生命周期，无周期摘要 | 周期 prose summary 不作为 DSH 对齐项；先做目录、状态和 transcript                         |
| 主 preset              | Cordis 插件组合；`agent-preset/selected` 写入日志，保留 revision                                  | `opts.agent` 未应用                           | 借鉴“选择可恢复、revision 可保留”，不引入 Cordis                                          |
| preset 切换时机        | 仅 blank session 可改；首个 turn 后 `agent-preset/locked`                                         | manager/Claude 暴露 live `setAgent`           | 保留本应用已有的 next-turn live switch，作为与 DSH 的明确差异；选择事件在下一轮前落盘     |
| 子代理 preset          | spawn provider 支持独立 preset；fork provider 不支持独立 preset，继承父 composition               | `subagent_type` 只应用 prompt/model           | 用统一 profile 表达字段，明确 fresh 与继承模式的差异                                      |
| 模型调用 Skill         | `skill` 工具返回正文，没有 forked Skill runner                                                    | 同样返回正文                                  | 已对齐基本路径                                                                            |
| 用户 `/skill`          | 原始用户消息保持不变，另追加 `skill-invocation` instructions 消息                                 | 日志改写为展开正文                            | 直接采用“原始消息 + 独立技能注入事件”                                                     |
| forked Skill           | 技能包内没有通用 forked Skill 执行器；另有通用 fork subagent provider                             | 不支持                                        | 不是 DSH 基线缺口；作为 Claude 兼容的后续独立项                                           |
| 插件/打包技能          | provider registry + rank/scope，支持自定义和 bundled roots                                        | 用户/项目目录                                 | bundled/provider 可复用目录视图；Claude Marketplace 插件技能依赖插件项目                  |
| context usage          | 粗粒度 system/tools/message tokens；无 per-skill/frontmatter token 桶                             | input + cache usage                           | per-skill token 明细从对齐清单移除                                                        |

关键 DSH 证据：

- `packages/subagent/tool-subagent/src/index.ts`：可配置工具名、activation 结果、`agentOptions`、preset、depth。
- `packages/subagent/subagent/src/depth.ts`：持久化 delegation depth。
- `packages/subagent/subagent/src/catalog.ts`、`list-children.ts`：父日志目录和 descendant 遍历。
- `packages/subagent/subagent-fork-in-process/src/index.ts`：fork 只继承已完成 turn 前缀。
- `packages/preset/agent-preset-registry/src/session.ts`、`index.ts`：选择 projection、revision 保留、blank-only switch。
- `packages/skill/tool-skill/src/index.ts`：原始 `/name` 消息之外追加技能 instructions，目录和工具可见性一致。
- `packages/skill/skill/src/index.ts`：provider registry、`SkillInvocationSource`、统一 `renderSkillContent`。

## 3. 目标、非目标与反目标

### 目标

- 主线程 preset 真正生效，且 create / next-turn switch / clear / resume / fork / respawn 行为一致。
- 自定义 agent 的核心行为字段有统一、可测试的解析与执行路径，不再静默失效。
- 子代理有 durable descriptor、列表、独立 transcript 读取和 live subscription。
- 用户 `/skill` 在 live、disk replay、search 中始终保留原始输入，模型历史仍包含展开指令。
- 保持现有同步 Agent、本地 Skill、后台 detach 的协议和 UI 兼容性。

### 非目标

- 不引入 DSH 的 Cordis 插件加载器或独立 continuable child-session 体系。
- 不改变同步 Agent 的 tool_result/final-report 契约，不改造成 DSH activation。
- 本批不实现 launch-time `run_in_background`、跨进程接管、自动完成唤醒或 continuable `send_message`。
- 本批不实现 forked Skill、Claude Marketplace 插件技能、嵌套深度扩层或 per-skill token 明细。
- 不复制 Claude 的 `subagents/agent-<id>.jsonl` 文件布局。

### 反目标

- 不接受“UI 显示 agent 已选择，但执行配置未变化”。
- 不把 `READONLY_TOOL_NAMES` 当作 Explore 的实际强制工具过滤；它是权限提示集合，不是执行沙箱。
- 不为 native transcript 再维护一份可能分叉的 sidecar。
- 不通过把展开正文重新塞回原始用户事件来修复搜索。

## 4. 统一 NativeAgentProfile

新增一个纯数据、纯函数解析层，主线程和嵌套 Agent 共用，但保留不同的默认值和优先级。

```ts
interface NativeAgentProfile {
  name: string | null
  instruction?: string
  model?: string
  tools?: readonly string[]
  disallowedTools?: readonly string[]
  mcpServers?: readonly string[]
  skills?: readonly string[] | 'all'
  permissionMode?: string
  maxTurns?: number
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}
```

### 4.1 首批字段矩阵

| 字段              | 主线程       | 嵌套 Agent   | 规则                                                                |
| ----------------- | ------------ | ------------ | ------------------------------------------------------------------- |
| `prompt`          | 是           | 是           | 主线程附加到 base system；嵌套附加到 subagent system                |
| `model`           | 是           | 是           | persona model 是 override，不改写 base model                        |
| `tools`           | 是           | 是           | 在 builtins + 当前 MCP 全量重建后做 allowlist；`[]` 表示无工具      |
| `disallowedTools` | 是           | 是           | 在 allowlist 后最后扣除；FQN 与工具名按同一规则匹配                 |
| `mcpServers`      | 是           | 是           | 按已解析 server metadata 过滤，不解析 FQN 字符串猜 server           |
| `skills`          | 是           | 是           | 生成同一 catalog 的 scoped view，exclude 后 override 不能复活       |
| `permissionMode`  | 是           | 是           | 下一轮生效；嵌套通过 requestPermission 的模式上下文，不改父会话字段 |
| `maxTurns`        | 是           | 是           | `runTurn` 接受显式轮数上限；到顶返回明确的非成功结果，不能静默继续  |
| `effort`          | 仅字符串枚举 | 仅字符串枚举 | 数值 effort 尚无 native 映射，显式拒绝                              |

以下字段本批不支持，**显式拒绝选择并列出字段名**，不得继续静默忽略：

- `background`：等待 launch-time background 设计，不能用 mid-flight detach 冒充。
- `initialPrompt`：不能在未确定“是否自动产生用户 turn”的情况下隐式发送消息。
- `memory`、`observer`、`observerMessage`、`criticalSystemReminder_EXPERIMENTAL`、`omitClaudeMd`：没有对应 native 语义。
- 数值 `effort`。

实现这些字段后从拒绝矩阵移除；错误信息同时指出 native 已支持的核心集合。

### 4.2 工具与 MCP 过滤顺序

每个 turn 仍先按当前连接状态重建完整工具集，再应用 profile：

1. depth/执行模式限制（例如一层子代理是否还能看见 Agent）。
2. `tools` allowlist。
3. `disallowedTools`。
4. `mcpServers` server-scope 过滤。
5. 特殊角色过滤（Explore 只保留实际只读工具）。

MCP 过滤复用 `mcpToolServers` 的 server ownership 元数据，支持动态 MCP replace/toggle 后的下一轮快照，不新增第二套连接。

嵌套 Agent 从当前完整 builtins + MCP 快照开始，只先应用会话的 `baseToolProfile`，再应用自己的 profile。主线程 persona 的工具过滤不会约束嵌套 Agent；会话级 base 工具限制仍然是嵌套能力的上限，避免子代理绕过用户为基础会话选择的工具面。

Explore 使用独立的只读 profile 和探索 instruction。只有具备明确只读元数据的内置工具和声明 `readOnlyHint` 的 MCP 工具才可进入；Bash/Write/Edit/NotebookEdit 等即使权限模式是 bypass 也不会出现在 Explore 的工具集中。

### 4.3 Skill scoped view

`NativeSkillCatalog` 保留一份发现缓存，新增只读 view，而不是每个 agent 重扫磁盘：

- `section(policy)`、`bodyOf(name, policy)`、`commands(policy)`。
- 继承同一 override 层，但 profile 的 allowlist 是硬过滤。
- 主 preset 清空时恢复 session 的 base skill policy。
- 嵌套 Agent 获得自己的 `createSkillTool(view)`，不再共享父会话的 Skill 工具状态。

### 4.4 `maxTurns` 的精确截止语义

`maxTurns` 必须是正整数，表示本 nested run（或主线程当前 prompt）允许发起的最大模型 API round 数，不是工具调用数。

- 未达到上限时，tool_use 正常走权限与执行路径。
- 第 N 个允许的 round 如果返回 tool_use：**不再执行这些工具，也不再请求权限**，避免超过预算后继续产生副作用。
- assistant frame 先按现有 durability 路径落盘；随后为该 round 的每个 tool_use 生成 `is_error: true` 的 synthetic tool_result（文本为 `max turns reached (N); tool not executed`），保证模型历史和 UI 没有未回答的 tool_use。
- 主线程随后走现有 error result + `turn/end` 路径，session 保持可用，用户可以发下一 prompt。
- 嵌套 Agent 以 `is_error: true` 的 tool_result 返回父线程，内容包含截止说明；若已有非空 assistant 文本，附在最后，不能把部分报告伪装成成功。
- 即使第 N 个 round 没有 tool_use，只要没有自然结束，结果仍是非成功；session/subagent 本身不被销毁。若第 N 个 round 以正常 end_turn 收尾，则按正常完成处理，不因刚好达到上限而失败。

## 5. 主线程 preset 状态模型

### 5.1 base 与 effective 分离

会话同时保存：

- `baseSystem` / `baseModel` / `basePermissionMode` / `baseEffortLevel` / `baseSkillPolicy` / `baseToolProfile`：清空 persona 后恢复的配置。
- `currentProfile: NativeAgentProfile | null`：当前生效的 persona。
- `effectiveModel` / `effectivePermissionMode` / `effectiveEffortLevel`：实际请求与 broker 使用的配置。

所有受 persona 影响的控制项遵循同一优先级，而不只 model：

- persona 定义了某个字段时，该字段覆盖 base，但不改写 base。
- `setModel`、`setPermissionMode`、`applyFlagSettings({effortLevel})` 总是更新对应 base；只有当 persona 未固定该字段时才同时改变 effective 值。persona 已固定的字段继续由 persona 决定。
- 清除 persona 恢复全部 base，不能只恢复 model 而把 bypass permission 或 persona effort 留在会话里。
- `SessionInfo.model` / `permissionMode` / `effortLevel` 暴露**下一轮 effective 值**，保证权限 chip 和 broker 不会显示/执行不同的模式；base 值另外持久化在 `session/agent` 的 `base` 快照中，供 clear/resume 恢复。
- 正在运行的 turn 使用开始时的 profile 快照；切换从下一轮开始。
- `session/agent.base.toolProfile` 保存 create-body 的 tools / allowedTools / disallowedTools / aliases / toolConfig，使跨进程 resume 后 clear 也能恢复 base 工具集。后续 model/permission/effort/toolProfile base 变化会追加携带当前 definition 的新快照，clear 不恢复选择时的旧 base。
- 嵌套权限通过 `canUseTool` context 的可选 `permissionMode` 传递。broker 统一按 `options.permissionMode ?? session.permissionMode ?? 'default'` 判定，不改写父 `SessionInfo`；因此 parent bypass + nested default 仍产生权限请求，parent default + nested bypass 才自动放行。

### 5.2 `session/agent` 选择事件

新增 history-only 日志事件：

```ts
{
  type: 'session/agent',
  name: string | null,
  definition?: StoredAgentDefinition,
  base: {
    model: string,
    permissionMode: string,
    effortLevel?: string,
    skillPolicy?: readonly string[] | 'all',
    toolProfile?: SessionToolProfile
  },
  droppedAgent?: { name: string, unsupportedFields: readonly string[] },
  timestamp: string
}
```

- create 时选择、next-turn switch 和 clear 都在生效前 append + flush。
- 保存定义快照，而不只保存名字，避免后续编辑定义悄悄改变已存在会话的 composition。
- resume/fork 以切点之前最后一个 `session/agent` 为准；无事件表示无 persona。
- 旧日志没有事件时，使用 `SessionMeta.agent` 做一次兼容解析并补写事件；这不 retroactively 改变旧 turn，只影响恢复后的下一轮。
- **旧定义包含本批不支持字段时，不让 resume/fork/clear 失败，也不恢复一个被削弱的 persona。** 改为恢复普通会话（`name: null`），同时清空 `SessionMeta.agent`，在事件中记录 `droppedAgent`（旧名字和 `unsupportedFields`）并发出一条 informational 提示，让用户重新选择兼容 agent。新 create/switch 仍严格拒绝这些字段；兼容降级只针对已有元数据，且必须可见。
- `SessionMeta.agent` 仍保存当前名字供 SessionInfo/UI 使用；事件中的快照是 native 实际 composition 的权威。

这是对 DSH `agent-preset/selected` + retained revision 的复用。区别是：本应用已有 Claude live `setAgent`，因此允许在 turn 之间切换，而不采用 DSH 的首轮后锁定。

构造路径不能等待异步 durable append。fresh create 在打开日志前完成定义校验，再把 `session/context` 与首个 `session/agent` 作为同一份同步 seed 原子写入；不支持字段的 create 不留下日志或 manager 元数据。旧日志迁移在构造期间同步 append，并通过现有后台 flush 落盘；运行中的 switch/clear/base 更新则 `await appendDurable`，成功后才更新 effective 状态。

`appendDurable` 拥有选择事件的 writer reservation 与回滚：先 flush 普通 pending 事件；真实 write/sync 失败时截断到 reservation 前的已 flush 字节位置，并以连续 seq 重新缓冲全部非 reservation 事件。被取代的 writer 绝不截断接替者的文件。reservation 已成功 flush 后的 close 不回滚 durable 事件；close 与真实写失败竞争时，其 allow-closed flush 负责写回恢复的普通字节，已关闭 writer 不重新开放公共 `append()`。

### 5.3 restart 与派生操作

- resume/fork/clear/respawn 重建同一个 profile 快照。
- New-like-this 继续只携带名字，在新会话中解析最新定义。
- restart 增加 `provider` 之外的 `agent` 保留，否则新会话会静默退回普通 persona。
- 子代理 `subagent_type` 与主 preset 独立；主 preset 不会自动成为所有子代理的强制 preset。

## 6. 子代理目录与 transcript

### 6.1 durable descriptor

在嵌套执行第一次网络请求前写入并 flush 一个 history-only 事件：

```ts
{
  type: 'subagent/descriptor',
  toolUseId: string,
  parentToolUseId: string | null,
  kind: 'agent' | 'skill',
  label: string,
  depth: number,
  profile: NativeAgentProfile | null,
  timestamp: string
}
```

- `toolUseId` 就是 native 的 agentId，resume/fork 后保持稳定。
- root 的 direct child 为 `parentToolUseId: null`，depth 为 1。
- 记录 profile 快照，保证 transcript 展示和后续 continuable 扩展能知道实际执行配置。
- descriptor 不是模型消息，不进入主模型 history，也不制造额外顶层 result。
- 只有真正开始 nested run 才写；未知 agent/无效输入/权限拒绝不写成功目录项。

### 6.2 列表与读取

- `listSubagents()` 从 descriptor 事件按日志顺序返回 toolUseId，live 和 dormant 都可用。
- **旧 sidechain 不隐藏**：没有 descriptor 的日志通过 Agent/Task/Explore tool_use 与 sidechain parentage 推导 legacy 目录项，使已有会话也获得 transcript UI。legacy 项标记 `metadataComplete: false`，label 取 `input.description`（缺省为 `Subagent`），depth 能由 parent 链推导则使用，否则为 1，`profile: null`，不得编造定义快照。新 descriptor 与推导项同 id 时以 descriptor 为准。
- `readSubagentTranscript(agentId)` 从同一日志筛选目标 agent 的直接对话，并在 standalone 读取层重投影 parentage、合成稳定 prompt，复用现有 normalize。
- 不为每个 agent 再写 JSONL，不引入第二个事实来源。
- descriptor/catalog 读取复用 session-log `(path,size,mtimeMs)` 缓存和增量解析，避免每次打开卡片都全量扫日志。
- `Task`/`Explore` 的 tool_use 名称保留在原始 assistant frame 中，目录不把它们归一化成 Agent。

### 6.3 live subscription

把当前 Claude 文件 tail hub 抽象成 provider-neutral source：

```ts
interface SubagentTranscriptSource {
  snapshot(sessionId: string, agentId: string): Promise<unknown[]>
  watch(sessionId: string, agentId: string, emit: (frames: unknown[]) => void): () => void
}
```

- Claude source 保持现有文件 watcher。
- Native source 先建立 manager live fan-out 订阅，再读取日志 snapshot；缓冲在 snapshot 后按序 drain，并用 uuid 去重。
- snapshot + watch 必须先建立订阅再读取，使用 uuid 去重，避免 replay/live 间隙。
- REST `/sessions/:id/subagents` 和 `/:agentId` 通过 provider-aware reader，不再直接调用 Claude 文件 helper。
- 验收后才开启 `supportsSubagentTranscripts`。

## 7. Task 与 Explore

- `Task` 复用 `createAgentTool` 的同一 nested runner 和 schema，作为 Claude 工具名兼容入口。
- `Explore` 复用 runner，但固定只读 profile + 探索 prompt，不允许调用方用 `tools` 输入扩大权限。
- DSH 的默认 depth=1 保持不变；descriptor 记录 depth 后，未来若要配置更深层级，不必再反推父子关系。
- `Agent` / `Task` / `Explore` 的 parentage、目录、最终报告和后台 detach 共用一套逻辑。

## 8. `/skill` 的原始消息与指令注入

新增 history-only 的 `session/skill` 事件。这里的 history-only 指**不作为独立 UI frame 广播，但 `historyFromEvents` 会把它 replay 进模型历史**；`session/agent` 和 `subagent/descriptor` 则只是状态/目录元数据，不进入模型历史。

```ts
{
  type: 'session/skill',
  name: string,
  body: string,
  timestamp: string
}
```

处理顺序：

1. 原始用户 `/name args` 原样写入 user 事件。
2. 命中技能后，把 canonical 正文作为独立 `session/skill` 事件 append，并与 raw user 共享 pre-request flush；args 不复制进事件。
3. `historyFromEvents` 在该位置向模型历史插入统一的 skill instructions 消息。
4. history reader 默认展示原始用户消息，不重复渲染整份技能正文；搜索 `/name args` 因此恢复命中。
5. Skill 工具和 `/name` 注入共用一个 canonical renderer，避免模型在两条路径看到不同语义。

旧日志中已展开的 user 事件保持原样，无法无损推回原始命令；迁移只对新事件生效。

forked Skill 不属于本批。若以后实现，复用 `subagent/descriptor` 的 `kind:'skill'` 和同一个 transcript reader。

## 9. 分阶段交付

### 阶段 A：profile 与主 preset 正确性（已实现）

- NativeAgentProfile、字段支持矩阵和显式拒绝。
- base/effective 状态、`session/agent`、create/switch/clear/resume/fork。
- tools/MCP/skills/permission/maxTurns/effort 的实际过滤与执行。
- restart 保留 agent。

### 阶段 B：子代理目录、transcript 和工具角色（已实现）

实现以 [Native 阶段 B 详细设计](2026-11-12-native-subagent-transcript-design.md) 为准：descriptor 使用同一 native 日志，standalone transcript 只投影目标 agent 的直接对话，live source 先订阅再读 snapshot，Explore 最后执行严格 `readOnlyHint` 过滤。

- descriptor + reader cache。
- list/read/live subscription 和 provider-aware route。
- Task 别名、Explore 只读 profile。
- depth=1 的持久化。

### 阶段 C：技能注入恢复（已实现）

实现以 [Native 阶段 C：技能调用原始输入与注入恢复设计](2026-11-12-native-skill-invocation-recovery-design.md) 为准：

- strict `session/skill`、canonical renderer 和下一回合生效的 scoped reload。
- live/disk/search/fork/resume 的原始 `/name` 一致性，live/replay 共享持久化指令快照。
- 冻结完整 turn 执行快照，pre-request 失败由明确的初始消息所有权保证下一 live/resume history 一致。
- 手动与自动 compact 共用隐藏指令投影，同时保留 main/subagent context；UI/search 不暴露注入。
- controller 的 whole-workstream 最终 review 和用户授权后的 push 不在本实现任务内预先声明完成。

### 后续独立项目

- launch-time background / continuable child session / 自动完成通知。
- forked Skill。
- Claude Marketplace 插件技能。
- observer/memory/initialPrompt 等高级字段。
- 可配置多层 delegation 和周期 prose progress summary。

## 10. 验收重点

### Profile / preset

- 选择 reviewer 后，主 system、model、tools、MCP、skills 都真实变化。
- allowlist 为 `[]`、deny 最后生效、动态 MCP 下一轮快照正确。
- 一个只读 agent 在 bypass 下仍拿不到写工具；Explore 也不能经 MCP 获得写能力。
- `maxTurns` 到顶有明确非成功结果；非法/不支持字段响亮失败。
- live switch 不影响已开始的 turn；clear 恢复 base model/system/tools/skills，并同时恢复 base permissionMode/effort，不能留下 persona 的 bypass 或 effort。
- `setPermissionMode` / effort 控制在 persona 有 override 时只更新 base，无 override 时同时更新 base+effective；SessionInfo 与 broker 使用同一个 effective permissionMode。
- `maxTurns` 最后一轮请求工具时不再调用权限或执行工具，synthetic error tool_result 保持历史平衡，主会话可继续；嵌套部分报告标为 error。
- 旧 `SessionMeta.agent` 含不支持字段时恢复普通会话并显示 droppedAgent 提示，不阻断 resume，也不静默应用部分 persona。
- 没有 descriptor 的旧 sidechain 能推导 `metadataComplete:false` 目录项并打开 transcript；新旧同 id 不重复。
- 定义后续被编辑或禁用，不改变已持久化会话的 profile 快照；New-like-this 才解析最新定义。
- resume/fork 在切点前后选中正确的 `session/agent`。

### 子代理

- descriptor 在 nested 首次请求前落盘；失败调用不留下伪目录项。
- list/read 在 live、dormant、resume、fork 都返回同一 agentId/subtree。
- snapshot 建立期间到达的 frame 不丢失、不重复；断线重连可恢复。
- Task/Explore 与 Agent 都只产生一个原始 tool_result 和一个顶层 result。

### 技能

- live ring 与 disk replay 都显示 `/demo args`，模型历史包含展开正文。
- `/demo args` 可搜索命中，正文不作为重复用户 bubble 出现。
- Skill 工具与 `/demo` 注入的 canonical body 一致。
- scoped agent 的 skill exclude 不受父会话 override 复活，reload 后下一次调用使用同一 view 的新快照。

## 11. 明确取舍

- 不追求 DSH 的独立 Session/continuable 架构；当前 native 的单日志同步 Agent 已足够支撑目录和 transcript。
- 不把一层深度当成缺陷；先持久化 depth，未来再开放配置。
- 不为“支持全部 AgentDefinition 字段”而保留假支持。核心字段落地前，其余字段必须显式拒绝。
- live preset switch 是本应用已有 Claude 行为，保留；它与 DSH 的 blank-only 规则是有意差异。
- forked Skill 和插件技能不再是“DSH 已有而 native 落后”的项目，降级为独立兼容功能。
