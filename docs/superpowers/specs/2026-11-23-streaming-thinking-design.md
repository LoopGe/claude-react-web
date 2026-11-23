# 流式 thinking 实时渲染 — 思考块在消息列表原地生长、结束折叠

## 1. Intent / Why

今天 thinking 块在流式期间完全不显示：用户只看到 WorkingBubble 的 thinking 相位 +
token 估计，思考全文要等该块定稿才以折叠行出现。模型思考动辄数秒到数十秒
（实测单块 1559 字符 / ~10s），这段时间转写区没有任何内容生长，用户无法知道
模型在想什么、想到哪了。

本特性让 thinking 全文在流式期间**实时渲染进消息列表**（独立行、全文可见地生长），
思考结束后**折叠成与今天完全相同的折叠行**。参照 DSH（deepseek-harness）的
reasoning 披露形态，但按用户裁决采用「全文实时渲染」而非 DSH 的「默认一行推进预览」。

**裁决继承**：本设计推翻 `2026-10-28-inplace-streaming-card-design.md` §5.2/§5.4 的
用户裁决「thinking 流式期不显示、整体不动」。正文草稿机制（该文档 §5.1/§5.3）
不动——thinking 行是与之平行的独立机制；唯一例外是 §5.6 的 supersede 判定按帧
内容收紧（本文 §5.6）。DSH 机制的完整调研见
`.agents/notes/proposed/simplification/2026-11-23-transcript-devirtualization-research.md`
（"Streaming reasoning previews" 一节）。

## 2. Goals

1. **流式可见**：主线程 thinking 块的第一条 `thinking_delta` 到达时，转写尾部出现
   thinking 行，全文以 ≤80ms 节奏实时生长（与正文草稿同节奏）。纯文本渲染，样式与
   今天展开后的 thinking 体（`pre.thinking-body`）一致。
2. **结束折叠**：thinking 块完成（`content_block_stop`）时该行折叠，折叠形态与今天
   定稿的 thinking 折叠行**像素一致**（同 `AnimatedDetails`、同 summary 标签 + 单行
   预览、同展开体）。折叠后用户可手动展开（与定稿行为一致）。
3. **定稿交接零重排**：thinking 块的定稿 assistant 帧到达时，行 key 别名接管
   （与正文草稿同机制），折叠态 → 折叠态交接，DOM 不变。
4. **渲染隔离不破**：thinking flush 只重渲染 thinking 行 body 叶子；Chat /
   MessageList 在 thinking flush 窗口内零重渲染（扩展
   `streaming-render-isolation.test.tsx` 钉住）。
5. **无 thinking 的响应零回归**：没有 thinking 块的响应走今天的草稿路径，行为逐字节
   不变。

## 3. Non-goals

- **sidechain thinking**（`parent_tool_use_id != null`，子 agent / workflow 内部思考）：
  不累积进行 thinking 行，维持现状（相位行为也不变）。SubagentOverlay 内的流式
  thinking 留作后续。
- **DSH 式「段落首行推进预览」**：用户已裁决要全文实时渲染，不做预览行推进算法。
- **redacted_thinking 内容**：只有签名没有文本，无内容可渲染——不产生 thinking 行，
  相位行为维持现状。
- **流式期间手动折叠开关**：流式中强制展开，结束才折（用户已确认）。
- **thinking 进搜索索引 / 持久化**：与草稿同等待遇——行未定稿不进索引，刷新后
  瞬态消失（定稿后照常）。
- **去 Virtuoso 虚拟化**：本特性独立于虚拟化现状（thinking 行与草稿行一样是
  Virtuoso 常驻尾行），不依赖、不推进去虚拟化。

## 4. Anti-goals / 失败即错

- thinking 文本重复渲染（流式行 + 定稿行同时存在）——supersede 必须精确清除。
- 定稿交接导致行 remount（key 别名失效）或可见跳变（折叠态 DOM 不一致）。
- thinking flush 触发 Chat / MessageList 重渲染（隔离契约回归）。
- sidechain thinking 泄漏进主转写。
- 为未观察到的帧形态加兜底分支（仓库规则：只处理实证存在的状态，异常形态
  fail-visible）。

## 5. The how（已定）

### 5.1 实证基础（2026-11-23 探针实测，探针已移除）

pinned CLI（SDK 0.3.311 / CLI 2.1.311）经 claude provider 实时转发 thinking 流事件，
7 个块全部完整到达客户端 `updateLiveTurnMirror`：

- `content_block_start`：`kind=thinking`，`initialTextLen=0`（文本全部经 delta 到达）；
- `thinking_delta`：3–127 条/块，44–1559 字符/块，主线程 `parent=null`；
- 每块恰好 1 条 `signature_delta` 收尾，随后 `content_block_stop`；
- 无「delta 先于 start」异常。

帧节奏（代码实证，`MessageView.tsx` split 注释）：**SDK 流每个内容块发一条独立
assistant 定稿帧**（磁盘有时整响应合并为一帧，split 逻辑正是为对齐两者）。因此
thinking 块有自己的定稿帧，与正文块各自成行、各自交接。

**帧节奏实证（2026-11-23，磁盘 JSONL 分析）**：分析两个会话的 SDK 转写
（28a77973：2992 主线程 assistant 帧，1137 含 thinking；0eb0856b：393 帧，154 含
thinking）——**0 帧含多个 thinking 块**，thinking 均为单块帧（`[thinking]` 独立
成帧，text / tool_use 同理）。帧间时距与流式/工具执行时长吻合（thinking→text
+156ms~5s；tool_use→下一 thinking +9~30s = 工具执行时间），即**按块顺序发射**
（块完成即发），非 message_stop 统一发。**单槽前提（每响应 ≤1 thinking 块）
成立**，无需升级状态模型。方法学注：磁盘 timestamp 理论上可能是事件时间戳的
批量落盘，但本设计折叠时机独立于帧到达（§5.5），两种时机均成立；Task 8 浏览器
实测确认实际 UX。

### 5.2 行模型：thinking 行 = 独立 transcript 行，平行于正文草稿

`buildTranscriptRows` 尾部行序：`[…settled, frozen…, thinking 行?, 正文草稿行?]`。
thinking 行在正文草稿**上方**（块序 thinking 先于 text；上一响应的内容已定稿）。

- **出现时机**：该响应第一条**主线程** `thinking_delta` 到达时（`content_block_start`
  不触发——它不携带文本）。
- **行 key**：`thinking:<n>`（会话内存内单调，独立于 `draft:<n>` 序列）。定稿帧到达
  时经**同一张别名表** `mirror.draftRowKeys`（uuid → key，本就与 key 命名空间无关）
  接管，行不 remount。
- **行渲染**：走 MessageView（与草稿行同组件类型），合成 assistant 消息标记
  `isDraft: true` + `isThinkingDraft: true`（复用现有 willRenderEmpty 豁免与 split
  豁免）；body 是独立叶子（§5.4）。
- **纯 thinking 响应**（thinking + tool_use，无 text）：thinking 行照常生长——推翻
  旧文档目标 3「无 text 响应什么都不长」中 thinking 的部分；工具卡仍定稿才出现。
- 搜索索引 / 行扫描按「跳过 thinking 草稿行」处理（与草稿行一致）。

### 5.3 状态模型（mirror 层，与 liveTurn/draft 平行）

```ts
// liveTurn 内（stream_event 累积，origin-tagged 与 textChunks 同构）
liveTurn.thinkingChunks: LiveTurnSegment[]   // 未 flush 的 thinking delta
liveTurn.thinkingBlockIndex: number | null   // 当前 thinking 块的 index
                                             // （start 时记录，stop 时清除）

// mirror 层（flush 产物，行层读稳定投影）
mirror.thinkingDraft: { key: string; text: string; done: boolean } | null
mirror.thinkingDraftKey: string | null       // 稳定字符串投影（MessageList 订阅，
                                             // 与 draftKey 同款——行层不吃 flush）
// 打断定格（§5.7）：不另设 frozenThinkingDrafts 数组——frozenDrafts 升级为
// 单一有序 tagged union（{kind:'text',…} | {kind:'thinking',…}），多次打断
// （一次断在 thinking、一次断在 text）按时间交错，保住「位于下一响应行上方」
// 的时序语义。（my call，builder-check 定夺）
```

- `thinking_delta`（主线程）→ push `thinkingChunks`，置 `dirty`（与 text delta 同路，
  使纯 thinking 阶段也触发 flush）。**不**计入 `totalChars` / token rate（rate 的
  `writingStartedAt` 门控语义不变）。
- `content_block_start`（thinking/redacted_thinking，主线程）→ 记录
  `thinkingBlockIndex`；相位行为维持现状。
- `content_block_stop`（index === thinkingBlockIndex）→ `thinkingDraft.done = true`，
  清除 index。
- `LIVE_TURN_FLUSH`（`flushLiveTurn`）→ 主线程 thinkingChunks 合并进
  `thinkingDraft.text`（首条 delta 创建 `thinking:<n>`），sidechain 丢弃；与正文
  draft fold 同 tick。**引用稳定**：只改 text 时不动 done/key 之外的无关引用，
  供叶子选择器 Object.is 去重。注意现有 `textChunks.length === 0` 早退须同时
  考虑 thinkingChunks——纯 thinking flush 不能被早退吞掉。
- **prune**：thinking 定稿帧到达 → `thinkingDraft` 整体清除 + 别名条目（§5.6）；
  `pruneFinalizedLiveTurnText` 同时丢弃主线程 thinkingChunks（与 text 同款串行
  不变量）。
- **api_retry 重试期间的半截 thinking**：与 text draft 完全对称（失败尝试文本留槽、
  重试文本 append、定稿接管）——按「与 draft 同等待遇」继承，不加清理分支。
- `result`（回合结束）→ 未定稿的 thinkingDraft 在 **result 分支**定格进 frozen
  列表（§5.7；freeze 在 sweep 之前，`sweepAtTurnEnd` 本身不碰 draft/frozen）。
- **重置覆盖**：所有真重置路径（CLEAR_TRANSCRIPT / WINDOW_BUMP / REBASE_TRANSCRIPT
  / TRANSCRIPT_RESYNC / 构造）都展开 `createInitialServerMirror()`——thinking 字段
  加进该函数即全覆盖。**REPLAY_REPLACE 不是重置**：benign cache-merge 显式保留
  在途 liveTurn/draft（thinkingDraft 同等待遇存活），newer slice 逐帧走
  `applyMessage` 照常定格/接管。SESSION_TERMINATED 跑 sweep 但**不 freeze**
  （draft 原样存活，thinking 对称继承）。

### 5.4 渲染：叶子订阅 + 两态

`ThinkingDraftBody`（新叶子，`message-list/thinking-draft-body.tsx`）：

- 订阅 `thinkingDraft` 的**投影**（text/done），不订阅整个 mirror——thinking flush
  只重渲染本叶子。正文 `DraftTextBody` 的订阅改为投影 `draft.text`（字符串值稳定），
  使 thinking-only flush 不触发正文叶子重渲染（反向亦然：text flush 不动 thinking
  叶子——flush 保持对方 section 引用不变）。
- **两态共用一个受控 `AnimatedDetails`**（my call，builder-check 定夺——关键：
  若实现为两个不同子树，完成态是新挂载的闭合组件，**不会播放收拢动画**，
  AnimatedCollapse 初 mount 闭合路径直接 pin 0）：`open = !done || userOpened`。
  流式期受控 open=true，summary 点击被受控机制天然吞掉（强制展开，非目标达成）；
  done 翻转触发**同一实例**的既有收拢动画；完成态用户可手动展开（userOpened）。
- **流式态**（done=false）：展开的 thinking 体——`thinking-summary` 标签行 +
  `pre.thinking-body` 全文（纯文本，不做 markdown 编译——thinking 定稿体本就是
  `<pre>`）。无游标（区别于正文草稿；thinking 是原始推理文本）。文本实时生长。
- **完成态**（done=true 且未手动展开）：闭合的 `AnimatedDetails`（`thinking-details`），
  summary = 「thinking」标签 + 单行预览（**复用 `blocks.tsx` 现有的预览计算**：
  空白压成一行、CSS 省略号、不截断长度——预览 helper 从 BlockView 内联代码提取），
  body = `pre.thinking-body` 全文。闭合态 DOM 与定稿 BlockView 输出一致。
- **像素一致契约**：完成态 DOM == 定稿 thinking 块 DOM（同组件、同 props、同文本 →
  同 summary 预览）。前提：累积 delta 文本 === 定稿块 thinking 文本（探针已证文本
  全经 delta 到达；signature 不参与渲染）。builder 用测试钉住：给定同一文本，
  完成态与 `BlockView(thinking block)` 渲染输出一致。

### 5.5 折叠时机：块完成即折，独立于定稿帧到达

`content_block_stop`（thinking 块）→ done=true → `AnimatedDetails` 从展开动画收拢
（复用现有折叠动画机制）。**不等定稿帧**——用户裁决「结束后折叠」指思考结束，
不是响应结束；正文随后流式期间 thinking 行已是折叠态。

定稿帧到达时完成态→完成态交接（像素一致，§5.4）。**已接受边**（均不加补偿代码）：

- 定稿帧在收拢动画进行中到达（块完成即发帧的时机下可能发生）：交接瞬间有
  ≤ 剩余动画高度的一次小跳——与旧文档「thinking 插行正文小移一次」同类。builder
  实测帧时机后若跳变明显，再议。
- done 后用户手动展开、定稿帧才到：交接瞬间收拢一次（定稿 BlockView 非受控
  `defaultOpen=false`，不可动）——唯一合规行为，接受。
- done 翻转可能先于最后一次 flush ≤80ms：收拢启动时预览文本缺尾，flush 落地即
  补齐；定稿帧带全文，交接无损——节奏固有。

### 5.6 定稿交接（supersede）

thinking 块的定稿 assistant 帧（主线程、content 含 thinking 块）到达
（`message-pipeline.ts` MESSAGE 路径）：

- `thinkingDraft` 非空 → 别名 `messageUuid → thinking:<n>` 进 `draftRowKeys`，
  `thinkingDraft = null`。定稿行经现有 split / BlockView 路径渲染折叠 thinking 块。
- 正文草稿的 supersede 条件**收紧**：今天「任何主线程 assistant + draft 存在」即
  接管；改为按帧内容判定——含 text 块的帧接管正文草稿，含 thinking 块的帧接管
  thinking 行。每块一帧的实证节奏下两者互不干扰。收紧严格优于现状：今天
  message_stop 时机下 thinking 帧会错误别名接管 text draft，空壳/纯 tool_use 帧
  也会误接管——收紧后消除。（整响应合并帧的罕见 live 形态若同时含 thinking+text：
  两行→一行的 split 渲染，**别名取 thinking key**（split 渲染 thinking 在前，保住
  上方行身份），两个 draft 同时清除——已文档化接受边，磁盘 replay 不受影响
  （replay 无草稿）。）
- 撤回机制（`supersedes` / refusal-fallback EVICT）作用于真消息 uuid，与草稿无冲突
  （继承旧文档 §5.6）。

### 5.7 打断（interrupt）

- **CLI 抢救半截 thinking 成真消息**：走正常 supersede，零特殊处理（继承旧 §5.7）。
- **无抢救**（打断于 thinking 流式中）：thinkingDraft 定格进统一 frozen 列表
  （§5.3 tagged union）——渲染为**折叠态**静态行（partial 文本在展开体内，用户可
  展开查看；my call：与定稿折叠行同形态，比展开半截文本更贴近「思考被打断」的
  语义）。生命周期与 frozen text 一致：按打断时序位于下一响应行上方、不进索引、
  刷新后消失。
- thinking 已 done 但帧未到即打断：同上定格（done 态本就是折叠）。

### 5.8 滚动 / WorkingBubble / 虚拟化

- 底部跟随 + 迟滞（`useTranscriptScroll` / bottom-stack）不变——thinking 行是尾行
  之一，生长推列表的行为与正文草稿一致；折叠收拢的高度变化由现有滚动机吸收。
- WorkingBubble 的 thinking 相位 + `thinkingTokens` 估计**完全不动**（两者并存：
  行内全文 + 底部进度提示）。
- Virtuoso 视角：thinking 行与草稿行同为常驻尾行，行高测量走现有 MeasuredItem
  机制，无新虚拟化负担。

## 6. Constraints

- 渲染隔离契约（`streaming-render-isolation.test.tsx`）：thinking flush 窗口内
  Chat / MessageList 零重渲染；叶子订阅投影、行层订阅稳定 key。
- 仓库规则：只处理实证帧形态（§5.1）；异常形态 fail-visible（log + 不渲染），
  不预先加兜底；CSS 用主题变量（thinking 现有类已满足）；新颜色须双主题定义。
- 不动 `server/`：探针已证服务端通路完好，本特性纯客户端。
- 不动正文草稿机制（旧文档 §5.1/§5.3/§5.6 契约），除 §5.6 supersede 条件收紧。

## 7. 留给 builder 的

- 帧时机 + 块多重性实证（§5.1）：临时探针确认一次后移除；多块共响应则先升级
  状态模型再动工。
- `ThinkingDraftState` 类型归属（draft-state.ts 扩展 vs 新模块）——约束：与 draft
  生命周期对称、mirror 重置全覆盖。frozen 形态已定（§5.3 tagged union）。
- 叶子选择器的具体接线：`useSessionSelector` 支持模块级稳定选择器 + Object.is
  去重（text/done 原始值投影天然去重）；`useOptionalSessionField` 只支持字段键，
  但 thinking 叶子必有 sessionId。注意 `flushLiveTurn` 只在 mainText 非空时重建
  draft——正文叶子投影化是加固而非可行性前提。
- 折叠动画与定稿帧交接的时序细节（§5.5 接受边的实测）。
- `buildDraftRows` / MessageView 的 thinking 行分支具体形态（placeholder content、
  frozen 行渲染），约束：行层稳定投影、isDraft 同等待遇。
- 测试清单：lifecycle（create/append/done/supersede/freeze/prune/重置）、sidechain
  排除、flush 折叠、像素一致、隔离扩展、无 thinking 零回归、打断两分支。
  **隔离扩展注意**：现有 harness 以 `streamingContent` 变化计 flush 数——
  thinking-only flush 不改 streamingContent，须换用 thinkingDraft.text 计 flush。

## 8. 实现顺序建议（供计划阶段参考）

1. 帧时机探针实证（§5.1）→ 移除。
2. 状态层：liveTurn.thinkingChunks + mirror.thinkingDraft + flush/prune/重置
   （纯函数 + 单测，TDD）。
3. 行层：thinkingDraftKey 投影 + buildDraftRows thinking 行 + MessageView 分支。
4. 叶子：ThinkingDraftBody 两态 + DraftTextBody 订阅投影化 + 像素一致测试。
5. supersede 收紧 + 打断定格 + lifecycle 补全。
6. 隔离测试扩展 + 无 thinking 零回归验证 + 浏览器实测（真实 thinking 回合）。