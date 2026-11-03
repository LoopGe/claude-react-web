# MessageList re-show、入场动画与滚动统一模型调研

**日期：** 2026-11-03
**范围：** 初始只读调研及后续真浏览器实测、独立修复与迁移记录。依据当前工作区源码、测试、既有实测记录及 Virtuoso 官方资料。下文区分“源码事实”和“建议”。
**笔记位置：** 仓库已有 `docs/*-research.md`（如 `docs/async-lifecycle-dedup-research.md`、`docs/streaming-footer-research.md`），本文沿用该约定。

> **2026-11-03 真浏览器实测更新：** 已用 production MessageList + real Chromium/Virtuoso 验证 320ms panel CSS、500ms row-sweep 上限和 750ms follow suppression；wrapper replacement 的 id 去重缺陷已先以失败测试复现，再通过直接读取 wrapper 自身 id 独立修复。rapid-gesture 也已独立完成 RED→GREEN：旧手势不再被机械向上位移跨 show 续期，真实 post-show 手势仍能提前结束 suppression。详见第 10 节。

## 结论摘要

**可以统一，但应统一“面板/转场事件契约 + 入场生命周期语义”，不应把 `MessageList`、re-show、`useTranscriptAnimations`、`useTranscriptScroll` 合成一个大 hook。**

推荐目标是 **一个 re-show 事件契约、两个正交控制器**：

1. App 继续拥有 keep-alive 成员关系、fresh/re-show 分类和 **pre-commit scroll memory**；可新增显式 `showEpoch`，让三类视觉/滚动效果消费同一次 hide→show，而不是各自推断。
2. `useTranscriptAnimations` 扩展为三种入场模式的唯一所有者：initial reveal、live row entrance、keep-alive re-show。`MessageList.tsx:839-956` 的 re-show sweep 移入该 hook；源码自己也把这里标为“第二套入场系统”的技术债（`src/components/MessageList.tsx:848-851`）。
3. `useTranscriptScroll` 继续独立拥有 FOLLOWING / AWAY / ANIMATING、用户手势归因和几何补偿，只消费相同的 visibility/epoch/settle 契约。不要把它与视觉动画状态合并成 Cartesian 状态机；其现有三态及底部不变量已是明确模型（`src/components/message-list/useTranscriptScroll.ts:11-41`）。

最重要的边界：**App 的滚动快照不能下移到 MessageList/hook。** 它必须在 `openIds` 改变的 render 阶段、React 移动或隐藏 keyed PanelSlot 之前读取可见 scroller；提交后再读已经可能丢失 offset（`src/App.tsx:2819-2828,3002-3008`）。因此“统一 hook”不可能成为全部状态的所有者。

---

## 1. re-show 的准确定义与入口

### 1.1 定义

本文的 **re-show** 专指：一个仍在 App keep-alive cache 中、之前以 `display:none` 隐藏且未卸载的 panel，再次进入 `openIds` 和可见 grid。它不是 fresh mount，也不是 transcript key 切换。

入口链路如下：

1. `PanelSlot key={session.id}` 保持身份，隐藏只切换 `.panel-slot-cached`，子树、Virtuoso window、follow gate 和 WS 订阅保持存活（`src/components/PanelSlot.tsx:1-12,22-31`；cache 规则见 `src/utils/panel-cache.ts:1-22`）。
2. App 在 render 阶段比较前后 `openIds`：新可见 id 若已经在旧 `panelCache` 中，进入 `replayEnterSetRef`；否则进入 fresh `enteringSetRef`（`src/App.tsx:2958-2991`）。
3. 同一 render 计算 `visible = openIdx >= 0`，传递 `PanelSlot hidden={!visible}`、`ChatPanel panelVisible={visible}` 和 `enteringReplay`（`src/App.tsx:5306-5335`）。
4. `ChatPanel` 只转发 `panelVisible`，并以 `key={session.id}` 隔离真正的 session 更换（`src/components/ChatPanel.tsx:1369-1375`）；`Chat` 再传给 `SessionMessageList`（`src/components/Chat.tsx:2338-2347`）。
5. 同一个 re-show 当前产生三种独立效果：
   - App panel 级 `.entering-replay`：320ms，前 30%（约 96ms）透明，用来遮住 Virtuoso stale-position frames（`src/App.tsx:2966-2982`；`src/styles/layout.css:829-856`）。
   - MessageList 行级 WAAPI cascade：同一 mounted list 在 `panelVisible` false→true 后扫描可见 rows（`src/components/MessageList.tsx:839-956`）。
   - scroll 的 750ms mechanical-settle 窗口：禁止机械 scroll events 重新 latch follow（`src/components/message-list/useTranscriptScroll.ts:179-184,292-351`）。

### 1.2 不是 re-show 的情况

| 场景 | 当前语义 |
| --- | --- |
| fresh mount / LRU 驱逐后再打开 | App 使用 `.entering`；动画 hook 的 key-scoped initial reveal 可再次运行，因为旧组件状态已销毁（`src/App.tsx:2973-2989`；`src/components/message-list/useTranscriptAnimations.ts:154-179`）。 |
| `transcriptRevealKey` 改变 | keyed `.chat-messages` 与 Virtuoso remount；initial reveal 接管，re-show effect 清状态并直接返回，避免两种 cascade 叠加（`src/components/MessageList.tsx:866-879,1721-1738`）。 |
| 普通 Virtuoso scroll remount | `knownIdsRef` / consumed enter flag 防止旧消息重播 `msg-enter`；它不是 panel re-show（`src/components/message-list/useTranscriptAnimations.ts:124-153,341-374`）。 |
| 可见 panel reorder | App scroll memory 会执行，但 `panelVisible` 没有 false→true，因此不触发行级 re-show 或 scroll re-show settle。不能把“发生 restore pass”等同于 re-show（`src/App.tsx:2819-2828,2855-2941`）。 |
| overlay / dialog 中省略 `panelVisible` | 初次可见按普通 mount 处理；没有实际 hide 记录就不会跑 re-show cascade（`src/components/MessageList.tsx:175-180,891-897`）。 |

---

## 2. 现有职责与状态所有权

| 所有者 | 当前职责 | 关键状态 / 输出 |
| --- | --- | --- |
| App | keep-alive LRU、fresh/re-show 分类、panel enter/exit、可见 scroller 的快照/恢复/持续 re-assert | `panelCache`、`enteringSetRef`、`replayEnterSetRef`、`panelScrollMemoryRef`（`src/App.tsx:2819-2855,2958-3024`）。 |
| MessageList | row model 接入、`firstItemIndex` 同提交锚定、Virtuoso 配置、bottom-stack 测量，以及目前的 re-show sweep | `rowAnchorRef`、`bottomStackHeight`、`rowReplayRef`（`src/components/MessageList.tsx:398-430,660-754,839-956`）。 |
| `useTranscriptAnimations` | 两类 one-shot：live tail row entrance、首个 ready transcript 的 initial reveal；不提供 re-show 输入 | `knownIdsRef`、`enterIdsRef`、`prevLenRef`、key-scoped reveal refs、`reveal` React state、`messagesElRef`（`src/components/message-list/useTranscriptAnimations.ts:119-179`）。 |
| `useTranscriptScroll` | 所有 scroller 几何读写、follow gate、用户手势归因、follow/jump/seek rAF、ResizeObserver 补偿、re-show follow-rearm suppression | `shouldFollowRef` + declarative `following`、`atBottomRef`、`userScrollIntentRef`、`lastShowAtRef`、animation/seek/settle handles（`src/components/message-list/useTranscriptScroll.ts:274-425`）。 |
| SessionMessageList / SessionSynchronizer | 提供 transcript 数据和 paging，不拥有视觉/滚动状态 | `items`、`replayReady`、`oldestSeq`、`hasOlder` 的窄订阅（`src/components/SessionMessageList.tsx:89-126`）；`loadOlder` 与 in-flight/stale-page 防护（`src/session-sync/session-synchronizer.ts:629-692,724-756`）。 |
| Virtuoso | virtual window、行测量和回调原语；不拥有 App 的 panel 转场 | MessageList 传入 `data`、`firstItemIndex`、`initialTopMostItemIndex`、`followOutput`、`rangeChanged` 等（`src/components/MessageList.tsx:1732-1777`）。 |

两个现有共享 seam 尤其重要：

- `messagesElRef` 虽由动画 hook 创建，却被 MessageList 的 re-show sweep 复用（`src/components/MessageList.tsx:742-754,866-868`）。这说明 re-show 已经在事实上依赖动画 hook 的 DOM 所有权，只是状态仍留在外面。
- `data-following` 由 scroll hook 写入 wrap，App 读取它决定是否为 AWAY panel 恢复旧 offset；FOLLOWING panel 应去新底部，不能与旧快照拔河（`src/components/message-list/useTranscriptScroll.ts:380-395`；`src/App.tsx:2876-2888`）。

---

## 3. 触发时序与事件流

### 3.1 初次 ready / transcript key 切换

1. `replayReady` 和 `items` 来自 session store；wrapper 派生 `transcriptSettling = !replayReady`（`src/components/SessionMessageList.tsx:95-116`）。
2. render 阶段同步完成 rows、`firstItemIndex` 和 entrance gate；prepend 锚必须与 data 同一次 commit，不能等 effect（`src/components/MessageList.tsx:660-736`）。
3. initial reveal 在 render 中 arm，pending class 同提交把 list 保持在透明状态；空 transcript 不 arm，key 只消费一次（`src/components/message-list/useTranscriptAnimations.ts:154-179,295-337`）。
4. layout effect 后的双重 rAF poll 等待 Virtuoso item-list 已暴露且实际渲染了属于当前 key 的 rows，再以一次 React state commit 同时写 container class 和 row snapshot classes（`src/components/message-list/useTranscriptAnimations.ts:376-447`）。
5. row 的 `animationend` 从 snapshot 移除自己，最后一个结束后清空 reveal；未收到事件时有 fallback timer（`src/components/message-list/useTranscriptAnimations.ts:449-473`）。

**关键不变量：** initial reveal 是“当前 key 的第一次 ready 非空 transcript”，不是“每次可见”或“每个新消息”的动画（`src/components/message-list/useTranscriptAnimations.ts:154-157,295-314`）。

### 3.2 live tail arrival

1. row gate 只把“replayReady 下符合 batch 规则的尾部新增、id 未见、`receivedAt` 新近、非 optimistic”视为 live entrance；首个新消息也可凭 recency 进入，而 prepend、replay、Virtuoso remount、optimistic→server re-key 都有专门排除或 bookkeeping（`src/components/message-list/useTranscriptAnimations.ts:184-215`；`src/utils/enter-animation.ts:9-18`）。
2. 原始 `items.length` 增长触发 layout-effect append pin，目标是让新 row 在首次 paint 就已贴底；这里故意用 raw item count，而非 filtered row count（`src/components/message-list/useTranscriptScroll.ts:193-199,553-577`）。
3. Virtuoso `followOutput` 回调只调用自有的逐帧重读 `scrollHeight` 动画并返回 `false`，避免库和自己的滚动写入竞争（`src/components/message-list/useTranscriptScroll.ts:1593-1616`）。
4. 后续行高测量、bottom spacer 和其他几何变化由 RO / settle verification 补偿；FOLLOWING 时“底部”是持续不变量，不是一次 callback（`src/components/message-list/useTranscriptScroll.ts:480-536,856-929`）。

**关键不变量：** AWAY 只能由真实用户向上手势（或明确 seek）进入，机械向上位移应在 FOLLOWING 下被校正，不能误判为用户离开（`src/components/message-list/useTranscriptScroll.ts:1300-1372`）。

### 3.3 hide → re-show

**隐藏前 / 提交前：** App 在 render 阶段只快照可见 scrollers，隐藏中的 0×0 scroller 不得把记忆写成 0（`src/App.tsx:2831-2849,3002-3014`；`src/utils/panel-cache.ts:81-87`）。

**show commit / paint 前：**

- scroll hook 的 layout effect 记录 `lastShowAtRef`；这是 mount 或 `panelVisible` false→true 的机械事件时间戳（`src/components/message-list/useTranscriptScroll.ts:292-316`）。
- App layout effect 恢复可见且非 FOLLOWING panel 的旧 offset，并启动最长 750ms 的逐帧 re-assert；FOLLOWING panel 跳过旧 offset，由 follow machinery 去新底部（`src/App.tsx:2855-2898`）。
- wheel/touch 或明显的用户位移可提前取消 re-assert，避免与用户抢 viewport（`src/App.tsx:2910-2938`）。

**Passive effect / 后续帧：**

- MessageList passive effect 在真实 hide 后的 show 上启动最长 500ms 的 rAF sweep；每帧只选 viewport 内 rows，空间位置映射为最高 300ms delay，并跳过 optimistic 与已经带 `msg-enter` 的 row（`src/components/MessageList.tsx:891-951`）。
- scroll hook 在 750ms 内不根据机械“回到底部”事件 re-arm follow；若用户在 show 之后重新手势，则提前退出 suppression（`src/components/message-list/useTranscriptScroll.ts:338-351,655-670,1362-1371`）。
- `syncBottomGeometry`、follow-debounce 和 scroller/item-list RO 在 `clientHeight === 0` 时显式 stand down，避免把 collapsed 几何当成真实底部（`src/components/message-list/useTranscriptScroll.ts:644-654,677-688,1029-1047`）。

这不是“所有 writer 在 hidden 时都零写入”的全局保证：append pin、spacer pin、settle verification 和 `followOutput` 自有动画路径没有统一的 collapsed check（`src/components/message-list/useTranscriptScroll.ts:512-535,571-577,904-911,1612-1616`）。FOLLOWING 时这些路径仍可能写隐藏 scroller；AWAY 则会被 `shouldFollowRef` 挡住。现有测试主要钉 hide-flip 的 RO/geometry paths，并未驱动“隐藏中真实 append/flush”。统一前应实测记录，而不能把架构注释扩大成未经验证的不变量。

**两种不同的恢复结果必须保留：**

- FOLLOWING + 隐藏时内容增长 → show 后跟随**新底部**（`src/components/MessageList.test.tsx:5102-5139`）。
- AWAY → 恢复**旧位置**，机械 remount/clamp 不得把它重新 latch 到底部（`src/App.tsx:2876-2888`；`src/components/message-list/useTranscriptScroll.ts:292-351`）。

### 3.4 流式更新与退出动画

- Overlay 模式的 80ms flush 只重渲染 `OverlayStreamingRegion` 叶子；它在 `.chat-bottom-stack` 内，DOM 尺寸变化经 RO 更新 spacer 和 scroll，不依赖 MessageList 每帧重渲染（`src/components/message-list/OverlayStreamingRegion.tsx:1-17,44-61`）。
- turn end 时 AnimatePresence 保留冻结 subtree 播放 fade/sink 和高度 collapse；stack 的 MutationObserver/RO 同步驱动 Footer spacer 与 re-pin（`src/components/message-list/OverlayStreamingRegion.tsx:40-61`；`src/components/MessageList.tsx:971-1111`）。
- Inline 模式由 draft body 叶子订阅增长，draft row 保持身份；现有测试同样要求 MessageList 在 flush 窗口 0 renders（`src/components/streaming-render-isolation.test.tsx:266-298`）。
- 普通 transcript row **没有统一的退出动画状态机**：row model 允许中部删除，稳定 id 保持幸存节点和测量；流式 bubble 的 AnimatePresence exit、panel closing ghost 是另外两层生命周期（`src/components/message-list/transcript-rows.ts:23-48`；`src/components/MessageList.tsx:1552-1589`）。统一方案不应顺手发明通用 message-exit。

### 3.5 历史分页

1. `rangeChanged` 距窗口顶不超过 5 个 rendered rows 时触发 `loadOlder`；subagent/workflow 子视图不触发主分页（`src/components/MessageList.tsx:1282-1317`；`src/components/message-list/transcript-rows.ts:731-743`）。
2. Synchronizer 请求 `before=oldestSeq`，一次仅一个请求，成功后 dispatch `WINDOW_PAGE at:'head'`（`src/session-sync/session-synchronizer.ts:631-673`）。
3. 新 rows 与减少后的 `firstItemIndex` 必须在同一 render 提交；偏移按**实际 rendered row 数**而非 seq delta 计算，并同步 rebase visible-top/navigation refs（`src/components/MessageList.tsx:685-736`；`src/components/message-list/transcript-rows.ts:602-728`）。
4. prepend 不是 tail arrival，因此不会 arm `msg-enter`；但如果它恰好发生在 re-show sweep 窗口，当前 re-show 的 DOM 扫描并不区分其来源。这是现有行为，迁移时不能默默改成另一种产品语义（`src/components/message-list/useTranscriptAnimations.ts:130-143`；`src/components/MessageList.tsx:903-949`）。

---

## 4. 耦合点：真正可统一与不可合并的部分

| 耦合 | 当前契约 | 统一含义 |
| --- | --- | --- |
| `transcriptRevealKey` | 同时驱动 keyed scroller remount、initial reveal、re-show cancel、follow reset 和 RO reattach（`src/components/MessageList.tsx:1721-1738`；`src/components/message-list/useTranscriptScroll.ts:822-854,939-944`）。 | 明确定义为 transcript identity hard reset；不要另造等效 key。 |
| `panelVisible` | 同时驱动行级 cascade 和 scroll settle（`src/components/MessageList.tsx:826-837,866-956`）。 | 最适合升级为同一 show epoch；visible reorder 不得增加 epoch。 |
| `PANEL_RESHOW_SETTLE_MS` | scroll suppression 与 App re-assert 共用 750ms，且要求一起调（`src/components/message-list/useTranscriptScroll.ts:179-184`；`src/App.tsx:2891-2898`）。 | 移到中立 transition-contract 模块共享；不是把 App 滚动逻辑搬进 hook。 |
| `msg-enter` | live arrival class 同时是 re-show 的仲裁信号，避免双重动画（`src/components/MessageList.tsx:937-947`）。 | 入场模式应由同一 hook 统一裁决。 |
| `bottomStackHeight` | MessageList 拥有测量，Footer 与 scroll hook 共同消费；streaming leaf 只通过 DOM/RO 耦合（`src/components/MessageList.tsx:971-1111,1644-1676`）。 | 保持几何数据流，不要让动画状态机接管 streaming。 |
| `firstItemIndexRef` / raw `itemCount` | scroll seek 需要 offset-space anchor，append pin 需要 raw item 增长（`src/components/MessageList.tsx:799-837`）。 | scroll 与 row entrance 的输入粒度不同，合并 hook 不会消除差异。 |
| CSS transform 与 scroll geometry | `msg-enter` 故意向上位移，避免底行 transform 暂时扩大 `scrollHeight`（`src/styles/chat.css:2371-2385`）。 | 统一视觉实现时仍须验证几何副作用，不能只替换 class/WAAPI。 |

**结论：** 可统一的是“什么事件发生了、属于哪个 key/epoch、各控制器在此期间允许做什么”。不应统一 FOLLOWING/AWAY 与 reveal/re-show 为一个大布尔状态，也不应把 streaming、history prepend 都变成 panel transition。

### 4.1 Virtuoso 官方约束：为什么需要统一协议，但不能外包恢复语义

仓库声明并锁定 `react-virtuoso` 4.18.6（`package.json:91`；`package-lock.json:12084-12086`）。以下外部结论取自 Virtuoso 当前官方文档和官方仓库 main 的 `31aef22e257211a4f4d59f9b013d1543d732df2a`；它们用于确认 API 契约，不把 main 的实现细节冒充为对 4.18.6 每一行的断言。

1. **`followOutput` 不是持续的同长度内容底部锁。** 官方 API 允许 callback 返回 `'auto' | 'smooth' | false` 自定义跟随；普通 source path 主要由去重后的 `totalCount` 变化触发，尺寸恢复只有特定 watcher/viewport 路径，而不是每次 same-count growth 的持续保证（[API](https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/)；[followOutputSystem.ts L44-L132](https://github.com/petyosi/react-virtuoso/blob/31aef22e257211a4f4d59f9b013d1543d732df2a/packages/react-virtuoso/src/followOutputSystem.ts#L44-L132)）。因此本项目返回 `false`、自驱 rAF 并用 RO/settle verification 覆盖流式几何，是在补足不同契约，不应在统一时误删（`src/components/message-list/useTranscriptScroll.ts:480-536,1593-1616`）。
2. **`initialTopMostItemIndex` 只在 mount 时生效。** 官方初始定位指南明确后续定位应走 `scrollToIndex`（[Initial index](https://virtuoso.dev/react-virtuoso/virtuoso/initial-index)）。`alignToBottom` 处理的是内容短于 viewport 时的底部对齐，不等于持续 append following（[API](https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/)）。所以“re-show 时重新传 initial index”既不能恢复 AWAY，也不是统一模型。
3. **官方 prepend 契约与当前 same-render anchor 一致。** prepend 时应把 `firstItemIndex` 按新增 item 数减少，并随 data 一起更新（[API](https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/)；[官方 prepend example L36-L72](https://github.com/petyosi/react-virtuoso/blob/31aef22e257211a4f4d59f9b013d1543d732df2a/packages/react-virtuoso/examples/prepend-as-you-scroll.tsx#L36-L72)）。当前按 rendered rows 而非原始 seq 计算，是对“item 数”的必要适配，不应被统一滚动逻辑绕过（`src/components/message-list/transcript-rows.ts:611-622`）。
4. **overscan 使 rendered range 不等于像素可见 range。** `increaseViewportBy` 是扩大渲染 viewport 的像素 overscan；`rangeChanged` 来源于渲染 listState，不能据此严格推断用户实际看到的顶行（[API](https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/)；[listStateSystem.ts](https://github.com/petyosi/react-virtuoso/blob/31aef22e257211a4f4d59f9b013d1543d732df2a/packages/react-virtuoso/src/listStateSystem.ts)）。当前 `getVisibleTopIndex` 的几何测量不是多余重复（`src/components/message-list/useTranscriptScroll.ts:219-228,1256-1276`）。
5. **官方支持自动测高，但明确提醒 remount 会重播 height/max-height 入场并造成测量/布局位移；建议入场只动 transform/opacity。** 测高保证不等于视觉位置保证（[Auto-resizing](https://virtuoso.dev/react-virtuoso/virtuoso/auto-resizing/)；[Troubleshooting](https://virtuoso.dev/react-virtuoso/troubleshooting/)）。这直接支持保留当前 transform/opacity 路线，也要求统一时优先测试 wrapper remount 与动画去重。
6. **未找到官方 `display:none` hide/re-show scroll-restoration 保证。** 官方 `useSize` 的 RO callback 在 `offsetParent === null` 时忽略 entry，`Virtuoso.tsx` 没有 panel 恢复契约（[useSize.ts L16-L45](https://github.com/petyosi/react-virtuoso/blob/31aef22e257211a4f4d59f9b013d1543d732df2a/packages/react-virtuoso/src/hooks/useSize.ts#L16-L45)；[Virtuoso.tsx](https://github.com/petyosi/react-virtuoso/blob/31aef22e257211a4f4d59f9b013d1543d732df2a/packages/react-virtuoso/src/Virtuoso.tsx)）。这不是“Virtuoso 必然恢复失败”的证明，而是说明本项目必须继续拥有自己的 App scroll memory 和 re-show settle 语义。

---

## 5. 现有测试覆盖与关键不变量

| 领域 | 已有覆盖 | 主要钉住的不变量 |
| --- | --- | --- |
| initial reveal | `src/components/MessageList.test.tsx:515-730` | ready + 实际 rows 后才 release；late arrival 不继承 snapshot；optimistic 排除；animationend 收缩；empty 解除 pending。 |
| live row entrance | `src/components/MessageList.test.tsx:3244-3512,4935-4957,5296-5316` | live tail 只播一次；增量 burst、前行动画不被截断；optimistic/echo settled；evict/re-append 不重播；draft 不 pop。 |
| follow / seek / 几何补偿 | `src/components/MessageList.test.tsx:1372-3243` | append/spacer/content-growth re-pin；用户手势优先；无手势位移不丢 follow；动画中不掉 follow；动态底部目标。 |
| reveal 与 follow 正交 | `src/components/MessageList.test.tsx:2533-2661` | reveal 中真实 leave 仍生效；真正 key change 才重置 follow；same-key re-fire 保留 AWAY。 |
| keep-alive collapsed geometry | `src/components/MessageList.test.tsx:5051-5185` | hide-flip 的 RO/geometry paths 不写 scrollTop、不翻状态；FOLLOWING show 后去新底部；不覆盖隐藏中真实 append/flush。 |
| history / anchor | `src/components/MessageList.test.tsx:926-1030,4991-5048`；`src/components/message-list/transcript-rows.test.ts:400-660,888-1009` | prepend 后 pinned identity 稳定；loadOlder guard；offset 按 rendered rows 移动；head-group re-key 等边界。 |
| streaming render isolation | `src/components/streaming-render-isolation.test.tsx:171-360` | Chat / MessageList / SessionMessageList 在 flush 中 0 renders，叶子承担更新。 |
| panel cache primitives | `src/utils/panel-cache.test.ts:13-92`；`src/components/PanelSlot.test.tsx:11-37` | LRU、render order、ghost、collapsed 不取快照、hidden 不卸载。 |
| 真浏览器几何 | `tests/browser/README.md:1-24`；`playwright.config.ts:1-21` | 已有 production MessageList + real Chromium/Virtuoso 的独立 fixture 机制，当前聚焦 bottom-card exit。 |

### 明显缺口

1. 检索 `src/**/*.test.{ts,tsx}` 未见 `panelVisible`、`crwReplay`、`enteringReplay` 或 `PANEL_RESHOW_SETTLE_MS` 的直接测试。现有 “same-key group-switch” 测试只重复同 key rerender，并没有走真实 false→true（`src/components/MessageList.test.tsx:2613-2661`）。
2. MessageList 的 Virtuoso mock 直接渲染全部 rows，用手写几何和少量回调模拟库行为；它不会重现真实 re-show 的 row remount、内部 range restoration 或 visibility 时序（`src/components/MessageList.test.tsx:26-178`）。因此现有 green tests 不能证明 320/500/750ms 三个窗口协调正确。
3. `tests/browser` 没有 re-show、row cascade、scroll memory 或 panel entering-replay 用例；目前只有 bottom-card 与 keyframe 相关 specs。仓库已有适合补此缺口的真浏览器基础设施（`tests/browser/README.md:3-23`）。
4. 未见 rapid hide→show、re-show 中 streaming/loadOlder、reduced-motion re-show、wrapper replacement dedup、用户手势提前结束 750ms suppression 的端到端覆盖。

### 已复现并独立修复的 dedup 偏差

re-show 注释声称用 message id 跨 wrapper replacement 去重（`src/components/MessageList.tsx:839-843,911-918`），但原实现读取的是 `w.querySelector('[data-message-id]')`，而 `data-message-id={item.id}` 写在同一个 `w`（`.virtuoso-item-wrapper`）上（`src/components/MessageList.tsx:1530-1537`）。

WHATWG 对 `querySelector` 的定义是返回匹配的 **descendant**，不包含 receiver 自身（https://dom.spec.whatwg.org/#interface-parentnode ）。真浏览器回归测试在第一次 re-show WAAPI 后替换同一消息 wrapper，未修复代码对 `fixture-message-22` 创建两次动画；改为直接读取 `w.getAttribute('data-message-id')` 后同一断言通过（`tests/browser/panel-reshow.spec.ts`；`tests/browser/fixtures/panel-reshow.ts`）。该修复独立于统一模型迁移。

re-show cleanup 只取消 rAF，没有保存/取消已经创建的 WAAPI `Animation`（`src/components/MessageList.tsx:937-955`）。rapid re-hide 是否允许旧、新动画重叠，需要先定义并表征，不能由统一模型偶然决定。

---

## 6. 推荐模型：一个事件契约，两个正交控制器

### 6.1 App 拥有的 transition contract

建议概念模型（不是要求新增框架或全局 store）：

```text
PanelTransition {
  transcriptKey
  visibility: visible | hidden
  showEpoch       // 同一 mounted panel 每次真实 hidden→visible +1
  origin          // fresh | keep-alive-reshow | standalone
}
```

- App 已知道 cache 命中与 fresh mount，因而是 `origin/showEpoch` 的正确所有者（`src/App.tsx:2971-3001`）。
- `showEpoch` 只在同一 mounted panel 的真实 re-show 增加；visible reorder 不增加，transcript key change/unmount 走 hard reset。
- `PANEL_RESHOW_SETTLE_MS` 移到中立模块，由 App 与 scroll hook 共用。视觉 320ms、扫描 500ms、几何 750ms 仍是不同 deadline；**统一 epoch 不等于强行统一为一个 timer**。

若不想先改 App props，可用 `panelVisible` 作为兼容输入，在 MessageList 内派生 epoch；但那只能统一两个 hook，不能让 App panel CSS 共享同一事件，因此是次优过渡态。

### 6.2 Entrance controller：扩展 `useTranscriptAnimations`

逻辑状态机：

```text
fresh/key change → initial pending → initial reveal → settled
settled + live tail arrival → independent one-shot row entrance
visible → hidden → visible (same key, new showEpoch) → re-show sweep → settled
key change / unmount → cancel old work and hard reset
```

三种模式共用：

- transcript identity、show epoch、取消与清理；
- row id / seen-id bookkeeping；
- optimistic 排除、live `msg-enter` 优先、reduced-motion 策略；
- `messagesElRef` 和 row wrapper 契约。

三种模式保留不同 gate：initial reveal 等待 first-ready 当前 rows；live arrival 看 tail delta + recency；re-show 看实际 hide 后的可见 DOM rows。**不能直接把 re-show 塞进 initial reveal 的单次 snapshot**：当前 re-show 故意在 500ms 内多帧扫描，以适应 wrapper settle/replacement（`src/components/MessageList.tsx:902-951`）。

迁移首步应保留现有 rAF/WAAPI 策略，仅改变所有权；是否进一步改成 container-class declarative mode 应另起行为验证，不与搬迁捆绑。

### 6.3 Scroll controller：保留 `useTranscriptScroll`

现有 FOLLOWING / AWAY / ANIMATING 继续是独立状态轴；hidden 和 re-show-settling 是几何 guard，不应与视觉 entrance 合并：

- FOLLOWING 的底部不变量与 AWAY 的用户所有权不变（`src/components/message-list/useTranscriptScroll.ts:11-32`）。
- spacer-aware at-bottom 与 true-bottom 必须继续是两个指标：前者用于状态，后者用于 user-leave/re-arm（`src/components/message-list/useTranscriptScroll.ts:115-174,731-757`）。
- re-show epoch 只重置机械 suppression 的起点；真实用户手势仍能提前退出，视觉动画是否结束不影响这个判断（`src/components/message-list/useTranscriptScroll.ts:338-351`）。
- App 继续通过 `data-following` 决定旧 offset 是否适用；不要改成动画状态推断滚动状态。

### 6.4 为什么不是合并 hook

1. **所有权无法闭合：** pre-commit App scroll memory 仍在组件外（`src/App.tsx:2819-2828`）。
2. **状态轴正交：** reveal/re-show 可以播放时用户仍能 leave；测试明确要求 reveal 不锁 follow（`src/components/MessageList.test.tsx:2533-2573`）。
3. **输入和 effect 生命周期不同：** raw item append、row entrance、bottom-stack RO、scroller listeners 各有依赖；当前代码刻意避免 spacer 每帧变化重绑监听器（`src/components/message-list/useTranscriptScroll.ts:1530-1555`）。合并容易意外扩大 effect/render 范围。
4. **流式隔离是产品级约束：** 任何统一层若把 flush 或视觉状态传播到 MessageList/Chat，都可能违反 0-render 测试（`src/components/streaming-render-isolation.test.tsx:171-298`）。

---

## 7. 备选方案

### 备选 A（低风险过渡）：只搬 re-show，不引入 App epoch

把 `MessageList.tsx:839-956` 基本原样迁到 `useTranscriptAnimations`，传入 `panelVisible`；把 settle constant 移到中立模块。App、scroll hook、Virtuoso props 全部不动。

- 优点：消除最明确的“第二套入场系统”，改动面最小。
- 缺点：App panel CSS、MessageList re-show、scroll lastShow 仍各自识别转场；统一的是代码归属，不是完整时序契约。

### 备选 B（不推荐）：`useTranscriptPresentation` 合并动画与滚动

一个 hook 同时返回 reveal、entrance、following、scroll writers。

- 看似只有一个状态机，实际需要表达 FOLLOWING×AWAY×HIDDEN×RESHOW×REVEAL×STREAMING 的组合，语义更隐晦。
- 无法吸收 App pre-commit snapshot，仍会留下跨层协议；同时增加 effect 重绑和 streaming render 回归面。
- 只有在完整表征测试和更小 seam 都稳定后才有讨论价值，不作为本次推荐目标。

---

## 8. 建议迁移步骤（原始方案；实测后的执行顺序见第 10 节）

1. **先补表征，不改行为。** 用现有 Playwright 真浏览器模式挂载 production MessageList + real Virtuoso，记录 hide/show 每帧 `scrollTop`、wrapper identity、`getAnimations()`、`data-following` 和 spacer。现有 browser harness 不需要后端 session/model（`tests/browser/README.md:3-13`）。
2. **单独处理 dedup 偏差。** 先复现 wrapper replacement 是否重复播放，再决定“修复 intended id dedup”是否作为独立行为变更落地；不要把修复藏在统一重构里。
3. **提取纯 transition contract。** 中立定义 key/visibility/epoch 和 shared constant；先保持 `panelVisible` 适配，确保 visible reorder 不被分类为 re-show。
4. **原样搬迁 re-show。** 保留 500ms scan、id/element 两层去重、optimistic/msg-enter 仲裁、reduced-motion 和 cleanup 时序；MessageList 只负责渲染和传参。
5. **让 scroll 消费同一 epoch。** 保持 FOLLOWING/AWAY/ANIMATING 与所有几何写入不变；只替换 show 事件来源。App scroll memory 仍在原位置。
6. **可选引入 App `showEpoch`。** 在同一次 render-phase cache 分类中生成，供 `.entering-replay`、entrance hook、scroll hook 共用； standalone callers 保持原默认行为。
7. **最后才考虑 declarative container-class。** 单独比较首帧、wrapper replacement、动画取消和 scroll overflow；不与步骤 4 同提交。
8. **全程不修改：** row model、`firstItemIndex` 算法、SessionSynchronizer、streaming leaf subscriptions、Virtuoso followOutput 自有驱动策略。

---

## 9. 风险与回归测试清单

### 最高风险

1. **把 scroll memory 下移导致 AWAY offset 丢失。** 必须保留 App render-phase snapshot + layout restore；测试应在真实 keyed DOM move/hide 下验证，而非只调用 hook（`src/App.tsx:2819-2828,3002-3008`）。
2. **750ms 窗口或用户取消语义改变，AWAY 被重新贴底。** 同时覆盖 App re-assert 与 scroll re-arm；二者共享时长但取消路径不同（`src/App.tsx:2891-2938`；`src/components/message-list/useTranscriptScroll.ts:338-351`）。
3. **jsdom 通过但真实 Virtuoso 回归。** 现有 mock 不重建虚拟 window（`src/components/MessageList.test.tsx:63-178`）；真实浏览器测试是必要条件，不是可选补充。

### 必测矩阵

- fresh mount、same-key re-show、key change、LRU eviction 后重开、visible reorder。
- AWAY 空闲 hide/show：旧 offset 恢复；机械 at-bottom events 不 re-latch；show 后用户向下滚到 true bottom 可提前恢复 follow。
- FOLLOWING 流式 hide/show：逐帧记录隐藏中 append/flush 的实际 writer 行为，show 后必须到新底部且旧 memory 不参与；若要把“隐藏全路径零写入”提升为新 invariant，应作为独立行为变更换测试。
- re-show cascade：每个预期 row 一次、wrapper replacement 同 id 不重复、无 id 的 element 策略、optimistic 不播、live `msg-enter` 不双播、reduced motion 不播视觉但几何恢复仍工作。
- rapid hide→show / re-hide：rAF、已有 WAAPI、App CSS class、re-assert loop 都按定义取消或重启，无旧 epoch 写入新 epoch。
- re-show 期间 live append 与 history prepend：row anchor 同提交、无错误 `msg-enter`、re-show 仲裁符合已表征语义。
- initial reveal 与 re-show 不叠加；reveal pending 中真实用户 leave 不被锁（现有 `src/components/MessageList.test.tsx:2533-2573`）。
- streaming overlay exit 与 bottom-card exit：spacer 逐帧跟踪，无底部跳动；Chat/MessageList 仍 0 renders per flush。
- seek/jump 与 re-show 交叉：用户手势中断 seek/re-assert，不能出现多个 scroll writer 拔河。
- CSS transform 对 `scrollHeight` 的影响：首个/尾部 row entrance 不产生瞬时 phantom scrollbar（`src/styles/chat.css:2371-2385`）。

## 10. 真浏览器实测与修正后的迁移顺序

新增 `tests/browser/panel-reshow.spec.ts` 和 `tests/browser/fixtures/panel-reshow.ts`，使用 production MessageList、真实 Virtuoso 和 Chromium，逐帧记录 panel opacity、CSS animation currentTime、row WAAPI 创建、wrapper identity、scrollTop 与 `data-following`。320ms panel class 由 fixture host 施加，因此这里验证的是 production CSS 与 MessageList/scroll contract；App 的 `openIds` 分类和 App 自己的 re-assert 仍需集成表征，不能由该 fixture 冒充覆盖。

### 10.1 三个窗口的实际含义

- **320ms：** `panel-enter-replay` 的计算时长为 320ms；采样帧在 animation currentTime 10–90ms 内 opacity 为 0，结束后恢复为 1，透明 hold 与 CSS 契约一致。
- **500ms：** 多次运行中，row WAAPI 创建集中在 show 后约 14.7–17ms，后续可见尾行在约 113.2–143.6ms 创建；duration 为 240ms，spatial delay 为 0–260ms，没有越出 500ms sweep deadline。持续制造新 message id 的场景确认 425ms 后仍会创建动画、deadline 后的 probe 不再创建。源码虽有“两次 empty passes 提前退出”的注释和计数器，但非终止空扫后立即把计数重置为 0，因此该 early exit 实际不会触发，现有产品行为是扫描到 500ms；本次搬迁保留这一行为，不在所有权迁移中启用提前退出。
- **750ms：** 在 gesture intent 已过期后进入 AWAY→hide→show，在约 100/300/500/700ms 多次强制到 true bottom 都不会于 750ms 内 re-arm；约 825ms 的窗口后滚动才恢复 FOLLOWING。750ms 是机械 re-arm suppression，不是到点自动 setFollowing(true) 的定时器。

### 10.2 rapid-gesture 的独立 RED→GREEN

最初未等待隐藏前 wheel 的 1200ms intent 有效期时，诊断日志显示：show 后的机械向上位移进入 scroll handler 的 gesture-chaining 分支（`src/components/message-list/useTranscriptScroll.ts:1317-1325`），把 `userScrollIntentRef` 续期到 `lastShowAtRef` 之后；`justReshowed()` 因而提前返回 false（同文件 `343-350`），随后 true-bottom scroll 恢复 FOLLOWING。

新增 rapid 测试在未修复代码上稳定于约 120ms 观察到提前 re-arm；另一个 FOLLOWING + pre-show downward wheel 场景证明 stale intent 也能直接通过 `isUserLeave` 把机械位移误判为用户离开。最终将 `!justReshowed()` 上移到 `userDriven` 计算，同时覆盖 gesture chaining 与 leave 判定；rapid、FOLLOWING 和既有机械 suppression 用例均通过。控制测试同时证明：show 后的真实 wheel、向底部 touch drag 和 End key 都会直接更新 intent，仍可在 750ms 内恢复 FOLLOWING；downward keys（PageDown / ArrowDown / End / Space）只补 intent，不改变 upward leave 路径。实现上 `userScrollIntentRef` 只拥有 upward leave/chaining；向下手势只递增单调 `userGestureSeqRef` 并清除旧 upward intent，避免向下手势让窗口外的机械向上位移误判为 user leave。programmatic seek 的 `userTookOver()` 与 re-show suppression 都读取这个输入序号，因此同一毫秒内的新手势也能与旧手势区分。横向 wheel（deltaY=0）、同 Y touchmove 和嵌套 scroller touch 也有反向控制，不会误退出 transcript suppression。该修复独立于后续统一 epoch。

### 10.3 id dedup 的 RED→GREEN

- **RED：** 第一次 re-show 动画后确定性替换同 id wrapper；未修复代码对 `fixture-message-22` 创建两次 WAAPI，断言“同 id 仅一次”失败。
- **修复：** 将后代查询改为读取 wrapper 自身的 `data-message-id`。
- **GREEN：** 同一真浏览器用例通过；加入 rapid/fresh/horizontal/downward/nested/mixed gesture 后，完整 15 个 panel-reshow specs 全部通过，另有向下 wheel 取消 programmatic seek 的 Vitest 覆盖。

### 10.4 修正后的迁移顺序

1. **已完成：** 建立真浏览器帧日志基线，独立修复 id dedup。
2. **已完成：** rapid-gesture 独立 RED→GREEN；旧手势不能跨 show 被机械位移续期，真实 post-show 手势保留提前恢复 follow 的语义。
3. **已完成：** 真实 App 集成表征覆盖 `openIds` 分类、keyed DOM move/hide、App scroll memory、750ms re-assert、原生 wheel 取消和 visible reorder；fake provider 只替换 subprocess 边界，不替换 App/Hono/WS/SessionManager/Virtuoso。
4. **已完成：** re-show 已原样迁入 `useTranscriptAnimations`，保留 500ms 扫描、WAAPI 数值和 id dedup；同时以独立测试明确 initial reveal 仲裁、hidden key change、rapid re-hide 取消与 rejection drain。共享 showEpoch 是下一步，尚未提前合入。
5. **已完成：** App 在现有 fresh/cache 分类点生成并传递 `showEpoch`，动画和 scroll 共用事件来源；reduced-motion 也递增，visible reorder 不增加，prune 清除旧 epoch，跨 epoch 重置 id/element dedup。FOLLOWING/AWAY、手势归因、App scroll memory 和几何写入未改。
6. **最后单独评估 declarative container-class。** 不与所有权搬迁或滚动行为变更混合。

## 11. 真实 App 集成表征

新增 `playwright.app.config.ts` 与 `tests/browser/app-panel-reshow.spec.ts`，使用真实 App、`createServerContext`、Hono REST/WS、SessionManager 和 Virtuoso。`app-panel-state-server.mjs` 以生产 `SessionStore`、`TranscriptSidecar`、`UiStateStore` 写入四个合法 UUID dormant sessions，并让 A/B 同组以覆盖 group-centric 多 panel；仅 provider 进程边界替换为返回 `system/init` 的 fake handle，不启动模型子进程。

三项表征在未搬迁代码上通过：

1. cached AWAY re-show 出现 `.entering-replay`，750ms settle 后仍恢复旧 offset 且 `data-following=false`。
2. 原生 `page.mouse.wheel` 后，post-gesture 帧序列不再回到 remembered offset，证明 App re-assert 被取消而非末帧偶然一致。
3. A/B 可见 panel 拖拽互换恢复 offset，但不出现 `.entering-replay`，因此 restore pass 与 re-show 是不同事件。

默认 `playwright.config.ts` 显式忽略该 spec，避免在未启动 App fixture 的 5175/3456 端口上误跑；App suite 使用独立的 5186/3467。

## 12. Entrance ownership 搬迁完成

`UseTranscriptAnimationsOptions` 新增 `panelVisible`，MessageList 不再持有独立的 `rowReplayRef` 和第二套 sweep。`useTranscriptAnimations` 现在统一拥有 initial reveal、live row entrance 与 keep-alive re-show，滚动控制器保持独立。

搬迁后的生命周期有 5 个专门 Vitest 场景：initial reveal active/pending 时保留 hide 标记并延后 cascade、hidden key change 仍记录 hide、re-hide 取消已创建 WAAPI、cancel 前 drain `ready/finished`。真浏览器另有 rapid re-hide 的 `unhandledrejection` 检查；原 16 个 panel-reshow 场景和 3 个真实 App 表征保持通过。

原注释中的 two-empty-pass early exit 已删除而非启用：它实际不可达，且启用会破坏 late wrapper/持续 churn 覆盖。现在注释明确扫描覆盖完整 500ms settle window，行为与搬迁前一致。最终验证：17 个 panel-reshow、188 个 MessageList/streaming 单测、3 个真实 App 测试通过，代码审查无未解决发现。

## 13. 共享 showEpoch 完成

`src/components/panel-transition.ts` 现在提供 `PanelShowOrigin`、`nextPanelShowEpoch` 和共享 `PANEL_RESHOW_SETTLE_MS = 750`。App 在原有 openIds render-phase 分类中维护 per-panel epoch：fresh 为 1，cache re-show 恰好 +1，prune 时删除；visible reorder 不产生新 epoch。标量经 ChatPanel → Chat → SessionMessageList → MessageList 传递，没有新增 store 或 streaming subscription。

`useTranscriptAnimations` 用 epoch 证明 re-show，并在 epoch 变化时取消旧工作、清 animatedIds 与 wrapper `crwReplay`，所以即使快速切换跳过 hidden commit，新一轮 cascade 也不会被上一轮 dedup 吞掉。`useTranscriptScroll` 用 epoch 重置 `lastShowAtRef`，但 mount 仍保留初始 suppression；standalone caller 省略 epoch 时沿用 false→true。

真实 App 测试现覆盖 fresh=1、re-show=2、reorder=1，以及 reduced-motion 下 epoch=2 且无 `.entering-replay`。另有直接 showEpoch=1→2→3 无 hidden commit 的 dedup 重置单测。最终验证：190 个相关单测、17 个 panel-reshow、4 个真实 App 测试通过；全量 8082 个单测与 25 个默认浏览器测试也通过，代码审查无未解决发现。

## 14. container-class 评估结论：保留 rAF/WAAPI

本次不把 re-show 改成 declarative container-class。initial reveal 的 snapshot 模式适合“当前 key 第一次 ready”，但 re-show 已验证依赖不同的契约：完整 500ms 多帧扫描、late wrapper/持续 churn、id/element 两层去重、跨 epoch 重置，以及 rapid re-hide 的 rAF/WAAPI 取消与 rejection drain。改成单次 class snapshot 要么丢失 late wrapper，要么仍需保留同样的扫描和生命周期控制，不会带来更简单的模型。

因此最终视觉实现保留现有 rAF/WAAPI；统一工作已经完成在事件契约和所有权层，而不是 CSS 写法层。后续若要做 container-class，应作为独立视觉重写，先用新的真浏览器证据证明首帧、wrapper replacement、取消、reduced motion 和 scroll overflow 都等价，不与本轮架构迁移混合。

## 15. 最终集成与审查修复

App scroll memory 由绝对 `scrollTop` 改为稳定 message id + 行内偏移：hidden 期间发生 history prepend 后，恢复目标按锚定行的当前 content-top 重算，不再恢复到过时的像素位置。750ms re-assert 按 panel 独立取消；真实 wheel、滚动键、overlay track 和中键接管当前 panel，不影响同组另一 panel。普通点击、Tab、横向/Ctrl+wheel 不取消恢复。取消监听与 listener cleanup 分离，真实浏览器同时断言 `pageerror` 为空，覆盖此前相互递归被末帧几何断言掩盖的问题。

滚动控制器进一步统一了方向与导航生命周期：向下 wheel/touch/thumb/middle 都清除 user-message 导航游标；thumb 以实际 scrollTop 而不是 pointer delta 归因，中键自动滚动相对按下原点判断方向，支持 pointerup 后继续滚动，并在 Escape、再次中键或普通 pointerdown 时终止归因。App 与 hook 共用 wheel/touch/keyboard 的 native-scroll ownership，App-owned 快捷键在 microtask 中按最终 defaultPrevented 分类。panel hide/showEpoch 改变会取消旧 seek，MessageList 同时清除已中止目标的导航游标；新的 programmatic seek 会清理旧 thumb/focus 状态。新增回归覆盖同毫秒手势、隐藏后重新导航、off-center thumb、released middle-button、Escape、nested scroller 和非滚动输入。

Scroll memory 的锚恢复不使用 scrollHeight 猜测：id 未挂载时由 MessageList 以真实 row id→Virtuoso index 定位，draft alias 与 optimisticSourceId 作为确定的身份映射。`ackUserMessage`、WS echo、MESSAGE_CONSUMED 和 replay replacement 都保留该 source id，因此 optimistic→ack 的动画 suppression 与锚恢复不依赖内容或 DOM 序号。快照几何按 panel transform 比例归一化，只选择真实与 viewport 相交的行。

最终架构仍是一个 show epoch、两个正交控制器；这些修复不改变 320/500/750ms 三个窗口，也不引入 declarative container-class。

## 最终判断

统一模型已经落地为 **同一个 panel/transcript 转场协议下的 entrance 统一 + scroll 独立**。rapid-gesture、App re-assert、entrance ownership 和共享 showEpoch 均已完成；FOLLOWING/AWAY、手势归因、App scroll memory、streaming 隔离和几何写入保持原契约。container-class 评估也已完成：保留现有 rAF/WAAPI，不在本轮做视觉重写。
