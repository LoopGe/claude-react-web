# Native Provider 会话持久化与恢复设计

**日期：** 2026-11-09
**状态：** 已实现（`docs/superpowers/plans/2026-11-09-native-session-persistence.md`）
**参考：** `D:\codes\deepseek-harness`（DSH）的 `packages/core/session`、`packages/session/*`、`packages/session-query/*`
**前置实现：** `docs/superpowers/plans/2026-11-08-native-provider-p0-p1.md`（P0/P1）

## 1. 意图

native provider 目前在 `NativeSession.history` 里保存对话，进程退出即全部丢失。目标是按 DSH 的事件日志模型，为 native 会话补上**与 claude 会话同等程度**的持久化能力：重启后恢复、历史分页、搜索、侧聊、fork、删除、clear、rewind 锚点，并且不再依赖 SDK JSONL。

这一层做完后，native 才具备作为默认运行时的基础；后续的协议适配（OpenAI/Codex）只需要换 adapter，不再改会话/历史/分页代码。

## 2. 目标

- 每个 native 会话一份 **append-only 事件日志**，它是模型历史与客户端 transcript 的唯一事实来源。
- 重启/休眠后 `resume`：重建模型 `history`、继续对话；崩溃中断的 turn 被修复到 API 可接受的状态。
- 实现 provider 的 `readHistoryPage` / `readHistoryEntries`，让现有历史分页、搜索、recap、侧聊前缀、fork 预置直接复用。
- fork 与侧聊：复制精确前缀 + seed 边界 + 收尾事件；侧聊继续隐藏继承前缀。
- 删除、clear、`hasTranscript`、`supportsResume` / `supportsFork` 与现有生命周期对齐。
- claude provider 行为不变；不增加运行时依赖；Node 20 可用。

## 3. 非目标

- 构建上下文压缩/摘要功能本身（但 `/compact` 已经产生的 seed 必须持久化，否则恢复后会话内容全丢）。
- SQLite FTS 搜索、zstd 压缩、跨进程写锁。
- 会话格式的完整迁移链：v1 只做版本拒绝，不实现 v2 迁移。
- 子代理、MCP、multi-protocol adapter、provider 选择 UI。
- `request/header` 级别的请求信封快照（未来做模型路由/缓存复用时再加）。
- 未消费输入队列的持久化：queued-but-not-consumed 的 turn 不写盘，崩溃后丢失，与 claude 当前行为一致。

## 4. 现有 seam（已核对）

- `AgentProvider`：`readHistoryPage?`、`readHistoryEntries?`、`hasTranscript?`、`createSession`。
- `CreateSessionOptions`：`resume?: string`、`forkSession?: boolean`、`resumeSessionAt?: string`、`onUserMessageConsumed?`。
- `ProviderCapabilities`：`supportsResume`、`supportsFork`。
- manager：
  - `resume()` 先用 `readProviderHistoryPage` 取 ring seed，再 `spawn({ resume: id })`。
  - `searchMessages` / `composeTranscriptEntries` / `preseedForkTranscript` 走 `readHistoryEntries`。
  - `fork()` 设置 `resume: sourceId, forkSession: true, resumeSessionAt`，并在 spawn 前 `preseedForkTranscript`。
  - `createSideChat()` 用 `readHistoryPage(parent, { limit: 1 })` 取 `forkBoundaryUuid`，再以 `resume+forkSession` 建新 id；历史读取统一传 `afterUuid` 隐藏继承前缀。
  - `hasSdkTranscript()` 在 provider 实现 `hasTranscript` 时直接委托，但**会吞掉所有异常并返回 false**。
  - `delete({ deleteTranscript })` / `discard({ deleteOriginal })` 目前直接调用 `findTranscriptFile` / `deleteTranscriptFile(s)`。
  - `recordResultFrame` / `recordTurnAnchor` 是 provider 无关的 pump 依赖，已落 sidecar。
  - `rewindFiles` 以 app 级 user-message uuid 查快照 sidecar，不依赖 SDK uuid。
  - `sliceWindow` / `paginateRenderable` 已导出，可直接复用分页语义；`normalize` 从 raw line 的 **ISO `timestamp`** 派生 `receivedAt` / `consumedAt`，并从 tool_result content 派生 `parent_tool_use_id`。
  - `isRenderableSdkMessage` 对 `parent_tool_use_id != null` 的一律拒绝。
  - `spawn()` **先创建新 handle、之后才异步 destroy 旧 handle**（同 id 竞态 resume 的既有路径），因此 writer 不能简单地“第二个 writer 就抛错”。
- `jsonl-cache` 目前把 `history-reader.normalize` 固定在里面，native 需要注入自己的归一化或复制一个薄缓存。
- provider 目前拿不到 `stateDir`；`SessionManager` 只给 `createDefaultProviders` 传了 `logsDir`。
- `sendControlMessage`（compact hand-off seed）当前只 push 进 `NativeSession.history`，不落盘；它是压缩后新会话唯一的上下文。

## 5. DSH 的做法（借鉴/不借鉴）

借鉴：

- 会话 = 只追加、`seq` 连续的事件日志；模型历史、transcript、搜索都由日志派生。
- 每会话一个文件；崩溃留下半截 turn，恢复时补合成收尾（缺结果的 tool_result、`turn/end {interrupted}`）。
- fork = 精确 inclusive 前缀 + `session/end-seed` 标记 + `inheritedEventCount`；未闭合 step 补错误结果并以 `{forked}` 收尾。
- 读取走统一 query 层：按 offset/length 切片、`afterUuid` 过滤、线性文本搜索。

不借鉴（本阶段）：

- 格式版本迁移链、Zstandard 帧、跨进程 `flock`、SQLite FTS5、projection/checkpoint 框架、请求头快照。

## 6. 日志格式 v1

### 6.1 路径

```
<stateDir>/native-sessions/<sessionId>/session.v1.jsonl
```

- `<stateDir>` 由 manager 传给 `NativeProvider`（`SessionManager` 新增 `stateDir: store.getDir()`）。
- `sessionId` 必须通过 `isSafeSessionId`。
- 未来 `v2` 发布为 `session.v2.jsonl`；读取时选最高版本，不认识的更高版本**拒绝**。
- 单文件、UTF-8、一行一个 JSON 对象。

### 6.2 头部（第一行，无 `seq`）

```json
{"type":"session/header","v":1,"id":"<uuid>","cwd":"...","createdAt":1690000000000,"isSeeded":false,"inheritedEventCount":0}
```

### 6.3 事件（后续每行，`seq` 从 0 连续）

线上帧形状的事件（`normalize` / `isRenderableSdkMessage` 可直接识别）：

```json
{"seq":0,"type":"user","uuid":"...","session_id":"...","parent_tool_use_id":null,
 "timestamp":"2026-11-09T10:00:00.000Z",
 "message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
{"seq":1,"type":"assistant","uuid":"...","session_id":"...","parent_tool_use_id":null,
 "timestamp":"2026-11-09T10:00:01.000Z",
 "message":{"id":"msg_...","role":"assistant","model":"...","content":[...],"stop_reason":"tool_use","usage":{...}}}
{"seq":2,"type":"user","uuid":"...","session_id":"...","parent_tool_use_id":null,
 "timestamp":"2026-11-09T10:00:01.100Z",
 "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_...","content":[...],"is_error":false}]}}
```

- tool_result 事件必须写 `parent_tool_use_id: null`（与 live frame、SDK JSONL 一致）；reader 由 `normalize` 从 content 派生 `parent_tool_use_id = tool_use_id`。写非 null 会让 `isRenderableSdkMessage` 直接丢弃该行。
- 每条 wire 事件必须带 ISO `timestamp`；`normalize` 用它生成 `receivedAt`，并给顶层 user 生成 `consumedAt`。
- compact hand-off seed 写成 `type:'user'` + `isCompactSummary:true` 的事件（`seedCompactSummary` 的现有形状），进入模型 history，客户端按 compact divider 渲染。

native 标记事件（不渲染）：

```json
{"seq":3,"type":"session/context","text":"<system-reminder>Working directory: ...</system-reminder>"}
{"seq":4,"type":"turn/end","reason":"completed","usage":{"input_tokens":10,"output_tokens":5}}
{"seq":5,"type":"session/end-seed"}
```

规则：

- **只持久化 durable surface**：顶层 user、assistant finalize、tool_result user、compact seed。`stream_event`、`tool_progress`、`system/init`、`thinking_tokens`、`api_retry` 不落盘。
- `result` 帧不落盘：现有 `resultFrameStore` 已由 pump 记录，恢复时由 manager 合并。
- `session/context` 只进模型 history，不进 transcript。
- `turn/end` 用于崩溃修复、`lastUsage` 重建和 fork 收尾；`reason` ∈ `completed | interrupted | error | forked`。
- `session/end-seed` 标记 fork 继承前缀的结束；与头部 `inheritedEventCount` 必须一致。
- 事件类型集合集中在一个 `known-event-types` 模块；未知类型**拒绝加载**（fail closed），除非未来显式标记 `ignorable`。

### 6.4 完整性与恢复

- 头部 `v` 不认识 → 明确报错，不猜测。
- `seq` 不连续 / 已提交前缀 JSON 损坏 → `NativeSessionStorageCorruptionError`，不静默截断。
- 最后一行不完整（无换行或 JSON 不完整）→ 视为未提交尾部：截断到最后一条完整行，再允许写入。
- 日志不存在 = 无 transcript；`hasTranscript` 返回 false。

## 7. 写入路径与 checkpoint

**用户 turn 在消费时写盘，不在入队时写盘。**

- `enqueueUserMessage`：只入内存队列，记录 `receivedAt = Date.now()`（`WeakMap<message, number>`）。不写盘。这样 `cancelQueued` / `messages-withdrawn` 的 queued turn 从未落盘，不需要 provider 侧的撤回/删除 API。
- `pumpLoop` 取到下一条消息、开始 API 调用**之前**：写 `user` 事件（`timestamp` 取记录的 `receivedAt`；`consumedAt` 不需要单独字段，reader 由 timestamp 派生），然后 `flush`。
- 模型响应 finalize：写 `assistant` 事件，并**记住这次 `flush` 的 promise**；`requestPermission`（loop 的执行工具前唯一 seam）在调用权限处理/执行工具**之前 await 它**，保证崩溃后能判断“调用已发出、结果未知”。flush 失败会在该 await 处抛出，成为本轮 turn 的 error。
- 每个 tool_result：写 `user` 事件；同一轮工具全部结束后 `flush`。
- turn 结束：写 `turn/end` 并 `flush`。只有 `completed` 携带本 turn 的 usage；`interrupted` / `error` 不携带（否则 `restoreUsage` 求和时会重复累计上一 turn 的 usage）。
- interrupt/abort/destroy：写 `turn/end {interrupted}` 并 `flush`。
- `sendControlMessage`（compact seed）：直接写 `isCompactSummary` user 事件 + `flush`，并加入 `history`。

- 批量 append、按 checkpoint flush（`fsync`），不是每行 fsync。
- 已提交事件永不改写；只有未提交尾部会被截断。
- **Writer 所有权**：模块级 registry 按**解析后的日志路径**（`resolve(path)`）记录当前 writer，而不是 session id——同一 id 在不同 stateDir 下互不影响。`NativeSessionLog.open` 新建 writer 时接管该路径，旧 writer 被标记 superseded（丢弃未 flush 的缓冲，其后续 append 只进内存、不落盘），`close()` 幂等。这样兼容 `spawn()` 先建新 handle、后异步 destroy 旧 handle 的既有顺序，不会把良性竞态变成 spawn 失败。**已知残留窗口**：接管发生时已经提交的那一次写入仍可能落盘，而新 writer 在加载文件时看不到这一块。跨进程锁不在本期。

## 8. 读取路径

### 8.1 归一化与分页

- 读取 = 解析完整行 → 过滤 native 标记 → 得到与 `history-reader` 兼容的 raw line 对象。
- 复用 `normalize` / `sliceWindow` / `paginateRenderable`：`before` / `beforeUuid` / `limit` / `afterUuid` 语义与 claude 完全一致。
- `afterUuid`：跳过该 uuid 及之前的条目（侧聊隐藏继承前缀）。
- tool_result 的父关系、`receivedAt` / `consumedAt` 全部交给 `normalize`，native reader 不重复实现。
- 缓存：native 自己的 page cache，键 `(size, mtimeMs)`，append 时增量解析，LRU 4，直接调用 `paginateRenderable`。实现为 `native-history-cache.ts`，不动 `jsonl-cache` 的 claude 热路径。

### 8.2 返回契约

- `readHistoryEntries(id, { afterUuid })` → 每条 renderable 事件一个 `{ index, message }`。
- `readHistoryPage(id, opts)` → `{ messages, totalCount, startIndex, hasMore }`。
- 顶层 user 事件经 `normalize` 后 `parent_tool_use_id: null`，并带 `receivedAt` / `consumedAt`。
- tool_result 事件经 `normalize` 后 `parent_tool_use_id = tool_use_id`。

### 8.3 搜索 / recap / 侧聊前缀

`searchMessages` 遍历 `readHistoryEntries`，历史分页走 `readHistoryPage`，侧聊/`preseedForkTranscript` 用 `afterUuid`——因此实现这两个方法即获得全部现有能力，不需要额外的 query/FTS 层。

## 9. Resume 与崩溃修复

`NativeSession` 构造时按选项分流：

| 条件 | 行为 |
|---|---|
| `forkSession && resume` | 从 `resume`（源 id）fork 到 `opts.id`，见 §10 |
| `resume && !forkSession` | 加载 `opts.id` 自己的日志 |
| 其他（fresh）且同 id 已有日志 | 以 `NativeSessionStorageError(kind:'exists')` **拒绝**，不覆盖、不轮转；正常路径不应发生（`respawnFresh` 只在 `hasTranscript` false 时调用） |
| 其他（fresh）且无日志 | 新建日志 |

恢复步骤：

1. 校验头部/版本/`seq`；截断未提交尾部。**损坏或未知版本在这里抛错，不降级为空会话。**
2. 重建 `history`：`session/context` → user 消息（按出现顺序全部放入；fork 会有两条，后一条是子会话 cwd）；wire 事件 → `{ role, content }`；thinking 块按现有规则剥离；native 标记跳过。
3. **崩溃修复**：若存在未回答的 `tool_use`，先追加合成错误 tool_result（`is_error: true`），再追加 `turn/end { interrupted }`，把被崩溃打断的 turn 明确收尾。
   - resume 路径：修复事件（合成结果 + `turn/end`）**持久化**。
   - 运行中的 turn 若在 assistant 已写入后抛错（assistant flush 失败或权限处理抛错），同一套合成结果会**立即写入日志与内存 history**（复用 `repairInterruptedTurn`）；只补内存会让重启后把结果补到后续 turn 之后，造成 history 永久非法。
   - 只读读取（冷会话的 `readHistoryEntries`）：在内存中补同样的 closers，不写盘。
4. 恢复 usage：`lastUsage` 优先取最后一个 assistant `message.usage`（它带 cache buckets，ContextBar 需要），没有时回退到最后一个带 usage 的 `turn/end`（usage-less 的 `turn/end {forked}` 不参与）。per-model usage 累加日志里所有 assistant frame（每个 API round 一条），与 live 路径在 `persistFrame` 里的累加完全一致；`/usage` 映射为 `SessionUsageData`（`session.model_usage` + `rate_limits_available:false` + `cost_available:false`，不伪造费用）。
5. 先推 `system/init`，再进入正常输入队列。
6. 不重放历史帧；客户端 transcript 由 manager 的 ring seed 提供。
7. **构造函数不无条件加新 context**：fresh 才生成；resume 复用已存的 context；fork 见 §10。

## 10. Fork 与侧聊

### 10.1 Fork

`fork()` 现有参数直接可用（`resume=source`, `forkSession=true`, `resumeSessionAt?`）。`NativeProvider.createSession`：

1. 读取源日志。
2. `resumeSessionAt` 给出时：找到该 uuid 的事件（assistant turn anchor），**包含**它及其之前的所有事件作为前缀；找不到则明确报错。未给出时：复制完整前缀。
3. 写新头部：`isSeeded: true`、`inheritedEventCount = 前缀事件数`；复制前缀（`seq` 在子日志内重新连续编号，`session_id` 改写为子会话 id）；追加 `session/end-seed`。
4. 修复 seed 中未闭合的 turn：补错误 tool_result + `turn/end {forked}`（子会话自有事件，在 seed 标记之后）。
5. 追加一条**子会话自己的** `session/context` 事件（cwd 取 fork 的实际 cwd，例如 worktree → mainRepoPath 后的目录）；继承前缀里的旧 context 保留。
6. 用 seed + 修复事件 + 新 context 重建 `history`。

### 10.2 侧聊

- 与 fork 同一路径，复制完整前缀；manager 已写入 `meta.forkBoundaryUuid`（父会话最后一条可渲染消息的 uuid）。
- 模型 `history` 包含继承前缀（作为参考上下文）；UI 与搜索通过 `afterUuid = forkBoundaryUuid` 隐藏它。
- 侧聊系统提示：manager 目前把 `SIDE_DEVELOPER_INSTRUCTIONS` 放在 SDK `systemPrompt`，native 收不到。新增 app 级 `CreateSessionOptions.systemPromptAppend?: string`（claude 忽略），由 `spawn` / `buildResumeOpts` 传递；native 在 `createSession` 里把它追加到 prompt registry 渲染出的 system 字符串之后，`NativeSessionOptions` 不单独携带该字段。
- `discard()` 的 `resumeSessionAt` + `historySeed` 走同一 fork 路径；`preseedForkTranscript` 已按 provider entries 预置 ring。

## 11. clear / delete / sleep

- **clear**：manager 用新 id spawn 全新会话（`doClear`），native 自然得到新日志；旧 id 的日志留在磁盘（与 claude 的 SDK transcript 一致），未来由 orphan GC 处理。
- **delete**：新增 provider 可选方法 `AgentProvider.deleteTranscript?(id): Promise<boolean>`，manager 以私有 `deleteProviderTranscript(providerName, id, { single })` 统一分派：provider 实现了就调用它（native 删除整个 `<id>/` 目录），否则回退到 claude 的 `deleteTranscriptFile` / `deleteTranscriptFiles`（`single` 选择单/多）。`delete({ deleteTranscript: true })` 与 `discard({ deleteOriginal: true })` 都走这条路径；`discard` 先 `unload({ awaitDestroy: true })` 等 writer/进程关闭再删，避免 Windows 上文件仍被持有。
- **sleep / unload**：不删除日志，只关闭 writer。
- **`hasTranscript`**：只检查 `session.v1.jsonl` 是否存在，不解析。损坏/未知版本的错误由 `readHistoryPage` / `createSession` 抛出；`resume()` 的 history-seed catch 即使吞掉读取错误，随后的 `createSession({resume})` 也会抛错并让请求失败，不会静默变成空会话。

## 12. Manager / provider 改动清单

1. `DefaultProvidersOptions` + `NativeProvider` 构造参数增加 `stateDir`；`SessionManager` 传 `this.store.getDir()`。
2. `NativeProvider`：实现 `readHistoryPage` / `readHistoryEntries` / `hasTranscript` / `deleteTranscript`；`capabilities.supportsResume = true`、`supportsFork = true`；构造参数增加 `stateDir`，并把 `resume` / `forkSession` / `resumeSessionAt` / `systemPromptAppend` 转发给 `NativeSession`。
3. `NativeSession`：接入 writer/reader；`resume` / `forkSession` / `resumeSessionAt` 分流；崩溃修复；writer takeover。
4. `AgentProvider`：新增可选 `deleteTranscript?`；`delete()` / `discard()` 改为 provider-aware。
5. `CreateSessionOptions`：新增可选 `systemPromptAppend?`；`spawn` / `buildResumeOpts` 传递。
6. `fork()` / `createSideChat()`：现有 `hasSdkTranscript` 已委托 `provider.hasTranscript`，无需改；仅确认 native 实现后 410 守卫按日志存在性工作。
7. 不修改 `history-reader`、`jsonl-cache`、claude provider 的行为。

## 13. 失败与错误

- 未知格式版本、已提交前缀损坏、`seq` 缺口 → `NativeSessionStorageCorruptionError`（manager 映射为 500，并在日志里带 session id + 文件路径）；`hasTranscript` 不做校验，因此不会被 `hasSdkTranscript` 吞成 false。
- 日志缺失 → `hasTranscript=false`；resume/fork/侧聊按现有 410 逻辑处理。
- 写入/`fsync` 失败 → append 失败向上抛；turn 标记 error；不回滚已提交前缀。
- fork 边界 uuid 不存在 → 明确报错，不静默复制全量。
- fresh spawn 遇到已存在日志 → 明确报错（数据保护），不轮转、不覆盖。

## 14. 测试

- 日志单元：append/load、torn tail、前缀损坏、seq 缺口、未知版本、同 id fresh spawn 拒绝、writer takeover。
- 读取单元：`before` / `beforeUuid` / `limit` / `afterUuid`、隐藏前缀、totalCount、hasMore、timestamp/consumedAt、tool_result 父关系。
- history 重建：thinking 剥离、tool_result 配对、compact seed、崩溃修复后的历史合法。
- 写入时点：queued turn 在消费前不落盘；`cancelQueued` 后日志无该 turn；直接 hand-off 的 consumedAt 正确。
- fork：精确 cut、`isSeeded` / `inheritedEventCount`、`session/end-seed`、`{forked}` 收尾、子会话 context、侧聊边界。
- provider 集成：fake streamer + 临时 stateDir，create → send → 新 provider resume → 继续；fork/侧聊/delete/clear。
- manager e2e：create → send → 重建 `SessionManager` → resume → 历史分页/搜索；fork；侧聊；delete；重启期间日志可读。落点在 `server/providers/native/e2e-persistence.test.ts`，每个用例的 provider 都使用独立的临时 stateDir。
- 回归：claude 全量测试不变；typecheck / lint / full suite。

## 15. 分阶段

1. **Phase 1**：日志 writer/reader、resume、历史分页、搜索（最大价值）。
2. **Phase 2**：fork、侧聊、delete、clear、`supportsResume/Fork`、compact seed 持久化。
3. **Phase 3**：崩溃修复加固、writer takeover、版本拒绝、缓存、跨平台测试、文档与计划同步。

## 16. 我做的决定（可在 review 中推翻）

- 日志放在 `<stateDir>/native-sessions/<id>/`，不按 cwd 分目录；会话导航以 `SessionStore` 为准。`stateDir` 由 manager 显式传给 provider（`createDefaultProviders({ stateDir: store.getDir() })`）。
- 事件行使用 SDK 线上帧形状 + native 标记类型，最大化复用 `normalize` / `paginateRenderable` / 现有客户端；tool_result 写 `parent_tool_use_id: null`，父关系交给 `normalize`。
- 每条 wire 事件写 ISO `timestamp`，让 `normalize` 生成 `receivedAt` / `consumedAt`。
- 用户 turn 在**消费时**写盘；queued-but-not-consumed 不落盘，因此不需要撤回 API。落盘时 `message.content` 统一归一化为 text block 数组（manager 主发送路径传的是字符串），内存里的 history 保持调用方形状。
- `result` 帧不落盘，继续用现有 `resultFrameStore` sidecar。
- compact hand-off seed 落盘为 `isCompactSummary` user 事件（保留现有语义，不等于实现压缩）。
- 恢复时复用原始 `session/context`；fork/侧聊在 seed 后追加子会话自己的 context。
- v1 不做压缩/迁移链；未知版本 fail closed。
- 崩溃修复在 resume 时持久化，冷读时仅内存补齐。`RepairResult.synthetic` 是日志输入而非事件：不带 `seq`，由调用方分配（resume 直接 append；fork seed 构建器在复制前缀后自行编号）。
- clear 沿用 manager 的“新 id 新会话”语义，旧日志保留待 GC；同 id fresh spawn 遇到已有日志以 `kind:'exists'` 拒绝，不轮转、不覆盖。
- writer 以 takeover 语义兼容 `spawn()` 先建后 destroy 的顺序；registry 键是解析后的日志路径，接管会丢弃旧 writer 的未 flush 缓冲与后续 append。truncate 只针对**本次读取快照自身**观察到的未提交尾部（`totalBytes > completeBytes`），不重新 stat，因此接管窗口内旧 writer 已提交的完整行**不会被截断**；该行对新 writer 不可见（已文档化），若新 writer 继续 append，其 seq 可能与这行冲突并在下次加载时以 `corrupt` 暴露——跨进程锁不在本期，这是接受的残留窗口（优先暴露而非静默丢数据）。
- 删除经 `AgentProvider.deleteTranscript?` + manager 的 `deleteProviderTranscript` 分派；`discard` 先 `unload({ awaitDestroy: true })` 再删除日志目录。
- resume 的崩溃修复除了合成 tool_result，还追加 `turn/end { interrupted }`；运行中的 turn 在 assistant 已写入后抛错时同样立即持久化合成结果（只补内存会在重启后产生非法顺序）。`lastUsage` 优先取最后一个 assistant `message.usage`（带 cache buckets），否则回退到带 usage 的 `turn/end`；per-model usage 累加所有 assistant frame，live 与 resume/fork 同源。`turn/end` 只在 `completed` 携带本 turn usage，`interrupted`/`error` 不带；fork 构造时即按复制前缀恢复 usage，与重启后一致。
- fork 的复制前缀把 `session_id` 改写为子会话 id（含合成修复事件），子日志不再声称携带源会话的事件；源快照只读不改。
- fresh 会话的初始 `session/context` 走 `NativeSessionLog.open` 的 seed 路径，与头部一起在 open 时同步落盘；不在后台 fire-and-forget，崩溃早于首个 turn 时仍有工作目录上下文。
- fresh native 会话在首个 turn 之前就已存在日志，因此无 turn 的 native 会话 `hasTranscript` 为 true（claude 在这种情况下会让侧聊 410）。接受此差异：空但合法的日志本身就是可恢复的 native 会话。

## 17. Builder check 结论

独立 builder check 提出的 7 个问题已在本版全部落定：用户事件写盘时点（§7）、tool_result 形状（§6.3/§8）、损坏日志的暴露路径（§9/§11/§13）、`timestamp` 归一化（§6.3/§8）、compact seed 持久化（§3/§6.3/§7）、fork 的 context（§9/§10）、writer 与 spawn 顺序（§7）。没有需要用户额外拍板的开放问题。