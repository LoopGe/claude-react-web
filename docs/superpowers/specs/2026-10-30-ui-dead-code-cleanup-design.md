# 剩余无效 UI、死代码与过期注释清理设计

- 日期：2026-10-30
- 状态：待用户审批
- 范围：客户端 UI、未使用导出/类型/函数，以及仍把已删除模块描述为当前依赖的注释

## 1. Intent / Why

前两批分别完成 SessionSynchronizer 和 SessionStore/旧 cursor 清理后，客户端仍有一组独立的小型无效代码：

- 只维护却从未渲染的 Side Chat unread 数字链路；
- 已被新组件替代的旧组件、不可达 variant 和未读取 ref；
- 只被 lazy loader 的 named export 使用的冗余 default export、未使用图标；
- 前一批新确认的 `cacheDroppedMedia` 和 `isDiskStableMsg`；
- 仍把已删除 `useChatStream` 描述为当前模块或当前调用方的注释。

本次目标是减少无效表面和误导性文档，不改变任何用户可见行为。

## 2. 删除清单

### 2.1 无效 UI 与冗余状态

| 候选 | 当前证据 | 处理 |
|---|---|---|
| Side Chat unread 链路 | `App.tsx` 维护 `initialMessageCount` 并计算 `sideChatUnread`；`ChatPanel.tsx` 仅将其改名为 `_sideChatUnread`，从未读取 | 删除 state 字段、初始化、collapse/expand 维护、prop 类型/解构和计算；保留 `sideChatWorking` 折叠工作态提示 |
| `stableSettingsTabRequest` | state 本身引用稳定；memo 仅在 state 变化时重建并裁掉 `sessionId`，但下游 memo 比较和 `tab`/`nonce` 读取不依赖这次裁剪 | 删除 memo，直接传完整 `settingsTabRequest`；保留外层 sessionId 过滤和 nonce 深链行为 |
| `ThemeToggle.tsx` | 无 import/JSX/dynamic import/test；`AppearancePanel.tsx` 明确已取代它 | 删除文件 |
| Overlay `subagent` / `workflow` variants | `Overlay.tsx` 自己标记 unused，无任何调用方 | 删除两个 map 条目和对应注释；保留手写 overlay 及 compositing 说明 |
| `bottomOverlayRef` | `MessageList.tsx` 只声明并挂到 DOM，没有读取 | 删除 ref 和 JSX 绑定 |

### 2.2 未使用导出与死类型/函数

| 候选 | 当前证据 | 处理 |
|---|---|---|
| `ResetConfigDialog` default export | lazy loader 使用 named export；default export 无引用 | 删除 default export，保留 named component |
| `InputHistoryPanel` default export | 同上 | 删除 default export，保留 named component |
| `IconLink`、`IconBug`、`IconBugOff`、`IconDollar`、`IconWrench` | 只有声明，无源码引用 | 删除五个导出函数；不改变其他图标 |
| `SdkMessage.cacheDroppedMedia` | 类型注释已确认没有 stamp/read；前一批只删了 snapshot gate | 删除字段及 legacy 注释 |
| `isDiskStableMsg` | `isCursorAnchorable` 删除后没有函数调用方，只剩 `normalize.ts`、`reducer.ts` 和 `reducer.test.ts` 的注释引用 | 删除函数，并重写 `isTrimBoundary` 的独立语义注释，同时清理 reducer/test 中的过期引用 |

### 2.3 过期注释

只更新**会把已删除模块写成当前依赖、当前调用方或当前文件**的注释，保留有价值的历史迁移说明。

优先处理：

- `src/session-store/selectors.ts`：仍称 `useChatStream.ts` “still active”。
- `src/components/SessionMessageList.test.tsx`：同类 still-active 描述。
- `src/session-sync/session-synchronizer.ts`：仍称 `PermissionHandlers` 位于已删除文件。
- `src/hooks/useSessionCommands.ts`：错误描述 SessionSynchronizer 与 commands 的关系。
- `src/hooks/useWsHub.ts`：把当前 per-session consumer 写成 `useChatStream`。
- `src/App.tsx`：把当前 listener owner 写成 `useChatStream`。
- `src/hooks/usePermissionChannel.ts`、`useElicitationChannel.ts`、`useUserDialogChannel.ts`：把当前 frame switch 写成 `useChatStream`。
- `src/components/PanelSlot.tsx`、`SessionErrorCard.tsx`：把当前订阅生命周期写成 `useChatStream`。
- `src/session-store/types.ts`、`normalize.ts`：把当前 paging/dismiss 路径写成 `useChatStream`。
- `src/session-sync/useSessionSynchronizer.ts`、`useSessionStreamError.ts`：在不增加价值的情况下引用已删除模块描述当前行为，改为直接说明 synchronizer/error projection 契约。
- `src/hooks/useGitStatus.ts`、`useReadFile.ts`：把当前实现模式错误归属到已删除 hook。

`types/context-usage.ts`、新 SessionSynchronizer 测试中的“ported from useChatStream”以及 `Chat.tsx` 中“no longer uses”属于合理历史说明，可保留或仅在不改变含义时精简，不做全仓字样清洗。

## 3. Goals

1. 删除全部已验证无生产行为的 UI、导出、类型和函数。
2. Side Chat collapse/expand、settings tab 深链、Overlay、MessageList 底部区域行为不变。
3. 注释准确描述当前模块和当前所有权，不复活已删除概念。
4. 每批可独立审查和验证，不与其他重构混合。

## 4. Non-goals

- 不改变 Side Chat 的折叠工作态提示、permission、transcript 或同步行为。
- 不合并 Overlay/TranscriptDrawer 组件，不做 CSS 重构。
- 不删除 `isTrimBoundary`、实际使用的 icon、named component export 或历史设计文档。
- 不清理 `useChatStream` 的历史提交、计划文档或有价值的历史注释。

## 5. 分批实施

### Batch A：无效 UI

1. 删除 Side Chat unread 整条链路。
2. 删除 settings request 的冗余 memo。
3. 删除 ThemeToggle、两个 Overlay variants、bottomOverlayRef。
4. 运行 Side Chat、Settings、Overlay、MessageList 相关测试。

### Batch B：未使用导出与死类型/函数

1. 删除两个冗余 default exports 和五个 icons。
2. 删除 `cacheDroppedMedia` 和 `isDiskStableMsg`。
3. 更新对应类型/trim 注释。
4. 运行 lazy dialog、icons、typecheck 和 session-store 相关测试。

### Batch C：过期注释

1. 按 §2.3 更新当前所有权和当前调用方注释。
2. 搜索 `useChatStream` / `ChatStream`，逐项确认剩余为历史说明而非当前依赖。
3. 运行 typecheck、项目源码 lint、客户端测试和 build。

## 6. 测试策略

- Side Chat：collapse/expand 仍只保留 synchronizer 和 working 提示，不出现 unread 数字。
- Settings：settings tab nonce 和 sessionId 深链仍打开正确面板和 tab。
- Overlay：现有 settings/git/tasks/palette/lightbox variants 类型和渲染不变；SubagentOverlay/WorkflowOverlay 手写路径不变。
- MessageList：bottom overlay 的内容、portal 和高度测量不变。
- Lazy dialogs：ResetConfigDialog、InputHistoryPanel 仍能以 named export 动态加载。
- SessionStore：trim/replay 测试继续通过，证明 `isDiskStableMsg` 无隐藏消费者。
- 最终：`npm run typecheck`、`npx eslint` 项目源码、`npx vitest run src`、`npm run build`、`npm test`（区分已知基线问题）。

## 7. 完成定义

- 本设计列出的 UI、导出、类型和函数全部删除，无兼容 alias。
- `useChatStream` 不再被注释描述为当前模块、当前调用方或当前生命周期 owner。
- Side Chat、Settings、Overlay、MessageList 和 lazy dialog 行为测试通过。
- 没有为了精简而改变实际 UI 或协议行为。
