# 完整支持 Workflow 工具的渲染方案

## 问题根源（已确认）

现有子 Agent 体系 = `getSubagentStarts()` → `activeSubagents` 索引 → `SubagentCard` → `SubagentOverlay(parentToolUseIdFilter)`，**三处都按工具名硬编码** `{'Agent','Task','Explore'}`，且 `Workflow` 不在其中：

- `src/constants/toolNames.ts:6` `SUBAGENT_TOOL_NAMES`
- `src/session-store/normalize.ts:187` `getSubagentStarts()`
- `src/components/ToolUseBlock.tsx:127` 分发分支

后果：Workflow 的 `tool_use` 落到 `ToolUseBlock.tsx:144` 的"未知工具"兜底分支渲染成一坨原始 JSON；它派生的子 Agent 消息虽然带 `parent_tool_use_id`（= Workflow 的 `tool_use_id`），会被 `MessageList.tsx:398` 的 `parentToolUseIdFilter` 在主流隐藏，**但因为没有任何卡片去 anchor，这些内部消息无处点开、对用户完全不可见**；Workflow 的 phase/group 进度树在 UI 上零呈现。

## 关键事实（决定方案的依据）

1. **Workflow 的进度数据不会作为独立 stream 帧到达**。`updateLiveTurn`（`reducer.ts:1107`）只解析 `content_block_start` 的 thinking/text/tool_use 三态，没有 workflow 帧。到达消息流的是：
   - Workflow 自身的 `tool_use` 块，其 `input` 含 `meta.phases`（声明的阶段）、`script`/`scriptPath`、`args`
   - 它派生的子 Agent（仍是 `Agent`/`Task`/`Explore` 工具调用），带 `parent_tool_use_id` = Workflow 的 `tool_use_id`，且子 Agent 的 `tool_use.input` 里携带 `phase` 字符串（workflow 脚本里 `agent(prompt, {phase:'Review'})` 透传过来）
   - Workflow 的 `tool_result`（汇总各子 Agent 输出）

   → **阶段树必须从这两类数据派生**：声明阶段取 `input.meta.phases`；运行态取子 Agent `tool_use.input.phase` 分组 + 各自状态。

2. **子 Agent 的 tool_use 块可通过 `message.message?.content` 数组访问**（`reducer.ts:1086` 已用此路径数 `toolCount`）。其 `input.phase` 可读。

3. **Overlay 是 per-column 的**（`Chat.tsx:1136`，绝对定位 `inset:0`）。当前 SubagentOverlay 右抽屉 `width: min(50%, 640px)`。双栏（阶段树 + 消息）需要更宽 —— 用 `width: min(92%, 960px)` 并改为整面板覆盖（不再贴右），左栏阶段树 ~240px 固定 + 右栏消息流 flex。

4. **现有 `parentToolUseIdFilter` 复用即可**：Workflow 内部子 Agent 消息已带 `parent_tool_use_id` = workflow id，把它们 anchor 到一个可点击的卡片 + 用同一个 filter 打开 overlay，就能 drill-in。和 Subagent 完全同构。

## 设计决策

### A. Workflow 复用现有子 Agent 渲染管线，而不是另起炉灶

把 `Workflow` 纳入子 Agent 体系是最小且一致的路径：同一套 `activeSubagents` 索引、同一个 `SubagentCard`（加 Workflow 标识）、同一个 overlay + `parentToolUseIdFilter` drill-in。差异点（阶段树、双栏布局）通过**新增字段 + 新增组件**叠加，不改动既有数据流骨架。

### B. Workflow 的 overlay ≠ SubagentOverlay，但共享底盘

- `WorkflowCard`：模仿 `SubagentCard`，但卡片体里嵌入一个**紧凑阶段进度条**（横向 chip 序列：`Scan → Review → Verify`，带完成态），点击卡片打开 overlay。
- `WorkflowOverlay`：双栏。左栏 `WorkflowPhaseTree`（阶段 + 该阶段下的子 Agent 列表，可点跳转）；右栏 `MessageList` 带 `parentToolUseIdFilter=workflowId`（复用现有过滤，内部子 Agent 会作为 `SubagentCard` 再次出现，支持嵌套 drill-down —— 与现有 Subagent 嵌套语义一致）。

### C. 阶段树数据来源

新增一个纯函数 selector `deriveWorkflowPhases(workflowInput, messages, workflowToolUseId)`：
- 声明阶段：从 `input.meta.phases`（`[{title, detail}]`）取，作为有序骨架
- 运行态分组：扫 `messages` 里所有 `parent_tool_use_id === workflowToolUseId` 的 assistant 帧，取其中 `Agent/Task/Explore` 的 `tool_use.input.phase`（或 `opts.phase`，两处都查），把每个子 Agent 归入对应阶段；没有 phase 的归入 `(unphased)`
- 每个阶段聚合：子 Agent 数、running/done/error 计数、该阶段是否完成

Selector 放 `src/session-store/normalize.ts`（与 `getSubagentStarts` 同位），纯函数、可单测、不引入新 state 字段（派生即可，避免改 reducer 持久化结构）。

### D. 为什么不改 reducer 加 `workflowPhases` 持久化字段

阶段树是 `input.meta.phases` + 子 Agent `phase` 的纯派生，没必要进 `SessionState`（会膨胀持久化、增加 replay 复杂度）。在 overlay/card 组件内用 `useMemo` 派生即可，`messages` 变化时自然重算。

## 实施步骤

### 第 1 步：工具名识别（让 Workflow 进入子 Agent 体系）

**`src/constants/toolNames.ts`**
- 新增 `WORKFLOW_TOOL_NAME = 'Workflow'`
- 新增 `WORKFLOW_TOOL_NAMES = new Set([WORKFLOW_TOOL_NAME])`（独立集合，**不并入 `SUBAGENT_TOOL_NAMES`** —— 因为 workflow 卡片需要自己的渲染分支，不能直接走 `SubagentCard`）

### 第 2 步：reducer 索引（让 Workflow 的内部消息可被 anchor）

**`src/session-store/normalize.ts`**
- 新增 `getWorkflowStarts(msg)`：仿 `getSubagentStarts`，识别 `Workflow` 工具，`label` 取 `input.meta.name ?? input.name ?? 'Workflow'`。返回 `ActiveSubagent[]`（**复用同一类型** —— workflow 在索引层面就是一个"特殊的 subagent"）。
- 把 `Workflow` 加入 `TOOL_STATUS_EXCLUDE`（`normalize.ts:223`），避免它既走通用 status badge 又有专属卡片。
- 新增 `deriveWorkflowPhases(workflowInput, messages, workflowToolUseId): WorkflowPhase[]`（纯函数）：
  ```ts
  interface WorkflowPhaseAgent {
    toolUseId: string
    label: string
    status: SubagentStatus
  }
  interface WorkflowPhase {
    title: string        // 来自 meta.phases[i].title，或 '(unphased)'
    detail?: string
    agents: WorkflowPhaseAgent[]
    running: number
    done: number
    error: number
    total: number
  }
  ```
  实现：先以 `meta.phases` 建有序骨架；再扫 `messages` 找 `parent_tool_use_id === workflowToolUseId` 的 assistant 帧里的 Agent/Task/Explore `tool_use`，按 `input.phase`（兼容 `input.opts?.phase`）归入；状态从 `activeSubagents` index 读（参数传入 `subagentIndex`），未命中算 running。

**`src/session-store/reducer.ts`**（`updateIndexes`，~1024 行 `getSubagentStarts` 之后）
- 在 `getSubagentStarts` 调用旁加 `getWorkflowStarts(message)`，**写入同一个 `activeSubagents` map**（workflow 复用该 map，不新增字段）。这样 `SubagentCard`/overlay 的 `index.get(toolUseId)` 天然能查到 workflow 记录，`toolCount` 统计逻辑（`reducer.ts:1081` 按 `parent_tool_use_id` 数 tool_use）对 workflow 的内部子 Agent 自动生效。
- `getToolResultEntries` → workflow 的 `tool_result` 会同样把 `activeSubagents` 里该 workflow 记录 flip 成 `done`/`interrupted`（`reducer.ts:1059` 现有逻辑无需改，因为它按 `toolUseId` 匹配，workflow 的 tool_use_id 一致）。

> 这一步是**点睛之笔**：workflow 复用 `activeSubagents`，意味着它的内部子 Agent（带 `parent_tool_use_id`=workflow id）一旦出现，`reducer.ts:1081` 的 toolCount 累加、`MessageList.tsx:398` 的过滤隐藏、以及 overlay 的 `parentToolUseIdFilter` drill-in **全部自动可用**，零额外接线。

### 第 3 步：Workflow 卡片（主流 anchor 点）

**`src/components/WorkflowCard.tsx`**（新文件，仿 `SubagentCard.tsx`）
- 读 `useSubagentContext().index.get(toolUseId)` 拿状态/计时（同 SubagentCard）。
- 额外读 `useSessionField` 的 `messages` + `subagentIndex`，用 `useMemo` 调 `deriveWorkflowPhases(input, messages, toolUseId)` 算阶段。
- 卡片体：一行阶段 chip 序列（`Scan✓ · Review● · Verify○`，✓=全完成 ●=进行中 ○=未开始），下方 `N agents · M running`。点击整卡 `ctx.open(toolUseId)`。
- fallback label：`input.meta.name ?? input.description ?? 'Workflow'`。

**`src/components/ToolUseBlock.tsx`**（分发分支，~127 行后）
- 在 SUBAGENT 分支后、`TOOL_VIEWS` 前加：
  ```tsx
  if (name && WORKFLOW_TOOL_NAMES.has(name)) {
    if (id) return <WorkflowCard toolUseId={id} input={input} />
    // 无 id 兜底：仍用未知工具 JSON
  }
  ```

### 第 4 步：Workflow Overlay（双栏：阶段树 + 消息）

**`src/components/WorkflowOverlay.tsx`**（新文件，仿 `SubagentOverlay.tsx`）
- Props 与 `SubagentOverlay` 对齐（`stack`/`items`/`index`/`onClose`/`onPop`/`toolStatus`/`toolResults`/…），但内部布局改双栏。
- 左栏 `<WorkflowPhaseTree>`：用 `deriveWorkflowPhases` 渲染阶段列表，每阶段可展开看其下子 Agent；点子 Agent 调 `onOpenSubagent(childToolUseId)` 压栈（复用 `Chat.tsx:333` 的 `openSubagent`，**嵌套 drill-down 自动复用**，栈深 >1 时右栏切到 SubagentOverlay 视图）。
- 右栏：栈顶是 workflow id 时，渲染 `<MessageList parentToolUseIdFilter={currentId} …>`（复用现有过滤，内部子 Agent 作为 SubagentCard 出现，可继续点开 → 压栈 → 右栏切 SubagentOverlay）。栈顶是普通 subagent id 时，右栏渲染现有 SubagentOverlay 的 body（复用 `MessageList`）。
- ESC / 面包屑 / 退场动画 全部复用 SubagentOverlay 的模式。

**`src/components/WorkflowPhaseTree.tsx`**（新文件）
- 阶段分组列表，每项：阶段名 + 状态徽标（running/done）+ 子 Agent 计数；展开列出子 Agent chip（label + status 图标），点击跳转。

**`src/components/Chat.tsx`**（~1136 行 SubagentOverlay 渲染处）
- 把单一的 `<SubagentOverlay>` 渲染改成一个**根据栈顶记录类型分发**的容器：
  - 栈顶 `index.get(topId)` 的记录标记为 workflow（见下）→ 渲染 `<WorkflowOverlay>`
  - 否则 → 渲染 `<SubagentOverlay>`（现有）
- 需要能区分"这条 activeSubagents 记录是 workflow 还是普通 subagent"。最小侵入：在 `ActiveSubagent` 加一个可选 `kind?: 'subagent' | 'workflow'` 字段，`getWorkflowStarts` 产出时置 `'workflow'`。`getSubagentStarts` 不变（undefined 视作 `'subagent'`，向后兼容）。

### 第 5 步：类型 + 持久化兼容

**`src/session-store/types.ts`**
- `ActiveSubagent` 加 `kind?: 'subagent' | 'workflow'`（可选，向后兼容旧 localStorage）。
- 上述 `WorkflowPhase` / `WorkflowPhaseAgent` 接口放 `normalize.ts` 并 `export`。

### 第 6 步：CSS（双栏 + 阶段树样式）

**`src/styles/chat.css`**（`.subagent-overlay` 旁）
- 新增 `.workflow-overlay` / `.workflow-overlay-panel`：`width: min(92%, 960px)`，`display: grid; grid-template-columns: 240px 1fr`，左栏 `.workflow-phase-tree` 可纵向滚动 + 右分隔线，右栏 `.workflow-overlay-body`。
- 新增 `.workflow-card` / `.workflow-card-phases` / `.workflow-phase-chip` 系列类，全部用 `var(--*)` 主题变量（遵 CLAUDE.md：禁硬编码 hex，`:root` + `[data-theme="light"]` 都要覆盖到的变量已在 tokens 定义，直接引用）。
- 阶段状态色复用现有 `--ok`/`--fg-muted`/`--danger` 变量。

## 影响面与风险

| 项 | 评估 |
|---|---|
| 改动文件数 | 新增 4（WorkflowCard/WorkflowOverlay/WorkflowPhaseTree + css 块），改 5（toolNames/normalize/reducer/ToolUseBlock/types/Chat）|
| 向后兼容 | `ActiveSubagent.kind` 可选；`Workflow` 不在集合时落兜底 JSON，不崩 |
| 嵌套 drill-down | 复用现有 stack + `parentToolUseIdFilter`，workflow→subagent→subagent 链路天然成立 |
| 持久化/replay | `activeSubagents` 复用，无新 state 字段（kind 是 activeSubagents 记录内的小字段，replay 时 `getWorkflowStarts` 重建即置位）；阶段树纯派生不持久化 |
| 性能 | `deriveWorkflowPhases` 用 `useMemo([messages, toolUseId])`；workflow 内部子 Agent 量大时扫描成本 O(该 workflow 子消息数)，可接受（MAX_VISIBLE_SUBAGENTS 折叠逻辑对 workflow 内部子 Agent 在右栏 MessageList 里天然生效，不会 chip 爆炸）|
| 测试 | 给 `deriveWorkflowPhases` / `getWorkflowStarts` 加单测（仿 `reducer.test.ts` 的消息构造）；给 `WorkflowCard` 加渲染测试（仿 MessageList.test.tsx 的 parent_tool_use_id 构造）|

## 不在本方案范围

- 服务端 `/workflows` 实时进度通道（如需秒级 live 进度，需新增 WS 帧类型，是更大改动；当前方案从消息流派生已足够覆盖"事后查看 + 大致进度"）
- workflow 脚本编辑器 / 保存的 workflow 列表 UI
- workflow 的 token 预算（budget）可视化

## 验收标准

1. Workflow `tool_use` 不再渲染原始 JSON，而是 `WorkflowCard`，显示 name + 阶段进度 chip 序列。
2. 点击 `WorkflowCard` 打开双栏 overlay：左阶段树（含子 Agent 分组+状态），右消息流。
3. overlay 右栏里 workflow 的内部子 Agent 作为 `SubagentCard` 出现，可继续点击 drill-in（嵌套栈），ESC/back 正常。
4. workflow 完成后卡片状态翻 `done`，overlay 仍可重开查看（与 SubagentCard 一致）。
5. `npm run typecheck` + `npm run test` + `npm run lint` 全绿。
