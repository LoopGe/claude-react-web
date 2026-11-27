# DSH 与 Claude Code CLI 记忆（memory）系统调研 + CRW native 缺口比对

> 2026-11-27。对象：三方记忆系统实现——**DSH**（`D:\codes\deepseek-harness`）、
> **Claude Code CLI**（pinned SDK 0.3.311 / CLI 2.1.311）、**CRW 本仓**
> （`D:\codes\claude-react-web`）宿主层与 native provider 现状，并逐项比对 native 的记忆缺口。
>
> **版本记录**：全程只读调研，未修改任何源码、未运行构建/测试、未对 DSH 做任何写操作或 pull。
> DSH HEAD 固定在 **`39163dd30f703a79079e2d2446545cff3c453738`**（2026-11-13，merge PR #8422，
> `git log -1` 实测），与 `2026-11-25-dsh-context-size.md` 的 pinned commit 相同；DSH 路径与行号以该 commit 为准。
> CLI 证据来自打包二进制
> `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`（298,870,432 字节；
> SDK `manifest.json`：version **2.1.311**、commit `e7d3b8365a0ffbe2f5dd032feb28e9fd9c7de025`、
> buildDate 2026-10-26），以及 SDK 类型声明
> `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（package.json version **0.3.311**）。
>
> **方法**：DSH 与 CRW 为静态源码调研（file:line 引用）。CLI 是 Bun 编译的 minified bundle，
> 但保留可读函数体与字符串表；证据用 `grep -aob`（0 起字节偏移）+ `tail -c / head -c` 切片提取，
> 非打印字符以 `.` 代替。下文所有 CLI 论断标注为**二进制字符串证据 @偏移**或 **SDK 类型 file:line**，
> 不冒充源码行号。观测到两份字符串拷贝：~123–136 MB 区为 UTF-16 字符串表（切片呈点隔字符），
> ~245–263 MB 区为 ASCII 代码/字面量区；同一事实尽量引 ASCII 区。
> **§4 缺口比对是 CRW 架构分析，不是 DSH/CLI 事实**，逐节标注。搜不到的内容明确写"未定位"，不做推测性补全。

---

## 0. 一句话结论（TL;DR）

- **DSH：没有内置自动记忆系统。** 它有的是三样相邻但不同的东西：AGENTS.md/CLAUDE.md 指令文件加载器
  （`agent-instructions`）、用户显式触发的跨会话引用（`session-reference`，context form 叫 `recall`）、
  以及官方指南推荐的**第三方记忆 MCP 服务器**（Memorix / MCP Reference Memory / Engram，默认全关）。
  记忆的存储、写入、召回全部外包给 MCP 服务器，DSH 只做桥接。
- **Claude Code CLI：完整的自动记忆系统。** per-project 文件式记忆目录（默认
  `~/.claude/projects/<sanitized-cwd>/memory/`）；`MEMORY.md` 索引（每条记忆一行、每会话加载进上下文）
  + 主题文件（frontmatter `name` / `description` / `metadata.type: user | feedback | project | reference`）；
  写入靠系统提示词指示主模型用 Write 等文件工具直接写（另有 `extract_memories` 后台抽取 pass 与
  team/org 共享记忆的 `memory_list/memory_read/memory_write` 工具）；召回是 turn-start supervisor
  （持久化检索索引 + 相关性下限 + top-5，select/synthesize 两模式），以 `relevant_memories` attachment
  注入模型上下文，并镜像为 `system/memory_recall` SDK 帧；**auto-dream** 是 ≥24h 且 ≥5 个会话后触发的
  后台 forked agent，回顾这些会话并整理记忆文件。
- **CRW：宿主层已全备好，claude provider 通路完整；native 缺的是整个"习得记忆"层。**
  settings 持久化 / REST / UI / recall 帧渲染 / fork-resume 携带全部存在；native `supportsMemory: false`
  且 `applyFlagSettings` 拒绝 memory 键。注意区分：native 已通过第七个 host port 实现了 **CLAUDE.md
  指令链**（"instruction memory"），缺的是 CLI 那套 **auto-memory**（存储/写入/召回/整理）——
  两者在 CLI 里也是不同子系统。

---

## 1. DSH：没有自动记忆系统（DSH 事实）

### 1.1 搜索证据（搜过什么、在哪里搜、结果）

在 pinned checkout 的 `apps/`、`packages/` 内（`*.ts` / `*.tsx`，另对 README 补搜 `*.md`）：

| 关键词 | 结果 |
|---|---|
| `autoMemory` / `MEMORY.md` / `memory_recall` / `autoDream` | **0 命中**（apps + packages 全部 ts/tsx） |
| `\bdream\b`（忽略大小写） | 仅 3 个 README 命中，且都指向文档链接而非实现（见下） |
| `\bremember\b` | 全部是缓存/状态记忆语义：`packages/util/values/src/partial-json.ts:209-294`（流式 JSON 视图的 `remember` memo）、`packages/boot/plugin-market/src/detail.ts:140-184`（TTL 缓存）等，无持久记忆写入 |
| `\brecall\b` | 两类：`packages/client/web/src/window-drag/recall.ts`（窗口拖拽重绘标记，无关）；`packages/context/session-reference/`（跨会话引用，见 §1.3） |
| `memory`（忽略大小写，packages 全量） | 80+ 文件命中，逐一抽查均为 in-memory 缓存/存储语义或上述相邻系统；`packages/settings` 内 **0 命中**（无 memory 设置键） |

3 个 README 命中的实际内容（`grep -niE` 实测）：

- `packages/mcp/README.md:43` 与 `packages/mcp/mcp-client/README.md:175` → 指向
  `docs/user/guide/mcp-memory.md`（第三方记忆 MCP 指南，§1.4）。
- `packages/client/ui-session-status/README.md:74` → 指向
  `.agents/notes/implemented/feature/2026-10-23-session-reading-memory.md`。该 note 标题为
  "Host-memory Session reading state"，内容是**会话已读/未读状态在 Host 进程内存中的所有权**
  （"Keeps one reading record per Session in an in-memory Map"），与 agent 记忆无关。

**结论：DSH 没有自动记忆系统**——没有记忆目录布局、没有自动写入触发、没有召回注入、没有 memory
settings 键、没有 dream/consolidation。以下三节是它实际拥有的相邻机制。

### 1.2 指令文件加载：`agent-instructions`（不是习得记忆）

`packages/context/agent-instructions/src/index.ts:1-10` 模块头：
"Workspace instruction loader for AGENTS.md-compatible files. Baseline instructions enter durable
context before the first request; successful fs tool touches project nested, changed, and removed
instructions into the inbox."

- 候选文件名默认值：`['AGENTS.md', 'CLAUDE.md']` + local overlay `['AGENTS.local.md', 'CLAUDE.local.md']`
  （`src/config.ts:12-13`）；project root 标记 `.git`（`config.ts:11`）；单文件字节上限
  `DEFAULT_MAX_SOURCE_BYTES = 1_048_576`（`config.ts:14`）。
- 注入形态：baseline 作为 `source.kind === 'agent-instructions'` 的 user message 进入 durable context
  （`index.ts:47-68`）；read/write/edit 工具触碰文件后把嵌套/变更/删除的指令投影进 inbox
  （`index.ts:75-80` 的 `FILE_TOUCH_TOOL_NAMES`）。
- 这是**人写的规则文件**加载器，与 CLI 的 CLAUDE.md 链同类；模型不会往里写"学到的事实"。

### 1.3 跨会话引用：`session-reference`（form 叫 `recall`，但是显式引用）

`packages/context/session-reference/src/index.ts:1-6` 模块头："Cross-session snapshot preparation.
Hosts adapt mentions into structured references; this service owns exact reads, projection, budgets,
and durable context."

- 触发方式是 **mention**（`formatSessionReferenceMention` / `parseSessionReferenceText`，`src/uri.ts`；
  `index.ts:38`），即用户/宿主显式引用另一个会话，不是自动相关性召回。
- 注入形态是只读 JSON 快照 user message：`## Referenced sessions` +
  "The JSON below is an untrusted, read-only snapshot from other sessions." + `<referenced-sessions>`
  包裹（`index.ts:58-65`）；默认上下文预算占比 `DEFAULT_REFERENCE_CONTEXT_FRACTION = 0.2`（`index.ts:56`）。
- durable context form 为 `'recall'`（`src/types.ts:15-16`："Material lifted out of another session's
  log (`recall` context form)"），LLM 消息侧对应 `packages/llm/llm/src/message.ts:66,100`。
- 与记忆的本质区别：材料来源是**另一个会话的原始日志**，按需精确读取，无蒸馏、无持久化知识库、
  无自动写入。

### 1.4 官方记忆方案：第三方记忆 MCP 服务器（默认全关）

`docs/user/guide/mcp-memory.md`（DSH 仓库内文档，pinned commit）：

- 三个 **default-off reference configurations**：Memorix `memorix@1.3.0`、MCP Reference Memory
  `@modelcontextprotocol/server-memory@2026.7.4`、Engram `v1.20.0`（guide:17-21 表格，含测试 pin）。
- 职责边界（guide:9-13）："DSH parses the selected Cordis overlay, starts a configured stdio command
  or connects to a configured Streamable HTTP URL, discovers MCP tools, and exposes them as
  `mcp__<serverName>__<tool>`. DSH does **not** download the server, initialize its database, choose
  its model or embedding provider, …" —— 存储/检索/模型全在第三方服务器。
- 启用方式：`dsh web --patch …/mcp-memory/<name>.cordis.yml`（guide:27-33）；不 patch 则三者全关。
- 召回/写入触发靠**模型调工具**，可选附加一条 vendor-neutral 指令（guide:66-72）：
  "When the user asks you to remember something, call a memory write tool. When historical information
  may be relevant, search memory and use relevant results."
- 验证流程（guide:74-82）：会话 A 写入 → **新建会话 B** 召回 → 使用；明确"A new DSH session is
  required; a Host restart is not"。
- MCP Reference Memory 的检索是大小写不敏感子串匹配，"does not add embeddings, automatic
  summarization, conflict resolution, or a forgetting policy"（guide:55）。

### 1.5 与 compact / session 生命周期的关系

DSH 没有记忆系统，故不存在"记忆与 compact 的交互"。指令文件（§1.2）走 durable context 投影、
跨会话引用（§1.3）按需读源会话日志，二者都不依赖 compact 产物；记忆 MCP 服务器（§1.4）的持久化
完全在 DSH 进程外，DSH 会话生命周期不触碰其存储。

---

## 2. Claude Code CLI：完整自动记忆系统（CLI 事实）

> 本节每条论断附**二进制字符串证据 @字节偏移**（`claude.exe`，0 起）或 **SDK 类型 file:line**
> （`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）。引文中的 `.` 是非打印字符占位。

### 2.1 Settings 键与开关

三个 flag-settings 键（SDK 类型 `sdk.d.ts:9500-9511`，原文 describe）：

```ts
// sdk.d.ts:9501-9511
/** Enable auto-memory for this project. When false, Claude will not read from or write to the auto-memory directory. */
autoMemoryEnabled?: boolean;
/** Custom directory path for auto-memory storage. Supports ~/ prefix for home directory expansion.
 *  Ignored if set in projectSettings (checked-in .claude/settings.json) for security.
 *  When unset, defaults to ~/.claude/projects/<sanitized-cwd>/memory/. */
autoMemoryDirectory?: string;
/** Enable background memory consolidation (auto-dream). When set, overrides the server-side default. */
autoDreamEnabled?: boolean;
```

二进制证据（ASCII 区，zod settings schema，与 SDK describe 逐字一致）：
`autoMemoryEnabled:()=>M().optional().describe("Enable auto-memory for this project. …")` 等
（**@245958991** 附近切片）。

开关判定链（**@248154679** 附近，函数体可读）：

- `oM()`：`let e=pt(); if(e.autoMemoryEnabled!==void 0) return e.autoMemoryEnabled; return !0`
  —— **settings 未设时默认开**。
- `k_()`：safe mode / `CLAUDE_CODE_SIMPLE` / remote 无 memory dir 等 → `"off"`；
  env `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 真值 → `"off"`，假值字符串 → `"forced_on"`。
- 目录解析 `C_()`（**@248155400** 附近）：按
  `["policySettings","flagSettings",…("localSettings","projectSettings" 条件性)…,"userSettings"]`
  顺序取第一个 `autoMemoryDirectory`；`ud()` 做 `~/` 展开与路径规范化（NFC、去尾分隔符、拒绝非法路径）。
  默认目录即 SDK describe 的 `~/.claude/projects/<sanitized-cwd>/memory/`。
- 相关 env：`CLAUDE_CODE_REMOTE_MEMORY_DIR`（remote 记忆目录）、`CLAUDE_MEMORY_STORES`（team/org
  store 配置）、`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`（**@248154679 / @248155400**）。
- 服务端 GrowthBook flag 参与判定（`tengu_mill_orange`、`tengu_moth_copse`、`tengu_sepia_cormorant`、
  `tengu_linked_cake` 等，**@248154679 / @248155400**）——auto-memory 的部分行为是服务端调控的。

`/memory` 终端对话框的宿主投影 schema（**@247681900–247684300**，"@internal The session's /memory
dialog"）给出运行时状态面：

- `auto_memory: { enabled, toggleable, status }` —— enabled 定义为 "on in settings and not turned off
  by an environment variable, a launch flag, safe mode or the per-model switch"；toggleable 在
  safe mode / per-model kill switch 下为 false。
- `auto_dream: { shown, enabled, toggleable, status, detail }` —— detail 为
  "('running', 'never', 'last ran …'), or empty"；toggleable 在 auto-memory 全关/本会话 held off 时为 false。
- `folders`：kind `auto | team | agent`（"The auto-memory folder, the team memory folder, or one
  agent's memory folder"）。
- `memories`：CLI 自己的记忆扫描列表（"the same listing the memory recall uses"）——
  **MEMORY.md 索引在首位，其余按修改时间新→旧，上限 200 条**；每条携带相对路径、frontmatter
  `description`（可 null）、frontmatter `type`（`user | feedback | project | reference`，可 null）、
  `modified_ms`（frontmatter `modified` 戳优先，否则文件 mtime）。

### 2.2 存储布局

**索引 + 主题文件的两层结构**（系统提示词模板，ASCII 区 **@251249800** 附近，完整可读）：

```
# Memory

You have a persistent file-based memory ${X} Each memory is one file holding one fact, with frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary, used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines.
 Link related memories with [[their-name]].>
```
```

- frontmatter 三字段：`name`（kebab-case slug）、`description`（一行摘要，**召回相关性判定用**）、
  `metadata.type`（四类型枚举；同一枚举在 **@126472774**（UTF-16 表）、**@247682910 / @251214142**
  （数组字面量 `"user","feedback","project","reference"`）重复出现）。
- `feedback` / `project` 类记忆正文后跟 `**Why:**` 与 `**How to apply:**` 行；记忆间用 `[[name]]`
  wiki-link 互联（**@251249800**）。
- **MEMORY.md 索引**：条目格式 `- [Title](file.md) — hook`（**@129603000** UTF-16 表：
  "`- [Title](file.md) — one-line hook`… It has no frontmatter. Never write memory content directly
  into `MEMORY.md`"）；"the index loaded into context each session — one line per memory, no
  frontmatter, never put memory content there"（**@251249800**）；
  "Keep index entries to one line under ~200 chars; move detail into topic files"（**@129615000**）；
  索引有行/字节截断上限（"…lines (limit: … lines and …"，**@129615000**；具体数值未定位）。
  索引超限的服务端拒绝文案："Shorten the index: one short line per memory, with the detail in the
  memory files"（org sync `index_too_large`，**@253280800**）。
- **scope 子目录**（`lVr()`，**@251249800** 尾部）：`user` → 记忆目录根（`Ta()`）；
  `team` → `<记忆目录>/team/<mount>/`（`qS()`）；`account` → `<configDir>/memory/personal/`
  （`tQo()`，**@248155400**）。team/org store 经 `/v1/code/memory/` API 路径同步
  （`Li="/v1/code/memory/"`，**@251135500**），同步失败有分类文案（store full / content_secret /
  content_screened / index_too_large 等，**@253280800**）。org 发现只接受 team scope、强制 ro 等
  （`org-memory-discovery` 日志，**@251173581**）。
- 记忆扫描的可见性规则：`.md` 文件、排除 MEMORY.md 自身与 skills 目录、team mount 过滤
  （`Yf()/O$o()`，**@253575400**）。
- **agent memory 是另一个独立子系统**（不要与 auto-memory 混淆）：SDK `Options.agents[].memory`
  `'user' | 'project' | 'local'` → `~/.claude/agent-memory/<agentType>/` /
  `.claude/agent-memory/<agentType>/` / `.claude/agent-memory-local/<agentType>/`
  （`sdk.d.ts:89-91`；二进制 `dVr()/sm()` **@251273800**）。其入口 MEMORY.md 有工作副本containment
  校验，链接出工作副本则拒读（"agent memory: … leads out of the working copy … its MEMORY.md is
  not read"，**@251273800 / @129615000**）。

### 2.3 写入路径

1. **主模型 + 文件工具（个人记忆的主写入路径）**。系统提示词直接指示：
   - "Your personal memory directory already exists — write to it directly with the Write tool
     (do not run mkdir or check for its existence)"（**@129603000** UTF-16 表）。
   - "Check each user reply for content worth persisting, and when you notice some, save it with …
     in that same reply; read memory whenever earlier project context would help"（**@129603000**）。
   - "## How to save personal memories … Save every memory type in your personal memory directory
     at `…` with the file tools"（**@129603000**）。
   - 索引维护："save it as a document with … then create `/…` with … to hold its one-line pointer"
     （空索引引导文案，**@129615000**）。
   即：**没有个人记忆的专用写入工具**——写入就是普通 Write/Edit 文件操作，由提示词驱动。
2. **`memory_list` / `memory_read` / `memory_write` 工具**（导出常量
   `var Fw="memory_list",qm="memory_read",ku="memory_write"; var yZs=[…]`，**@251120800**；
   字符串表 **@123420120**）。这组工具面向**共享（team/org）记忆**：
   - "You have persistent, shared memory reached through the … tools … It is shared with the other
     people and Claude sessions working in this organization's projects"（**@129603000**）。
   - "Read shared memory whenever earlier project context would help, and persist new learnings to
     your personal memory directory with the file tools"（**@129603000**）——共享与个人分工明确。
   - 多 store 时 "pass an id as the tools' store argument"；工具被 defer 时先用 ToolSearch
   `select:…` 加载（**@129603000**）。
   - `memory_search` 与 `memory_read`/`memory_list` 同在只读工具集合
   `qfi=new Set(["memory_read","memory_list","memory_search"])`（**@248148800**）。
   - 只读会话："If the user asks you to remember something, explain that memory is read-only in
     this session"（**@129615000 / @251249800**）；权限拒绝有专用 reason code
   `'memory_paused'`（"memory is paused for the session"，**@247565000**）。
3. **后台抽取 pass：`extract_memories` / caller `memextract`**。
   - querySource 分类：`s=new Set(["side_question","extract_memories"])`（**@254346400**）；
     `Ve(e){return e==="extract_memories"||e==="local_memory_import"||e==="auto_dream"}`
     —— 这三类 memory-operation 运行的文本在 account-memory 记录中被扣 withheld
     （**@249491400**）。
   - 调用方元数据：`OSe="anthropic/memory.caller", m_="anthropic/memory.pass_id",
     g_="anthropic/memory.cites_event"`，`eQo="memextract"`（**@248153400**）。
   - 配置 schema（服务端下发形态，**@248148800** 附近 `f_`）：
     `every_n_turns`（1–100，**default 5**）、`idle_flush_s`（0–86400，**default 120**）、
     `idle_flush_min_turns`（default 1）、`max_turns`（default 4）、
     `extract_transport: ["tools","text","tools_cached"]`（default "tools"）、
     `person_files_writable` / `people_writable`（default false）、
     `person_files_typed_evidence: ["cited_turn","contiguous"]` 等。
     即存在一个**每 N 轮 / 空闲 flush 的后台记忆抽取机制**，其参数由服务端配置驱动。
     （精确的 dispatch 调用点未在二进制中定位；以上为 schema + querySource + caller 元数据证据。）
4. **auto-dream 的整理写入**：见 §2.5，它是唯一被观测到"批量改写/删除记忆文件"的自动路径。

### 2.4 召回路径

**turn-start supervisor**（入口函数 `ZWs`，ASCII 区 **@257968200** 附近，函数体可读）：

- 门控：`n.memorySelector` 存在、**非 subagent**（`n.agentId` 排除）、querySource 不在排除集
  `$wr=new Set(["extract_memories","auto_dream",…,"prompt_suggestion","compact"])`；
  auto-memory 开（`Xf()`）且 team-store 开关（`Qse()`）或 account recall 开。
- 取**最后一条非 meta 的 user message** 作为查询；纯单词（无空白）查询被跳过，**除非含 CJK 字符**
  （`/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/`，受
  `tengu_mill_orange` flag 门控）——中日韩单字/词查询有专门放行。
- **会话级字节预算**：`Nwr()` 累计历史中所有 `relevant_memories` 与 `account_memory_recall`
  attachment 的 content 长度，达到 `Swn.MAX_SESSION_BYTES` 即停
  （telemetry `memory_recall_select / session_budget_exhausted`；常量数值未定位）。
- 异步 prefetch：返回 promise 供 turn 迭代消费（`consumedOnIteration` 等字段），不阻塞 turn 启动；
  启动时序里有专门的 `memory_recall_wait` / `memory_context_wait` 相位
  （startup-timing schema describe，**@247441800**）。

**检索与相关性判定**（select 模式，**@257911627** 附近）：

- 走持久化检索索引：`searchMemoryFilesWithIndex`（动态 import chunk），返回
  `{ranked, stats}`；stats 含 `docCount / queryTermCount / hitCount / belowFloorCount / topScore /
  relevanceFloor / scanCompleted` 等。
- 索引是 **BM25 风格的 term-posting 倒排索引**（docs/terms/fieldLengths、delta 编码 posting、
  format version 10；增量扫描按 hash+mtime 复用未变文档，**@268510600** 附近）。
- **相关性下限（relevance floor）**：低于 floor 的候选被抑制；零结果有分类原因
  （`below_relevance_floor / no_servable_hits / partially_below_floor / all_filtered /
  index_sweep_incomplete / no_candidates`，telemetry `memory_recall_select`）。
- 候选经 visibility/已注入去重过滤后 **top-5**（`.slice(0,5)`）；frontmatter `description`
  参与相关性（§2.2 模板原文 "used to decide relevance during recall"）。

**注入形态**（**@257968200** 附近 `Fwr()`）：

- 产出 attachment `{type:"relevant_memories", memories:[{path, content, mtimeMs, header, limit}]}`
  —— **content 是文件正文**（读取时截断保护：超限附
  "This memory file was truncated (… byte limit / first … lines). Use the … tool to view the
  complete file at: …"）；account/org 记忆另走 `account_memory_recall` attachment。
- SDK 侧镜像为 `system/memory_recall` 帧（`sdk.d.ts:5559-5582`）：

```ts
// sdk.d.ts:5562-5582（节选）
export declare type SDKMemoryRecallMessage = {
    type: 'system'; subtype: 'memory_recall';
    /** 'select' returns full file bodies chosen by the parallel selector;
     *  'synthesize' returns a Sonnet-authored paragraph distilled from many tiny memories. */
    mode: 'select' | 'synthesize';
    memories: { path: string; scope: 'personal' | 'team' | 'organization'; content?: string }[];
    uuid: UUID; session_id: string;
};
```

  二进制 zod 镜像逐字一致（**@247565000**）；`<synthesis:DIR>` 哨兵路径在 **@128883356 / @247565150**。
  describe 原文："Emitted when the memory recall supervisor surfaces relevant memories into the
  turn. Mirrors the CLI relevant_memories attachment so SDK renderers can show 'Recalled from
  memory' inline."
- **synthesize 模式**：SDK 类型与二进制字符串表均确认其存在（"Sonnet-authored paragraph distilled
  from many tiny memories"，**@128883259**）；**触发阈值/判定代码未在二进制中定位**，不推测。
- select 模式的 file-backed 条目在 SDK 帧里**不带 content**（渲染器按 path 懒加载，
  `sdk.d.ts:5576`）；模型侧拿到的则是 attachment 里的正文（上面 `Fwr()` 证据）——两条消费路径不同。

**MEMORY.md 索引的每会话加载**独立于上述召回：提示词原文 "the index loaded into context each
session"（**@251249800**）、"…is always loaded into your conversation context — lines after … will
be truncated, so keep the index concise"（**@129603000**）。即索引常驻、主题文件按需召回。

### 2.5 auto-dream（后台记忆整理）

核心代码 ASCII 区 **@263520500–263526400**（函数体可读）：

- **触发阈值默认 `se={minHours:24,minSessions:5}`**，可被 GrowthBook `tengu_onyx_plover`
  的 `{minHours,minSessions}` 覆盖（`fe()`）。
- 注册为后台 runner（`Y.of(e).runner=async function(s,i){…}`；精确调用点未定位，/memory schema
  称之为 "background runner"，**@247684300**）。门控链：
  1. auto-memory 有效（`he()`：非 safe mode、`Xf()` 开等）；
  2. 距 `lastConsolidatedAt` ≥ `minHours`（`readLastConsolidatedAt`，**@263216800**）；
  3. scan 节流（上次扫描距今过近则跳过，"scan throttle — time-gate passed but last scan was …s ago"）；
  4. `listSessionsTouchedSince(lastConsolidatedAt)` 列出其后触碰过的会话、**排除当前会话**，
     数量 ≥ `minSessions`（不足则 `tengu_auto_dream_skipped / reason:sessions`）；
  5. 权限规则检查：若现有 permission context 会拒绝记忆写入则跳过
     （"… would refuse memory writes"，`reason:permission_rule`）；
  6. **PID 锁**：锁文件记录 `holderPid + lastConsolidatedAt`，活 PID 持锁则跳过
     （"lock held by live PID …"，**@263216800 / @263520500**）；记忆条目不可读/有更新记录也跳过
     （`items_unreadable / record_newer`）。
- **触发日志**：`[autoDream] firing — ${N.toFixed(1)}h since last, ${f.length} sessions to review`
  + telemetry `tengu_auto_dream_fired {hours_since, sessions_since, team_memory_enabled}`。
- **执行形态**：一次 forked 后台 query —— `querySource:"auto_dream", forkLabel:"auto_dream",
  skipTranscript:!0`，`canUseTool` 带 `{fork:"dream", onWriteAllowed}` 跟踪写入文件
  （**@263524000**）。提示词含会话清单与**工具约束**（原文，**@263520500**）：
  "Shell access is restricted to read-only commands (`ls`, `find`, `grep`, `cat`, `stat`, `wc`,
  `head`, `tail`, and similar) plus deleting `.md` files inside the memory directory (outside
  protected subdirectories like `.git` or `agents`; `rm` takes no flags except `-f`). Anything else
  that writes, redirects to a file, or modifies state will be denied."
  —— dream agent 可读会话材料、可写/删记忆 .md，其余写操作被拒。
- **完成**：统计 `filesTouched`，发 "consolidated N memory file(s)" 通知（verb "Improved"，
  source "dream"），telemetry `tengu_auto_dream_completed`（cache_read/created、output、
  sessions_reviewed、files_touched_count）；用户可中止（"aborted by user"）。
- **失败回滚**：释放/回滚锁时间戳，"next trigger delayed to minHours"（**@263216800**）；
  telemetry `tengu_auto_dream_failed {phase, error_class}`。
- 开关：`autoDreamEnabled` settings 键覆盖服务端默认（`sdk.d.ts:9509-9511`）；
  /memory 对话框有独立 toggle 行与 `tengu_auto_dream_toggled` telemetry（**@134496460**）。

### 2.6 与 compact / session 生命周期的关系

- 记忆是**磁盘文件**、目录按 cwd（sanitized）定位（§2.1），因此 compact / resume / fork 不清空记忆；
  compact 只影响会话上下文，索引下次会话照常加载。
- recall supervisor 的 querySource 排除集显式包含 `"compact"`（**@257968200**）——compact 运行
  本身不触发召回；`extract_memories` / `auto_dream`  likewise 排除。
- auto-dream 的输入是**磁盘上的会话日志**（`listSessionsTouchedSince`），跨会话、跨重启工作；
  锁文件持久化 `lastConsolidatedAt`（§2.5）。
- 未定位到 `/clear` 或会话删除会触碰记忆目录的证据——不做此论断。

---

## 3. CRW 本仓现状（CRW 事实，源码行号）

### 3.1 宿主 settings 层（provider-agnostic，已完整）

- **类型**：`SessionMemorySettings { autoMemoryEnabled?, autoMemoryDirectory?, autoDreamEnabled? }`
  （`shared/session-info.ts:58-68`；注释明确"Applied via Query.applyFlagSettings and re-applied on
  every re-spawn … Persisted via SessionMeta so it survives resume / fork / clear"）。
- **持久化 coercion**：`coerceMemory`（`server/persistence.ts:339-349`，store 读取侧 `:265`）——
  三键白名单、boolean/string 校验、trim、空对象归 undefined。
- **create 入口**：`POST /sessions` body 的 app 级 `memory` 字段校验
  （`server/routes/sessions.ts:252-273`：未知键 400、boolean/string 校验）；
  manager 侧 `memory: coerceMemory(opts.memory)`（`server/session-manager.ts:1920-1923`）。
- **live 设置入口**：`POST /sessions/:id/memory`（`server/routes/sessions.ts:1143-1178`，
  null 清键、控制字符拒绝）→ `SessionManager.setMemorySettings`
  （`server/session-manager.ts:7062-7094`）→ `applyFlagSettingAndPersist`
  （`:7021-7044`：opLock + handle `applyFlagSettings` + 本地 mutate + persist）。
  注意：该调用**未传 capability 参数**，native 的拒绝发生在 handle 内部（§3.5）。
- **spawn 剥离 + post-spawn 重放**：SDK 无 `Options.memory`，manager 在 spawn 前
  `delete sdkOptions.memory`（`server/session-manager.ts:3832-3836`）；claude provider 在 spawn 后
  把三键经 `q.applyFlagSettings(memoryFlags)` 重放（`server/providers/claude/claude-provider.ts:591-608`，
  失败仅 warn）。
- **生命周期携带**：fork 携带 `forkOpts.memory = coerceMemory(meta.memory)`（`:2830-2833`）；
  resume 恢复 `memory: existingMeta?.memory ?? metaSnapshot.memory`（`:3688-3691`）；
  side chat 携带（`:3385-3386`）；clear/fresh-swap 携带（`:5785-5792`）。
- **能力投影**：`ProviderCapabilities.supportsMemory`（`server/providers/types.ts:436-438`，注释：
  "Auto-memory settings (claude's flag-settings memory layer). Native rejects the memory keys in
  applyFlagSettings, so the surface locks."）；`SessionInfo.memorySupported = caps.supportsMemory`
  （`server/session-manager.ts:11876`，`memory` 字段投影 `:11867`）。

### 3.2 客户端 UI（已完整，按能力锁定）

- `SettingsPanel.tsx:629-631`：`memoryLocked = session.memorySupported === false` ——
  native 会话的设置面永久锁定（show-but-disable）。
- 三个控件：auto-memory 开关（`:1302-1322`）、目录输入（`:1331-1336`，commit-drafts 语义）、
  auto-dream 开关（`:1356-1376`），各带"清除回默认"按钮（发 null）；
  提交走 `POST /sessions/:id/memory`（`:651`）。测试：`SettingsPanel.commit-drafts.test.tsx`、
  `SettingsPanel.test.tsx:1237-1419`（locked 行为）。

### 3.3 `memory_recall` 帧通路（已完整，provider-agnostic）

- **durable allowlist**：`'memory_recall'` 在 `BROADCAST_SYSTEM_SUBTYPES`
  （`shared/transcript-format.ts:91`；`server/history-utils.ts:210-218` re-export + broadcast 判定）。
- **disk 读路径**：history-reader `normalize()` 顶层透传 `mode/memories`
  （`server/history-reader.ts:705`；测试 `history-reader.test.ts:549-551`）。
- **可见性**：`shared/message-visibility.ts:39` 不隐藏；
  `src/session-store/normalize.test.ts:288-290`  pin 住可见。
- **渲染**：`src/components/message-list/MessageView.tsx:814` 分支 →
  `src/components/message-list/views/frame-views.tsx:407-474`：
  select file-backed 条目只有 path → 文件名 + scope badge + hover 全路径
  （注释明确"this app deliberately has no memory-file read API"）；synthesize / organization 条目带
  content → markdown；`<synthesis:DIR>` 哨兵渲染为 "Synthesized summary" 卡片；
  折叠阈值 4 / peek 3（`:419-420`）。客户端类型 `src/types.ts:366-375`。
  测试 `MessageList.test.tsx:5094-5230`。
- native 适配层已把 `memory_recall` 列入"适配层负责的 system subtypes"注释
  （`server/providers/native-host-frame-adapter.ts:42`）——但 native core 目前不发此帧（§3.5）。

### 3.4 claude provider 通路：完整

settings 三键 → flag-settings → CLI 自有记忆系统（§2）；CLI 发 `memory_recall` → ring/disk/渲染
（§3.3）。`supportsMemory: true`（`server/providers/claude/claude-provider.ts:381`）。
CRW 自身**不实现**任何记忆存储/写入/召回——全部由 CLI 子进程完成；CRW 也没有记忆文件浏览/读取 API
（frame-views 注释，§3.3）。

### 3.5 native provider：拒绝 memory 键，无习得记忆

- `supportsMemory: false`（`server/providers/native/native-provider.ts:151`）。
- `NativeSession.applyFlagSettings` 的 supported 集合为
  `['skillOverrides', 'effortLevel', 'fastMode', 'agent', 'hooks']`
  （`server/providers/native/native-session.ts:3560-3565`）——memory 三键落入 unknownKeys，
  抛 `native provider does not support flag settings: …`。handle 侧接线存在
  （`server/providers/native-host-frame-adapter.ts:982`），所以拒绝是**响亮的 throw**，不是静默忽略。
- native v3 durable 事件词表 `SessionEventMap`
  （`server/providers/native/vocabulary/session-event.ts:70-145`）共 13 个事件
  （user/message、assistant/message、tool/result、session/context、turn/end、session/end-seed、
  session/compact、session/supplement、session/skill、subagent/descriptor、session/attachments、
  session/agent、session/title）——**没有任何 memory 相关事件**。

### 3.6 native 已有的"指令记忆"（与 auto-memory 区分）

native 已实现 CLAUDE.md 指令链（第七个 host port）：

- `NativeMemoryPort.read(cwd) → { files: {path, scope, content}[], isGitRepo }`
  （`server/providers/native/ports.ts:158-171,186`）；host 侧实现
  `server/providers/native-host-memory.ts`（worktree-aware、per-file 1 MiB cap、mtime 缓存）。
- 每 turn 重读并渲染进 system overlay（`native-session.ts:2447-2455`），
  Context 面板有 "Memory Files" used 行（`:3206-3235`）。
- 决策记录 `.agents/notes/implemented/feature/2026-11-27-native-memory-and-behavior.md`
  的 **Deferred** 节明确列出："Managed enterprise policy memory, **auto-memory**, AGENTS.md,
  additional-working-directories memory — the CLI has them; local single-user usage here does not."
  即 auto-memory 是**已知且被刻意推迟**的缺口，本调研与该 note 一致。

---

## 4. 缺口比对（**分析，非 DSH/CLI 事实**）

> 本节是基于 §1–§3 事实的 CRW 架构分析。分类：
> **(a)** native 完全没有、需新建；**(b)** 宿主已备好、只等 native 实现/解锁；
> **(c)** 需要新协议/事件词（native v3 `SessionEventMap` 或中立词汇）。
> 架构约束前提：native core 是 host-free 中立核（`vocabulary/` 只准 import neutral `shared/*` +
> Node builtins + sibling vocabulary，`neutrality.test.ts` / `host-free.test.ts` pin 住）；
> fs/git/宿主服务一律走 ports，SDK 形状投影一律在 `native-host-frame-adapter.ts`。

### 4.1 逐项比对表

| 维度 | CLI（§2） | DSH（§1） | CRW claude | CRW native | 缺口分类 |
|---|---|---|---|---|---|
| 存储布局 | per-cwd memory 目录 + MEMORY.md 索引 + frontmatter 主题文件；team/org 远端 store | 无（外包 MCP 服务器自管） | CLI 子进程自管，CRW 不触碰 | 无 | **(a)** |
| 写入触发 | 提示词驱动主模型 Write；extract_memories 后台 pass；dream 整理 | 模型调 MCP 写工具（可选指令） | CLI 内部 | 无（Write 工具本身已有，缺提示词/目录/索引约定） | **(a)**；最小路径可复用现有 Write |
| 召回注入 | turn-start supervisor：索引检索 top-5 + floor，relevant_memories attachment；select/synthesize | 无自动召回（MCP search 工具 + 显式 session 引用） | CLI 内部 | 无 | **(a)** 机制；**(b)** 帧渲染 |
| 开关/settings 键 | autoMemoryEnabled / autoMemoryDirectory / autoDreamEnabled（flag-settings） | 无 memory 键（MCP overlay 即开关） | 完整通路 | applyFlagSettings 拒绝三键；UI 锁定 | **(b)** 宿主全备好 |
| 生命周期 | 磁盘记忆不受 compact 影响；recall 排除 compact/extract/dream querySource；dream 跨会话扫日志 | 记忆在进程外，与会话生命周期解耦 | CLI 内部；宿主携带 memory intent 跨 fork/resume/clear | intent 携带已存在但 native 不消费；无记忆可谈生命周期 | **(b)** 携带；**(a)** 其余 |
| UI surface | /memory 对话框（文件行/文件夹行/两 toggle） | MCP 工具面 | settings 三控件 + recall 卡片；无记忆文件浏览 | settings 锁定；recall 卡片代码在但无帧可渲染 | **(b)** |

### 4.2 (b) 类：宿主已备好、只等 native 的部分

1. **settings 全链路**：类型/coercion/REST/持久化/fork-resume-clear 携带/UI 三控件全部
   provider-agnostic（§3.1–3.2）。native 只需：`applyFlagSettings` supported 集合接纳三键
   （或按 native 语义映射）、spawn intent 消费、`supportsMemory` 翻 true。UI 自动解锁，无需新 UI。
   注意 `setMemorySettings` 未传 capability 参数（§3.1），翻 capability 不会改变路由行为——
   拒绝点只在 handle，解锁是单点的。
2. **recall 帧渲染**：`memory_recall` 的 allowlist/disk 透传/可见性/渲染分支全部现成（§3.3），
   且适配层注释已把该 subtype 划给 adapter 负责。native 只要发出形状正确的帧
   （mode/memories/path/scope/content），live 与 disk 回放、select/synthesize 两态渲染全部免费。
   已知限制同样免费继承：select file-backed 条目无 content 时只显示文件名
   （CRW 无记忆文件读 API，§3.3）——若 native 记忆目录在宿主可达路径，未来可补读 API，但那是
   CRW 全局缺口，不是 native 特有。
3. **memory intent 的生命周期携带**：fork/resume/clear/side-chat 已携带 `SessionMeta.memory`
   （§3.1），native 实现后自动继承。

### 4.3 (a) 类：native 完全没有、需新建的部分

按 CLI 的层分解，并给出归属层分析（依据 §3.5–3.6 的 port 先例）：

1. **存储与索引（host 侧）**：记忆目录的 fs 读写、MEMORY.md 索引维护、frontmatter 解析、
   检索索引（若做索引召回）都是宿主关注点——先例是第七 port `NativeMemoryPort`：
   core 只收中立形状、不碰 fs（`native-host-memory.ts` 模式）。目录选址是产品决策：
   CLI 用 `~/.claude/projects/<sanitized-cwd>/memory/`；CRW 若要与 claude 会话**共享**记忆，
   可直接读同一目录（只读兼容），若独立则放 stateDir 下——本调研不做决定，仅指出两条路。
2. **写入触发（core 提示词 + 现有工具）**：最小可行路径是 CLI 的主路径——
   `# Memory` 提示词节（目录、索引格式、frontmatter 约定、"same reply 保存"纪律）+
   现有 Write/Edit 工具。提示词渲染归 core（`prompt/overlay.ts` 先例），目录事实经 port 注入。
   extract_memories 后台 pass 与 team/org 共享记忆是 CLI 的服务端调控高级层，
   对本地单用户 CRW 无现成对应物（无 GrowthBook、无 org API），属于可推迟项。
3. **召回注入（core 时机 + host 检索）**：turn-start 时机归 core（turn 引擎已有 per-turn
   overlay 钩子，§3.6）；候选检索/相关性判定若走索引，索引读写归 host port；
   注入形态需中立词汇表达"被召回的记忆"（见 §4.4）。会话字节预算、querySource 排除
   （compact/子 agent/整理运行不召回）是 core 状态机问题。
4. **auto-dream（core 编排 + host 日志扫描 + aux LLM）**：native 已有 subagent/task 编排与
   `NativeAuxLlmPort`，dream 的"forked 后台 run + 工具约束 + 写入跟踪"在 core 有对应物；
   `listSessionsTouchedSince` 需要跨会话日志扫描，是 host 能力（native 日志在 stateDir，
   宿主可扫）；锁/阈值（24h/5 sessions）是 core 策略。这是最大的一块，CLI 也把它做成
   服务端默认调控——CRW 可最后做。

### 4.4 (c) 类：需要新协议/事件词的部分

1. **durable 事件（§8 验证后降级为可选）**：卡片存活**不依赖 v3 日志**。CRW 的 transcript
   seq store + sidecar 是 provider-agnostic 的 app-only durable 层：凡过
   `isRenderableSdkMessage` 的帧在 live ingest 时即获 seq + sidecar 行；`/history` 分页读
   seq store 而非 provider 日志；冷会话 reconcile 把 sidecar-only 行标 `source:'app'` 并
   保留（backfill 只增不删，ordered rebuild 按旧锚点重插，无 subtype 白名单）。native
   adapter 只要经正常 pump 发出 SDK 形状 `system/memory_recall` 帧，即自动继承整条链路
   （§8.2 逐步证据）。CLI 侧事实同构：CLI 落盘的是 `relevant_memories` attachment，
   `system/memory_recall` 镜像仅流（§7.1）——claude 侧卡片的 disk 回放同样靠 CRW sidecar，
   不靠 CLI JSONL。新事件词（如 `session/memory-recall`，payload：mode + memories 列表，
   配套 v3 parser 校验 + `projectNativeEventToSdkLine` 投影）只在 recall 需进 native
   **canonical 模型历史 / 跨 provider 可移植回放**时才值得做，是可选增强而非卡片存活前提。
2. **中立词汇**：若 core 拥有召回时机/预算/排除逻辑，`vocabulary/` 需要中立的
   memory-recall 形状（path/scope/content/mode），不得 import SDK 类型；
   SDK `memory_recall` 形状只出现在 adapter 投影侧（`native-host-frame-adapter.ts` 先例）。
   若记忆文件内容进模型上下文，还需决定它在中立 `Message`/`ContentBlock` 词汇里的载体
   （attachment 还是 system overlay 段）——CLI 用 attachment，native 现有 overlay 先例是
   system 段（§3.6），两条路都通，需按 prompt-cache 稳定性与历史回放语义选择。
3. **settings 词**：flag-settings 三键本身已是宿主词（`SessionMemorySettings`），
   native core 若消费需中立映射（core 不认 SDK Settings 键名）——小缺口，随 (b)-1 一起解。

### 4.5 与 DSH 路线的对照（分析）

DSH 的选择是**不自建记忆、MCP 外包**（§1.4）。CRW native 已支持 MCP（外部服务器 + 首方工具），
理论上"接一个记忆 MCP 服务器"是零核心改动的替代路线——但那条路得到的是 DSH 式体验
（模型自觉调工具、无自动召回注入、无索引常驻、无 dream），与 CLI 式 auto-memory
（提示词纪律 + turn-start 自动召回 + 后台整理）是**不同产品形态**。
若目标是"native 与 claude 会话体验对齐"，MCP 路线不满足召回注入与 settings 面 parity；
若目标只是"native 能记住东西"，MCP 路线成本最低。本调研不替产品做选择，仅指出两条路的存在与差异。

---

## 5. 搜索证据附录（可复现）

### 5.1 DSH（pinned `39163dd3`）

```
git -C D:/codes/deepseek-harness log -1 --format='%H %ad %s'
grep -rn 'autoMemory|MEMORY\.md|memory_recall|autoDream' apps/ packages/ (--include '*.ts' '*.tsx')  → 0
grep -rniE 'autoDream|\bdream\b|MEMORY\.md|autoMemory' apps/ packages/ (--include ts,tsx,md)
  → 仅 3 README（mcp-memory 指南链接 ×2、session-reading-memory note 链接 ×1）
grep -rni '\brecall\b|\bdream\b|\bremember\b|autoMemory' packages/**/src/**/*.ts
  → partial-json remember / window-drag recall / session-reference recall form（§1.1 表）
grep -rni 'memory' packages/settings/ (--include '*.ts')  → 0
```

### 5.2 CLI 二进制（`claude.exe`，偏移 0 起，`grep -aob`）

| 关键词 | 代表偏移（本文引用处） |
|---|---|
| `autoMemoryEnabled` | 125346264（UTF-16 表）、245958991（zod schema）、248154679（判定链） |
| `autoMemoryDirectory` | 123264060、245959154、248155986（目录解析 C_()/ud()） |
| `autoDream` / `autoDreamEnabled` | 125346292、245959458、263520500（触发/执行）、263216800（锁） |
| `MEMORY.md` | 123420596、248155986（`sM="MEMORY.md"`）、251274746、253281536（sync 文案） |
| `memory_recall` | 247564810（zod 镜像）、257911627（select）、257968944（attachment 构造） |
| `memory_recall_select` / `_wait` | 257911717…257915531、247442660（timing schema） |
| `memory_list/read/write` | 251120800（导出常量）、123420120（表）、248149551（只读集） |
| `extract_memories` | 254347179（querySource 分类）、249492180（withheld 分类） |
| `memextract` | 248154129（caller 元数据）、123420576（表） |
| `relevant_memories` | 124885396（attachment 类型表）、247565670（describe）、257968200 区（构造） |
| `<synthesis:` | 128883356、247565150 |
| `frontmatter` / 类型枚举 | 251249800（# Memory 模板）、126472774、247682910、251214142 |
| `tengu_auto_dream_*` | 263521727…263525760（skipped/fired/completed/failed）、134496460（toggled） |

切片命令形态：`tail -c +$((OFFSET+1)) claude.exe | head -c LEN | tr -c '\11\12\40-\176' '.'`。

### 5.3 未定位项（诚实清单）

- synthesize 模式的触发阈值/判定代码（模式存在由 SDK 类型 + 字符串表证实；§7 补查确认 SDK 镜像构造器 `nn()` 硬编码 `mode:"select"`，synthesize 的触发判定仍未定位）。
- ~~`Swn.MAX_SESSION_BYTES`、索引行/字节截断上限的具体数值。~~ **已解决（见 §7.3）**：`MAX_SESSION_BYTES=61440`（@257919322）；索引截断 `TB=200` 行 / `Hfe=25000` 字节、记忆文件截断 `$fe=4096` 字节 / `QFe=200` 行（@248995404）。
- `extract_memories` 的精确 dispatch 调用点（schema 默认值与 querySource 已证实）。
- auto-dream runner 的精确调用时机（注册形态与门控链已证实）。
- `/clear`/会话删除是否触碰记忆目录（无证据，不做论断）。
- **（§7 新增）个人 MEMORY.md 索引内容注入器的精确门控函数**：已证实索引/提示词层由 `Xf()`（auto-memory 开）门控、与 recall supervisor 的 `Qse()` 门控相分离（§7.2.5），但个人索引内容读取器的完整调用链未逐行追到底（agent-memory 入口读取器 `va()` 已定位 @251268008）。

---

## 6. 来源文件表

| 来源 | 路径 | 用途 |
|---|---|---|
| DSH pinned checkout | `D:\codes\deepseek-harness`（HEAD `39163dd3`） | §1 全部 |
| DSH 指令加载器 | `packages/context/agent-instructions/src/{index,config,files}.ts` | §1.2 |
| DSH 跨会话引用 | `packages/context/session-reference/src/{index,types,uri}.ts` | §1.3 |
| DSH 记忆 MCP 指南 | `docs/user/guide/mcp-memory.md` | §1.4 |
| DSH 已读状态 note（排除项） | `.agents/notes/implemented/feature/2026-10-23-session-reading-memory.md` | §1.1 |
| CLI 二进制 | `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`（2.1.311） | §2 二进制证据 |
| SDK 类型 | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（0.3.311） | §2.1/2.2/2.4 类型引用 |
| SDK manifest | `node_modules/@anthropic-ai/claude-agent-sdk/manifest.json` | 版本记录 |
| CRW settings 类型 | `shared/session-info.ts:58-68` | §3.1 |
| CRW 持久化 | `server/persistence.ts:265,339-349` | §3.1 |
| CRW REST | `server/routes/sessions.ts:252-273,1143-1178` | §3.1 |
| CRW manager | `server/session-manager.ts:1920-1923,2830-2833,3385-3386,3688-3691,3832-3836,5785-5792,7021-7044,7062-7094,11867-11876` | §3.1 |
| CRW capability | `server/providers/types.ts:436-438` | §3.1/3.5 |
| CRW claude provider | `server/providers/claude/claude-provider.ts:381,591-608` | §3.4 |
| CRW native provider | `server/providers/native/native-provider.ts:151` | §3.5 |
| CRW native session | `server/providers/native/native-session.ts:2447-2455,3206-3235,3560-3565` | §3.5/3.6 |
| CRW native ports | `server/providers/native/ports.ts:158-171,186` | §3.6/4.3 |
| CRW native 事件词表 | `server/providers/native/vocabulary/session-event.ts:70-145` | §3.5/4.4 |
| CRW native adapter | `server/providers/native-host-frame-adapter.ts:42,982` | §3.3/3.5 |
| CRW recall 通路 | `shared/transcript-format.ts:91`、`shared/message-visibility.ts:39`、`server/history-reader.ts:705`、`src/types.ts:366-375`、`src/components/message-list/MessageView.tsx:814`、`src/components/message-list/views/frame-views.tsx:407-474` | §3.3 |
| CRW UI | `src/components/SettingsPanel.tsx:629-651,1302-1376` | §3.2 |
| CRW 指令记忆 note | `.agents/notes/implemented/feature/2026-11-27-native-memory-and-behavior.md`（Deferred 节） | §3.6 |
| 结构参考 | `docs/research/2026-11-25-dsh-context-size.md` | 文档体例 |

---

## 7. 追问补查：memory_recall 的 CLI 侧落盘行为与触发门控（2026-11-27）

> 本节回答两个追问：**Q1** CLI 是否把 memory recall 持久化进它自己的会话 JSONL
> （`~/.claude/projects/<slug>/<sessionId>.jsonl`）——是 `system/memory_recall` 行、
> `relevant_memories` attachment 行，还是仅走输出流（stream-only）？**Q2** recall supervisor
> 的触发门控是什么，为何本机 278 个会话零 recall 行、但 MEMORY.md 索引明明每会话加载？
>
> **版本与二进制说明（重要）**：任务给定的偏移锚点（247564810 / 257911627 / 257968944 /
> 124885396 / 248154679 等）经 `grep -aob` 复核，全部落在 **SDK 打包二进制 2.1.311**
> （`D:\codes\claude-react-web\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`，
> 298,870,432 字节，BUILD_TIME `2026-10-26T18:31:42Z` / GIT_SHA `e7d3b836…`，与 §2 版本记录一致）。
> 任务同时给出的全局 npm 二进制
> （`C:\Users\Ge Zelin\AppData\Roaming\npm\…\claude-code-win32-x64\claude.exe`）实测为
> **2.1.322**（346,496,160 字节，`package.json` version 2.1.322），体积与偏移均与锚点不符——
> 锚点不能直接复用于它。因此**本节主证据取自锚点所在的 2.1.311 二进制**，并在 §7.2.6 对
> 2.1.322 做了关键门控的交叉复核（结论一致）。下文偏移除注明外均指 2.1.311，0 起，
> 切片命令形态同 §5.2；引文中 `.` 为非打印字符占位。全部论断为**二进制字符串证据**，不冒充源码行号。

### 7.1 Q1 定论：attachment 形态落盘，system 镜像仅流；本机零存在 = 从未触发，而非不落盘

**结论先行**：recall 的两种候选形态命运不同——
- **(b) `{"type":"attachment","attachment":{"type":"relevant_memories",…}}` 行：代码路径会落盘。**
  它通过持久化过滤器、被路由到 transcript，写入会话 JSONL。
- **(a) `{"type":"system","subtype":"memory_recall",…}` 行：仅流（stream-only），不落盘。**
  它是引擎输出投影里的 "yield-twin" 镜像，机制与 `api_retry`（由 `api_error` 派生、磁盘零存在）完全相同。

本机 278 会话两种行都为零，**不是因为代码跳过落盘，而是因为 recall supervisor 从未触发**（§7.2 门控）。
即属于任务预设的"**落盘但本机从未触发**"情形——一旦门控放行，磁盘上出现的将是 **attachment 行 (b)**，
而不是 system 行 (a)。

#### 7.1.1 relevant_memories attachment 的落盘证据链

1. **构造**：select 编排器 `Lwr()` 末尾产出 attachment（**@257967503**，函数体可读）：
   `return[...ze.length>0?[{type:"relevant_memories",memories:ze}]:[],...st]`；
   `ze` 来自 `Fwr()`（**@257968200** 区）逐文件读取正文（截断保护文案见 §7.3）。
2. **进消息链并 yield**：主 turn 循环把 prefetch 结果并入 `ee.messages` 并逐条 yield
   （**@263714200**）：`if(k.length>0)ee={...ee,messages:[...ee.messages,...k]};for(let Ze of k)yield Ze`。
   非阻塞消费路径同样 yield attachment（**@263786290**）：
   `let M=F0o(Le.screen(await Le.promise,…),…);for(let Q of M){let ce=tn(Q,j);yield ce,ut.push(ce)}`。
3. **持久化入口**：消息经 `XT()`（**@255091529**）→ `insertMessageChain()`（**@255075792**）→
   清洗器 `HDe()`（**@255217609**）：`function HDe(e,n=e){let r=e.filter(bv);…}`——**`bv` 是落盘判定函数**。
4. **`bv` 过滤器**（**@255215649**，全文可读）：
   ```
   function bv(e){
     if(e.type==="progress")return!1;
     if(e.type==="attachment"&&e.attachment.type==="hook_success"&&!…content&&!…stdout&&!…stderr)return!1;
     if(e.type==="attachment"&&QHr()!=="ant"&&Wlo.has(e.attachment.type))return!1;
     if(CVn(e)&&e.attachment.content!==null)return!1;
     if(e.type==="system"&&"persist"in e&&e.persist===!1)return!1;
     return!0
   }
   ```
   逐条对照 `relevant_memories`：
   - 不是 `progress`、不是空 `hook_success`；
   - **`Wlo=new Set([])`（@255215550）是空集**——"外部用户不落盘的 attachment 类型"集合在本 build 为空，
     `Wlo.has(…)` 恒 false，任何 attachment 类型都不经此条被排除；
   - **`CVn()`（@254974106）只匹配 `cowork_memory_context` / `account_memory_recall` 且 `leg==="laptop"`**：
     `return e.type==="attachment"&&(…==="cowork_memory_context"||…==="account_memory_recall")&&e.attachment.leg==="laptop"`
     ——`relevant_memories` 不在其列；
   - 不是 system 帧。
   → **`relevant_memories` 通过 `bv`，返回 `!0`（落盘）**。持久化过滤器区域（255215000–255218000）
   grep `relevant_memories` 零命中，确认无其它排除。
5. **路由到 transcript**：落盘路由表 `_io`（**@254974280**）：
   `{user:"transcript",assistant:"transcript",system:"transcript",attachment:"transcript",progress:"boundary-cleared",…}`
   ——**`attachment:"transcript"`**；查表函数 `kio(e){return _io[e]??"accumulate"}`（**@254975652** 区）。
   `appendEntry()`（**@255081968**）最终 `this.enqueueWrite(L,e,s)` 写入会话文件。
6. **旁证**：任务已实证 `task_reminder / instructions / environment / queued_command` 等 attachment 在磁盘存在——
   它们与 `relevant_memories` 走同一条 turn-start yield → `bv` → transcript 路径，`bv` 对它们同样放行。

#### 7.1.2 system/memory_recall 镜像仅流的证据

1. **镜像构造器 `nn()`**（**@263896476**，全文可读）：
   ```
   function nn(e){if(e.length===0)return;
     return{type:"system",subtype:"memory_recall",mode:"select",
       memories:e.map((s)=>({path:s.path,scope:RUs(s.path)??"personal"})),
       uuid:gr(),session_id:V()}}
   ```
   注意：**硬编码 `mode:"select"`、memories 只带 path+scope、无 content**（与 `sdk.d.ts:5562-5582` 一致）。
2. **唯一调用点是输出投影的 yield-twin**（**@263940233**）：
   `if(h.type==="attachment"&&h.attachment.type==="relevant_memories"){let G=nn(h.attachment.memories);if(G){let{uuid:We,session_id:Ct,...Mt}=G;yield D(Mt)}}`。
   该循环是引擎的 **SDK 输出投影**（snake_case 线上字段：`logical_parent_uuid`/`retracted_message_uuids`/`retry_delay_ms`），
   日志串 `[engine] yield …` / `[engine] yield-twin …` 可证（**@263936600** 区）。
3. **与 api_retry 同机制**：紧邻上一行就是 `api_error`→`api_retry` 的 yield-twin（**@263939889**）：
   `if(h.type==="system"&&h.subtype==="api_error")yield D({type:"system",subtype:"api_retry",…})`。
   `api_retry` 磁盘零存在（任务实证）——证明**此投影路径只产输出流帧、不进持久化消息链**；
   `memory_recall` 镜像与它并列，同理仅流。`thinking_tokens` 镜像（`stream_event` 派生）亦在此路径。
4. **下游消费**：SDK 输出转换器 `sC()` 对 `system/memory_recall` 直接 `yield e`（**@283305485**）；
   终端 REPL 则显式跳过 `if(wt.type==="system"&&wt.subtype==="memory_recall")continue`（**@282074182**，
   与 `thinking_tokens` 并列）——即终端不渲染它，SDK 流把它交给宿主（CRW 的 recall 卡片正消费此帧）。

**Q1 小结**：落盘的是 **attachment (b)**；**system 帧 (a) 是仅流镜像**。"CLI 是否把 recall 持久化"的答案是
**会（以 attachment 形态）**，本机零存在归因于 §7.2 的触发门控，而非落盘路径缺失。

### 7.2 Q2 门控：个人文件召回被 `Qse()`（服务端 flag / 环境变量）二次把关

#### 7.2.1 supervisor 入口门控链（`ZWs`，@257969742，函数体可读）

```
function ZWs(e,n,r,s){
  let h=n.memorySelector;
  if(!h||n.agentId||$wr.has(r))return;                 // ① selector 存在 ② 非 subagent ③ querySource 不在排除集
  let y=Xf()&&Qse(),                                    // ④ 个人召回：auto-memory 开 且 Qse()
      S=mEe?.isAccountRecallOn()===!0&&!cCt();          // ⑤ account/org 召回（另一子系统）
  if(!y&&!S)return;
  let w=e.findLast((Ie)=>Ie.type==="user"&&!Ie.isMeta);if(!w)return;   // ⑥ 有非 meta user 消息
  let L=Fh(w);if(!L)return;
  if(!/\s/.test(L.trim())&&!(cCt()&&/[\u3040-\u30FF…]/.test(VW(L))))return;  // ⑦ 多词查询（CJK 单词需 flag）
  let z=Nwr(e);
  if(z.totalBytes>=Swn.MAX_SESSION_BYTES){f("memory_recall_select","session_budget_exhausted");return}  // ⑧ 会话字节预算
  …Lwr(…,y,q)…                                          // y 作为第 13 参传入，门控个人文件检索
}
```
- `memorySelector` 恒被创建（`jde()` 返回 `{stateByDir:{},lastUsage:null}`，toolUseContext 装配处
  `memorySelector:jde()` **@256871157**），**不是**可变门控。
- `$wr=new Set(["extract_memories","auto_dream",fke,"prompt_suggestion","compact"])`（**@257969200** 区），
  其中 `fke="memdir_relevance"`（**@256289084**）——即 select 自身的 LLM 调用 querySource 也被排除，防递归。
- `y` 传入 `Lwr` 后作为 `ke` 门控个人目录检索（`Ce=ke&&!(…)`，**@257967503**）——**个人文件召回确需 `y`**。

#### 7.2.2 决定性门控 `Qse()`：服务端 GrowthBook flag 或环境变量

**@248155351**（全文可读）：
```
function Qse(){if(E("tengu_moth_copse",!1))return!0;return OXr()}
function OXr(){return!!process.env.CLAUDE_MEMORY_STORES?.trim()}
```
即 **`Qse() = GrowthBook("tengu_moth_copse", 默认 false) 为真 OR 环境变量 `CLAUDE_MEMORY_STORES` 非空`**。
- `E()` 是 GrowthBook 取值器（**@248983640**）：`function E(e,n){return bn(e,n).value}`，
  `bn(e,n){return ze().getFeatureValueWithSource(e,n)}`（**@248983609** 区）；GrowthBook 基础设施字符串
  （`getFeatureValue_CACHED_WITH_REFRESH`/`refreshGrowthBookFeatures` 等）在 **@125420156** 区可证。
- **`tengu_moth_copse` 默认 `!1`（false）**，是服务端下发的 rollout flag；`CLAUDE_MEMORY_STORES` 是 team/org
  store 配置环境变量（§2.1 已列）。**二者本机皆无 → `Qse()` 返回 false → `y=false` → 个人文件召回永不启动。**
  这就是"索引每会话加载、top-5 召回却零触发"的**单一根因**。
  **取值格式补正（§9.1 实测）**：`Qse()` 只查非空，但 store 解析器 `parseMemoryStoresEnv` 要求
  **合法 JSON 数组**（元素 `{mount,path,mode,promptIndex?}`）；置 `"1"` 能过 `Qse()` 却解析失败
  （debug 日志 `expected array, received number`），置 `"[]"` 才是有效的"开门且无额外 store"值。

#### 7.2.3 `Xf()`（auto-memory 总开关）判定链

**@248154141**：`function Xf(){if(O6())return!1;return D9()}`；
`O6(){return sI()||uve()}`——`sI()=sessionFlags.memoryToggledOff()`（/memory 会话级关闭，**@245059803**）、
`uve()=sessionFlags.autoMemoryOffThisSession()`（**@245060068**）。
`D9()`：`k_()` 返回 off→false / forced_on→true / unset→继续；`if(uCt())return!1`（per-model kill switch）；
`return oM()`（settings `autoMemoryEnabled ?? true`）。
- `k_()`（**@248154939**）：`Hr()`=safe mode（`CLAUDE_CODE_SAFE_MODE`/`--safe-mode`，**@245096594**）、
  `Ik()`=restrictedSession（**@245059126**）、`Y()`=diskless（**@245074077**）任一→off；
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 真值→off、假值字符串→forced_on；`A_()`（`CLAUDE_CODE_SIMPLE` / remote 无
  memory dir）→off。
- `uCt()` per-model kill：`E("tengu_sepia_cormorant",null)` 模型名单命中当前模型 且 `E("tengu_umber_petrel",!1)`
  →true→关闭（**@248155303** 区）。
- **本机 `Xf()` 为 true**（settings 未设、默认开，索引加载可证）——所以卡点不在 `Xf()`，而在 `Qse()`。

#### 7.2.4 其余门控（补充，非本机根因）

- **多词查询**：`!/\s/.test(L.trim())` 的单词查询被跳过，**除非** `cCt()`（`E("tengu_mill_orange",!1)`，
  **@248155303**）为真且含 CJK 字符（§2.4 已述）。本机即便 `Qse()` 放行，单词 query 仍不召回。
- **会话字节预算**：`Nwr()` 累计历史中 `relevant_memories`+`account_memory_recall` 的 content 长度，
  `Swn.MAX_SESSION_BYTES=61440`（**@257919322**，§7.3）。
- **阻塞等待门控**：`ezs(){return cCt()&&!IVo()&&!(dKe()&&pS().state==="undecided")}`（**@257969742** 区）——
  仅当 `tengu_mill_orange` 开才在 turn-start 阻塞等待（`Hwr=2000`ms deadline，`tzs()`）；否则 prefetch 在
  后续迭代非阻塞消费（@263786290）。**不改变"是否召回"，只改变"何时注入"。**
- **无记忆文件数量阈值**：`ZWs`/`Lwr` 无最小文件数门控；目录为空仅产 `no_candidates` telemetry。
  （`minSessions:5` 是 auto-dream 的阈值，§2.5，与 recall 无关。）
- select 检索的零结果分类 telemetry（`memory_recall_select`，**@257911400** 区）：
  `index_sweep_incomplete / no_candidates / below_relevance_floor / no_servable_hits / partially_below_floor /
  all_filtered / index_query_failed / none_visible / all_surfaced / output_truncated / no_text_block /
  selector_model_fell_back / every_selector_model_refused / memory_recall_select_query_failed / session_budget_exhausted`。
  select 除索引检索外还有一个 **LLM selector**（`jbr()`，querySource=`memdir_relevance`，JSON schema
  `selected_memories`，主模型 + 至多 2 个 sonnet 降级，`Wbr=2`）。

#### 7.2.5 索引加载与 recall 的关系：两层，门控不同

- **索引/提示词层**：`eyn()`（memory 提示词节构建器，**@251269398** 区）门控为 `let h=Xf()&&!gZ()`——
  **只需 auto-memory 开（`Xf()`），不需要 `Qse()`**。索引内容以 `## MEMORY.md` 段注入
  （`C.push(\`## ${Yf}\`,"",Mse(O.content))`，**@251268608** 区；`Yf="MEMORY.md"`），截断上限见 §7.3。
  这解释了**本机当前会话为何加载了 MEMORY.md 索引**（system-reminder 进首条 user 消息）。
- **召回 supervisor 层**：`ZWs` 需 `Xf()&&Qse()`（§7.2.2）——**多出的 `Qse()` 正是两层分野**。
- 旁证：`eyn` 内 `let X=Qse()` 被用作 `personalSkipIndex`/`skipIndex`，但 `pa()`（**@251248046**）中
  `skipIndex` 只控制"写文件后往 MEMORY.md 加一行指针"的**提示词文案**（`Z=s||j,se=Z?"":"After writing the file, add a one-line pointer…"`），
  不决定索引内容是否加载——进一步说明索引加载与 recall 的 `Qse()` 门控是两回事。

#### 7.2.6 跨版本复核（2.1.322 全局二进制）与本机根因

在全局 **2.1.322** 二进制中复核关键门控（minified 名不同，结构一致）：
- `Qse` 对应 `Twe()`（**@292177356**）：`if(k("tengu_moth_copse",!1))return!0;return nUs()`，
  `nUs(){return!!process.env.CLAUDE_MEMORY_STORES?.trim()}`——**同一 flag、同一默认 false**。
- supervisor 门控（**@302554973**）：`let y=Ih()&&Twe(),S=dDe?.isAccountRecallOn()===!0;if(!y&&!S)return;…`
  ——个人召回仍需 auto-memory 开 **且** `Twe()`（=`Qse`）。
- `MAX_SESSION_BYTES:61440`（**@302498993**）不变。
- （差异：2.1.322 该处查询门控为 `if(!N||!/\s/.test(N.trim()))return`，未见 2.1.311 的 CJK 单词放行分支，
  account 召回门控也去掉了 `&&!cCt()`——属版本演进，不影响"个人召回需 `Qse`"的结论。）

**本机根因定论**：`tengu_moth_copse` 为服务端 GrowthBook flag（默认 off，本机账号未命中），
`CLAUDE_MEMORY_STORES` 未设置 → `Qse()=false` → 个人文件 recall supervisor 在 `ZWs` 入口即 return，
**278 会话零 recall 行**。索引加载层只依赖 `Xf()`（auto-memory 默认开），故照常加载。
flag 的**实际服务端取值无法从二进制读出**（它在运行时由 GrowthBook 下发）——此处论断是"代码要求该 flag/env
二者之一，而本机两者皆无"，与零存在的观测自洽；若需 100% 坐实 flag 值，可在运行时抓 GrowthBook 响应或
`CLAUDE_MEMORY_STORES` 置位后复现（**§9 已复现**：env=`[]` + 带工具迭代的 turn，recall 全链路跑通）。

### 7.3 补查顺带解决的常量（更新 §5.3）

**@248995404**（一行可读）：`var Yf="MEMORY.md",TB=200,Hfe=25000,U6r=4*Hfe,QFe=200,$fe=4096;`
- **索引截断**：`TB=200` 行 / `Hfe=25000` 字节（`U6r=100000` 为 4× 上限的派生值）。超限文案
  "…is ${r} lines (limit: ${TB})… Only part of it was loaded… Keep index entries to one line under ~200 chars"
  （**@251263400** 区）。
- **记忆文件截断**：`$fe=4096` 字节 / `QFe=200` 行——即 §2.4 `Fwr()` 截断文案里的
  "${$fe} byte limit / first ${QFe} lines"（**@257968200** 区）。
- **会话召回字节预算**：`Swn={MAX_SESSION_BYTES:61440}`（**@257919322**）。
- **阻塞等待 deadline**：`Hwr=2000`（ms，**@257969742** 区）。

### 7.4 仍未定位（诚实清单，接 §5.3）

- synthesize 模式的触发判定：`nn()` 镜像硬编码 `mode:"select"`，二进制中未定位产出 `mode:"synthesize"` 帧的代码路径。
- 个人 MEMORY.md 索引**内容读取器**的完整调用链与精确门控函数（索引/提示词层由 `Xf()` 门控已证，
  agent-memory 入口读取器 `va()` @251268008 已定位，个人 auto-memory 索引读取器未逐行追到底）。

---

## 8. 追问补查：CRW 侧 disk 回放链路验证（2026-11-27，CRW 源码事实）

> 验证目标：recall 卡片在重启/分页后是否存活、依赖哪一层。方法：本机全量磁盘扫描 +
> 生产代码路径逐行核对。本节结论已回写 §4.4-1（该条原推断"大概率需要新 v3 事件"被证伪）。

### 8.1 实证扫描：本机 recall 从未触发

- `C:\Users\Ge Zelin\.claude\projects\` **全部** JSONL：零 `"subtype":"memory_recall"` 行、
  零 `relevant_memories` attachment 行（`grep -rl` 全目录）。
- CRW stateDir `transcripts/*.ndjson`（278 个 sidecar）：零真实 recall 帧——`memory_recall`
  的 grep 命中全部是会话散文/工具输出里提到该词，无 `"subtype":"memory_recall"` 帧行。
- 结论：零存在的原因是 supervisor 门控未开（§7.2：`tengu_moth_copse` 默认 false 且无
  `CLAUDE_MEMORY_STORES` env），**不是**落盘路径缺失。索引加载（MEMORY.md 进首条 user
  消息的 system-reminder）是另一层，照常工作；其磁盘痕迹只在 `api-request-blob` 行里。
- 推论：claude 侧 recall 的 disk 行为无法从本机既有数据实证观测，§7 用二进制取证补上；
  本节验证的是 CRW 宿主链路——它决定 native 实现后卡片能否免费存活。

### 8.2 链路逐步证据（recall 帧若出现）

1. **live 持久化（provider-agnostic）**：pump → `ingestDurableMessage` →
   `recordTranscriptFor`（`server/session-manager.ts:9005`）→ `isRenderableSdkMessage`
   放行（`memory_recall` ∈ `BROADCAST_SYSTEM_SUBTYPES`，`shared/transcript-format.ts:91`；
   system 帧判定在 :179-181）→ seq + fire-and-forget sidecar append
   （`server/transcript-sidecar.ts`，`<stateDir>/transcripts/<id>.ndjson`）。
2. **分页读 seq store，不读 provider 日志**：`/history` 已转发 `getTranscriptWindow`
   （`server/routes/sessions.ts:609-646`，legacy shim 注释明确"paging space is now the
   seq store"）；`/messages` 同源。冷会话先 `foldSidecarRows` hydrate
   （`session-manager.ts:9318/10508`）再 reconcile。
3. **sidecar-only 帧在 reconcile 存活**：canonical 由 provider `readHistoryEntries` 组成
   （`composeTranscriptEntries`，`session-manager.ts:9170`）；old 行不在 canonical 即
   `source:'app'`（:9475）。append-only 快路径 `backfillFromEntries`
   （`transcript-sidecar.ts:1001`）只补缺、不删既有行；ordered rebuild 路径
   `appInsertIndex`（`transcript-reconcile.ts:229-268`）按旧 canonical 锚点重插 app-only
   行，剩余 app-only 全量保留（:410-412），**无 subtype 白名单**。
   `classifyLegacyAppOnly`（`transcript-projection.ts:139`）及其 proof 白名单**只有测试
   引用**，不是生产 reconcile 路径——勿据其推断 memory_recall 会被判 source-lost。
4. **history-reader passthrough 是第二保险**：`server/history-reader.ts:705-710` 对
   `system/memory_recall` JSONL 行透传 mode/memories。由 §7.1，真实 CLI 永不写该形态
   （写的是 attachment），故此分支对 claude 现状是**惰性路径**；它服务的是"provider 日志
   自身携带该帧"的情形（如 native 未来选择 v3 事件路线）。

### 8.3 两个形态不重复渲染

CLI 落盘的 `relevant_memories` attachment 行在 CRW **不可渲染**：
`isRenderableSdkMessage` 对 `type:'attachment'` 落底 `return false`
（`shared/transcript-format.ts:182`），CRW 亦无该 attachment 的渲染分支（全仓 grep 零）。
它不进 canonical compose，不会与 sidecar 里的 system 镜像卡重复——卡片唯一来源是
sidecar app-only 镜像帧。

### 8.4 对 native 的含义（分析）

- native adapter（`native-host-frame-adapter.ts:42` 注释已把 `memory_recall` 划给 adapter）
  经正常 pump 发 SDK 形状帧 → 自动获得 seq + sidecar + 冷回放存活，**零新协议词**。
- 新 v3 事件词的收益只剩：recall 进 native canonical 模型历史（供 native 自身
  replay/compact 输入看见"当时召回了什么"）与跨 provider 日志可移植。是否需要取决于
  产品对"召回痕迹是否算模型历史一部分"的定义，不是 disk 一致性问题。
- 本机实证整条链路：**已完成，见 §9**（隔离实例 + env=`[]` + 工具 turn → recall 帧 → sidecar →
  真重启后冷读存活 + reconcile append 指标）。
- `tengu_moth_copse` 的运行时实际取值（服务端下发，二进制不可读；§7.2.6 已说明坐实方法）。

---

## 9. 追问实测：recall 全链路跑通（2026-11-27，隔离实例实证）

> 方法：独立 CRW 实例（端口 3457、独立 stateDir、config 副本），**不触碰主 dev server**。
> CLI 为 SDK 捆绑二进制（`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`，
> attribution header `cc_version=2.1.311.*`）。env 经 `POST /sessions` 的 `env` map 注入
> （`filterClientEnv` 黑名单不拦 `CLAUDE_MEMORY_STORES`，`server/session-env.ts:34`），
> 无需重启任何进程。每会话 `cliDebug:true` → CLI 全量 debug 日志（`<stateDir>/logs/cli-<id>.log`）。
> 测试 cwd 为本仓，记忆目录即现有 `~/.claude/projects/D--codes-claude-react-web/memory/`
> （MEMORY.md + 3 主题文件）。测后全部清理（§9.7）。

### 9.1 env 取值格式：必须是合法 JSON 数组

- `CLAUDE_MEMORY_STORES="1"`：`Qse()` 过（非空），但 debug 日志报
  `memory-prompt-index: parseMemoryStoresEnv failed: … expected array, received number`——
  store 解析失败，recall 仍零触发。
- `CLAUDE_MEMORY_STORES="[]"`：解析干净（无报错），门控开启。**这是"开门且无额外 store"的正确值。**
- 元素 schema（`da()`/`afn()` 切片，@251245045 区）：`{mount, path, mode, promptIndex?, skillsDirs?, scope?}`。

### 9.2 消费门控：recall 只在带工具迭代的 turn 上表面化（本机 flag 状态下）

- 入口 supervisor `ZWs` 每 turn 都跑（§7.2.1），但**blocking 消费**受
  `ezs(){return cCt()&&!IVo()&&!(dKe()&&pS().state==="undecided")}` 门控，
  `cCt()=E("tengu_mill_orange",!1)`（@248155303，默认 false）——本机无该 flag → turn-start
  阻塞等待（`Hwr=2000`ms）不生效。
- 非阻塞消费点在**迭代末附件阶段**（@263786252：`if(Le&&Le.settledAt!==null&&Le.consumedOnIteration===-1)`
  → yield `relevant_memories` attachment）。实测：
  - **无工具 turn**（新会话、同主题、模型直接作答 end_turn）：零 recall（sidecar/JSONL 皆无）；
    模型 thinking 自述"no recalled memories were shown"。
  - **带工具 turn**（"Read CLAUDE.md then…"）：recall 帧**turn 中途**落地（sidecar seq 4/8）。
  - 同会话后续无工具 turn 亦无新帧（已表面化路径被预算集 `Nwr(e).paths` 去重，混淆因素，
    但新会话无工具 turn 的零触发是干净数据点）。
- 结构解读（标注为分析）：无工具 turn 的退出路径不经过迭代末消费块；flag 开启时 blocking
  消费会在 turn-start 注入，不依赖工具迭代。**native 若自建召回，表面化时机是 core turn
  引擎的自主设计点，不必复制 CLI 的 flag 门控。**
- 未定项：本环境 API 日志从未出现 `source=memdir_relevance`（selector 的 querySource，
  `fke` @256289084），辅助请求均 dispatch 会话模型——本次候选排序走的可能是索引路径
  （`searchMemoryFilesWithIndex`，无 LLM）而非 `jbr` LLM selector；`cCt()` 运行时取值未直接观测。

### 9.3 帧形状（sidecar 实录）

```json
{"seq":4,"type":"system","subtype":"memory_recall","msg":{"mode":"select",
 "memories":[{"path":"C:\\Users\\Ge Zelin\\.claude\\projects\\D--codes-claude-react-web\\memory\\debug-with-logs-not-guesswork.md","scope":"personal"}],
 "session_id":"034f3493-…","uuid":"…"}}
```

file-backed select 条目**无 content**（SDK 契约：renderer 从 path lazy-load）——CRW 现状
只显示文件名（§3.3 已知限制），与契约一致。召回命中主题与查询语义相关（debugging 偏好 →
debug-with-logs-not-guesswork）。

### 9.4 CLI 磁盘形态（§7.1 的活体确认）

- SDK JSONL：`relevant_memories` attachment 行 **1 条**，携带完整 content（frontmatter+body）；
  `"subtype":"memory_recall"` 行 **0 条**——system 镜像仅流，落盘的是 attachment，与二进制取证一致。
- attachment 行在 CRW 不可渲染（§8.3），不进 canonical；卡片唯一来源是 sidecar 镜像帧。

### 9.5 重启存活（§4.4-1 修正的实证闭环）

1. warm `/messages`：5 条消息含 recall（seq 4，generation 0）。
2. **直接 kill node 进程**（netstat 定位 PID + CommandLine 校验），确认端口释放后以**同一
   stateDir** 重启新进程（PID 不同）。
3. cold `/messages`：recall 帧**同 seq 同形状存活**。
4. 指标坐实冷路径执行：`transcript_reconcile_total:mode=append,result=success = 1`——
   冷读确实走了 foldSidecarRows hydrate + append-only reconcile，app-only recall 行被保留。
5. **方法学陷阱（记录以免复踩）**：`TaskStop` 杀 npx 包装进程会**孤儿化 node 子进程**——
   首次"重启"实际未发生（新进程 EADDRINUSE 退出，旧进程继续服务），该轮"冷读"无效；
   必须直杀 node PID 并验证端口释放。本节结论以第二轮真重启为准。

### 9.6 对 native 缺口结论的最终确认

- §4.4-1 修正（sidecar app-only 层免费供给 disk 一致性，**零新 v3 事件词**）由 §9.5 实证支持。
- native 实现清单不变（§4.2/§4.3）：解锁三键 + 提示词节 + 召回时机 + 目录 port；
  表面化时机自主设计（§9.2），recall 帧形状照 SDK 契约（§9.3）即可免费继承渲染。

### 9.7 清理记录

测试会话经 `DELETE /sessions/:id` 删除（6 个）；对应 SDK JSONL 从 projects 目录移除；
为排除存储列表路径曾临时创建的空 `memory/team/` 目录已 rmdir（记忆目录恢复原状：
MEMORY.md + 3 主题文件）；隔离实例进程已 kill；临时 stateDir（含 config 副本）整目录删除。
主 dev server 与其会话全程未触碰。