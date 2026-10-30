# SessionSynchronizer 重构设计：同步独立、ChatStream 退役、订阅下放

- 日期：2026-10-29
- 状态：待用户审批
- 范围：`src/hooks/useChatStream.ts`、主 Chat、Side Chat、会话态 transcript 消费者及相关测试

## 1. Intent / Why

`useChatStream` 当前把四种职责装进一个 31 字段的宽泛接口：

1. 约二十个 SessionStore 字段订阅；
2. WS frame 路由；
3. REST tail、断线补偿、generation/epoch 校验与 hole repair；
4. 乐观发送、历史分页和若干 store 操作。

结果是同步协议、React 渲染和 transcript 数据消费互相耦合。任何使用 hook 的宿主都订阅整组状态，未使用字段的变化也可能触发宿主渲染；修改同步协议又必须穿过一个包含大量 UI 数据的 hook。

本次重构的目标不是换一个状态库，而是让三个现有职责各自拥有清晰接口：

- `SessionSynchronizer` 拥有 WS/REST 同步生命周期；
- SessionStore commands 拥有用户发起的 transcript 操作；
- selectors 拥有渲染数据读取。

**用户已决定的范围：**

- 不只是物理搬迁同步代码，要同时收缩接口；
- `ChatStream` 宽泛接口最终直接删除，不作为永久兼容层；
- 允许把 store 订阅下放到实际使用数据的子组件。

## 2. Goals

1. 建立一个不依赖 React 渲染的 `SessionSynchronizer`，统一拥有：
   - per-session WS listener 与 force subscribe/release；
   - REST tail page；
   - attached reconnect catch-up；
   - generation floor、clear epoch 和全部 page validation；
   - gap-fill 与 `loadOlder`；
   - session-cleared 处理；
   - terminated 后的延迟 sweep。
2. 所有 transcript page 请求继续经过同一套 stale-page 校验，不能形成第二套同步实现。
3. `ChatStream` interface 与 `useChatStream` 最终删除；主 Chat 和 Side Chat 不再通过聚合对象读取会话状态。
4. 会话数据通过窄 selectors 在实际消费者处读取；显示叶子不得各自建立 WS 订阅。
5. 保留受控 `MessageList`，继续服务子代理、磁盘 transcript 和测试；新增会话态适配层承接 SessionStore 数据。
6. 保持 Side Chat 折叠时同步不中断，保持主面板 keep-alive 隐藏时同步不中断。
7. 迁移完成后不存在名为 `ChatStream` 的兼容别名或同形替代接口。

## 3. Non-goals

- 不改变 UI、交互、WS 协议、REST 协议或 SDK 行为。
- 不引入 Redux、Zustand 或另一份 transcript cache。
- 不重写 reducer，不合并 `items/messages/window`，不改变 seq/tombstone/replay 语义。
- 不改变现有 streaming telemetry 叶子订阅，不让 `streamingContent/tokenRate/activePhase/thinkingTokens` 回到 Chat 根订阅。
- 不把静态或 scratch-store transcript 强制改成主会话数据源。
- 不顺带拆分整个 reducer、App 或 MessageList 的其他职责。
- 不大规模清理 SessionSnapshot；本次只移除旧 ChatStream 迁移中确认无用的订阅和接口。

## 4. Anti-goals / 失败即错

- 任何一个 MessageList、WorkingBubble、Composer 等显示组件自行调用 `hub.subscribe`。
- SessionSynchronizer 内再复制一份 messages/items，或另建 transcript 真相源。
- 拆完后 Chat 仍通过一个新对象订阅原来的全部字段；这会被视为换名而非完成重构。
- Side Chat collapse、主面板 display:none、搜索/overlay 开关导致 WS 生命周期重启或 transcript 重拉。
- `loadOlder` 绕开 generation/epoch 校验，或与 tail/gap-fill 使用不同的 stale-page 规则。
- 为了保留受控 MessageList 测试而让生产会话同时走 props 和 SessionStore 两份数据。
- 最终仍保留 `ChatStream` 作为永久 facade。

## 5. 目标架构

```text
                    WsHub（单连接，不变）
                           │
                SessionSynchronizer
                ├─ WS frame routing
                ├─ tail / attached / gap-fill
                ├─ generation + clear-epoch validation
                ├─ loadOlder + paging snapshot
                └─ terminated sweep
                           │ dispatch
                           ▼
                    SessionStore（唯一 transcript owner）
                           │
             ┌─────────────┼──────────────┐
             │             │              │
      narrow selectors  commands     paging snapshot
             │             │              │
       实际渲染消费者   发送/清除等操作   OlderHistoryFloat / MessageList

受控 MessageList ◀── 子代理、磁盘 transcript、测试（保持现状）
SessionMessageList ── 从 SessionStore 订阅后渲染受控 MessageList
```

### 5.1 所有权规则

- 每个挂载中的主 Chat 拥有一个主会话 synchronizer。
- ChatPanel 在 Side Chat 存在期间拥有其 synchronizer；**不能因为 SideChatDrawer collapse/unmount 而停止它**。
- React adapter 负责 retain/release SessionStore；synchronizer 不建立第二个全局 registry。
- 子组件只订阅 SessionStore 或 synchronizer 的窄 paging snapshot，不拥有 WS 生命周期。
- 空 `sessionId` 的 Side Chat 路径保持 inert：不 subscribe、不 fetch、不 retain。

## 6. 模块与接口设计

以下为本次设计选择的实现形状，实施时保持接口窄小，不再扩展成通用状态框架。

### 6.1 `src/session-sync/session-synchronizer.ts`

一个不 import React 的类或等价闭包模块。构造时注入现有 store、hub、REST GET 和 sessionId，便于通过同一接口测试。

```ts
interface SessionSyncHandlers {
  onRequest(permission: PermissionRequest): void
  onResolved(permission: PermissionResolved): void
  onCleared?(): void
  onElicitationRequest?(request: ElicitationRequestUi): void
  onElicitationResolved?(resolved: ElicitationResolved): void
  onDialogRequest?(request: UserDialogRequestUi): void
  onDialogResolved?(resolved: DialogResolved): void
  onEditPrompt?(text: string): void
}

interface TranscriptPagingSnapshot {
  loadingOlder: boolean
  olderError: string | null
}

interface SessionSynchronizer {
  start(): void
  stop(): void
  setHandlers(handlers: SessionSyncHandlers): void
  setTerminated(terminated: boolean): void
  loadOlder(): Promise<number>
  getPagingSnapshot(): TranscriptPagingSnapshot
  subscribePaging(listener: () => void): () => void
}
```

实现要求：

- `start` 包含当前 open path 的完整顺序：重置本运行实例的 generation/epoch/gap 状态、注册 listener、force subscribe、并发 tail fetch。
- 保留当前 `running` 变化会重跑订阅 effect 的行为；React adapter 以 `running` 为 start/stop effect 依赖。**不得擅自把 `running=false` 改成不订阅。**
- `setHandlers` 只更新最新 handlers，不重建 WS 订阅，替代当前 `permsRef`。
- `setTerminated(true)` 后，只有 store 的 `replayReady` 为 true 才 dispatch `SESSION_TERMINATED`；若尚未 ready，通过 store subscription 等待，stop 时取消。
- 每次 `start` 建立新的 run token，并重置 paging 为 `{ loadingOlder: false, olderError: null }`；`stop` 使当前 run token 失效。`running` 变化造成同 session 重启时，旧 run 的 loadOlder 不得清除、覆盖或触发新 run 的 paging 状态。
- `stop` 取消 listener/release，并使 tail、gap-fill、loadOlder 的迟到结果不再更新 paging 通知或 dispatch 页面；store 的 stale-page 防护仍按现有规则执行。
- `fetchValidatedPage` 是私有共享实现，tail、attached、gap-fill、loadOlder 全部调用它。
- `loadingOlder/olderError` 留在 synchronizer 的 paging snapshot，不加入 SessionStore reducer。paging snapshot 仅在值变化时更换引用。
- `hasOlder/oldestSeq` 仍由 SessionStore window 提供，不复制进 paging snapshot。

### 6.2 `src/session-sync/useSessionSynchronizer.ts`

React adapter 只做生命周期和 paging 订阅：

- 按 `sessionId/store/hub` 创建 synchronizer；
- 转发最新 handlers；
- retain/release store；
- 按 session/running 启动和停止；
- 同步 terminated；
- 用 `useSyncExternalStore` 暴露 `{ paging, loadOlder }`。

它不返回 items、messages、tool maps 或其他 transcript 数据。

### 6.3 `src/session-sync/useSessionStreamError.ts`

保留当前 `store.error + hubStatus` 的组合规则：

- reconnecting 时显示/保留 `Stream reconnecting…`；
- online 后清除 reconnecting 文案；
- 其他 error 原样显示。

只在实际渲染错误 banner 的 Chat/SideChatDrawer 使用，不回到聚合 stream 对象。

### 6.4 `src/session-store/commands.ts`

把当前稳定的 store 操作从 React hook 中移出：

- `insertUserMessage`
- `ackUserMessage`
- `rollbackUserMessage`
- `clearError`
- `dismissSubagent`

可以提供很小的 `useSessionCommands(sessionId)` React adapter，保证回调在会话内引用稳定。UI 不直接拼 reducer action，也不获得整个 SessionStore。

`ChatStream.reset` 删除，不迁移；`tasks` 与 `permissionDecisions` 不再由根 hook 订阅。SessionSnapshot 的其他字段是否退役不在本次范围。

## 7. 订阅下放与组件形状

“下放”指窄 SessionStore selectors，不是每个字段都必须新建组件。Chat 在实现搜索、overlay stack 等自身职责时仍可订阅它实际需要的单个字段，但不得重新聚合成旧 ChatStream。

### 7.1 会话态 MessageList 适配层

新增 `SessionMessageList`：

- 订阅 `items`、`replayReady`、`planStatus`、`planContent`、`questionAnswers`、`toolStatus`、`toolResults`、`oldestSeq`、`hasOlder`；
- 由 `replayReady` 派生 `transcriptSettling`；
- 接收 synchronizer 的窄 paging controls；
- 将数据和其余现有 props 交给受控 `MessageList`。

主 Chat 与 SideChatDrawer 使用 `SessionMessageList`。子代理、Workflow、磁盘 transcript 和静态测试继续直接给受控 `MessageList` 传数据，避免双数据源。

### 7.2 其他字段的目的地

| 字段/职责 | 目标消费者 |
|---|---|
| `activeSubagents`、`apiRetry` | WorkingBubble 的会话态适配层；Side Chat waiting 计算使用自己的窄 selector |
| `contextUsage` | ContextOrb、SettingsPanel 等实际展示者 |
| `promptSuggestion` | Composer 或其建议按钮叶子 |
| `subagentIndex/workflowIndex/skillIndex` | 实际 overlay controller；若 Chat 继续持有 overlay stack，则在 Chat 使用独立窄 selectors |
| `messages` 用于导出、auto-title、queued count | 事件发生时读取 store snapshot，或使用返回 primitive 的派生 selector；避免仅为回调读取而订阅整个 messages 数组 |
| `items` 用于搜索/pending jump | Chat 的搜索职责可保留窄 items selector；transcript 展示由 SessionMessageList 自己订阅 |
| `hasActivePhase` | 现有 `selectHasActivePhase`，只在 turn-status 消费者处订阅 |
| `insert/ack/rollback/clearError/dismiss` | SessionStore commands |
| `loadingOlder/olderError/loadOlder` | synchronizer paging interface |

不追求“Chat 对 durable message 零渲染”这一额外目标；本次必须保证的是不再有宽泛接口，以及现有 streaming flush 隔离不回退。

### 7.3 Side Chat

ChatPanel 保留 Side Chat synchronizer 和 permission channel，因为 collapse 时 drawer 会卸载。SideChatDrawer 不再接收 `stream: ChatStream`，改为：

- 使用 `SessionMessageList`；
- 使用窄 selectors 计算 waiting、items length 和 error；
- 使用 SessionStore commands 发送；
- 接收 ChatPanel 传来的窄 paging controls。

ChatPanel 不再订阅 Side Chat 的 transcript 字段。

## 8. 类型归位

- 将 `ContextUsage` 从 `useChatStream.ts` 移到 `src/types/context-usage.ts`，更新所有 import。
- `WorkingBubble` 的 `ActivePhase` 直接从 `session-store/types` 引入。
- 删除 `ChatStream`、`useChatStream` 及其 re-export，不保留别名。
- 这一步同时消除 `session-store/types.ts → hooks/useChatStream.ts` 的类型依赖，不改变运行时行为。

## 9. 迁移顺序

每个阶段独立运行相关测试；允许中间存在短期兼容 adapter，但最终阶段必须删除。

1. **类型与 commands 归位**：移动 ContextUsage，提取 SessionStore commands，删除明确的 reset/无用根订阅。
2. **引入 SessionSynchronizer**：原样移动 WS/REST/generation/gap/termination 逻辑和 paging；旧 useChatStream 可暂时只作为迁移 adapter。
3. **迁移协议测试**：将 reconnect、乱序、hole、clear race、loadOlder race 等测试移到 synchronizer 接口，确认行为等价后再改消费者。
4. **主 Chat 迁移**：引入 SessionMessageList、窄 selectors、paging 和 commands，移除主 Chat 对聚合 stream 的依赖。
5. **Side Chat 迁移**：ChatPanel 只保留 synchronizer，drawer 使用会话态组件和窄接口。
6. **删除旧接口**：删除 useChatStream/ChatStream、残余 props、无用订阅和过期测试；全仓搜索确认无引用。
7. **最终验证**：typecheck、lint、完整 vitest、build，以及主会话/Side Chat 的手动同步冒烟。

## 10. 测试策略

### 10.1 Synchronizer 行为测试

以现有 `useChatStream.test.ts` 和 `useChatStream.seq.test.ts` 的用例为行为清单，通过注入 fake hub/REST 和真实 SessionStore 测试同一接口：

- tail page + force subscribe 的并发打开路径；
- attached 同 generation 的 gap catch-up；
- generation bump 后整窗重置和 tail refetch；
- live 乱序、parked frame、hole fill、tombstone drain；
- session-cleared 的 epoch/floor 双重 stale-page 防护；
- pre-clear tail/head page 不复活；
- loadOlder 的 in-flight、hasOlder、错误重试和 stop/session-switch 防护；
- `running` 在 loadOlder 途中变化：stop/start 后旧 run 返回 0，不 dispatch 页面、不影响新 run 的 loading/error；新 run 可独立发起翻页；
- terminated 等 replayReady 后 sweep；
- handlers 更新不重建订阅；
- running 变化保持当前重订阅语义；
- stop 后无迟到 paging 通知。

### 10.2 Commands 与 selectors

- optimistic insert/ack/rollback 的现有语义；
- prompt suggestion 清除；
- clearError/dismissSubagent；
- paging snapshot 引用稳定，仅在值变化时通知。

### 10.3 组件与渲染护栏

- SessionMessageList 正确传入 store 数据；受控 MessageList 的现有测试不依赖主会话 store。
- 主 Chat 和 SideChatDrawer 不再出现 ChatStream/stream 聚合 props。
- Side Chat collapse/expand 不重新 subscribe、不重新 tail fetch。
- 保持 `streaming-render-isolation.test.tsx` 中 Chat/MessageList 每 flush 0 renders 的钉子。
- 增加针对迁移后根组件的订阅测试，证明 `tasks` 等未使用 snapshot 不再触发 Chat/ChatPanel 渲染。
- ContextOrb、Composer、WorkingBubble 等现有组件测试改为窄接口，不断言旧聚合 props。

### 10.4 手动冒烟

- 主会话首次打开、向上翻页、断线重连、/clear、terminated session；
- Side Chat 打开、发送、collapse/expand、真正关闭；
- 子代理和磁盘 transcript 仍能渲染，未接入错误的会话数据；
- streaming overlay/inline 两种模式均无额外整面板刷新。

## 11. 完成定义

- `ChatStream` 和 `useChatStream` 在全仓无引用、无兼容别名。
- WS/REST 同步只有 SessionSynchronizer 一个实现，所有 page 请求共享 stale-page 校验。
- Chat/ChatPanel/SideChatDrawer 不再订阅或传递聚合 transcript 状态。
- 受控 MessageList 的静态/scratch-store 用法保持有效。
- Side Chat collapse 与主面板 keep-alive 的同步生命周期不变。
- 现有 seq/replay/scroll/streaming 测试及完整验证命令通过。
