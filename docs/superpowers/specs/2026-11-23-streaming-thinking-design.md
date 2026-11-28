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
   thinking 行，全文以 ≤80ms 节奏实时生长（与正文草稿同节奏）。专用流式块：推理文本
   按 **markdown** 渲染（段落/列表/代码块），**换行**（不再横向增长出看不见的滚动
   区）、高度**封顶**（`--thinking-stream-max-height`，默认 `min(40vh, 320px)`）并在
   内部自动滚动到最新行（手动上滚暂停跟随，回到底部恢复），上方有内容时顶部渐隐；
   左→右揭示动画与正文草稿同款。
2. **结束折叠**：thinking 块完成时该行折叠，折叠形态与今天定稿的 thinking 折叠行
   **像素一致**（同 `AnimatedDetails`、同 summary 标签 + 单行预览、同展开体）。折叠
   动画由**定稿交接**驱动（同一 `ThinkingBody` 实例的 `open` 翻转，见 §5.5），折叠后
   用户可手动展开（与定稿行为一致，展开即同一个封顶/换行块）。
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

`buildTranscriptRows` 尾部行序：`[…settled（frozen text 已按锚点插回其回合）, thinking 行?, 正文草稿行?]`。
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

### 5.4 渲染：一个 `ThinkingBody` 组件，三种状态

`ThinkingBody`（`message-list/thinking-body.tsx`，本轮由 `ThinkingDraftBody` 重命名）
是 live 流式行、定稿行、冻结半截行**共用的唯一组件**，且在 **MessageView 的同一树
位置**渲染：live 草稿行与 settled 单-thinking 块行都直接渲染它（后者不经
`BlockView`，且**该分支不能包 `<Fragment>`**——槽位元素类型一变，React 就会重挂，
折叠动画随之变成瞬时 snap）；`BlockView` 的 thinking 分支委托给同一组件，供 split /
合并帧 / 历史 / raw-report 使用。

- **live 模式**（传 `sessionId`）：订阅 `thinkingDraft` 投影（text/done），streaming
  flush 只重渲染本叶。正文 `DraftTextBody` 的订阅改为投影 `draft.text`（字符串值
  稳定），使 thinking-only flush 不触发正文叶子重渲染（反向亦然）。
- **settled 模式**（传 `text`）：定稿帧 / 磁盘历史的静态全文，默认折叠。
- **frozen 模式**（传 `frozenText`）：打断定格半截文本，默认折叠，订阅 INERT。

**专用流式块**（`.thinking-body` 即滚动视口，内容走与正文草稿**同一套 markdown
管线** `DraftBlocks`；`.md` 根承载揭示动画）：

- 推理文本按 **markdown** 渲染（段落 / 列表 / 粗体 / 代码块），不再是等宽 `<pre>`；
  换行/长词折行由 `.md` 的 `pre-wrap` + `overflow-wrap: anywhere` 规则负责，不再产生
  横向滚动区。
- **body 懒编译**：已定稿/冻结且未展开的行不渲染 `DraftBlocks`（历史首屏不为每个
  thinking 行付 markdown 解析）；`bodyShown` 在首次可见（流式或展开）后锁定，收拢
  动画期间内容不会消失。
- `max-height: var(--thinking-stream-max-height)`（默认 `min(40vh, 320px)`）+
  `overflow-y: auto`；streaming 时 `useStickToBottom` 每次 flush 钉到底部，手动上滚
  暂停跟随、回到底部恢复；`data-scrolled` / `data-at-bottom` 驱动**顶部 / 底部**
  渐隐（sticky 伪元素，背景用 `--bg-elev`；滚动条按仓库惯例隐藏，渐隐就是提示）。
  定稿/冻结不跟随；用户展开时回到顶部（折叠动画期间保持流式视口，不跳内容）。
- 揭示动画由 `DraftBlocks` 的 `animate` 开关驱动（mask 挂在它自己的 `.md` 根上）；
  thinking 传 `cursor=false`（无游标）。
- summary =「thinking」标签 + 单行预览（`thinkingPreviewText`，仅在闭合态计算——
  展开/流式期间 summary 的预览被 CSS 隐藏，逐 flush 跑全串空白折叠是纯浪费）。
- **像素一致契约为字面同一 DOM**：live 完成态与定稿行是同一个组件、同一份渲染，
  不再有两套渲染器可比。

### 5.5 折叠时机：定稿交接驱动（实测帧序修正）

**实测（2026-11-23 WS 探针，claude provider 真实回合）**：thinking 块的定稿
assistant 帧与 `content_block_stop` 同一毫秒到达，且**定稿帧先到**：

```
content_block_start  index=0 thinking
ASSISTANT 帧          blocks=["thinking"]   ← 定稿帧
content_block_stop   index=0                ← 同毫秒，紧随其后
```

因此 `content_block_stop` 驱动的 `done=true`（`live-turn.ts`）在真实流中**永远不会
在 draft 存在时发生**——supersede 已先清空 `thinkingDraft`。旧设计「块完成即折、
同一实例动画收拢」依赖的正是这个不会发生的顺序；实测旧实现从不播放收拢动画。

**折叠改由交接驱动**：定稿帧到达 → `thinkingDraft` 清除 + 别名接管 → settled 行在
live 草稿行的**同一树位置**渲染同一 `ThinkingBody`；同一 `AnimatedDetails` 实例的
`open` 从 true→false，播放既有 240ms 收拢动画。（`MessageView` 对「单 thinking 块的
settled 行」必须直接渲染 `ThinkingBody` 而非经 `BlockView`——后者会在该位置插入
不同组件，重挂一个初始闭合的 `AnimatedCollapse`，pin 0 且不播放动画；同理该分支
不能包 `<Fragment>`。）

**已接受边**（均不加补偿代码）：

- live 合并帧（thinking+text 在同一帧，罕见）走 split 渲染，树位置不同 → 无实例
  连续性、无收拢动画；磁盘 replay 无草稿，不受影响。
- 定稿帧带全文且先于 stop：交接时文本已是最终版，不存在「预览缺尾」窗口。
- done 后用户手动展开在真实帧序下不可达（done 只在交接时成立）；交接后的手动展开
  是正常路径（展开即封顶/换行块，从头读）。

**浏览器实测**：2026-11-23 的旧记录（「动画收拢」）前提有误——同日的 WS 探针证明
定稿帧先于 stop，旧实现从未播放收拢动画。折叠改为交接驱动、专用流式块（换行/
封顶/自动跟随）落地后，需要重新做一次真实 thinking 回合的浏览器复验（生长→换行
不横向溢出→封顶跟随→收拢→定稿无跳变；工具回合；打断定格）。

### 5.6 定稿交接（supersede）

thinking 块的定稿 assistant 帧（主线程、content 含 thinking 块）到达
（`message-pipeline.ts` MESSAGE 路径）：

- `thinkingDraft` 非空 → 别名 `messageUuid → thinking:<n>` 进 `draftRowKeys`，
  `thinkingDraft = null`。单 thinking 块的定稿行在草稿行的同一树位置直接渲染
  `ThinkingBody`（实例连续性 → 收拢动画，§5.5）；其余分帧走 split / `BlockView`。
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
- **无抢救**（打断于 thinking 流式中）：thinkingDraft **不再冻结**，随回合丢弃。
  2026-11-27 用户裁决：thinking 是内部推理，模型未看到、后端不持久化；保留只会
  在客户端留下折叠的 "thinking" 残卡，没有回看价值。
- **正文 text 半截**：仍冻结为 `FrozenDraft`，但带 `anchorUuid`（该回合 `result`
  的 uuid）。`mergeFrozenDraftRows` 把它插回 **result footer 之前**（下一响应
  之前），而不是所有 settled 行之后；长时间会话中不会再出现「残卡固定在列表
  底部」。锚点不在已加载的历史窗口时暂不渲染；刷新后消失；不进搜索索引。
- thinking 已 done 但帧未到即打断：同样不冻结，直接丢弃。

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
4. 叶子：`ThinkingBody` 三态（live/settled/frozen）+ DraftTextBody 订阅投影化 +
   专用流式块（换行/封顶/跟随）+ 交接实例连续性 + 像素一致测试。
5. supersede 收紧 + 打断定格 + lifecycle 补全。
6. 隔离测试扩展 + 无 thinking 零回归验证 + 浏览器实测（真实 thinking 回合）。