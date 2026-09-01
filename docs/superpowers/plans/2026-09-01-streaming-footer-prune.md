# StreamingFooter 定稿裁剪(回合内不再累积)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主线程 assistant 消息定稿落进上方 transcript 时,把 StreamingFooter 累加器里对应的主线程文本段精确删除,使 footer 只显示在途文本,消除回合内的无界累积。

**Architecture:** 把 `LiveTurnState` 的扁平文本累加器(`textChunks: string[]` / `flushedText: string`)改成带 `sidechain` 来源标记的分段数组;在 `applyMessage` 处理主线程定稿 assistant 帧时删除全部主线程段(依赖「主线程 API 响应严格串行」不变量,无需文本比对);store 的 snapshot 层把段数组 join 回 `streamingContent` 字符串。纯客户端改动,服务端与 WS 协议零变化。

**Tech Stack:** TypeScript / React 19 store(reducer + snapshot)/ vitest。

**Spec:** `docs/streaming-footer-research.md`(调研文档,§4.2 方案 A + §4.3 风险清单 + §5 结论)。本计划从该 spec 出发;执行者应同时阅读两者。

## Global Constraints

- **纯客户端**:不改 `server/`、不改 `shared/ws-protocol.ts`、不加 REST 路由。
- **sidechain 段永不删除**:子代理文本(`parent_tool_use_id != null` 的流)不进主 transcript(`MessageList.tsx:766-780` 按 parent 过滤),footer 是它唯一的进行中可视化面。任何清理路径都不得移除 `sidechain: true` 的段。
- **liveTurn 本体不置 null**(定稿时):`activePhase` / `tokenRate` 同源于 `liveTurn.phase` / `liveTurn.tokenRate`(`store.ts:1045-1046`),WorkingBubble 与 tok/s 读数靠它;只清文本段。
- **`totalChars` 不裁剪**:它喂 tok/s 的滑窗估算(`reducer.ts:2088-2105`),是计数器不是显示文本。
- **良性重连语义不回归**:`REPLAY_REPLACE` 无 result 的 newer 分片必须保留 liveTurn 文本(现有测试 `reducer.test.ts:2437-2447`)。重叠丢弃路径(split 判定 older=newer=[])不经过 `applyMessage`,不触发裁剪 —— 保持现状,不算回归。
- **退出淡出手感不改**:`MessageList.tsx:643-678` 的 180ms exit-fade 机制原样保留;定稿后 `streamingContent` 变 `''` 走既有 ""-当-null 路径(今天 tool-use-only 回合已在回合中途触发过该路径,是被演练过的机器)。
- **CSS 零改动**(自然无新增颜色值)。
- **持久化零改动**:`liveTurn` 本就不落盘(`store.ts:148-197`),不新增持久化字段。
- 每个任务的 commit 前必须过一遍代码评审(CLAUDE.md 约定:未评审的代码不得提交;diff 用 `git diff HEAD` 全量看)。
- 目标测试命令:单文件 `npx vitest run src/session-store/reducer.test.ts`;全量 `npm run test`;双 tsconfig 类型检查 `npm run typecheck`。

---

### Task 1: 分段累加器改型 + snapshot join

把累加器换成 origin 标记分段结构,并让 store 的 snapshot 继续产出字符串。本任务完成后所有现有测试通过、typecheck 通过,行为与今天一致(只是结构变了)。

**Files:**
- Modify: `src/session-store/types.ts:246-258`(新增 `LiveTurnSegment`,retype 两个字段)
- Modify: `src/session-store/reducer.ts:222-234`(LIVE_TURN_FLUSH)、`:2016-2032`(惰性初始化)、`:2108-2114`(delta push)
- Modify: `src/session-store/store.ts:1044`(snapshot 投影 + join memo)
- Test: `src/session-store/reducer.test.ts`(新增 helper + describe;更新 `:2446`、`:2470` 两处既有断言)
- Test: `src/session-store/store.test.ts`(新增 join 投影测试)

**Interfaces:**
- Consumes: 现有 `LiveTurnState`(`types.ts:253-288`)、`streamEventMsg` / `asstMsg` / `seedWithLiveTurn`(`reducer.test.ts:2287` / `:2261` / `:2326` 等文件级 helper)。
- Produces: `export interface LiveTurnSegment { text: string; sidechain: boolean }`(`types.ts`);`LiveTurnState.textChunks: LiveTurnSegment[]`、`LiveTurnState.flushedText: LiveTurnSegment[]`。Task 2 的裁剪逻辑、`store.ts` 的 join 都消费这两个类型。

- [ ] **Step 1: 写失败测试(reducer 层:来源标记 + flush 合并语义)**

在 `src/session-store/reducer.test.ts` 顶层 helper 区(`streamEventMsg` 附近,约 `:2287` 后)新增:

```ts
function sidechainStreamEventMsg(uuid: string, text = 'delta'): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    parent_tool_use_id: 'toolu_sub_1',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SdkMessage
}
```

在文件末尾(replay liveTurn describe 之后)新增 describe:

```ts
describe('live turn segmented accumulator', () => {
  it('tags text deltas with their sidechain origin and flush coalesces adjacent same-origin segments', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: streamEventMsg('se-1', 'hello ') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: sidechainStreamEventMsg('se-2', 'child ') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: streamEventMsg('se-3', 'world') })
    state = reduceSessionState(state, { type: 'LIVE_TURN_FLUSH' })
    // 段保序:显示顺序与 delta 到达顺序一致
    expect(state.mirror.liveTurn?.flushedText).toEqual([
      { text: 'hello ', sidechain: false },
      { text: 'child ', sidechain: true },
      { text: 'world', sidechain: false },
    ])
    // 相邻同源段合并:段数跟随主/子代理交替次数,不随 flush 次数或 delta 数增长
    state = reduceSessionState(state, { type: 'MESSAGE', message: streamEventMsg('se-4', ' more') })
    state = reduceSessionState(state, { type: 'LIVE_TURN_FLUSH' })
    expect(state.mirror.liveTurn?.flushedText).toEqual([
      { text: 'hello ', sidechain: false },
      { text: 'child ', sidechain: true },
      { text: 'world more', sidechain: false },
    ])
  })

  it('unflushed chunks keep their origin tag until the flush moves them', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: sidechainStreamEventMsg('se-1', 'child') })
    expect(state.mirror.liveTurn?.textChunks).toEqual([{ text: 'child', sidechain: true }])
    expect(state.mirror.liveTurn?.flushedText).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/session-store/reducer.test.ts`
Expected: 新增 2 条 FAIL(`flushedText` 当前是 string,`toEqual` 数组断言不匹配;sidechain delta 当前无标记)。

- [ ] **Step 3: types.ts 改型**

在 `LiveTurnState` 之前(`src/session-store/types.ts:252` 附近)新增:

```ts
/** One coalesced run of streamed text in the live turn, tagged by origin.
 *  `sidechain: true` marks subagent stream text (parent_tool_use_id set) —
 *  it never lands in the main transcript (MessageList filters on
 *  parent_tool_use_id), so finalize-time pruning must never remove it. */
export interface LiveTurnSegment {
  text: string
  sidechain: boolean
}
```

`LiveTurnState` 内(`types.ts:256-257`)替换:

```ts
  /** Unflushed stream-event text deltas, in arrival order, origin-tagged
   *  (see LiveTurnSegment). Drained into `flushedText` by LIVE_TURN_FLUSH. */
  textChunks: LiveTurnSegment[]
  /** Flushed streamed text, coalesced into origin-tagged segments and joined
   *  by the store into `streamingContent` (the StreamingFooter). Main-thread
   *  segments are pruned when their finalized assistant message lands — see
   *  pruneFinalizedLiveTurnText — so this stays bounded to in-flight text. */
  flushedText: LiveTurnSegment[]
```

- [ ] **Step 4: reducer.ts 三处写点**

(a) `LIVE_TURN_FLUSH`(`reducer.ts:222-234`)整段替换为:

```ts
    case 'LIVE_TURN_FLUSH': {
      const liveTurn = state.mirror.liveTurn
      if (!liveTurn || !liveTurn.dirty) return state
      // Prune may have emptied the tail (finalized assistant landed inside the
      // 80ms flush window): clear the dirty flag without rebuilding flushed.
      if (liveTurn.textChunks.length === 0) {
        return withMirror(state, {
          ...state.mirror,
          liveTurn: { ...liveTurn, dirty: false },
        })
      }
      // Merge unflushed chunks into the tail of the flushed segment list,
      // coalescing adjacent same-origin segments so the segment count tracks
      // main↔sidechain alternations, not flush ticks or delta counts.
      const flushed = liveTurn.flushedText.slice()
      for (const chunk of liveTurn.textChunks) {
        const tail = flushed[flushed.length - 1]
        if (tail && tail.sidechain === chunk.sidechain) {
          flushed[flushed.length - 1] = { text: tail.text + chunk.text, sidechain: tail.sidechain }
        } else {
          flushed.push(chunk)
        }
      }
      return withMirror(state, {
        ...state.mirror,
        liveTurn: { ...liveTurn, flushedText: flushed, textChunks: [], dirty: false },
      })
    }
```

(b) 惰性初始化(`reducer.ts:2021`)把 `flushedText: '',` 改为:

```ts
      flushedText: [],
```

(`textChunks: []` 不变,类型随 Step 3 自动收窄。)

(c) delta push(`reducer.ts:2111`)把

```ts
        textChunks: [...liveTurn.textChunks, text],
```

改为

```ts
        textChunks: [...liveTurn.textChunks, { text, sidechain: message.parent_tool_use_id != null }],
```

- [ ] **Step 5: store.ts join 投影**

`src/session-store/store.ts` 顶部从 `./types` 的既有 type import 中补上 `LiveTurnSegment`。在 `buildSnapshot` 附近(模块级,类外)新增:

```ts
/** Joined `flushedText` memo. buildSnapshot runs on every dispatch, but the
 *  segment array's identity only changes on LIVE_TURN_FLUSH / pruning, so a
 *  WeakMap keyed by the array keeps the common case O(1) while the join
 *  itself stays bounded by in-flight (un-pruned) text. */
const streamedTextMemo = new WeakMap<LiveTurnSegment[], string>()
function joinLiveTurnSegments(segments: LiveTurnSegment[]): string {
  const memoed = streamedTextMemo.get(segments)
  if (memoed !== undefined) return memoed
  const joined = segments.map((s) => s.text).join('')
  streamedTextMemo.set(segments, joined)
  return joined
}
```

`buildSnapshot`(`store.ts:1044`)把

```ts
      streamingContent: mirror.liveTurn?.flushedText ?? null,
```

改为

```ts
      streamingContent: mirror.liveTurn ? joinLiveTurnSegments(mirror.liveTurn.flushedText) : null,
```

- [ ] **Step 6: 更新两处既有断言(reducer.test.ts:2446、:2470)**

两处均为:

```ts
    expect(after.mirror.liveTurn?.flushedText).toBe('partial')
```

改为:

```ts
    expect(after.mirror.liveTurn?.flushedText).toEqual([{ text: 'partial', sidechain: false }])
```

- [ ] **Step 7: store 层 join 测试**

`src/session-store/store.test.ts` 末尾新增(顶层 describe,复用文件内既有的 `new SessionStore(id)` 惯例):

```ts
describe('SessionStore streamingContent projection', () => {
  it('joins the segmented live-turn text into one string', async () => {
    const store = new SessionStore('session-stream-join-test')
    await store.hydrateDone
    const delta = (uuid: string, text: string): SdkMessage =>
      ({
        type: 'stream_event',
        uuid,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      }) as unknown as SdkMessage
    store.dispatch({ type: 'MESSAGE', message: delta('se-1', 'hello ') })
    store.dispatch({ type: 'MESSAGE', message: delta('se-2', 'world') })
    store.dispatch({ type: 'LIVE_TURN_FLUSH' })
    expect(store.getSnapshot().streamingContent).toBe('hello world')
    // 未 flush 的尾部不计入(与今天的 flush 语义一致)
    store.dispatch({ type: 'MESSAGE', message: delta('se-3', ' tail') })
    expect(store.getSnapshot().streamingContent).toBe('hello world')
    store.dispatch({ type: 'LIVE_TURN_FLUSH' })
    expect(store.getSnapshot().streamingContent).toBe('hello world tail')
  })
})
```

- [ ] **Step 8: 跑测试与类型检查**

Run: `npx vitest run src/session-store/reducer.test.ts src/session-store/store.test.ts`
Expected: PASS(含新增 3 条与改写的 2 条断言)。

Run: `npm run typecheck`
Expected: PASS(两个 tsconfig;若有其它消费点漏改,此处会暴露 —— 全仓库 `flushedText`/`textChunks` 的写读点已核实仅 `types.ts:256-257`、`reducer.ts:229/230/2020/2021/2111`、`store.ts:1044/1520`,`store.ts:1520` 是 debug dump 的 `.length` 计数,分段数组下语义不变,顺手把键名 `hasTextChunks` 改为 `hasTextSegments`)。

- [ ] **Step 9: Commit**

```bash
git add src/session-store/types.ts src/session-store/reducer.ts src/session-store/store.ts src/session-store/reducer.test.ts src/session-store/store.test.ts
git commit -m "重构:live turn 文本累加器改为带来源标记的分段结构"
```

(评审通过后再提交;diff 用 `git diff HEAD` 全量看。)

---

### Task 2: 定稿裁剪(applyMessage 新增 prune 点)

主线程 assistant 定稿到达时,删除累加器中全部主线程段(含未 flush 尾巴)。Task 1 已把类型与 join 落地,本任务只加一个纯函数 + 一处调用。

**Files:**
- Modify: `src/session-store/reducer.ts:1217-1219`(applyMessage 调用点)、`:~2010`(`updateLiveTurnMirror` 前新增 `pruneFinalizedLiveTurnText`)
- Test: `src/session-store/reducer.test.ts`(新增裁剪 describe,含 replay 路径用例)

**Interfaces:**
- Consumes: Task 1 的 `LiveTurnSegment` / `LiveTurnState.flushedText: LiveTurnSegment[]`;reducer.test.ts 文件级 helper `asstMsg`(`:2261`)、`userMsg`(`:2240`)、`streamEventMsg`(`:2287`)、`sidechainStreamEventMsg`(Task 1 Step 1)、`seedWithLiveTurn`(`:2326`)、`replay`(`:2316`)、`resultMsg`(`:2270`)。
- Produces: `pruneFinalizedLiveTurnText(mirror: ServerMirror, message: SdkMessage): ServerMirror`(reducer 内部函数,不导出;Task 3 无依赖)。

- [ ] **Step 1: 写失败测试**

`src/session-store/reducer.test.ts` 新增(复用 Task 1 的 `sidechainStreamEventMsg`):

```ts
describe('live turn finalized-text pruning', () => {
  function blockStartMsg(uuid: string, blockType: 'text' | 'thinking'): SdkMessage {
    return {
      type: 'stream_event',
      uuid,
      event: { type: 'content_block_start', content_block: { type: blockType } },
    } as unknown as SdkMessage
  }
  function toolUseOnlyMsg(uuid: string, toolUseId: string): SdkMessage {
    return {
      type: 'assistant',
      uuid,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }] },
      parent_tool_use_id: null,
    } as unknown as SdkMessage
  }
  /** main 'hello ' → side 'child ' → main 'world',一次 flush 落进 flushedText */
  function streamMixedTurn(state: ReturnType<typeof createInitialSessionState>): ReturnType<typeof createInitialSessionState> {
    state = reduceSessionState(state, { type: 'MESSAGE', message: streamEventMsg('se-1', 'hello ') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: sidechainStreamEventMsg('se-2', 'child ') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: streamEventMsg('se-3', 'world') })
    return reduceSessionState(state, { type: 'LIVE_TURN_FLUSH' })
  }

  it('drops finalized main-thread segments (flushed AND unflushed) but keeps sidechain ones', () => {
    let state = createInitialSessionState('s')
    state = streamMixedTurn(state)
    // ≤80ms flush 窗口内的未定稿尾巴:主线程 delta,尚未 flush
    state = reduceSessionState(state, { type: 'MESSAGE', message: streamEventMsg('se-4', ' tail') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: asstMsg('a1', 'hello world tail') })
    expect(state.mirror.liveTurn?.flushedText).toEqual([{ text: 'child ', sidechain: true }])
    expect(state.mirror.liveTurn?.textChunks).toEqual([])
  })

  it('keeps liveTurn itself alive (phase/tokenRate source) — only text segments are pruned', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: blockStartMsg('se-0', 'text') })
    state = streamMixedTurn(state)
    state = reduceSessionState(state, { type: 'MESSAGE', message: asstMsg('a1', 'hello world') })
    expect(state.mirror.liveTurn).not.toBeNull()
    expect(state.mirror.liveTurn?.phase).toBe('writing')
    expect(state.mirror.liveTurn?.flushedText).toEqual([])
  })

  it('a flush after pruning cannot resurrect the pruned text', () => {
    let state = createInitialSessionState('s')
    state = streamMixedTurn(state)
    state = reduceSessionState(state, { type: 'MESSAGE', message: asstMsg('a1', 'hello world') })
    state = reduceSessionState(state, { type: 'LIVE_TURN_FLUSH' })
    expect(state.mirror.liveTurn?.flushedText).toEqual([])
  })

  it('a tool-use-only main-thread assistant (no text of its own) still prunes — serial-response invariant covers all prior text', () => {
    let state = createInitialSessionState('s')
    state = streamMixedTurn(state)
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUseOnlyMsg('a1', 'tu_1') })
    expect(state.mirror.liveTurn?.flushedText).toEqual([{ text: 'child ', sidechain: true }])
  })

  it('a sidechain assistant finalize does NOT prune', () => {
    let state = createInitialSessionState('s')
    state = streamMixedTurn(state)
    const sideAsst = { ...asstMsg('a-side', 'sub output'), parent_tool_use_id: 'toolu_sub_1' } as unknown as SdkMessage
    state = reduceSessionState(state, { type: 'MESSAGE', message: sideAsst })
    expect(state.mirror.liveTurn?.flushedText).toEqual([
      { text: 'hello ', sidechain: false },
      { text: 'child ', sidechain: true },
      { text: 'world', sidechain: false },
    ])
  })

  it('result still nulls the whole liveTurn after pruning', () => {
    let state = createInitialSessionState('s')
    state = streamMixedTurn(state)
    state = reduceSessionState(state, { type: 'MESSAGE', message: asstMsg('a1', 'hello world') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: sidechainStreamEventMsg('se-9', 'child still streaming') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultMsg('r1') })
    expect(state.mirror.liveTurn).toBeNull()
  })

  it('prunes via the replay path too: a newer-slice finalized assistant drops its streamed text', () => {
    // REPLAY_REPLACE 的 newer 分片逐帧走 applyMessage(reducer.ts:335-337),
    // 重连回放里出现的定稿 assistant 同样触发裁剪 —— 行为与实时路径一致。
    const state = seedWithLiveTurn([userMsg('u1', 'hi')], 'hello world')
    const after = replay(state, [userMsg('u1-disk', 'hi'), asstMsg('a1', 'hello world')])
    expect(after.mirror.liveTurn).not.toBeNull()
    expect(after.mirror.liveTurn?.flushedText).toEqual([])
  })
})
```

注意:现有的 `preserves an in-progress liveTurn across a benign replay merge`(reducer.test.ts:2437)不受影响 —— 它的 replay 载荷 `[userMsg('u1-disk'), asstMsg('a1')]` 里 `a1` 按 uuid 与缓存重叠,split 判定 `newer = []`(`older = [u1-disk]`),`applyMessage` 不执行,裁剪不触发。跑一遍确认它仍是绿的。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/session-store/reducer.test.ts`
Expected: 新增 7 条中至少「drops finalized main-thread segments」「keeps liveTurn itself alive」「a flush after pruning cannot resurrect」「tool-use-only」「replay path」5 条 FAIL(裁剪尚不存在,`flushedText` 保持全量);「sidechain finalize 不裁剪」与「result 置 null」两条 PASS(它们锚定的是不应被本任务破坏的现状)。

- [ ] **Step 3: 实现 prune**

`src/session-store/reducer.ts`,`updateLiveTurnMirror` 定义之前(`:2010` 附近)新增:

```ts
/** Prune finalized main-thread text from the live turn's accumulator.
 *
 *  Invariant: main-thread API responses are strictly serial — the agent loop
 *  waits for the current response (and its tool runs) before starting the
 *  next. So when a finalized main-thread `assistant` message arrives, EVERY
 *  main-thread segment streamed so far this turn belongs to an already-
 *  finalized response — including the ≤80ms unflushed tail, which is
 *  contained in the finalized text. Dropping all main-thread segments is
 *  therefore an exact operation, not a text-match heuristic, and it bounds
 *  the StreamingFooter to in-flight text only.
 *
 *  Sidechain segments (subagent streams, parent_tool_use_id set) never land
 *  in the main transcript (MessageList filters on parent_tool_use_id) — the
 *  footer is their only in-progress surface, so they are kept. liveTurn
 *  itself stays: phase / tokenRate / samples still drive the WorkingBubble
 *  and the tok/s readout, and an all-sidechain (or empty) result projects to
 *  '' — the same pre-text path a tool-use-only response takes today
 *  (MessageList treats "" as null, running the existing exit-fade).
 *
 *  applyMessage is also the path for REPLAY_REPLACE's newer slice, so a
 *  reconnect replay that carries finalized assistants prunes identically.
 *  The full-overlap drop path (older=newer=[]) never reaches here — same as
 *  today, no pruning, no regression. */
function pruneFinalizedLiveTurnText(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  if (message.type !== 'assistant' || message.parent_tool_use_id != null) return mirror
  const liveTurn = mirror.liveTurn
  if (!liveTurn) return mirror
  const hasMainThread =
    liveTurn.flushedText.some((s) => !s.sidechain) || liveTurn.textChunks.some((s) => !s.sidechain)
  if (!hasMainThread) return mirror
  return {
    ...mirror,
    liveTurn: {
      ...liveTurn,
      flushedText: liveTurn.flushedText.filter((s) => s.sidechain),
      textChunks: liveTurn.textChunks.filter((s) => s.sidechain),
    },
  }
}
```

applyMessage 调用点(`reducer.ts:1217-1219` 之后)插入一行:

```ts
  working = withMirror(working, updateLiveTurnMirror(working.mirror, incomingMessage))
  working = withMirror(working, updateTranscriptMirror(working.mirror, incomingMessage))
  working = withMirror(working, updateIndexesMirror(working.mirror, incomingMessage))
  // A finalized main-thread assistant message means its text now lives in the
  // transcript above — drop the duplicate from the live accumulator (see
  // pruneFinalizedLiveTurnText for the serial-response invariant this leans on).
  working = withMirror(working, pruneFinalizedLiveTurnText(working.mirror, incomingMessage))
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `npx vitest run src/session-store/reducer.test.ts`
Expected: 全 PASS(新增 7 条 + 既有良性重连/older 分片 3 条不受影响)。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session-store/reducer.ts src/session-store/reducer.test.ts
git commit -m "feat:主线程 assistant 定稿时裁剪 StreamingFooter 已定稿文本"
```

(评审通过后再提交。)

---

### Task 3: 全量验证 + 手动确认

**Files:**
- 无新增/修改(验证任务;若全量跑挂出问题,修复归属于对应 Task)

**Interfaces:**
- Consumes: Task 1 + Task 2 的全部产出。
- Produces: 干净的 `npm run typecheck` / `npm run test` / `npm run lint`。

- [ ] **Step 1: 全量测试**

Run: `npm run test`
Expected: PASS(含 client hook tests 与 server 单测;重点看 `MessageList.test.tsx` 的 footer/exit-fade 用例组无回归)。

- [ ] **Step 2: lint**

Run: `npm run lint`
Expected: PASS。

- [ ] **Step 3: typecheck(双 tsconfig)**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 4: 手动行为确认(可选但建议,用户配合)**

Run: `npm run dev` → 起一个长输出回合并观察:
1. 每条主线程响应定稿的瞬间,footer 内容收缩为「当前在途文本」(下一个响应开始前为空/仅剩子代理预览),不再是整回合累计;
2. 派发子代理的回合里,子代理流式文本仍正常在 footer 预览,不闪烁清空;
3. Ctrl+C/Stop 打断后 footer 照常淡出;`/clear` 后 footer 消失。
(既有行为:回合结束时 180ms 淡出;定稿后淡出复用同一机制,残影 ≤180ms 且该文本已在上方 transcript。)

---

## 行为变化披露(评审时重点核对)

1. **footer 的可见内容从「回合级累计」变为「在途级」**:定稿后(距 `result` 约 10-16ms,见 `MessageList.test.tsx:773-775` 的实测注释)footer 内容骤减,触发一次 exit-fade;下一个响应开始流式时重新进入。这条路径今天已被 tool-use-only 回合(文本为空)在回合中途触发过,机器是被演练的;变化的只是触发频率(每响应一次 → 而非仅回合尾一次)。
2. **被打断回合的在途尾部文本仍随 `result`/淡出消失**,与本计划无关、行为不变(不确定项「interrupt 时 CLI 是否补发部分定稿」见 spec §4.3,若补发则该部分走 transcript + 裁剪,仍无损失)。
3. **重连 replay**:良性重连(无 result、无新定稿)保留在途文本(现状);replay 携带新定稿 assistant 时裁剪(正确且是新行为);full-overlap 丢弃路径不裁剪(与今天一致)。

## Self-Review 记录

- **Spec 覆盖**:spec §4.2 的 4 个改动点(types/reducer-push+flush+裁剪点/store join)→ Task 1(前三个中的类型与 push/flush)+ Task 2(裁剪点)+ Task 1 Step 5(join);spec §4.2 测试清单 → Task 1 Step 1/6/7 + Task 2 Step 1(定稿裁剪、sidechain 保留、flush 先后、replay newer 裁剪、良性重连保留[既有用例跑绿即证]);spec §4.3 风险(sidechain、淡出、interrupt、replay、持久化)→ 行为变化披露 + 全局约束;spec §5.3 的 `activePhase`/`tokenRate` 保住 → Task 2 Step 1 第二条用例。
- **占位符扫描**:无 TBD/「适当处理」;所有代码步骤给出完整代码。
- **类型一致性**:`LiveTurnSegment { text; sidechain }` 在 types.ts 定义,Task 1 Step 4(c) 的 push、Task 1 Step 4(a) 的 flush 合并、Task 2 Step 3 的 prune、Task 1 Step 5 的 join、全部测试断言使用同一形状;`pruneFinalizedLiveTurnText(mirror, message): ServerMirror` 签名与 `withMirror` 消费方式一致(同 `updateLiveTurnMirror` 惯例)。
