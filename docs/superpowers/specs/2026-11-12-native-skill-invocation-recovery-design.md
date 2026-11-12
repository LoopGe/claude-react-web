# Native 阶段 C：技能调用原始输入与注入恢复设计

日期：2026-11-12
状态：已确认；阶段 A/B 已实现，本文不声明阶段 C 已实现
前置设计：`docs/superpowers/specs/2026-11-11-native-agent-skill-preset-parity-design.md`

## 1. 问题与目标

native 当前在 live manager ring 中保留 `/name args`，但 provider 把模型输入改写为 `SKILL.md body + args` 并将这份展开内容作为唯一 user event 持久化。因此：

- live bubble 与 disk/resume/fork bubble 不一致；
- 搜索命中展开正文而不是用户原始命令；
- `/name` 与模型 `Skill` 工具使用不同的正文和 args 拼接方式；
- root base policy 与 active persona 的 scoped Skill view 不一致，显式 `/name` 可以绕过 persona allowlist。

阶段 C 将原始调用事实和技能指令拆成两个有序表示：原始 user event 保留给用户界面和搜索，隐藏 `session/skill` 事件保存模型曾经或将要看到的最终指令快照。两条路径共用 canonical body 构造，但保留各自调用协议。

### 目标

- live、disk replay、resume、fork 和搜索都保留原始 `/name args`。
- 模型 live 与 replay 都按同一顺序看到原始 user 消息和隐藏指令，不依赖当前技能文件重新展开。
- active persona 的 skill allowlist 同时约束模型 `Skill` 工具和用户 `/name`，`supportedCommands()` 与实际执行一致。
- 原始 user 与注入在首次模型请求前按序列化路径落盘，fork 切点不会静默丢失配对的注入。
- 新旧日志、compact、失败和重复调用都有确定语义。

### 非目标

- 不实现 DSH 的“正文任意位置提及即注入”、Context row 或注入正文搜索。
- 不实现 Claude command markup、`Launching skill + 后续 meta user` 的完整 Skill 工具协议，也不伪造 Skill tool_use 生命周期。
- 不实现 `:` 命名空间、Claude Marketplace 插件技能或 forked Skill。
- 不改变文件附件 handle 投影，不在本阶段处理 file-block 结构保真。
- 不在本阶段修复 `NativeSkillCatalog.reload()` 的跨 reload generation 竞态；单次 invocation 的快照一致性是独立必须项。
- 不回填旧日志或 raw-only 崩溃前缀中的缺失注入，不根据当前 catalog 重渲染历史。

### 反目标

- 为修复搜索而把展开正文重新塞回原始 user event。
- 将 `session/skill` 作为普通 live user frame 广播，造成重复 bubble 或被 prompt-echo 过滤。
- 让 `/name` 绕过 active persona 的硬 skill allowlist。
- 让 live 请求和磁盘 replay 分别读取/渲染技能文件，产生不同模型输入。
- 用当前技能定义猜测旧展开 user event 的原始命令。

## 2. 三方差异与已确认选择

Claude 直接 slash 的本地 transcript 证据来自 CLI 2.1.302，Skill 工具证据来自 2.1.311；未知/禁用技能的 Claude slash 行为未完全验证。以下选择不以未验证行为为依据。

| 主题       | DSH                             | Claude Provider                                  | 本阶段已确认决策                                                          |
| ---------- | ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| 原始调用   | 原始 user/message               | command markup + args                            | 原始 `/name args` user event                                              |
| 注入       | 独立 user/message               | 独立 `isMeta:true` user 消息                     | 隐藏 `session/skill`，replay 时成为 user-role 指令                        |
| UI         | 原始 bubble + Context row       | 原始 bubble，meta 默认隐藏                       | 只显示原始输入，不增加 Context row                                        |
| 搜索       | 原始输入和注入都可搜索          | command markup 可搜索，meta 不可搜索             | 原始输入可搜索，注入不作为独立搜索行                                      |
| 识别       | 任意位置、lowercase kebab-case  | CLI slash dispatch                               | 保留 native 整消息匹配和现有名称字符集；不支持 `:`                        |
| args       | 只在原始消息                    | slash 为 `ARGUMENTS`，Skill 为 `## User Request` | `/name` args 只在原始消息；Skill 工具使用独立 `## User Request` 后缀      |
| 正文       | canonical `<skill_content>`     | 去 frontmatter + Base directory                  | 去 frontmatter + Base directory，持久化最终文本                           |
| Skill 工具 | tool_result 返回 canonical body | `Launching skill` + 后续 meta user               | 保留 native tool_result 正文，采用相同 canonical body + `## User Request` |
| persona    | user/model 权限独立             | Options.skills 控制模型面                        | user/model 权限仍独立，但两者都受当前 turn effective scoped view 约束     |
| compact    | 不自动重注入                    | CLI 管理 compact 链                              | 沿用 native compact floor，不自动重注入                                   |
| fork       | 可出现 raw-only 前缀            | CLI transcript 链恢复                            | 原始 user 与紧随注入作为切分组，不补写 raw-only 崩溃历史                  |
| 未知/禁用  | 普通文本                        | 未完全验证                                       | 保持普通文本；Skill 工具仍返回明确错误                                    |

## 3. 核心表示与顺序

### 3.1 原始 user event

原始 user event 按现有格式写入，保留原始 UUID 和内容块：

```ts
{
  type: 'user',
  uuid: <manager app-level uuid>,
  session_id: <session id>,
  parent_tool_use_id: null,
  timestamp: <receivedAt>,
  message: {
    role: 'user',
    content: [{ type: 'text', text: '/name args' }]
  }
}
```

字符串输入仍按现有规则规范化为 content blocks，不扩大“原文一致”到 container 的运行时类型。文件附件和图片块保持现状，不在本阶段改变。

manager 已广播的 raw user frame 是 live UI 的唯一输入表示。native 不发射第二个顶层用户 bubble，prompt UUID pairing 和 `echoesUserPrompts:false` 不变。

### 3.2 `session/skill` 事件

在 strict `NativeLogEvent` union 中新增：

```ts
{
  type: 'session/skill',
  name: string,
  body: string,
  timestamp: string
}
```

- `name` 是实际解析出的技能名，保留 native 现有大小写和字符集。
- `body` 是最终 canonical 指令文本，不是整个 SKILL.md，不包含 frontmatter，不包含 `/name` 的 args 后缀。
- 事件没有独立 UI UUID，不广播、不进入 history page、搜索或 seq backfill。
- 事件只表达模型指令，不进入 `subagent/descriptor`；forked Skill 仍是后续独立项目。
- `args` 不存入该事件，避免模型 replay 时与原始 `/name args` 重复。
- strict v1 接受该事件后，旧 server 不能读取包含它的日志，与 descriptor 的 downgrade 规则一致；不得宽松跳过未知类型。

### 3.3 顺序与模型输入

命中技能时顺序固定为：

1. 原始 user event。
2. 紧随的 `session/skill` 事件。
3. 后续 assistant/tool 事件。

live `runTurn` 的初始消息从单个 user message 改为有序的两个 user-role 消息：原始 `/name args`，然后 canonical instruction。持久化模型 history 与请求使用同一数组，不能只改 replay 而漏掉 live。

`historyFromEvents` 遇到 `session/skill` 时：

- 插入 `{ role:'user', content:[{type:'text',text:event.body}] }`；
- 将 open tool-result group 关闭，语义与普通 genuine user/supplement 消息相同，后续 tool_result 不得跨注入合并；
- 直接使用 `event.body`，不重新查询 catalog、不重新读取文件、不重新渲染。

未知或不可调用技能只有原始 user event，模型按普通文本处理。

## 4. Canonical body 与 Skill 工具

### 4.1 共享构造

新增单一 canonical body 构造函数，输入为技能名、SKILL.md 所在目录和去 frontmatter 的正文：

```text
Base directory for this skill: <absolute skill directory>

<skill body without frontmatter>
```

- 目录必须是实际加载来源的绝对目录，不能使用 cwd 猜测。
- frontmatter 只在构造时剥离；权限元数据已经由 catalog 解析，不把 YAML 再发送给模型。
- 正文保持原始文本，不做 args interpolation，不增加 DSH `<skill_content>` 包装。
- 该函数生成的 `body` 是 replay-v1 稳定语义。未来改变 prefix、正文处理或包装时必须显式 versioning，不能让旧事件随代码升级改变含义。

### 4.2 `/name` 注入

`session/skill.body` 就是上述 canonical body。args 只存在原始 `/name args` user event 中，不再添加第二份。

### 4.3 模型 `Skill` 工具

保留 native 的 tool_result 返回方式，不改成 Claude 的 `Launching skill + meta user` 两阶段协议。返回文本由同一 canonical body 加调用类型专属后缀组成：

```text
<canonical body>

## User Request
<args>
```

- 空 args 时不添加空的 `## User Request` 段落。
- 这与 `/name` 共享 body 构造，但不要求两条调用路径最终字符串相同。
- Skill 工具仍使用独立 tool_result/UI card，不把用户 `/name` 伪造成 Skill tool_use。
- `disable-model-invocation` 继续禁止工具调用但允许用户 `/name`；`user-invocable:false` 继续使 `/name` 成为普通文本。

## 5. Turn 内解析、policy 与持久化

### 5.1 单一 invocation 快照

每个 main turn 先捕获 `turnProfile` 和 `turnSkillView`，再解析一次用户输入：

```ts
interface NativeSkillInvocation {
  name: string
  renderedBody: string
}
```

- 只有整消息匹配且当前 view 允许用户调用时返回 invocation。
- 解析、policy 判断、body 读取和 canonical 构造都基于同一个 turn snapshot，不能先 root catalog 展开再捕获 persona view。
- 同期 reload 或 profile switch 不影响已开始的 turn；下一轮使用新 view。
- `supportedCommands()` 使用相同的 current/effective view，避免 UI 展示可调用但执行被 persona 排除或反之。
- 现有整消息 regex 保持不变：`/^\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\s+([\s\S]*))?$/`。多行 args 保留，`:` 不匹配，不扫描正文中的提及其他位置。
- 每个用户 turn 至多一个 invocation；不同 turn 的同名技能会重新解析并产生新事件，不做会话级去重。

### 5.2 持久化顺序

命中 invocation 时：

1. append 原始 user event。
2. append `session/skill`。
3. 在同一个序列化 pre-request `flush()` 中等待两者落盘。
4. 用同一 `{rawUser, renderedBody}` 构造 live 初始消息并进入 `runTurn`。

未命中时只 append 原始 user event，沿用普通路径。不得增加独立后台渲染/flush，避免 writer takeover 和跨 catalog 快照分叉。

这两个事件共享 pre-request flush，但不是跨行事务。崩溃可以留下 raw-only 前缀；replay 接受它，不按当前 catalog 补写。flush 失败时不发起模型请求并走现有 error result 路径；已 append 的事件仍属于这个 consumed turn 的 durable 历史，后续 flush 可以将其写入。replay 只回放持久化快照，不宣称失败请求实际成功，也不重新发送或重渲染。

内存 history 必须遵循同一 consumed-turn 语义：正常进入 `runTurn` 时由它追加初始消息；若 catalog/flush 失败发生在 `runTurn` 之前，error 路径把同一份原始 user + 可用时的 skill instruction 追加到当前会话的内存模型 history。后续 live turn 因而与 resume 看到相同的失败尝试，不会出现“日志有注入、 uninterrupted session 下一轮却没有”的分叉。该路径只在 `runTurn` 未接管初始消息时使用，不得重复追加。

### 5.3 错误与未知技能

- catalog discovery/reload 整体失败：保留原始 user event，发 error result，不发起 stream；不写无法证明完整的 invocation。
- 单个技能的 stat/read/oversize 失败继续沿用当前 catalog 的 skip-as-unknown：该技能按未知处理、原始文本作为普通输入，不升级为全目录错误，也不伪造 invocation。不得把两种失败合并成同一种结果。
- `session/skill` 或原始 user 的 pre-request flush 失败：同上，不发起 stream。
- 未知、`off`、`user-invocable:false` 或被 effective view 排除：原始文本作为普通模型输入，不写 `session/skill`，不报技能错误。
- 模型 `Skill` 工具遇到未知/不可用名称继续返回 `isError:true` 的 tool_result，不改变现有错误语义。
- `/clear` 等 manager 内建命令继续由 manager 处理；provider 不新增一套命令优先级。

## 6. Replay、resume、fork 与 compact

### 6.1 Resume

resume 继续分为两个投影：

- UI ring/history page/search 只读取原始 user event，`session/skill` 不可见。
- 模型 history 按 seq 读取原始 user + `session/skill.body`，顺序和 live 完全一致。

恢复后修改/删除技能文件或改变 policy 不影响历史注入。新 turn 才使用当前 catalog 和当前 persona。

### 6.2 Fork

`buildForkSeed` 继续复制事件前缀并保持 `session/skill` 的形状。切点规则补充为：

- assistant anchor 行为不变。
- 若切点落在原始 `/name` user event，且下一事件就是对应的 `session/skill`，切分必须同时包含这两个事件。
- 若历史已经是 raw-only 崩溃前缀，保持 raw-only，不重新生成注入。
- 不得把其他普通 user 与后续 skill 错配；配对依据是原始 user 后紧邻的 skill 事件及当前 invocation 顺序。

这样 fork 不会出现“复制了命令但静默丢掉指令”的新日志，同时兼容不完整的真实历史。

### 6.3 Compact

`session/compact` 继续作为模型 history floor：

- compact 前的原始 user 和注入都不进入新的模型 history，不自动重注入。
- compact 后的两类事件按原顺序 replay。
- history page/search 继续采用现有 native floor；`session/skill` 不可见，因此无需额外分页或索引分支。

手动 `/compact` 和自动 auto-compact 共用同一个 `mergedHistoryForCompaction(session)` 输入构造函数，不能直接拿 UI 的 `mergedHistory(session)` 代替，也不能简单替换成 provider 的主模型 history：

1. 先取现有 `mergedHistory(session)`，保留其中的 main 与 subagent frames。
2. NativeSession 通过可选 handle 接口 `getSkillCompactionEntries(): readonly {afterUserUuid:string;body:string}[]` 提供持久化注入及原始 user 锚点；Claude handle 不实现该接口时行为不变。
3. manager 在每个匹配原始 user UUID 后插入对应 user-role canonical body。锚点不在当前汇总输入中时，不制造孤立的注入消息。
4. 该函数只用于 compact 汇总，不把事件写回 UI ring、history page、搜索或普通模型 replay。两条 compact 路径因此同时保留 subagent context 与技能指令。

## 7. 旧日志、附件与版本边界

- 旧日志中已展开的 user event 原样保留，不尝试恢复 `/name args`。新旧表示可以共存于同一日志。
- `session/skill` 是 replay-v1 新事件，旧 server 读到时按 strict corrupt/unknown 处理，不保证 downgrade。
- file block 仍按 manager 现有文本 handle 投影，图片和其他块不因 skill 解析被重写或删除。只有第一个 text block 用于判断整消息命令的规则保持不变。
- `NativeSkillCatalog.reload()` 的跨 reload generation 问题单独处理；本阶段只保证单个 turn 使用一个 view 和一份 invocation 快照，不用文档宣称该 race 已修复。
- renderer 的最终文本持久化意味着未来 renderer 修改不会改变旧日志；需要新格式时必须新增显式版本，而非静默改变 replay-v1。

## 8. 实施单元边界

后续实现计划按以下可独立审查单元拆分：

1. **Canonical renderer 与 scoped view**：去 frontmatter、Base directory、Skill 工具后缀、effective view/supportedCommands。
2. **`session/skill` 格式与 replay**：strict parser、historyFromEvents、tool-result group 关闭、旧日志兼容。
3. **Live turn 持久化与双消息输入**：单 invocation 快照、raw+skill pre-request flush、live/replay 一致、错误路径。
4. **Fork/compact/history/search**：同组切点、floor、UI/search 隐藏和 mixed-log 行为。
5. **真实 E2E 与文档**：live/disk/search/resume/fork/compact、Skill 工具与 `/name` 对照、policy、错误、旧日志和最终门禁。

## 9. 验收标准

### 原始输入与模型历史

- live ring、history page、resume 和 fork 均显示 `/demo do X`，不显示展开正文作为额外 user bubble。
- 首次 live 请求和 resume/fork 的模型 history 都依次包含原始 `/demo do X` 与 canonical instruction，body 不含 frontmatter，包含实际 Base directory。
- `/demo do X` 可搜索命中；canonical body 不产生独立搜索行或 seq backfill。
- 修改/删除技能文件后，历史请求仍使用持久化 body；下一轮才使用新定义。

### Policy 与 Skill 工具

- active persona 排除 demo 时，`/demo do X` 只作为普通文本，`supportedCommands()` 不显示 demo；清除 persona 后恢复。
- `disable-model-invocation` 的 `/name` 可注入而 Skill 工具失败；`user-invocable:false` 的 `/name` 为普通文本而工具按模型 policy 执行。
- 整目录 reload 失败产生 error result；单技能 stat/read/oversize 失败仍按未知技能处理为普通文本，不混淆两种失败。
- `/name` 不重复 args；Skill tool_result 使用同一 canonical body 且仅有工具路径的 `## User Request` 后缀，不产生额外交互 bubble。

### Durability、fork 与 compact

- raw 与 skill 在首次请求前 flush；失败时不发起 stream，后续 replay 只读持久化快照，不重渲染或补发。失败 turn 的原始 user+可用指令也进入当前内存模型 history，下一 live 请求与 resume 一致且不重复。
- 手动与自动 compact 的汇总输入都保留 main/subagent frames，并在原始 user 锚点后包含 canonical body；这些注入不泄漏到 UI ring/search。
- raw-only 崩溃前缀保持原样；切在 raw user 的 fork 同时包含紧随的 skill 事件；assistant 切点行为不回归。
- compact 前 raw+skill 不进入新模型 history，compact 后正常 replay；history reader/search 不出现注入行。
- 旧展开 user event 保持不变；含 `session/skill` 的新日志被旧 server 明确拒绝，而非静默丢事件。

### 回归与门禁

- 更新旧 P1.4 中要求“磁盘保存展开正文/搜索原命令丢失”的断言，不保留互相矛盾的旧行为。
- native skills/session-log/native-session、SessionManager、history/search、fork/compact、Skill tool 和真实 E2E 全部通过。
- `npm run typecheck`、`npx vitest run`、`npm run lint`、`npm run verify:agent-notes` 和 `git diff --check` 通过。
- whole-workstream review 通过后才声明阶段 C 完成；不提前声明附件保真、插件技能、forked Skill 或 reload generation 修复。

## 10. 明确取舍

- 采用 DSH 的“原始消息 + 独立注入”而非 Claude command markup，因为本阶段要恢复的是用户实际输入，而不是再生成一种命令表示。
- 不采用 DSH 的任意位置识别、Context row 和注入搜索，避免普通文本误触发与重复结果；只借鉴其不替换原始消息的原则。
- 采用 Claude 的去 frontmatter/Base directory 与 Skill 的 `## User Request` 包装，但不复制其 meta-user 协议，控制改动范围并保持 native 工具生命周期。
- args 在 `/name` 中只出现一次，在 Skill 工具中按工具调用协议出现，优先避免模型历史重复，而不追求两条路径字节完全相同。
- 接受 pre-request flush 失败后 consumed-turn 事件仍可能随后落盘，将其视为失败尝试的 durable 历史；不以“模型当时未看到”为理由删除或重写日志，也不自动重放请求。
