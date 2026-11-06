# SessionCatalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Chat 内联的 commands/agents 目录逻辑抽成 `useSessionCatalog`，并修复 initial/refresh/WS 乱序及 session/running 切换后的旧响应写回。

**Architecture:** 一个公开 hook 组合两个独立泛型 resource。每个 resource 用 session-tagged state、唯一 operation token 和纯 functional update 原子提交 cache/items；commands 独有全量 WS 替换，agents 仅 REST/refresh。

**Tech Stack:** React 19、TypeScript、Vitest、@testing-library/react、现有 `api` 与 `useWsHub`。

**Spec:** `docs/superpowers/specs/2026-11-03-session-catalog-design.md`

## Global Constraints

- 公开接口固定为 `{ commands, agents, refreshCommands, refreshAgents }`，不新增 loading/error。
- cache 仅为 hook-local per-session Map；不做全局缓存、跨 remount 缓存或请求去重。
- session 切换立即采用新 session cache/[]；running false 保留 items，迟到 REST 不得提交 state/cache。
- 非 running refresh 只清 cache、保留 items、零 HTTP；running 翻正后 miss 重取。
- REST 仅当 session + running + token 全匹配才提交；commands-changed 仅检查 session，同时替换 cache/items 并淘汰旧 REST。
- 两个资源互不影响；空数组可命中，失败静默并保留 items。
- Composer 继续用 mergedCommands，Settings 用原始 commands/agents；plugin reload 刷新两者，skill reload 仅 commands。
- 不修改 server、REST/WS 协议、SDK、SettingsPanel 或 Composer。
- 只 stage 每个任务列出的文件，不混入其他工作树改动。

## Review Focus

- **同 tick 连续 refresh：** 只有最后一次操作可提交；由 Task 1 的 unique-token 测试覆盖。
- **WS 与 REST 乱序：** commands-changed 后的旧 REST 不得覆盖或污染 cache；由 Task 1 的 WS generation 测试覆盖。
- **session/running 切换：** 旧响应不得写新状态，非 running items 保留；由 Task 1 的切换矩阵覆盖。
- **effect 重复请求：** items/cache/token 更新不得触发额外 initial fetch；由 Task 1 请求计数与 Task 2 streaming render 测试覆盖。
- **非 running refresh 与空数组：** cache 失效但 items 保留，空数组后续仍命中；由 Task 1 的缓存语义测试覆盖。

---

### Task 1: 建立带竞态防护的 `useSessionCatalog`

**Files:**
- Create: `src/hooks/useSessionCatalog.ts`
- Create: `src/hooks/useSessionCatalog.test.ts`

**Interfaces:**
- Produces:

```ts
export function useSessionCatalog(sessionId: string, running: boolean): {
  commands: SlashCommand[]
  agents: AgentInfo[]
  refreshCommands: () => void
  refreshAgents: () => void
}
```

内部每个 resource 返回 `items / refresh / replaceFromFrame`，供 commands WS 使用；agents 不接 frame。

- [ ] **Step 1: 写完整 catalog 行为与 deferred-race 测试**

用 mock `api.get`、稳定 mock hub 和可捕获的 session listener 创建测试。至少覆盖以下独立场景：

1. running mount 分别 GET `/sessions/s1/commands` 与 `/agents`；非 running 零 GET。
2. 空数组响应写 cache；running false→true 命中，不重复 GET。
3. session A→B 立即显示 B cache/[]；A 的迟到 initial/refresh 不写 B items/cache。
4. A 的旧 commands-changed listener 在切换后不得修改 B。
5. running true→false 保留 items，迟到 REST no-op；false→true cache miss 重新 GET。
6. 非 running refresh 清 cache、保留 items、零 GET；翻正后重新 GET。
7. initial 未完成时 refresh，旧 initial 后落地不得覆盖 refresh 或写 cache。
8. 同 tick 两次 refresh 使用不同 token，只有最后一次响应可提交。
9. initial/refresh 未完成时 commands-changed 到达，旧 REST 不得覆盖 WS 列表。
10. 非 running 时 commands-changed 仍同时更新 cache/items。
11. commands 的 refresh/WS 不改变 agents，agents refresh 不改变 commands。
12. 请求失败保留 items、不填 cache；后续 refresh 可成功重试。
13. Chat unmount 后 deferred 响应无 act/unhandled 警告。
14. refresh identity 在 items/cache/token 更新后保持稳定，仅 session/running 改变时更新。
15. hook remount 不继承其他实例 cache。

每个 deferred 都必须显式 resolve/reject 并 await 原操作，避免游离 Promise。

- [ ] **Step 2: 运行测试并确认模块缺失 RED**

Run:

```bash
npm test -- src/hooks/useSessionCatalog.test.ts
```

Expected: FAIL，原因是 `./useSessionCatalog` 尚不存在，不是测试语法或 mock 错误。

- [ ] **Step 3: 实现两个 session-tagged resources 与公开 hook**

在 `useSessionCatalog.ts` 实现内部 `useCatalogResource<T>`：

```ts
{
  sessionId: string
  running: boolean
  path: 'commands' | 'agents'
  select: (response: unknown) => T[]
}
```

每个 resource 的 React state固定为：

```ts
{
  sessionId: string
  running: boolean
  token: symbol
  cache: ReadonlyMap<string, T[]>
  items: T[]
}
```

实现要求：

- session/running 改变使用 render-time state adjustment + 新 token；session 改时 items 采用新 session cache/[]，仅 running 改时保留 items。
- initial 仅 running + cache miss 请求；cache hit 采用缓存。initial effect 不依赖操作 token，stateRef 只在 effect 中同步。
- refresh 生成新 token、清当前 session cache；running 才请求。连续调用天然获得不同 symbol。
- REST 的 `.then` 仅在同一个纯 functional update 中检查 session/running/token 后同时写 cache/items；失败静默。
- `replaceFromFrame` 生成新 token，仅检查 session，同时替换 cache/items，不检查 running。
- `select` 使用首 render ref 或等价稳定策略；refresh callbacks 不依赖 items/cache/token。
- `useSessionCatalog` 组合两个 resource，仅在 commands 上调用 `hub.addSessionListener(sessionId, ...)`，agents 不订阅。

- [ ] **Step 4: 运行完整 hook 测试**

Run:

```bash
npm test -- src/hooks/useSessionCatalog.test.ts
```

Expected: 全部 PASS，无 act warning、unhandled rejection 或额外 GET。

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSessionCatalog.ts src/hooks/useSessionCatalog.test.ts
git commit -m "refactor: add guarded session catalog" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 迁移 Chat 并保持调用方契约

**Files:**
- Modify: `src/components/Chat.tsx:720-832`
- Modify: `src/components/streaming-render-isolation.test.tsx`
- Test: `src/components/SettingsPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `useSessionCatalog(session.id, session.running)`。
- Produces: 原 `commands/agents/refreshCommands/refreshAgents` 局部变量及全部调用方行为。

- [ ] **Step 1: 运行 Chat/Settings 表征测试基线**

Run:

```bash
npm test -- src/components/streaming-render-isolation.test.tsx src/components/SettingsPanel.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 2: 用 catalog 替换内联实现**

在 Chat 中：

- 用一次 `useSessionCatalog(session.id, session.running)` 替换 commands/agents 的 state、两个 cache refs、initial effects、commands listener 和两个 refresh 实现。
- 保留 `mergedCommands` 的 `LOCAL_COMMANDS` 优先派生及全部使用点。
- 删除不再使用的 `useWsHub` import；不要改 Composer、SettingsPanel props 或 reload callbacks。

- [ ] **Step 3: 增加重复 render 不重复请求的表征断言**

在 `streaming-render-isolation.test.tsx` 的现有 flush 窗口末尾，按 URL 过滤 API spy，断言：

```ts
expect(callsFor('/commands')).toHaveLength(1)
expect(callsFor('/agents')).toHaveLength(1)
```

该断言固定 token/items/cache 更新不会触发额外 initial GET；不要改变原 streaming render 测试目的或阈值。

- [ ] **Step 4: 运行 Chat、catalog 与 Settings 回归**

Run:

```bash
npm test -- src/components/streaming-render-isolation.test.tsx src/components/SettingsPanel.test.tsx src/hooks/useSessionCatalog.test.ts
```

Expected: 全部 PASS；merged commands、原始 Settings 数据和 reload 调用不变。

- [ ] **Step 5: Commit**

```bash
git add src/components/Chat.tsx src/components/streaming-render-isolation.test.tsx
git commit -m "refactor: use session catalog in chat" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 全量验证与完整 diff review

**Files:**
- Review only: Task 1–2 的全部文件
- Modify only for confirmed findings: 对应实现或测试文件

**Interfaces:**
- Consumes: 完整 catalog、Chat 集成和竞态测试矩阵。
- Produces: 可交付 diff，不改变已确认接口。

- [ ] **Step 1: 运行全部针对性测试**

Run:

```bash
npm test -- src/hooks/useSessionCatalog.test.ts src/components/streaming-render-isolation.test.tsx src/components/SettingsPanel.test.tsx
```

Expected: 全部 PASS，无 act/unhandled/max-depth 或额外请求。

- [ ] **Step 2: 运行项目静态检查与完整测试**

Run:

```bash
npm run typecheck
npm run lint
npm test
```

Expected: 全部 exit 0。若出现预存时序失败，记录准确测试与隔离复现结果，不得猜归因。

- [ ] **Step 3: 对完整变更执行 code review**

从实施前 base SHA 到 HEAD 运行 `code-review` skill，重点检查：

- token/session/running 检查与 cache/items 提交原子且纯；
- 同 tick refresh、WS 淘汰、非 running frame 与失败语义；
- effect 不因 token/items/cache 变化重复请求；
- cache 仅 hook-local，非 running refresh 不清 items；
- mergedCommands、Settings 原始列表及 reload 差异不变；
- 无 agents WS、全局 cache、loading/error 或无关文件混入。

确认 finding 先补失败测试再修复；非平凡修复后重跑本任务 Step 1–3。

- [ ] **Step 4: 汇总交付**

报告实际改动、竞态测试证据、请求次数、静态检查、全量测试及 review findings。不得把未运行的验证写成通过。
