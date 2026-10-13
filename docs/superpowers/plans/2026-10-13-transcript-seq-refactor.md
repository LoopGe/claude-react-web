# Transcript Seq 重构实施计划（P0–P3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以服务端权威的追加稳定 seq 取代 uuid 合并/IDB 缓存/replay 重放，修复 lazy-load 死锁，客户端瘦身为 seq 窗口视图。

**Architecture:** 服务端 pump 为每条可渲染消息分配会话内单调 seq 并追加进 `<stateDir>/transcripts/<sessionId>.ndjson` sidecar（驱逐=墓碑行）；`GET /messages` 按 seq 分页成为唯一读取入口；WS live 帧携带 seq，attach 回 `attached {generation, headSeq}`，不再重放历史。客户端 store 只持有一个 seq 连续窗口，渲染 `firstItemIndex = oldestSeq`，向上加载由 `rangeChanged` 驱动。

**Tech Stack:** TypeScript (Node 20 / React 19)、Hono、vitest、react-virtuoso 4.18.6。

**Spec:** `docs/superpowers/specs/2026-10-13-transcript-seq-refactor-design.md`（本计划逐节对应 spec §2–§9；执行前先读 spec）

## Global Constraints

- 两个 tsconfig 都必须过：`npm run typecheck`（root + node）。
- 每个任务结束 `npm run test` 全绿、`npm run lint` 干净。
- 服务端诊断日志一律 `createLogger(scope)`，禁止裸 `console.*`。
- 禁止 shell 拼 git/路径；文件操作走 `node:fs/promises`；sessionId 进路径前必须 `path.basename()`。
- 不新增运行时依赖。
- 每个任务完成即 commit（消息末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`）；P3 是破坏性变更，单独成 commit。
- 提交前对整个 diff 跑 `code-review` 技能（CLAUDE.md 约定）。
- 主题颜色规则与本计划无关（无 CSS 改动）。

---

## Phase 0 — 止血（独立可发布）

### Task 1: rangeChanged 触发 loadOlder（修复 startReached 死锁）

**Files:**
- Modify: `src/components/message-list/transcript-rows.ts`（新增纯函数）
- Modify: `src/components/MessageList.tsx:676-684`（startReached 区块）与 `:1337`（Virtuoso props）
- Test: `src/components/message-list/transcript-rows.test.ts`

**Interfaces:**
- Produces: `shouldLoadOlder(opts: { rangeStart: number; firstItemIndex: number; hasOlder: boolean; loadingOlder: boolean; itemCount: number }): boolean`（导出，P2 Task 10 复用同一函数）
- Consumes: 现有 `firstItemIndexValRef`（MessageList.tsx:872 已在 rangeChanged 作用域内维护）

背景：react-virtuoso 的 `startReached` 只在 `items[0].index === 0`（偏移空间）时触发，而 `firstItemIndex` 锚定在 1_000_000（`INITIAL_FIRST_ITEM_INDEX`），条件恒假——lazy-load 自 commit 7692251 起整体失效。本任务不动锚定机制，改用 `rangeChanged`（它已经在跑，`handleRangeChanged` 见 MessageList.tsx:866 附近）判断"可视区贴近窗口顶"来触发加载。

- [ ] **Step 1: 写失败测试**（追加到 `src/components/message-list/transcript-rows.test.ts`）

```ts
import { shouldLoadOlder } from './transcript-rows'

describe('shouldLoadOlder', () => {
  const base = { hasOlder: true, loadingOlder: false, itemCount: 500 }
  it('fires when visible range is within threshold of the window top', () => {
    // firstItemIndex=1_000_000（1e6 锚定），可视顶 1_000_003 → 距顶 3 行 ≤ 阈值 5
    expect(shouldLoadOlder({ ...base, rangeStart: 1_000_003, firstItemIndex: 1_000_000 })).toBe(true)
  })
  it('does not fire when far from the top', () => {
    expect(shouldLoadOlder({ ...base, rangeStart: 1_000_300, firstItemIndex: 1_000_000 })).toBe(false)
  })
  it('does not fire when already at true start (nothing older)', () => {
    // firstItemIndex === 0 且已到顶 → hasOlder 为 false 由调用方保证；这里验证函数不做多余触发
    expect(shouldLoadOlder({ ...base, hasOlder: false, rangeStart: 0, firstItemIndex: 0 })).toBe(false)
  })
  it('does not fire while a load is in flight', () => {
    expect(shouldLoadOlder({ ...base, loadingOlder: true, rangeStart: 1_000_001, firstItemIndex: 1_000_000 })).toBe(false)
  })
  it('does not fire on empty list', () => {
    expect(shouldLoadOlder({ ...base, itemCount: 0, rangeStart: 0, firstItemIndex: 0 })).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/message-list/transcript-rows.test.ts`
Expected: FAIL（`shouldLoadOlder` 未导出）

- [ ] **Step 3: 最小实现**（追加到 `transcript-rows.ts` 底部）

```ts
/** 向上加载触发判定：可视顶与窗口顶的距离 ≤ LOAD_OLDER_THRESHOLD 行。
 *  P0：firstItemIndex 仍是 1e6 锚定；P2 切 seq 后本函数不变（减法天然成立）。 */
export const LOAD_OLDER_THRESHOLD = 5
export function shouldLoadOlder(opts: {
  rangeStart: number
  firstItemIndex: number
  hasOlder: boolean
  loadingOlder: boolean
  itemCount: number
}): boolean {
  if (!opts.hasOlder || opts.loadingOlder || opts.itemCount === 0) return false
  return opts.rangeStart - opts.firstItemIndex <= LOAD_OLDER_THRESHOLD
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/message-list/transcript-rows.test.ts`
Expected: PASS

- [ ] **Step 5: 接入 MessageList**

在 `MessageList.tsx`：
1. import `shouldLoadOlder`（来自 `./message-list/transcript-rows`）。
2. 找到现有 `handleRangeChanged`（`rangeChanged` 回调，~866 行附近，已做偏移换算）。在其开头追加：

```ts
if (
  sessionId == null &&
  shouldLoadOlder({
    rangeStart: range.startIndex,
    firstItemIndex: firstItemIndexValRef.current,
    hasOlder,
    loadingOlder,
    itemCount: renderableItems.length,
  })
) {
  void loadOlder?.()
}
```

（`sessionId == null`：主 transcript 才有 loadOlder；SubagentOverlay 等子视图传了 sessionId，见 Props。若现有 `handleRangeChanged` 已有等价守卫则以现有守卫为准，不要重复。）
3. 删除 `startReached` 回调（~678-684 行）与 `<Virtuoso … startReached={startReached}>` 一行（~1338 行）。"到窗口顶"由 rangeChanged 同一条件覆盖。
4. 注意 effect 依赖数组：`handleRangeChanged` 若是 `useCallback`，把 `hasOlder, loadingOlder, loadOlder, renderableItems.length` 加入依赖（或沿用文件内已有的 ref 直读模式——如果现有代码用 ref 直读避免重渲染，跟随现有模式）。

- [ ] **Step 6: 全量验证**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: 全绿

- [ ] **Step 7: 人工验收**

`npm run dev`，打开会话 `89b7ae30-ba3b-4c0f-898a-b4e8c5831f10`（715 条），向上滚动：`GET /history` 请求应逐页发出，首条消息（14:01:46 `/ui-ux-pro-max` 命令）最终可见。

- [ ] **Step 8: Commit**

```bash
git add src/components/MessageList.tsx src/components/message-list/transcript-rows.ts src/components/message-list/transcript-rows.test.ts
git commit -m "fix(transcript): trigger loadOlder from rangeChanged — virtuoso startReached can never fire with the 1e6 firstItemIndex anchor"
```

---

## Phase 1 — 服务端 seq 权威（纯增量，新旧并存）

### Task 2: TranscriptStore 纯核心

**Files:**
- Create: `server/transcript-store.ts`
- Test: `server/transcript-store.test.ts`

**Interfaces:**
- Produces（Task 3/4/5 依赖的精确签名）:

```ts
export interface SeqMessage { seq: number; uuid: string | null; msg: unknown }
export interface TranscriptWindow {
  generation: number
  headSeq: number        // 已分配的最大 seq + 1（下一条的 seq）
  startIndex: number     // 本页第一条的 seq
  hasMore: boolean
  messages: SeqMessage[] // 不含墓碑，chronological
}
export class TranscriptStore {
  constructor(sessionId: string)
  generation: number
  get headSeq(): number
  /** pump 路径：为一条可渲染消息分配 seq 并登记。uuid 重复调用（SDK echo）返回原 seq。 */
  record(uuid: string | null): number
  /** seq → 已登记消息（供 /messages 持久化行与 WS 帧）；未登记返回 undefined */
  messageAt(seq: number): SeqMessage | undefined
  /** uuid → seq（供 retraction/withdraw 的 uuid→seq 映射）；未登记返回 undefined */
  seqOf(uuid: string): number | undefined
  /** 驱逐 → 墓碑。返回被墓碑化的 seq 列表（未登记的 uuid 忽略） */
  evict(uuids: string[]): number[]
  isEvicted(seq: number): boolean
  /** 分页窗口：before 省略 = 最新一页；墓碑过滤但不回收 seq */
  window(before: number | undefined, limit: number): TranscriptWindow
  /** 世代切换（/clear）：generation+1，seq 归零，清空索引 */
  reset(): void
  /** 对账：从持久化行恢复内存索引（Task 3 实现加载，本任务只定义签名并抛 'not implemented'） */
  hydrate(rows: Array<{ seq: number; uuid: string | null; evicted?: boolean; msg?: unknown }>): void
}
```

- 语义要点（写进实现注释）：seq 追加稳定永不复用；`window()` 的 `totalCount` 语义由调用方组合（本类只给 messages）；`before` = 独占上界（返回 seq < before 的最后 limit 条非墓碑消息）。

- [ ] **Step 1: 写失败测试**（核心行为，每条一个 it）

```ts
import { describe, expect, it } from 'vitest'
import { TranscriptStore } from './transcript-store'

describe('TranscriptStore', () => {
  it('assigns dense ascending seqs and dedups by uuid', () => {
    const s = new TranscriptStore('sid')
    expect(s.record('u1')).toBe(0)
    expect(s.record('u2')).toBe(1)
    expect(s.record('u1')).toBe(0) // SDK echo / 重复登记不产生新 seq
    expect(s.record(null)).toBe(2)
  })
  it('window() returns the newest page by default, oldest-first', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 10; i++) s.record(`u${i}`)
    const w = s.window(undefined, 4)
    expect(w.messages.map((m) => m.seq)).toEqual([6, 7, 8, 9])
    expect(w.hasMore).toBe(true)
  })
  it('window(before) pages strictly below the bound', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 10; i++) s.record(`u${i}`)
    const w = s.window(4, 3)
    expect(w.messages.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(w.hasMore).toBe(true)
  })
  it('hasMore is false at the beginning of the seq space', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 5; i++) s.record(`u${i}`)
    expect(s.window(2, 10).hasMore).toBe(false)
  })
  it('evict tombstones without recycling seqs; window skips them', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 5; i++) s.record(`u${i}`)
    expect(s.evict(['u1', 'u3', 'missing'])).toEqual([1, 3])
    expect(s.window(undefined, 10).messages.map((m) => m.seq)).toEqual([0, 2, 4])
    expect(s.record('u5')).toBe(5) // seq 不回 收
  })
  it('reset bumps generation and zeroes seqs', () => {
    const s = new TranscriptStore('sid')
    s.record('u1')
    s.reset()
    expect(s.generation).toBe(1)
    expect(s.record('u2')).toBe(0)
    expect(s.seqOf('u1')).toBeUndefined()
  })
  it('hydrate restores indexes and tombstones', () => {
    const s = new TranscriptStore('sid')
    s.hydrate([
      { seq: 0, uuid: 'a', msg: { type: 'user' } },
      { seq: 1, uuid: 'b', evicted: true },
      { seq: 2, uuid: 'c', msg: { type: 'assistant' } },
    ])
    expect(s.headSeq).toBe(3)
    expect(s.seqOf('b')).toBe(1)
    expect(s.isEvicted(1)).toBe(true)
    expect(s.window(undefined, 10).messages.map((m) => m.seq)).toEqual([0, 2])
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run server/transcript-store.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现** `server/transcript-store.ts`。内存结构：`messages: Map<number, SeqMessage & { evicted?: boolean }>`、`uuidToSeq: Map<string, number>`、`generation`、`nextSeq`。`record` 查 `uuidToSeq` 命中即返回；`window` 按 seq 降序收集非墓碑至 limit 再 reverse；`hydrate` 逐行写入同一结构（`nextSeq = max(seq)+1`）。全部同步、纯内存——持久化在 Task 3。
- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 → PASS
- [ ] **Step 5: Commit**

```bash
git add server/transcript-store.ts server/transcript-store.test.ts
git commit -m "feat(server): TranscriptStore pure core — append-stable seq, tombstoned eviction, generation reset"
```

### Task 3: sidecar 持久化 + SessionManager 接线

**Files:**
- Create: `server/transcript-sidecar.ts`（读写 ndjson，唯一 fs 触点）
- Modify: `server/session-manager.ts`（ring 追加处分配 seq；`/clear` 处 reset；提供 `getTranscriptWindow`）
- Test: `server/transcript-sidecar.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `TranscriptStore` 全部签名。
- Produces:
  - `TranscriptSidecar`：`constructor(dir: string, sessionId: string)`；`load(): Promise<Rows>`；`appendRow(row: object): Promise<void>`（内部串行队列，追加不阻塞 pump）；`remove(): Promise<void>`。路径 `<dir>/transcripts/<basename(sessionId)>.ndjson`。
  - `SessionManager` 新方法：`getTranscriptWindow(id: string, before?: number, limit?: number): Promise<TranscriptWindow & { totalCount: number }>`；`transcriptHead(id: string): { generation: number; headSeq: number } | null`；`evictTranscript(id: string, uuids: string[]): number[]`。

- [ ] **Step 1: 写 sidecar 失败测试**（临时目录，测 append→load 往返 + 串行追加顺序 + remove）

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscriptSidecar } from './transcript-sidecar'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })

describe('TranscriptSidecar', () => {
  it('appends rows and loads them back in order', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'crw-tsidecar-')); dirs.push(dir)
    const sc = new TranscriptSidecar(dir, 'sid-1')
    await sc.appendRow({ seq: 0, uuid: 'a', msg: { type: 'user' } })
    await sc.appendRow({ seq: 1, uuid: 'b', evicted: true })
    const rows = await new TranscriptSidecar(dir, 'sid-1').load()
    expect(rows.map((r) => r.seq)).toEqual([0, 1])
    expect(rows[1].evicted).toBe(true)
  })
  it('serializes concurrent appends without interleaving', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'crw-tsidecar-')); dirs.push(dir)
    const sc = new TranscriptSidecar(dir, 'sid-1')
    await Promise.all(Array.from({ length: 50 }, (_, i) => sc.appendRow({ seq: i, uuid: `u${i}` })))
    const rows = await new TranscriptSidecar(dir, 'sid-1').load()
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i))
  })
})
```

- [ ] **Step 2: 跑失败** — `npx vitest run server/transcript-sidecar.test.ts`
- [ ] **Step 3: 实现 sidecar**。`appendRow` 用 `fs.appendFile(fd 复用)` + 内存 Promise 链保证串行；`load` 整文件按行 `JSON.parse`（容忍 torn 尾行：parse 失败跳过该行，warn 日志）。`remove` 先关 fd 再 unlink，ENOENT 视为成功。
- [ ] **Step 4: 接入 SessionManager**：
  1. 字段：`private transcriptStores = new Map<string, { store: TranscriptStore; sidecar: TranscriptSidecar }>`；懒创建（`getOrCreateTranscript(id)`）。
  2. **seq 分配点**：找到 pump 消息进入 ring 的追加处（`session-manager.ts` 中 `s.history.push(...)` 的位置，6000 行附近的 `subscribe`/mergedHistory 同源）——在 push **之前**判定可渲染性（复用 `history-utils.ts` 的 `BROADCAST_SYSTEM_SUBTYPES` + `tool_use_summary` 判定，抽成共享谓词 `isRenderableSdkMessage(msg)` 放 `history-utils.ts` 并让 history-reader 复用），可渲染则 `const seq = t.store.record(uuid)`、`void t.sidecar.appendRow({ seq, uuid, msg: normalized })`（normalized = 现有 `normalize()` 输出；此处 `trim: true` 与 live 一致），并把 `seq` 存入 ring 条目旁的并行 Map `seqByRingIndex`（或直接以 `WeakMap<SDKMessage, number>`——选 WeakMap，避免 ring 裁剪后索引漂移）。
  3. `getTranscriptWindow`：优先读 sidecar store 的 `window()`；store 为空（冷会话）时回退 jsonl-cache 全量解析喂给 `hydrate()` 后再 window（**对账**：sidecar 行数 < jsonl 可渲染行数时增量补齐，spec §2）。`totalCount` = store 非墓碑总数。
  4. `/clear` 路径（`clear()`，transcript 文件删除处）：`store.reset()` + `sidecar.remove()`。
  5. 会话删除路径：Map delete + `sidecar.remove()`。
- [ ] **Step 5: 新增 SessionManager 级测试**（`server/transcript-sidecar.test.ts` 内追加或独立文件）：构造假 SDK 消息序列走 `sm` 内部追加入口（若不可直接调用则把 seq 分配逻辑抽成可测函数 `recordTranscriptMessage(t, msg)` 放 transcript-sidecar.ts），断言：seq 连续、重复 uuid 不重复分配、evict 后 window 不含墓碑。
- [ ] **Step 6: 全量验证 + Commit**

```bash
npm run typecheck && npm run test && npm run lint
git add server/transcript-sidecar.ts server/transcript-sidecar.test.ts server/session-manager.ts server/history-utils.ts
git commit -m "feat(server): seq-assigned transcript sidecar wired into the pump; SessionManager window accessors"
```

### Task 4: GET /messages 端点

**Files:**
- Modify: `server/routes/sessions.ts`（紧跟现有 `/sessions/:id/history` 路由之后）
- Modify: `shared/ws-protocol.ts` 或新建 `shared/transcript-page.ts`（响应类型，客户端 P2 也要用——**放 shared**）
- Test: `server/routes/transcript-page.test.ts`

**Interfaces:**
- Produces: `GET /sessions/:id/messages?before=<seq>&limit=200` → `TranscriptPageResponse`：

```ts
// shared/transcript-page.ts
export interface TranscriptPageMessage { seq: number; msg: unknown }
export interface TranscriptPageResponse {
  generation: number
  headSeq: number
  totalCount: number
  startIndex: number
  hasMore: boolean
  messages: TranscriptPageMessage[]
}
```

- 错误：未知会话 404；`before`/`limit` 非数字 400；`before > headSeq` 400。

- [ ] **Step 1: 写失败路由测试**（仿 `server/routes/` 现有 supertest 风格；若项目用 app 级内存构造则跟随）。用例：空会话返回 `{messages:[],hasMore:false}`；追加 10 条后 `?before=4&limit=3` 返回 seq [1,2,3]；`before=99` → 400；未知 id → 404；响应含 `generation`/`headSeq`。
- [ ] **Step 2: 跑失败**。
- [ ] **Step 3: 实现**（`sessions.ts`，在 `/history` 后）：

```ts
app.get('/sessions/:id/messages', async (c) => {
  const id = c.req.param('id')
  const beforeRaw = c.req.query('before')
  const limitRaw = c.req.query('limit')
  const before = beforeRaw != null && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : undefined
  const limit = limitRaw != null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 200
  if (beforeRaw != null && before == null) throw new HttpError(400, 'before must be a non-negative integer')
  const page = await sm.getTranscriptWindow(id, before, limit)
  return c.json(page)
})
```

（`HttpError` 由 `buildApiRouter` 的 onError 统一转 JSON——现有机制。）
- [ ] **Step 4: 跑通过** + `npm run typecheck && npm run test`
- [ ] **Step 5: Commit**

```bash
git add server/routes/sessions.ts shared/transcript-page.ts server/routes/transcript-page.test.ts
git commit -m "feat(server): seq-paginated GET /sessions/:id/messages — the single transcript read entry"
```

### Task 5: WS 变更 — attached / messages-evicted / message 帧带 seq

**Files:**
- Modify: `shared/ws-protocol.ts`（`WsMessage` 加 `seq`/`generation`；新增 `WsAttached`、`WsMessagesEvicted`；加入 `WsServerFrame` union）
- Modify: `src/ws-types.ts`（镜像 alias 同步——文件头注释声明它是 thin instantiation）
- Modify: `server/frame-bridge.ts:101-106`（`messageFrameJson` 帧体带 seq）
- Modify: `server/ws.ts`（subscribe 处理：回 `attached`；dialog-resolved 的 `retractedMessageUuids` 处映射为 seq 广播 evicted）
- Modify: `server/session-manager.ts`（pump 的 `model_refusal_fallback` retract 分支：`evictTranscript` + 广播）
- Test: `server/frame-bridge.test.ts`（若已有则追加）、`server/ws-attached.test.ts`

**Interfaces:**
- Produces:

```ts
// shared/ws-protocol.ts 追加
export interface WsAttached { kind: 'attached'; sessionId: string; generation: number; headSeq: number }
export interface WsMessagesEvicted { kind: 'messages-evicted'; sessionId: string; seqs: number[]; generation: number }
// WsMessage<Msg> 追加可选字段（P2 前旧客户端容忍缺失）：
//   seq?: number; generation?: number
```

- [ ] **Step 1: 类型先行**——改 `shared/ws-protocol.ts` + `src/ws-types.ts`，`npm run typecheck` 保证 union 完整（若 switch 穷举报错，逐个补 default 分支，**不删旧行为**）。
- [ ] **Step 2: attached 帧**——`server/ws.ts` 的 subscribe 成功路径（现有 `subscribe-result` 回帧处）之后追加：

```ts
const head = sm.transcriptHead(sessionId)
if (head) sink.send({ kind: 'attached', sessionId, generation: head.generation, headSeq: head.headSeq })
```

（帧进 `WsServerFrame` union；客户端 P2 才消费，服务端先发无副作用。）
- [ ] **Step 3: message 帧带 seq**——`frame-bridge.ts` 的 `messageFrameJson(sessionId, message)` 改为接收 `{ seq, generation } | null` 第三参并入帧体；调用方（pump fan-out 路径）从 Task 3 的 WeakMap 取 seq。缓存命中语义注意：**seq 在帧 JSON 里，同一消息的缓存行天然携带 seq，无需额外键**。无 seq（不可渲染帧）保持 `seq` 缺省——旧客户端不受影响。
- [ ] **Step 4: messages-evicted**——两处调用 `sm.evictTranscript(id, uuids)` 后广播 `{ kind:'messages-evicted', sessionId, seqs, generation }`：① `model_refusal_fallback` 的 `retracted_message_uuids` 处理点（session-pump/session-manager）；② `dialog-resolved` 的 `retractedMessageUuids` 处理点（server/ws.ts）。uuid→seq 映射不到的忽略。
- [ ] **Step 5: 测试**——frame-bridge 帧体含 seq；attached 在 subscribe 后到达；evicted 帧的 seqs 与墓碑一致（直接构造 TranscriptStore + 假 sink 断言）。
- [ ] **Step 6: 全量验证 + Commit**

```bash
npm run typecheck && npm run test && npm run lint
git add shared/ws-protocol.ts src/ws-types.ts server/frame-bridge.ts server/ws.ts server/session-manager.ts server/frame-bridge.test.ts server/ws-attached.test.ts
git commit -m "feat(ws): seq on message frames, attached handshake, messages-evicted frame"
```

### Task 6: 双读对账验证（迁移护栏）

**Files:**
- Test: `server/transcript-dual-read.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `getTranscriptWindow`；现有 `history-reader.ts` 的 `paginateJsonl`。

- [ ] **Step 1: 写对账测试**——取一个真实 transcript 的前 200 行文本做 fixture（从本机会话 JSONL 复制前 N 行内联进测试，或 `readFile` 真实路径 + skipIf 不存在）。断言两条路径输出逐条相等：

```ts
// 期望形态：同一份原始 JSONL，
//   A. 现有路径：paginateJsonl(raw, sid, { limit: 200 }).messages
//   B. 新路径：TranscriptStore 逐条 record 后 window(undefined, 200).messages.map(m => m.msg)
// 对比键序列：type、subtype、uuid、parent_tool_use_id、message.content 逐条 deep-equal。
```

注意：B 路径的 `msg` 就是 normalize 输出，A 路径同样是 normalize 输出，因此理想情况 deep-equal 直接成立；若有字段差异（如 B 侧多 `seq`），对比前剥除 `seq`。
- [ ] **Step 2: 跑测试**——FAIL 则修正 Task 3 的 normalize/登记路径（**改实现，不改断言**；断言代表"两条路径等价"这一迁移验收门）。
- [ ] **Step 3: Commit**

```bash
git add server/transcript-dual-read.test.ts
git commit -m "test(server): dual-read parity gate — seq window output equals legacy history pages"
```

---

## Phase 2 — 客户端 seq 窗口（依赖 Phase 1）

### Task 7: 客户端 store 重写为 seq 窗口

**Files:**
- Modify: `src/session-store/store.ts`、`src/session-store/reducer.ts`（重写窗口核心；UI reducer 分支保留）
- Create: `src/session-store/seq-window.ts`（窗口数据结构与操作，纯函数，可单测）
- Delete: `src/session-store/idb.ts`、`src/session-store/project.ts` 及 store 中 IDB/localStorage 全部接线（`loadOlderFromIdb`、`saveIdb`、`hydrate`/cold-load、`persistedUuids`/`uuidToSeq`/`maxSeq`/`minSeq`、`resetIdbTracking`、`clearPersisted` 的 IDB 部分、`idbReady`）
- Test: `src/session-store/seq-window.test.ts`、`src/session-store/reducer.test.ts`（追加用例；删除 IDB 相关旧用例）

**Interfaces:**
- Produces（Task 8/9/10 依赖）:

```ts
// src/session-store/seq-window.ts
export interface WindowState {
  generation: number
  headSeq: number
  window: Map<number, SdkMessage>       // seq → message（含 live）
  oldestSeq: number | null              // null = 空窗口
  newestSeq: number | null
  hasOlder: boolean
  hasNewer: boolean
  pending: Map<number, SdkMessage>      // 乱序缓冲（见下）
}
export function emptyWindow(generation: number, headSeq: number): WindowState
export function pageLoaded(w: WindowState, opts: { at: 'tail' | 'head'; messages: Array<{ seq: number; msg: unknown }>; hasMore: boolean; generation: number }): WindowState
export function liveAppend(w: WindowState, seq: number, message: SdkMessage, generation: number): WindowState
export function evictSeqs(w: WindowState, seqs: number[]): WindowState
export function bumpGeneration(w: WindowState, generation: number, headSeq: number): WindowState
```

语义（写进 seq-window.ts 头注释）：
- `liveAppend`：`seq === newestSeq + 1` → 尾追加；`seq > newestSeq + 1` → 进 `pending`，**并返回需要补洞的区间标记**（`{ hole: [newestSeq + 1, seq - 1] }`，Task 9 据此拉 REST）；`seq <= newestSeq` → 幂等丢弃。
- `pending` 非空且补洞页到达后，把连续段并入 window（`pageLoaded` 内处理）。
- `evictSeqs`：从 window 与 pending 删除；`oldestSeq/newestSeq` 重算。
- `bumpGeneration`：整窗作废（/clear / 世代不匹配）。

- [ ] **Step 1: seq-window 失败测试**——每条语义一个 it：尾追加、空洞进 pending、补洞合并、幂等旧帧、驱逐重算边界、世代重置。**先写 `pageLoaded` 空洞合并与 `liveAppend` 空洞缓冲这两条最容易被写错的。**
- [ ] **Step 2: 跑失败 → 实现 → 跑通过**（标准 TDD 循环，同前几任务的命令）。
- [ ] **Step 3: reducer 接线**——新增 action：

```ts
| { type: 'WINDOW_PAGE'; at: 'tail' | 'head'; generation: number; headSeq: number; messages: Array<{ seq: number; msg: unknown }>; hasMore: boolean }
| { type: 'WINDOW_LIVE'; seq: number; generation: number; message: SdkMessage }
| { type: 'WINDOW_EVICT'; seqs: number[] }
| { type: 'WINDOW_BUMP'; generation: number; headSeq: number }
```

`mirror.messages` 的有序数组由 `window` 按 seq 排序派生（`useMemo` 层），`applyMessage` 等 UI 路径改为从 `WINDOW_LIVE` 进入。**保留**：REPLAY_REPLACE/PREPEND_MESSAGES 等 action 在本任务内先做成对 window 的薄适配（内部转调 pageLoaded/liveAppend），让未迁移的调用方继续编译——P3 再删。
- [ ] **Step 4: 删除 IDB/localStorage 层**——按 Delete 清单移除；`store.idb.test.ts` 删除；所有 `idbReady` 消费点（useChatStream:270、Chat 等）改读常量 `true`（保持行为：打开即就绪），P3 清理。
- [ ] **Step 5: reducer/store 测试全绿** + `npm run typecheck && npm run test && npm run lint`
- [ ] **Step 6: Commit**

```bash
git add -A src/session-store src/hooks/useChatStream.ts src/components
git commit -m "feat(client): seq-windowed transcript store — single source, no client persistence"
```

### Task 8: useChatStream — 打开=尾页+订阅，补洞走 REST

**Files:**
- Modify: `src/hooks/useChatStream.ts`
- Modify: `src/hooks/useWsHub.ts`（暴露 `attached` 帧；`isReplayBurstOpen` 及 burst 相关状态删除）
- Delete: `src/session-store/replay-bursts.ts`（客户端侧消费者全部移除后；若服务端测试仍用则 P3 再删文件）
- Test: `src/hooks/useChatStream.seq.test.ts`（假 hub）

**Interfaces:**
- Consumes: Task 7 的 reducer actions；`shared/transcript-page.ts` 的 `TranscriptPageResponse`；WS `attached`/`messages-evicted` 帧。
- Produces: 与现有 hook 返回形状一致（`items/messages/loadOlder/hasOlder/...`），**新增 `oldestSeq: number | null`**（Task 9 的 `MessageList` 锚定依赖它，Chat.tsx 透传给 MessageList）。

- [ ] **Step 1: 打开路径**——替换现有 subscribe effect（~322-796 行）：

```ts
useEffect(() => {
  if (!sessionId || !hydrateReady) return
  let cancelled = false
  ;(async () => {
    const page = await api.get<TranscriptPageResponse>(`/sessions/${sessionId}/messages?limit=200`)
    if (cancelled) return
    store.dispatch({ type: 'WINDOW_PAGE', at: 'tail', ...page, messages: page.messages })
    releaseRef.current = hub.subscribe(sessionId, undefined, { force: true })
  })().catch(() => store.dispatch({ type: 'ERROR', message: '加载历史失败，请重试' }))
  return () => { cancelled = true; releaseRef.current?.() }
}, [sessionId, hydrateReady, hub, store])
```

（`sinceUuid`/`hasCachedTranscript`/`replayMode` 参数全部删除；`subscribe` 的第二参在 hub 内变为无参透传。）
- [ ] **Step 2: attached/补洞**——会话监听器处理新帧：

```ts
case 'attached': {
  const snap = store.getSnapshot()
  if (frame.generation !== snap.generation) {
    store.dispatch({ type: 'WINDOW_BUMP', generation: frame.generation, headSeq: frame.headSeq })
    void refetchTail()   // 打开路径同一函数，抽出来复用
  } else if (snap.newestSeq != null && snap.newestSeq < frame.headSeq - 1) {
    void fillGap(snap.newestSeq + 1, frame.headSeq - 1)   // WINDOW_PAGE at:'tail' 分页直至追平
  }
  break
}
case 'message': {
  if (frame.seq != null && frame.generation != null) {
    const res = store.dispatch({ type: 'WINDOW_LIVE', seq: frame.seq, generation: frame.generation, message: frame.message })
    if (res?.hole) void fillGap(res.hole[0], res.hole[1])
  } else {
    store.dispatch({ type: 'APPEND_MESSAGE', message: frame.message }) // 无 seq 帧：旧服务端兼容
  }
  break
}
case 'messages-evicted':
  store.dispatch({ type: 'WINDOW_EVICT', seqs: frame.seqs })
  break
```

（空洞检测的选定方案：**hook 内比较**——dispatch 前读 `store.getSnapshot().newestSeq`，dispatch 后再读，若仍 `!== seq - 1` 则补洞区间为 `[prevNewestSeq + 1, seq - 1]`。不采用 reducer 返回值，避免改 store.dispatch 的全局签名。）
- [ ] **Step 3: loadOlder 重写**——删除 `clearedRef`、`cursorRef`、`isReplayBurstOpen` gate、`fetchServerPage` 的 beforeUuid 分支：

```ts
const loadOlder = useCallback(async (): Promise<number> => {
  if (inFlightRef.current) return 0
  const snap = store.getSnapshot()
  if (!snap.hasOlder || snap.oldestSeq == null) return 0
  inFlightRef.current = true; setLoadingOlder(true)
  try {
    const page = await api.get<TranscriptPageResponse>(`/sessions/${sessionId}/messages?before=${snap.oldestSeq}&limit=200`)
    store.dispatch({ type: 'WINDOW_PAGE', at: 'head', ...page, messages: page.messages })
    setHasOlder(page.hasMore)
    return page.messages.length
  } catch { return 0 } finally { inFlightRef.current = false; setLoadingOlder(false) }
}, [store, sessionId])
```

`hasOlder` 初始 true；`WINDOW_PAGE at:'head'` 后由 `page.hasMore` 驱动。`clearedRef` 的 /clear 防回滚职责由 generation 接管（WINDOW_BUMP 后旧页拉不到）。
- [ ] **Step 4: 假 hub 测试**——场景：①打开→WINDOW_PAGE tail→attached 追平缺口；②live seq 跳号→fillGap 发出正确 before 参数；③attached generation 不同→WINDOW_BUMP+重拉；④messages-evicted 收敛。用内存 fetch stub + 假 hub（仿现有 hook 测试环境，jsdom docblock）。
- [ ] **Step 5: 全量验证 + Commit**

```bash
npm run typecheck && npm run test && npm run lint
git add src/hooks/useChatStream.ts src/hooks/useWsHub.ts src/session-store
git commit -m "feat(client): open = tail page + subscribe; gap-fill via REST; seq-based loadOlder"
```

### Task 9: MessageList — firstItemIndex = oldestSeq

**Files:**
- Modify: `src/components/MessageList.tsx`（锚定来源、行携带 seq）
- Modify: `src/components/message-list/transcript-rows.ts`（`initialRowAnchor`/`advanceRowAnchor` 接受外部锚值）
- Test: `src/components/message-list/transcript-rows.test.ts`（追加）

**Interfaces:**
- Consumes: Task 7 的 `oldestSeq`（经 props `oldestSeq: number | null` 传入）。

- [ ] **Step 1: 测试先行**——`advanceRowAnchor` 新签名 `advanceRowAnchor(prev, rows, externalAnchor?: number | null)`：`externalAnchor != null` 时初始/重建锚取 `externalAnchor`（= 窗口最旧 seq），prepend 移位逻辑不变；`externalAnchor === null`（空窗）回落 `INITIAL_FIRST_ITEM_INDEX`。测试用例：externalAnchor=300 初始锚 300；prepend 200 行 → 锚 100；null → 1e6。
- [ ] **Step 2: 实现**——`MessageList.tsx`：`rowAnchorRef = useRef<RowAnchor>(initialRowAnchor())` 处改为接受 `oldestSeq` prop；`firstItemIndex = nextRowAnchor.index` 不变（值现在=服务端 seq）。行数据 `virtuosoData` 携带 `seq`（renderableItems 元素已含 seq——Task 7 派生时带上）。
- [ ] **Step 3: 验证语义**——`shouldLoadOlder` 不需要改：`rangeStart - firstItemIndex` 现在就是"距窗口顶的真实条数"。追加一条回归测试锁住："firstItemIndex=oldestSeq 时 startReached 语义等价"（即 rangeStart === firstItemIndex 触发）。
- [ ] **Step 4: 全量验证 + Commit**

```bash
npm run typecheck && npm run test && npm run lint
git add src/components/MessageList.tsx src/components/message-list
git commit -m "feat(client): render index space = server seq space — firstItemIndex anchored on oldestSeq"
```

### Task 10: /history 转 shim + 手工验收

**Files:**
- Modify: `server/routes/sessions.ts`（`/history` 内部改调 `getTranscriptWindow`；`beforeUuid` 用 `seqOf(uuid)` 翻译，翻译不到 → 400）

- [ ] **Step 1: shim 实现**（保持响应形状 `{ messages, totalCount, startIndex, hasMore }`：messages 从 `TranscriptPageMessage` 展平回 `{ ...msg, seq }` 顶层——旧客户端的 uuid 去重逻辑依赖顶层 uuid，normalize 输出里已有）。
- [ ] **Step 2: 手工验收**——`npm run build && npm run preview`，真实会话全流程：打开（尾页）→ 向上滚到底（seq 0 可见）→ 发消息 → 断网 5s 重连（补洞）→ /clear（世代重置）→ 滚动加载新世代。对照 spec §6。
- [ ] **Step 3: Commit**

```bash
git add server/routes/sessions.ts
git commit -m "refactor(server): /history becomes a shim over the seq window endpoint"
```

---

## Phase 3 — 退役（破坏性，前后端同版）

### Task 11: 删除 replay/burst/兼容层

**Files:**
- Delete: `server/replay-plan.ts`、`server/replay-plan.test.ts`、`server/replay-bursts.ts`、`server/replay-bursts.test.ts`、`src/session-store/replay-bursts.ts`、`src/session-store/idb.ts`、`src/session-store/project.ts`、`src/session-store/store.idb.test.ts`、`src/session-store/seq-window.ts` 中 P2 的临时适配
- Modify: `shared/ws-protocol.ts`（删 `WsReplay`/`WsReplayDone`/`sinceUuid`/`replayMode`/`hasCachedTranscript`；`seq`/`generation` 转必填）
- Modify: `server/ws.ts`、`server/frame-bridge.ts`、`src/hooks/useWsHub.ts`、`src/hooks/useChatStream.ts`（replay 分支、burst 状态机、`idbReady` 常量残留、`restoredFromDisk`/`consumedAt`/`isReplay` 字段消费）
- Modify: `server/routes/sessions.ts`（删 `/history`）

- [ ] **Step 1: 逐文件删除 + 修剪消费点**；每删一组跑 `npm run typecheck`（union 穷举会准确报出残留分支）。
- [ ] **Step 2: spec §9 清单核对**——逐项打勾：`idb.ts`、`loadOlderFromIdb`/seq 水位/contiguity、`project.ts`、replay 组装器与 burst 缓冲、`replay-plan.ts`、`replay-bursts.ts`、`sinceUuid`/`hasCachedTranscript`/`replayMode`、`restoredFromDisk`/`consumedAt`/`isReplay`、`clearedRef` gate、uuid→seq 换算。
- [ ] **Step 3: 全量验证**——`npm run typecheck && npm run test && npm run lint && npm run build`，再跑 Task 10 的手工验收清单。
- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor!: retire WS replay/sinceUuid, IDB transcript cache, and uuid merge heuristics — seq window is the only transcript path"
```

- [ ] **Step 5: 收尾 code-review**——对 P0→P3 全部 commit 范围跑 `code-review` 技能，确认发现逐条核实/修复后重跑（CLAUDE.md 约定）。
