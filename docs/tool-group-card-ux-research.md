# Research: 折叠 tool-group 卡片头部的 UI 设计调研与优化方案

**Date:** 2026-09-09
**Scope:** research + design proposal (initial), **direction A 已定并实现**（`git diff HEAD` 未提交）。状态边线强化暂缓。

---

## Summary / 结论先行

`ToolGroupCard`（连续 tool-only 助理消息自动聚合成一张可折叠卡片）的折叠态头部当前由 **7 个 DOM 元素** 拼成一行：

```
[▸chevron] [◫layers] [3计数章] "tool calls"  Read×2 · Grep · Edit  ──spacer──  [running|waiting|failed]
```

调研（对照 ui-ux-pro-max 的 `ux` 域指引）发现 **4 类问题**，其中最主要的是**信息重复 + 可访问性缺口**：

- **冗余**：`[3]` 计数章与紧随的 `"tool calls"` 重复表达同一数量；一行 36px 里 7 个元素，2 个在说同一件事。
- **可扫描性**：最有价值的工具概要（`Read×2 · Grep · Edit`）被排到末尾，占 C 位的是低信息的计数。
- **a11y**：`role="button"` 无 `aria-label`；计数章 `aria-hidden` 导致读屏**丢失数量**；无 `aria-controls`；概要截断仅靠 `title` 悬浮（键盘/触碰不可达）。
- **状态锚点**：`failed/waiting` 左侧 accent 边在深色下偏弱，折叠态缺统一异常锚点。

**推荐方案 A**（改动小、保留现有 pill 词汇、只消冗余 + 补 a11y）：

```
[▸] [3]  Read×2 · Grep · Edit   [failed]
```

删冗余量词、让概要做主角、把数量并入可访问名。纯展示层改动，**不触碰**任何折叠状态机逻辑（2200ms settle 宽限、搜索强制展开、运行中/待决强制打开、wasLive 参与判定）。

---

## 1. 现状概述

### 1.1 组件与折叠逻辑

- 容器组件：`ToolGroupCard` — `src/components/message-list/ToolGroupCard.tsx`（196 行，整体）。
- 数据来源：`summarizeToolGroup` — `src/components/message-list/tool-grouping.ts:26-73`。产出 `count` / `nameSummary`（`Read×2 · Grep · Edit`，去重+首见序）/ `anyRunning` / `anyError` / `anyPendingInteractive`。
- 折叠判定（输入侧）：`transcript-rows.ts` 的 `isToolGroupEligible`（~162 行）+ `foldToolGroupRows`（~187 行）；AskUserQuestion 与 thinking 是 run 边界。
- 打开判定（`ToolGroupCard.tsx:98-108`）——**这些内在逻辑本次不修改**：

  ```
  open = hasSearchHit || live || (wasLive && turnActive) || settleHold || (userOpen ?? false)
  ```

- 动画：`AnimatedCollapse`（`AnimatedCollapse.tsx`），`unmountOnExit={false}` 保嵌套卡状态；内部已尊重 `prefers-reduced-motion`。

### 1.2 折叠态头部 DOM / CSS

折叠态（`data-state="closed"`）header 为 `div[role=button][tabindex=0][aria-expanded]`（`ToolGroupCard.tsx:139-151`），CSS：

- 容器 `tool-group-card`：`border:1px solid var(--border)`，`border-radius:var(--radius-sm)`，`bg-elev`。
- 头部 `tool-group-summary-inner`（`utilities.css:914-925`）：`flex; gap:7px; padding:6px 10px; min-height:36px; bg-elev-2; fg-muted`。
- 计数章 `tool-group-count`（`utilities.css:950-965`）：`min-width:20px; height:20px; border-radius:var(--radius-pill); color-mix(accent 14%); color:accent; mono 11px; weight 600`。
- 概要 `tool-group-names`（`utilities.css:974-983`）：`min-width:0; ellipsis; nowrap; mono 12px; fg-muted`，`title={nameSummary}` 悬浮提示。
- 状态左侧边（`utilities.css:1003-1008`）：`tool-group-has-error` → `border-left:3px solid var(--danger)`；`tool-group-has-pending` → `var(--accent)`。

### 1.3 状态徽章（折叠态仍可见）

`badge`（`ToolGroupCard.tsx:110-128`）按优先级取一：
`running`（`IconLoader`+文字）→ `waiting`（`IconMessageQuestion`+文字）→ `failed`（`IconAlertCircle`+文字）→ 无。目的是**绝不隐藏运行中/阻塞/失败的回合**。

---

## 2. 调研方法论

- 工具：ui-ux-pro-max skill，`--domain ux` 检索 `collapsible accordion summary header` 与 `grouped list density summary badge`。
- 命中且适用的指引：
  - **Contextual Live Badge Updates（a11y/H）**：计数类状态变化应播报有上下文的一句话（如 "3 items"），不播裸数字；避免把每个 badge 都变成竞争的 live region。
  - **Compact Label Overflow（Content/H）**：紧凑标签尽量整体一行（nowrap + 可收缩 label 的 min-width:0），**避免 hover-only 悬浮提示**作为唯一截断补救。
  - 通用 a11y 基线（priority 1）：`role="button"` 需有可访问名；屏幕阅读器要能获取被折叠内容的数量与展开关系（`aria-controls`）。
- 产品画像：**桌面/浏览器端开发者工具**（dark-first，密度较高，mono 语言）；栈 = React 19 + Vite + 原生 CSS（`src/styles/*.css`），无 Tailwind/shadcn。
- 未命中专用匹配的领域（如「工具卡聚合折叠」）未找到数据库条目，以下为基于上述命中项 + 本仓库现有视觉词汇（pill / mono / `fg-muted` / accent-tint）推导，作为 fallback 提出。

---

## 3. 发现的 UI 问题

### 3.1 信息重复（冗余）— 主要问题

`[N]` 计数章（mono accent pill）与紧随其后的 `"tool calls"` 量词文本**重复表达同一数量**。一行 36px、7 个 flex 子元素中，两个元素在说同一件事；而它们夹在概要之前，稀释了扫读重点。按「视觉层级应当单一主体」原则，数量只应通过单一通道表达。

### 3.2 可扫描信息被边缘化

`nameSummary`（工具概要，最有用的一眼信息）排在**尾部**、属 `fg-muted` 纯 mono，且 `overflow:hidden+ellipsis`（`utilities.css:974-983`）。当组内工具多时大概率被截断，而头部最强的视觉锚点（accent pill）恰恰是低价值的计数。信息密度与视觉权重**倒挂**。

### 3.3 可访问性缺口（对照 §2 命中项）

1. `role="button"` 缺 `aria-label`：读屏输出会是 "tool calls tool calls Read Grep Edit button" —— 无上下文、重复、（因 `[N]` 章 `aria-hidden`）**完全听不到数量**。
2. `aria-expanded` 有，但**无 `aria-controls`** 指向内容体，展开的是哪个区域对 AT 是隐式的。
3. 概要截断只靠 `title`（hover-only）：键盘 / 触碰用户无法取得完整工具清单 —— 命中 **Compact Label Overflow** 反模式。

### 3.4 状态锚点偏弱

`failed`（`var(--danger)`）与 `waiting`（`var(--accent)`）仅用 3px 左边线表达，在深色 `bg-elev` 上对比有限，且与数字章同为 `accent` 系时两处易混淆。好在「边线 + 文字徽章」双通道优于单靠颜色 ✅；这里主要是视觉强度问题，非信息缺失。

---

## 4. 优化方案

### 方案 A（推荐）— 去重 + 概要做主角

**折叠态 header：**

```
[▸] [3]  Read×2 · Grep · Edit        [failed]
```

- 删除冗余的 `"tool calls"` 量词（layers 图标 + 计数章已隐含「工具」语义）。
- `gap` 与间距重排：计数章后接概要（概要成为首可扫描信息、靠左），藏进一个可收缩/ellipsis 的 flex 单元。
- 概要行保留 `title`（可选：键盘聚焦时用 `aria-label` 提供完整清单）。

**a11y 补强（两方案共用）：**

- `role="button"` 加 `aria-label`，eg `\`${count} tool call(s): ${nameSummary}\`` —— 数量进入可访问名，读屏不再丢数量。
- 加 `aria-controls={bodyId}` 指向 `AnimatedCollapse` 内容体；给 body div 补 `id`。
- （可选）`aria-describedby` 指向状态徽章，使「running/waiting/failed」也进可访问上下文。

**视觉微调：**

- 状态边线从 `border-left: 3px` 提升为可选 `box-shadow` 左缘或加重色，折叠加 `anyError/anyPending` 时给徽章行补充一个 `accent` 背景后缀（仅视觉，不改徽章文字）。
- 保持 36px 行高、`gap:7px`、现有 pill 词汇，不引入新设计语言。

### 方案 B（备选）— 合成一句话

```
[▸]  3 tool calls — Read×2 · Grep · Edit   [failed]
```

- 计数并入自然语言 run，无独立 pill；DOM 元素降到 5 个（去掉 pill + 量词）。
- **代价**：失去 accent pill 的视觉锚点，行内仅剩 chevron 一个图标性元素，折叠态视觉更平。
- 适用场景：若后续希望进一步压低「折叠 = 静音」的呈现优先级。

### 不做 / 排除

- **保活逻辑全改**：`open` 判定、2200ms settle、搜索强制展开、mid-turn 不折叠（`wasLive && turnActive`）、`unmountOnExit={false}` —— 均属已判定的交互契约，非视觉问题，不动。
- **持久化折叠偏好**：仓库当前完全无折叠 localStorage；引入全局偏好会与「由 live 状态推导」的设计意图冲突，本调研不推荐（可在验收阶段复议）。

---

## 5. 决策与后续

- **已决定 & 已实现（2026-09-09）：方案 A。** 理由：改动面最小、保留现有 pill 词汇，只消冗余并补齐 a11y。
  - 改动文件：`ToolGroupCard.tsx`（去 icon+量词、加 `aria-label`/`aria-controls`/`title`、body 用 `useId`）、`AnimatedCollapse.tsx`（新增可选 `id` 透传到 content box）、`utilities.css`（移除 `.tool-group-icon`/`.tool-group-label`）、`ToolGroupCard.test.tsx`（+2 断言）。
  - 测试：`ToolGroupCard.test.tsx` 11 项全绿；`AnimatedCollapse.test.tsx` + `message-list/` 共 63 项全绿；typecheck（两 config）通过。
- **暂缓投入**：§4 的「状态边线强化 / 徽章 accent 后缀」未纳入首轮，可作后续增量。
- **验收口径一并确认**：a) 折叠态读屏能报「N 个工具调用以及清单」✅（`aria-label`）；b) 无回归：运行中/搜索强制展开、settled 自动收拢、状态徽章与 left-accent 仍在 ✅；c) 视觉自查无 light/dark 主题色破口（颜色一律走 `var(--…)`）——本轮涉及颜色全部复用既有变量。
- **验收口径**：a) 折叠态读屏能报「N 个工具调用以及清单」；b) 无回归：运行中/搜索强制展开、settled 自动收拢、状态徽章与 left-accent 仍在；c) 视觉自查无 light/dark 主题色破口（颜色一律走 `var(--…)`）。

---

## 附录：相关文件索引

| 关注点 | 文件 : 行 |
|---|---|
| 折叠容器组件 | `src/components/message-list/ToolGroupCard.tsx`（196 行整体） |
| 概要/搜索纯函数 | `src/components/message-list/tool-grouping.ts:26-89` |
| 折叠输入侧判定 | `src/components/message-list/transcript-rows.ts:162-211` |
| 折叠引擎 | `src/components/AnimatedCollapse.tsx` |
| 折叠态头部 CSS | `src/styles/utilities.css:904-1008` |
| 子成员渲染 | `src/components/message-list/blocks.tsx` |