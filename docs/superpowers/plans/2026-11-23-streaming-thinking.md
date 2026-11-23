# 流式 thinking 实时渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** thinking 块流式期间在消息列表独立行全文实时生长，块完成动画折叠成与今天像素一致的折叠行，定稿帧别名交接零 remount。

**Architecture:** 与正文草稿平行的独立机制——`liveTurn.thinkingChunks` 累积 delta，80ms flush 折进 `mirror.thinkingDraft`，行层订阅稳定 key 投影，body 是独立叶子（受控 AnimatedDetails 两态）。定稿 assistant 帧按内容块类型分别接管 thinking 行 / 正文草稿行（同一张 `draftRowKeys` 别名表）。纯客户端，不动 server/。

**Tech Stack:** React 19 + TypeScript，vitest（client happy-dom），现有 session-store reducer / selectors / AnimatedCollapse 机制。

**Spec:** `docs/superpowers/specs/2026-11-23-streaming-thinking-design.md`（已批准；builder-check 修订版）

## Global Constraints

- 纯客户端：`server/` 零改动（探针已证服务端通路完好）。
- 渲染隔离契约：thinking flush 窗口内 Chat / MessageList / SessionMessageList 零重渲染（`streaming-render-isolation.test.tsx` 钉住）。
- 像素一致：thinking 完成态 DOM == 定稿 `BlockView(thinking block)` DOM（同组件同 props 同文本）。
- 无 thinking 块的响应零回归：正文草稿路径行为逐字节不变。
- sidechain thinking（`parent_tool_use_id != null`）不累积进行 thinking 行。
- 只处理实证帧形态；异常形态 fail-visible，不预先加兜底分支（仓库规则）。
- 单槽前提：每响应 ≤1 thinking 块——Task 1 实证；若揭示多块共响应，**停工**回到设计升级状态模型。
- **DraftTextBody 订阅保持 'draft' 整对象，不做投影化**（spec §5.4 的投影化是可选加固，YAGNI 不实现）：`flushLiveTurn` 结构性保证 thinking-only flush 不重建 draft 引用、text-only flush 不重建 thinkingDraft 引用（Task 3 引用测试钉住，Task 8 隔离扩展验证）。executor 不要按 spec 字面去改 DraftTextBody 订阅。
- 每个 task 提交时 typecheck 必须绿（frozen 类型变更与其消费方适配同 task 落地）。
- CSS 只用主题变量；新颜色须 `:root` + `[data-theme="light"]` 双定义（本计划预期零新颜色——复用 thinking 现有类）。
- 仓库规则：未审查不得提交——每个 task commit 前 self-review 该 task diff；整分支完成后跑 `code-review` skill 全 diff 复审。
- commit message 结尾附 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## Review Focus

1. **打断于 thinking 流式中，随后新回合**——frozen thinking 行按打断时序位于新响应行上方，不丢、不错序（Task 5 freeze 顺序测试）。
2. **thinking 流式中 benign 重连 / 面板切回**（REPLAY_REPLACE cache-merge）——thinkingDraft 存活、行继续生长，不被 replay 抹掉（Task 4 replay 保留测试）。
3. **纯 thinking 响应（thinking + tool_use，无 text）**——thinking 行正常生长/接管，全程不产生正文草稿（Task 5 pipeline 测试）。
4. **redacted_thinking 块**——无文本可渲染：不产生 thinking 行、不崩溃、相位行为不变（Task 3 live-turn 测试）。
5. **thinking-only flush 期间正文叶子与 streamingContent 稳定**——flushedText 引用不被 thinking fold 触碰，DraftTextBody / SideChatAutoScroll 零扰动（Task 3 flush 引用测试 + Task 8 隔离扩展）。

---

### Task 1: 帧时机 + 块多重性探针（实证门，临时 spike）

**Files:**
- Modify（临时，验证后移除）: `src/session-store/live-turn.ts`（updateLiveTurnMirror 入口）
- Modify（永久）: `docs/superpowers/specs/2026-11-23-streaming-thinking-design.md` §5.1（记录实证结论）

**Interfaces:**
- Consumes: 无（首个 task）。
- Produces: 实证结论——thinking 定稿帧到达时机（块完成即发 vs message_stop 统一发）+ 每响应 thinking 块数。后续 task 的单槽模型以此为前提。

- [ ] **Step 1: 加临时探针**

在 `updateLiveTurnMirror` 的 `if (!event || typeof event.type !== 'string') return mirror` 之后插入纯日志块（不触碰 mirror），标记 `TEMP thinking-probe`：
- `message_start`：`console.debug('[thinking-probe] message_start', (event as {message?:{id?:string}}).message?.id)`
- `content_block_start`（thinking/redacted_thinking）：index + kind + `message.parent_tool_use_id`
- `content_block_stop`：index
- 函数外无法拦 assistant 帧——改在 `message-pipeline.ts` `applyMessage` 入口临时加：`incomingMessage.type === 'assistant' && parent_tool_use_id == null` 时 log uuid + content 块类型序列 + `Date.now()`。

- [ ] **Step 2: 用户复现 + 读日志**

请用户在开了 thinking 的会话跑 2–3 个带思考的回合（含一次工具调用回合）。用 `mcp__appdebug__console_read` grep `thinking-probe` 读环。判定：
- 时机：assistant(thinking) 帧 timestamp 紧跟 block_stop（块完成即发）还是紧跟 message_stop（统一发）；
- 多重性：同一 message_start→message_stop 区间内 thinking block_start 计数 ≤1？

- [ ] **Step 3: 移除探针 + 记录结论**

删除两处临时日志（`git diff` 确认两文件回到仅含永久改动的状态）。把结论写入 spec §5.1「留给 builder 实证」段（替换为实证结果）。**若多块共响应：停工，向用户报告，升级设计。**

- [ ] **Step 4: typecheck + 提交文档**

Run: `npm run typecheck`（预期 PASS，探针已移除）
```bash
git add docs/superpowers/specs/2026-11-23-streaming-thinking-design.md
git commit -m "docs: record thinking frame-timing probe evidence

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 状态类型 + draft-state 纯函数

**Files:**
- Modify: `src/session-store/draft-state.ts`
- Test: `src/session-store/draft-state.test.ts`

**Interfaces:**
- Consumes: 现有 `DraftState = { key: string; text: string }`、`supersedeDraft`。
- Produces:
  - `export type ThinkingDraftState = { key: string; text: string; done: boolean }`
  - `export type FrozenDraft = { kind: 'text'; key: string; text: string } | { kind: 'thinking'; key: string; text: string; done: boolean }`
  - `export function appendDraftThinking(draft: ThinkingDraftState | null, seq: number, text: string): ThinkingDraftState`
  - `supersedeDraft` 参数放宽为 `(draft: { key: string }, messageUuid: string)`（返回类型不变；thinking 复用）。

- [ ] **Step 1: 写失败测试**

`draft-state.test.ts` 追加：
```ts
describe('appendDraftThinking', () => {
  it('starts with key thinking:<seq>, done=false, then extends text preserving done/key', () => {
    const started = appendDraftThinking(null, 3, 'a')
    expect(started).toEqual({ key: 'thinking:3', text: 'a', done: false })
    const extended = appendDraftThinking({ ...started, done: true }, 3, 'b')
    expect(extended).toEqual({ key: 'thinking:3', text: 'ab', done: true })
  })
})
describe('supersedeDraft (widened)', () => {
  it('accepts a thinking draft key', () => {
    expect(supersedeDraft({ key: 'thinking:3' }, 'uuid-x').aliasEntry).toEqual(['uuid-x', 'thinking:3'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session-store/draft-state.test.ts`
Expected: FAIL（appendDraftThinking 未定义）

- [ ] **Step 3: 实现类型与函数**

`appendDraftThinking`：有 draft → `{ ...draft, text: draft.text + text }`；无 → `{ key: \`thinking:${seq}\`, text, done: false }`。`supersedeDraft` 参数类型改 `{ key: string }`（函数体不变）。导出两个新类型。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/session-store/draft-state.test.ts`
Expected: PASS（含原有 appendDraftText/supersedeDraft 测试）

- [ ] **Step 5: self-review diff + 提交**

```bash
git add src/session-store/draft-state.ts src/session-store/draft-state.test.ts
git commit -m "feat(thinking): ThinkingDraftState/FrozenDraft types + appendDraftThinking

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: live-turn 累积 / flush / prune

**Files:**
- Modify: `src/session-store/live-turn.ts`
- Modify: `src/session-store/types.ts`（LiveTurnState 两字段 + 初始化处）
- Test: `src/session-store/live-turn.test.ts`

**Interfaces:**
- Consumes: Task 2 `appendDraftThinking`、`ThinkingDraftState`；现有 `LiveTurnSegment`、`flushLiveTurn`、`pruneFinalizedLiveTurnText`。
- Produces:
  - `LiveTurnState.thinkingChunks: LiveTurnSegment[]`、`LiveTurnState.thinkingBlockIndex: number | null`（updateLiveTurnMirror 的 liveTurn 初始化块补 `thinkingChunks: [], thinkingBlockIndex: null`）。
  - `updateLiveTurnMirror` 新行为：主线程 `thinking_delta`（`typeof delta.thinking === 'string'`）push thinkingChunks + `dirty: true`；主线程 thinking/redacted_thinking `content_block_start` 记 `thinkingBlockIndex = event.index`；`content_block_stop` 且 `index === thinkingBlockIndex` → 清 index + `mirror.thinkingDraft` 非空时置 `done: true`（mirror 写，保持 identity short-circuit 纪律）。sidechain thinking_delta 同样 push（sidechain 标记），flush 时丢弃。
  - `flushLiveTurn` 扩展（见 Step 3 算法）。
  - `pruneFinalizedLiveTurnText` 扩展：`hasMainThread` 门控纳入 `thinkingChunks.some(!sidechain)`；丢弃主线程 thinkingChunks（flushedText/textChunks 现有逻辑不变）。
  - **本 task 不改 message-pipeline / reducer**——thinkingDraft 的 mirror 字段在 Task 4 加入；本 task 的 flush 测试用手工构造的含 thinkingDraft 字段的 mirror（类型在 Task 4 才进 ServerMirror——**调整：ServerMirror.thinkingDraft/thinkingSeq 字段声明提前到本 task**，createInitialServerMirror 初始值同批加入，Task 4 只做 snapshot/pipeline 接线）。

- [ ] **Step 1: 写失败测试**

`live-turn.test.ts` 追加（沿用文件现有 mirror 构造 helper）：
```ts
describe('thinking accumulation', () => {
  it('main-thread thinking_delta pushes thinkingChunks and sets dirty', () => { /* stream_event content_block_delta delta.thinking='a', parent null → thinkingChunks [{text:'a',sidechain:false}], dirty true */ })
  it('sidechain thinking_delta is tagged sidechain', () => { /* parent_tool_use_id='t1' → sidechain:true */ })
  it('thinking content_block_start records thinkingBlockIndex; stop clears it and marks thinkingDraft done', () => { /* start index 0 → thinkingBlockIndex 0; mirror.thinkingDraft={key:'thinking:1',text:'x',done:false}; stop index 0 → index null, done true */ })
  it('redacted_thinking start records index but no deltas arrive; stop with null thinkingDraft is a no-op', () => { /* mirror unchanged identity when nothing to flip */ })
  it('thinking deltas do NOT touch totalChars / textChunks / flushedText', () => { /* rate 语义不变 */ })
})
describe('flushLiveTurn thinking fold', () => {
  it('folds main-thread thinkingChunks into thinkingDraft, creates key thinking:<seq+1> on first fold', () => { /* mirror.thinkingDraft null, thinkingSeq 0 → flush → {key:'thinking:1',text:'ab',done:false}, thinkingSeq 1, thinkingChunks [] */ })
  it('drops sidechain thinking chunks', () => {})
  it('thinking-only flush leaves flushedText and draft references UNTOUCHED', () => { /* const before = mirror.flushedText/draft; flush; expect(after.flushedText).toBe(before...) — 引用相等 */ })
  it('text-only flush leaves thinkingDraft reference untouched', () => {})
  it('both-empty dirty flush clears dirty without rebuilding', () => {})
})
describe('pruneFinalizedLiveTurnText thinking', () => {
  it('drops main-thread thinkingChunks on finalized assistant, keeps sidechain', () => {})
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session-store/live-turn.test.ts`
Expected: FAIL（字段/行为未实现）

- [ ] **Step 3: 实现**

types.ts：LiveTurnState 加两字段；ServerMirror 加 `thinkingDraft: ThinkingDraftState | null`、`thinkingSeq: number`；createInitialServerMirror 加 `thinkingDraft: null, thinkingSeq: 0`。

flushLiveTurn 算法（关键约束：thinking-only flush 不得重建 flushedText/draft 引用）：
```ts
if (!liveTurn || !liveTurn.dirty) return mirror
if (liveTurn.textChunks.length === 0 && liveTurn.thinkingChunks.length === 0)
  return { ...mirror, liveTurn: { ...liveTurn, dirty: false } }
// text 路径：仅当 textChunks.length > 0 时执行现有 flushed 重建 + draft fold（原逻辑照搬）
// thinking 路径：mainThinking = thinkingChunks.filter(!sidechain).map(text).join('')
//   非空 → seq = mirror.thinkingDraft ? mirror.thinkingSeq : mirror.thinkingSeq + 1
//          thinkingDraft = appendDraftThinking(mirror.thinkingDraft, seq, mainThinking)
// liveTurn 收尾：{ ...liveTurn, flushedText: <text 路径产物或原引用>, textChunks: [], thinkingChunks: [], dirty: false }
```

- [ ] **Step 4: 跑测试确认通过 + 现有测试零回归**

Run: `npx vitest run src/session-store/live-turn.test.ts src/session-store/reducer.test.ts`
Expected: PASS（reducer.test 现有 flush/draft 测试不回归）

- [ ] **Step 5: self-review diff + 提交**

```bash
git add src/session-store/live-turn.ts src/session-store/types.ts src/session-store/live-turn.test.ts
git commit -m "feat(thinking): live-turn thinking accumulation, flush fold, prune

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: snapshot 接线 + 重置/replay 覆盖

**Files:**
- Modify: `src/session-store/store.ts`（buildSnapshot）
- Modify: `src/session-store/types.ts`（SessionSnapshot 字段）
- Test: `src/session-store/store.test.ts`、`src/session-store/replay-merge.test.ts`

**Interfaces:**
- Consumes: Task 3 mirror 字段。
- Produces: `SessionSnapshot.thinkingDraft: ThinkingDraftState | null`、`SessionSnapshot.thinkingDraftKey: string | null`；buildSnapshot 加 `thinkingDraft: mirror.thinkingDraft, thinkingDraftKey: mirror.thinkingDraft?.key ?? null`（镜像 draft/draftKey 行，store.ts:131-132 旁）。

- [ ] **Step 1: 写失败测试**

```ts
// store.test.ts
it('snapshot exposes thinkingDraft and stable thinkingDraftKey', () => { /* dispatch thinking delta + LIVE_TURN_FLUSH → snapshot.thinkingDraftKey 'thinking:1'；再 flush 同 key 引用不变 */ })
// replay-merge.test.ts（Review Focus 2）
it('benign cache-merge replay preserves an in-flight thinkingDraft', () => { /* mirror 含 thinkingDraft + liveTurn，REPLAY_REPLACE overlap payload → thinkingDraft 引用存活 */ })
it('replay newer-slice result freezes thinkingDraft into frozenDrafts', () => { /* newer 含 result → frozenDrafts 含 kind:'thinking' 条目，thinkingDraft null */ })
// reducer 重置（reducer.test.ts 或 store.test.ts）
it('CLEAR_TRANSCRIPT resets thinkingDraft/thinkingSeq', () => { /* createInitialServerMirror 覆盖 */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session-store/store.test.ts src/session-store/replay-merge.test.ts`
Expected: FAIL（snapshot 字段缺失）。注意：replay 保留测试可能**直接 PASS**（cache-merge 展开 prevMirror 自动带上 thinkingDraft）——若 PASS，记录为「结构性覆盖，测试钉住」，不算失败步骤异常。freeze 测试依赖 Task 5 的 result 分支改动，**本 task 只写保留测试 + 重置测试**，freeze 测试移入 Task 5。

- [ ] **Step 3: 实现 snapshot 接线**

types.ts SessionSnapshot 加两字段（draftKey 旁，types.ts:836）；store.ts buildSnapshot 加两行。replay-merge **零代码改动**（展开 prevMirror 结构性保留）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/session-store/store.test.ts src/session-store/replay-merge.test.ts src/session-store/reducer.test.ts`
Expected: PASS

- [ ] **Step 5: self-review diff + 提交**

```bash
git add src/session-store/store.ts src/session-store/types.ts src/session-store/store.test.ts src/session-store/replay-merge.test.ts
git commit -m "feat(thinking): snapshot thinkingDraft/thinkingDraftKey + reset/replay coverage

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: supersede 收紧 + 打断定格 + frozen 消费方适配

**Files:**
- Modify: `src/session-store/message-pipeline.ts`（228-240 supersede 块、248-266 result freeze 块）
- Modify: `src/session-store/types.ts`（frozenDrafts 类型 → `readonly FrozenDraft[]`，ServerMirror + SessionSnapshot）
- Modify: `src/components/message-list/transcript-rows.ts`（buildDraftRows frozen 按 kind 分支）
- Modify: `src/components/message-list/MessageView.tsx`（frozen thinking 提取 + isThinkingDraft 分支）
- Create: `src/components/message-list/thinking-draft-body.tsx`（最小占位，Task 7 填充）
- Test: `src/session-store/message-pipeline.test.ts`、`src/components/message-list/transcript-rows.test.ts`

**Interfaces:**
- Consumes: Task 2 `supersedeDraft`（放宽版）、`FrozenDraft`；Task 3 mirror 字段。
- Produces:
  - 按帧内容判定的 supersede（thinking 帧接管 thinkingDraft，text 帧接管 draft，别名优先 thinking key）。
  - result 分支统一 freeze（thinking 条目在 text 条目前）。
  - `buildDraftRows` frozen 分支按 kind 构造行（text 照旧；thinking 合成行标记 `isDraft: true, isThinkingDraft: true`，placeholder `content: [{type:'thinking', thinking: d.text}]`）——签名暂不变（第三参 Task 6 加）。
  - MessageView：`draftFrozenThinking` = isThinkingDraft 行 thinking 块文本 join；draft 分支 `msg.isThinkingDraft ? <ThinkingDraftBody sessionId frozenText={draftFrozenThinking || undefined}/> : <DraftTextBody …/>`。
  - 占位叶子：`export const ThinkingDraftBody = memo(function ThinkingDraftBody({ frozenText }: { sessionId?: string; frozenText?: string }) { return <pre className="thinking-body">{frozenText ?? ''}</pre> })`。

- [ ] **Step 1: 写失败测试**

```ts
// message-pipeline.test.ts
it('thinking-bearing finalized frame aliases thinkingDraft key and clears it', () => { /* assistant content [{type:'thinking',thinking:'full',signature:'s'}] → draftRowKeys[uuid]='thinking:1', thinkingDraft null */ })
it('text-bearing finalized frame aliases draft key (unchanged behavior)', () => {})
it('thinking frame does NOT take over the text draft (regression fix)', () => { /* mirror 同时有 draft + thinkingDraft；thinking 帧 → draft 存活、draftRowKeys 无 text 别名 */ })
it('pure tool_use / empty-shell assistant frame supersedes nothing', () => {})
it('merged thinking+text frame aliases the thinking key and clears both drafts', () => { /* 别名取 thinking key */ })
it('result freezes thinkingDraft before draft in frozenDrafts order', () => { /* 两者皆 live → frozenDrafts [..., {kind:'thinking',...}, {kind:'text',...}]，两槽 null */ })
it('result freezes thinking-only (no text draft ever created)', () => { /* Review Focus 3 */ })
it('SESSION_TERMINATED does not freeze thinkingDraft (draft symmetry)', () => { /* sweep 不碰 */ })
// transcript-rows.test.ts
it('frozen thinking entry builds an isThinkingDraft row carrying its text', () => { /* frozen [{kind:'thinking',key:'thinking:1',text:'partial',done:false}] → 行标记 + placeholder thinking 文本 'partial' */ })
it('frozen text entries build rows unchanged', () => { /* 零回归 */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session-store/message-pipeline.test.ts src/components/message-list/transcript-rows.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

supersede 块（替换 message-pipeline.ts:228-240）：
```ts
if (incomingMessage.type === 'assistant' && incomingMessage.parent_tool_use_id == null && messageUuid) {
  const blocks = Array.isArray(incomingMessage.message?.content) ? incomingMessage.message.content : []
  const hasThinking = blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
  const hasText = blocks.some((b) => b.type === 'text')
  let aliased = false
  if (hasThinking && working.mirror.thinkingDraft) {
    const { aliasEntry } = supersedeDraft(working.mirror.thinkingDraft, messageUuid)
    working = withMirror(working, { ...working.mirror, thinkingDraft: null,
      draftRowKeys: { ...working.mirror.draftRowKeys, [aliasEntry[0]]: aliasEntry[1] } })
    aliased = true
  }
  if (hasText && working.mirror.draft) {
    const { aliasEntry } = supersedeDraft(working.mirror.draft, messageUuid)
    working = withMirror(working, { ...working.mirror, draft: null,
      draftRowKeys: aliased ? working.mirror.draftRowKeys : { ...working.mirror.draftRowKeys, [aliasEntry[0]]: aliasEntry[1] } })
  }
}
```
result freeze 块（替换 248-256 的 frozen 构造）：
```ts
const entries: FrozenDraft[] = []
if (m.thinkingDraft) entries.push({ kind: 'thinking', ...m.thinkingDraft })
if (m.draft) entries.push({ kind: 'text', ...m.draft })
const frozen = entries.length > 0
  ? { ...m, frozenDrafts: [...m.frozenDrafts, ...entries], draft: null, thinkingDraft: null }
  : m
```
types.ts frozenDrafts 类型改 `readonly FrozenDraft[]`；transcript-rows frozen 按 kind 分支；MessageView frozen 提取 + 分支；占位叶子文件创建。**同 task 落地，typecheck 不留红窗。**

- [ ] **Step 4: 跑测试确认通过 + typecheck 绿**

Run: `npx vitest run src/session-store/ src/components/message-list/transcript-rows.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: self-review diff + 提交**

```bash
git add src/session-store/message-pipeline.ts src/session-store/message-pipeline.test.ts src/session-store/types.ts src/components/message-list/transcript-rows.ts src/components/message-list/transcript-rows.test.ts src/components/message-list/MessageView.tsx src/components/message-list/thinking-draft-body.tsx
git commit -m "feat(thinking): content-typed supersede + ordered interrupt freeze + frozen rows

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: live thinking 行——buildDraftRows 第三参 / MessageList 订阅

**Files:**
- Modify: `src/components/message-list/transcript-rows.ts`（buildDraftRows 第三参 + live thinking 行）
- Modify: `src/components/MessageList.tsx`（609-629 订阅 + memo）
- Test: `src/components/message-list/transcript-rows.test.ts`、`src/components/MessageList.test.tsx`

**Interfaces:**
- Consumes: Task 4 `thinkingDraftKey` snapshot 字段；Task 5 frozen 行构造 / 占位叶子。
- Produces: `buildDraftRows(draft: DraftState | null, frozenDrafts: readonly FrozenDraft[], thinkingDraft: ThinkingDraftState | null): TranscriptRow[]`——行序 `[...frozen（原序）, thinking 行?, text 草稿行?]`。live thinking 合成行：`{ type:'assistant', uuid: key, isDraft: true, isThinkingDraft: true, parent_tool_use_id: null, message: { role:'assistant', content: [{ type:'thinking', thinking: '' }] } }`（body 读 store，placeholder 传 ''，镜像 live text draft 约定）。

- [ ] **Step 1: 写失败测试**

```ts
// transcript-rows.test.ts
it('buildDraftRows orders frozen, live thinking, live text draft', () => { /* frozen[text,thinking] + thinkingDraft{key:'thinking:1'} + draft{key:'draft:1'} → id 序列 [f1,f2,'thinking:1','draft:1'] */ })
it('live thinking row placeholder thinking text is empty (body reads store)', () => {})
it('no thinkingDraft → row list unchanged from today', () => { /* 零回归 */ })
// MessageList.test.tsx（沿用现有 mock 体系）
it('subscribes thinkingDraftKey and appends the thinking row above the draft row', () => { /* store dispatch thinking delta + flush → 行序断言 */ })
it('computeItemKey aliases a settled thinking uuid to its thinking:<n> key', () => { /* draftRowKeys 含 thinking 别名 → key 查表命中（零改动钉住） */ })
it('thinking draft row is excluded from search indexing like text drafts', () => { /* plainText '' / isDraft 跳过（零改动钉住） */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/message-list/transcript-rows.test.ts`
Expected: FAIL（第三参未实现）

- [ ] **Step 3: 实现**

transcript-rows：第三参 + live thinking 行插在 frozen 之后、text draft 之前。MessageList：`const thinkingDraftKey = useOptionalSessionField(draftSessionId, 'thinkingDraftKey')`；buildDraftRows 第三参 `thinkingDraftKey != null ? { key: thinkingDraftKey, text: '', done: false } : null`；memo deps 加 thinkingDraftKey。computeItemKey / willRenderEmpty / 搜索跳过 **零改动**（isDraft 标记 + draftRowKeys 通用查表已覆盖——Step 1 测试钉住）。

- [ ] **Step 4: 跑测试确认通过 + typecheck 绿**

Run: `npx vitest run src/components/message-list/transcript-rows.test.ts src/components/MessageList.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 5: self-review diff + 提交**

```bash
git add src/components/message-list/transcript-rows.ts src/components/MessageList.tsx src/components/message-list/transcript-rows.test.ts src/components/MessageList.test.tsx
git commit -m "feat(thinking): live thinking row projection + MessageList subscription

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: ThinkingDraftBody 叶子 + 预览 helper + 像素一致

**Files:**
- Modify: `src/components/message-list/thinking-draft-body.tsx`（Task 5 占位 → 完整实现）
- Modify: `src/components/message-list/blocks.tsx`（提取 thinkingPreviewText，thinking 分支复用）
- Create: `src/components/message-list/thinking-draft-body.test.tsx`
- Test: `src/components/message-list/blocks` 相关现有测试（零回归）

**Interfaces:**
- Consumes: Task 4 snapshot `thinkingDraft`；现有 `AnimatedDetails`（`open`/`onOpenChange`/`defaultOpen` props，AnimatedCollapse.tsx:651）、`useOptionalSessionField`。
- Produces:
  - `export function thinkingPreviewText(text: string): string`（blocks.tsx 导出：`text.replace(/\s+/g, ' ').trim()`——与现有内联计算逐字节一致）。
  - `ThinkingDraftBody({ sessionId, frozenText }: { sessionId?: string; frozenText?: string })` 完整两态。

- [ ] **Step 1: 写失败测试**

```tsx
// thinking-draft-body.test.tsx
it('live streaming renders expanded pre with growing text', () => { /* store thinking delta + flush → pre.thinking-body 文本可见、details open */ })
it('done flips closed with the same summary DOM as settled BlockView (pixel parity)', () => { /* 同文本：ThinkingDraftBody done 态 vs <BlockView block={{type:'thinking',thinking:text}}/> → summary outerHTML 相等、闭合态一致 */ })
it('summary click during streaming stays open (controlled swallow)', () => { /* fireEvent.click summary → 仍 open */ })
it('done态 user can expand manually', () => { /* click → open，pre 全文 */ })
it('frozenText renders statically collapsed, subscription inert', () => { /* frozenText='partial' → 闭合；后续 store flush 不重渲染（render count） */ })
it('blocks.tsx thinking branch uses thinkingPreviewText (byte-identical preview)', () => { /* 现有 blocks 渲染快照不回归 */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/message-list/thinking-draft-body.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

blocks.tsx：提取 `thinkingPreviewText` 并在 thinking 分支替换内联计算（DOM 输出不变）。thinking-draft-body.tsx：
```tsx
const thinkingDraft = useOptionalSessionField(frozenText != null ? undefined : sessionId, 'thinkingDraft')
const text = frozenText ?? thinkingDraft?.text ?? ''
const done = frozenText != null ? true : (thinkingDraft?.done ?? false)
const [userOpened, setUserOpened] = useState(false)
// live：受控 open={!done || userOpened} + onOpenChange={setUserOpened}
// frozen：open 传 undefined（非受控），defaultOpen=false
// summary：<span className="thinking-label">thinking</span> + <span className="thinking-preview">{thinkingPreviewText(text)}</span>
// body：<pre className="thinking-body">{text}</pre>
// 外层 AnimatedDetails className="thinking-details" summaryClassName="thinking-summary"
```
受控/非受控切换注意：frozen 与 live 是不同行实例（frozen 行 key 独立），同一实例不会跨模式——AnimatedDetails 的 isControlled 判定稳定。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/message-list/thinking-draft-body.test.tsx src/components/message-list/MessageView.split.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 5: self-review diff + 提交**

```bash
git add src/components/message-list/thinking-draft-body.tsx src/components/message-list/thinking-draft-body.test.tsx src/components/message-list/blocks.tsx
git commit -m "feat(thinking): controlled two-state ThinkingDraftBody leaf + pixel parity

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 隔离扩展 + 全量验证 + 浏览器实测

**Files:**
- Modify: `src/components/streaming-render-isolation.test.tsx`
- Test: 全量 `npm run test`、`npm run typecheck`、`npm run lint`

**Interfaces:**
- Consumes: 全部前序 task。
- Produces: 隔离契约扩展钉住 + 真实回合验证记录。

- [ ] **Step 1: 扩展隔离测试（失败先行）**

counts 加 `ThinkingDraftBody: 0` + vi.mock wrap（镜像 draft-body 的 counted 包装）。新测试：thinking-only delta 窗口（N 个 thinking_delta + N 次 LIVE_TURN_FLUSH，**无 text delta**）→ Chat / MessageList / SessionMessageList 渲染 0 次；ThinkingDraftBody 每 flush 渲染 1 次（**计 flush 用 thinkingDraft.text 变化，不用 streamingContent**——thinking-only flush 不改 streamingContent）；DraftTextBody 渲染 0 次。现有 text 窗口测试保持原样通过。

- [ ] **Step 2: 跑隔离测试确认新测试失败/通过状态**

Run: `npx vitest run src/components/streaming-render-isolation.test.tsx`
Expected: 新测试若前序实现正确应 PASS（隔离是结构性保证）；若 FAIL 说明引用稳定被破坏——定位修复后重跑。

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: 全 PASS。任何失败定位修复（修复本身 self-review）。

- [ ] **Step 4: 浏览器实测（真实 thinking 回合）**

请用户跑：(a) 普通 thinking 回合——观察 thinking 行全文生长→块完成动画收拢→定稿无跳变；(b) 工具调用回合——thinking 折叠后工具卡出现；(c) thinking 流式中打断——frozen 折叠行定格、新回合正常。用 `mcp__appdebug__dom_query` / 截图佐证。发现问题按 systematic-debugging 定位（先日志后修）。

- [ ] **Step 5: self-review + 提交**

```bash
git add src/components/streaming-render-isolation.test.tsx
git commit -m "test(thinking): isolation contract extended to thinking flushes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 6: 整分支 code-review**

跑 `code-review` skill 全分支 diff（仓库规则：未审查不得合并）。验证每条发现、修复确认项、非平凡修复复审。通过后任务完成。