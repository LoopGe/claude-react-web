# opencode 的任务清单（todowrite）机制调研

> 基准：opencode 仓库 `dev` 分支，commit `fe046564650854594c4c5aa22270f46d9de6cace`（2026-11-03）。
> 本地克隆：`D:\codes\opencode`（remote 为 `github.com/anomalyco/opencode`）；下文 permalink 均以
> `https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/<path>#L<行号>`
> 形式固定到该 commit，行号已在本地克隆逐一核对。
> 最新发布版本：CHANGELOG 记录 "OpenCode V2"，最新为 v2.2.5（2026-10-30）。
> 文件位置约定：本仓库研究类文档惯例为 `docs/<主题>-research.md`（如 `docs/codex-opencode-desktop-ui-research.md`），
> 故本文放在 `docs/opencode-tasklist-research.md`。

---

## 1. 术语与概念

- 核心概念就是一个 **工具（tool）**，工具名单数 `todowrite`——只有写、没有读：
  - `export const name = "todowrite"`（[packages/core/src/tool/plugin/todo.ts#L11](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L11)，本地 `packages/core/src/tool/plugin/todo.ts`）。
  - 全仓库工具目录 `packages/core/src/tool/plugin/` 下没有 `todoread`/`todoupdate` 之类的兄弟工具（本地目录清单核对）。
  - 模型侧"读"任务列表的方式是回看自己历史里的上一次 `todowrite` 调用（见 §3）。
- 工具描述文本（`packages/core/src/tool/todowrite.txt`，全文 7 行）把它定义为会话级工作计划：
  "Create and update a todo list for the current session. **The user sees it as your working plan.**"
  （[todowrite.txt#L1](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/todowrite.txt#L1)）。
- 配置开关：`experimental.todo`（布尔，默认 **false**）——
  "Enable the experimental todowrite tool. Defaults to false."
  （[packages/schema/src/config/experimental.ts#L12-L14](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/schema/src/config/experimental.ts#L12-L14)）。
  这是一个 **实验性、默认关闭** 的功能；开启方式 `{"experimental": {"todo": true}}`（CHANGELOG，见 §6 时间线）。
- 文档页面：
  - `packages/web/src/content/docs/tools.mdx` 的 `### todowrite` 小节（[tools.mdx#L217-L233](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/web/src/content/docs/tools.mdx#L217-L233)）："Creates and updates task lists to track progress during complex operations. The LLM uses this to organize multi-step tasks."
  - `packages/web/src/content/docs/agents.mdx` 权限表中列为独立权限键 `todowrite`（[agents.mdx#L454](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/web/src/content/docs/agents.mdx#L454)）。
  - UI 里的叫法：TUI 侧栏标题 "Todo"、transcript 块标题 "# Todos"、桌面端 "todo pill"、设置页权限项 "Todo Write"。
- **不是**任务清单的两个相邻概念（避免混淆）：
  - **Plan mode**：`packages/core/src/plugin/plan.ts` 定义的只读 agent（"Read-only agent for exploring the codebase and planning work before implementation."，只允许写 `~/.opencode/plan` 目录；[plan.ts#L14-L40](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/plugin/plan.ts#L14-L40)）。这是"规划模式"，与 todo 列表无关。
  - **Goal（`/goal` 命令）**：`packages/core/src/plugin/goal.ts` + `packages/schema/src/goal.ts`，见 §6 末尾。

## 2. 数据模型

单个 todo 项只有两个字段（[packages/core/src/tool/plugin/todo.ts#L13-L18](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L13-L18)）：

```ts
export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
})
```

- **没有 id、没有 activeForm、没有时间戳、没有排序字段**——顺序就是数组顺序，UI 按数组顺序渲染（如 [packages/app/src/session/composer/todo-pill.tsx](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/app/src/session/composer/todo-pill.tsx) 的 `<For each={props.todos}>`）。
- status 枚举 4 值：`pending | in_progress | completed | cancelled`（`cancelled` 会以灰色+删除线渲染，[packages/tui/src/component/todo-item.tsx#L15-L31](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/component/todo-item.tsx#L15-L31)）。
- 列表整体的输入/输出 schema（[todo.ts#L21-L28](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L21-L28)）：
  - `Input = { todos: Array<Info> }`（注释 "The updated todo list"）
  - `Output = { todos: Array<Info> }`（原样回显）
- 客户端解析函数 `parseTodos` 对非法项宽容处理：非字符串/空 `content` 直接丢弃，非法 `status` 回落 `pending`（[packages/tui/src/util/todo.ts#L17-L23](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/util/todo.ts#L17-L23)）。
- 工具执行结果还带 `metadata: { todos }`（[todo.ts#L74](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L74)），随消息一起持久化。

## 3. 存储与生命周期

**核心设计：工具本身完全无状态，"当前列表"从消息流里推导。**

- 客户端注释原文（[packages/app/src/session/composer/todos.ts#L12-L19](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/app/src/session/composer/todos.ts#L12-L19)）：
  > "The experimental `todowrite` tool keeps no server state: the current list is the input of the latest completed call before the revert boundary."
- 推导逻辑（TUI 与 app 各有一份等价实现，`sessionTodos(messages, boundary?)`）：取 revert 边界之前的最后一条 `state.status === "completed"` 的 `todowrite` 工具调用，读它的 **`state.input.todos`** 即为当前列表（[packages/tui/src/util/todo.ts#L32-L43](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/util/todo.ts#L32-L43)）。
- 更新方式是**整表覆盖**：每次调用提交完整列表，替换前一次（tool description："Send the full list on every call; it replaces the previous one."，[todowrite.txt#L5](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/todowrite.txt#L5)）。没有单条增删改。
- 持久化：`todowrite` 调用是普通 assistant 消息里的 tool part，落在 SQLite（drizzle + `SessionMessageTable`）里，重启后仍在——所以 todo 列表跟着会话消息走，天然跨轮次、跨重启持久。
- **Revert（回退）感知**：推导时按 `session.revert.messageID` 截断（app：[region.tsx#L451](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/app/src/session/composer/region.tsx#L451)；TUI：[sidebar/todo.tsx#L10-L13](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/feature-plugins/sidebar/todo.tsx#L10-L13)）——回退点之后的 `todowrite` 调用不算数。
- **压缩（compaction）**：
  - 模型侧历史被最新一次完成的 compaction 截断（`messageEntries` 用 `gte(seq, compaction.seq)` 界定，[packages/core/src/session/history.ts#L184-L191](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/session/history.ts#L184-L191)），压缩前的 `todowrite` 调用会离开模型上下文；任务进度改由压缩摘要的 **"Work State → Completed / Active / Blocked" + "Next Move"** 小节以文字形式承接（[packages/core/src/session/compaction.ts#L177-L189](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/session/compaction.ts#L177-L189)）。
  - UI 侧的推导**不受 compaction 界定**：客户端消息列表走 `SessionStore.messages` → `messageRows`，是对消息表的直接分页查询，无 compaction 过滤（[packages/core/src/session/store.ts#L102-L135](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/session/store.ts#L102-L135)、[#L188-L194](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/session/store.ts#L188-L194)）。因此压缩后 UI 可能仍显示旧计划；app 的对策是显式门控（§5），TUI 侧栏则不设门控。
- 历史包袱：
  - V2 重写时 `todowrite` 曾被移除：`REMOVED_TOOLS = ["todowrite"]`（[packages/core/src/database/v1-migration.bun.ts#L998](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/database/v1-migration.bun.ts#L998)），迁移后给模型的提示语是 "The `todowrite` tool is no longer available by default. Only call it if it is in your tool list."（[packages/core/test/v1-migration.test.ts#L515](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/test/v1-migration.test.ts#L515)）。
  - 迁移链里有一个 V1 时代的 `todo` 表（`CREATE TABLE todo (... position ..., PRIMARY KEY(session_id, position))`，[packages/core/src/database/migration/20260127222353_familiar_lady_ursula.ts#L76-L85](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/database/migration/20260127222353_familiar_lady_ursula.ts#L76-L85)）；当前代码里找不到任何读写它的地方（见文末未决项）。
  - 迁移来的 V1 会话历史里还留着旧 `todowrite` 调用；app 侧显式防呆："Migrated V1 sessions keep their old `todowrite` calls, so without this check their last plan would come back."（[region.tsx#L456-L457](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/app/src/session/composer/region.tsx#L456-L457)）——只有 `experimental.todo` 开启才展示。

## 4. 工具设计

- 注册（[packages/core/src/tool/plugin/todo.ts#L50-L77](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L50-L77)）：
  - 只有 `experimental.todo === true` 时才 `editor.add`（[L50-L54](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L50-L54)）；配置热变更通过 `ctx.tool.reload()` 重建（[L48-L49](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L48-L49)）。
  - `options: { codemode: false }` —— 注册在 provider 原生工具列表上，不走 Code Mode（[L57](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L57)；语义见 [packages/core/src/tool/AGENTS.md](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/AGENTS.md) "`codemode: false` keeps the tool on the provider's native tool list"）。
  - 执行前过一次权限：`permission.assert({ action: "todowrite", resources: ["*"] ... })`（[L62-L68](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L62-L68)），文档给出 `permission: { "todowrite": "allow" }` 的配置示例（[tools.mdx#L221-L228](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/web/src/content/docs/tools.mdx#L221-L228)）。
  - 返回值：`output: { todos }` + 给模型看的文本 `content: summarize(todos)` + `metadata: { todos }`（[L71-L75](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L71-L75)）。
- `summarize` 把整表压缩成一行统计给模型（[L30-L41](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L30-L41)）：
  例：`Todos updated: 1/4 completed, 1 in progress, 1 pending, 1 cancelled. In progress: "Write tests"`（测试样例见 [packages/core/test/tool-todo.test.ts#L50-L70](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/test/tool-todo.test.ts#L50-L70)）。清空列表时返回 `"Todos cleared"`（[L31](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/plugin/todo.ts#L31)）。
- **输入校验**：registry 在运行时按 Effect Schema 校验 model 输入（`todos` 必须是 `{content: string, status: 四值之一}[]`；测试断言 `properties.todos.items.required: ["content","status"]`，[tool-todo.test.ts#L54-L56](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/test/tool-todo.test.ts#L54-L56)）。没有"必须至少一条"、"状态迁移合法性"之类的业务校验。
- **使用时机的指令不写在 system prompt 里**——`packages/core/src/plugin/system-prompt/*.txt` 与 `packages/core/src/session/runner/prompt/system.txt` 全文 grep 无 todo 相关段落；唯一的行为指令是工具描述 `todowrite.txt` 全文（[L1-L7](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/todowrite.txt#L1-L7)）：
  > "Use it proactively when a task has 3 or more distinct steps, or when the user gives several tasks or asks for a todo list. Skip it for a single simple task or a purely conversational request. When in doubt, use it."
  > "- Send the full list on every call; it replaces the previous one."
  > "- Mark items `in_progress` when you start them and `completed` as soon as they're actually done."
  > "- Only call it when the list changes."
- 每会话一份：描述里 "for the current session"（[todowrite.txt#L1](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool/todowrite.txt#L1)）。子 agent 是独立 session（独立消息流），天然各有各的列表；文档称 General 子 agent 默认拿不到该工具（见 §6 / 未决项）。
- 工具可见性按 agent 的 permission ruleset 过滤：`whollyDisabled` 把 `deny` + `resource: "*"` 的 action 对应工具从快照里剔除（[packages/core/src/tool.ts#L251-L259](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool.ts#L251-L259)、[#L379-L382](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/tool.ts#L379-L382)）；每次请求用 `registry.snapshot(Permission.merge(agent.permissions, session.permissions))` 取工具集（[packages/core/src/session/context.ts#L135-L139](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/session/context.ts#L135-L139)）。

## 5. UI 呈现

**TUI（packages/tui）**——展示粒度是"每次调用一个块 + 侧栏聚合"：

- Transcript 内：`TodoWrite` 组件把已完成的调用渲染成标题 `# Todos` 的块，逐条列 `TodoItem`；进行中显示 inline "Updating todos…"，失败 "Todo update failed"，空表 "Cleared todos"（[packages/tui/src/routes/session/index.tsx#L3636-L3656](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/routes/session/index.tsx#L3636-L3656)；`todowrite` 在自定义渲染白名单里，[message-parts.tsx#L33](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/routes/session/message-parts.tsx#L33)）。
- 状态记号（[packages/tui/src/util/todo.ts#L25-L31](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/util/todo.ts#L25-L31)）：`[✓]` completed、`[•]` in_progress、`[-]` cancelled（+删除线）、`[ ]` pending；ascii 回退为 `[x]`/`[>]`（scrollback 用）。
- 侧栏插件 `opencode.sidebar.todo`：标题 "Todo"，>2 条才可折叠，折叠时显示 "(N remaining)"（N = pending + in_progress），无列表时整个区域隐藏（[packages/tui/src/feature-plugins/sidebar/todo.tsx#L6-L55](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/feature-plugins/sidebar/todo.tsx#L6-L55)）。折叠状态存插件 storage。
- mini 渲染（无 UI/scrollback 场景）：`runTodo` 输出 checklist 正文，`snapTodo` 提取快照（[packages/tui/src/mini/tool.ts#L462-L470](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/mini/tool.ts#L462-L470)、[#L627-L632](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/tui/src/mini/tool.ts#L627-L632)）。

**桌面端 / Web UI（packages/app）**——展示粒度是"composer 上方一颗胶囊（pill）"：

- `SessionTodoPill`：胶囊显示"当前那条"（优先 in_progress，其次下一条 pending，再次最后一条 completed——`currentTodo`，[packages/app/src/session/composer/todos.ts#L33-L41](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/app/src/session/composer/todos.ts#L33-L41)），并行的其他 in_progress 显示 "+N" 徽标；点开 popover 看完整列表，且自动滚动到 in_progress 那行（[todo-pill.tsx#L12-L130](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/app/src/session/composer/todo-pill.tsx#L12-L130)）。位于 composer lane，紧挨后台活动胶囊（[region.tsx#L577-L579](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/app/src/session/composer/region.tsx#L577-L579)）。
- **可见性门控**（与 TUI 不同的设计）：`todoEnabled() && working() && 有条目 && 并非全部已完结` 才显示——"Like the old dock: the plan shows while the turn runs and still has work left, so **stale todos never linger**"（[region.tsx#L452-L455](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/app/src/session/composer/region.tsx#L452-L455)）。
- Timeline 里**不渲染** todowrite 调用本身：投影层直接 `if (content.name === "todowrite") return false`（[packages/session-ui/src/timeline/projection.ts#L969](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/session-ui/src/timeline/projection.ts#L969)），工具渲染器返回 null（[packages/session-ui/src/tools/tool-renderer.tsx#L1349](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/session-ui/src/tools/tool-renderer.tsx#L1349)）——计划只通过 pill 表达，不占 transcript。
- 无独立 spinner 集成：working 指示器（`session-working-indicator.tsx`）不含 todo 逻辑（本地 grep 核对）。

## 6. 值得注意的设计取舍（对比 Claude Code 式 TaskList/TaskCreate）

1. **无状态工具 + 流派生态**：没有服务端 todo store、没有 per-item 编辑工具（对比 Claude Code 的 `TaskCreate`/`TaskUpdate`/`TaskList` 一族）。"当前列表"= 消息流里最后一次完成的 `todowrite` 调用的 input（§3 引文）。好处：零状态一致性问题，replay/回退天然正确；代价：每次变更都要重传整表，且"当前状态"对模型而言只存在于它自己的历史里（没有 `todoread`）。
2. **整表覆盖 + 无 id**：`{ content, status }` 两项、四态（含 `cancelled`），顺序即数组序。对比 Claude Code 任务项的 `id`/`activeForm`/单条更新语义，opencode 的契约小得多，模型侧也更难"改错一半"。
3. **实验性、默认关闭、且是"复活"的功能**：CHANGELOG 时间线——
   - v2.0.28：清理残留的 `todowrite` 标签（[CHANGELOG.md#L1182](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/CHANGELOG.md#L1182)）——V2 重写时工具已被移除（`REMOVED_TOOLS`，§3）；
   - v2.1.0（2026-10-19，PR #56947）：**恢复** `todowrite`，置于 `{"experimental":{"todo":true}}` 之后，TUI 会话输出/侧栏展示（[CHANGELOG.md#L844](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/CHANGELOG.md#L844)、[#L928](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/CHANGELOG.md#L928)）；
   - v2.2.0：桌面端 composer 上方展示（PR #59092，[CHANGELOG.md#L522](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/CHANGELOG.md#L522)）；
   - v2.2.2：todo pill 改版（[CHANGELOG.md#L254](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/CHANGELOG.md#L254)）。
   有趣的是 v1 反而是有服务端 todo 表的（§3 的 `todo` 表残迹），v2 改成了纯消息流推导。
4. **UI 与模型状态可以脱节，用门控消化**：compaction 后模型不再持有列表（由摘要 "Work State" 文字承接），而 UI 推导不看 compaction 边界；app 用"仅 turn 进行中且未全部完结才显示"来保证过期计划不会滞留，TUI 侧栏则接受常驻显示。
5. **呈现位置的分歧**：TUI 让每次 `todowrite` 调用在 transcript 里留下 "# Todos" 块（过程可见）；桌面端反过来把调用从 timeline 隐藏、只留 composer pill（结果可见）。
6. **子 agent**：文档称 General 子 agent "Has full tool access except `todowrite`"（[agents.mdx#L96](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/web/src/content/docs/agents.mdx#L96)），但代码里 `general` agent 只显式 deny 了 `question` 和 `subagent`（[packages/core/src/plugin/agent.ts#L63-L71](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/plugin/agent.ts#L63-L71)）——见未决项。
7. **相邻概念 Goal（`/goal`）**：如果要对比的是"跨轮次目标/任务驱动"，opencode 另有一个内置插件 `opencode.goal`：`/goal <objective> | pause | resume | clear`，把 `{ objective, status: active|paused|complete, reason, rounds, maxRounds, stalls, boot, updatedAt }` 存在 **插件 storage**（key `session:<id>`，子会话/ fork 不继承，[packages/schema/src/goal.ts#L7-L40](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/schema/src/goal.ts#L7-L40)、[packages/core/src/plugin/goal.ts#L15-L33](https://github.com/anomalyco/opencode/blob/fe046564650854594c4c5aa22270f46d9de6cace/packages/core/src/plugin/goal.ts#L15-L33)），由 reviewer（`goal/judge.txt`、`goal/continuation.txt`、`goal/reminder.txt`）在每轮结束后判定 `done|continue|blocked|paused|wait` 驱动续跑，上限 50 轮 / 连续 3 轮无进展即停 / 空等 30 分钟暂停。这是"目标循环器"，与 todowrite 的"工作计划清单"分工不同。

## 未决项（未能从一手来源证实）

1. **General 子 agent 默认排除 `todowrite` 的实现位置**：文档（tools.mdx#L233、agents.mdx#L96）明确说该工具对 General 子 agent 默认禁用、可手动启用；但在本 commit 的代码里，`general` agent 的 ruleset 只 deny 了 `question` 与 `subagent`（plugin/agent.ts#L63-L71），工具快照的过滤只认 `deny`+`resource:"*"` 规则（tool.ts#L251-L259, L379-L382），全仓库再无第二处针对 `todowrite` 的过滤或 deny。无法确定是文档超前/滞后，还是存在未被 grep 到的注入路径。
2. **V1 时代 `todo` 表（`session_id, position` 主键）的原始读写实现**：本仓库只留下建表迁移（2026-01-27）与 `REMOVED_TOOLS` 记录，V1 工具代码不在该仓库内，其行为无法核实；也无法确定这张空表是刻意保留还是遗留未清。
3. **fork 会话是否复制 todo 状态**：fork 复制消息历史的话派生列表自然跟着走，但未找到 fork 对 `todowrite` 的显式处理代码，未验证。
