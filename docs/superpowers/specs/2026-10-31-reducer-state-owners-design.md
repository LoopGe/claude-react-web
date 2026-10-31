# Reducer 按状态所有者拆分设计

- 日期：2026-10-31
- 状态：待用户审批
- 范围：`src/session-store/reducer.ts`、`normalize.ts`、相关状态模块与测试

## 1. Intent / Why

`reducer.ts` 当前约 3541 行，同时负责 action 路由、消息处理、replay 合并、seq window、live-turn、六类生命周期索引和回合收尾。`normalize.ts` 另约 1176 行，混合消息分类、索引提取和 turn-status 纯函数。

目标是把实现拆成六个真正的状态所有者：

- `transcript-log`
- `replay-merge`
- `live-turn`
- `tool-index`
- `sidechain-index`
- `turn-status`

`reduceSessionState(state, action)` 的外部接口、SessionStore dispatch 和现有行为测试 seam 保持不变。用户已允许顺带删除经证明无用的兼容逻辑，并明确允许顺带修复 dismissed 在 replay 后复活的问题。

## 2. Goals

1. 每个模块拥有明确字段、action 家族和不变量，而不是接收完整 mirror 的浅转发层。
2. `reduceSessionState(state, action)` 保持同一函数签名和返回语义。
3. 保持主会话 seq-window、子代理 `REPLAY_REPLACE + MESSAGE`、streaming、pendingResults 和 activeWorktree 行为。
4. 拆分过程中不产生 `applyMessage ↔ replayReplace` 或 `transcript-log ↔ index-pipeline` 循环依赖。
5. 让 reducer 入口只剩 action 路由与少量简单字段处理，复杂实现由独立模块拥有。
6. 每一步可独立测试、审查和提交，避免一次性重写。

## 3. Non-goals

- 不引入新的状态库，不改变 `SessionState`/`ServerMirror` 的整体数据模型。
- 不改变 WS/REST 协议、SessionSynchronizer、SessionSnapshot 投影或 UI。
- 不删除仍在使用的 `REPLAY_REPLACE`、overlap、stale-copy replace、mid-slice、chronology repair、prepend 或 draft 逻辑。
- 不顺带拆分 SessionStore DEV dump、registry、selector 或其他客户端模块。
- 不把 `purge/destroy`、`unref`、`cachedSubagentsMap` 等额外候选项混入本工程。

## 4. Anti-goals / 失败即错

- 六个文件只是接收和返回完整 mirror 的浅 reducer，实际复杂度仍靠互相调用维持。
- `drainPendingResults` 改为调用完整 `applyMessage`，造成消息重复追加。
- 为删除“旧代码”而移除子代理 `reset:true` 所需的 cache-merge 路径。
- 改变 tool → sidechain → pendingResults 的处理顺序，导致孤儿结果漏配或重复配对。
- 把 dismissed 修复变成删除 `dismissedSubagents`，或让 replay 再次复活 dismissed。
- 通过一次性大改让现有 reducer/seq/replay 测试失去覆盖。

## 5. 目标模块与所有权

| 模块 | 拥有字段/职责 | 主要 action / 接口 |
|---|---|---|
| `transcript-log` | `items`、`messages`、`window`、`activeWorktree`、prepend、trim/evict、seq 边界 | `windowLive/Page/Evict`、`prependMessages`、`trimFront`、`evictMessages`、`MEMORY_ITEM_CAP` |
| `replay-merge` | `REPLAY_REPLACE` 的 fresh/cache merge、overlap、stale copy、mid-slice、chronology | `replayReplace`、`dedupeReplayPayload`、`splitReplayAgainstCache` |
| `live-turn` | `liveTurn`、`draft/frozenDrafts/draftRowKeys/draftSeq`、token rate、apiRetry/thinkingTokens 的瞬态行为 | `updateLiveTurnMirror`、`flushLiveTurn`、`pruneFinalizedLiveTurnText` |
| `tool-index` | `pidToToolUseId`、`planStatus`、`planContent`、`questionAnswers`、`toolStatus`、`toolResults` | `updateToolIndexMirror`、permission handlers |
| `sidechain-index` | `activeSubagents`、`activeWorkflows`、`activeSkills`、task snapshot join、dismissed 状态、`hasTranscriptBackground`（读取 Subagent status，sidechain 生命周期谓词） | `updateSidechainIndexMirror`、`applyTasksSnapshot`、`dismissSubagent`、`reapplyDismissed`、`hasTranscriptBackground` |
| `turn-status` | `sessionState`、turn-end sweep、stale timeout、Waiting/Active 纯规则 | `sweepAtTurnEnd`、`settleStaleLiveSubagents`、`computeWaiting`、`computeTurnActive`、`countTaskActivity` |

### 必要的内部协调模块

以下模块不是额外业务层，而是避免循环依赖所需的内部 seam：

- `index-pipeline`：按固定顺序组合 tool-index 与 sidechain-index，统一 `updateIndexesMirror`、owner-known 判断和 `pendingResults` 的 park/drain/prune；导出 `rebuildIndexesFromMessages` 与统一的 `pruneIndexesToLive(live, retained)`，供 transcript-log 在 trim/evict 时裁剪全部索引而不直接改写其他模块字段。
- `message-pipeline`：组合 transcript-log、live-turn、index-pipeline 和 turn-status，保留完整 `applyMessage` 的处理顺序与 intent 交互。
- `user-message-lifecycle`：拥有 `pendingPlaceholders`、optimistic/ack 和 `clearSendingPlaceholders`；consumed/steered 的 intent 部分由它处理，transcript 的 items/messages/activeWorktree 重写则通过 `transcript-log` 的 stamp 接口完成。

## 6. 依赖方向

```text
types / normalize / seq-window / draft-state（叶子）
        │
        ├─ tool-index ────────┐
        ├─ sidechain-index ───┤
        │                     ▼
        │               index-pipeline
        │                     │
        ├─ transcript-log ────┤
        │                     │
        ├─ live-turn          │
        ├─ turn-status        │
        │                     ▼
        │               message-pipeline ◀── user-message-lifecycle
        │                     │
        └─ replay-merge ──────┘
                              │
                         reducer.ts 入口
```

约束：

- `transcript-log` 可以调用 `index-pipeline.rebuildIndexesFromMessages` 和 `pruneIndexesToLive`，但 `index-pipeline` 不得调用 transcript-log。
- `user-message-lifecycle` 可以调用 transcript-log 的 consumed/steered stamp 接口完成 mirror 更新；transcript-log 不得反向调用 user-message-lifecycle。
- `replay-merge` 可以调用 `message-pipeline.applyMessage` 和 `transcript-log.prependMessages`，两者不得调用 replay-merge。
- `reducer.ts` 可以调用所有模块；任何业务模块不得反向 import reducer 入口。
- `drainPendingResults` 只能重放 index-pipeline，不得调用完整 message-pipeline。

## 7. applyMessage 顺序必须保持

`message-pipeline` 必须保留当前顺序，而不是仅按模块拼接：

1. FIFO 消费最老 optimistic placeholder；
2. 计算 `effectiveConsumedAt`；
3. 路由 apiRetry / thinkingTokens 瞬态槽；
4. 更新 live-turn；
5. 更新 transcript items/messages 和 activeWorktree；
6. 更新 tool/sidechain indexes；
7. drain pendingResults（仅 index-pipeline）；
8. prune finalized live-turn text；
9. supersede draft；
10. 清理已消费 pendingConsumedMessages；
11. result 分支：freeze draft、sweep turn、清空 liveTurn、清理 sending placeholders；
12. trimFront；
13. refusal-fallback / supersedes eviction。

其中 tool/plan/question 必须先于 sidechain 更新，pendingResults 的 `resultOwnerKnown` 才能看到一致视图。

## 8. 关键行为约束

### 8.1 Replay 与子代理

- `REPLAY_REPLACE` 的 fresh 和 cache-merge 都保留；子代理 WS `reset:true` 会走 cache-merge。
- `dedupeReplayPayload`、`splitReplayAgainstCache`、`replaceStaleCachedMessages`、`applyMidSlice`、`repairChronology`、`countPromptOverlap` 均为 live code。
- `isDiskReplay && !result` 的 sweep 保留；live in-memory replay 不得提前 sweep。

### 8.2 Sidechain 与 dismissed

- `TASKS_SNAPSHOT.isBackgrounded` 仍是 `isAsync` 的唯一权威。
- 子代理 launch-ack 不得被当成真正 result；child-result-flip 的“无 live-status guard”行为保留。
- `dismissed` 是终态，不得被 task-notification 恢复。
- **用户批准的行为修复：** replay rebuild 完成后调用 `reapplyDismissed`，并在每次 `rebuildIndexesFromMessages` 完成后同样重应用，覆盖 replay/reset 以及 trim 后 page-back 的索引重建，使 dismissed 不被恢复为 running。新增主会话、子代理 replay 和 trim 后分页回归测试。

### 8.3 PendingResults 与 turn-status

- `pendingResults` 仍 cap 256，按 owner-known park/drain，sidechain child id 不得进入 pendingResults。
- drain 只更新索引，不能重复写 items/messages/liveTurn。
- `sweepAtTurnEnd` 保持 identity-stable；background→pending，sync running→interrupted，Workflow/Skill running→interrupted。
- `countTaskActivity` 保持 `indicator <= all` 的结构不变量。

### 8.4 Transcript 与 streaming

- `MEMORY_ITEM_CAP=1000`、`MEMORY_TRIM_SLACK=256` 和 trim boundary 语义不变。
- activeWorktree 继续满足 `activeWorktree === getActiveWorktree(messages)`，随机 action 序列不变量测试保留。
- streaming telemetry 仍在叶子订阅；Chat/MessageList 每 flush 0 renders 的测试不得回退。

## 9. 允许删除或修复的兼容点

### 9.1 删除 `toTranscriptItem` 的 `cachedPlainText` 参数

生产调用方均只传 `(msg, prev)`；该参数只属于已删除的持久化缓存。删除第三参数及注释，把测试改为直接验证 lazy memo：

- memoized `null` 仍表示“无可提取文本”并短路；
- `undefined` 才触发实时计算。

**不要删除** `topLevelUserPromptSignature` 的同名参数；`countPromptOverlap` 在生产中实际传入 `items[].plainText`。

### 9.2 接回 `reapplyDismissed`

它不是应删除的死代码，而是未接线的必要逻辑。把它归入 sidechain-index，在 replay-merge 完成后和每次 index-pipeline 的批量索引重建后应用，并修正文档为实际调用路径。

### 9.3 其他候选项

`settleStaleLiveSubagents` 的导出、helper re-export、`purge/destroy`、registry `unref` 等不作为本工程清理项。后续若发现新候选，必须先证明无生产消费者和行为贡献，再单独裁决，不得在实现中顺手删除。

## 10. 外部接口与类型整理

- `reduceSessionState(state, action)` 保持原签名。
- `reducer.ts` 暂时 re-export 现有 helper，避免测试与调用方同步大改：
  - `rebuildIndexesFromMessages`（index-pipeline）
  - `splitReplayAgainstCache` / `dedupeReplayPayload`（replay-merge）
  - `reapplyDismissed`（sidechain-index）
  - `settleStaleLiveSubagents`（turn-status）
  - `MEMORY_ITEM_CAP`（transcript-log）
- `normalize.ts` 可暂时 re-export turn-status 纯函数，消费者逐步改为从 `turn-status.ts` 引入。
- 将 `ActiveWorktree` 类型从 `normalize.ts` 移到 `types.ts`，让 normalize 改为从 types 引入，消除当前 `types ↔ normalize` 类型级环依赖；不改变运行时行为。

## 11. 分阶段迁移

### Stage 0：基线与预备

- 保持现有 reducer、session-sync、subagent、active-worktree 测试作为 characterization suite。
- 移动 ActiveWorktree 类型，删除 `toTranscriptItem.cachedPlainText` 并迁移测试。
- 在 sidechain-index 阶段添加并修复 dismissed replay/page-back 回归测试，避免中间阶段留下红灯。

### Stage 1：提取 live-turn

- 移动 streaming delta、rate、prune、LIVE_TURN_FLUSH 和 draft 相关实现。
- 保持 streaming-render-isolation 与 inline/overlay 测试不变。

### Stage 2：提取 sidechain-index

- 移动 Subagent/Workflow/Skill、TASKS_SNAPSHOT、 dismissal。
- 接回 reapplyDismissed 并通过新增的 dismissed replay/page-back 回归测试。

### Stage 3：提取 tool-index

- 移动 generic tool/plan/question 和 pid mapping；`pendingResults` 的 park/drain/prune 不归本模块，而由 Stage 5 的 index-pipeline 统一拥有。
- 保持 PERMISSION_RESOLVED、orphan result 和索引配对行为。

### Stage 4：提取 turn-status

- 移动 turn-end sweep、stale timeout 和纯 Waiting/Active 规则。
- 保持 computeWaiting/computeTurnActive/countTaskActivity 的调用方接口。

### Stage 5：形成 index-pipeline

- 用固定 tool → sidechain 顺序组合索引。
- 统一 owner-known、park/drain/prune、`rebuildIndexesFromMessages` 和 `pruneIndexesToLive(live, retained)`，保证无重复 append，并在批量索引重建后重应用 dismissed。

### Stage 6：形成 transcript-log

- 移动 prepend、trim/evict、window handlers、activeWorktree 和 cap。
- 通过 seq-window、active-worktree 与 replay 测试。

### Stage 7：形成 message-pipeline 与 user-message-lifecycle

- 按 §7 的精确顺序移动 applyMessage 和 intent 交互。
- 保持 optimistic FIFO、effectiveConsumedAt、draft supersede、trim 和 refusal eviction。

### Stage 8：形成 replay-merge 并收敛 reducer.ts

- 移动完整 replay merge 与 helper。
- reducer.ts 只保留 action 路由、简单字段写入和 re-export。
- 删除不再需要的旧分发代码，跑全量验证并检查依赖图无运行时循环。

## 12. 测试策略

- 保留 `reducer.test.ts` 的外部接口测试，不为了对应文件而机械重写。
- 新模块只为其所有者不变量添加聚焦测试，避免重复整套集成测试。
- `active-worktree.test.ts` 的随机序列与每一步不变量断言必须保留。
- `subagent-ingest.test.ts`、`SubagentTranscriptDialog`、`useSubagentTranscriptStore` 覆盖 fresh/reset/incremental。
- `tool-status.test.ts`、`skill-index.test.ts` 覆盖 index 配对和 sidechain child。
- 新增 dismissed replay/reset 与 trim 后 page-back 回归测试。
- 每阶段运行相关测试；最终运行 typecheck、项目源码 lint、`npx vitest run src`、build 和 `npm test`，并区分已接受的基线失败。

## 13. 完成定义

- 六个目标模块真实拥有自己的实现和不变量，reducer.ts 不再承载这些实现。
- `reduceSessionState` 签名和外部行为不变，helper re-export 不形成永久第二业务层。
- 无运行时循环依赖；pendingResults drain 不产生重复消息。
- dismissed 在 replay/reset 以及 trim 后 page-back 的索引重建后均保持 dismissed。
- `toTranscriptItem.cachedPlainText` 删除，lazy memo 语义仍有测试。
- 所有相关客户端测试、typecheck、lint 和 build 通过。
