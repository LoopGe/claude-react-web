# Native 附件结构保真与混合读取实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 native generic file 在 live、resume、fork、UI、search 和 compact 中保留结构化引用，并提供受控文本读取与稳定 PDF document 投影。

**Architecture:** manager 在共享 UploadStore 上解析并验证附件，provider-neutral content 将 resolved occurrence 交给 native；v1 日志仅在首次结构化附件时原子迁移为 v2。canonical history 不保存文件字节，每次 API round 通过异步 projector 生成 handle/document；`modelForm` 和 PDF 预算在首次持久化时固定，避免历史前缀变化。UI/search 使用独立有序投影，compact 使用有界水合和 durable 附件目录 handoff。

**Tech Stack:** TypeScript ESM（`.js` imports）、Node 20、React 19、Vitest/jsdom；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-13-native-attachment-fidelity-design.md`

## Global Constraints

- 在 `main` 上执行，不创建 worktree；保留其他会话的未提交改动，禁止 `git add -A`、amend、rebase 和未经授权的 push。
- 每个 commit message 末尾添加 `Co-Authored-By: Kimi <noreply@moonshot.cn>`；每任务提交前必须 review 完整 diff，最终还需 whole-workstream review。
- `nativeAttachmentFidelity` 在 Task 1 加入且默认 `false`；Task 2–7 的新执行路径只在门内启用，测试可显式开启，生产默认值直到 Task 8 完整验证后才改为 `true`。
- 新 session 默认仍写 v1；只有首次结构化附件才迁移 `header.v=2`。物理文件仍为 `session.v1.jsonl`，不得产生双日志事实来源。
- 浏览器公开 `FileAttachmentRef/FileBlock` 不增加 path/mediaType/modelForm；tool_result 内的 native file block 不向浏览器输出 JSON。
- 每个新 occurrence 都有完整 sha256/size；同一发送中相同 registry id/path 只 hash 一次。旧 handle 不补造 digest。
- `AttachmentRead` 文本上限 2000 行和 64 KiB；PDF 单文件上限 20 MiB；每个 history 分区 PDF base64 上限 28,000,000 字符；session-wide PreparedPdf 原始字节上限 20 MiB、base64 上限 28,000,000 字符。
- compact 文本水合每附件 65,536 字节、每请求 262,144 字节；main+subagent 合并后的 PDF 同样不得超过 28,000,000 base64 字符。
- PDF `modelForm` 一旦持久化不得因配置、预算或新 occurrence 改写；`nativePdfDocuments` 只影响新 occurrence。
- 普通 `Read` 的 cwd 规则、现有 steering 优先级、图片 intake/replay 规则和 Claude handle 形状不变；scheduled sends 继续拒绝 file blocks。
- 非 PDF 且非 UTF-8 binary 不伪装为可理解内容；所有工具/compact 对外错误都去除绝对 path，原始错误只进 server log。
- raw user 只能在 consumption 时持久化，保持 tool_result 紧邻和 raw+skill 相邻；`message-consumed` 只能在 raw append 成功后发送，pendingDurableInitial 必须可 withdraw。
- 每任务只 stage 该任务列出的文件；如实际实现需要新增文件，先更新任务清单并重新 review，不得夹带其他改动。

## Review Focus

1. **持久化与取消竞态**：hash 期间 Stop/delete、consumption append 失败、pending prompt withdrawal。Task 1/3/4 用阻塞 stream 和真实 manager 测试覆盖。
2. **迁移与重启恢复**：writer 在 rename 前已关闭、父目录 fsync 失败、cache 仍按 v1 incremental parse。Task 2 覆盖每个失败点及 full reload。
3. **历史前缀与预算**：新 PDF/AttachmentRead 不得把旧 document 改为 handle；main 与嵌套 Agent 不得错误共享去重域。Task 5 比较连续请求的完整前缀。
4. **不可见或不可导航的附件**：text/file/text、重复 id、Bash early return、折叠体内 chip、tool_result 内部 file block。Task 3/6 覆盖渲染和 search ordinal。
5. **compact 静默数据损失**：attachment-only 空摘要、合并 PDF 超预算、seed flush 失败、Y 已发布后回滚。Task 7 验证原 X 保留且没有 ghost Y。

---

### Task 1: Provider-neutral 附件解析、共享 UploadStore 与发送序列化

**Files:**

- Create: `server/attachment-resolver.ts`, `server/attachment-resolver.test.ts`
- Modify: `server/agent-message.ts`, `server/config.ts`, `server/config.test.ts`
- Modify: `server/bootstrap.ts`, `server/providers/default-providers.ts`, `server/providers/types.ts`
- Modify: `server/session-manager.ts`, `server/session-manager.test.ts`, `server/session-manager-file-blocks.test.ts`, `server/session-manager-steering.test.ts`
- Modify: `server/providers/claude/claude-session.ts`, `server/providers/claude/claude-session.test.ts`
- Modify: `server/providers/native/native-provider.ts`
- Modify: `server/routes/sessions.ts`, `server/routes/sessions-messages.test.ts`, `server/routes/index.ts`, `server/routes/scheduled-sends.test.ts`
- Modify: `server/app-plugins/host/session-adapter.ts`

**Interfaces:**

- 新增 `ResolvedFileAttachment {id,name,size,digest,path,mediaType?}` 与 `ResolvedFileBlock {type:'file',attachment}`；`AgentUserMessage` 的 content 接受 provider-neutral blocks，不再用 `unknown as SDKUserMessage` 绕过 file block。
- `resolveAttachmentContent(content, {sessionId, signal}): Promise<ProviderContentBlock[]>` 验证 id/归属/realpath/普通文件，读取 `%PDF-` 头部，按唯一 registry id/path 流式核对 digest/size，并保留原 block 顺序。
- `nativeAttachmentFidelity: boolean` 默认 false；Claude 在 SDK 边界继续投影现有 `fileHandleText`，native 在功能门内接收 resolved file block，门外沿用旧 handle。
- `SessionManager.send/sendContent` 在同一 per-session op lock 内完成解析、生命周期/interrupt-epoch 复核和 dispatch；所有 HTTP/scheduled/internal callers await。

- [ ] **Step 1: 写失败测试**

覆盖：两个相同 id 的 block 只读取一次但 occurrence 顺序保留；缺失 digest 合法补齐，短/大写 digest、size/digest 不匹配均拒绝；symlink 指向 root 外拒绝，`.pdf` 后缀无 magic 不写 PDF mediaType。阻塞 hash 时后一 plain send 不进入普通队列，Stop abort stream 并释放锁，delete/clear 后无 ack/bubble；queue admission 失败回滚 prompt UUID/snapshot anchor。Claude handle 字节不变，功能门默认 false。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/attachment-resolver.test.ts server/session-manager.test.ts server/session-manager-file-blocks.test.ts server/session-manager-steering.test.ts server/routes/sessions-messages.test.ts server/routes/scheduled-sends.test.ts server/providers/claude/claude-session.test.ts server/config.test.ts`
Expected: resolver 不存在，发送顺序/取消用例 RED。

- [ ] **Step 3: 实现共享 registry 与 resolver**

bootstrap 创建一个 UploadStore 并注入 routes、SessionManager、NativeProvider；不得由 provider 再建独立实例。resolver 使用可取消流，hash 前做 realpath containment，重复 id 共享一次验证结果，所有错误在 dispatch 前抛出。

- [ ] **Step 4: 串行化 send 并保持 provider 边界**

send/sendContent 从入口起持有同一 op lock，捕获 interrupt epoch，解析后复核 session identity/running/terminated/clear generation。prompt UUID 与 snapshot anchor 延迟到解析成功后执行；Claude 只在 SDK 边界转换 handle，native 门内保留结构。

- [ ] **Step 5: 重跑测试与 node typecheck**

Run: 同 Step 2，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，现有 sendBody 的 file 上限和 image 校验不回归。

- [ ] **Step 6: 审查并提交**

Review 完整 diff后，仅 stage 本任务文件。
Commit: `feat(native): resolve structured attachments before dispatch`

---

### Task 2: v2 strict 日志、原子迁移与 cache/fork 恢复

**Files:**

- Modify: `server/providers/native/session-log/format.ts`, `server/providers/native/session-log/format.test.ts`
- Modify: `server/providers/native/session-log/log.ts`, `server/providers/native/session-log/log.test.ts`
- Modify: `server/providers/native/session-log/cache.ts`, `server/providers/native/session-log/cache.test.ts`
- Modify: `server/providers/native/session-log/fork.ts`, `server/providers/native/session-log/fork.test.ts`
- Modify: `server/providers/native/session-log/reader.ts`, `server/providers/native/session-log/reader.test.ts`
- Modify: `server/providers/native/session-log/replay.ts`, `server/providers/native/session-log/replay.test.ts`
- Modify: `server/providers/native/session-log/paths.ts`, `server/providers/native/session-log/paths.test.ts`

**Interfaces:**

- 新增 `NativeFileAttachment extends ResolvedFileAttachment {modelForm:'handle'|'pdf-document'}`、`NativeFileBlock` 和隐藏 `session/attachments {attachments:NativeFileAttachment[],timestamp}`。
- reader 接受 v1/v2；v1 遇 structured file/catalog 为 corrupt，v2 严格验证所有 attachment 字段及 PDF modelForm/mediaType 组合。
- `NativeSessionLog.migrateToV2(): Promise<void>` 串行 drain、close、copy、fsync、rename、目录 fsync、reopen；成功后使 history cache generation 失效并 full reload。
- `historyFromEvents` 保持同步并返回 canonical file blocks；catalog 不进入模型 history、UI、search 或 seq backfill。

- [ ] **Step 1: 写失败测试**

覆盖：纯文本新 session 仍 v1；v2 round-trip、未知字段/非法 digest/modelForm 均 corrupt，旧 handle 可读，旧 parser 对 v2 返回 unsupported-version。writer 在 Windows rename 前关闭；rename 前失败重开 v1，rename 后 fsync/reopen 失败关闭 live session且不接收后续 turn。cache 不沿用 v1 appendParse，fork 保留 seq/uuid/结构，raw-only 前缀不回填。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/session-log/format.test.ts server/providers/native/session-log/log.test.ts server/providers/native/session-log/cache.test.ts server/providers/native/session-log/fork.test.ts server/providers/native/session-log/reader.test.ts server/providers/native/session-log/replay.test.ts server/providers/native/session-log/paths.test.ts`
Expected: v2/parser/migrateToV2 尚不存在，新增用例 RED。

- [ ] **Step 3: 实现版本化 parser 与隐藏 catalog**

header.v 成为实际版本，文件名只作稳定存储 key。严格解析顶层 user 和 tool_result 内的 native file block；公开 history projection 由 Task 3 处理。catalog 只进入授权目录派生，不产生 renderable line。

- [ ] **Step 4: 实现 writer 独占迁移与失效**

migration gate 排队后续 append，先等待 repair/flush 并关闭 handle。rename 前失败必须重开 v1，rename 后任何 fsync/reopen 失败都关闭 live session，禁止在耐久性未知时继续 ack。成功替换后递增 cache generation，后续 append 前 full reload。

- [ ] **Step 5: 重跑测试与 node typecheck**

Run: 同 Step 2，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，阶段 A/B/C 的 descriptor/skill/appendDurable 行为不回归。

- [ ] **Step 6: 审查并提交**

Review 完整 diff 后，仅 stage 本任务文件。
Commit: `feat(native): version structured attachment logs`

---

### Task 3: Canonical projector、结构化 tool_result 与 consumption 持久化

**Files:**

- Create: `server/attachment-access.ts`, `server/attachment-access.test.ts`
- Create: `server/providers/native/attachment-projection.ts`, `server/providers/native/attachment-projection.test.ts`
- Modify: `server/providers/native/loop.ts`, `server/providers/native/loop.test.ts`
- Modify: `server/providers/native/frames.ts`, `server/providers/native/frames.test.ts`
- Modify: `server/providers/native/subagent.ts`, `server/providers/native/subagent.test.ts`
- Modify: `server/providers/native/tools/types.ts`
- Modify: `server/providers/native/native-session.ts`, `server/providers/native/native-session.test.ts`
- Modify: `server/providers/native/session-log/reader.ts`, `server/providers/native/session-log/reader.test.ts`
- Modify: `server/providers/native/subagent-transcripts.ts`, `server/providers/native/subagent-transcripts.test.ts`
- Modify: `server/providers/native/subagent-transcript-source.ts`

**Interfaces:**

- `resolveAuthorizedAttachment(occurrence, {uploadStore,stateDir}): Promise<ResolvedFileAttachment>` 统一 registry/id/name/size/digest/path、realpath root 和普通文件校验，同时覆盖 content-addressed 与 legacy upload roots。
- `nativeFileHandleText(attachment): string` 使用固定条件句式；`projectNativeMessages(history, options, signal): Promise<unknown[]>` 每次 round 返回独立副本，不写回 canonical history。
- `ToolOutcome` 可携带 `content:Array<TextBlock|NativeFileBlock>`；`LoopDeps.persistToolResult(result)` 与 `toolResultFrame` 共享同一 UUID。
- NativeSession 在 consumption 时 append raw user/skill；append 前失败保留 `pendingDurableInitial` 并暂停，append 成功后才发送 consumed。pending 项包含在 clear/drain/cancelQueued withdrawal 中。

- [ ] **Step 1: 写失败测试**

覆盖：file-before-skill 保持 raw→instruction 顺序；连续 tool rounds 不发送 raw `type:'file'`，canonical history 不被 projector 修改。migration/raw append 失败不进入 history、后续输入不能越过，成功前 Stop 能 withdraw；append 后 projection 失败只恢复一次。persisted tool_result 与 UI frame UUID 相同。顶层 file 恢复公开 FileBlock，tool_result file 被省略而 TextBlock 摘要保留，standalone/live subagent 均不泄露 path。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/attachment-access.test.ts server/providers/native/attachment-projection.test.ts server/providers/native/loop.test.ts server/providers/native/frames.test.ts server/providers/native/subagent.test.ts server/providers/native/native-session.test.ts server/providers/native/session-log/reader.test.ts server/providers/native/subagent-transcripts.test.ts`
Expected: projector/结构化结果路径尚不存在，新增用例 RED。

- [ ] **Step 3: 实现授权与 canonical 投影**

resolveAuthorizedAttachment 只信任 registry 当前记录和 approved roots；handle 包含 id/name/size/digest8/path 元数据及固定 AttachmentRead 条件指引，不根据当轮 profile 改写历史。projector 处理顶层和 tool_result 内的 file，PDF 由 Task 5 扩展。

- [ ] **Step 4: 接通 loop、NativeSession 与公开恢复**

ToolOutcome 支持结构内容，runTurn 为每个 result 生成一次 UUID 并同时用于 persist/frame；NativeSession 不再从 text-only frame 重复持久化。pendingDurableInitial 在成功前仍属未配对 prompt，clear/drain/cancelQueued 触发相同 withdrawal/sidecar 清理。公开投影仅对顶层用户 file 生成 FileBlock，tool_result file 整块省略。

- [ ] **Step 5: 重跑测试与 node typecheck**

Run: 同 Step 2，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，现有 steering、skill、subagent live prompt 和 compact floor 不回归。

- [ ] **Step 6: 审查并提交**

Review 完整 diff 后，仅 stage 本任务文件。
Commit: `feat(native): project structured attachment history`

---

### Task 4: AttachmentRead、引用索引与上传删除保护

**Files:**

- Create: `server/attachment-reference-index.ts`, `server/attachment-reference-index.test.ts`
- Create: `server/providers/native/tools/attachment-read.ts`, `server/providers/native/tools/attachment-read.test.ts`
- Modify: `server/upload-store.ts`, `server/upload-store.test.ts`
- Modify: `server/routes/uploads.ts`, `server/routes/uploads.test.ts`
- Modify: `server/bootstrap.ts`
- Modify: `server/providers/native/tools/index.ts`
- Modify: `server/providers/native/explore.ts`, `server/providers/native/explore.test.ts`
- Modify: `server/providers/native/native-session.ts`, `server/providers/native/native-session.test.ts`
- Modify: `server/providers/native/native-provider.ts`

**Interfaces:**

- `createAttachmentReadTool(deps): ToolDef<{id:string;offset?:number;limit?:number}>`，`readOnlyHint:true`，仅接受 upload id。
- 文本读取复用单流 digest 验证和 fatal UTF-8 decoder，默认/上限 2000 行、输出 64 KiB；PDF offset/limit 在读取前拒绝。
- `NativeAttachmentReferenceIndex` 提供 `hasReference(id)`、`acquireLease(id)`、`releaseLease(id)` 和启动重建；引用来自完整 v2 occurrence/catalog，索引不是第二事实来源。
- 删除同时检查 persisted reference 与 in-flight lease；任何引用日志无法读取时相关删除 fail closed。

- [ ] **Step 1: 写失败测试**

覆盖：cwd 外 UTF-8 文本按行分页/截断，digest 在 EOF 前不返回，fatal 非 UTF-8、foreign id、无日志引用、registry/path/digest 不符均失败；realpath/stat/read/Node 原始错误的 path 不出现在 toolResultFrame/search。PDF offset/limit 明确拒绝，Explore 可保留只读工具但普通 Read 规则不变。删除在 hash/queue lease 中返回 409，重启后 dormant 引用仍阻止删除，最后引用/permanent session delete 后允许。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/attachment-reference-index.test.ts server/providers/native/tools/attachment-read.test.ts server/upload-store.test.ts server/routes/uploads.test.ts server/providers/native/explore.test.ts server/providers/native/native-session.test.ts`
Expected: AttachmentRead/index 不存在，新增用例 RED。

- [ ] **Step 3: 实现单流工具与安全错误**

一次流式读取同时 hash、fatal decode 并保留请求窗口，EOF 验证前不输出。整个工具边界 catch 所有 filesystem/decode 错误并映射为 id/name+安全原因，原始错误仅 log。不得通过普通 Read 或任意 path 回退。

- [ ] **Step 4: 实现派生索引和 lease 生命周期**

bootstrap 从所有 native 日志重建索引，append/fork/manual compact handoff/permanent delete 增量维护。send hash 前 acquire lease，native raw append 成功后转为 persisted reference；取消、失败和 Claude dispatch 完成均释放。删除同时检查两类引用。

- [ ] **Step 5: 重跑测试与 node typecheck**

Run: 同 Step 2，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，旧上传下载/删除和 Explore 工具过滤不回归。

- [ ] **Step 6: 审查并提交**

Review 完整 diff 后，仅 stage 本任务文件。
Commit: `feat(native): authorize attachment reads and retention`

---

### Task 5: 稳定 PDF modelForm、预算与原生 document

**Files:**

- Create: `server/providers/native/pdf-documents.ts`, `server/providers/native/pdf-documents.test.ts`
- Modify: `server/providers/native/attachment-projection.ts`, `server/providers/native/attachment-projection.test.ts`
- Modify: `server/providers/native/tools/attachment-read.ts`, `server/providers/native/tools/attachment-read.test.ts`
- Modify: `server/providers/native/native-session.ts`, `server/providers/native/native-session.test.ts`
- Modify: `server/config.ts`, `server/config.test.ts`

**Interfaces:**

- `nativePdfDocuments:boolean` 默认 true，但仅在 `nativeAttachmentFidelity` 门内生效；只影响新 occurrence。
- `PdfBudgetLedger` 按 main/agentId 分区提供同步 `reservePdfBudget(historyKey,size,digest)`、confirm/release；每个分区总量 28,000,000 base64 字符，同 digest 只保留首个 document。
- `PreparedPdfStore` 提供 session-wide 同步预留：未完成原始字节 ≤20 MiB、base64 ≤28,000,000；AttachmentRead 的 PreparedPdf 只被紧随 projection 消费一次。
- document 使用 `{type:'document',source:{type:'base64',media_type:'application/pdf',data},title:name,context:'Upload id: '+id}`；日志只保存 modelForm，不保存 base64。

- [ ] **Step 1: 写失败测试**

覆盖：magic/size/config/预算共同决定首次 modelForm，之后连续 tool round/resume/fork 的历史前缀逐字稳定。两个并发读取同步预留不能超额；main 与 agentId 可各自读取同 digest，同分区重复为 handle。两个 20 MiB PDF 不能同时内联；20 AttachmentRead 不先缓冲 400 MiB。alias 修改后重新验证失败，PreparedPdf 首轮不双读，PDF offset/limit 已拒绝。关闭 nativePdfDocuments 不重写旧 document。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/pdf-documents.test.ts server/providers/native/attachment-projection.test.ts server/providers/native/tools/attachment-read.test.ts server/providers/native/native-session.test.ts server/config.test.ts`
Expected: ledger/document/PreparedPdf 不存在，新增用例 RED。

- [ ] **Step 3: 实现稳定分配与同步预留**

按 canonical history 顺序和原始 block 顺序分配 modelForm，image+PDF 所在 user message 同样受 28M 限制。ledger 按实际 history 分区，预留先于任何 await，persist confirm、失败/interrupt release；compact 后从 floor 重建。

- [ ] **Step 4: 实现验证 document 和一次性 PreparedPdf**

读取时最多保留 20 MiB 原始字节，EOF digest/magic 通过后才编码，无换行 base64。AttachmentRead 先取得分区和 session-wide 预留，再将 TextBlock 摘要+NativeFileBlock 持久化；下一次 projection 消费 PreparedPdf，之后每轮重新读取验证，不维护跨轮缓存。

- [ ] **Step 5: 重跑测试与 node typecheck**

Run: 同 Step 2，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，图片历史不新增本地总量失败，普通文本仍 handle+AttachmentRead。

- [ ] **Step 6: 审查并提交**

Review 完整 diff 后，仅 stage 本任务文件。
Commit: `feat(native): add stable PDF document projection`

---

### Task 6: 有序 UI、附件 chip 与独立 search document

**Files:**

- Modify: `src/utils/file-blocks.ts`, `src/utils/file-blocks.test.ts`
- Modify: `src/components/message-list/MessageView.tsx`, `src/components/message-list/MessageView.split.test.tsx`
- Modify: `src/components/message-list/UserFileAttachments.tsx`, `src/components/message-list/UserFileAttachments.test.tsx`
- Modify: `src/utils/exportConversation.ts`, `src/utils/exportConversation.test.ts`
- Create: `shared/search/segments.ts`, `shared/search/segments.test.ts`
- Modify: `shared/search/extract.ts`, `src/search/__tests__/extract.test.ts`, `src/search/__tests__/alignment.test.ts`
- Modify: `server/session-manager.ts`, `server/session-manager.test.ts`, `server/session-search-index.ts`, `server/session-search-index.test.ts`, `server/history-reader.ts`, `server/history-reader.test.ts`
- Modify: `src/components/MessageList.tsx`, `src/components/MessageList.test.tsx`, `src/components/SessionSearchPreview.tsx`, `src/components/SessionSearchPreview.test.tsx`
- Modify: `src/App.tsx`, `src/components/Chat.tsx`, `shared/message-jump.ts`, `src/components/CommandPalette.test.tsx`
- Modify: `src/session-store/normalize.ts`, `src/session-store/plain-text-lazy.test.ts`, `src/session-store/reducer.ts`, `src/session-store/reducer.test.ts`

**Interfaces:**

- `UserContentSegment = text|image|file` 保留原始 block 顺序；旧 handle 在原位置生成 file segment，chip key 为 upload id+segment index。
- `extractMessageSearchSegments(msg): MessageSearchSegment[]` 保留现有 text/tool_result/tool_use diff/system error 来源，只给真实顶层用户 FileBlock/旧 handle 添加 attachment segment；不跨 segment 匹配。
- server 全局搜索与 `session-search-index` 的 per-session 搜索、snippet、matchCount/matchOrdinal、client 计数和 fold/reveal gate 共用 segments；`MessageJumpTarget` 保留全局 matchOrdinal，canonical `plainText` 的 prompt editing/dedup 职责不变。
- 同一 UUID 的 seq sidecar 与 native replay 只保留一个 bubble；字段更完整的结构化副本不能被低保真 handle 覆盖。

- [ ] **Step 1: 写失败测试**

覆盖：`[text 'before',file F,text 'after']` 按原顺序渲染，重复 id 无 duplicate key；file+bash-input 的 early return 仍显示 chip，导出顺序一致。attachment-only 名称可命中并高亮 chip，foldSearchHit 能展开，text Markdown activeMatchIdx 不偏移；全局 matchOrdinal 经 CommandPalette/App/MessageJumpTarget 传到正确 segment，per-session preview 的本地 ordinal 也正确。tool_result/diff 搜索不回归，AttachmentRead 内部 file 不产生附件名命中但其 TextBlock 摘要可搜索；path/digest/base64/原始文件内容不因引用入索引，last prompt 仅用名称 fallback。sidecar 与 native replay 同 UUID 不重复，handle 不覆盖更完整结构。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/utils/file-blocks.test.ts src/components/message-list/MessageView.split.test.tsx src/components/message-list/UserFileAttachments.test.tsx src/utils/exportConversation.test.ts shared/search/segments.test.ts src/search/__tests__/extract.test.ts src/search/__tests__/alignment.test.ts src/components/MessageList.test.tsx src/components/SessionSearchPreview.test.tsx src/components/CommandPalette.test.tsx src/session-store/plain-text-lazy.test.ts src/session-store/reducer.test.ts server/session-search-index.test.ts server/history-reader.test.ts server/session-manager.test.ts`
Expected: ordered segments/search segments 不存在，新增用例 RED。

- [ ] **Step 3: 实现 ordered UI 投影**

MessageView 在专用 Bash 分支前先拆分 segments，专用 renderer 只消费特殊 text；外层按序渲染 text/image/file。UserFileAttachments 接收 occurrence key 和本地 active 状态，导出复用同一投影。

- [ ] **Step 4: 实现共享 search segments 与导航**

将现有提取来源映射为 text segments并添加顶层附件 segment；全局 SessionManager 和 per-session session-search-index 的计数、snippet 和 ordinal 使用同一实现，禁止简单 join 后跨段匹配。MessageJumpTarget 保留当前被丢弃的全局 matchOrdinal，client 将全局/本地 ordinal 映射为 Markdown activeMatchIdx 或 chip active 状态，fold/reveal gate 同步替换；last prompt 在 history-reader 独立使用名称 fallback，reducer 保留同 UUID 的高保真副本。

- [ ] **Step 5: 重跑测试与双端 typecheck**

Run: 同 Step 2，再加 `npx tsc -p tsconfig.json --noEmit` 和 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，plainText lazy 行为和现有搜索高亮不回归。

- [ ] **Step 6: 审查并提交**

Review 完整 diff 后，仅 stage 本任务文件。
Commit: `feat(native): render and search ordered attachments`

---

### Task 7: Compact 水合、合并预算与 durable handoff

**Files:**

- Create: `server/compact-attachments.ts`, `server/compact-attachments.test.ts`
- Modify: `server/compact-summary.ts`, `server/compact-summary.test.ts`, `server/recap.test.ts`
- Modify: `server/anthropic-api.ts`, `server/anthropic-api.test.ts`
- Modify: `server/providers/types.ts`
- Modify: `server/providers/native/native-session.ts`, `server/providers/native/native-session.test.ts`
- Modify: `server/session-manager.ts`, `server/session-manager.test.ts`
- Modify: `server/routes/sessions-clear.test.ts`

**Interfaces:**

- `getAttachmentOccurrences(): readonly {messageUuid,blockPath:readonly number[],attachment:NativeFileAttachment}[]`；顶层路径 `[contentIndex]`，tool_result 路径 `[outerIndex,innerIndex]`。
- `getAttachmentCatalog(): readonly NativeFileAttachment[]`；`seedCompactSummary(summary,{uuid,timestamp,attachments}):Promise<void>` 在新日志先写 `session/attachments` 再写 summary，并 await 同一 flush。
- compact builder 用 UUID+blockPath join 顶层公开 FileBlock，tool_result 直接使用 provider occurrence；普通文本水合，PDF/image 原生投影，compact-safe handle 不含 path。
- replacement spawn 支持 `deferPublication`；Y 在 durable seed 前不进入可见 session list、不广播 created，失败时 X 保留。
- 含 image/document 的 aux 请求使用 effective model、streaming Messages 和 60 秒无数据超时；纯文本路径不变。

- [ ] **Step 1: 写失败测试**

覆盖：小文本 attachment-only 生成真实摘要；每文件 65,536/总 262,144 字节及截断标记准确，compact-safe handle 无 path。main 20 MiB+subagent 20 MiB PDF 在 compact 副本中去重/限额，超额不读 alias且不改正常 history。缺失/digest/UTF-8 错误或空白摘要均保留 X；未入选 binary 不失败。auto-compact 不写重复目录，手动 handoff 后新日志可 AttachmentRead；seed flush 失败无 session-created/session-cleared/ghost Y。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/compact-attachments.test.ts server/compact-summary.test.ts server/recap.test.ts server/anthropic-api.test.ts server/providers/native/native-session.test.ts server/session-manager.test.ts server/routes/sessions-clear.test.ts`
Expected: compact builder/handoff 不存在，新增用例 RED。

- [ ] **Step 3: 实现异步附件水合与合并投影**

从 provider occurrence 获得 resolved path/mediaType/modelForm，按最新 user message 和 block 倒序分配文本预算，输出保持原顺序。单流 digest 验证仅读取实际入选内容；PDF 在 compact 副本按 merged 顺序和 digest 去重，超额使用无 path safe handle，不改写正常 canonical history。

- [ ] **Step 4: 实现 streaming aux 与 durable replacement handoff**

附件请求使用 effective model 和 60 秒无数据 streaming 调用；附件输入的空白 summary 为错误，不走 plain clear。手动 compact 先取 catalog，deferPublication 创建 Y，await catalog+summary flush 后才发布并交换 X；失败销毁未发布 Y。auto-compact 只保留原 occurrence，不写 O(C×N) 目录。

- [ ] **Step 5: 重跑测试与 node typecheck**

Run: 同 Step 2，再加 `npx tsc -p tsconfig.node.json --noEmit`。
Expected: 全部通过，无附件 compact/recap 的旧模型选择和空白处理不变。

- [ ] **Step 6: 审查并提交**

Review 完整 diff 后，仅 stage 本任务文件。
Commit: `feat(native): preserve attachments during compaction`

---

### Task 8: 真实 E2E、文档与功能门开启

**Files:**

- Create: `server/providers/native/e2e-attachment-fidelity.test.ts`
- Modify: `server/config.ts`, `server/config.test.ts`
- Modify: `CONFIG.md`
- Modify: `CLAUDE.md`
- Modify: `.agents/notes/implemented/architecture/2026-11-06-file-block-handle-projection.md`

**Interfaces:**

- E2E 使用真实 SessionManager、PermissionBroker、UploadStore、NativeProvider、native log 和 scripted streams，不以纯函数测试代替跨层验收。
- 仅当本任务全部 E2E 和回归门禁通过后，`nativeAttachmentFidelity` 默认值才改为 true。

- [ ] **Step 1: 写完整失败 E2E**

一条真实链路覆盖：上传 text/PDF → file-before-skill → live ring/disk/search → AttachmentRead → resume/fork → manual/auto compact → 后续读取。另覆盖旧 v1 handle、重复 id、stop withdraw、delete lease、alias tamper、PDF 预算/history prefix、空白摘要和 seed 失败不丢 X；浏览器输出不得包含 registry path/modelForm/base64 document。

- [ ] **Step 2: 运行 E2E 确认失败**

Run: `npx vitest run server/providers/native/e2e-attachment-fidelity.test.ts`
Expected: 功能门仍关闭或跨层接缝未完整，E2E RED。

- [ ] **Step 3: 修复跨层接缝并开启默认门**

只修复 E2E 证明的问题，不以 fallback 隐藏根因。完整链路通过后把 `nativeAttachmentFidelity` 默认改为 true；CONFIG 说明两个 native 配置、20 MiB/28M/compact 预算、旧日志迁移与 gateway 失败恢复，CLAUDE.md 更新 canonical attachment 投影和删除保护，Agent Note 记录实际实现结果。

- [ ] **Step 4: 运行相关回归**

Run: `npx vitest run server/providers/native/e2e-attachment-fidelity.test.ts server/providers/native/e2e-skill-invocation.test.ts server/providers/native/e2e-persistence.test.ts server/providers/native/e2e-subagent.test.ts server/providers/native/native-session.test.ts server/session-manager.test.ts server/compact-summary.test.ts server/routes/uploads.test.ts src/utils/file-blocks.test.ts shared/search/segments.test.ts`
Expected: 全部通过，阶段 A/B/C 与 Claude 路径不回归。

- [ ] **Step 5: 运行最终门禁**

Run: `npm run typecheck`、`npx vitest run`、`npm run lint`、`npm run verify:agent-notes`、`npx prettier --check CONFIG.md CLAUDE.md .agents/notes/implemented/architecture/2026-11-06-file-block-handle-projection.md`、`git diff --check`。
Expected: 全部通过；环境/并发导致的失败必须归因并隔离复跑，不能用 workaround 掩盖。

- [ ] **Step 6: Whole-workstream review 后提交**

对 `0d3c02c8d5687772b6f3e2d40a11303c37135a3b..HEAD` 加当前 diff 做最终 review，验证并修复所有 confirmed findings；非平凡修复需 scoped re-review。仅 stage 本任务文件。
Commit: `feat(native): enable attachment fidelity`

最终完成声明不得包含未验证的任意 binary 理解、scheduled-send 文件附件、reload-generation 或 push；push 仍需用户另行明确授权。
