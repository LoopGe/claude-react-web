# Native 阶段 B：子代理目录、Transcript 与工具角色实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 native 子代理增加可恢复的 descriptor/catalog、standalone transcript、provider-aware REST/WS，以及 Claude 兼容的 Task 别名和 Explore 只读 profile。

**Architecture:** 在单一 `session.v1.jsonl` 中增加 history-only descriptor，并在现有 `(path,size,mtimeMs)` 缓存条目内同步生成目录。provider-level reader 负责 live/dormant/resume/fork 的 list/read，provider-neutral source 复用 Claude 文件 hub 与 native manager fan-out；standalone 读取层统一重投影 parentage、合成稳定 prompt。Agent/Task/Explore 共用 nested runner，Explore 用 `readOnlyHint` 做最后的硬过滤。

**Tech Stack:** TypeScript ESM（`.js` imports）、Node 20、Vitest、现有 Hono/React/WS；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-12-native-subagent-transcript-design.md`

## Global Constraints

- 只做阶段 B：不得加入 `session/skill`、forked Skill、continuable child、launch-time background、自动完成唤醒、插件技能、可配置多层 delegation 或周期 progressSummary。
- 保留单一 native 日志、同步 final-report、depth=1 和 mid-flight detach；不得复制 Claude sidecar 文件布局或 DSH 独立 Session/Cordis/runId。
- native `agentId = toolUseId = taskId` 仅是本 provider 的映射；接口中的 id 是不透明字符串，不得推广为 Claude 的全局身份规则。
- descriptor 在首次 nested 网络请求前 `await appendDurable`；校验/权限/pre-abort/写入失败不得发起请求或留下新目录项。
- 目录与 transcript 读完整日志，不应用主模型 compact floor，不进入主模型 history、普通 history page、搜索或 seq backfill。
- standalone prompt 从原 tool_use 推导，`uuid = 'native-subagent-prompt:' + agentId`；不得新增 durable prompt frame 或重复 final report。
- nested 必须同时移除 Agent 与 Task；Explore 经 `Agent(subagent_type:'Explore')` 调用，不新增 Explore ToolDef。
- Explore 最后只接受 `readOnlyHint === true`；MCP annotation 缺省为 false，Bash/Write/Edit/NotebookEdit 等不得放行，即使 bypass。
- native `supportsSubagentTranscripts` 在 Task 7 验收前保持 false；不得提前开启。
- 每任务先审查完整 diff，只 stage 本任务文件；禁止 `git add -A`、amend、rebase 和未经授权的 push。保留其他会话未提交改动。
- 每个 commit message 末尾添加 `Co-Authored-By: Kimi <noreply@moonshot.cn>`。

## Review Focus

1. **失败调用复活**：descriptor 写入失败或权限拒绝后没有 sidechain，legacy 推导不得把 outer tool_use 重新列为执行记录。Task 1 覆盖失败写入，Task 2 覆盖无证据过滤。
2. **目录不可见/过期**：descriptor-only 追加不产生 renderable line 时仍必须更新目录；compact、fork、同 id 新旧记录不得造成丢失或重复。Task 2 覆盖。
3. **prompt/watch 竞态**：descriptor 前后订阅、descriptor-only 空输出、只有 outer error result、snapshot/live 重叠都必须得到恰好一个稳定 prompt。Task 3/5 覆盖。
4. **standalone 空白或错父子**：assistant、prompt、tool_result 必须在现有 root-only UI 可见，但主 history/SubagentOverlay 的真实 parentage 不得改变。Task 3 覆盖。
5. **角色绕过与 provider 串线**：Task 不得恢复 depth>1，Explore 不得经 MCP/bypass 获得写能力，native 不得误落 Claude reader，慢订阅者不得阻塞 pump。Task 4/5/6 覆盖。

---

### Task 1: Durable descriptor 与 nested 写入顺序

**Files:**

- Modify: `server/providers/native/session-log/format.ts`
- Modify: `server/providers/native/session-log/replay.ts`
- Modify: `server/providers/native/subagent.ts`
- Modify: `server/providers/native/native-session.ts`
- Test: `server/providers/native/session-log/format.test.ts`, `server/providers/native/session-log/replay.test.ts`, `server/providers/native/session-log/fork.test.ts`, `server/providers/native/subagent.test.ts`, `server/providers/native/native-session.test.ts`

**Interfaces:**

- Produces `NativeSubagentDescriptorEvent`，字段严格遵循 spec §4.1；`toolName` 为 `'Agent'|'Task'|'Explore'`，`depth` 为正整数，`profile` 为 detached `NativeAgentProfile|null`。
- `AgentToolDeps.appendDescriptor(input: Omit<NativeSubagentDescriptorEvent,'seq'|'timestamp'>): Promise<NativeSubagentDescriptorEvent>`，由 NativeSession 用 `appendDurable` 实现。
- `createAgentTool(deps, toolName: 'Agent'|'Task' = 'Agent')`；本任务只注册 Agent，Task 参数供 Task 6 复用。

- [ ] **Step 1: 写失败测试**

覆盖：descriptor round-trip 保留 `skills:[]`、Task toolName 和 profile；depth 0、非法 toolName/profile/缺字段抛 `NativeSessionStorageError('corrupt')`。replay 不产生模型 history，fork 保留 toolUseId/parent/profile。runner 测试断言 appendDescriptor resolve 前 stream 调用数为 0，resolve 后才为 1；append reject 时 outer outcome `isError:true` 且 stream 为 0。unknown/unsupported/pre-abort 不 append，NativeSession 权限拒绝也不 append。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/session-log/format.test.ts server/providers/native/session-log/replay.test.ts server/providers/native/session-log/fork.test.ts server/providers/native/subagent.test.ts server/providers/native/native-session.test.ts`
Expected: descriptor variant/appendDescriptor 尚不存在，新增用例 RED。

- [ ] **Step 3: 实现事件与 durable 接线**

strict v1 增加 descriptor 校验，replay 默认忽略，fork 作为普通事件复制。`createAgentTool` 在校验、快照和 pre-abort 后、runTurn 前 await descriptor；descriptor 不经过 emit。失败仅生成现有 outer error tool_result，不能产生 sidechain。

- [ ] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，旧 native runner/format 测试不回归。

- [ ] **Step 5: 审查并提交**

Commit: `feat(native): persist subagent descriptors`

---

### Task 2: 缓存目录投影与 legacy 推导

**Files:**

- Create: `server/providers/native/session-log/subagents.ts`, `server/providers/native/session-log/subagents.test.ts`
- Modify: `server/providers/native/session-log/cache.ts`
- Test: `server/providers/native/session-log/cache.test.ts`

**Interfaces:**

- Produces `NativeSubagentCatalogEntry`：`agentId/parentToolUseId/toolName/label/depth/profile/metadataComplete`，以及内部使用的 `prompt?:string`、`timestamp:string`。
- Produces `NativeSubagentCatalog`：`entries: readonly NativeSubagentCatalogEntry[]` 与 `byId: ReadonlyMap<string,NativeSubagentCatalogEntry>`。
- Produces `buildNativeSubagentCatalog(events: readonly NativeLogEvent[]): NativeSubagentCatalog` 和 `extendNativeSubagentCatalog(previous: NativeSubagentCatalog, appended: readonly NativeLogEvent[]): NativeSubagentCatalog`。
- `NativeHistoryLoad` 新增 `subagents: NativeSubagentCatalog`；full/append parse 共用上述 fold。

- [ ] **Step 1: 写失败测试**

覆盖：descriptor 顺序与 profile；root Agent/Task/Explore + 至少一条 sidechain 才生成 legacy 项；无 sidechain 的 outer tool_use 被忽略。legacy label 缺省 Subagent、profile null、metadataComplete false；descriptor 同 id 优先且不重复。cycle/断链 depth 安全回退。compact 前后目录保持。descriptor-only append 时 `lines` 引用可不变，但 `subagents` 必须更新；delete invalidate 后不返回旧目录。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/session-log/subagents.test.ts server/providers/native/session-log/cache.test.ts`
Expected: catalog/export/cache.subagents 尚不存在，新增用例 RED。

- [ ] **Step 3: 实现纯 fold 与同条目缓存**

新 descriptor 以 descriptor seq 排序，legacy 以 originating tool_use seq 排序。originating tool_use 与 descriptor toolName 交叉校验，不一致按 corrupt 处理。缓存 full/append 同步更新 lines/subagents，freshness 继续只用 path/size/mtimeMs，不用 lines 引用判断目录新鲜度。

- [ ] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，descriptor-only 增量用例证明目录发生变化。

- [ ] **Step 5: 审查并提交**

Commit: `feat(native): project cached subagent catalogs`

---

### Task 3: Standalone transcript reader 与 parent/prompt 投影

**Files:**

- Create: `server/providers/native/subagent-transcripts.ts`, `server/providers/native/subagent-transcripts.test.ts`
- Modify: `src/components/SubagentTranscriptDialog.test.tsx`

**Interfaces:**

- Consumes Task 2 的 `nativeHistoryCache.load(...).subagents` 与 renderable lines。
- Produces `readNativeSubagentTranscript(stateDir:string, sessionId:string, agentId:string): Promise<unknown[]>`。
- Produces `projectNativeSubagentLine(line:RawLine, sessionId:string): unknown|undefined` 和 `nativeSubagentPromptFrame(entry:NativeSubagentCatalogEntry, sessionId:string): unknown|null`，供 Task 5 live source 复用。

- [ ] **Step 1: 写失败测试**

覆盖：unknown id 返回 []；descriptor 有合法 prompt 但无 nested 输出时返回 prompt-only。assistant 变 root，tool_result parent 由自身 tool_use_id 决定；直接对话之外/未来 descendant 不混入。compact 前的 sidechain 仍可读。prompt UUID/正文/timestamp 稳定，final report 不重复。将 native 输出帧送入现有 SubagentTranscriptDialog/MessageList 测试，断言 prompt、assistant、tool result 实际可见，而主 history 输入未被改写。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/subagent-transcripts.test.ts src/components/SubagentTranscriptDialog.test.tsx`
Expected: native reader 不存在，standalone root-only 用例 RED。

- [ ] **Step 3: 实现共享读取投影**

从 cache 选择 `parent_tool_use_id === agentId` 的 durable user/assistant；重投影后调用 Claude 共用 `normalizeSubagentLine`。有真实字符串 prompt 时合成稳定首条 user frame，真实 sidechain prompt 存在时不再合成。未知/无合法 prompt 且无输出才返回 []，读取/解析错误照常抛出。

- [ ] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npm run typecheck`。
Expected: server/client 测试和四个 tsconfig 全部通过。

- [ ] **Step 5: 审查并提交**

Commit: `feat(native): read standalone subagent transcripts`

---

### Task 4: Provider-level list/read 与 manager/REST 解耦

**Files:**

- Modify: `server/providers/types.ts`
- Modify: `server/providers/claude/claude-provider.ts`
- Modify: `server/providers/claude/claude-session.ts`（仅保留兼容委托时需要）
- Modify: `server/providers/native/native-provider.ts`
- Modify: `server/session-manager.ts`, `server/session-manager.test.ts`
- Modify: `server/routes/sessions.ts`
- Create: `server/routes/sessions-subagents.test.ts`

**Interfaces:**

- `ProviderSessionRef = { id:string; cwd:string }`。
- `AgentProvider.subagentTranscripts?: { listSubagents(ref):Promise<string[]>; readTranscript(ref,agentId):Promise<unknown[]> }`。
- Manager 新增 `readSubagentTranscript(id,agentId)` 和 `resolveSubagentTranscriptProvider(id):AgentProvider`；后者供 Task 5 做 capability/source 选择，非 live 时使用 persisted metadata。
- REST wire 保持 `{subagents:string[]}`、`{messages:unknown[]}`。

- [ ] **Step 1: 写失败测试**

覆盖：fake Claude/native provider 在 live 与仅有 store metadata 时均 list/read；未知 session 404、缺 capability 501、reader 缺失 501。Claude 不再 requireLive，native 生产 capability 仍为 false 时 manager 明确拒绝。两个 route 只调用 manager并保留响应形状，不再 import Claude 文件 helper。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/session-manager.test.ts server/routes/sessions-subagents.test.ts`
Expected: provider-level reader/read 方法尚不存在，新增用例 RED。

- [ ] **Step 3: 实现 provider reader 与 manager 解析**

Claude 复用 SDK standalone `listSubagents(sessionId,{dir:cwd})` 和现有文件 reader；Native 调用 Task 2/3 reader，无需 live Query。Manager 统一 provider/capability 解析，list 删除 live-only guard；route 全部经 manager。

- [ ] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，native capability 未提前开启。

- [ ] **Step 5: 审查并提交**

Commit: `feat(providers): resolve subagent transcripts by provider`

---

### Task 5: Provider-neutral live transcript source 与 WS

**Files:**

- Create: `server/subagent-transcript-source.ts`, `server/subagent-transcript-source.test.ts`
- Create: `server/providers/native/subagent-transcript-source.ts`, `server/providers/native/subagent-transcript-source.test.ts`
- Modify: `server/subagent-transcript-hub.ts`, `server/frame-bridge.ts`, `server/frame-bridge.test.ts`, `server/cli.ts`
- Modify: `server/session-manager.ts`, `server/session-manager.test.ts`

**Interfaces:**

- `SubagentTranscriptSource.subscribeSubagentTranscript(sessionId,agentId): SubagentTranscriptSub`，复用现有 `{iterable,unsubscribe}` 与 reset/append frame。
- `ProviderSubagentTranscriptHub` 通过 Task 4 `resolveSubagentTranscriptProvider` 选择 Claude/native source 并完成 capability 检查。
- Native source 接受 `stateDir` 与 `subscribeLive(sessionId,emit): (()=>void)|null`；null 表示 dormant，使用 Task 3 的 reader/projection/prompt。Manager 新增 `subscribeLiveSubagentFrames(id,emit): (()=>void)|null` 作为该 callback 的真实实现：live 时委托现有 live-only `subscribe`，dormant 返回 null，不 resume、不把“未运行”当错误。
- `FrameBridgeDeps.subagentTranscripts` 改为上述 provider-neutral interface，WS wire 不变。

- [ ] **Step 1: 写失败测试**

覆盖：subscribe 先于 snapshot；descriptor 前空 reset 后，stream_event 触发目录重读并先补 prompt；只有 outer error result 也补 prompt。snapshot/live 同 UUID 只出现一次，慢订阅者独立队列不阻塞 pump，dormant 仅 reset 不 resume，unsubscribe/close 停止推送。frame-bridge 选择正确 provider，capability 错误显式返回，Claude 现有 hub 测试保持绿色。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/subagent-transcript-source.test.ts server/subagent-transcript-source.test.ts server/frame-bridge.test.ts server/subagent-transcript-hub.test.ts server/session-manager.test.ts`
Expected: provider-neutral/native source 尚不存在，新增用例 RED。

- [ ] **Step 3: 实现 source/router 与 CLI 接线**

每个 native 订阅者使用独立 async queue。先注册 live listener，再读 snapshot/reset，随后 drain buffer；prompt 状态未决时每个 live frame 都重读目录，发送或确认无合法 prompt 后停止重读。Claude hub 仅做接口适配，completion watcher 不并入。CLI 用 lazy manager/provider resolver 组装 router，避免构造环。

- [ ] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，WS reset/append 协议未变。

- [ ] **Step 5: 审查并提交**

Commit: `feat(native): stream subagent transcripts live`

---

### Task 6: Task 别名与 Explore 只读 profile

**Files:**

- Modify: `server/providers/native/subagent.ts`, `server/providers/native/subagent.test.ts`
- Create: `server/providers/native/explore.ts`, `server/providers/native/explore.test.ts`
- Modify: `server/providers/native/native-session.ts`, `server/providers/native/native-session.test.ts`
- Modify: `server/providers/native/tools/types.ts`
- Modify: `server/providers/native/tools/{read,grep,glob,ls,web-fetch,web-search,skill,task-output}.ts`
- Modify: `server/providers/native/mcp/tools.ts`, `server/providers/native/mcp/tools.test.ts`

**Interfaces:**

- 使用 Task 1 `createAgentTool(deps, toolName)`；NativeSession 同时构造 Agent/Task 两个 ToolDef，nested 移除两者。
- `EXPLORE_AGENT_NAME='Explore'`、`EXPLORE_AGENT_INSTRUCTION='Explore the codebase read-only. Use available read-only tools to answer with concrete file references; do not modify files or run state-changing tools.'`。
- `ToolDef.readOnlyHint?:boolean`，缺省 false；`filterExploreTools(tools:readonly ToolDef[]):ToolDef[]` 只保留 true。

- [ ] **Step 1: 写失败测试**

覆盖：Task 与 Agent 同 schema/runner/descriptor/final-report/detach，descriptor toolName 为 Task，nested 无 Agent/Task 或对应 guidance。Explore 名称大小写精确，store 同名定义不能覆盖；model 可覆盖/默认继承，supportedAgents 包含 Explore。bypass + profile allow + 混合 MCP 下只剩 readOnlyHint true，readOnlyHint false/缺省的 MCP 和 Bash/Write/Edit/NotebookEdit 不可见。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/subagent.test.ts server/providers/native/explore.test.ts server/providers/native/native-session.test.ts server/providers/native/mcp/tools.test.ts`
Expected: Task/Explore/readOnlyHint 尚不存在，新增用例 RED。

- [ ] **Step 3: 实现共享角色与工具元数据**

NativeSession 注册 Task，nested depth 同时移除 Agent/Task。Explore 在 custom store 解析前走内置 profile，最后应用 read-only role filter。只为 spec 允许的只读 builtins 标记 true，MCP 透传 `annotations.readOnlyHint === true`。不增加 Explore ToolDef 或独立 prompt section。

- [ ] **Step 4: 重跑测试和 typecheck**

Run: 同上，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，Stage A profile/权限/maxTurns 测试不回归。

- [ ] **Step 5: 审查并提交**

Commit: `feat(native): add Task and Explore agent roles`

---

### Task 7: 全链路 E2E、capability、文档与最终门禁

**Files:**

- Create: `server/providers/native/e2e-subagent-transcript.test.ts`
- Modify: `server/providers/native/native-provider.ts`
- Modify: `docs/superpowers/specs/2026-11-12-native-subagent-transcript-design.md`
- Modify: `docs/superpowers/specs/2026-11-11-native-agent-skill-preset-parity-design.md`
- Modify: `docs/superpowers/plans/2026-11-12-native-subagent-transcript.md`
- Create: `.agents/notes/implemented/architecture/2026-11-12-native-subagent-transcripts.md`

**Interfaces:**

- 全部前序 reader/source/runner 接口就绪后，才把 NativeProvider `supportsSubagentTranscripts` 改为 true。

- [ ] **Step 1: 写真实 E2E**

使用真实 SessionManager、ProviderRegistry、NativeProvider、PermissionBroker、日志与 SessionConnection/scripted streams，覆盖：

1. Agent descriptor → list/read → resume/fork，id/profile/subtree 稳定；旧无 descriptor sidechain 可推导且去重。
2. descriptor-only prompt、subscribe-before-snapshot、outer error prompt 与重连去重。
3. dormant REST list/read 不 resume，native 不误走 Claude helper，capability 开启后两个 provider 的 route 都正常。
4. Task 后台 detach 后继续 transcript；Explore 在 bypass+MCP 下无写工具，Agent/Task 不恢复 depth>1。
5. descriptor 写失败、unknown agent、permission denial 无请求/无新目录；unknown transcript 为普通空态。

- [ ] **Step 2: 开启 capability 并运行 E2E 与回归**

先运行 Task 1–6 的 focused suites，确认 list/read/watch/role 验收均已绿色；新增真实 native route E2E 在生产 capability 为 false 时应 RED。随后将 NativeProvider `supportsSubagentTranscripts` 改为 true，再运行：

Run: `npx vitest run server/providers/native/e2e-subagent-transcript.test.ts server/providers/native server/session-manager.test.ts server/subagent-transcript-hub.test.ts server/subagent-transcripts.test.ts server/frame-bridge.test.ts src/hooks/useSubagentTranscriptStore.test.tsx src/components/SubagentTranscriptDialog.test.tsx`
Expected: 全部通过；不得用 fixture 伪造生产 capability 来替代这次开启。

- [ ] **Step 3: 更新文档与 Agent Note**

将两份 spec 的阶段 B 标为已实现并链接本详细设计；plan 记录实际决策。Agent Note 按 `.agents/notes/README.md` 记录单日志 descriptor、standalone 投影、provider-neutral source、Explore 比 Claude 更严格的安全取舍，以及未实现的后续能力；先搜索并更新已有 owning note，避免重复。

- [ ] **Step 4: 全量门禁**

Run: `npm run typecheck && npx vitest run && npm run lint && npm run verify:agent-notes && git diff --check`。
Expected: 全部通过；任何并行工作流失败先归因并给隔离证据。

- [ ] **Step 5: 最终 review 与提交**

先派最强可用模型做 whole-workstream review，修复确认发现并 scoped re-review。提交 `test(native): cover subagent transcripts end to end`，只包含本任务实际文件。不得把最终 review/push 预先写成已完成；push 需要用户另行明确授权。
