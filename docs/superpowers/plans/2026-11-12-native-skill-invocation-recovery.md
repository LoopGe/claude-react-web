# Native 阶段 C：技能调用原始输入与注入恢复实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 native `/name args` 在 live、disk、resume、fork 和搜索中保持原始输入，同时让模型 live/replay 使用同一份 canonical 技能指令。

**Architecture:** 原始 user event 与隐藏 `session/skill` 事件按序写入同一日志，live turn 以两个 user-role 消息进入模型。canonical body 在调用时由当前 effective Skill view 构造并持久化，replay 只读快照。compact 使用 main/subagent 汇总历史加锚定注入的专用投影，不把注入暴露到 UI/search。

**Tech Stack:** TypeScript ESM（`.js` imports）、Node 20、Vitest；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-12-native-skill-invocation-recovery-design.md`

## 实现状态与实际决策

- Task 1–4 已完成并通过各自独立 review；Task 5 的真实 E2E、文档与门禁由本任务交付。
- turn 在首个 await 前冻结完整执行配置和不可变 skill snapshot；reload/persona 只影响下一轮。
- `runTurn` 通过初始消息所有权标记决定由谁追加 history，pre-request 失败后下一 live/resume 使用同一有序输入且只出现一次。
- 手动与自动 compact 都经 `mergedHistoryForCompaction` 投影 durable raw→skill 对，保留 main/subagent context 且不改 UI/search。
- 附件结构保真、跨 reload generation、插件技能和 forked Skill 仍未实现。controller 保留最终 whole-workstream review 与用户授权后的 push，本计划不预先认领。

## Global Constraints

- 只做阶段 C：不得加入任意位置 `/name` 扫描、Context row、注入正文搜索、`:` 命名空间、插件技能、forked Skill、Claude meta-user 协议或 file-block 结构保真。
- 原始 `/name args` 是 UI/search 的唯一用户输入；`session/skill` 不广播、不进入 history page、搜索或 seq backfill。
- `session/skill` 形状固定为 `{type:'session/skill',name:string,body:string,timestamp:string}`，不含 args；replay-v1 中旧 server 必须明确拒绝，不得静默跳过。
- canonical body 为 `Base directory for this skill: <absolute dir>` + 去 frontmatter 正文；`/name` 不重复 args，Skill tool_result 才添加非空 `## User Request` 后缀。
- active persona 的 scoped view 同时约束 `/name` 与 Skill 工具；`supportedCommands()` 使用同一 view。`disable-model-invocation` 与 `user-invocable:false` 的独立语义保持不变。
- live 首次请求和 replay 都按原始 user → canonical instruction 排序，使用同一快照，不根据当前 catalog 重渲染历史。
- pre-request flush 失败不得发起 stream；失败 turn 同时进入内存与 durable 模型 history，后续 live/resume 不分裂、不重复。
- raw-only 崩溃前缀保持原样；raw user 的 fork 切点必须包含紧随的 `session/skill`，不得回填缺失注入。
- 手动与自动 compact 共用 `mergedHistoryForCompaction`，保留 main/subagent frames，并按原始 user UUID 插入隐藏指令。
- 每任务先审查完整 diff，只 stage 本任务文件；禁止 `git add -A`、amend、rebase 和未经授权的 push。保留其他会话未提交改动。
- 每个 commit message 末尾添加 `Co-Authored-By: Kimi <noreply@moonshot.cn>`。

## Review Focus

1. **原始输入再次丢失**：live 保留原文但磁盘仍写展开正文，或只改 replay 漏改 live 初始消息。Task 3 覆盖。
2. **args/frontmatter 重复或漂移**：`/name` 重复 args、Skill 与 `/name` body 不一致、修改文件后历史变化。Task 1/2/3 覆盖。
3. **失败 history 分叉**：pre-request flush 失败后日志含注入而下一 live 请求缺失，或恢复时重复。Task 3 覆盖。
4. **fork/compact 静默丢信息**：raw 切点漏注入、compact 丢 subagent frames 或把注入泄漏到 UI/search。Task 2/4 覆盖。
5. **policy/错误混淆**：persona 排除仍执行、单技能读取失败被当全目录错误、未知技能被当致命错误。Task 1/3/5 覆盖。

---

### Task 1: Canonical body 与 effective scoped Skill view

**Files:**

- Create: `server/providers/native/skill-render.ts`, `server/providers/native/skill-render.test.ts`
- Modify: `server/skills.ts`, `server/skills.test.ts`
- Modify: `server/providers/native/skills.ts`, `server/providers/native/skills.test.ts`
- Modify: `server/providers/native/tools/skill.ts`, `server/providers/native/tools/skill.test.ts`
- Modify: `server/providers/native/native-session.ts`, `server/providers/native/native-session.test.ts`

**Interfaces:**

- `parseSkillFrontmatter()` 的有效返回新增 `body:string`（分隔线后的正文，失败返回可没有 body），不改变既有权限字段。
- `renderNativeSkillBody(input:{directory:string;document:string}): string`，无效 frontmatter 响亮失败，输出 Base directory + 正文。
- `renderNativeSkillToolResult(body:string,args:string): string`，仅非空白 args 添加 `## User Request`。
- `NativeSkillView.expand(name): {name:string;body:string}|null` 返回当前 view 的 canonical invocation；`bodyOf()` 返回 canonical body，不再返回整份 frontmatter 文档。
- `supportedCommands()` 使用 `currentSkillView()`。

- [x] **Step 1: 写失败测试**

覆盖：frontmatter 不进入 canonical body，绝对目录和正文保留；空/空白 args 无工具后缀，非空 args 仅工具路径出现。`/name` expand 与 `bodyOf` 的 body 完全一致且没有 args。persona allowlist 同时影响 expand/bodyOf/supportedCommands，override 不能复活 exclude；`disable-model-invocation` 与 `user-invocable:false` 保持独立行为。旧“返回整份 SKILL.md”断言改为新契约。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/skill-render.test.ts server/skills.test.ts server/providers/native/skills.test.ts server/providers/native/tools/skill.test.ts server/providers/native/native-session.test.ts`
Expected: canonical renderer/expand 尚不存在，新增用例 RED。

- [x] **Step 3: 实现 renderer 与 scoped view**

在现有 frontmatter parser 返回正文，renderer 复用它而不另写 YAML 解析。reload 缓存保留原始 document，view 在调用时基于同一缓存构造 canonical body；工具只负责 args 后缀。`NativeSkillCatalog` 根方法委托对应 policy view。

- [x] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，既有 policy/catalog 测试不回归。

- [x] **Step 5: 审查并提交**

Commit: `feat(native): canonicalize skill invocation bodies`

---

### Task 2: `session/skill` strict 格式、replay 与 fork 切点

**Files:**

- Modify: `server/providers/native/session-log/format.ts`, `server/providers/native/session-log/format.test.ts`
- Modify: `server/providers/native/session-log/replay.ts`, `server/providers/native/session-log/replay.test.ts`
- Modify: `server/providers/native/session-log/fork.ts`, `server/providers/native/session-log/fork.test.ts`
- Test: `server/providers/native/session-log/cache.test.ts`, `server/providers/native/session-log/reader.test.ts`

**Interfaces:**

- `NativeSkillInvocationEvent` 严格为 `{seq,type:'session/skill',name,body,timestamp}`，无 args/UI uuid。
- `historyFromEvents()` 在该位置插入 user-role text body 并关闭 open tool-result group。
- fork 在 raw user 切点包含紧随的 `session/skill`；assistant anchor 不变。

- [x] **Step 1: 写失败测试**

覆盖：round-trip；args 字段、缺 name/body/timestamp、非法类型均 corrupt。模型 history 依次含 raw user+body，body 不被 catalog 重渲染，tool_result 不跨注入合并。history page/cache/search/seq backfill 不出现事件，旧展开 user 不变。raw 切点包含两者，raw-only 前缀不补写，compact 前消失/compact 后正常。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/session-log/format.test.ts server/providers/native/session-log/replay.test.ts server/providers/native/session-log/fork.test.ts server/providers/native/session-log/cache.test.ts server/providers/native/session-log/reader.test.ts`
Expected: 新事件 unknown/corrupt，新增用例 RED。

- [x] **Step 3: 实现 strict 事件与投影**

加入 union/parser，replay 只读 body。renderable cache 不为新事件增加任何 UI 分支；fork 仅对原始 user 后紧邻的 skill 做同组切分，不扫描 catalog 或补全崩溃前缀。

- [x] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，mixed-log 与旧 descriptor 行为不回归。

- [x] **Step 5: 审查并提交**

Commit: `feat(native): persist skill instruction events`

---

### Task 3: Live 双消息输入与失败 history 一致性

**Files:**

- Modify: `server/providers/native/loop.ts`, `server/providers/native/loop.test.ts`
- Modify: `server/providers/native/native-session.ts`, `server/providers/native/native-session.test.ts`
- Modify: `server/providers/native/e2e-skills.test.ts`

**Interfaces:**

- `runTurn` 的 user input 接受 `{role:'user';content:unknown[]}` 或 `readonly {role:'user';content:unknown[]}[]`，内部统一为有序数组；既有 subagent 单消息调用不变。
- NativeSession 每个 turn 先捕获 `turnProfile/turnSkillView`，通过 Task 1 `expand()` 得到一次 invocation，再持久化 raw user + 可选 `session/skill`，并把相同有序消息交给 `runTurn`。
- 若失败发生在 `runTurn` 接管初始消息之前，catch 路径把相同消息追加到内存 history；正常 `runTurn` 路径不得重复追加。

- [x] **Step 1: 写失败测试**

覆盖：live 首次请求依次含原始 `/demo do X` 与 canonical body，磁盘为 raw+skill；ring 仍只有原文。修改技能文件不改变已持久化 body。persona 排除时只有原文，清除后恢复。pre-request flush/catalog 整体失败不发起 stream，下一 live 请求与 resume 都含失败 turn 且只出现一次。单技能读取失败仍为普通文本，整目录失败为 error result。更新旧 P1.4 展开正文断言。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/loop.test.ts server/providers/native/native-session.test.ts server/providers/native/e2e-skills.test.ts`
Expected: live 仍只有展开后的单消息，新增用例 RED。

- [x] **Step 3: 实现双消息 turn 管线**

用原始用户内容替代旧展开内容；命中时 raw 后紧跟 `session/skill`，共享 pre-request flush。显式标记 `runTurn` 是否已接管初始消息，失败 catch 只补未接管部分。不得新增后台渲染或第二次用户广播。

- [x] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，live/disk/resume/fork 与失败 history 一致。

- [x] **Step 5: 审查并提交**

Commit: `feat(native): preserve skill prompts with separate instructions`

---

### Task 4: 手动/自动 compact 的隐藏指令投影

**Files:**

- Modify: `server/providers/types.ts`
- Modify: `server/providers/native/native-session.ts`, `server/providers/native/native-session.test.ts`
- Modify: `server/session-manager.ts`, `server/session-manager.test.ts`

**Interfaces:**

- `ProviderSessionHandle.getSkillCompactionEntries?(): readonly {afterUserUuid:string;body:string}[]`，NativeSession 从 durable raw user→session/skill 对生成；Claude 不实现时行为不变。
- Manager `mergedHistoryForCompaction(session)` 先取现有 `mergedHistory(session)`，再按 afterUserUuid 插入 user-role body；手动 `/compact` 与自动 auto-compact 都调用它。

- [x] **Step 1: 写失败测试**

覆盖：手动和自动汇总输入都保留 main/subagent frames，并在匹配原始 user 后含 canonical body；UI ring/history/search 不含新增项。锚点缺失时不制造孤立注入，Claude 无接口时输入逐字不变。失败 turn 的 durable 注入与内存 history 不被重复加入。

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/native-session.test.ts server/session-manager.test.ts`
Expected: 接口/专用汇总输入不存在，新增用例 RED。

- [x] **Step 3: 实现锚定合并**

NativeSession 按日志顺序配对原始 user 与紧随 skill。Manager 只在汇总副本上插入，不改 ring，不以 provider 主模型 history 替换 main/subagent 输入。两个 compact 调用点共用同一函数。

- [x] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，手动/自动 compact 与 Claude 行为不回归。

- [x] **Step 5: 审查并提交**

Commit: `feat(native): include skill instructions in compaction`

---

### Task 5: 全链路 E2E、文档与最终门禁

**Files:**

- Create: `server/providers/native/e2e-skill-invocation.test.ts`
- Modify: `docs/superpowers/specs/2026-11-12-native-skill-invocation-recovery-design.md`
- Modify: `docs/superpowers/specs/2026-11-11-native-agent-skill-preset-parity-design.md`
- Modify: `docs/superpowers/specs/2026-11-09-native-session-persistence-design.md`
- Modify: `docs/superpowers/plans/2026-11-12-native-skill-invocation-recovery.md`
- Create: `.agents/notes/implemented/architecture/2026-11-12-native-skill-invocation-recovery.md`

**Interfaces:**

- 使用 Task 1–4 的 renderer/event/turn/compaction 真实路径，不新增测试专用协议。

- [x] **Step 1: 写真实 E2E**

通过真实 SessionManager/NativeProvider/scripted streams 验证：

1. `/demo do X` 的 live、disk、search、resume、fork 都保留原文，模型 history 顺序一致。
2. persona allowlist、reload 后下一轮、disable-model-invocation/user-invocable 和未知技能。
3. `/name` 与 Skill 工具共享 body 但 args 不重复；无额外交互 bubble。
4. pre-request 失败的下一 live/resume history 一致，raw-only crash 不回填，raw fork 切点同组。
5. 手动/自动 compact 同时保留 subagent 与隐藏指令，旧展开日志保持原样。

- [x] **Step 2: 运行 E2E 与回归**

Run: `npx vitest run server/providers/native/e2e-skill-invocation.test.ts server/providers/native server/session-manager.test.ts server/skills.test.ts`
Expected: 全部通过，旧 P1.4 互斥断言已更新。

- [x] **Step 3: 更新文档与 Agent Note**

将阶段 C 标为已实现，更新旧 persistence 设计中“原命令搜索丢失是可接受后果”的历史决策。Agent Note 记录 raw+skill 分离、replay-v1 renderer、失败 history 一致性、compact 专用投影和未解决附件/reload generation；先搜索并更新 owning note，避免重复。

- [x] **Step 4: 全量门禁**

Run: `npm run typecheck && npx vitest run && npm run lint && npm run verify:agent-notes && git diff --check`。
Expected: 全部通过；其他工作流失败必须给精确归因和隔离证据。

任务提交仅包含本任务文件，message 为 `test(native): cover skill invocation recovery end to end`；提交前由实现者自审完整任务 diff，不派发 reviewer。

- [ ] **Step 5: Controller 最终 review 与授权 push**

Controller 保留 whole-workstream 最终 review、确认发现的修复与 scoped re-review；用户另行明确授权后才 push。本任务不预先声明这些事项完成，不 amend/rebase。
