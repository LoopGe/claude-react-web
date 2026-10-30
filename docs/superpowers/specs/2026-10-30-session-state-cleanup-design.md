# Session 状态与旧 Cursor 协议清理设计

- 日期：2026-10-30
- 状态：待用户审批
- 范围：`src/session-store/*`、相关 SessionSynchronizer/reducer/store 测试与过期注释

## 1. Intent / Why

SessionSynchronizer 重构完成后，主会话统一走 seq-window，子代理 transcript 使用 `REPLAY_REPLACE + MESSAGE`。SessionStore 仍保留几类旧接口：

1. 没有生产消费者的 SessionSnapshot 投影和公开方法；
2. 已退役 IDB/localStorage 时代的固定 readiness/cache 字段；
3. 旧 uuid cursor 协议留下的 action、marker 和写而不读的字段。

这些残留让 `SessionSnapshot`、`ServerMirror` 和 reducer 看起来比实际协议更复杂，也增加误用两套状态源的风险。本次只做**已验证无生产行为贡献的清理**，不顺带重写 reducer。

## 2. 当前事实与删除边界

### 2.1 可直接删除的 Store / Snapshot 表面

| 候选 | 当前证据 | 处理 |
|---|---|---|
| `SessionSnapshot.permissionDecisions` | 只由 `store.ts` 投影；无组件/selector 消费 | 删除 snapshot 投影，同时删除 mirror 字段及 reducer 写入；`planStatus` 保留 |
| `ServerMirror.permissionPending` | 只在 `PERMISSION_REQUEST/RESOLVED` 中写入和清理，无生产读取 | 删除字段和写入；`pidToToolUseId` 必须保留 |
| `SessionSnapshot.activeWorkflows` | running-only 投影及缓存只在 `store.ts` 内使用，无生产消费者 | 删除投影、`cachedWorkflowsMap/cachedRunningWorkflows` 和 `getRunningWorkflows`；mirror 与 `workflowIndex` 保留 |
| `hydrateReady` / `idbReady` | `store.ts` 固定写 `true`，只有 store 测试读取 | 删除字段、投影和固定值断言 |
| `cacheHasDroppedMedia` | `store.ts` 固定写 `false`，无生产读取 | 删除字段、投影及 `src/types.ts` 中的过期注释 |
| `dispatchMany` | 无生产或测试调用 | 删除方法，保留单 action `dispatch` |
| `useSessionSnapshot` / `getSessionState` | 只有声明和注释，无调用方 | 删除；保留 `useSessionField` / `useSessionSelector` / `getSessionStore` |
| `reset` / `clearPersisted` / 私有 `wipe` | 没有生产调用；只有一个 store 测试和一个 SessionSynchronizer 测试使用 | 删除方法；需要清空行为的测试改为 dispatch `CLEAR_TRANSCRIPT` |

### 2.2 旧 cursor 协议

| 候选 | 当前证据 | 处理 |
|---|---|---|
| `ADOPT_CURSOR` | 没有生产 dispatcher | 删除 action、switch 分支和 `adoptCursor` |
| `SETTLE_RESULT_INDEXES` | 类型注释已明确被 `pendingResults` 取代，无生产 dispatcher | 删除 action、分支、`settleResultIndexes` 和旧测试；保留 `pendingResults` |
| `MARK_TAIL_FIRST_APPLIED` / `tailFirstUnsettled` | 只服务上述旧 settle 路径 | 删除 action、字段、初始化及旧测试 |
| `PREPEND_MESSAGES` | 没有生产 dispatcher；内部 helper 仍由 seq page 与 replay 调用 | 只删除公开 action 和 switch 分支；**保留 `prependMessages` helper** |
| `lastMessageUuid` | snapshot 无消费者；mirror 中仅被写入、比较和维护，没有任何生产逻辑根据它决定 replay、渲染或同步行为 | 删除 snapshot 与 mirror 字段、初始化、replay/append/evict 中的写入维护，以及纯 cursor 断言 |
| `isCursorAnchorable` | 只为 `lastMessageUuid` 的写入和维护服务 | 随字段一起删除；不影响其他 normalize 逻辑 |

## 3. Goals

1. SessionSnapshot 只保留真实消费者需要的字段。
2. reducer 不再维护无行为贡献的 permission、cursor 和 readiness 状态。
3. 主会话 seq-window 行为不变；子代理 `REPLAY_REPLACE + MESSAGE` 行为不变。
4. 保留当前 prepend、replay overlap、chronology repair、pendingResults 和 activeWorktree 不变量。
5. 测试从“旧协议实现细节”调整为“当前公开行为”，而不是机械删除整组 replay/prepend 覆盖。

## 4. Non-goals

- 不按模块拆分 reducer，不改变 `reduceSessionState(state, action)` 的外部接口。
- 不改变 `REPLAY_REPLACE`、seq/tombstone、WS 或 REST 协议。
- 不修改 SessionSynchronizer 的 run/paging/generation/epoch 逻辑。
- 不合并 `items/messages/window`、tasks 与 subagent detail。
- 不清理其他 App/UI 候选，不顺带处理 CSS 或工程基线。

## 5. Anti-goals / 失败即错

- 删除 `ServerMirror.activeWorkflows`、`workflowIndex`、`planStatus` 或 `pidToToolUseId`。
- 删除 `REPLAY_REPLACE`、`prependMessages` helper、`pendingResults` 或子代理去重/overlap 逻辑。
- 将仍有生产行为的测试全部当成“旧协议测试”删除。
- 用新的兼容 alias、空方法或固定默认值代替被清理接口，继续扩大无意义表面。
- 为了通过类型检查而保留写而不读的 cursor 字段。

## 6. 分批实施

### Batch A：Store 与 Snapshot 表面清理

1. 删除 readiness/cache 固定字段和对应测试断言。
2. 删除 `permissionDecisions` 的 mirror/snapshot/reducer 维护；保留 `planStatus` 的 permission-resolution 更新。
3. 删除 `permissionPending`，保留 `pidToToolUseId` 和实际 permission channel。
4. 删除 `activeWorkflows` running-only 投影和缓存，保留 mirror/workflowIndex。
5. 删除 `dispatchMany`、`useSessionSnapshot`、`getSessionState`、`reset/clearPersisted/wipe`。
6. 将需要清空的测试改为 `CLEAR_TRANSCRIPT`，并更新过期注释。

**独立验收：** store、selectors、commands、permission/plan、WorkflowCard/Overlay 测试通过。

### Batch B：旧 Cursor 协议清理

1. 删除 `ADOPT_CURSOR`、`SETTLE_RESULT_INDEXES`、`MARK_TAIL_FIRST_APPLIED` 及其实现。
2. 删除 `tailFirstUnsettled`。
3. 删除公开 `PREPEND_MESSAGES` action，保留内部 `prependMessages` helper 及 `WINDOW_PAGE` / replay 调用。
4. 删除 `lastMessageUuid` 和 `isCursorAnchorable` 的全部维护逻辑，包括：
   - replay 的 cursor advance 区块；
   - append 的 cursor 写入；
   - evict 的 cursor 修复；
   - snapshot 投影和初始化。
5. 更新测试：
   - 删除只验证已删除 action/cursor 的用例；
   - 仅验证 uuid dedup 的 prepend 用例改用当前 seq page 输入；signature/prompt-overlap 用例改走 `REPLAY_REPLACE` 的 older slice，因为 `WINDOW_PAGE at:'head'` 固定 `trustUuidDedup: true`，不能覆盖该路径；
   - replay 用例继续断言去重、overlap、顺序和子代理状态，不再断言 cursor 值；
   - active-worktree 随机序列移除旧 action，保留 WINDOW_* 与不变量断言。

**独立验收：** reducer、active-worktree、subagent-ingest、SubagentTranscriptDialog、SessionSynchronizer 全部相关测试通过。

## 7. 测试策略

### 保留并加强的行为覆盖

- `PERMISSION_RESOLVED` 仍能翻转 `planStatus`、问题回答和 `pidToToolUseId` 清理。
- Workflow 的 running/completed 记录仍通过 `workflowIndex` 可读取。
- seq page 的 prepend、uuid/prompt overlap、tombstone 和 chronology repair 不变。
- 子代理 REST bootstrap、WS reset、MESSAGE 增量和磁盘 replay 不变。
- activeWorktree 在所有 prepend/evict/trim/replay 路径上继续满足不变量。
- `CLEAR_TRANSCRIPT` 保持测试所需的 empty-live-ready 语义。

### 删除或改写的实现细节覆盖

- 删除 `ADOPT_CURSOR`、`SETTLE_RESULT_INDEXES`、`MARK_TAIL_FIRST_APPLIED` 的专项测试。
- 删除仅断言 `lastMessageUuid` 增长、修复或 anchor 选择的断言；保留同测试中的实际 replay 行为断言。
- `PREPEND_MESSAGES` 的 uuid-dedup 用例迁移到 `WINDOW_PAGE at:'head'`，使用合法 seq/page 构造；signature/prompt-overlap 用例迁移到 `REPLAY_REPLACE` 的 older slice（`trustUuidDedup: false`）；不能机械保留旧 action 调用或把两类去重混为一条路径。

### 最终验证

- 全仓搜索确认上述删除项无生产引用。
- `npm run typecheck`
- 项目源码 lint（0 errors）
- `npx vitest run src`
- `npm run build`
- `npm test`；如出现已记录的 Windows server 基线问题，单独区分，不掩盖新的客户端失败。

## 8. 完成定义

- 本设计列出的字段、方法和公开 actions 全部删除，无兼容别名。
- `SessionSnapshot` 不再包含固定 readiness/cache 字段或无消费者投影。
- reducer 不再写入 `permissionDecisions`、`permissionPending`、`lastMessageUuid` 或 `tailFirstUnsettled`。
- 子代理 replay、seq prepend、plan/workflow 和 activeWorktree 的相关测试全部通过。
- 没有为了清理而改变 UI、WS/REST 协议或 SessionSynchronizer 行为。
