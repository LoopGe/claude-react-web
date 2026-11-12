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
- 子代理、multi-protocol adapter、provider 选择 UI；MCP 与 first-party 工具已由 P1.2 交付（见 `## P1.2 — MCP 与 first-party 工具`）。
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
{
  "type": "session/header",
  "v": 1,
  "id": "<uuid>",
  "cwd": "...",
  "createdAt": 1690000000000,
  "isSeeded": false,
  "inheritedEventCount": 0
}
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

| 条件                          | 行为                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `forkSession && resume`       | 从 `resume`（源 id）fork 到 `opts.id`，见 §10                                                                                                |
| `resume && !forkSession`      | 加载 `opts.id` 自己的日志                                                                                                                    |
| 其他（fresh）且同 id 已有日志 | 以 `NativeSessionStorageError(kind:'exists')` **拒绝**，不覆盖、不轮转；正常路径不应发生（`respawnFresh` 只在 `hasTranscript` false 时调用） |
| 其他（fresh）且无日志         | 新建日志                                                                                                                                     |

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

## P1.1 — Context efficiency

P1.1 在持久化之上补两件事：跨 turn 复用稳定的 prompt 前缀（prompt caching），以及不换 session id 的上下文压缩。

### Prompt caching

- `buildRequestBody` 在三个稳定前缀边界加 `cache_control: { type: 'ephemeral' }`：`system` 块、最后一个 tool 定义、请求最后一条消息的最后一个 content block（字符串 content 改写成带 `cache_control` 的 text block）。
- 只克隆最后一条消息/块与 tools 数组，不修改调用方持有的 history/tools。
- 始终开启，没有配置开关。
- 接受的限制：拒绝 `cache_control` 的 Anthropic 兼容网关会让该 turn 失败。不为兼容而静默降级。

### `session/compact` 日志事件

```json
{
  "seq": 5,
  "type": "session/compact",
  "text": "<summary>",
  "context": "<system-reminder>...</system-reminder>",
  "uuid": "...",
  "timestamp": "..."
}
```

- `text`：摘要正文；`context`：压缩时刻重新抓取的 `<system-reminder>` 快照；`uuid`：与客户端 compact boundary 帧共享的身份；`timestamp` / `seq`：与其他事件一致。
- 它是 replay 与 reader 的地板：`historyFromEvents` 从**最后一条** `session/compact` 重建模型历史（先 `context` 再 `text`），reader 从同一事件生成的 summary 行开始返回可渲染内容——因此分页 / 搜索 / 侧聊前缀只看到压缩后的对话。
- 日志仍然只追加：压缩是加一条事件，不重写、不截断已提交事件。

### 原地压缩（同 id）

- 不换 session id、不 respawn。`NativeSession.compactInPlace` 追加 compact 事件、替换自己的模型 history、把 `lastUsage` 清零，不产出帧；manager 重置同 id 的 transcript 管线，广播 `session-cleared`，再推送 boundary + summary 两帧。
- manager 重置清单：history ring；transcript seq sidecar（**seq generation 继续 +1，不回零**——客户端在 `session-cleared` 上以 `generation + 1` 作为 stale floor）；`promptUuids`；`steeredInFlight`；`withdrawnUuids`；`pendingSnapshotAnchors`；`lastContextUsage`；prompt-uuid / steered / turn-anchor / result-frame 四个 sidecar。
- 保留：后台 task 记录与文件快照锚点（压缩不丢任务、不丢 rewind 锚点）。

### 触发规则

- 只在 `phaseOf === 'idle'` 时触发；turn 在跑或输入仍在队列里时不触发。
- 阈值：`Options.settings.autoCompactWindow` 显式给出时用它，否则 `floor(maxTokens × nativeAutoCompactRatio)`（配置默认 `0.8`，夹在 `(0, 1]`）。
- `nativeAutoCompact: false` 整体关闭。
- 同一 session 同时最多一个压缩在跑（`autoCompacting`）；await 摘要之后重新检查 session 身份与 idle，避免与用户 turn 竞争。
- `summarizeForCompact` 返回空串时跳过（不为空历史伪造摘要）。

### Usage

- `usageByModel` 跨压缩保持累计（计费不因压缩丢失）。
- context-window 的 usage 从压缩后的对话重新开始：`compactInPlace` 清零 provider 的 `lastUsage`，manager 清空 `lastContextUsage`。已渲染的 ContextBar 在下一次 turn 产出新的 usage 前仍显示压缩前的百分比（不额外广播 reset）。

## P1.2 — MCP 与 first-party 工具

P1.2 让 native 会话的工具面与 claude 会话对齐：用户配置的 MCP server 与进程内 first-party server 都能被模型发现、调用、授权、动态增删，并出现在设置面板的状态视图里。

### 一个会话一个 MCP 客户端层

- 每个 native 会话持有自己的 `NativeMcpConnections`。manager 解析出的 `mcpServers`（全局 + inline + first-party `injectAll` 结果）在 `createSession` 时一次性交给它；native provider 不再重新合并全局配置，也不维护 `mcpServerNames`。
- 每个 entry 一个 `@modelcontextprotocol/sdk` `Client`。外部 server 复用 `createMcpTransport`（stdio / SSE / StreamableHTTP，含 allowlist 与 OAuth）；`type:'sdk'` 的 first-party entry 通过 `InMemoryTransport.createLinkedPair()` 连接，进程内外共用一条发现 / 调用 / 状态路径。工具调用仍然穿过 SDK 的 `McpServer`，因此 `inputSchema` 的 Zod 校验与 `CallToolResult` 归一化保持原样。
- 连接是**异步**的：`load()` 立即返回，所有变更（load / replace / reconnect / toggle / closeAll）串行跑在一条队列上，`whenReady()` 就是该队列。turn 在发请求前 await 它，所以慢 server 或坏 server 永远不会阻塞 `createSession`，也不会让 turn 无限等待。
- 每个 server 记录持有自己的 `AbortController`，覆盖握手、每一页 `listTools` 与在途工具调用；连接超时（10 s）或移除会**先** abort、再关闭 client（stdio 子进程随之被杀），状态记为 `failed`，从不向调用方抛错。
- 状态机：`pending → connected | failed | needs-auth`，`disabled` 由 toggle 产生。失败的 server 只是不贡献工具，不影响其它 server 或会话本身。
- `closeAll()` 幂等：同步 abort 所有在途连接，再关闭已建立的 client；`destroy` 走这条路径。

### 工具名与授权

- 模型看到的工具名一律来自 `mcpToolFqn(server, tool)`：`mcp__{server}__{tool}` 把每个 `[^A-Za-z0-9_-]` 换成 `_`，超过 64 字符时截断并追加 FNV-1a 8 位哈希后缀，因此结果始终满足 Anthropic API 的 `^[A-Za-z0-9_-]{1,64}$`。合法输入原样返回（`mcp__git-tools__git_status`）。同一个函数被 model tool list、first-party registry、permission broker 与客户端 MCP-Apps 映射共用。
- 权限请求通过发现元数据把 FQN 映射回 `{ name, source: 'sdk' | 'dynamic' }`，**不解析工具名**（名字可能被截断或哈希）。`canUseTool` 只在 MCP 工具上收到 `mcpServer`，内置工具省略该字段。
- MCP 工具不注册 prompt section：native 的 system prompt 在 create 时冻结，工具描述本身承载模型需要的信息。first-party server 的只读 / 写入注解继续驱动 broker 的只读豁免与 git 快照广播。

### 状态形状

`mcpServerStatus()` 原样返回 `NativeMcpStatus[]`，服务端不做变换：

- `name` / `status` / `serverInfo?` / `error?` / `scope: 'session'`；
- 进程内 server 带 `source: 'sdk'`，外部 server 省略该字段；
- `tools` 是**裸工具名**数组（附 description / annotations / `_meta`），供 SettingsPanel 与 `useMcpApps` 使用；
- `config` 只含 `{ type, command?, args?, url? }`，**永不**包含 `env` 或 `headers` 的值（`args` 按 CLI 自身状态的做法保留）。

### 动态替换

- `setMcpServers` 是**替换**语义。entry 以指纹比较：外部 entry 取可序列化字段的 JSON，`type:'sdk'` entry 取 instance 本身；永远不对 entry 做 `JSON.stringify`（live instance 会因循环引用抛错）。未变 = 保留，移除 = 关闭，新增/变化 = 关闭后重连；返回 `{ added, removed, errors }`。
- manager 的 `injectAll` 每次都会构造新的 first-party instance，因此每次 `setMcpServers` 都会重连 first-party server——进程内、代价可接受，是刻意的取舍。
- 变更只在下一次 turn 生效：turn 开始时 await `whenReady()` 再重建工具数组；运行中的 turn 继续使用它拿到的快照。

### 延迟项

- MCP elicitation：server 收到 method-not-found（native 暂不支持 OAuth 表单交互）。
- `setMcpPermissionModeOverride`：返回 501（claude/SDK 专有的 per-process 覆盖）。
- `listTools` 的游标分页已实现，但 in-memory 与测试 fixture 都不产生分页，暂无集成测试覆盖。

## P1.3 — Subagents

P1.3 让 native 会话拥有 `Agent` 工具：子代理在同一条 turn 循环里跑自己的历史，帧带上真实的父 `tool_use` id，复用现有的 SubagentCard / SubagentOverlay / SubagentSwarm 渲染。只支持同步调用。

### Agent 工具

- `Agent` 是**每个会话**构造的 `ToolDef`（不是全局静态），闭包捕获会话的 `streamFor`、模型、cwd、permission handler 与 emit 路径。schema 为 `{ description, prompt, subagent_type?, model? }`，`required: ['description', 'prompt']`；`run_in_background` 不在 schema 里。
- `run` 用**空历史**重新进入 `runTurn`（`[]` + 一条 user 消息），`emitResult: false` 因此不再产出第二个顶层 `result` 帧；`signal` 与父 turn 相同，中断父 turn 同时中断嵌套循环。
- 每个嵌套帧经 `FrameContext.parentToolUseId = <Agent 的 tool_use id>` 打上 `parent_tool_use_id`，父帧保持 `null`。父级归属**只**来自这个 ctx，没有第二层 stamping wrapper。
- 结果是嵌套循环里**最后一条非空 assistant 文本**；全都为空时退回 `'(no output)'`。工具异常转成 `{ text, isError: true }`；`ctx.signal.aborted` 在进入前和返回后各查一次（脚本化或不响应 signal 的流不会挂住）。

### 嵌套 turn 的形状

- **system**：父会话渲染出的 subagent 版本 prompt —— 与父 prompt 同一个 registry，但**不含** `tool:Agent` 段（子代理不会被告知可以再分派），再拼上 agent 指令。
- **tools**：调用时读取父工具列表并过滤掉 `Agent`（深度上限 1 由构造保证，不靠运行时计数）。因为调用时读取，中途变化的 MCP / first-party 工具对子代理立即生效。
- **model**：`input.model ?? def.model ?? 父会话当前模型`。父模型是**实时 getter**，中途 `setModel` 不会让子代理落回 spawn 时的旧模型。
- **权限**：沿用父会话的 `requestPermission` 与 permission mode —— 子代理永不扩大授权范围。
- 嵌套 `api_retry` 不产出帧（`streamFor(req, { suppressRetryFrames: true })`）；重试行为本身不变，只有顶层会话发重试帧。

### 自定义 agent

- agent 定义来自 `AgentDefinitionStore`：启用条目的 `prompt` 作为嵌套 system 后缀，`model` 作为默认模型。未知或未启用的 `subagent_type` 返回错误 outcome。
- `supportedAgents()` 只返回内建的 `general-purpose`；路由负责把 store 里的定义并上去（与 claude 路径一致）。

### 持久化：一条日志，两个视图

- sidechain 的 user/assistant 事件**写进同一条 append-only 会话日志**，带真实的 `parent_tool_use_id`。日志格式仍是 v1，只把该字段从字面量 `null` 放宽为 `string | null`：旧日志照常解析，但含 sidechain 的新日志会被旧服务端判为 `corrupt`（**downgrade-unsafe**，已知并接受）。
- `readNativeHistoryPage`（resume seed + 历史 UI）**保留** sidechain 行，因此子代理的对话在恢复后仍然可见。
- `readNativeHistoryEntries`（搜索 + transcript seq 回填）**过滤掉** sidechain，但保留每一行的完整流索引 —— 命中项的 `messageIndex` 仍指向正确页行，索引空间只是变稀疏。seq store 与搜索因此保持纯顶层，不需要改 `composeTranscriptEntries`。
- `historyFromEvents`（模型历史）跳过 `parent_tool_use_id != null` 的事件；两条修复路径（`collectOpenToolUses` / `repairRenderableLines`）同样跳过 sidechain —— 崩溃修复不会为 sidechain 的 `tool_use` 伪造顶层 `tool_result`。
- 日志缓存（`session-log/cache.ts`）的纳入条件放宽为 `isRenderableSdkMessage(event) || isSidechainEvent(event)`；共享谓词本身不动，所以 seq store 仍然排除 sidechain。
- `history-reader` 的 `normalize` 优先采用**持久化**的 `parent_tool_use_id`（`string` 或显式 `null` 都算数）；只有字段缺失（claude CLI 的盘上行）才回落到从 tool_result 内容推导的父 id。
- resume seed 的页大小是 `historyCap + subagentHistoryCap`（先读、再按 sidechain 拆分）；否则子代理密集的会话会把几乎整个 `historyCap` 花在 sidechain 上，顶层历史被挤掉。

### 延迟项

- 后台子代理与 `run_in_background`；task 帧（`task_started` / `task_notification` / `task_progress`）与 task 控制（`backgroundTasks` / `stopTask`）。
- `Task` / `Explore` 别名、progress summary、`listSubagents`。
- 自定义 agent 定义中 `prompt` / `model` 以外的字段（`tools`、`disallowedTools`、`maxTurns`、`background` 等）。
- model 别名解析：`input.model` 原样透传，短别名可能被 API 拒绝。
- 在 sidechain 内部 fork：会留下未回答的 sidechain `tool_use`，渲染成一张卡住的子代理卡（接受）。

## P1.4 — Skills / commands / presets

P1.4 让 native 会话拥有与 claude 会话同等的本地技能能力：发现项目的 `.claude/skills` 与用户级 `skills/` 下的 `SKILL.md`，把可选技能写进每轮 system prompt 与 `/` 命令目录，让模型通过 `Skill` 工具加载正文。用户的 `/name args` 以原始 user event 持久化，命中时的 canonical 指令由紧随的 history-only `session/skill` 事件保存。解析仍走现有的 `server/skills.ts` / `shared/skills.ts`，没有新增解析器与依赖。

### NativeSkillCatalog 与选择策略

- 每个 native 会话一个 `NativeSkillCatalog`。spawn 策略（`configure`）与 override 层（`applyOverrides`，整表替换）分开存放，与发现解耦，因此调用顺序不影响结果。
- `reload()` 是**异步**的：重新跑 `listSkills(cwd)`，为每个有效技能缓存整份 SKILL.md（含 frontmatter，单文件 ≤1 MiB；发现之后变大的文件被跳过，不让整轮发现失败）。此后 `section()` / `commands()` / `bodyOf()` / `expand()` 全是同步读取缓存；后两者通过共享 canonical renderer 返回 Base directory + 去 frontmatter 正文。
- 同名去重：项目级覆盖用户级；无效记录在去重**之前**丢弃，因此坏掉的项目技能会回落到同名的有效用户技能。
- 基础状态（spawn `Options.skills`）：
  - `undefined`（默认）→ 每个技能 `name-only`：只列名字、不列描述，模型仍可调用。这是 CLI/app 的实际默认，不是 "all with descriptions"。
  - `'all'` → `on`：名字 + 描述。
  - `string[]` → 列表内 `on`、列表外 `off`。allowlist 是硬上下文过滤，override `'on'` **不能**复活被排除的技能。
  - `[]` → 全部 `off`。
- override（`Settings.skillOverrides`）叠在基础状态之上：`on` / `name-only` / `user-invocable-only` / `off`。`name-only` 只改变 `section()` 的展示（仍可被模型调用），`user-invocable-only` 从 `section()` 消失但 `/name` 仍可展开，`off` 在 section / commands / bodyOf / expand 四处全部隐藏。
- `disable-model-invocation: true` 把有效状态钳制为 `user-invocable-only`（显式 `off` 仍是 `off`）：该技能永不进入 `section()`，且任何 override 都无法把它抬回 `on` / `name-only`。
- `commands()` 过滤 `off` 与 `user-invocable: false`；`bodyOf()` 只在 `on` / `name-only` 下返回正文，其余返回 `unknown skill: <name>` 错误；`expand()` 在 `state !== 'off'` 且 `userInvocable !== false` 时返回正文。

### Prompt section 与 Skill 工具

- 每轮 turn 把 `<available_skills>` 段拼到 system 字符串之后（空段不留多余空行）。turn 拿到的是本轮开始时的快照，运行中的 turn 不受后到的 reload / override 影响。
- 子代理 prompt 的 skills 段是**实时 getter**，嵌套 Agent 调用读到的总是当前目录状态。
- `Skill` 是每个会话构造的 `ToolDef`（不是全局静态），随所有工具列表下发——子代理也有，因为子代理也可能需要加载技能。`run` 返回与 `/name` 相同的 canonical body；带非空 `args` 时仅工具结果追加 `\n\n## User Request\n<args>`。不支持 forked 执行。
- 未知名字、`off` 技能与 `disable-model-invocation` 技能都返回错误正文，且不发起任何流调用。

### 用户 `/skill` 原始输入与隐藏注入

- `pumpLoop` 在每轮开头 `await skillsReady`，再从该轮冻结的 scoped skill snapshot 解析调用：字符串 content 整体匹配 `/^\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\s+([\s\S]*))?$/`；数组 content 只用第一个 text block 判断整消息命令，image / file 等其它 block 原样保留。未命中（非命令、未知技能、`off`、persona 排除）原样透传。
- 命中时先写原始 `/name args` user event，再紧随写入不含 args 的 `session/skill {name,body,timestamp}`，两者共享 pre-request flush。live 模型输入与 replay 都按 raw user → canonical body 排列；body 不含 frontmatter，也不在 `/name` 路径重复 args。
- **manager ring、history page 与搜索只投影原始用户输入。** `session/skill` 不广播、不产生额外 bubble、不进入 history page/search/seq backfill；模型 history 由 `historyFromEvents` 读取持久化 body，不根据当前 catalog 重渲染。
- resume/fork 因而与 live 一样显示 `/demo args`，搜索该原文正常命中。raw user 的 fork 切点同时保留紧随的 skill 事件；raw-only 崩溃前缀和旧日志中已经展开的 user event 均保持原样，不回填、不猜测原始命令。
- 旧决策中“resume/fork 显示展开正文、搜索原命令丢失是可接受后果”已被上述实现取代，不再是接受的限制。

### 控制面

- `supportedCommands()` 返回 `commands()`，并 await 当前发现，避免 spawn 后立即拉取时拿到空表；`capabilities.supportsCommands = true`。
- `reloadSkills()` 重新发现并返回 `{ skills }`。新的发现**替换** `skillsReady`，所以手动 reload 既覆盖构造时的快照，也能从一次失败的发现中恢复（后续每轮 turn 的 await 都跟踪这一遍）。
- `applyFlagSettings` 只接受 `skillOverrides`：它**替换**整张 override 表，`{}` 回到 spawn 默认；任何其它 key 直接抛错。`supportsPlugins` 保持 false——插件开关必须响亮失败，而不是报告一个没有发生的变更。
- 发现失败不阻塞建会话：失败的 promise 被观察（日志 warn），turn 侧仍 await 原始 promise。**被消费的 user turn 在发现失败时先以原始文本落盘，再让 turn 响亮失败**——客户端已把该 turn 标成 "sent"，日志不能让它蒸发。若失败发生在 `runTurn` 接管初始消息前，NativeSession 将同一有序输入追加到内存 history 一次；后续 live 与 resume 都看到这个失败尝试，但不会自动重发请求。

### 共享改动

- `Skill` 同时加入 `server/permission-broker.ts` 的 `READONLY_TOOL_NAMES` 与 `SAFE_AUTO_TOOLS`：加载技能只读、无网络，claude 与 native 两个 provider 都适用。
- `SessionSkillManager.reloadSkills` 在 provider 返回 `skills` 数组时**也广播空表**（`commands-changed`）；只有结果完全不带 `skills` 数组时才保留现有列表。因此删光所有技能会清空客户端的选择器。

### 延迟项

- 插件来源的技能（`Options.plugins`）；forked 技能执行（`Skill "<x>" completed (forked execution)` 的整段对话）；`getContextUsage` 的 `includedSkills` / `skillFrontmatter` 明细；`opts.agent` 主会话 preset（native 目前忽略 `opts.agent`，它也不属于子代理 store）。

## P1.5 — Thinking / effort / steering

P1.5 让 native 会话拥有与 claude 会话同等的三项能力：扩展思考（只保留可验证的块 + 运行时切换）、reasoning effort / fast mode，以及运行中 steering（`session/supplement` 持久化）。三项都只改 native provider 的请求构造与 turn loop，没有新增依赖，也不改 claude 路径。

### Thinking：只保留可验证的块

- **signed-only 保留**：模型历史只保留**带签名**的 `thinking` 块与 `redacted_thinking` 块（`isRetainedInHistory`）。无签名的 thinking 块从 API 历史中剥离——API 会拒绝 follow-up 请求里的 unsigned thinking；UI 帧（assistant `content`）仍保留全部块，客户端照常渲染。
- `signature_delta` 与 `thinking_delta` 在 loop 内按 delta 累积到同一个 `{type:'thinking', thinking, signature}` 块；`redacted_thinking` 在 `content_block_start` 就带 `data`。
- 块类型与 delta 类型不匹配时是 no-op，不会跨块污染；`signature` 只在 thinking 块上累积。

### `thinking` 线上形状与运行时切换

- 线上用 snake_case：`{type:'enabled', budget_tokens:N}`、`{type:'adaptive'}`、`{type:'disabled'}`。裸 `{type:'enabled'}`（无 budget）没有合法线上形状，按 adaptive 发送。
- `budget_tokens` 钳在 `[1024, max_tokens - 1]`（`max_tokens <= 1024` 时区间为空，budget 原样保留）。native 的 `max_tokens` 固定 16384，因此客户端 16k / 32k 的预算会钳到 16383；claude 路径把预算原样交给 CLI，这是两条 provider 的已知差异。
- `display` 只转发 API 接受的 `'summarized'` / `'omitted'`；`'highlights'` 是 CLI-only 值，只保留在会话状态里，永不上线。
- display 与 token 配置**分开跟踪**（`thinkingDisplay`）：ABSENT 表示保持会话启动时的模式，`null` 表示重置为 API 默认，显式值表示替换。`POST /sessions/:id/thinking` 的 `clearDisplay: true` 是唯一的显式重置入口，所以 type / budget 变化不会顺带清掉 display。
- 运行时切换沿用 SDK `setMaxThinkingTokens` 的语义：adaptive → `null`，disabled → `0`，enabled N → `N`。live 切换拒绝没有正 budget 的 enabled（400）。`SessionMeta.thinking` 持久化，resume / fork / clear / respawn 在 spawn 时重新应用；create 时的 `Options.thinking.display` 只作为 `thinkingDisplay` 的初值。

### Effort 与 fast mode

- effort 走 `output_config.effort`，fast mode 走 `speed: 'fast'` + 请求头 `anthropic-beta: fast-mode-2026-02-01`。两者是**一个判定点**（`fastModeEnabled`）：模型不支持时 `speed` 与 beta header 一起省略，绝不会只发一半。
- 模型能力按 model id 关键词分类（`effortLevelsForModel` / `supportsFastModeForModel`），与 UI chip 用的是同一份判定；模型不支持该 level 时**省略**而不是发送后等 400，所以切模型不会把钉住的 level 变成错误。`EFFORT_LEVELS` 在 `applyFlagSettings` 中校验，非法 level 响亮抛错。
- `applyFlagSettings` 只接受三个 key：`skillOverrides`、`effortLevel`（level 或 `null` 清回模型默认）、`fastMode`（true 开，false / null 清）。其它 key 抛错（`supportsPlugins` 保持 false）。
- `fast_mode_state` 是**意图导向**的：native 没有 CLI 可以报告运行时状态，所以 init 帧与 result 帧都按当前意图打 `on` / `off`，chip 在第一轮结束前就是正确的。resume 时按持久化的 `SessionMeta.fastMode` 重新打。

### Steering（`session/supplement`）

- **admission 是 `steeringOpen`**：pump 消费一条 prompt 时打开，manager 的 `noteTurnSettled` 关闭。刻意不看 `turnAbort !== null`——否则在 manager turn-end drain 与 pump `finally` 之间到达的 supplement 会被接纳却没有下一轮可注入（stranded）。关闭后到达的消息走普通下一轮队列。
- **round-top 注入**：loop 每轮在构造请求前调用 `drainSupplement`，把已到达的 supplement 追加为 user 消息后再发请求。被注入的是 **WRAP 后的文本**（`formatSupplementInstruction`），并作为 `session/supplement` 事件持久化；replay 原样插回日志位置、重置开放的 tool-result 组，因此重启后的模型历史与 live 注入完全一致。它不进入 history reader / 搜索（重启后按内容搜索不到），UI 气泡由 steered sidecar 拥有。
- **flush-before-delivery**：`session/supplement` 先 append 并 `await flush()`，成功之后才清队列并触发 `onSupplementDelivered`；失败时条目留在队列里，由 turn-end 的 drain 或下一轮继续负责——客户端已经画出气泡，绝不能静默丢失。
- **zero-loss 回退**：turn 结束时（manager 的 `drainAndRequeueSteered`）与 plain interrupt 时，未投递的 supplement 由 `drainSupplements` 取出，按原文重新入队为下一轮 prompt（打 `requeuedAt`，广播 `message-steered {state:'requeued'}`）。empty bookend（后台任务完成、`num_turns 0`）不是 turn 结束，既不关闸也不 requeue。
- **requeue-order 修复**：requeue 前先把 prompt uuid 记进 `promptUuids` 再 `enqueueUserMessage`。native 的 handle 在 `enqueueUserMessage` 内同步消费并配对 uuid，先入队会让配对扫描找不到条目，留下永久 unpaired 项。
- 投递成功广播 `message-steered {state:'injected'}` 并给 ring 条目打 `injectedAt`；sidecar 同步记录，重连标签页靠它恢复。

### 能力位与延迟项

- native 的 `capabilities` 打开 `supportsThinkingControl` / `supportsEffortLevel` / `supportsFastMode` / `supportsSteering`，manager 对应的控制方法因此不再被 capability gate 拒绝。上述全部路径由 `server/providers/native/e2e-thinking-effort.test.ts` 经 `SessionManager` 端到端覆盖。
- **延迟**：per-model effort 降级（不支持就省略，不降到最近的可用级别）；`'summarized'` / `'omitted'` 之外的 display 值；`supportedModels` 里 SDK 上报的其余字段；fast-mode 的资格规则（`model_not_allowed` 等 org 能力）；generic `/settings` 的其余 key（autoCompactEnabled / agent / hooks / sandbox / memory 继续响亮拒绝）。

## P1.6 — Extra tools, title and provider selection

P1.6 让 native 会话补齐日常工具（Glob、LS、WebFetch、WebSearch、TodoWrite、NotebookEdit、AskUserQuestion）、自动标题与诚实的 `accountInfo`，并在新建会话对话框里显式选择 provider（restart / new-like-this 保留来源 provider）。sandbox 不在本批实现范围内：本轮只把现状变诚实——native 的 create 明确拒绝 `sandbox.enabled`，sandbox 本身作为独立的安全项目。

### 工具契约与边界

- `Glob`（`server/providers/native/tools/glob.ts`）：独立实现的纯 Node 递归 walker（复用 `grep.ts` 抽出的 `walk` / `globToRegExp`，**不 spawn ripgrep**），支持 `**` / `?`；匹配对象是相对搜索根的路径，输出是相对 cwd 的 `/` 分隔路径。跳过 `node_modules`、`.git`、`dist`；最多返回 100 个已排序的文件名，收集到 101 个匹配就停止遍历，因此超出时 `truncated: true` 且 `totalMatches` 是**观察到**的计数（≤101，不是全树精确计数）。`walk` 接受 turn signal，在每次目录读取 / 条目迭代前检查中断。输出 JSON `{durationMs, numFiles, filenames, truncated, totalMatches?}`。`path` 指向单个文件时按 basename 匹配自身。
- `LS`（`ls.ts`）：只列一层，条目按名字排序，`.git` 永远排除，`ignore` 是子串过滤；文件条目带 `size`，目录 / 其它 dirent 分别是 `dir` / `link`。最多 100 条并置 `truncated`。输出 JSON `{path, entries: Array<{name, type, size?}>, truncated}`。
- 两个路径型工具都经 `resolveAgainstCwd` 解析，逃逸 cwd 的路径抛 `ToolInputError`；所有输出再走 `capToolText`。
- `TodoWrite`（`todo-write.ts`）是**每会话工厂**（列表状态封闭在工具实例里，两个会话不共享）：每次调用整表替换；校验 trim 后的非空且唯一 `content`、`status ∈ pending|in_progress|completed`、非空 `activeForm`。多个 `in_progress` 不是输入错误，而是规划气味：接受并返回 `{oldTodos, newTodos, warning}`，warning **在 JSON 内部**，保证结果整体可解析。
- `NotebookEdit`（`notebook-edit.ts`）按 nbformat 4.5 的 `id` 定位单元格：`replace`（默认）/ `insert` / `delete`；`insert` 必须给 `cell_type`（`code` / `markdown`），有锚点时插在锚点之后、无锚点时插到最前；`replace` / `delete` 必须给 `cell_id`。只返回被改动的那一格：`{new_source, old_source, cell_id, cell_type, language: 'jupyter', edit_mode, notebook_path}`，**不含** `original_file` / `updated_file` 整文件正文；`cell_type` 报告单元格自身的原始类型（`raw` 也照实返回，只有 insert 的输入被限制为 code/markdown）。文件以 1 空格缩进 JSON 写回。
- `AskUserQuestion`（`ask-user-question.ts`）的 schema 与 broker 的解析器完全一致（`questions[]`，每项 `{question, header?, options[{label, description?, preview?}], multiSelect?}`，`required: ['questions']`）。它不是一个文件操作：除 `bypassPermissions` 外，broker 会在 `run` 之前拦截并把它变成待回答的 `kind: 'question'`；`bypassPermissions` 没有对话框，`run` 返回显式的 "dialog unavailable" 错误。

### Web 策略与 SSRF

- WebFetch / WebSearch 共用 `web.ts` 的 HTTP 策略：仅 HTTP(S)；URL ≤2048 字符；拒绝 URL 内嵌凭证；目标地址必须是公网（IPv4 / IPv6，含 `169.254.169.254`、`::1` 与 NAT64/6to4/Teredo 等 IPv4 编码过渡前缀），每次重定向都重新校验，并且**连接期**由内置 `node:http` / `node:https` 的 Agent 自定义 `lookup` 只返回已验证地址——Node 不会再解析一次，封死 resolve→connect 的 DNS rebinding TOCTOU（与 app-plugin network broker 共用 `server/safe-dns.ts` 的实现，只是 IP 谓词不同）。不使用全局 `fetch` 抓取页面内容。不自动跟随重定向，最多 5 跳，且不允许跨 origin；响应 ≤5 MiB、解码文本窗口 ≤100k 字符（窗口在 `offset` **之后**裁剪）；整个链路一个 30s 截止时间，与 turn 的 interrupt signal 用 `AbortSignal.any` 合并。hostname 解析失败按工具错误处理。
- `WebFetch`（`web-fetch.ts`）是每会话工厂（辅助调用需要本会话的 model 与 profile 凭证）：抓取页面 → HTML 转文本（去 script/style/注释/标签、解码常见实体、折叠空白）→ 用辅助 Anthropic 调用按 `prompt` 提炼答案。辅助调用模型取 `profile.recapModel || 当前 model`（**调用时**解析，live 切模型会生效），`maxTokens: 1024`、`temperature: 0.2`、`caller: 'web-fetch'`，凭证走会话 profile。`offset` 在 100k 窗口裁剪之前应用（可读取超过前 100k 的页面）；越界 offset 报 "no text content … from offset N"。输出 JSON `{bytes, code, codeText, result, durationMs, url}`。
- `WebSearch`（`web-search.ts`）走 DuckDuckGo HTML（无需 API key），查询用 `encodeURIComponent`，带浏览器 User-Agent；结果在本地按 host 过滤 `allowed_domains` / `blocked_domains`（子域包含在内，blocked 优先），最多 10 条。非 2xx 是错误而不是静默空结果。输出 `{query, results: Array<{title, url, snippet}>, durationSeconds, searchCount}`；`searchCount` 在同一会话的工具实例内累加，跨会话独立。

### AskUserQuestion：显式 marker 区分「答案」与「控制性拒绝」

- broker 在答案路径上把 `{behavior:'deny', message}` 当作工具输出：`answerQuestion` / `clarifyQuestion` / malformed input 三条路径给结果对象打上宿主内部的 symbol marker（`QUESTION_RESULT`），native 的 `requestPermission` 用 `isQuestionResult` 转成 `questionResult: true`。
- loop 只在 `call.name === 'AskUserQuestion'` **且** `decision.questionResult === true` 时把 deny 结果发成 `is_error: false`；interrupt / abort、`denyAll`（session closed）、缺少 permission handler、普通权限拒绝都不带 marker，仍是 `is_error: true`。marker 是 symbol-keyed，JSON 序列化到 SDK control-response 时自然消失，claude provider 的线上行为不变。
- 回答的正文是 `{note, answers: [{question, answer}]}`（单选取字符串、多选取数组、跳过为 `null`），note 明确说明这是来自 AskUserQuestion 的用户答案。客户端 `QuestionDialog` / `QuestionCard` 因此无需变化。

### 标题：复用辅助调用

- `generateTitle(description)` 走共享的 `callAnthropicMessages`：模型 `profile.recapModel || this.model`（调用时解析）、`system` 为固定标题 prompt（要求只返回标题本身）、`maxTokens: 64`、`temperature: 0.3`、`caller: 'session-title'`、目标为会话 profile 的 `credentials()`；返回辅助响应的首个 text block。
- manager 的 `autoGenerateTitle` 在**调用前**与**await 之后**各检查一次 `s.title`：用户命名或上一次自动标题已经落地的标题永不被覆盖；非空结果 trim 后写入 `SessionMeta` 并 `persist()`（随之广播 `session-update`）。`capabilities.supportsSessionTitle = true`。

### `accountInfo` 诚实为空

- native 没有 CLI 账号状态（`ProviderProfile` 里没有 email / org / subscription / token source），`accountInfo()` 直接 resolve `undefined`，不发明任何字段。`capabilities.supportsAccountInfo = true`，所以 `/sessions/:id/account` 返回 `{account: null}`，而不是一个没有意义的 501。

### Provider 选择与保留

- `NewSessionDialog` 增加 provider 下拉（`Claude CLI` / `Native in-process`），表单总是提交 `provider`，默认 `'claude'`；native 选中时隐藏 `enabledPlugins` 区块（native 不支持插件），其它 create 字段不变。
- restart 与 new-like-this 现在携带 `source.provider`（此前会丢掉并静默回退到 claude）。在 `defaultProvider` 配置项出现之前，服务端的默认 provider 保持显式的 `'claude'`。

### Sandbox：create 明确拒绝，实现属于独立安全项目

- `SessionManager.create` 在 **worktree provisioning 之前**拒绝 native + `sandbox.enabled === true`（`501 provider native does not support sandbox`），因此不会留下孤儿的 worktree / 分支；native provider 的 `createSession` 对直接调用者做同样的守卫。
- `SettingsPanel` 对 native 会话隐藏 sandbox 区块（不再提供一个必然失败的控件）；`applyFlagSettings({sandbox})` 继续抛错。
- DSH 级隔离（Linux bubblewrap/Landlock、macOS Seatbelt、Windows restricted-token ACL runner 且只能部分强制）超出 P1.6 范围。未来项目应先确定单一平台/后端与显式 fail-closed 语义，再把该设置暴露给 native 会话。
- 各条 sandbox 路径的覆盖分工：manager create 的 501（发生在 worktree provisioning 之前、不留下孤儿目录）由 `server/providers/native/e2e-tools.test.ts` 经 `SessionManager` 覆盖；provider 的直接守卫（直接调用 `createSession`）与 `applyFlagSettings({sandbox})` 的拒绝在 `server/providers/native/native-session.test.ts`；`SettingsPanel` 对 native 隐藏 sandbox 区块在 `src/components/SettingsPanel.test.tsx`；manager 层的「拒绝先于 provisioning、不产生 worktree」断言另有 `server/session-manager.test.ts` 的专测。P1.6 的其余端到端路径（真实 PermissionBroker 问答、stubbed `fetch` / DNS、无真实网络）同样由 `e2e-tools.test.ts` 覆盖。

### 延迟项

- sandboxing 本身（独立项目）；create 拒绝之外的 `Options.sandbox`；`renameSession` / provider transcript 的改标题；`GET /api/providers` 端点；ChatPanel 的 provider chip；`defaultProvider` 配置项。
