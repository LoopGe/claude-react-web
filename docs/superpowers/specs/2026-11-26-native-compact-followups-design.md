# Native compact 后续清理 设计

日期：2026-11-26
状态：已实现（`docs/superpowers/plans/2026-11-26-native-compact-followups.md`）
范围：retain-history 特性落地后的三项后续（死代码清理、D6 权威摘要地板、测试补全）。`session-cleared` 通道清理**不在本次**（另立票）。

## 1. 背景与意图

retain-history 特性（`2026-11-26-native-compact-retain-history-design.md`）已落地 main 并通过 CI。final review 留下三项后续：

- **A 死代码**：`TranscriptWriter.forReset` / `resetGeneration` 在 compact 降级为 append 后失去唯一生产调用方（`resetTranscriptGeneration` 已删），现仅剩定义 + 自测。
- **B D6 权威地板**：`runInPlaceCompact` 的摘要输入靠"在 ring 里倒序找最后一条 `compact_boundary` 帧再切片"。ring 有 500 上限——若两次压缩之间落入 500+ 帧，boundary 帧（及其前的 pre-compact、其后的早期 post-compact 与上一份摘要）被驱逐，切片退化为"最新 500 帧"，摘要会**漏掉模型仍看到的早期 post-compact 内容与上一份摘要**。权威来源是 provider 的模型历史（`historyFromEvents`，无上限、始终地板在最后 compact）。
- **C 测试补全**：parser guard-rejection、writer omission 分支、e2e boundary-uuid/ordering 钉子。

意图：消除 B 的退化（用权威模型历史），清掉 A 的确证死代码，补 C 的廉价覆盖。`session-cleared` 通道虽无生产者，但帧被约 10 个文件消费且注释定位为"未来 in-band clear 生产者"脚手架——本次不动。

## 2. 目标 / 非目标 / 反目标

### 目标
- B：native in-place compact（auto + manual 共享 `runInPlaceCompact`）的摘要输入取自 provider 模型历史，免疫 ring 上限驱逐。
- A：删除 `forReset` / `resetGeneration` 及其自测（确证无生产调用方）。
- C：补 parser guard-rejection（`retainHistory:false`/非布尔、`summaryUuid:''`/非字符串被忽略）、writer omission（无 `summaryUuid` 时事件不带该键）、e2e boundary-uuid 与 marker ordering 钉子。

### 非目标
- 不动 `session-cleared` 通道（另立票）。
- 不动模型历史地板 `historyFromEvents` / `lastCompactIndex`。
- 不动 `/handoff` / plugin-compact / claude 的摘要输入（共享 `mergedHistoryForCompaction` 不变）。
- 不改 compact 的 append/retain 语义、D8 身份、前向 fence。

### 反目标
- 摘要输入因 ring 驱逐而漏掉模型仍看到的内容（B 要消除的）。
- 删除仍被消费的代码（A 只删确证死的；`session-cleared` 不删）。
- 破坏 neutrality / host-free 结构钉。

## 3. 关键设计决策

| # | 决策 | 理由 |
|---|---|---|
| A1 | 删 `TranscriptWriter.forReset`（transcript-writer.ts:106）+ `resetGeneration`（:539）+ 其自测 | 确证零生产调用方（`recoverResetJournal` 直写 `sidecar.appendBatch`，不经此）；保留只是死代码 |
| B1 | `ProviderSessionHandle` 加可选 `getCompactionInput?(): SDKMessage[]`，capability-gated；native 实现返回模型历史的 SDK 投影 | 权威、无上限的摘要输入；可选 + 能力门控，不碰 claude/handoff |
| B2 | `runInPlaceCompact` 优先 `s.handle.getCompactionInput?.()`，无则回退现有 ring-slice | native 总有该方法；回退保底（不破坏无此能力的假设调用方）。ring-slice 逻辑保留为回退 |
| B3 | native `getCompactionInput` = `historyFromEvents(neutralEventsOf(log))` 逐条投影为 SDKMessage，**仅模型可见**（sidechain/subagent 内部排除） | 模型历史已含 context/skill/supplement 内联插入与地板；subagent **结果**在主历史（Agent tool_result）保留，内部 chatter 排除（用户决定，与 claude/DSH 一致） |
| B4 | 投影恢复 floor 摘要身份：adapter 从 log 的 `session/compact` 事件（`summaryUuid`/`text`）识别摘要消息并标 `isCompactSummary:true`；context 快照标记/跳过（不计 user turn） | `historyFromEvents` 把 floor 摘要推为无标记 userText；`recap.ts extractHistory` 靠 `isCompactSummary` 把上一份摘要保留为全文 System 行。不恢复身份会把摘要截断 500 字符，经 transcript budget 重新引入 B 要消除的丢失 |
| B5 | 中立接线：core 暴露中性模型历史访问器（`RequestMessage[]`），SDK 投影在 host adapter（`native-host-frame-adapter.ts`），`wrapNativeCore` 委托为 handle 的 `getCompactionInput` | core 禁 SDK import（neutrality）；`getCompactionInput(): SDKMessage[]` 只能在 adapter/host 侧 |
| C1 | 补三组测试（parser rejection / writer omission / e2e identity+ordering） | 关闭 final review 的覆盖缺口 |

## 4. 组件机制

### 4.1 A — 死代码删除
- `server/transcript-writer.ts`：删 `static forReset`（:106）与 `async resetGeneration`（:539）及其仅服务的私有辅助（若 exclusively 服务 reset）。
- `server/transcript-writer.test.ts`：删 `resetGeneration` 的自测（约 :326-353）。
- 核验：`grep -rn "forReset\|resetGeneration" server/ --include=*.ts`（除被删文件）零命中；`recoverResetJournal` 仍直写 batch，legacy 恢复测试绿。
- 若 `resetGeneration` 引用的类型/辅助（如 `GenerationRecord` 的 reset 分支）仍被 legacy 恢复消费，**保留**那些；只删确证无消费者的方法体。

### 4.2 B — 权威摘要地板（仅模型可见）
- `server/providers/types.ts`：`ProviderSessionHandle` 加 `getCompactionInput?(): SDKMessage[]`（doc：模型历史的 SDK 投影，compact 摘要的权威输入；native 提供；仅模型可见，sidechain 排除）。
- `server/providers/native/core-contract.ts`：中性契约加**中性**访问器（如 `getCompactionHistory?(): RequestMessage[]`），**不**含 SDK 类型。
- `server/providers/native/native-session.ts`：实现中性访问器，返回 `historyFromEvents(neutralEventsOf(this.log))`（neutral `RequestMessage[]`，已地板、已含 context/skill/supplement、已排除 sidechain）。
- `server/providers/native-host-frame-adapter.ts`：SDK 投影在此——把中性 `RequestMessage[]` 逐条映射为 SDKMessage（user/assistant/tool_result），块映射复用现有中性→SDK 家族（`projectAssistant`/`projectToolResult` 等；builder 钉确切复用点，必要时抽薄映射，须覆盖 thinking/附件/tool_result 所有块类型）。**身份恢复（B4）**：读 log 最后一条 `session/compact` 事件，把对应摘要消息标 `isCompactSummary:true`（使 `recap.ts` 保留全文 System 行），context 快照消息标记/跳过（不计 user turn）。`wrapNativeCore` 把该投影委托为 handle 的 `getCompactionInput`。
- `server/session-manager.ts` `runInPlaceCompact`（:6228）：
  ```ts
  const authoritative = s.handle.getCompactionInput?.()
  const span = authoritative ?? ringSliceFallback(s)  // 现有倒序 boundary 切片保留为回退
  const summary = await this.summarizeMergedForCompact(s, span)
  ```
  共享 `mergedHistoryForCompaction` 不动（/handoff + plugin-compact + claude 仍用全量 ring）。
- 附件：`summarizeMergedForCompact` 的 `buildCompactAttachmentContent(span, occurrences)` 对 SDK 投影后的附件 ref 同样工作（模型历史含附件 ref；图像在模型历史已 base64）。builder 核验附件投影一致。
- **subagent 语义（用户决定 B）**：摘要仅模型可见，subagent 内部 chatter 排除（现状经 `mergedHistory` 含它，且每条截断 500 字符）；subagent **结果**保留（主历史的 Agent tool_result）。这是有意的行为演进，与 claude/DSH 一致。

### 4.3 C — 测试补全
- `format.test.ts`：`retainHistory:false` / 非布尔 → 解析后 `retainHistory` undefined；`summaryUuid:''` / 非字符串 → undefined（guard rejection）。
- `native-session.test.ts`：`compactInPlace('S', {uuid, timestamp})`（无 summaryUuid）→ 事件 `data` 不含 `summaryUuid` 键、`retainHistory:true`（writer omission）。
- `e2e-persistence.test.ts`：pin 3 page surface 补 boundary uuid 断言；pin 4 reconcile 补 `status==='ok'`；加 marker ordering 断言（boundary 先于 summary）。

## 5. 边界与兼容
- claude / handoff / plugin-compact：无 `getCompactionInput`，`runInPlaceCompact` 本就 native-only（compactInPlace 能力门控）；共享 helper 不动 → 零影响。
- legacy 恢复：`recoverResetJournal` 直写 batch，不依赖被删方法 → 绿。
- 模型地板：`historyFromEvents` 不动；`getCompactionInput` 复用它 → 摘要输入与模型所见一致。
- ring-slice 回退：保留，无 `getCompactionInput` 时行为同今。

## 6. 测试
- A：删自测后 `transcript-writer.test.ts` 绿；legacy 恢复（reset-journal）测试绿。
- B：新增钉死——
  - 构造 post-compact 超 500 帧（或 mock ring 驱逐 boundary）的场景，断言摘要输入仍含上一份摘要 + 早期 post-compact（取自模型历史，不退化）；
  - 身份恢复：floor 摘要消息带 `isCompactSummary:true`（`extractHistory` 保留为全文 System 行，不截断 500）；context 快照不计 user turn；
  - subagent 语义：subagent 内部 chatter 不在摘要输入，subagent 结果（Agent tool_result）在；
  - `getCompactionInput` 投影形状正确（user/assistant/tool_result + thinking/附件 ref 全覆盖）。
- C：三组新测试绿。
- 全量门：typecheck / test / lint / verify:agent-notes。

## 7. 留给 builder
- B3 的确切中性→SDK 投影复用点（host adapter 家族），必要时抽薄映射；保持 neutrality（core 不 import SDK——投影在 adapter/host 侧）。
- `getCompactionInput` 接到 handle 的确切位置（native-provider / adapter）。
- A 中 `resetGeneration` 私有辅助的依赖核验（只删确证死的）。
- B 测试如何模拟 ring 驱逐（超 500 帧或直接构造）。

## 8. 风险
- B 投影若漏掉模型历史的某类块（thinking/附件），摘要输入会与模型所见不一致——builder 核验投影覆盖所有 RequestMessage 类型，测试钉死。
- 中立边界（B5 已定）：core 只暴露中性 `RequestMessage[]`，SDK 投影 + 身份恢复在 host adapter；`getCompactionInput(): SDKMessage[]` 绝不在 core。neutrality/host-free 结构钉须绿。
- 身份恢复（B4）若匹配错摘要消息（如内容匹配歧义），上一份摘要会被截断——builder 钉确切识别机制（log compact 事件的 text/uuid），测试钉死全文保留。
- subagent 内部排除是有意的行为演进（用户决定 B）：摘要不再含 subagent 内部 chatter（保留结果）。与 claude/DSH 一致；非缺陷。