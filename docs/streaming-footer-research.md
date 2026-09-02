# Research: StreamingFooter 内容随回合累积，能否清掉「已发送」的部分

**Date:** 2026-09-01
**Scope:** research only — 未修改任何源码（验证过程中临时创建又删除了一个 reducer 级 scratch 测试，见 §4.4）。

---

## Summary / 结论先行

**可行，且不需要动服务端。** StreamingFooter 只渲染一份「纯文本」字符串，它来自 store 的 `streamingContent`，而后者直接映射 `mirror.liveTurn.flushedText`。这个字段**整个回合单调累加**（跨同一条回合内的所有 assistant 消息，甚至包括子代理 sidechain 的文本），唯一的清零时机是回合结束的 `result` 帧。与此同时，每条 API 响应对应的「已定稿」assistant 消息在回合中途就会落进上方 transcript —— 也就是说 footer 里的文本**绝大部分已经以定稿形式出现在上方**，属于纯重复展示，且每次 80ms flush 都要对整条字符串做 O(n) 拼接 + O(n) DOM 文本替换。

推荐的清理点是「**主线程 assistant 消息定稿落盘时，把累加器里主线程来源的文本段删掉**」，实现需要把现在的扁平 `string` / `string[]` 累加器改成**带来源标记的分段数组**（因为子代理文本也会混进同一条字符串里，且它永远不会落进主 transcript，不能被误删）。最小代价的替代方案是给累加器加一个尾部窗口上限。

---

## 1. 问题描述

### 1.1 StreamingFooter 是什么

- 组件：`StreamingFooter({ content }: { content: string })` — `src/components/message-list/transcript-chrome.tsx:66-206`。它把 `content` 以**纯文本**（非 Markdown）渲染进一个 `.streaming-plain` 气泡（`transcript-chrome.tsx:181-183`），并做两处显示层加工：
  - 把连续 ≥2 个换行折叠成 1 个（避免 Markdown 结构性空行闪现）— `transcript-chrome.tsx:138`；
  - 内容变化时若用户停在底部则自动滚到底（跟随最新一行）— `transcript-chrome.tsx:90-94`。
- 挂载点：`MessageList.tsx:1883-1891`，作为 Virtuoso 列表**之外的 overlay**（`.chat-streaming-region`），配一个 Footer spacer 让定稿消息从它下面滚过（`MessageList.tsx:1773-1792`、`MessageList.tsx:3088`）。
- 气泡高度被 CSS 截在约 3 行：`max-height: calc(3lh + 20px); overflow-y: auto` — `src/styles/chat.css:1427-1428`，超出部分靠内部滚动 + 上下渐隐遮罩（`chat.css:1437-1438`）。**也就是说「累积」在视觉上不会把气泡撑高，但字符串本身和每次 flush 的渲染成本会一直涨，且用户可以在 3 行气泡里向上滚动读到整条回合的历史文本。**

### 1.2 累积的是什么

只有**流式文本 delta**（`content_block_delta` 里 `delta.text`），累积在一个扁平结构里，**没有任何按消息/块的分段或 uuid 标记**：

- 数据结构：`LiveTurnState`（`src/session-store/types.ts:253-288`）
  - `textChunks: string[]`（未 flush 的尾部增量，`types.ts:256`）
  - `flushedText: string`（已 flush 的累计全文，`types.ts:257`）
  - 同结构里还有 `totalChars: number`（`types.ts:272`，只用于 tok/s 估算，数值型无所谓）和 `samples` 环（`types.ts:283`，自带 60 条上限 `reducer.ts:1977`）。**无界增长的就是 `flushedText`。**
- 追加路径：`updateLiveTurnMirror` 的 `content_block_delta` 分支把每段 `delta.text` push 进 `textChunks` 并置 `dirty: true` — `src/session-store/reducer.ts:2083-2115`（push 在 `:2111`）。
- **不进 footer 的内容**：
  - thinking delta 用的是 `delta.thinking` 不是 `delta.text`，被 `:2085-2086` 的类型判断挡掉；
  - 工具卡片、子代理 chip、phase 标签、token 速率都在 **WorkingBubble**（`src/components/Chat.tsx:2037-2052`），与 footer 无关；footer 只承载文本。

### 1.3 一个容易被忽略的事实：子代理文本也混在 footer 里

- 服务端默认 `forwardSubagentText: true`（`server/config.ts:194`），子代理的 `stream_event` 帧会带 `parent_tool_use_id` 转发给客户端；`shouldBroadcastMessage` 对所有非 system 消息都放行（`server/history-utils.ts:158-161`）。
- 而客户端的 delta 累加分支**没有按 `parent_tool_use_id` 过滤**（`reducer.ts:2083-2115` 全分支无 parent 判断；同函数里只有 `content_block_start` 的 phase 分支做了 sidechain 区分，见 `reducer.ts:2054-2082`）。
- 结果：子代理流式文本也会累积进 `flushedText`（已用 reducer 级测试实证，见 §4.4）。这部分文本**永远不会落进主 transcript**（主 transcript 按 `parent_tool_use_id` 过滤只显示根消息，`MessageList.tsx:766-780`），它只出现在 SubagentOverlay / SubagentCard。这是后文「清理会不会丢内容」的关键边界条件。

---

## 2. 当前生命周期（状态字段 + 动作清单)

数据流：WS `message` 帧（`stream_event`）→ `useChatStream` dispatch `MESSAGE`（`src/hooks/useChatStream.ts:322`）→ reducer → `store.buildSnapshot` 把 `liveTurn.flushedText` 投影成 `streamingContent`（`src/session-store/store.ts:1044`，同处还有 `activePhase: liveTurn.phase` `:1045`、`tokenRate` `:1046`，**改 liveTurn 结构时必须保住这两个**）→ `useChatStream` 按字段订阅（`useChatStream.ts:179`）→ `Chat.tsx:1883` 传给 `MessageList`（prop 声明 `MessageList.tsx:80-82`；侧边聊天 `SideChatDrawer.tsx:203` 同源同消费）。

### 2.1 追加（累积）的动作

| 动作 / 时机 | 位置 | 效果 |
| --- | --- | --- |
| `MESSAGE`（`stream_event` / `content_block_delta`，text delta） | `reducer.ts:2083-2115` | `textChunks.push(text)`、`totalChars += len`、`dirty = true`；惰性创建 liveTurn `reducer.ts:2015-2032` |
| `LIVE_TURN_FLUSH`（80ms 定时器） | 触发 `store.ts:753-759`（`LIVE_TURN_FLUSH_MS = 80`，`store.ts:327`）；执行 `reducer.ts:222-234` | `flushedText += textChunks.join('')`；`textChunks = []`；`dirty = false` —— **只搬运，不清零** |
| `MESSAGE`（`message_delta`，usage） | `reducer.ts:2034-2053` | 只更新 `outputTokens` / 速率采样 |
| `MESSAGE`（`message_stop`） | `reducer.ts:2116-2121` | 只清 `outputTokens`，**不清文本** |

注意 flush 的历史：`flushedText` 从一开始就是「回合级累计」语义 —— 262178d 引入时为 `flushedText = textBuffer`（buffer 本身整回合累计），6b793f8 只是为修 O(n²) 把直接字符串拼接改成 chunk 数组（`git log -S flushedText`），**没有改动累计语义，也没有任何先例做过中途裁剪**（`git log --oneline -20 -- src/components/message-list/transcript-chrome.tsx src/session-store/reducer.ts` 里与 footer 相关的只有 6a0ccfa「暂时关闭 live 代码块渲染」和 31c39ae「折叠换行」，均与累积无关）。

### 2.2 清零（重置）的动作 —— 全部只在回合边界

| 动作 / 时机 | 位置 | 效果 |
| --- | --- | --- |
| `MESSAGE`（`type === 'result'`，回合结束） | `reducer.ts:1227-1237` | `liveTurn: null`（+ `sweepAtTurnEnd`）—— **唯一的正常清零点** |
| `REPLAY_REPLACE` 且 newer 分片含 `result` | `reducer.ts:314-330`（判断 `:325`，置空 `:328`） | 重连/切回面板的 replay 若带 result 则清；良性重连则**保留** liveTurn（`reducer.test.ts:2437-2470` 专门测了这两个分支） |
| `CLEAR_TRANSCRIPT`（`/clear`） / `RESET` | `reducer.ts:262-274`（`createInitialServerMirror()` 里 `liveTurn: null`，`types.ts:557`） | 整镜像重建 |

### 2.3 今天**不会**清它的路径（已逐一排查 + 实证）

- 新一条 `user` 消息（新回合开始）：`reducer.ts:1199-1201` 只清 `thinkingTokens`，不动 liveTurn；
- 收到定稿 `assistant` 消息：`updateLiveTurnMirror` 对非 `stream_event` 直接早退（`reducer.ts:2010-2011`），`updateTranscriptMirror` 只追加 items（`reducer.ts:1267-1277`），没有任何路径回写 liveTurn；
- `EVICT_MESSAGES`（refusal 回撤/中断撤回队列）：`evictMessages` 完全不触碰 liveTurn（`reducer.ts:970-1001`）；
- 退场动画期间：`MessageList.tsx:643-678` 的 presence 状态在 `streamingContent` 变 null 后把**最后一段内容**再保留 180ms（`STREAMING_EXIT_MS = 180`，`MessageList.tsx:289`）做淡出；
- 持久化：`persistToStorage` 只存 messages/plainTexts/lastMessageUuid/dismissedSubagents（`store.ts:148-197`），`liveTurn` 不落盘 —— 刷新页面即丢，无持久化负担。

---

## 3. 「已经发送出去的消息」三种可能含义，哪一种成立

### (a) 已经渲染进上方 transcript 的（已定稿）assistant 文本 —— ✅ 代码证据支持这一种

- 每条 API 响应完成时 CLI 都会发一条定稿 `assistant` 消息，**回合中途就到达**：pump 里有明确注释「derive a snapshot from each main-thread `assistant` message so the bar refreshes MID-TURN (per API response)」（`server/session-pump.ts:853-863`）；`MessageList.test.tsx:773-775` 的注释给出实测数据「The final assistant message lands only ~15ms before the `result` frame (server logs show assistant→result ≈ 10–16ms)」。
- 这些定稿消息进 `mirror.items`（`reducer.ts:1267-1277`；`stream_event` 被明确排除，`src/session-store/normalize.ts:105`），并且只要文本非空就渲染（`src/components/message-list/rendering.ts:83-92` 的 `willRenderEmpty` assistant 分支）。
- 而 footer 的 `flushedText` 对此毫无感知：**没有任何代码在定稿消息到达时把对应文本从累加器里去掉**（`flushedText` 全仓库只有两处写点：`reducer.ts:229` 追加、`reducer.ts:2021` 初始化为 ''）。已用 reducer 级测试实证：主线程文本 delta `hello ` + `world` flush 后，`asstMsg('hello world')` 到达后 `flushedText` 仍是 `'hello world'`（§4.4）。
- 结论：**footer 的累积文本 ≈ 本回合已定稿（已在上方 transcript）的主线程文本 + 当前在途那条的未定稿尾部 + 混入的子代理文本**。用户看到的「越积越多、和上面重复」正是 (a)。

### (b) SDK 已消费的排队输入（`message-consumed` 帧）—— ❌ 不成立

`MESSAGE_CONSUMED` 驱动的是**用户输入气泡**的「sending → sent / queued → consumed」状态（`reducer.ts:213-214`、`useChatStream.ts:418`、`MessageList.tsx:1930-1938` 的 `deliveryStatus` 说明）。而 StreamingFooter 展示的是**assistant 输出**，与输入队列完全无关。

### (c) 「已经流到屏幕上的内容」—— 与 (a) 同义

若把「发送出去」理解为「已经推送到屏幕」，其可清理集合与 (a) 相同（定稿部分）；差别只在未定稿尾部要不要保留，见 §4.2 的风险讨论。

---

## 4. 可行性分析

### 4.1 核心问题：store 目前缺「哪段文本属于哪条消息」的索引

- `textChunks: string[]` / `flushedText: string` 都是**无标记扁平结构**（`types.ts:256-257`），`liveTurn.turnId` 只是回合首条 stream_event 的 uuid（`reducer.ts:2018`），不能用来对账。
- 但有一个可依赖的强顺序不变量：**主线程 API 响应是严格串行的**（agent loop 等当前响应结束、工具执行完才发起下一条），所以「第 k 条主线程 assistant 定稿到达时，累加器里所有主线程文本必然都属于已定稿的第 1..k 条」。⇒ **「主线程定稿到达 ⇒ 删掉累加器里全部主线程来源文本段」是精确操作，不依赖文本比对**（不需要 `startsWith` 之类脆弱匹配）。
- 唯一的时序噪声是 80ms flush 定时器：定稿帧到达时 `textChunks` 里可能还压着最后 ≤80ms 的 delta —— 它们也一定包含在定稿消息的全文里，一并删除即可，无丢失。删除后若 flush 定时器随后才触发，`textChunks` 已空，`flushedText += ''` 是 no-op（`reducer.ts:222-234` 对空数组安全）。

### 4.2 需要改什么（推荐方案 A：来源标记分段 + 定稿即删）

1. **`src/session-store/types.ts`** — `LiveTurnState` 的 `textChunks` / `flushedText` 改为带来源的分段结构，例如 `Array<{ text: string; sidechain: boolean }>`（保序，这样子代理文本和主线程文本的先后显示顺序不变；`flushedText` 若要避免每次 join，可让 snapshot 侧 join）。
2. **`src/session-store/reducer.ts`**
   - `content_block_delta` 分支（`:2083-2115`）：push 时带上 `sidechain = message.parent_tool_use_id != null`（该函数里 `:2067` 已经在读这个字段，顺手可取）。
   - `LIVE_TURN_FLUSH`（`:222-234`）：搬运逻辑不变，只是对象换成段。
   - **新增清理点**：`applyMessage` 里对 `type === 'assistant' && parent_tool_use_id == null && liveTurn 存在` 的帧，在 `updateLiveTurnMirror` 调用（`:1217`）之后过滤掉 `sidechain === false` 的段（textChunks 与 flushedText 两处）。放在 applyMessage 里意味着 replay 的 newer 分片路径（`reducer.ts:335-337`）天然复用 —— 重连回放里出现的定稿 assistant 同样会触发裁剪，行为一致。
3. **`src/session-store/store.ts`** — `buildSnapshot`（`:1044`）把段数组 join 成 `streamingContent` 字符串；`activePhase` / `tokenRate` 两行不动。
4. **测试**
   - `src/session-store/reducer.test.ts`：定稿后主线程段被删、sidechain 段保留、定稿与 flush 定时器的先后顺序（先 MESSAGE 后 LIVE_TURN_FLUSH 不回填）、replay newer 分片含定稿 assistant 时同样裁剪；
   - `src/components/MessageList.test.tsx`：定稿消息落地后 footer 文本收缩；退出淡出（`MessageList.tsx:643-678`）仍工作。

纯客户端改动，无协议/服务端变化。

### 4.3 风险与边界情况

- **子代理文本（最重要的边界）**：它永远不会进主 transcript（`MessageList.tsx:766-780` 的 parent 过滤），footer 是它唯一的「进行中」可视化面。方案 A 用 `sidechain` 标记保住它；**任何「定稿即整串清空」的朴素实现都会把子代理文本一起抹掉**，表现为子代理运行时 footer 闪烁/空白。
- **退出淡出的短暂残影**：回合最后一条 assistant 定稿后（距 `result` 约 10–16ms，`MessageList.test.tsx:773-775`），`streamingContent` 变 `''`，`MessageList.tsx:643` 把空串当 null → 走退出分支，presence 会把**清空前的旧内容**再展示 180ms（`:651-678`）。这段旧内容此刻已同时出现在上方 transcript，与今天回合结束时的行为相同（今天淡出保留的是整回合文本，方案 A 后只剩最后一段，反而更短）。若要完全无残影，可在退出分支里对「因定稿清空」的场景直接清 `content`，但这会牺牲淡出动画，需要单独权衡。
- **被打断的回合**：在途那条响应的部分文本永远不会定稿；今天它在 `result` 时随 `liveTurn: null` 消失（`reducer.ts:1232`，淡出保留 180ms），方案 A 不改变这一点（只提前清掉了「已定稿」部分）。**不确定项**：CLI 在 interrupt 时是否会补发一条含部分文本的定稿 assistant 消息（若会，则该部分文本会在 transcript 里出现并被方案 A 裁掉，仍然无损失）；确认方式是打断一个长输出回合并抓取 WS `message` 帧序列。
- **重连/重放**：良性重连保留 liveTurn（`reducer.ts:314-330`），段结构照常保留；重放 newer 分片里若含定稿 assistant，裁剪恰好是正确行为。唯一残留：overlap 部分走 `splitReplayAgainstCache` 丢弃路径、`applyMessage` 不执行（`reducer.ts:338-347`），此时不会触发裁剪，footer 可能保留一段已在 transcript 的重复文本 —— 与今天行为一致，不是回归。
- **无持久化影响**：`liveTurn` 不写 localStorage/IDB（`store.ts:148-197`）。
- **性能收益（本需求的原始动机之一）**：当前每 80ms 一次 `flushedText + join` 的 O(n) 字符串分配（`reducer.ts:229`）+ 整串 `replace` 的 O(n)（`transcript-chrome.tsx:138`）+ 整个文本节点的 O(n) DOM 替换（`transcript-chrome.tsx:181-183`），n 随回合无界增长；裁剪后 n 被限制在「当前在途消息 + 子代理在途文本」的量级。

### 4.4 结论所依赖的实证（scratch 测试，已删除）

为避免猜测，写了一个临时 reducer 级测试（`src/session-store/__scratch_footer__.test.ts`，`npx vitest run` 3 条断言全绿后删除），验证了：

1. 主线程文本 delta flush 成 `flushedText: 'hello world'` 后，到达定稿 `asstMsg('hello world')`，`flushedText` **保持不变**（重复存在）；
2. `parent_tool_use_id: 'toolu_01'` 的 sidechain text delta **确实累加**进 `flushedText`（得到 `'parent child text'`）;
3. 新 `user` 帧**不清** liveTurn，只有 `result` 帧清成 `null`。

### 4.5 备选方案

- **方案 B：按 `message_start` 重置**（每条新响应开始时清空累加器）。实现更简单（无需分段），但会把上一段响应与子代理运行之间累积的 sidechain 文本一次性抹掉（子代理预览闪空），且清理时机比「定稿」更粗。仅当不关心 sidechain 预览时可取。
- **方案 C：尾部窗口上限**（在 `LIVE_TURN_FLUSH` 里只保留最后 N KB，`reducer.ts:222-234` 一行改动）。零耦合、立刻解决性能与「无限累积」，但属于「丢弃」而非「对账」：超出窗口的文本若尚未定稿（被打断的回合尾部、子代理文本）会提前从 footer 消失。考虑到气泡本来就只有 3 行高（`chat.css:1427`）且贴底滚动，实际可感知损失很小，适合作为快速止血或与方案 A 并用的保底。

---

## 5. 结论 / 建议

1. **判定：可行。** 「已发送」= 已定稿并渲染进上方 transcript 的主线程 assistant 文本；它在 footer 中是纯重复展示，可以安全清除。清除的正确时机是「主线程 assistant 消息定稿到达」这一 reducer 事件，而不是回合结束。
2. **推荐实现（方案 A）**：把 `LiveTurnState` 的文本累加器改为带 `sidechain` 标记的分段数组，在 `applyMessage` 处理主线程定稿 assistant 时删除全部主线程段。改动集中在 `src/session-store/types.ts`、`src/session-store/reducer.ts`、`src/session-store/store.ts`（snapshot join）+ 两个测试文件，服务端与 WS 协议零改动。
3. **必须保住的语义**：sidechain（子代理）文本段不被误删；`activePhase` / `tokenRate` 仍从同一 `liveTurn` 派生（`store.ts:1044-1046`）；良性重连保留在途文本（`reducer.ts:314-330`）；退出淡出 180ms 的现有手感（`MessageList.tsx:643-678`）。
4. **若想先低成本止血**：方案 C（flush 时尾部窗口）一条改动即可同时解决「无限累积」和每 flush 的 O(n) 成本，之后再决定是否升级为方案 A 的精确对账。
