# In-place streaming card — 普通消息卡片原地流式生长（inline 档重建）

## 1. Intent / Why

流式预览今天是一件**独立制品**：开关打开时（`streamingMode='inline'`）是 Virtuoso 尾部的一条
`StreamingFooter` 临时行，响应定稿时该行消失、一条真正的消息卡落在原位（换卡交接）；开关
关闭时（`'overlay'`）是悬浮气泡，定稿卡片落地、气泡内对应文本被 prune 裁掉。用户要的是把
「预览」与「卡片」合成一体：**普通消息卡片自己原地长到定稿，一张卡长到底，没有换卡交接**。

范围（用户裁决）：

- **只重建 `'inline'` 档**。开关保留、语义不变（overlay = 悬浮气泡，inline = 在 transcript 里）；
  `'overlay'` 档（`StreamingFooter` 悬浮气泡 + prune 管线）**完全不动**。
- **一条响应一张卡**（用户裁决）。回合级"一卡到底"被明确否决——沿用现有 transcript 语义：
  一条 API 响应 = 一张卡；一个回合 = 一串卡（文字卡 → 工具结果 → 下一条响应的卡 → …）。

## 2. Goals

1. 开关开（`'inline'`）：**含正文的在途响应**（有 text 块）以**普通消息卡**
   （`MessageView` 同一组件）出现在 transcript 尾部，随 flush 生长；响应定稿时**原地停长**——
   内容零交接、无换卡闪变。
2. 定稿交接可视连续：正文渲染结果与定稿渲染**像素一致**；定稿时刻只发生两件小事——
   头部行的时间戳槽从空到有值、流式游标熄灭。为保证高度不跳，草稿卡**预留完整头部行**
   （`showMessageHeaders` 开启时渲染 header、时间戳槽为空）。**唯一例外（用户裁决）**：
   `thinking` 折叠行照现有渲染在定稿时出现在正文上方（正文随之小移一次）——
   thinking 渲染整体不动（流式期不显示、定稿照旧），该行的定稿出现**不计入**不跳保证。
3. **无 text 的响应（纯工具 / 纯 thinking / thinking+工具）不长草稿**（用户裁决"什么都不长"）：
   流式期间什么都不长（WorkingBubble 照常显示活动），定稿时走现有管线（thinking 折叠行 /
   `ToolGroupCard` 折叠 / 组卡合并）——与今天完全一致。"定稿不跳"保证只覆盖长草稿的响应。
   `toolGroupCards: false` 的用户天然无折叠问题（行不折叠，工具卡独立出现）。
4. 增量渲染复用 a9fb16e9 的机制：块级冻结 + `transient` 尾块编译（永不进 LRU）+ 尾叶
   `::after` 游标。每 flush 成本 = 尾块编译，与现 inline 行同级。
5. 卡片正文只含**主线程**内容。子代理在途文本不进卡（定稿卡永远不含它），其在途可视面
   回归 SubagentSwarmPill / SubagentOverlay。
6. 被打断的回合：半截卡原地定格为 interrupted 部分（沿用现有打断渲染），不回滚（§5.7）。
7. 性能护栏不回退：`streaming-render-isolation` 的叶子隔离钉（Chat/MessageList 每 flush
   0 渲染）保持绿色；新增"定稿交接不换行/不重挂"钉。

## 3. Non-goals

- 不改 overlay 档、开关 UI、`streamingRenderMode` 配置键。
- 不做"一个回合一张卡"（明确否决）。
- 不持久化在途草稿（刷新/重放后草稿消失，只回放定稿消息——现行为；打断半截卡的
  刷新消失是同一非目标的延伸，用户已确认）。
- 不改**定稿卡**的渲染管线（定稿仍是整串编译 + LRU；引用定义等保真度不回退）。
- 不做纯工具响应的草稿化（用户裁决"什么都不长"）；工具组卡的实时生长（组卡本身
  原地长）不在本期。

## 4. Anti-goals / 失败即错

- **定稿跳动**：对**长草稿的响应**（含 text 的卡），交接时刻换卡、DOM 重挂
  （组件实例更换）、已长正文的重排都算失败——**两类定稿插入除外**（用户裁决）：
  thinking 折叠行出现在正文上方（正文小移一次）；`[text, tool_use, text]` 交错形态
  定稿插入工具卡（后段文字下移一次）。常见形态 `[text, tool_use]` 的工具卡只在卡片
  底部追加、正文不动。无 text 的响应不在此列（目标 3）。
- **双重渲染**：草稿与定稿同帧并存（旧的"预览 + 卡片"双显问题）绝对不允许。
- **热路径回退**：每 flush 对整条回合重编译（0.2.5 时代的错误）不许回来；尾块编译入
  LRU 污染缓存（a9fb16e9 修掉的）不许复发。

## 5. The how（已定）

### 5.1 行模型：草稿行 = 真正的 transcript 行

`buildTranscriptRows`（`src/components/message-list/transcript-rows.ts`）在尾部追加一行
**草稿行**：一条在途 assistant 响应的合成消息。它不是 `StreamingFooter` 也不是
`StreamingRowItem`——它走 `MessageView` 渲染，和定稿卡**同一组件类型**。这是"无换卡"
的结构性保证：React 同 key + 同组件 = update 而非 remount。

- **出现时机**：该响应的**第一条 text delta** 到达时。thinking / tool_use 不触发长卡
  （两者都定稿才出现，§5.4）；`message_start` 后尚无 text 时不长卡（这段时间由
  WorkingBubble 承担 liveness）。
- 行 key：草稿期为**稳定的本地 id**（如 `draft:<n>`，会话内存内单调）。响应定稿、真消息
  （带真 uuid）落地时，行 key 由**别名表**接管（`messageUuid → draft:<n>`），该消息行继续
  用旧 key 渲染——Virtuoso/React 视角里是同一行的延续。别名表是客户端瞬态（刷新后按
  uuid 重新编号，跨重载无需延续）。
- **无 text 的响应不产生草稿行**（目标 3），其消息定稿后照常参与现有管线（thinking
  折叠行 / `isToolGroupEligible` 折叠 / 组卡合并）——包括"被并入前一个组卡、不再拥有
  自己行"的形态，因为没有草稿行需要别名接管。
- 现有 `VirtuosoItem = TranscriptRow | StreamingRowItem` 联合体中 `StreamingRowItem`
  一档退役（连同 `STREAMING_ROW_KEY`）；草稿行进入 `renderableItems`（真正行序列）。
  搜索索引、`userMsgIndices` 等行扫描按"跳过草稿行"处理（其文本尚未定稿，与今天
  inline 行不进索引一致）。

### 5.2 草稿消息的内容模型：只是文本（用户裁决）

一条响应的内容块序列是 `[thinking?, text?, tool_use*, text?]`。草稿**只累积主线程
文本**（用户裁决"只需要 text"）——thinking 与 tool_use 都是**定稿才出现**的内容
（thinking 折叠行、工具卡都按现有渲染在定稿时落进卡片），与今天的预览语义一致：

```ts
// liveTurn 的文本累积，语义 = 今天的 flushedText 减去 sidechain
liveTurn.draftText: string
```

- 只收主线程（`parent_tool_use_id === null`）的 `delta.text`；sidechain 文本**排除在
  草稿外**（现有 sidechain 标记机制指导过滤），继续走 pill/overlay 面。
  `delta.thinking` / `input_json_delta` 维持现状（不累积、不渲染）。
- 响应定稿（`MESSAGE` 帧）时草稿**整体丢弃**、由真消息行接管（§5.6）——不再需要
  `pruneFinalizedLiveTurnText` 的逐文本裁剪（inline 档）；overlay 档的 prune 不动。
- **无 text 的响应**（纯工具 / 纯 thinking / thinking+工具）不投射草稿行（目标 3）。
- 已接受的定稿重排边（与 thinking 插行同类）：同响应内 `[text, tool_use, text]` 交错时，
  定稿把工具卡插进两段文字之间，后段文字下移一次——罕见形态，接受。

### 5.3 正文渲染：裸块级增量 + 定稿整串编译 = 像素一致

- 草稿正文：`splitStreamBlocks` 切块（复用 a9fb16e9：栅栏整体、空行分块、列表/引用/
  缩进/数学续并、冻结不变量），块**裸渲染**（无每块 `.md` 包裹）进**同一个 `.md` 祖先**；
  尾块 `transient` 编译，冻结块吃 `compileMarkdown` LRU（同一 tree 引用 = React 直接
  bail）。`.streaming-block` 包裹层与接缝补距 CSS 退役——裸块序进同一 `.md`，边距折叠
  语义与定稿完全相同。
- 定稿正文：**保持现状**（整串编译，保真度不回退）。
- 像素一致论证：裸块级编译产出的元素序列 == 整串编译的元素序列（切块从不劈开 mdast
  构造；一个 chunk 编译出它包含的全部 mdast 块的元素）。同一源文本 → 同一 DOM 序列 →
  交接零重排。游标（尾叶 `::after` + 空尾兜底 span + 代码块内嵌 span）只活在草稿期。
- 已知分歧（继承自 a9fb16e9，罕见）：跨空行的链接/脚注**引用定义**在草稿期按块解析、
  显示为字面文本，定稿整串编译才解析成链接——定稿瞬间该罕见内容有一次"字面→链接"
  的变化。定为已文档化的接受边（定义前导携带留作后续增强）。

### 5.4 定稿才出现的内容（thinking 与工具卡，均不动）

- **thinking：整体不动**（用户裁决）。流式期不显示（现状）、定稿照现有渲染出折叠行
  （`blocks.tsx` 的 `AnimatedDetails`：summary 标签 + 单行预览、展开体全文）。
  含 thinking 的响应定稿时该行出现在正文上方、正文小移一次——**接受**（目标 2 例外项）。
- **工具卡：定稿才出现**（用户裁决"只需要 text"）。流式期不渲染（现状），定稿消息的
  tool_use 块按现有 `ToolUseBlock` 渲染进卡片。常见形态 `[text, tool_use]`：定稿时工具卡
  追加在卡片底部、正文不动（底部跟随吸收）；响应输入流式期的 liveness 由 WorkingBubble
  承担。交错形态的重排见 §5.2 接受边。
- **块模型覆盖不到的定稿内容**（罕见）：`context_usage` / `usage_report` 双卡形态、
  `model_not_found` 提示、头部错误 chip 等。v1 草稿不模拟这些特殊形态——定稿时照常
  渲染。已文档化的接受边。

### 5.5 头部行与时间戳

草稿卡渲染完整头部行（`showMessageHeaders` 开），时间戳槽留空——定稿只填时间戳
（+ 发送状态行的定稿态），**高度不跳**。`showMessageHeaders` 关闭时草稿卡无头部行，
定稿也无——同样不跳。

### 5.6 定稿交接（supersede）

定稿 assistant 消息到达（`MESSAGE` 帧）时：草稿行被真消息行**接管**（key 别名，§5.1），
`liveTurn.draftText` **整体丢弃**（不再逐文本 prune）。多响应回合重复此循环。
`supersedes` / refusal-fallback 的撤回机制（`EVICT_MESSAGES`）作用于真消息 uuid，与
草稿无冲突（草稿已被接管）；refusal 场景下若真消息被撤回，行随现有 eviction 消失。

### 5.7 打断（interrupt）

- **CLI 把半截响应抢救成真消息**（部分回合会）：走正常 supersede（§5.6），半截内容
  定稿为普通（部分）消息，`result` 行照常显示 `aborted_streaming` 的 "turn interrupted"
  标记——零特殊处理。
- **没有抢救消息**（打断于 thinking 中 / 首块完成前）：草稿行**原地定格**为合成的
  interrupted 半截卡（用户裁决"不回滚"），沿用现有打断渲染语汇（分隔/标记）。生命周期：
  位于下一条响应草稿行**上方**（回合内不再增长）；不进搜索索引（与草稿一致）；
  **刷新后消失**（草稿不持久化非目标的延伸，用户已确认）；`result` 帧到来时 `liveTurn`
  被清扫但该合成行作为行层状态保留到本会话结束。
- 实现时先实证 CLI 的抢救行为（打断各时机各试一次），两分支都要有测试。

### 5.8 overlay 档与组件去留

- `StreamingFooter` 保留**overlay 变体专用**；`variant="inline"` 分支、`.streaming-*--inline`
  CSS 退役。overlay 气泡自 a9fb16e9 起也是 markdown 卡片渲染——那部分照旧。
- `StreamingFooterVariant` / `StreamingRenderMode` 联合体不变（'overlay' | 'inline'）；
  inline 档的实现从"尾行"换成"草稿行"，开关语义保持。

### 5.9 滚动与动画

底部跟随 + 迟滞（`useTranscriptScroll` / bottom-stack 机制）不变——草稿卡就是尾行，
生长推列表的行为与现 inline 一致。草稿卡**无入场/退场动画**（它不"出现/消失"，它生长、
然后停长）；打断分隔线沿用现有渲染。

## 6. Constraints

- 热路径：80ms `LIVE_TURN_FLUSH`；叶子隔离（flush 只许动草稿卡叶子）；冻结不变量 +
  transient 尾块（a9fb16e9）。
- 复用优先：`splitStreamBlocks` / `markdown-cache`（transient）/ 游标 CSS / toolStatus /
  打断渲染 / prune（overlay 侧）/ `AnimatedDetails` 全部现成。
- 不改定稿卡渲染管线（§3）；`MessageView` 对草稿的支持必须是**加法**（draft 消息形状
  或可选 prop），不能改变既有定稿路径的输出。
- 测试基线：`streaming-render-isolation`、`MessageList.test`、`transcript-chrome.test`、
  `stream-segments.test`、`markdown-cache.test` 全绿；inline 档相关断言按新行为改写。

## 7. 留给 builder 的

- `liveTurn.draftText` 的镜像形状与 reducer 折叠点（`updateLiveTurnMirror` 一带）、
  sidechain 过滤点、`MESSAGE` 接管时的清理点。
- key 别名表的存放位置（client mirror 的哪一层）与 `computeItemKey` 的接线。
- `MessageView` 草稿形态的 prop 命名/形状（draft 消息 vs `draft` 布尔），以及草稿正文
  与定稿文本块渲染的同源一致性核对（§5.3 像素一致的前提：单 text 块形态两者必须
  产出同一 DOM 序列）。
- §5.7 的 CLI 抢救行为实证 + 两分支测试。
- 测试脚手架：定稿交接"不重挂"钉（组件实例/渲染计数断言）、主线程过滤钉、
  无 text 响应不长草稿钉。

## 8. 实现顺序建议（供计划阶段参考）

1. store：`liveTurn.draftText` + sidechain 过滤 + supersede 清理（reducer 单测先行）。
2. 行层：草稿行接入 `buildTranscriptRows` + key 别名 + 草稿行扫描排除（搜索/跳转）+
   无 text 响应不长草稿。
3. 渲染：`MessageList`/`MessageView` 草稿形态（裸块级正文 + 头部预留 + 游标）。
4. 切换：MessageList inline 分支改挂草稿行；`StreamingFooter` inline 变体退役。
5. 打断两分支（§5.7）+ 钉：交接连续性、主线程过滤、叶子隔离全量回归。
