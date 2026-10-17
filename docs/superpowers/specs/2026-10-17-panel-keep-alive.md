# Panel Keep-Alive 设计依据（调研结论）

> 2026-10-17 会话调研产出。实施计划见 `../plans/2026-10-17-panel-keep-alive.md`。

## 问题

切换 session 后切回，滚动条位置丢失（回落到底部）。根因：切换 = `setOpenIds` 替换 → `PanelSlot key={s.id}` 变化 → 整棵 Chat 子树卸载；滚动位置是易失组件状态，无持久层；remount 时 `initialTopMostItemIndex` 硬编码为最后一行。

## 方案选择

**keep-alive（选定）**：离开 open 视图的面板不卸载，改为同容器内 `display:none` 隐藏。
放弃"状态外置"（store 存 scrollTop）：恢复时序竞态多（须等 replay 落地 + 行高测完），保留范围窄（仅位置），切换仍有 replay 闪烁。

## 关键实测证据（本机 Chromium + 运行中的 app）

1. **合成 DOM**：`display:none` 祖先隐藏期间 `scrollTop` 读作 0，恢复后浏览器自动还原。
2. **真实 app / AWAY 面板（空闲会话）**：隐藏 400ms → 恢复，`scrollTop` 6242 精确还原、Virtuoso 渲染窗口 41 行原样、`data-following="false"` 不变。**这就是 bug 场景的完整保活证明。**
3. **真实 app / FOLLOWING 面板（流式中）**：隐藏期间 0×0 几何被滚动 hook 读作"在底部"，恢复后被贴底——对贴底面板语义正确，但属模式演算的巧合。
4. React 19.2.5 的 `<Activity mode="hidden">` 会卸载 effects（杀掉 WS 订阅），不符合"数据层保持热"的目标，不采用。

## 设计决策

| 决策 | 内容 |
|---|---|
| 隐藏方式 | 同一 grid 容器内 `display:none`（CSS Grid auto-placement 跳过，可见面板轨道不受影响；key 不变 → React 状态永不销毁） |
| 缓存策略 | App 层 LRU state；cap = `maxOpen + 3`（桌面峰 6 / 移动峰 4 份面板）；render-phase 同步（React adjust-state-on-change 模式，本库已有先例） |
| 显式驱逐 | X 关闭、组关闭、`swapSession`（/clear、fork、discard 的 X→Y）、`teardownRemovedSession`（session 删除） |
| 进入动画 | 缓存命中再显示时抑制 `.entering`（瞬时切换是目的）；全新挂载保留 |
| 滚动 hook | `clientHeight === 0`（塌陷）时 `syncBottomGeometry` 直返 + 收缩兜底跳过——把"隐藏"从巧合固化为契约 |
| 既有机制适配 | closing-ghost 仅对"离开缓存"的面板播；`snapshotPanelScrolls` 只快照/恢复可见滚动器 |
| 数据层 | 面板保持挂载 ⇒ `useChatStream` 订阅与 store retain 存活 ⇒ 切换零 replay、零 `refetchTail`（性能净收益） |

## 内存成本

每个缓存面板 ≈ 一个 3-up 非聚焦面板（Virtuoso ~40 行 DOM + hook 状态 + store retain，绕过 5 分钟 TTL）。cap 是唯一成本旋钮。
