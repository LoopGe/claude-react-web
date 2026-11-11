# Native Agent Profile 与主线程 Preset 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 native 主线程 preset 与嵌套自定义 agent 的核心字段真实生效，并以可恢复的日志快照统一 create、切换、clear、resume、fork 和嵌套执行行为。

**Architecture:** 新增纯数据 `NativeAgentProfile` 与 `session/agent` 事件。主会话分离 base/effective 配置，在每个 turn 重建完整工具集后应用 profile 过滤；嵌套 Agent 复用同一解析层。`runTurn` 获得显式 `maxTurns` 截止能力，manager 通过可选 provider 读接口同步下一轮 effective model/permission/effort。

**Tech Stack:** TypeScript ESM（`.js` imports）、Node 20、Vitest；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-11-native-agent-skill-preset-parity-design.md`（阶段 A）。

## Global Constraints

- 只做阶段 A：不得加入 `subagent/descriptor`、独立 transcript、Task/Explore、forked Skill、插件技能或 `session/skill`。
- 保持同步 Agent 的单一 tool_result/final-report、depth=1、depth 子列表移除 Agent，以及后台 detach 协议。
- `session/agent` 是 history-only 状态事件，不进入模型 history、UI transcript 或搜索；compact 不清除最新选择，fork 只继承切点前的选择。
- 新 create/switch 遇到 `background`、`initialPrompt`、`memory`、`observer`、`observerMessage`、`criticalSystemReminder_EXPERIMENTAL`、`omitClaudeMd` 或数值 `effort` 必须显式拒绝并列出字段名，不能静默忽略。
- `maxTurns` 是模型 API round 上限。第 N 轮返回 tool_use 时不得请求权限或执行工具；为每个 tool_use 持久化并广播 `is_error:true` 的 `max turns reached (N); tool not executed` synthetic result。正常 end_turn 收尾不因刚好达到上限而失败。
- 主会话 `SessionInfo.model` / `permissionMode` / `effortLevel` 与 broker 必须使用下一轮 effective 值；base 只用于 clear/respawn 恢复。
- 嵌套权限模式通过 `canUseTool` context 的 `permissionMode` 覆盖传递，不能污染父会话；parent bypass、nested default 不得被自动放行。
- 旧 `SessionMeta.agent` 含不支持字段时恢复普通会话、清空 `SessionMeta.agent`、写 `droppedAgent` 并发 informational，不得让 resume/fork/clear 失败或应用部分 persona。
- 每提交一个任务先审查完整 diff；只 stage 本任务文件，禁止 amend/rebase/push 和 `git add -A`。每个 commit message 末尾添加 `Co-Authored-By: Kimi <noreply@moonshot.cn>`。
- 设计补充：`session/agent.base` 除 model/permissionMode/effortLevel/skillPolicy 外，还保存 `toolProfile?: SessionToolProfile`，否则跨进程 clear 无法恢复 base 工具集。

## Review Focus

1. **权限泄漏**：persona bypass 在 clear 后仍残留，或 parent bypass 让 default 子代理绕过权限。Task 4/5 分别用 main 和 nested 请求证明。
2. **超限副作用**：`maxTurns` 最后一轮请求写工具时不得运行，且所有 tool_use 都有 synthetic result。Task 2/5 覆盖 main/nested 持久化与 frame。
3. **恢复错版本**：定义后续被编辑时 resume 必须使用日志快照；旧不支持定义必须可见地降级。Task 3/6 覆盖。
4. **过滤顺序错误**：动态 MCP、allowlist `[]`、deny-last 和 skill allowlist 不得互相复活。Task 2/3/5 覆盖。
5. **UI/broker 与实际配置分裂**：persona override 下的 setModel/setPermissionMode/effort 必须同时保持 base 可恢复和 SessionInfo effective 一致。Task 4 覆盖。

---

### Task 1: Agent profile、字段矩阵与选择事件

**Files:**
- Create: `server/providers/native/agent-profile.ts`
- Create: `server/providers/native/agent-profile.test.ts`
- Modify: `server/providers/native/session-log/format.ts`
- Modify: `server/providers/native/session-log/replay.ts`
- Test: `server/providers/native/session-log/format.test.ts`, `server/providers/native/session-log/replay.test.ts`

**Interfaces:**
- Produces `NativeAgentProfile`、`NativeAgentBase`、`NativeAgentSelectionEvent`、`profileFromDefinition(def)`、`unsupportedAgentFields(def)`、`assertAgentProfileSupported(def)`、`agentSelectionFromEvents(events)`。
- `NativeAgentBase` 包含 `model`、`permissionMode`、`effortLevel?`、`skillPolicy?`、`toolProfile?: SessionToolProfile`。
- `session/agent` 形状固定为 `{type:'session/agent', name:string|null, definition?:StoredAgentDefinition, base:NativeAgentBase, droppedAgent?:{name:string,unsupportedFields:string[]}, timestamp:string}`。
- `agentSelectionFromEvents` 从后向前返回最后一个选择，compact 不作为 floor；没有事件返回 `undefined`。

- [x] **Step 1: 写失败测试**

覆盖：
- 全字段定义映射为 profile；`tools:[]` 保留为空数组，字符串 effort 保留。
- 上述不支持字段和数值 effort 全部进入 `unsupportedAgentFields`；`assertAgentProfileSupported` 的错误文本同时含字段名。
- 选择事件 append/parse round-trip；多个选择 last-wins；compact 后仍读取之前选择；非法 base、definition、droppedAgent 抛 `NativeSessionStorageError('corrupt')`。
- 普通 user/assistant/supplement replay 结果不受 `session/agent` 影响。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/agent-profile.test.ts server/providers/native/session-log/format.test.ts server/providers/native/session-log/replay.test.ts`

- [x] **Step 3: 实现纯解析与事件支持**

`profileFromDefinition` 只映射 `prompt/model/tools/disallowedTools/mcpServers/skills/permissionMode/maxTurns/effort`，不执行 I/O。严格校验选择事件快照，不复用会静默 strip 非法字段的宽松 coercion 掩盖日志损坏。format 的 `NativeLogEvent`/`NativeEventInput` 增加选择事件，replay 默认忽略它。

- [x] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。

- [x] **Step 5: 审查并提交**

Commit: `feat(native): add agent profiles and selection events`

---

### Task 2: Profile 工具/技能过滤与 maxTurns

**Files:**
- Create: `server/providers/native/agent-tools.ts`, `server/providers/native/agent-tools.test.ts`
- Modify: `server/providers/native/skills.ts`, `server/providers/native/skills.test.ts`
- Modify: `server/providers/native/loop.ts`, `server/providers/native/loop.test.ts`

**Interfaces:**
- `filterToolsForProfile(tools: readonly ToolDef[], profile: Pick<NativeAgentProfile,'tools'|'disallowedTools'|'mcpServers'>, ownership: ReadonlyMap<string,{name:string}>): ToolDef[]`。
- `NativeSkillCatalog.view(policy?: readonly string[] | 'all')` 返回共享发现缓存的 `{section(), bodyOf(name), commands()}` view；现有方法委托给 spawn-policy view。
- `LoopDeps.maxTurns?: number`；`TurnResult.isError` 在截止时为 true。

- [x] **Step 1: 写失败测试**

- `tools:[]` 返回空集；allowlist 后 deny；MCP 按 ownership.name 过滤，不能按 FQN 猜 server。
- skill view 的 exclude 在父 catalog override 为 on 时仍不可见，reload 后同一 view 读到新缓存。
- `maxTurns:1` 的 tool_use 轮不调用 requestPermission、不执行工具；发出一个 synthetic error result，history 中 tool_use/result 配对，result.isError=true。
- 第 N 轮无 tool_use 且 end_turn 时正常完成；非法 maxTurns（0、负数、非整数）在 history 写入前抛错。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/agent-tools.test.ts server/providers/native/skills.test.ts server/providers/native/loop.test.ts`

- [x] **Step 3: 实现过滤与截止**

`filterToolsForProfile` 在完整工具列表上按 `tools` → `disallowedTools` → `mcpServers` 顺序过滤。`runTurn` 在 assistant/history 持久化后、权限前检查截止，复用现有 tool_result emit + history 路径生成 `max turns reached (N); tool not executed`。`NativeSkillCatalog` 不重扫磁盘。

- [x] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。

- [x] **Step 5: 审查并提交**

Commit: `feat(native): filter profile tools and cap turn rounds`

---

### Task 3: 主线程 preset 在 spawn/resume/fork 生效

**Files:**
- Modify: `server/providers/native/native-provider.ts`
- Modify: `server/providers/native/native-session.ts`
- Modify: `server/providers/types.ts`
- Modify: `server/session-manager.ts`
- Test: `server/providers/native/native-session.test.ts`, `server/session-manager.test.ts`

**Interfaces:**
- `NativeSessionOptions.agent?: string`。
- `ProviderSessionHandle.getEffectiveSettings?(): {model:string; permissionMode?:string; effortLevel?:string; agent:string|null}`。
- `NativeSession` 保留 base system/model/permission/effort/skillPolicy/toolProfile 与 current profile；每个 turn 计算 effective system/tools/skills。
- manager 新增 `syncEffectiveSettings(session)`，在 spawn 创建 handle 后调用，同步 SessionInfo 与 broker 可见字段。

- [x] **Step 1: 写失败测试**

- create `agent:'reviewer'` 后首个请求的 system 包含定义 prompt，model 使用定义 model，tools/skills 使用定义策略；日志先有 `session/agent`。
- resume 时 store 中定义已修改，请求仍使用日志 definition/base 快照；fork 切点之后的选择不得泄漏。
- `getEffectiveSettings()` 返回实际 model/permission/effort/agent，manager 的 SessionInfo 与 broker 使用同一 permissionMode。
- 主线程 `maxTurns` 截止时 `runTurn.isError=true` 必须映射到 `turn/end.reason='error'`（正常完成仍为 completed），不能只改 result frame。
- 无 persona 时现有 create-body `SessionToolProfile`、skill policy、model/permission/effort 行为不变。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/native-session.test.ts server/session-manager.test.ts`

- [x] **Step 3: 实现 spawn 状态与恢复**

NativeProvider 传递 `opts.agent`。NativeSession 在 init 前完成选择恢复：新会话从 store 解析并 append 选择；旧日志用最后事件；旧日志无事件走 Task 6 的兼容入口。system 先拼 base+profile.instruction，再拼当前 skill view。完整工具集重建后应用 profile，base toolProfile 与 persona 字段按字段合并（persona 优先）。选择事件只在持久化路径写，不广播 transcript。

- [x] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。

- [x] **Step 5: 审查并提交**

Commit: `feat(native): apply main agent presets at spawn`

---

### Task 4: Turn 间切换、clear 与 base/effective 控制优先级

**Files:**
- Modify: `server/providers/native/native-session.ts`
- Modify: `server/session-manager.ts`
- Modify: `server/providers/types.ts`（仅若 Task 3 未完成该接口）
- Test: `server/providers/native/native-session.test.ts`, `server/session-manager.test.ts`

**Interfaces:**
- `applyFlagSettings` 新增 `agent` key，接受 `string|null`；其它 key 保持原子校验。
- `getEffectiveSettings()` 总是返回下一轮值。
- `setModel` / `setPermissionMode` / `applyFlagSettings({effortLevel})` 更新 base；persona 未 override 对应字段时同时更新 effective。

- [x] **Step 1: 写失败测试**

- 第一个 turn 进行期间切换 agent，当前请求不变，下一轮才使用新 profile，且新选择先于下一轮请求落盘。
- clear agent 后恢复 base system/model/tools/skills/permission/effort。
- persona 固定 model/permission/effort 时，用户控制只改变 base，SessionInfo 仍显示 persona effective；无 override 时 base+effective 同变。
- clear 后不能残留 bypass；manager persist 后 SessionInfo 与 broker 仍一致。
- 修改 base 后发生进程重启，再 clear 时必须恢复**最新** base，而不是最后一次 agent 选择时的旧快照。
- 含不支持字段的 switch 原子失败，不写事件、不改变任何状态。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/native-session.test.ts server/session-manager.test.ts`

- [x] **Step 3: 实现切换与同步**

选择先 append+flush，再更新 current profile；**base 的 model/permission/effort/toolProfile 后续变化也按当前 profile 追加一条新的 base 快照**，因此 resume 后 clear 恢复的是最新 base，而不是旧选择。manager 在 setModel/setPermissionMode/applyFlagSettingAndPersist 成功后调用 `syncEffectiveSettings`。`applyFlagSettings` 在修改任何字段前完成全部 key 和 profile 校验。

- [x] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。

- [x] **Step 5: 审查并提交**

Commit: `feat(native): switch main agent presets between turns`

---

### Task 5: 嵌套 Agent 应用 profile 与权限上下文

**Files:**
- Modify: `server/providers/native/subagent.ts`
- Modify: `server/providers/native/native-session.ts`
- Modify: `server/permission-broker.ts`
- Test: `server/providers/native/subagent.test.ts`, `server/providers/native/native-session.test.ts`, `server/permission-broker.test.ts`

**Interfaces:**
- broker 的 options 类型扩展为 `Parameters<CanUseTool>[2] & {permissionMode?: string}`，统一计算 `mode = options.permissionMode ?? session.permissionMode ?? 'default'` 并用于 acceptEdits/bypass/dontAsk 分支。
- `createAgentTool` 按定义 profile 过滤 nested tools、构造 scoped Skill view、传递 model/effort/maxTurns/permissionMode。
- `NativeSession.streamFor` 接受可选 effort override；嵌套权限经 `canUseTool` context 传递，父 SessionInfo 不变。

- [x] **Step 1: 写失败测试**

- 只读定义在 bypass 下也拿不到写工具；`mcpServers` 只保留指定 server，skills allowlist 不被父 override 复活。
- parent default + nested bypass 可自动放行；parent bypass + nested default 仍产生权限请求，证明没有权限 widening。
- nested effort 覆盖父 effort；未定义时继承。
- `maxTurns:1` 的 nested 最终 tool_use 不执行，父 tool_result 为 `is_error:true`，含截止说明与已有的非空部分报告；sidechain history 配对完整。
- 不支持字段返回错误正文且不发起 nested stream。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/subagent.test.ts server/providers/native/native-session.test.ts server/permission-broker.test.ts`

- [x] **Step 3: 实现嵌套执行**

保留 fresh history、`emitResult:false`、parentToolUseId 和 depth=1。profile 只影响当前 nested run；不得修改父会话的 model/tools/permission/effort。broker 默认不传 options.permissionMode 时行为完全不变。

- [x] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。

- [x] **Step 5: 审查并提交**

Commit: `feat(native): apply profiles to nested agents`

---

### Task 6: 旧 preset 迁移与 restart 保留

**Files:**
- Modify: `server/providers/native/native-session.ts`
- Modify: `server/providers/native/frames.ts`
- Modify: `src/utils/new-like-this.ts`, `src/utils/new-like-this.test.ts`
- Test: `server/providers/native/native-session.test.ts`
- Test-only amendment: `server/session-manager.test.ts`

**Interfaces:**
- `informationalFrame(ctx, text)` 复用现有 `system/informational` 广播白名单。
- legacy fallback 只在没有 `session/agent` 且 `opts.agent` 存在时运行。
- `RestartSessionBody` 增加 `agent?: string`，`buildRestartSessionBody` 携带 `source.agent`。

- [x] **Step 1: 写失败测试**

- 旧日志无选择事件、`SessionMeta.agent` 指向含不支持字段的定义：会话可 resume，实际恢复普通配置，写 `droppedAgent`，发 informational，并同步清空 SessionInfo.agent。
- 旧定义只含支持字段时正常恢复并补写选择事件。
- restart body 保留 agent，Claude/native 普通无 agent 时仍是 undefined。
- 已有选择事件时不得再次执行 legacy fallback。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/native-session.test.ts src/utils/new-like-this.test.ts`

- [x] **Step 3: 实现兼容迁移**

不应用部分 persona。`droppedAgent` 事件记录旧名字和不支持字段；informational 文本列出旧 agent 与字段，manager 通过 `getEffectiveSettings().agent === null` 清除 UI 元数据。

- [x] **Step 4: 重跑测试和两个 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.node.json --noEmit`。

- [x] **Step 5: 审查并提交**

Commit: `fix(native): migrate legacy presets and preserve them on restart`

---

### Task 7: SessionManager E2E、文档与最终门禁

**Files:**
- Create: `server/providers/native/e2e-agent-profile.test.ts`
- Modify: `docs/superpowers/specs/2026-11-11-native-agent-skill-preset-parity-design.md`
- Modify: `docs/superpowers/plans/2026-11-11-native-agent-profile-preset.md`
- Create: `.agents/notes/implemented/architecture/2026-11-11-native-agent-profile-presets.md`

- [x] **Step 1: 写 E2E**

通过真实 SessionManager + scripted native stream 验证：
1. create reviewer → 首个请求的 profile 全字段生效。
2. turn 间切换 → 下一轮生效 → clear 恢复 base permission/effort/model。
3. nested 只读 agent → 无写工具，parent bypass/nested default 仍触发权限。
4. `maxTurns` 最后一轮写工具不执行，主会话可继续下一 prompt。
5. resume/fork 使用日志快照；旧不支持定义可见降级。
6. restart 保留 agent，unsupported create 原子失败。

- [x] **Step 2: 运行 E2E 与回归**

Run: `npx vitest run server/providers/native/e2e-agent-profile.test.ts server/providers/native server/session-manager.test.ts server/permission-broker.test.ts src/utils/new-like-this.test.ts`

- [x] **Step 3: 更新文档**

在 spec 标注阶段 A 已实现，记录 base.toolProfile 补充、broker permissionMode context 和迁移决策，不加入阶段 B/C 的实现声明。plan 记录实际执行决策。

实际执行补充：
- Task 3 将主线程 `runTurn.isError` 映射到 `turn/end.reason='error'`，使 maxTurns 的 result 与日志终态一致。
- Task 4 的 fresh create 使用同步 context+selection seed；运行中选择与 base 更新通过 `appendDurable` 持久化。回滚由当前 writer 拥有，覆盖普通 pending 事件恢复、supersession、close/write-failure 竞争与连续 seq。
- Task 5 的 nested 完整工具快照不受 parent persona 过滤影响，但保留 `baseToolProfile` 上限；nested permission 通过 broker context 覆盖，不写父会话。
- Task 6 除原列文件外还修改 `server/session-manager.test.ts`，把两个旧的“不迁移”resume/fork 断言改为真实 manager 下的支持字段迁移断言。这是 test-only amendment，无 manager production change。
- Task 7 新增 `.agents/notes/implemented/architecture/2026-11-11-native-agent-profile-presets.md`，并把 `npm run verify:agent-notes` 与 `git diff --check` 纳入门禁。
- 最终 whole-workstream review 补足了 durable 初始 flush 的静止基线，以及真实 `/clear` 的 reset-base 读取；显式未定义的 base skill policy 通过独立 reset 标记保留，RAM skillOverride 只在 spawn 后重应用，不写入新 base。

- [x] **Step 4: 全量门禁**

Run: `npm run typecheck && npx vitest run && npm run lint`。任何失败先归因；并行工作流的未提交 RED 不得计入本计划，但必须给隔离证据。

结果：focused 42 files / 1131 tests 全绿；最终 full 711 files / 9973 passed / 8 skipped；四个 typecheck project 与 eslint 通过（eslint 仅 26 个既有 warning）；Agent Note 校验 17 notes OK，`git diff --check` 通过。

- [x] **Step 5: 自审、提交与 controller 最终 review**

本任务对最终 diff 做 self-review，提交 `test(native): cover agent profiles end to end`，只包含 E2E、两份文档和新增 Agent Note。controller 随后运行独立的 final whole-workstream review，并在批准后 push；本任务不派遣 reviewer、不 push，也不提前勾选最终 review。

最终结果：whole-workstream review 的两项 finding 与定向复审的一项 residual 均已修复并复审 Approved；最终门禁全绿后由 controller 提交修复并执行用户授权的 push。
