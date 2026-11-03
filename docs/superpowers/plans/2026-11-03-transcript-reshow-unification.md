# Transcript Re-show Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏 keep-alive 滚动恢复、follow 语义和流式渲染隔离的前提下，统一 re-show 入场生命周期与 panel/transcript 转场事件契约。

**Architecture:** 先独立修复 rapid-gesture，再以真实 App 浏览器测试表征 scroll memory；随后把 MessageList 的 re-show sweep 原样迁入 `useTranscriptAnimations`。最终由 App 产生 `showEpoch`，动画与滚动两个正交控制器共同消费；App 继续持有 pre-commit scroll memory，不合并不相关的状态轴。

**Tech Stack:** React 19、TypeScript、react-virtuoso 4.18.6、WAAPI/CSSAnimation、Vitest、Playwright/Chromium。

**Spec:** `docs/transcript-reshow-unified-model-research.md`（尤其第 10.4 节）。

## Global Constraints

- 每个行为变更先写失败测试并确认 RED，再做最小修复；不把滚动修复、搬迁和视觉重写捆在一起。
- App 的 render-phase scroll snapshot 与 layout-effect restore/re-assert 必须留在 App。
- `useTranscriptScroll` 的 FOLLOWING / AWAY / ANIMATING 状态轴保持独立；真实新手势仍须能提前结束 750ms suppression。
- 保持 streaming flush 期间 Chat / MessageList / SessionMessageList 0 renders，以及 `firstItemIndex` 与 prepend 的同提交锚定。
- 不修改或回退其他会话留在工作区的诊断日志、`older-prepend` 文件或其他未跟踪内容；审查时明确本次路径范围。
- 不提交、不推送；每个任务完成后运行相关测试并审查该任务 diff。

## Review Focus

- re-show 后真实新 wheel/touch/key：必须立即结束 suppression，不能被 rapid-gesture 修复一并屏蔽（Task 1 控制测试）。
- AWAY re-assert 中用户接管 viewport：必须取消 App 的旧 offset 写入（Task 2 真 App 测试）。
- 可见 panel reorder：可以恢复滚动，但不得增加 `showEpoch` 或播放 re-show cascade（Tasks 2、4）。
- rapid hide→show / re-hide：旧 epoch 的 rAF/WAAPI 不得写入新 epoch；reduced motion 不播视觉但仍恢复几何（Tasks 3、4 测试）。
- 流式更新与历史 prepend：不得因统一事件层引入父级重渲染或错误的 `msg-enter`（Tasks 3、4 既有测试）。

---

### Task 1: Rapid-gesture 独立修复

**Files:**
- Modify: `tests/browser/fixtures/panel-reshow.ts`
- Modify: `tests/browser/panel-reshow.spec.ts`
- Modify: `src/components/message-list/useTranscriptScroll.ts:1317-1325`
- Modify: `docs/transcript-reshow-unified-model-research.md`

**Interfaces:**
- Consumes: 现有 `PanelReshowFixtureApi`、`justReshowed()` 和 1200ms `USER_SCROLL_INTENT_MS`。
- Produces: `PanelReshowFixtureApi.measureRapidGesture(): Promise<ReshowMeasurement>`；不改变生产 hook 的公开签名。

- [ ] **Step 1: 写 rapid-gesture 失败测试和真实新手势控制测试**

新增 fixture 路径：隐藏前 wheel 后不等待 1300ms 即 hide→show；仍在约 100/300/500/700/825ms 探测 true bottom。测试断言 750ms 前不 re-arm、窗口后可 re-arm。另一个控制场景在 show 后主动 wheel 向下，断言真实新手势仍可在 750ms 内恢复 FOLLOWING。

- [ ] **Step 2: 确认 rapid 测试 RED、控制测试 GREEN**

Run: `npx playwright test tests/browser/panel-reshow.spec.ts -g "rapid|fresh gesture"`
Expected: rapid 用例在 750ms 前观察到 `following === true`；控制用例通过。

- [ ] **Step 3: 最小修复 gesture chaining**

在 scroll handler 的 upward chaining 写入 `userScrollIntentRef` 前增加 `!justReshowed()`：show 前的旧 intent 不得被机械向上位移跨 show 续期；show 后的真实手势已由 gesture listener 直接更新时间，因此其后续 chaining 不受阻。不得修改 1200ms、750ms 或 follow 几何判定。

- [ ] **Step 4: 验证并审查独立修复**

Run: `npx playwright test tests/browser/panel-reshow.spec.ts`
Expected: 全部通过。检查 diff 仅包含 gesture-chain guard、测试和文档，然后运行 `code-review`。

### Task 2: 真实 App 的 openIds 与 scroll-memory 表征

**Files:**
- Create: `playwright.app.config.ts`
- Create: `tests/browser/app-panel-reshow.spec.ts`
- Create: `tests/browser/fixtures/app-panel-state-server.mjs`
- Modify: `package.json`（新增 `test:browser:app`）
- Modify: `tests/browser/README.md`

**Interfaces:**
- Consumes: `SessionStore.load()/upsert()/flush()`、`TranscriptSidecar.appendRow({ seq, uuid, msg })/close()`，以及真实 App 的 `[data-panel-id]`、`.chat-virtuoso-scroller` 和 `.entering-replay`。
- Produces: 真实 App 的 keep-alive re-show、visible reorder 和用户取消 re-assert 回归测试；不抽取 App 生产逻辑。

- [ ] **Step 1: 建立无模型子进程的 dormant-session fixture**

用生产 `SessionStore` 与 `TranscriptSidecar` 在临时 state dir 写入两个含可滚动历史的 dormant sessions；启动真实 Hono 服务和 Vite。测试不得发送消息或恢复 provider session，只通过真实 UI 打开、切换和 reorder panels。

- [ ] **Step 2: 写 App 表征测试**

覆盖：cached AWAY re-show 恢复旧 offset 且 `.entering-replay` 出现；750ms settle 中 Virtuoso 漂移不丢 offset；wheel/touch 后旧 offset re-assert 立即取消；visible reorder 保留 offset 但不出现 `.entering-replay`。逐帧附加 `scrollTop`、`data-following`、panel class 与 wrapper identity。

- [ ] **Step 3: 在未搬迁代码上确认测试有效**

Run: `npm run test:browser:app`
Expected: 全部通过；若失败，先用帧日志区分 fixture 时序与产品根因，不在本任务顺手修统一模型。

- [ ] **Step 4: 审查 App 测试真实性**

确认测试驱动真实 App/Hono/WS 和真实 Virtuoso，不是复刻 scroll memory；运行 `code-review` 后才允许进入搬迁。

### Task 3: 将 re-show 原样迁入 `useTranscriptAnimations`

**Files:**
- Modify: `src/components/message-list/useTranscriptAnimations.ts`
- Modify: `src/components/MessageList.tsx:839-956`
- Test: `tests/browser/panel-reshow.spec.ts`
- Test: `src/components/MessageList.test.tsx`

**Interfaces:**
- Consumes: `panelVisible?: boolean`、现有 `messagesElRef` 和 `transcriptRevealKey`。
- Produces: `UseTranscriptAnimationsOptions.panelVisible?: boolean`；`TranscriptAnimationsApi` 不新增滚动状态。

- [ ] **Step 1: 增加 ownership 边界测试**

在现有 re-show suite 中断言 initial reveal、live `msg-enter` 与 re-show 不叠加，rapid re-hide 不留下旧 sweep 写入；保留 500ms churn cutoff、wrapper id dedup、optimistic 和 reduced-motion 覆盖。

- [ ] **Step 2: 原样搬迁实现**

把 `rowReplayRef`、false→true 判定、500ms rAF sweep、id/element 两层去重、WAAPI 参数与 cleanup 移入 `useTranscriptAnimations`；MessageList 只传 `panelVisible`。不得同时改成 container-class，不改变动画数值或滚动代码。

- [ ] **Step 3: 验证搬迁**

Run: `npx playwright test tests/browser/panel-reshow.spec.ts`、`npx vitest run src/components/MessageList.test.tsx src/components/streaming-render-isolation.test.tsx`、`npm run test:browser:app`
Expected: 全部通过，streaming 父级 0-render 断言不变。

- [ ] **Step 4: 审查并更新调研状态**

Run: `code-review`
Expected: 无未解决的正确性问题；文档仅记录搬迁已完成，不把后续 showEpoch 提前写成事实。

### Task 4: App 共享 `showEpoch` 与中立转场契约

**Files:**
- Create: `src/components/panel-transition.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/components/Chat.tsx`
- Modify: `src/components/SessionMessageList.tsx`
- Modify: `src/components/MessageList.tsx`
- Modify: `src/components/message-list/useTranscriptAnimations.ts`
- Modify: `src/components/message-list/useTranscriptScroll.ts`
- Test: `tests/browser/app-panel-reshow.spec.ts`、`tests/browser/panel-reshow.spec.ts`

**Interfaces:**
- Produces: `type PanelShowOrigin = 'fresh' | 'keep-alive-reshow' | 'standalone'`、`showEpoch?: number`，以及从中立模块导出的 `PANEL_RESHOW_SETTLE_MS = 750`。
- Consumes: App 已有 fresh/cache 分类；动画与 scroll hook 仍同时接收 `panelVisible` 用于 hidden guard。

- [ ] **Step 1: 写 epoch 语义测试**

同一 mounted cached panel 每次真实 hidden→visible 恰好 +1；fresh mount 初始化；visible reorder 不增加；key change/unmount 不沿用旧 epoch。standalone caller 省略 epoch 时保留现有 false→true 行为。

- [ ] **Step 2: 在 App 现有分类点生成并传递 epoch**

在 `prevOpenIdsRef.current !== openIds` 的同一 render-phase 分类中维护 per-panel epoch；不得把 render-phase scroll snapshot 移走。沿 ChatPanel → Chat → SessionMessageList → MessageList 传递标量，不引入 store 或 streaming subscription。

- [ ] **Step 3: 两个控制器消费同一事件来源**

re-show entrance 与 `lastShowAtRef` 改用 epoch 触发；`panelVisible` 继续承担 collapsed geometry guard。App CSS 分类和共享 750ms constant 来自同一转场契约，但 320/500/750ms deadline 不合并。

- [ ] **Step 4: 全量验证与审查**

Run: `npm run typecheck`、`npm test`、`npm run test:browser`、`npm run test:browser:app`
Expected: 全部通过；运行完整 diff 的 `code-review`，修复确认问题后复审。

### Task 5: 单独评估 declarative container-class，并完成迁移记录

**Files:**
- Modify: `docs/transcript-reshow-unified-model-research.md`
- Optional Modify: `src/components/message-list/useTranscriptAnimations.ts`（仅当前置证据支持且另行 RED→GREEN）

**Interfaces:**
- Consumes: Tasks 1–4 的真实帧日志与回归矩阵。
- Produces: 明确的“保留 rAF/WAAPI”或“可单独迁移 container-class”结论；默认不在本任务改视觉实现。

- [ ] **Step 1: 对照首帧、wrapper replacement、取消和 scroll overflow 证据**

确认 container-class 能否保持 500ms 多帧扫描、id/element 去重、rapid re-hide 取消、reduced motion 和无 phantom scrollbar；证据不足则保留现有 WAAPI。

- [ ] **Step 2: 记录最终架构与剩余边界**

更新调研文档为实际完成状态：rapid-gesture、App 表征、entrance ownership、showEpoch、未覆盖项和后续建议。不得把可选 container-class 写成已完成。

- [ ] **Step 3: 最终验证与完整审查**

Run: `npm run typecheck`、`npm run lint`、`npm test`、`npm run test:browser`、`npm run test:browser:app`
Expected: 命令成功；lint 仅报告已确认的非本次 warnings。完整 diff 经 `code-review`，无未解决发现；不提交。
