# Native Compact 后续清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三项后续——删确证死代码（forReset/resetGeneration）、D6 摘要输入改用权威模型历史（仅模型可见，免疫 ring 驱逐）、补廉价测试覆盖。

**Architecture:** B 加一个能力门控的 `getCompactionInput(): SDKMessage[]` handle 方法：native core 暴露中性模型历史（`historyFromEvents`，无上限、已地板、排除 sidechain），host adapter 投影为 SDK 并恢复 floor 摘要的 `isCompactSummary` 身份；`runInPlaceCompact` 优先用它，ring-slice 保留为回退。A 删死方法。C 补测试。`session-cleared` 通道不动（另立票）。

**Tech Stack:** TypeScript (ES2022), Node 20, vitest（server Node 环境）。

**Spec:** `docs/superpowers/specs/2026-11-26-native-compact-followups-design.md`

## Global Constraints

- native core neutrality：core 生产文件禁 SDK / `agent-message` / host-frame import（value + type-only）；`getCompactionInput(): SDKMessage[]` 绝不在 core——core 只暴露中性 `RequestMessage[]`，SDK 投影 + 身份恢复在 host adapter（`native-host-frame-adapter.ts`）。`neutrality.test.ts` / `host-free.test.ts` 须绿。
- 模型历史地板 `historyFromEvents` / `lastCompactIndex`（replay.ts）**绝不改动**。
- 共享 `mergedHistoryForCompaction` 不动（/handoff + plugin-compact + claude 输入不变）。
- compact 的 append/retain 语义、D8 身份、前向 fence 不变。
- `session-cleared` 通道不动（另立票）。
- ES2022（无 Array.findLastIndex）；日志 createLogger；append-only log。
- 每 task 提交前过 review；commit message 结尾 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 聚焦测试 `npx vitest run <file>`；全量门 `npm run typecheck && npm run test && npm run lint && npm run verify:agent-notes`。
- git MCP 工具指向主 checkout——worktree 内一律用 Bash git。

## Review Focus

1. **ring 驱逐 boundary 后摘要仍完整**：post-compact 超 500 帧时，摘要输入仍含上一份摘要 + 早期 post-compact（取自模型历史）。Task 3 钉。
2. **上一份摘要全文保留**：floor 摘要带 `isCompactSummary` → `extractHistory` 全文 System 行，不截断 500。Task 2/3 钉。
3. **投影块覆盖**：thinking/附件/tool_result（含 file 块）全覆盖，不漏模型所见。Task 2 钉。
4. **subagent 语义**：内部 chatter 排除、结果（Agent tool_result）保留。Task 2/3 钉。
5. **死代码删除安全**：forReset/resetGeneration 零生产调用方，legacy 恢复（recoverResetJournal 直写 batch）不依赖它。Task 1 钉。

---

### Task 1: A — 删除确证死代码 forReset / resetGeneration

**Files:**
- Modify: `server/transcript-writer.ts`（`static forReset` ~106、`async resetGeneration` ~539）
- Modify: `server/transcript-writer.test.ts`（resetGeneration 自测 ~326-353）

**Interfaces:**
- Produces: 无（纯删除）。`recoverResetJournal` 仍直写 `sidecar.appendBatch`，legacy 恢复不变。

- [ ] **Step 1: 核验零生产调用方**

Run: `grep -rn "forReset\|resetGeneration" server/ --include="*.ts" | grep -v "\.test\."`
Expected: 仅 `transcript-writer.ts` 的定义行（无调用方）。若有意外调用方，STOP 报告。

- [ ] **Step 2: 删除方法 + 自测**

删 `transcript-writer.ts` 的 `static forReset` 与 `async resetGeneration`。**保留**它们共享的仍被 live append/rebuild/legacy 恢复消费的辅助（`ledger.next`/`nextBatchId`/`makeCommitV2`/`commit`/`ResetJournal`/`GenerationRecord` 等）——只删确证无消费者的方法体。删 `transcript-writer.test.ts` 中仅测 `resetGeneration`/`forReset` 的用例。

- [ ] **Step 3: 跑测试确认绿**

Run: `npx vitest run server/transcript-writer.test.ts server/transcript-reconcile.test.ts`
Expected: PASS。再跑 legacy 恢复相关：`npx vitest run server/session-manager.test.ts -t 'journal'`（或 reset-journal describe）确认绿。

- [ ] **Step 4: typecheck + 提交**

Run: `npm run typecheck`（noUnusedLocals 须过）。
```bash
git add server/transcript-writer.ts server/transcript-writer.test.ts
git commit -m "refactor(native): drop dead forReset/resetGeneration after compact append demotion

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: B — 权威模型历史投影 + getCompactionInput handle

**Files:**
- Modify: `server/providers/native/core-contract.ts`（中性访问器）
- Modify: `server/providers/native/native-session.ts`（实现中性访问器）
- Modify: `server/providers/native-host-frame-adapter.ts`（SDK 投影 + 身份恢复 + wrapNativeCore 委托）
- Modify: `server/providers/types.ts`（`ProviderSessionHandle.getCompactionInput?`）
- Test: `server/providers/native-host-frame-adapter.test.ts`（或新建投影测试）

**Interfaces:**
- Consumes: `historyFromEvents(neutralEventsOf(log)): RequestMessage[]`（replay.ts，已地板/排除 sidechain）；neutral `RequestMessage`（vocabulary/message.ts：UserMessage/AssistantMessage/ToolResultMessage/SystemMessage/DeveloperMessage/RequestUserInput，各含 role + content: ContentBlock[] + id）；`session/compact` 事件 `data.{text,context,uuid,summaryUuid}`。
- Produces: `ProviderSessionHandle.getCompactionInput?(): SDKMessage[]`——模型历史的 SDK 投影，floor 摘要标 `isCompactSummary:true`，context 快照不计 user turn，sidechain 排除。Task 3 消费。

- [ ] **Step 1: 写失败测试（投影契约）**

在 adapter 测试加（沿用该文件现有中性→SDK 测试 fixture）：

```ts
it('getCompactionInput projects model history to SDK with summary identity, excludes sidechain', () => {
  // 构造含 pre-compact turn + session/compact(text=SUMMARY, context=CTX, summaryUuid) + post turn + subagent sidechain 的 log
  const input = handle.getCompactionInput!()
  // 形状：user/assistant/tool_result SDK 消息
  // floor 摘要消息 isCompactSummary === true（extractHistory 全文 System）
  const summary = input.find(m => (m as any).isCompactSummary)
  expect(summary).toBeDefined()
  expect(extractText((summary as any).message.content)).toContain('SUMMARY')
  // context 快照不计 user turn（标记/跳过——按实现机制断言）
  // subagent 内部 chatter 不在；subagent 结果（Agent tool_result）在
  expect(JSON.stringify(input)).not.toContain('subagent-internal-chatter')
  // 块覆盖：thinking / 附件 ref / tool_result(含 file 块) 不丢
})
```

（断言意图：身份恢复 + sidechain 排除 + 块覆盖；具体 fixture 按现有 adapter 测试构造。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native-host-frame-adapter.test.ts -t 'getCompactionInput'`
Expected: FAIL — `getCompactionInput` 不存在。

- [ ] **Step 3: 实现中性访问器 + SDK 投影 + 接线**

- `core-contract.ts` + `native-session.ts`：加中性 `getCompactionHistory(): RequestMessage[]`，返回 `historyFromEvents(neutralEventsOf(this.log))`。**core 不 import SDK。**
- `native-host-frame-adapter.ts`：加 `RequestMessage → SDKMessage` 薄映射（复用 `sdkAssistantBlock` 等块映射；tool_result 须容 file 块，**不**复用会 throw 的 live `projectToolResult`）。覆盖 user/assistant/tool_result/system/developer/RequestUserInput 所有类型与 thinking/附件/tool_result 块。
- **身份恢复**：读 log 最后一条 `session/compact` 事件，把对应摘要消息（text 匹配 `compact.data.text`）标 `isCompactSummary:true`；context 快照（`compact.data.context`）标记/跳过使 `extractHistory` 不计 user turn（机制 builder 定，如 isMeta 或省略；测试钉死）。
- `wrapNativeCore`：委托 `getCompactionInput: () => projectCompactionInput(core.getCompactionHistory(), compactEvents)`。
- `types.ts`：`ProviderSessionHandle` 加 `getCompactionInput?(): SDKMessage[]`。

- [ ] **Step 4: 跑测试确认绿 + neutrality**

Run: `npx vitest run server/providers/native-host-frame-adapter.test.ts server/providers/native/vocabulary/neutrality.test.ts server/providers/native/host-free.test.ts`
Expected: PASS（投影测试 + 结构钉）。

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add server/providers/native/core-contract.ts server/providers/native/native-session.ts server/providers/native-host-frame-adapter.ts server/providers/types.ts server/providers/native-host-frame-adapter.test.ts
git commit -m "feat(native): authoritative getCompactionInput model-history projection with summary identity

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: B — runInPlaceCompact 改用权威输入 + 驱逐免疫集成

**Files:**
- Modify: `server/session-manager.ts`（`runInPlaceCompact` ~6228）
- Test: `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 2 `s.handle.getCompactionInput?(): SDKMessage[]`。
- Produces: native in-place compact（auto + manual）摘要输入取自权威模型历史；ring-slice 保留为回退。

- [ ] **Step 1: 写失败测试（驱逐免疫 + 身份 + subagent）**

```ts
it('compact summary input survives ring eviction of the boundary (authoritative model history)', async () => {
  // 第一次 compact 后，构造 post-compact 超 500 帧使 ring 驱逐 boundary + 上一份摘要 + 早期 post turn
  // 触发第二次 compact，断言 summarize 输入仍含上一份摘要 + 早期 post-compact（取自 getCompactionInput，不退化）
})
it('runInPlaceCompact prefers getCompactionInput over ring-slice', async () => {
  // mock handle.getCompactionInput 返回标记 span，断言 summarizeMergedForCompact 收到它
})
it('native compact summary excludes subagent internals, keeps results', async () => {
  // 含 subagent sidechain 的 session，断言摘要输入无内部 chatter、有 Agent tool_result
})
```

（驱动方式沿用现有 native auto-compact 测试；ring 驱逐可用超 500 帧或 mock。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-manager.test.ts -t 'authoritative model history'`
Expected: FAIL — 当前用 ring-slice，驱逐后退化。

- [ ] **Step 3: 改 runInPlaceCompact**

`runInPlaceCompact`（~6228）摘要输入改为：
```ts
const authoritative = s.handle.getCompactionInput?.()
const span = authoritative ?? this.ringSliceForCompact(s)  // 现有倒序 boundary 切片抽为回退方法
const summary = await this.summarizeMergedForCompact(s, span)
```
现有倒序 boundary 切片逻辑保留为 `ringSliceForCompact`（回退，无 getCompactionInput 时）。共享 `mergedHistoryForCompaction` 不动。更新 doc 注释（权威输入 + 仅模型可见 + 回退）。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS（含现有 compact 测试）。

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(native): in-place compact summarizes authoritative model history, immune to ring eviction

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: C — 测试补全（parser rejection / writer omission / e2e identity+ordering）

**Files:**
- Modify: `server/providers/native/session-log/format.test.ts`
- Modify: `server/providers/native/native-session.test.ts`
- Modify: `server/providers/native/e2e-persistence.test.ts`

**Interfaces:** 无新生产代码（纯测试）。

- [ ] **Step 1: parser guard-rejection 测试**

`format.test.ts` 加：`retainHistory:false` / 非布尔 → 解析后 `retainHistory` undefined；`summaryUuid:''` / 非字符串 → undefined。

- [ ] **Step 2: writer omission 测试**

`native-session.test.ts` 加：`compactInPlace('S', {uuid:'c1', timestamp})`（无 summaryUuid）→ 事件 `data` 不含 `summaryUuid` 键、`retainHistory:true`。

- [ ] **Step 3: e2e identity + ordering 测试**

`e2e-persistence.test.ts`：pin 3 page surface 补 boundary uuid 断言（`=== boundaryUuid`）；pin 4 reconcile 补 `status==='ok'`；加 marker ordering 断言（boundary index < summary index）。

- [ ] **Step 4: 跑测试确认绿 + 提交**

Run: `npx vitest run server/providers/native/session-log/format.test.ts server/providers/native/native-session.test.ts server/providers/native/e2e-persistence.test.ts`
Expected: PASS。
```bash
git add server/providers/native/session-log/format.test.ts server/providers/native/native-session.test.ts server/providers/native/e2e-persistence.test.ts
git commit -m "test(native): compact parser rejection, writer omission, e2e identity+ordering pins

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 全量门 + 文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-11-26-native-compact-followups-design.md`（状态→已实现）
- Modify: `docs/superpowers/specs/2026-11-26-native-compact-retain-history-design.md`（§8 parked 风险标注已由 followups B 解决）
- Modify: `CLAUDE.md`（native 段：compact 摘要取权威模型历史，仅模型可见）

- [ ] **Step 1: 全量门**

Run: `npm run typecheck && npm run test && npm run lint && npm run verify:agent-notes`
Expected: 绿（预存 Windows flake 按隔离归因，非 compact 相关）。

- [ ] **Step 2: 文档同步**

followups spec 状态→已实现；retain-history spec §8 的 D6 eviction parked 风险标注"已由 followups B（权威模型历史输入）解决"；CLAUDE.md native 段补一句摘要输入取权威模型历史（仅模型可见，免疫 ring 驱逐）。

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/specs/2026-11-26-native-compact-followups-design.md docs/superpowers/specs/2026-11-26-native-compact-retain-history-design.md CLAUDE.md
git commit -m "docs(native): mark compact followups implemented; authoritative summary input

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 压缩摘要 image ref→base64 水合（预存 bug 修复）

**Files:**
- Modify: `server/compact-attachments.ts`（`buildCompactAttachmentContent` ~341，image 块处理 ~360；`imageBase64Chars` ~172）
- Test: `server/compact-attachments.test.ts`

**Interfaces:**
- Consumes: `resolveImageBlocks(content, opts: ResolveImageOptions): Promise<(T|ResolvedImageBlock)[]>`（attachment-resolver.ts:264，验证 ref→base64 source，fail-closed，opts.stateDir+signal）；`ImageRefBlock`/`isImageRefBlock`（shared/image-attachment.ts）。
- Produces: compact 摘要请求的 image 块带 base64 `source`（Anthropic API 要求），ring-slice 与权威投影两路径共享受益。

**背景**：预存 bug——native 压缩带图像 session 时，`buildCompactAttachmentContent` 把 image ref 原样（`structuredClone`）推入摘要内容，`callAnthropicMessages` 不解析 ref → API 400。旧 ring 路径同样如此（parity）。

- [ ] **Step 1: 写失败测试**

```ts
it('buildCompactAttachmentContent resolves image refs to verified base64 source', async () => {
  // 构造含 ImageRefBlock 的 message + occurrences，store 里有对应图像
  const result = await buildCompactAttachmentContent(messages, occurrences, { uploadStore, stateDir })
  // 断言 image 块带 source:{type:'base64',data,media_type}（非纯 ref）
  // budget（imageBase64Chars）按 base64 计
})
it('legacy base64 image blocks pass through unchanged', async () => { /* ... */ })
it('missing/corrupt image ref fails closed (resolver verification)', async () => { /* ref 无对应 store 对象 → throw */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/compact-attachments.test.ts -t 'resolves image refs'`
Expected: FAIL — image 块仍是纯 ref（无 source）。

- [ ] **Step 3: 实现水合**

`buildCompactAttachmentContent` 组装 image 块前，对 ImageRefBlock 复用 `resolveImageBlocks`（opts.stateDir 已传入；signal 若有则传）解析为 ResolvedImageBlock（base64 source）。legacy base64 块直通。`imageBase64Chars` 预算按解析后 base64 计。fail-closed（ref 无对应/损坏 → resolver throw）。不新建图像存储路径，复用单一验证点。

- [ ] **Step 4: 跑测试确认绿 + 提交**

Run: `npx vitest run server/compact-attachments.test.ts`
Expected: PASS。
```bash
git add server/compact-attachments.ts server/compact-attachments.test.ts
git commit -m "fix(native): hydrate compact image refs to verified base64 for the summary API

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖**：A1→Task1；B1/B2→Task2/3；B3/B4/B5→Task2；C1→Task4；§6 测试→各 task；§5 边界（claude/handoff/legacy/模型地板）→Global Constraints + Task1/3 测试。
- **类型一致**：`getCompactionHistory(): RequestMessage[]`（core，中性）vs `getCompactionInput(): SDKMessage[]`（handle，adapter 投影）命名区分；Task2 产出 → Task3 消费一致。
- **Review Focus**：1→Task3，2→Task2/3，3→Task2，4→Task2/3，5→Task1。
- **比例**：以签名 + 测试断言为主；投影块映射细节留 builder（§7），代码块仅用于 runInPlaceCompact 切换。