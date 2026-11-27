# Native compact 保留可见历史 设计

日期：2026-11-26
状态：已实现（`docs/superpowers/plans/2026-11-26-native-compact-retain-history.md`）
范围：native provider 的自动 in-place compact（`runAutoCompact` / `compactInPlace` / native session-log reader）

## 1. 背景与意图

native provider 的自动 in-place compact 当前把"模型上下文压缩"实现成一次"宇宙重置"：manager 清空 history ring、重置 transcript seq generation、广播 `session-cleared`，native reader 又把分页 / entries / 搜索 / reconcile 快照全部地板（floor）在最后一条 `session/compact` 事件。结果是压缩后用户**永远看不到压缩前的对话**——向上滚动、重新打开、resume、fork、搜索都读不到。

两个参照系都不这么做：

- **claude provider**：CLI 自身的 compact 保留压缩前历史可见。`server/history-reader.ts` 读全量 JSONL、无 compact 地板，`compact_boundary` 只是 transcript 里的一条分隔线，向上滚动照常翻旧消息。
- **DSH**：log / surface 双层分离。压缩在 surface（模型上下文）上"遮蔽"（shadow）选中区间，但 UI transcript 从 log 渲染，被遮蔽的行原样保留。契约原文（`packages/client/ui-conversation/src/client/contract/records.ts`）："The conversation it shadowed on the model surface stays in the transcript above it: the marker reports where the model stopped seeing that history, it does not replace it."

native 之所以偏离，是有记录的简化：持久化 spec（`2026-11-09-native-session-persistence-design.md` §5）明确"不借鉴（本阶段）projection/checkpoint 框架"。没有 DSH 的 log/surface 双投影，native reader 只有单投影，于是让渲染面地板对齐模型历史地板（`reader.ts` 注释 "matching historyFromEvents' model-history floor"），ordered-reconcile 又把 compact 并入与 `/clear` 同一套 generation-reset 机制。

本设计把 native 的压缩体验对齐 claude：**历史保留可见，压缩处一条分隔线 + 摘要卡片，模型侧上下文依旧压缩**。数据零风险——native log 本就 append-only 全保真，本设计只放开读取面。

## 2. 目标 / 非目标 / 反目标

### 目标

- 新发生的 native 自动 compact 之后，压缩前对话在 transcript 中保留可见：向上滚动懒加载、重新打开、resume、fork 都能读到；搜索能命中压缩前内容。
- 压缩位置呈现 claude 式分隔线（`compact_boundary`）+ 摘要卡片（`isCompactSummary`），摘要直接铺开。
- 模型上下文依旧在最后一条 compact 处地板——压缩仍然真正缩小模型看到的上下文（这是 compact 的意义）。
- 客户端零改动：native 产出的帧形状与 claude 一致，复用现有 CompactBoundary + 摘要卡渲染。

### 非目标

- **不恢复存量 session**：本设计上线前已压缩过的 session 维持现状（历史仍隐藏）。前向 fence 保证旧行为不变。
- 不动 `/clear`、`/handoff`（X→Y 换会话续接）、fork、resume 的既有语义。
- 不给 native 增加手动 `/compact`（native 当前无功能性手动 in-place compact；claude 的 `/compact` 发给 CLI，native 无 CLI）。如需另立 feature。
- 不引入 DSH 的 log/surface 双投影框架或可展开标记行 UI。

### 反目标（做到即失败）

- 模型上下文因保留可见历史而重新膨胀（模型地板被破坏）。
- 存量已压缩 session 的历史被意外暴露或行为改变。
- 压缩后摘要把保留的整段可见历史重摘一遍（摘要输入未地板）。
- 同一 app 内 native 与 claude 的压缩呈现分叉。

## 3. 关键设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 呈现用 claude 式（分隔线 + 摘要卡铺开），不用 DSH 可展开标记行 | 客户端零成本（帧形状已一致）；跨 provider 一致。DSH 式需新造 UI 组件且让两种 provider 呈现分叉 |
| D2 | 前向 fence：`session/compact` 事件加可选 `retainHistory` 标记。reader 只对带标记的 compact 放开渲染面地板；无标记（legacy）维持地板 | "只管未来"的干净边界，存量 session 完全不受影响；additive 可选字段，向后兼容 |
| D3 | 模型历史地板（`historyFromEvents` / `lastCompactIndex`）不变，始终地板在最后一条 compact（无论标记） | 模型永远只看压缩后上下文，compact 的压缩意义不破 |
| D4 | compact 从 reset 降级为 append：`runAutoCompact` 不再 prepare/commit reset journal、不再 `resetTranscriptGeneration` / `store.reset` / 清 ring / 发 `session-cleared` / 删 sidecar；改为 provider 追加 marker 事件 + 换模型历史后，`pushCompactFrames` 照常追加 boundary + summary 两帧 | compact 是 transcript 里的一条标记，不是宇宙重置。崩溃安全由 reader 从 log 合成 marker 保证，不依赖 journal 两阶段提交 |
| D5 | reader 拆双 floor：渲染面地板 = 最后一条**无标记**的 legacy compact；带标记的 compact 在其 seq 位置内联合成 boundary + summary 标记行，前后历史照常返回 | 即使一个 session 跨越新旧设计多次压缩，旧地板依旧遮旧内容、新压缩只插标记 |
| D6 | 摘要输入地板到最后一条 compact boundary，**仅作用于 native auto-compact**：`runAutoCompact` 在取摘要输入时局部丢弃 merged ring 中最后一条 `compact_boundary` 帧及之前的内容；共享 `mergedHistoryForCompaction` 不动 | ring 不再清空，否则第二次压缩会重摘保留的旧历史。摘要必须只代表模型当前看到的（压缩后）历史。地板不能进共享 helper——它另有 `/handoff` / plugin-compact 调用方（含 claude），会违反"不动 /handoff"非目标 |
| D8 | compact 事件载荷加 `summaryUuid`：manager 统一铸造一次，传给 `compactInPlace`（落盘）与 `pushCompactFrames`（live 摘要帧）；reader 从 `summaryUuid` 合成摘要 | live 摘要原用 `randomUUID()`、磁盘合成原用 event uuid（与 boundary 同）。保留历史后 uuid-only 去重会在重启时把磁盘摘要当未知追加成第二张卡。统一 uuid 使 live==磁盘，boundary/summary 保持不同 uuid（claude 约定） |
| D7 | 保留 compact 的磁盘渲染投影同时合成 boundary + summary（entries / page 路径，与 snapshot 路径一致） | claude 式分隔线在重新打开后也要可见；顺带修掉旧设计"磁盘重渲染只有摘要卡没有分隔线"的 cosmetic 缺口 |

## 4. 组件机制

### 4.1 事件词汇与解析（前向标记）

- `server/providers/native/vocabulary/session-event.ts` 的 `'session/compact'` 载荷加两个可选字段：
  `{ text: string; context: string; uuid: string; timestamp: string; retainHistory?: boolean; summaryUuid?: string }`。
  `uuid` 仍是 boundary 身份；`summaryUuid` 是摘要帧身份（D8），仅 retain compact 携带。
- `server/providers/native/session-log/format.ts` 的 v3 解析（`parseEventLineV3`）接受并保留这两个可选字段；缺省为 `undefined`（legacy）。
- v1/v2 → v3 迁移（`migration.ts`）：旧事件无此字段，迁移后 `retainHistory` 为 `undefined`，自然落入 legacy 地板。无需迁移逻辑改动，只需确保迁移不丢弃未知可选字段（builder 核验）。
- 该字段是纯数据，`neutralEventsOf` 等读消费者无需改动；只有 reader 地板逻辑读它。

### 4.2 provider `compactInPlace`

`server/providers/native/native-session.ts` `compactInPlace`（约 1994）签名加 `summaryUuid`，写事件时带标记与摘要身份：

```ts
async compactInPlace(summary: string, opts: { uuid: string; timestamp: string; summaryUuid: string }): Promise<void>
// ...
this.log.append({
  type: 'session/compact',
  time: Date.parse(opts.timestamp),
  data: { text: summary, context, uuid: opts.uuid, timestamp: opts.timestamp, retainHistory: true, summaryUuid: opts.summaryUuid },
})
```

其余不变：flush 后才 splice 模型历史（`this.history` 重置为 context + summary），`lastUsage` 归零，`pdfBudgets.rebuildFromEvents`。模型历史地板由 `historyFromEvents` 保证，与此标记无关。

### 4.3 manager `runAutoCompact`

`server/session-manager.ts` `runAutoCompact`（约 6129）移除 reset 链路，保留摘要与 provider 调用：

保留：
- 阈值 / idle / `autoCompacting` 守卫，`mergedHistoryForCompaction` + `summarizeMergedForCompact`（输入按 D6 在 `runAutoCompact` 内局部地板）。
- 摘要 await 后的 identity + phase 复检。
- `s.lastContextUsage = undefined`（**保留清空**，见下）。
- `compactInPlace.call(s.handle, summary, { uuid, timestamp, summaryUuid })`。
- `pushCompactFrames(s, summary, uuid, timestamp, preTokens, summaryUuid)`（照常追加 boundary + summary 到 ring + seq，广播给 subscribers）。

新增（D8）：在 provider 调用前统一铸造 `const summaryUuid = randomUUID()`，同时传给 `compactInPlace`（落盘）与 `pushCompactFrames`（live 摘要帧 uuid）。`pushCompactFrames` 的摘要帧不再内部 `randomUUID()`，改用传入的 `summaryUuid`；boundary 帧仍用 `uuid`（event 身份）。

移除：
- `journal.prepare({ reason: 'compact', ... })` 与 `resetTranscriptGeneration(s.id, 'compact', journal)` 及其 try/catch degraded 分支。
- `promptUuidStore` / `clientOperationStore` / `steeredStore` / `turnAnchorStore` / `resultFrameStore` 的 sidecar 重置循环。
- `t.store.reset()`、`t.generationHistory` 的 compact 条目、`s.history = []`、`s.subagentHistory = []`、`s.promptUuids = []`、`s.steeredInFlight.clear()`、`s.withdrawnUuids = []`、`s.pendingSnapshotAnchors = undefined`。
- `broadcastSessionCleared(s.id, ...)`。

注意：
- **`s.lastContextUsage` 保留清空**（纠正早期草稿）：post-turn 无压力触发 `maybeAutoCompact(s)` 读 `getCachedContextUsage(id) ?? s.lastContextUsage`；若不清，provider 侧 `lastUsage` 虽归零，manager 缓存仍停在压缩前高位，一个未刷新 usage 就结算的 turn（如首帧前 interrupt/error）会用陈旧高值再次触发压缩、只重摘上一份摘要。清空防此回归。ContextBar"压缩后保持旧百分比"的 UX 不受影响——清空不广播零 usage，客户端持有上次显示值直到下一 turn 产生新 usage 帧（这正是旧设计实现该 UX 的方式）。
- `promptUuids` / `steeredInFlight` / `withdrawnUuids` 不清：它们描述的是输入队列配对，compact 在 idle 发生（无在飞 turn / 队列），本就为空或已结算；保留不影响。builder 核验 idle 守卫确实保证这些在 compact 时为空。
- 日志：保留一条 info（"auto-compact: appended compact marker, history retained"），移除 reset 措辞。

### 4.4 legacy reset-journal 恢复（保留）

`recoverResetJournal` / `providerHasResetFloor` / `resetTranscriptGeneration` 的 `'compact'` 分支**保留不动**——存量 session 的 compact-reset journal 仍需恢复。新 compact 不再产生 journal，这些分支只伺候存量。`resetTranscriptGeneration` 的 `reason: 'clear' | 'compact'` 类型保留（clear 仍用；legacy 恢复仍读 'compact'）。

### 4.5 reader 双 floor

`server/providers/native/session-log/reader.ts`：

- `lastCompactEvent` / `findLastCompact` 当前返回最后一条 compact。改为区分两类：
  - **渲染面地板** = 最后一条 `retainHistory !== true` 的 compact（legacy）。无则不地板。
  - **内联标记** = 所有 `retainHistory === true` 且 seq 大于渲染面地板的 compact。
- `floorAtCompact`（entries / page 共用的 `loadFlooredLines`）与 `readNativeHistorySnapshot` 统一为新投影：
  1. 若有 legacy 地板：丢弃 seq ≤ 地板 seq 的行，在地板位置维持该路径**现有**的 legacy 投影——entries / page 仅 summary（`floorAtCompact` 现状），snapshot 为 boundary + summary（`readNativeHistorySnapshot` 现状）。存量呈现零变化。
  2. 对每个 retain compact：在其 seq 位置内联插入 `compactBoundaryLine(event)` + `compactSummaryLine(event)`（所有路径一致，D7），前后行原样保留。
  3. 无 compact：原样。
- entries / page 路径（`loadFlooredLines`）当前只合成 summary（`floorAtCompact`）；按 D7，retain compact 的投影改为 boundary + summary 双行，使分隔线在磁盘分页可见。legacy 地板投影维持 summary-only（存量呈现不变）。
- `readNativeHistorySnapshot`（reconcile）已合成 boundary + summary；改为对 retain compact 内联插入、对 legacy 地板维持原 floored 投影。
- `compactBoundaryLine` 复用现有构造（uuid = `event.data.uuid`）。`compactSummaryLine` 的 uuid 改为 `event.data.summaryUuid ?? event.data.uuid`（D8）：retain compact 用持久化的 `summaryUuid`，与 live 摘要帧一致；legacy 事件无 `summaryUuid`，回退 `event.data.uuid`，呈现不变。boundary 与 summary 因此保持不同 uuid（claude 约定），uuid-only 去重在 live 与磁盘间对齐，重启不再追加重复摘要卡。frameKind 仍区分二者。
- 缓存：`nativeHistoryCache` 存原始 renderable 行（不含 compact 合成），地板/标记在读取时投影，缓存键 `(size, mtimeMs)` 不变。`compactMemo` 需缓存"legacy 地板 + retain 标记列表"而非单条 compact（builder 决定 memo 形状）。

### 4.6 摘要输入地板（D6，仅 native auto-compact）

地板**只作用于 `runAutoCompact` 的摘要输入**，不进共享 `mergedHistoryForCompaction`（约 8630）——后者另有 `compact(id, {handoff})`（约 5918，`/handoff` 与 plugin-compact，含 claude）调用方，共享地板会违反"不动 /handoff"非目标并改变 claude handoff 输入。

实现：`runAutoCompact` 取 `mergedHistoryForCompaction(s)` 后，局部丢弃最后一条 `compact_boundary` 帧及其之前的所有帧，再交给 `summarizeMergedForCompact`：

```ts
const merged = this.mergedHistoryForCompaction(s)
const lastBoundary = findLastIndex(merged, m => m.type === 'system' && m.subtype === 'compact_boundary')
const span = lastBoundary >= 0 ? merged.slice(lastBoundary + 1) : merged
const summary = await this.summarizeMergedForCompact(s, span)
```

（或等价地给 `mergedHistoryForCompaction` 加一个仅 `runAutoCompact` 传 true 的可选地板参数；builder 择一，默认局部切片以免触碰共享 helper。）

ring 中存在 `compact_boundary` 帧由 `pushCompactFrames` 保证（每次 compact 追加）。首次压缩无 boundary → 全量。摘要因此只代表模型当前看到的压缩后历史。`/handoff`、plugin-compact、claude 的摘要输入零变化（补钉死测试）。

## 5. 边界与兼容

- **存量 session**：compact 事件无 `retainHistory` → legacy 地板 → 历史仍隐藏；其 reset journal 恢复分支保留。行为零变化。
- **混合多次压缩**（旧设计压缩过、升级后再压缩）：渲染面地板在最后的 legacy compact，retain compact 只插标记。旧压缩前的内容依旧隐藏，新压缩保留其前后历史。模型地板始终在最后一条 compact。
- **fork**：fork 复制事件前缀（含 retain 标记的 compact 事件）。forked session 的 reader 套用同一双 floor → 渲染面保留历史 + 标记；模型历史经 `historyFromEvents` 地板。无需特殊改动（builder 核验 fork 种子路径确实逐字复制 compact 事件及其标记）。
- **resume / 重新打开**：reader 投影保留历史 + 标记；新 compact 的 seq sidecar 从未 reset，reconcile 快照含全量历史 + 标记。模型经 `historyFromEvents` 地板。
- **崩溃安全**：compact 是 append-only marker。provider 追加 `session/compact`（flush，含 `summaryUuid`）后换模型历史；manager 追加 boundary + summary 帧。若 manager 帧追加前崩溃，reader 从 log 的 `session/compact` 事件合成 marker（摘要用 `summaryUuid`），渲染面不丢分隔线/摘要，且与正常重启产出同一身份（无重复卡）。无需 journal 两阶段提交。
- **搜索**：entries 路径放开地板后自然命中压缩前内容（claude 对齐）。
- **模型上下文**：`historyFromEvents` 地板不变，模型永远只看最后 compact 之后。provider 侧 `lastUsage` compact 归零；manager 侧 `s.lastContextUsage` 保留清空（防陈旧高值重复触发，见 §4.3）。ContextBar 客户端持有上次显示值直到下一 turn 的新 usage 帧，与 ring 保留无关。

## 6. 测试翻转

P1.1 plan（`2026-11-09-native-p1.1-context-efficiency.md`）不变量 3/4 与对应测试钉死了旧行为，需翻转：

- 不变量 3"same-id reset is complete / replay cannot resurrect pre-compact messages"→ 改为"compact 是 append marker，ring/seq 延续，replay 保留压缩前历史"。
- 不变量 4"resume/fork starts at the compact floor（reader/page/search exclude pre-compact）"→ 改为"模型历史地板保留；渲染面（reader/page/search）保留压缩前历史 + 内联标记"。
- `e2e-persistence.test.ts` / `reader.test.ts` 中"page/entries/search 不含 pre-compact"的断言翻转为"含 pre-compact + 标记"；新增 legacy（无标记）compact 仍地板的断言（前向 fence）。
- `session-manager.test.ts` compact reset 相关断言（ring 清空、session-cleared、generation bump）翻转为 append 行为。
- 新增钉死测试：
  - 压缩后向上分页 / 搜索读到压缩前消息；
  - 模型历史（`historyFromEvents`）仍地板；
  - 第二次压缩的摘要输入只含上次压缩后历史（D6）；
  - **`/handoff` / plugin-compact / claude 的摘要输入不受 D6 地板影响**（共享 helper 不变）；
  - legacy compact（无标记）维持地板（存量不变）；
  - 混合 legacy + retain 多次压缩的渲染面投影；
  - 磁盘重渲染含分隔线 + 摘要卡（D7）；
  - **摘要帧身份 live==磁盘**：retain compact 重启 / reconcile 后只有一张摘要卡（`summaryUuid` 对齐，uuid-only 去重不追加重复）；崩溃恢复与正常重启产出同一摘要身份（D8）；
  - **无陈旧 usage 重复压缩**：压缩后一个未刷新 usage 即结算的 turn 不再触发第二次压缩（`lastContextUsage` 清空生效）。
- `neutrality.test.ts` / `host-free.test.ts` 结构钉不受影响（无新边界 import）。

## 7. 留给 builder

- `compactMemo` 的新形状（legacy 地板 + retain 标记列表）与缓存失效语义。
- reader 三处投影（`floorAtCompact` / `loadFlooredLines` / `readNativeHistorySnapshot`）的统一抽象，避免三处各写一遍地板/标记逻辑。
- `findLastIndex` 的实现位置（manager 内联或共享 util）。
- 迁移路径对未知可选字段的保留核验。
- fork 种子路径逐字复制 compact 标记的核验。
- idle 守卫保证 compact 时 `promptUuids` / `steeredInFlight` / `withdrawnUuids` 为空的核验。
- 日志措辞与 metrics（如有 compact reset 相关计数器）同步。

## 8. 风险

- **ordered-reconcile spec 耦合**：compact-as-reset 写在 `2026-11-16-transcript-ordered-reconcile-design.md` §8.3。本设计解耦后需同步更新该 spec（compact 不再是 reset reason 的生产者，仅 legacy 恢复消费）。这是文档同步，不是机制风险。
- **摘要输入地板依赖 ring 中的 boundary 帧**：若 ring 因 500 上限 eviction 丢了 boundary 帧，ring 切片找不到地板会退化为全量（最新 500 帧），漏掉模型仍看到的早期 post-compact 内容与上一份摘要。已由 followups B（权威模型历史输入）解决，见 `2026-11-26-native-compact-followups-design.md`：in-place compact（auto + manual）的摘要输入取自 provider 的权威模型历史（`getCompactionInput`，无上限、始终地板在最后 compact），ring 切片仅为无此能力 provider 的回退。
- **legacy 呈现微调**：D7 让新 compact 磁盘投影含分隔线，legacy 维持 summary-only。两种投影并存是有意为之（前向 fence），非缺陷。