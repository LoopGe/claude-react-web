# Native Compact 保留可见历史 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** native 自动 in-place compact 后保留压缩前对话可见（claude 式分隔线 + 摘要卡），模型侧上下文依旧压缩，存量 session 行为不变。

**Architecture:** compact 事件加前向标记 `retainHistory` + 摘要身份 `summaryUuid`；provider 写标记、manager 把 compact 从 generation-reset 降级为 append（不清 ring / 不重置 seq / 不发 session-cleared）、reader 拆双 floor（渲染面地板在最后的 legacy compact，retain compact 内联标记，模型地板不动）。客户端零改动。

**Tech Stack:** TypeScript (ES2022 lib), Node 20, Hono, vitest（server 测试 Node 环境）, esbuild。

**Spec:** `docs/superpowers/specs/2026-11-26-native-compact-retain-history-design.md`

## Global Constraints

- native core 中立性：`vocabulary/` 只 import 中性 `shared/*` + Node builtins + 同级 vocabulary；core 生产文件禁 SDK / `agent-message` / host-frame 词汇（`neutrality.test.ts` 钉死，value 与 type-only 均禁）。新字段是纯数据，不引入边界 import。
- `host-free.test.ts` 六端口纪律不变。
- 日志一律 `createLogger(scope)`，禁裸 `console.*`（诊断）。
- append-only log：已提交事件永不改写；compact 只追加事件。
- 模型历史地板 `historyFromEvents` / `lastCompactIndex`（`replay.ts`）**绝不改动**——模型永远只看最后 compact 之后。
- 客户端零改动：native 帧形状与 claude 一致，复用现有 CompactBoundary + 摘要卡渲染。
- 存量 session（compact 事件无 `retainHistory`）行为零变化；legacy reset-journal 恢复分支保留。
- typecheck 跑两个 tsconfig：`npm run typecheck`（`tsconfig.json` + `tsconfig.node.json`）。
- ES2022 lib：无 `Array.prototype.findLastIndex` / `Promise.withResolvers` / `AbortSignal.any`；倒序查找手写 for 循环。
- 每个 task 提交前过 review（CLAUDE.md：禁提交未 review 代码）；subagent-driven 执行自带 per-task review。
- 聚焦测试：`npx vitest run <file>`；全量门：`npm run typecheck && npm run test && npm run lint && npm run verify:agent-notes`。

## Review Focus

1. **retain-compacted session 重启** → transcript 恰好一张摘要卡（`summaryUuid` live==磁盘，uuid-only 去重不追加重复）。Task 3 / Task 5 钉。
2. **压缩后一个未刷新 usage 即结算的 turn**（首帧前 interrupt/error）→ 不再用陈旧高 usage 触发第二次压缩。Task 4 钉。
3. **已 retain-compact 的 native session 跑 /handoff** → 摘要输入不被 D6 地板改变（共享 helper 不动）。Task 4 钉。
4. **同一 log 混合 legacy + retain 多次压缩** → legacy 压缩前内容仍隐藏，retain compact 只插内联标记。Task 3 钉。
5. **provider compact append 之后、manager 帧 append 之前崩溃** → 重载从 log 合成单一干净 marker（分隔线 + 摘要），与正常重启同一身份。Task 3 / Task 5 钉。

---

### Task 1: 事件词汇 + v3 解析器携带前向标记

**Files:**
- Modify: `server/providers/native/vocabulary/session-event.ts:107`（`'session/compact'` 载荷）
- Modify: `server/providers/native/session-log/format.ts:1067-1076`（`parseEventLineV3` case `'session/compact'`）
- Test: `server/providers/native/session-log/format.test.ts`

**Interfaces:**
- Produces: `SessionEventMap['session/compact'] = { text: string; context: string; uuid: string; timestamp: string; retainHistory?: boolean; summaryUuid?: string }`。后续 task 从 neutral 事件 `event.data.retainHistory` / `event.data.summaryUuid` 读这两个可选字段。
- 不改 `NativeCompactEvent`（legacy 扁平接口，format.ts:130）与 `migrateEventToV3` 的 compact 分支（migration.ts:274）——legacy 事件无新字段，迁移后为 `undefined`，自然落入 legacy 地板。

- [ ] **Step 1: 写失败测试**

在 `format.test.ts` 加（沿用该文件现有 v3 解析测试的 helper / 断言风格）：

```ts
it('parseEventLineV3 preserves session/compact retainHistory + summaryUuid', () => {
  const raw = {
    type: 'session/compact', seq: 5, time: 1795661986714,
    data: { text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: '2026-11-26T02:59:46.714Z', retainHistory: true, summaryUuid: 'sum-1' },
  }
  const ev = parseEventLineV3(raw, 5, 's1', '/log') as any
  expect(ev.type).toBe('session/compact')
  expect(ev.data.retainHistory).toBe(true)
  expect(ev.data.summaryUuid).toBe('sum-1')
})

it('parseEventLineV3 session/compact without markers yields undefined fields (legacy)', () => {
  const raw = {
    type: 'session/compact', seq: 5, time: 0,
    data: { text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: '2026-11-09T00:00:00.000Z' },
  }
  const ev = parseEventLineV3(raw, 5, 's1', '/log') as any
  expect(ev.data.retainHistory).toBeUndefined()
  expect(ev.data.summaryUuid).toBeUndefined()
})
```

（`parseEventLineV3(raw: unknown, expectedSeq: number, sessionId: string, path: string)` 接收解析后的对象 + 期望 seq，参照 format.test.ts:460 现有调用。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native/session-log/format.test.ts -t 'session/compact'`
Expected: FAIL — `retainHistory` / `summaryUuid` 为 undefined（解析器当前丢弃）。

- [ ] **Step 3: 改词汇类型 + 解析器**

`session-event.ts:107` 改为：
```ts
'session/compact': { text: string; context: string; uuid: string; timestamp: string; retainHistory?: boolean; summaryUuid?: string }
```

`format.ts` case `'session/compact'`（1067）的 `data` 对象追加两个可选读取（仅当存在且类型正确时携带；`retainHistory` 仅接受 `true`，`summaryUuid` 须非空字符串）：
```ts
data: {
  text: requireV3NonEmptyString(data, 'text', type, sessionId, path),
  context: requireV3NonEmptyString(data, 'context', type, sessionId, path),
  uuid: requireV3NonEmptyString(data, 'uuid', type, sessionId, path),
  timestamp: requireV3NonEmptyString(data, 'timestamp', type, sessionId, path),
  ...(data.retainHistory === true ? { retainHistory: true } : {}),
  ...(typeof data.summaryUuid === 'string' && data.summaryUuid !== '' ? { summaryUuid: data.summaryUuid } : {}),
},
```
（该 case 不走 `requireKnownKeys`，无需改键集。可选字段缺失时不写入，保持 legacy 形状。）

- [ ] **Step 4: 跑测试确认通过 + 迁移 round-trip 不破**

Run: `npx vitest run server/providers/native/session-log/format.test.ts server/providers/native/session-log/migration.test.ts`
Expected: PASS（含现有 `projectNeutralEventToLegacy(migrateEventToV3(e)) === e` legacy corpora round-trip——legacy 无新字段，不受影响）。

- [ ] **Step 5: 提交**

```bash
git add server/providers/native/vocabulary/session-event.ts server/providers/native/session-log/format.ts server/providers/native/session-log/format.test.ts
git commit -m "feat(native): compact event carries retainHistory + summaryUuid markers"
```

---

### Task 2: provider compactInPlace 写标记

**Files:**
- Modify: `server/providers/native/native-session.ts:1994-2018`（`compactInPlace`）
- Modify: `server/providers/native/native-session.test.ts`（现有 `compactInPlace` 调用，约 5680/5688/5734）
- Test: `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SessionEventMap['session/compact']` 可选字段。
- Produces: `NativeSession.compactInPlace(summary: string, opts: { uuid: string; timestamp: string; summaryUuid?: string }): Promise<void>`。`summaryUuid` 可选（保证 Task 4 之前 manager 旧调用仍 typecheck）；provider **始终**写 `retainHistory: true`，`summaryUuid` 仅在提供时写入。Task 4 的 manager 总是提供它。

- [ ] **Step 1: 写失败测试**

在 `native-session.test.ts` 加（沿用该文件现有 compactInPlace 测试的 fixture / `neutralEventsOf` 读法）：

```ts
it('compactInPlace persists retainHistory + summaryUuid and floors model history', async () => {
  // 建一个有 pre-compact turn 的 idle native session（沿用现有 compactable fixture）
  await compactable.compactInPlace('SUMMARY', { uuid: 'c1', timestamp: '2026-11-26T02:59:46.714Z', summaryUuid: 'sum-1' })
  const events = neutralEventsOf(compactable.log)
  const compact = events.find(e => e.type === 'session/compact') as any
  expect(compact.data.retainHistory).toBe(true)
  expect(compact.data.summaryUuid).toBe('sum-1')
  expect(compact.data.uuid).toBe('c1')
  // 模型历史仍地板：historyFromEvents 只含 context + summary + 之后
  const model = historyFromEvents(events)
  expect(JSON.stringify(model)).not.toContain('pre-compact')
  expect(JSON.stringify(model)).toContain('SUMMARY')
})
```

（`historyFromEvents(events: readonly NativeSessionEvent[]): RequestMessage[]`，单参，replay.ts:103。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native/native-session.test.ts -t 'compactInPlace persists retainHistory'`
Expected: FAIL — `retainHistory` / `summaryUuid` undefined。

- [ ] **Step 3: 改 compactInPlace 签名与事件写入**

`native-session.ts:1994` 签名加 `summaryUuid?: string`；`this.log.append` 的 `data` 改为：
```ts
data: {
  text: summary, context, uuid: opts.uuid, timestamp: opts.timestamp,
  retainHistory: true,
  ...(opts.summaryUuid ? { summaryUuid: opts.summaryUuid } : {}),
},
```
其余（flush 后 splice 模型历史、`lastUsage` 归零、`pdfBudgets.rebuildFromEvents`）不动。

- [ ] **Step 4: 更新现有 compactInPlace 调用 + 跑测试**

把 `native-session.test.ts` 现有 `compactInPlace('SUMMARY', { uuid, timestamp })` 调用补 `summaryUuid`（如 `'sum-1'`）；其余 e2e 调用（`e2e-read-file.test.ts:248` 等）若 typecheck 报缺参再补（可选字段，多数无需改）。
Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): compactInPlace writes retain marker + summary identity"
```

---

### Task 3: reader 双 floor + 内联标记 + 摘要身份

**Files:**
- Modify: `server/providers/native/session-log/reader.ts`（`compactSummaryLine` 135、`floorAtCompact` 148、`loadFlooredLines` 159、`lastCompactEvent`/`findLastCompact` 85-128、`readNativeHistorySnapshot` 266、`compactMemo`）
- Test: `server/providers/native/session-log/reader.test.ts`

**Interfaces:**
- Consumes: Task 1 字段（从 neutral 事件 `data.retainHistory` / `data.summaryUuid` 读）。
- Produces: 渲染面投影规则——
  - 渲染面地板 = 最后一条 `retainHistory !== true` 的 compact（legacy）；无则不地板。
  - retain 标记 = 所有 `retainHistory === true` 且 seq > 渲染面地板的 compact，在其 seq 位置内联 `compactBoundaryLine` + `compactSummaryLine`。
  - `compactSummaryLine(event).uuid = event.data.summaryUuid ?? event.data.uuid`。
  - legacy 地板投影维持各路径现状（entries/page 仅 summary；snapshot boundary+summary）；retain 标记所有路径 boundary+summary。

- [ ] **Step 1: 写失败测试**

在 `reader.test.ts` 加。**retain compact 须直接 append neutral v3 事件**（legacy 扁平形状经迁移丢标记）：

```ts
async function seedLogWithRetainCompact() {
  dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
  const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
  const push = (e: never) => log.append(e)
  push({ type: 'session/context', text: 'CTX' } as never)
  push({ type: 'user', uuid: 'p1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'pre-compact' }] } } as never)
  push({ type: 'assistant', uuid: 'p2', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'pre-compact reply' }] } } as never)
  // neutral v3 retain compact
  push({ type: 'session/compact', time: Date.parse('2026-11-09T00:00:02.000Z'), data: { text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: '2026-11-09T00:00:02.000Z', retainHistory: true, summaryUuid: 'sum-1' } } as never)
  push({ type: 'user', uuid: 'u3', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'post-compact' }] } } as never)
  await log.flush(); await log.close()
}

it('retain compact keeps pre-compact history + inline boundary and summary', async () => {
  await seedLogWithRetainCompact()
  const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 20 })
  expect(pageText(page)).toContain('pre-compact')
  expect(pageText(page)).toContain('post-compact')
  expect(pageText(page)).toContain('SUMMARY')
  expect(pageText(page)).toContain('compact_boundary')
  const entries = await readNativeHistoryEntries(dir, 's1', transcriptPort)
  expect(JSON.stringify(entries)).toContain('pre-compact')
})

it('retain compact summary uses summaryUuid (live==disk identity)', async () => {
  await seedLogWithRetainCompact()
  const snap = await readNativeHistorySnapshot(dir, 's1', transcriptPort)
  const summary = snap.entries.find(e => (e.message as any).isCompactSummary)
  expect((summary!.message as any).uuid).toBe('sum-1')
  const boundary = snap.entries.find(e => (e.message as any).subtype === 'compact_boundary')
  expect((boundary!.message as any).uuid).toBe('c1')
})

it('legacy compact (no marker) still floors (existing behavior unchanged)', async () => {
  await seedLogWithCompact()  // 现有 helper，legacy 扁平 compact
  const page = await readNativeHistoryPage(dir, 's1', transcriptPort, { limit: 20 })
  expect(pageText(page)).not.toContain('pre-compact')
})

it('mixed legacy + retain: legacy floor hides its pre-content, retain inserts marker', async () => {
  // seed: legacy compact c1 (floor) → post-legacy turn → retain compact c2 → post-retain turn
  // 断言：legacy 压缩前内容不出现；retain 压缩前（post-legacy）内容出现；两个摘要身份各对
})
```

（混合测试的 seed 与断言按上述意图补全；`readNativeHistorySnapshot` 若未导出则从 reader.ts 导出供测试。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native/session-log/reader.test.ts -t 'retain compact'`
Expected: FAIL — 当前 reader 地板在最后 compact，pre-compact 被丢。

- [ ] **Step 3: 实现双 floor 投影**

`reader.ts`：
- `compactSummaryLine` uuid 改 `event.data.summaryUuid ?? event.data.uuid`。
- 把 `lastCompactEvent` / `findLastCompact` 的"单条最后 compact"判定改为返回 `{ legacyFloor: NeutralCompactEvent | null; retainMarkers: NeutralCompactEvent[] }`：倒序扫描，`legacyFloor` = 第一条（最后一条）`retainHistory !== true`；`retainMarkers` = 所有 `retainHistory === true` 且 seq > legacyFloor.seq（无 legacyFloor 则全部 retain）。`compactMemo` 缓存该结构（键 `(size, mtimeMs)` 不变）。
- 统一投影 helper（builder 命名，如 `projectCompactAware(lines, legacyFloor, retainMarkers)`）：
  1. legacyFloor 存在 → 丢 seq ≤ floor.seq 的行，按路径现状合成 legacy 投影（entries/page：`compactSummaryLine`；snapshot：`compactBoundaryLine` + `compactSummaryLine`）。
  2. 每个 retainMarker → 在其 seq 位置内联插入 `compactBoundaryLine` + `compactSummaryLine`（所有路径），前后行保留。
  3. 无 compact → 原样。
- `loadFlooredLines`（entries/page）与 `readNativeHistorySnapshot` 都走该 helper；snapshot 保留 `tornTail` / `afterUuid` / status 逻辑。
- 内联插入按 seq 定位：retain marker 的 boundary+summary 排在 seq == marker.seq 的原始行之后、seq > marker.seq 的行之前（compact 事件本身不渲染，原始 renderable 行无 marker.seq 行；插入点 = 第一个 seq > marker.seq 的行前）。

- [ ] **Step 4: 跑测试确认通过（含现有 legacy 测试不破）**

Run: `npx vitest run server/providers/native/session-log/reader.test.ts`
Expected: PASS——新 retain 测试 + 现有 legacy 地板测试（"pages and searches only after the last compact"、"floors at the last compact when several exist"）全绿。

- [ ] **Step 5: 提交**

```bash
git add server/providers/native/session-log/reader.ts server/providers/native/session-log/reader.test.ts
git commit -m "feat(native): reader retains history at retain-compacts, floors legacy only"
```

---

### Task 4: manager compact 降级为 append + 摘要身份 + D6 局部地板

**Files:**
- Modify: `server/session-manager.ts`（`runAutoCompact` 6129-6215、`pushCompactFrames` 6225-6267）
- Test: `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 2 `compactInPlace(summary, { uuid, timestamp, summaryUuid })`。
- Produces: `pushCompactFrames(s, summary, uuid, timestamp, preTokens, summaryUuid: string)`——摘要帧 uuid = `summaryUuid`（不再内部 `randomUUID()`），boundary 帧 uuid = `uuid`。`runAutoCompact` 铸造一次 `summaryUuid` 传给 provider 与 pushCompactFrames。

- [ ] **Step 1: 写失败测试**

在 `session-manager.test.ts` 加（沿用现有 native compact 测试的 mock handle / `maybeAutoCompact` 驱动方式，参考约 2848/3706/10825/11381）：

```ts
it('native auto-compact appends marker, retains ring, no session-cleared / generation bump', async () => {
  // 驱动一个超阈值 idle native session 走 maybeAutoCompact（mock summarize 返回 'SUMMARY'）
  const before = sm.get(id).history.length
  const genBefore = transcriptStore.generation
  await driveAutoCompact(id)
  const s = sm.get(id)
  expect(s.history.length).toBeGreaterThan(before)          // ring 保留 + 追加
  expect(s.history.some(m => m.type === 'system' && m.subtype === 'compact_boundary')).toBe(true)
  expect(s.history.some(m => (m as any).isCompactSummary)).toBe(true)
  expect(transcriptStore.generation).toBe(genBefore)         // 不 bump
  // 无 session-cleared 广播（断言 subscriber 未收到 cleared 帧）
})

it('live summary frame uuid == persisted summaryUuid (no duplicate on restart)', async () => {
  await driveAutoCompact(id)
  const liveSummary = sm.get(id).history.find(m => (m as any).isCompactSummary) as any
  const events = neutralEventsOf(handle.log)
  const compact = events.find(e => e.type === 'session/compact') as any
  expect(liveSummary.uuid).toBe(compact.data.summaryUuid)
})

it('second compact summarizes only post-last-boundary span (D6)', async () => {
  // 第一次 compact 后 ring 含 pre-compact + boundary + summary + post turn
  // 第二次 compact：断言 summarize 输入不含 pre-compact / 上一份 SUMMARY
})

it('handoff summary input unchanged by D6 floor (shared helper untouched)', async () => {
  // 已 retain-compact 的 session 跑 sm.compact(id, {handoff:true})
  // 断言 summarize 输入仍含压缩前内容（共享 mergedHistoryForCompaction 不地板）
})

it('no spurious re-compaction on stale usage after compact', async () => {
  await driveAutoCompact(id)
  // 模拟一个未刷新 usage 即结算的 turn（lastContextUsage 已清空）
  // 断言 maybeAutoCompact 不再触发（autoCompacting 未置位 / 无第二次 compact 事件）
})
```

（`driveAutoCompact` / `transcriptStore` / `handle` 按该文件现有 native compact 测试的访问方式对齐；断言意图如上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-manager.test.ts -t 'native auto-compact appends marker'`
Expected: FAIL — 当前 ring 被清、generation bump、发 session-cleared。

- [ ] **Step 3: 改 runAutoCompact + pushCompactFrames**

`runAutoCompact`（6129）：
- 摘要输入局部地板（D6，ES2022 手写倒序循环）：
```ts
const merged = this.mergedHistoryForCompaction(s)
let lastBoundary = -1
for (let i = merged.length - 1; i >= 0; i--) {
  const m = merged[i] as any
  if (m.type === 'system' && m.subtype === 'compact_boundary') { lastBoundary = i; break }
}
const span = lastBoundary >= 0 ? merged.slice(lastBoundary + 1) : merged
const summary = await this.summarizeMergedForCompact(s, span)
```
- 铸造 `const summaryUuid = randomUUID()`（与现有 `uuid` 一起）。
- **移除**：`journal.prepare` / `resetTranscriptGeneration` 及 try/catch degraded 分支；sidecar 重置循环；`t.store.reset()` / `t.generationHistory` compact 条目 / `s.history = []` / `s.subagentHistory = []` / `s.promptUuids = []` / `s.steeredInFlight.clear()` / `s.withdrawnUuids = []` / `s.pendingSnapshotAnchors = undefined` / `broadcastSessionCleared`。
- **保留**：`s.lastContextUsage = undefined`；identity/phase 复检；idle/autoCompacting 守卫。
- provider 调用改 `await compactInPlace.call(s.handle, summary, { uuid, timestamp, summaryUuid })`。
- 结尾改 `this.pushCompactFrames(s, summary, uuid, timestamp, preTokens, summaryUuid)`；info 日志改 "auto-compact: appended compact marker, history retained"。

`pushCompactFrames`（6225）签名加 `summaryUuid: string`；摘要帧 `uuid: summaryUuid`（删内部 `randomUUID()`）；boundary 帧 `uuid` 不变。

- [ ] **Step 4: 翻转现有 reset 断言 + 跑测试**

把 `session-manager.test.ts` 现有断言 compact 后 ring 清空 / generation bump / session-cleared 的测试翻转为 append 行为（保留 legacy reset-journal 恢复测试不动）。
Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
Expected: 两个 tsconfig 均 PASS。
```bash
git add server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(native): demote auto-compact to append, retain ring, unify summary identity"
```

---

### Task 5: e2e 集成 + 文档同步 + 全量门

**Files:**
- Modify: `server/providers/native/e2e-persistence.test.ts`（compact 断言翻转，约 385）
- Modify: `docs/superpowers/plans/2026-11-09-native-p1.1-context-efficiency.md`（不变量 3/4 翻转）
- Modify: `docs/superpowers/specs/2026-11-16-transcript-ordered-reconcile-design.md`（§8.3 compact 不再是 reset 生产者，仅 legacy 恢复消费）
- Modify: `CLAUDE.md`（native 段：compact 保留可见历史、模型地板不变、前向 fence）
- Test: `server/providers/native/e2e-persistence.test.ts`

**Interfaces:**
- Consumes: Task 1-4 全部。
- Produces: 端到端钉死 + 文档与代码一致。

- [ ] **Step 1: 翻转 e2e compact 断言 + 加集成钉死**

`e2e-persistence.test.ts` 现有"ring 含 boundary+MOCK SUMMARY 不含 pre-compact prompt / readHistoryPage/searchMessages 无 pre-compact"断言翻转为：ring 保留 pre-compact + boundary + summary；`readHistoryPage` / `searchMessages` 含 pre-compact。新增：
```ts
it('restart of a retain-compacted session shows exactly one summary card', async () => {
  // compact → 重启 session（resume）→ reconcile 快照 + 分页
  // 断言 isCompactSummary 恰好一条，uuid == summaryUuid；boundary 一条
})
it('crash before manager frame append: reload synthesizes single clean marker', async () => {
  // provider compactInPlace 后模拟 manager 未 push（直接读磁盘 reader）
  // 断言 reader 合成 boundary + summary 各一，身份与正常路径一致
})
```

- [ ] **Step 2: 跑 e2e 确认通过**

Run: `npx vitest run server/providers/native/e2e-persistence.test.ts server/providers/native/e2e-context-window.test.ts`
Expected: PASS。

- [ ] **Step 3: 同步文档**

- P1.1 plan 不变量 3/4 改为"compact 是 append marker，ring/seq 延续，渲染面保留压缩前历史；模型地板保留"。
- ordered-reconcile spec §8.3 注明：compact 不再产生 reset journal（仅 `/clear` 产生）；legacy compact-reset journal 恢复分支保留伺候存量。
- CLAUDE.md native 段补一句：native auto-compact 保留压缩前历史可见（claude 式分隔线+摘要卡），模型历史地板不变，前向 `retainHistory` fence 保存量行为。
- 更新本 design spec 状态为 implemented（若仓库惯例）。

- [ ] **Step 4: 全量门**

Run: `npm run typecheck && npm run test && npm run lint && npm run verify:agent-notes`
Expected: 全 PASS（既有无关 flake 按现状归因报告）。

- [ ] **Step 5: 提交**

```bash
git add server/providers/native/e2e-persistence.test.ts docs/superpowers/plans/2026-11-09-native-p1.1-context-efficiency.md docs/superpowers/specs/2026-11-16-transcript-ordered-reconcile-design.md CLAUDE.md docs/superpowers/specs/2026-11-26-native-compact-retain-history-design.md
git commit -m "test(native): e2e retain-history compact; sync specs + CLAUDE.md"
```

---

## Self-Review 记录

- **Spec 覆盖**：D1（客户端零改动，Task 4 帧形状）/ D2（前向 fence，Task 1+3）/ D3（模型地板不动，Task 2 测试 + Global）/ D4（append 降级，Task 4）/ D5（双 floor，Task 3）/ D6（局部地板，Task 4）/ D7（磁盘分隔线，Task 3）/ D8（summaryUuid，Task 1+2+3+4）均有 task。§5 边界（legacy/混合/fork/resume/崩溃/搜索）由 Task 3/5 测试覆盖；fork/resume 逐字复制标记列为 builder 核验（Task 5 e2e 间接覆盖）。
- **类型一致**：`summaryUuid` 在 Task 1（词汇）/ Task 2（provider opts 可选）/ Task 3（reader 读）/ Task 4（manager 铸造 + pushCompactFrames 必填参数）命名一致；`retainHistory` 同理。`compactInPlace` opts.summaryUuid 可选 → manager 总提供，typecheck 全程绿。
- **Review Focus**：5 项各落到 owning task 测试（1→Task3/5，2→Task4，3→Task4，4→Task3，5→Task3/5）。
- **比例**：计划以签名 + 测试断言为主，代码块仅用于解析器/地板算法等签名与测试不能确定的部分；未转录实现体。