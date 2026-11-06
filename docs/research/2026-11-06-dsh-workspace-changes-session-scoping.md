# dsh 的 per-turn changed-files：快照范围与 session 归属

> 2026-11-06。回答：DeepSeek Harness（`dsh`）的「edited N files」卡片到底统计了哪个
> 工作树的哪些改动，是否给每处改动画出「哪个 session / 哪次工具调用」的归属；这决定
> claude-react-web 的 `TurnChangesCard` 要不要继续沿用「turn 窗口内的 worktree diff」
> 这一范围。
>
> 来源分级：**dsh 源码（本地 checkout，pin 到 `22ddee3792`）** > **dsh docs** >
> **本仓实现**（仅用于对照，非 dsh 事实）。每条 dsh 结论标注
> **CONFIRMED**（源码/类型/文档直接写明）或 **INFERRED**（由机制必然推出，但没有一句
> 文档明说）。无法从源码回答的问题集中在最后一节，不猜。

---

## 0. 结论先行

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| **A** | 快照范围 / 归属键 | 快照的是 **session 所在 git 仓库的 top-level work tree**（`git rev-parse --show-toplevel`），不是 session cwd；summary 用 `cwd` 只做路径展示。summary 存于进程内，键是 **`(SessionId, event seq)`**；事件负载只有 `turn`，**没有 workspace id**。 | CONFIRMED |
| **B** | 是否记录「谁改的」 | **没有**。`WorkspaceChangedFile` 只有 `path / display / added / deleted / binary? / oversized?`；没有 sessionId、toolUseId、callId、agentId。本质是「turn 窗口内的整棵工作树前后 diff」。 | CONFIRMED |
| **C** | session/workspace 模型 | 一个 workspace = 一个目录记录 + 一组有序 session；session 的 `cwd` 直接取自 `workspace.path`。多个 session 可同属一个 workspace（同一 cwd）。Host 上每个 session 是独立 agent，没有 per-cwd / per-workspace 的 turn 锁；UI 主栏一次只显示 **一个** Conversation，但会话可在后台继续跑。**dsh 并没有绕开跨 session 污染，它只是没有处理。** | CONFIRMED / UI 部分 CONFIRMED，并发运行 INFERRED（无显式产品声明） |
| **D** | turn 期间的外部改动 | 会进 summary。文档明说「Edits the user makes during a turn are attributed to that turn」；机制是整树前后快照，不按 actor 过滤。其他进程/其他 session 的写入同理（文档未点名，INFERRED）。 | CONFIRMED（用户编辑）/ INFERRED（其他进程） |
| **E** | worktree / sandbox / overlay | **都没有用在这条路上**。worktree 是 experimental、默认不装；sandbox 只是子进程文件权限策略；snapshot 只借 private index + private object dir，不复制工作树、不做 per-session overlay。 | CONFIRMED |
| **F** | 卡片渲染 & 持久化 | **per turn**，挂在每个 closing turn 的 `conversation.chat.turnTail`；文案 `Edited {count} files` / `Edited {name}`；4 行折叠。summary **不持久化**：Host 重启后旧 turn 的卡片和 diff 都没有（仅 `workspace/changes {turn}` 事件留在日志里）。 | CONFIRMED |
| **G** | Bash/shell 改动 | 在 git 仓库内 **包含**（整树快照，与工具无关）；在非 git 目录 **不含**（只列 file-tool 捕获）。没有单独归属或标记。 | CONFIRMED |
| **H** | 边界处理 | 仓库外文件、gitignore、binary、oversized、`maxFiles=500`、gitlinks、临时目录、rename、每文件按需 diff、5,000 行渲染上限、git 命令超时/输出上限，全部有明确机制（见 §H）。 | CONFIRMED |

一句话：**dsh 的卡片回答的是「这个 turn 的时间窗口内，这棵共享工作树变了什么」，不是「这个 session 改了什么」。** 它与 claude-react-web 今天的 `TurnChangesCard` 在范围上同构，也因此有同样的并发污染。

---

## Sources

| Repo | Root | Revision | 用途 |
|---|---|---|---|
| deepseek-harness | `D:\codes\deepseek-harness` | `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（`master`，2026-10-23） | 一手源码 + 文档 + 归档决策记录 |
| claude-react-web | `D:\codes\claude-react-web` | 当前 worktree（2026-11-06） | 仅对照现有实现与旧研究文档 |

dsh 路径均相对 checkout 根。类型/接口处的行号以该 pin 为准。

---

## A. `WorkspaceChangesSummary` 的确切范围

### A.1 类型本身

`packages/deliverables/workspace-changes/src/types.ts:24-40`：

```ts
/** Files changed during one top-level turn, kept on the Host until its Session is disposed. */
export interface WorkspaceChangesSummary {
  /** The turn whose file changes this summary describes. */
  turn: number
  /** The Session working directory `path` values are relative to. */
  cwd: string
  /** Changed files in `display` order, capped at the plugin's `maxFiles`. */
  files: WorkspaceChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  total: number
  ...
  /** Git tree ids of the turn-start and turn-end snapshots; absent when no snapshot was taken. */
  snapshot?: { before: string; after: string }
}
```

- 没有 `sessionId`、没有 `workspaceId`、没有 `turnId`。
- `cwd` 只是 **session 的工作目录**，用来算 `path` / `display` 的相对形式，不是快照根。
- 单文件记录 `WorkspaceChangedFile`（`types.ts:5-22`）同样只有路径、展示名、行数、`binary?`、`oversized?`。

### A.2 快照根是仓库 top-level，不是 cwd

`packages/deliverables/workspace-changes/src/git.ts:130`：

```ts
const found = await git.run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'], { cwd, signal })
```

`GitWorkspace.root` 的注释（`git.ts:94-106`）写明：

```ts
/** Repository top-level directory, the root every diff path is relative to. */
root: string
```

`snapshotTree()` 在 **root** 上执行 `git add --all --ignore-errors` 再 `write-tree`（`git.ts:154-172`），`diffTrees()` 也在 **root** 上执行 `git diff-tree -r -M -z --numstat before after`（`git.ts:231-240`）。因此：

- 快照覆盖 **整个仓库工作树**（tracked + untracked 非 ignore 文件），包括 session cwd 之上的目录。
- 文件路径先相对 repo root 得到，再 `resolve(root, entry.path)` 还原绝对路径，最后按 session cwd 生成 `path` / `display`（`recorder.ts:313-322`）。
- cwd 在仓库子目录时，cwd 之上的文件会以 `../` 前缀出现（`paths.ts:84-88`；README `:48`）。
- 没有 git 时，`record()` 把范围收缩到 session cwd：`const root = baseline?.workspace.root ?? paths.cwd`（`recorder.ts:306`），此时只有 file-tool 捕获。

一个容易忽略的细节：recorder 的 `cwd` 在 **创建 recorder 时** 取自 `session.header.cwd`（`index.ts:59-62` 的 `eligible()` + `index.ts:132-144`），header 是整个 session 不可变的原始项目目录；即便 session 之后 `cd` 到别处，仓库发现与 display 路径仍以原项目为准，而捕获会跟随工具解析后的目标（README `:46`：「Repository discovery and display paths retain the original project; file captures follow the operation's resolved target even after the Session changes directories.」）。

### A.3 键：`(SessionId, event seq)`，不是 workspace

- `workspace/changes` 事件负载只有 `{ turn }`（`types.ts:99-108`；`recorder.ts:351`）。
- Host 服务按 `SessionId -> TurnRecorder` 索引（`index.ts:105,116-119`），recorder 内按 **事件 seq** 存 `TurnRecord`（`recorder.ts:118,207-209`）。
- 服务签名 `summary(sessionId, seq)` / `diff(sessionId, seq, index, signal)`（`types.ts:78-97`）就是这个键。
- `workspace/changes` 是 log-only 的持久事件（`docs/persistence-catalog.md:86,1327-1335`），但 summary 本体只在内存里。

---

## B. 有没有 per-edit 归属？

**没有。** 三层都查过：

1. **记录类型**：`WorkspaceChangedFile`（`types.ts:5-22`）没有 session / tool / agent 字段。
2. **构建路径**：`record()` 只把 tree diff 的每个 entry 折成 `{ file, sources }`（`recorder.ts:313-322`），`changedFile()` 只写 `path / display / added / deleted / binary? / oversized?`（`recorder.ts:392-401`）。捕获路径同理（`recorder.ts:337-347`、`compared()` `373-382`）。
3. **UI**：卡片行只渲染 `display` + 行数（`ChangedFiles.tsx:77-97`），没有任何「哪个 session / 哪次调用」的字段可渲染。

它是**纯时间窗口的树 diff**：turn-start 树 vs turn-end 树（`recorder.ts:309-322`），外加「git 覆盖不到、但 file tool 碰过」的路径的整文件前后拷贝（`recorder.ts:324-347`）。落入窗口的任何写入——本 session 的工具、子代理、用户编辑器、另一个 session、后台进程——都等价。

设计记录对此是自觉的，但接受的是「用户编辑」：

- `packages/deliverables/workspace-changes/README.md:90`：`Edits the user makes during a turn are attributed to that turn.`
- `.agents/notes/archived/feature/2026-09-11-turn-changed-files-card.md:50` 同句。

注意：客户端另有一条「本 turn 成功 mutation 的路径」折叠（`packages/client/ui-deliverables/src/client/turn-deliverables.ts:1-6, 179-229`），但它只喂 **closing prose 的 inline-code 文件链接**（README `ui-deliverables:57`），**不参与 changed-files 卡片，也不写进 summary**。所以不能用它反推卡片有归属。

---

## C. session / workspace 模型：能不能共用目录、能不能并发？

### C.1 一个 workspace 可以挂多个 session，cwd 就是 workspace 路径

- `docs/subsystems/workspace.md:28`：workspace 是「a stable id over a canonical path, a display title, and **an ordered account of sessions**」。
- `docs/subsystems/workspace.md:64`：`readonly sessionIds: readonly SessionId[]`。
- `docs/subsystems/workspace.md:126`：`the API gateway resolves a new session's cwd from the chosen workspace's path ... creates the session so the cwd lands in its immutable SessionHeader`。
- 源码直接印证：`packages/api/session-controller/src/commands.ts:117`：

  ```ts
  const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
  ```

  随后 `workspace.attachSession(sessionId)`（`commands.ts:127-133`）。同一个 workspace 可以反复 attach 不同 session，`sessionIds` 是一个有序列表。

因此：**两个 session 共用同一个 workspace 目录是模型内的正常情形，不是边缘 case。**

### C.2 Host 上多个 session 可以同时运行；UI 一次只显示一个 Conversation

- 每个 live session 一个 agent：`AgentRegistry keeps one entry per live agent`（`packages/core/agent/README.md:124`）。
- session 列表行带 per-session 运行态：`SessionSummary.running`（`packages/api/session-controller/src/types.ts:149-160`），状态事件 `api-session/status(sessionId, running)`（同文件 `:588-593`）。
- 客户端维护 `Map<SessionId, boolean>` 的运行态（`packages/client/ui-session/src/client/index.ts:291,508-512`），README 写明「Running status comes from Host list baselines or status events」（`packages/client/ui-session/README.md:13`）。
- 布局层只有一个 Conversation 槽位：`conversation` is the reserved key for the Conversation（`packages/client/ui-layout/README.md:32`），即主栏一次显示一个 session。
- 代码里**没有**按 cwd / workspace 串行化 turn 的锁；`session.create` 的冲突码只处理「同名 session 被别的 writer 持有 / cwd 不符」这类身份冲突（`packages/api/session-controller/README.md` 的 create 段），不是「同一目录正在跑另一个 turn」。
- 另外 sandbox 文档明确假设并发 session 存在：「This permits concurrent sessions, consumers, and one-shot escalated retries to ask the same provider for different boundaries…」（`docs/subsystems/sandbox.md:86`）。

### C.3 结论

**dsh 没有绕开跨 session 污染。** 多个 session 可以指向同一个真实 worktree，Host 允许它们各自跑 agent；每个 recorder 只按自己的 turn 边界拍整树快照，因此 A 跑 turn 期间 B（或用户、或后台进程）写进同一棵树的改动，会原样进入 A 的 `edited N files`。它连「归属」字段都没有留，所以也无法在 UI 上区分。

唯一算「隔离」的是 **子代理**：`eligible()` 不给 `origin === 'subagent'` 或 `delegationDepth > 0` 的 session 建 recorder（`index.ts:59-62`），即子 session 不产生自己的卡片；但子代理默认继承父目录（`docs/subsystems/subagent.md:11`：「Omitting it captures that directory at admission. Local child Sessions retain the parent's original project」），它的写入照样出现在**父 turn** 的 summary 里。这属于「不重复出卡」，不是归属。

---

## D. turn 期间的外部改动（用户编辑器、别的进程）

**会进 summary。**

- 机制上没有任何 actor 过滤：`record()` 对 `diffTrees()` 的结果逐条列入（`recorder.ts:309-322`），对捕获路径也只按「是否被快照覆盖 / 是否 ignore / 是否临时目录」筛选（`recorder.ts:324-347`），从不问「是谁写的」。
- 文档只点名了用户编辑这一种外部写入，并明确接受：
  - `packages/deliverables/workspace-changes/README.md:90`：`Edits the user makes during a turn are attributed to that turn.`
  - 设计记录 `.agents/notes/archived/feature/2026-09-11-turn-changed-files-card.md:50` 同句；并在 alternatives 里拒绝「diff against HEAD」，理由正是「attributes the user's uncommitted work to the turn」（同文件 `:32`）。
- 快照只排除了「turn 开始前就已存在」的改动（baseline 就是 turn-start 树），**不排除 turn 进行中发生的**。这正是「用户编辑归到该 turn」的设计代价。

其他进程 / 另一个 session 的写入：源码机制上与用户编辑完全同路（同一棵树、同一个 diff、无 actor 检查），所以**必然**同样计入；但 dsh 文档没有把这一情形写进 Known Limitations，属于 INFERRED。见 §未验证。

---

## E. 有没有用 worktree / sandbox / per-session overlay？

**这条路上没有。**

| 机制 | 是否存在 | 证据 |
|---|---|---|
| Git worktree 隔离 | 否（且是 experimental、默认关闭） | `docs/subsystems/worktrees.md:3`：`The experimental dsh-experimental-worktree service ...`；`workspace-changes` 的依赖只有 `['subprocess', 'fs']`（`packages/deliverables/workspace-changes/src/index.ts:31`），不注入 `worktrees`。 |
| 进程 sandbox | 不在 recorder 路径上 | sandbox 是给 confined subprocess 的文件效果策略（`docs/subsystems/sandbox.md:5-10`）；recorder 只经 `subprocess` 跑 git，没有调用 `ctx.sandbox`。 |
| per-session 文件系统 overlay | 否 | 私有目录只放 **object store / scratch index / 捕获副本**，工作树本身仍是共享的真实目录：`git.ts:136-140`（`objects` + `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES`），`git.ts:154-171`（private index 复制后 `add`/`write-tree`）。README `:44` 明确「the repository's index, objects, work tree, and refs stay untouched」。 |
| 影子仓库（shadow repo） | 仅用于「非 git 目录」的 deferred 方案，**未实现** | README `:91`：`a shadow repository under the Harness home is deferred until its exclude rules can replace a missing .gitignore reliably.` |

唯一「每 session 独立」的东西是 **私有临时目录**（`recorder.ts:269-272` 的 `mkdtemp(... 'dsh-workspace-changes-')`），但它装的是快照对象和捕获副本，不改变工作树的共享事实。session 结束时整个目录删除（`recorder.ts:243-248`）。

---

## F. 卡片怎么渲染、是否持久化

### F.1 per turn、挂在 turn tail

- 定义是 **turn 作用域**：`deliverablesDefinition` 以 `turn/start` 为 start、以 `workspace/changes` 为 update，state 里的 `changes = { seq }`（`packages/client/ui-deliverables/src/client/turn-deliverables.ts:173-192`）。
- closing turn 读取：`changesForClosing(owner)` 返回 `owner.turn.data.get('deliverables')?.changes`（`turn-deliverables.ts:251-253`）。
- 卡片作为 `conversation.chat.turnTail` 的贡献渲染（`Deliverables.tsx:51-59, 95-97`），即**每个 turn 的尾部**，不是 session 级汇总。
- 摘要按 `(sessionId, seq)` 从 Host 读一次，缓存在 client store，直到连接替换（`changes-summary.ts:9-32`；`Deliverables.tsx:79-85`）。滚动回看历史 turn 时，只要 Host 还活着就能重新出卡。

### F.2 文案与计数

`packages/client/ui-deliverables/src/client/locales.ts:100-110`：

```ts
'changes.title': 'Edited {count} files',
'changes.singleTitle': 'Edited {name}',
'changes.binary': 'binary',
'changes.all': 'All {count} files',
'changes.oversized': 'too large',
```

- 多文件：code-file 图标 + `Edited {total} files` + 总 `+added / -deleted`；hover/focus 时计数换成 `Preview in sidebar`（README `ui-deliverables:45`）。
- 单文件（`total === 1`）：`Edited {basename}`，不出列表（`ChangedFiles.tsx:47, 50-76`）。
- 行数来自 `summary.added/deleted`（对**全部**文件求和，包括被 `maxFiles` 截掉的，`recorder.ts:359-360`）。
- 4 行后折叠，底部 toggle 展开/收起（`ChangedFiles.tsx:18, 48-49, 98-104`）。

### F.3 不持久化（旧文档正确）

- README `:86`：`Summaries, snapshot trees, and captured copies live only as long as their Session in this Host process; earlier turns of a conversation reopened after a Host restart have no card and no comparison.`
- `docs/subsystems/deliverables.md:138`：`the summary that event announced is not in the log but is returned by workspaceChanges.summary(...) for the event's sequence until the Session is disposed, so a conversation reopened after a Host restart has no changed-files card for its earlier turns.`
- 实现：`records` 只是内存 `Map`（`recorder.ts:118`），`dispose()` 清空（`recorder.ts:243-248`）。路由在拿不到时返回 404（`present-open.ts:131-140`）。
- 事件本身仍是 log-only 持久事件（`docs/persistence-catalog.md:86,1327-1335`），所以重启后客户端**知道**某 turn 曾经有卡，但读不到内容 —— 产品决策是「打不开的卡就不显示」（README `:86`）。

---

## G. shell / Bash 驱动的改动

| 情形 | 是否出现 | 证据 |
|---|---|---|
| 在 git 仓库内，Bash 改了文件 | **包含**，且与 file tool 改动无区别 | 快照是整树 `add --all` + `write-tree`（`git.ts:154-168`），diff 只看前后树（`git.ts:231-240`）。README `:12`：`Git snapshots of the working tree ... are diffed`。设计记录 `:16`：「git sees every write regardless of the tool」。 |
| 在 git 仓库内，先 file tool 再 Bash 改同一文件 | 包含；捕获副本会体现 Bash 之后的最终内容 | README `:46`：`a shell edit after a file-tool edit is included`。 |
| 在非 git 目录，只有 Bash 改文件 | **不包含** | README `:44`：`Either way the summary lists the file-tool edits alone ... shell edits are absent.`；`:91`、`:92` 同义。 |
| 归属 | 无差别 | 同 §B；没有 tool/session 字段。 |

---

## H. 边界处理清单

| 边界 | 行为 | 证据 |
|---|---|---|
| **文件在仓库根之外** | 只能经 file-tool 捕获进入；`path` 为绝对路径，`display` 为 `~`（home 下）或绝对路径；比较照常可读全文 | `paths.ts:84-98`；`recorder.ts:337-347`；README `:48`、`:94` |
| **gitignored 文件** | 快照不含；但若 file tool 编辑过，走捕获副本比较（`check-ignore` 判定是否「未覆盖」）；tracked 但匹配 ignore 的文件仍算被快照覆盖 | `git.ts:260-279`；`recorder.ts:334-342`；README `:46` |
| **binary** | git numstat 的 `-` → `binary: true`、计数 0；捕获侧按前 8,000 字节是否含 NUL 判定；diff 直接拒绝（`kind: 'binary'`） | `numstat.ts:42-48`；`capture.ts:12,69`；`recorder.ts:317,378`；`types.ts:73-74` |
| **oversized** | 捕获副本 > `maxFileBytes`（2 MiB）→ 不存内容，列 `oversized`、计数 0；快照侧在 diff 时按 `ls-tree -l` 大小拒绝；两侧都超限也照样列出（「unread content is never known to be unchanged」） | `index.ts:55`；`capture.ts:57`；`recorder.ts:375-377`；`recorder.ts:286-297`；README `:46` |
| **`maxFiles`** | 默认 500；`files` 截断，`total` 保留完整计数，`added/deleted` 对全部文件求和 | `index.ts:54`；`recorder.ts:352-360` |
| **嵌套仓库 / submodule** | 记为 gitlink，不下钻；捕获路径若落在 gitlink 下也被剔除 | `git.ts:242-258`；`recorder.ts:328-332` |
| **临时目录** | 仓库外的 `/tmp` 或平台 temp 根下的捕获路径剔除；在仓库内的不剔（因为整棵树本来就覆盖） | `paths.ts:26-40,72-74`；`recorder.ts:338-342`；README `:46` |
| **rename** | `diff-tree -M` 检测；before 侧用 `oldPath` 读旧内容 | `git.ts:235`；`numstat.ts:36-41`；`recorder.ts:318` |
| **删除 / 新建** | diff 的 D / A entry 正常列出；diff 侧 `before` / `after` 布尔表示是否存在 | `recorder.ts:313-321`；`types.ts:58-72` |
| **仅缺末尾换行** | 捕获副本比较视为未变；git 的 numstat 仍会计一行 | README `:46` |
| **git 命令失败 / 超时 / 输出过大** | 该 turn 放弃记录（warn），下一 turn 重新开始；timeout 30s，输出 8 MiB | `index.ts:52-53`；`git.ts:55-80`；`recorder.ts:250-266`；README `:58,60` |
| **summary 为空** | 若本 turn 之前没有记录过，则不 append 事件；若之前 in-turn 记录过、最终为空，则 append 空列表以取代旧记录 | `recorder.ts:349-351` |
| **单文件 diff 如何服务** | 按需：`workspaceChanges.diff(sessionId, seq, index, signal)`；HTTP `GET /api/changes.diff`；3 行上下文；`diffTimeoutMs=100` 超时降级为整文件替换（`coarse`）；client 最多画 5,000 行 | `types.ts:87-96`；`present-open.ts:153-164`；`compare.ts:6,41-49,90-104`；`FileDiff.tsx:14` |
| **Windows** | `path` 保留原生分隔符，`display` 始终 `/` | README `:96`；`paths.ts:84-98` |

---

## 对 claude-react-web 的含义

### 1. 旧研究文档 §7 需要三处更正

`docs/borrowable-from-deepseek-harness.md:132-146`（§7）大部分仍然成立，但以下三点已过时或不精确：

1. **「我们只是没把它展示出来」已过时**。claude-react-web 现在已有 `TurnChangesCard` + `GET /sessions/:id/turn-changes` + sidecar `recordTurn`（`src/components/message-list/TurnChangesCard.tsx`；`server/snapshot/snapshot-service.ts:432-528`；`server/routes/sessions.ts:1128-1133`）。旧文 `:136` 的 `grep ... returns nothing` 不再成立。
2. **「whole-file captures ... for non-git paths」范围说窄了**。dsh 的捕获覆盖的是「快照不覆盖的路径」：ignored 文件、仓库外文件，以及**无快照时的全部 file-tool 编辑**（README `:46`）。
3. **§7 没有点出范围**：dsh 的快照根是 **repo top-level 整棵树**，不是 session cwd。这正是并发污染的来源，旧文完全没提。

旧文唯一明确表扬的「not persisted」是准确的（见 §F.3）；而本仓的实现反而**持久化**了 turn summary（`snapshot-service.ts:500-528` 写 `prev.turns`），这一点比 dsh 强，不是要补的洞。

### 2. 并发污染在 dsh 里同样存在，不能当「他们解决了」来抄

本仓 `recordTurnLocked()` 的取数方式与 dsh 同构：

```ts
const entries = await treeDiff(repo, start, end)   // server/snapshot/snapshot-service.ts:448
const listed = entries.map(...)                    // :450-461
```

`treeDiff` 是 `git diff --name-status/--numstat from to --`，作用在 `repo.worktree`（仓库 top-level，`snapshot-service.ts:442`），不看 actor。因此：

- 两个本仓 session 指向同一 cwd 时，A 的 turn 窗口内 B 的写入会进 A 的卡片 —— 与 dsh 完全相同的失败模式。
- dsh 的选择是**接受并文档化**「用户编辑归到该 turn」，而没有做按 session 归属。把它当作「业界已验证的范围」是可以的，把它当作「已解决跨 session 污染」是错的。

可选的产品方向（按代价排序，均非本次结论）：

1. **保持范围，改文案**：把卡片从「Edited N files」改成更中性的「N files changed in this turn」并在 tooltip/说明里承认「包括其他会话或你在此期间的外部编辑」。这是 dsh 的实际立场，成本最低。
2. **按「本 session 触达的路径」过滤**：本仓已经有 per-turn 的 mutation 目标集合（`shared/turn-changes.ts` 之外的 `recordTurn` capture map、以及 pump 里的 `MUTATING_TOOL_NAMES`），可以把 tree diff 与「本 session 工具写过的路径」求交；但 Bash 的间接写入会漏，且 rename/删除判定变复杂。这是「归属」而非「隔离」，会把 shell 改动重新变成盲区。
3. **per-session worktree 隔离**：能真正消除污染，但要求每个 session 独立 checkout（dsh 的 worktree 是 experimental 且默认关闭，见 `docs/subsystems/worktrees.md:3`），是产品形态级的改动，不属于卡片 scoping。

如果只做卡片层面的决定，**方向 1 是与 dsh 对齐、且不引入新状态模型的最小改动**；方向 2 需要先证明「Bash 间接写入漏报」可接受。

### 3. 可借鉴但尚未抄的两点

- **快照根显式化**：dsh 把 `snapshot.root` 与 `summary.cwd` 分开建模，路径展示（`../`、`~`、绝对）有完整规则（`paths.ts:84-98`）。本仓的 `displayPath` 是否覆盖「cwd 之上的仓库文件」值得对照检查。
- **事件只带 turn、内容按需服务**：dsh 用 `workspace/changes {turn}` + `summary(sessionId, seq)` 两层，事件本身可长期回放而内容有明确生命周期。本仓把 summary 持久化在 sidecar，生命周期更长，但也意味着「内容与卡片同寿命」这条 dsh 的产品不变量在本仓不成立 —— 这是有意的差异，不是缺陷。

---

## 未验证 / open questions

1. **「其他进程的写入」是否有文档背书** —— 机制上必然计入（无 actor 过滤），但 dsh 文档只写了「用户编辑」。没有找到明确写「another process」的句子。标 INFERRED。
2. **两个 session 在同一个 workspace 里同时跑 turn，是否是 shipped 产品实际允许的操作** —— Host 层没有任何 per-cwd 锁（已查 `packages/core/agent/src`、`packages/api/session-controller/src`、`packages/workspace`），`SessionSummary.running` 也是 per-session；但 dsh 没有一句「你可以同时跑两个」的产品声明。UI 主栏一次只显示一个 Conversation（`ui-layout/README.md:32`），所以「同时可见两个会话」不是产品形态；「一个在后台跑、你在另一个里输入」在架构上成立，未见反证。标 INFERRED。
3. **子代理写入的归属** —— `eligible()` 明确不给 subagent session 建 recorder（`index.ts:59-62`），子代理默认继承父目录（`subagent.md:11`），因此其写入进入父 turn 的 summary。这是由两处代码推出的，没有一句文档直接描述「子代理的编辑归到父 turn 卡片」。
4. **「Session disposed」的确切时机** —— README 只说 summary 活到 disposal；`session/disposed` 在什么情况下触发（删除、Host 退出、休眠/唤醒？）本次未追。若存在「休眠但不 dispose」，卡片寿命会比「进程重启」更长，需要另查。
5. **桌面端 / headless 是否也挂 workspace-changes** —— README `:28` 说「The shipped Web bundle mounts this plugin」；headless/SDK/ACP 的组合是否包含它未查。对本问题（卡片范围）无影响，但影响「dsh 所有入口是否都面对同一污染」。
6. **`maxFiles` 截断后的卡片行为** —— `total` 是完整计数，`files` 只有前 500；卡片显示 `Edited {total} files` 但列表只有 500 行。UI 是否提示「已截断」本次未在 `ChangedFiles.tsx` 找到对应文案（只看到 `All {count} files` 用的是 `files.length`），可能是一个未覆盖的边界。