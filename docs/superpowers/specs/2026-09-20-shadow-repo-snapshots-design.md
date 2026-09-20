# 2026-09-20 · 影子仓库文件快照与离线 Rewind

> **承接**:现有 SDK `enableFileCheckpointing` + `Query.rewindFiles`(live-only、tracked-only、claude-provider-only)。本 spec 用**影子 git 仓库 + TreeID 快照**替换该路径,使 rewind 覆盖 untracked/新建文件,并在 dormant/terminated/重启后仍可回滚;同时为后续 Review 面板提供结构化 before/after 数据源。

## 一、背景与动机

### 1.1 现状

| 构件 | 角色 | 限制 |
|---|---|---|
| SDK `rewindFiles` | 按 user message 恢复 tracked 文件 | 必须 **live + idle**(dormant→412 / terminated→410 / working→409);只恢复 tracked;依赖 live `Query` 子进程;仅 claude provider |
| `promptUuidStore` | app uuid `U` ↔ SDK uuid `V` sidecar | 已有,生命周期完整 |
| history ring | live fan-out + 短窗 replay | `HISTORY_CAP=500`,旧帧被挤掉 |
| SDK JSONL transcript | 消息身份/顺序/离线 UI 骨架 | **只读**,CLI 独占写;自定义字段进不去 |
| `git.ts` / GitPanel | 用户仓库展示与写操作 | 与 checkpoint 无关 |

用户可感知缺口:

1. **休眠/终止/重启后无法 rewind** —— 子进程不在,SDK 控制请求直接 412/410。
2. **新建/untracked 文件不回滚** —— SDK 只动 tracked;「这轮新建的 `foo.ts`」在 rewind 后仍留在磁盘。
3. **无结构化「这一轮改了什么」** —— dry-run 只有文件列表和 +/- 行数,没有可渲染的 before/after patch 供 Review。

### 1.2 已确认决策(设计输入)

| 决策点 | 选择 |
|---|---|
| 主目标 | ① 离线/休眠可回滚 ② 覆盖 untracked;⑤ Review 供数一并做;③ 细粒度/tool 级、④ 跨 provider 解耦 **本期不做** |
| 与 SDK rewind 关系 | **A:影子仓库为唯一路径,SDK `rewindFiles` / `enableFileCheckpointing` 退役** |
| 捕获范围 | **A:session cwd**(非整个 repo worktree);多 session 同 repo 互不卷入 |
| 拍摄时机 | **C+:user 消息发出前一张全量树 + step-finish 的 end 树/patch**(对齐 opencode) |
| 非 git 项目 | **A:无 rewind**(UI 隐藏;与 GitPanel `{isRepo:false}` 同语义) |
| 存储形态 | **Tier 2:per-session snapshots sidecar 为权威;ring 帧冗余展示字段;不改 `HISTORY_CAP`;不自建消息 DB** |

### 1.3 为何不用「去掉 HISTORY_CAP / 塞进 SDK JSONL」

- 去 cap 只解决运行期,不解决**重启后 TreeID 丢失**(ring 不落盘);且 RSS/replay/seed 三条线失稳。
- SDK JSONL 写权在 CLI;追加/改写自定义行会被 compact/resume 破坏。你们已有三个 sidecar(`promptUuids` / `resultFrames` / `turnAnchors`)正是为此模式。

## 二、目标 / 非目标

**目标**

1. 影子 git 仓库(独立 `GIT_DIR`,alternates 共享源 ODB)按 session cwd 捕获内容树。
2. user 发送前 + step-finish 拍摄;TreeID 与 patch 文件列表持久化到 per-session sidecar。
3. `POST /sessions/:id/rewind-files` 重写为影子树路径:**不要求 live 子进程**;dormant/terminated/重启后可 dry-run + 真回滚;覆盖 tracked + untracked(新建文件回滚时删除)。
4. 退役 provider `rewindFiles` / `supportsRewindFiles` / spawn `enableFileCheckpointing`。
5. 提供结构化 diff API(树间 `FileDiff[]`:path/status/additions/deletions/patch),为 Review UI 供数;本期可先只做 API + 复用现有 ConfirmDialog 展示文件列表。
6. 生命周期完整:fork 拷、clear/discard 清、delete 删、resume 加载;非 git cwd 不写不提供。

**非目标(YAGNI)**

- **tool 级 / 中间 step 回滚 UI**(目标③):存储格式预留 `patches[]` 与 per-step start/end,但 API/UX 仍锚定 **user message**。
- **跨 provider 抽象**(目标④):本期实现绑在 host 泵的帧类型上;非 claude provider 若无 step-finish 帧则退化为「仅 user 前一张」。
- **整仓 scope 开关**(决策 C 的可选项):不做配置项,写死 cwd。
- **自建消息 DB / 取代 JSONL**:不做。
- **影子仓库 gc 策略细化**:第一版沿用周期 `git gc --prune=7.days` 级别的简单清理;不做 LRU 策略引擎。
- **非 git 项目的拷贝式快照**:不做。
- **Conversation truncate 与 file rewind 合并**:保持现有两条产品路径(discard 截断对话;rewind 只动文件)。

## 三、架构总览

```
                         ┌─────────────────────────────────────┐
                         │  影子 git-dir                        │
                         │  <stateDir>/snapshots/odb/<key>/     │
                         │  objects/info/alternates → 源 .git    │
                         │  index = scope 内工作树状态           │
                         └──────────────┬──────────────────────┘
                                        │ write-tree → TreeID
user send / step-finish                 ▼
      │                        SnapshotService (host)
      │                         capture / diff / restore
      │                                │
      ▼                                ▼
 session pump ──────────► snapshots sidecar (权威)
      │                   <stateDir>/snapshots/meta/<sessionId>.json
      │                   { byMessage, patches }
      ▼
 history ring 帧 (冗余展示字段 snapshot?)
      │
      ▼
 WS / REST  ──► 客户端 Rewind 菜单 / ConfirmDialog / (后续 Review)

SDK JSONL  = 消息身份与顺序(只读 join)
用户 .git  = ignore 规则 + alternates 对象源(只读)
```

**权威分层**

| 层 | 内容 | 寿命 |
|---|---|---|
| SDK JSONL | 消息 uuid、顺序、正文 | CLI 管 |
| snapshots sidecar | TreeID、patch 文件列表 | session 生命周期;**无 HISTORY_CAP** |
| history ring | 冗余 `snapshot` 字段 + live 消息 | `HISTORY_CAP`,可丢 |
| 影子 ODB | blob/tree 对象 | gc 窗口(约 7 天 prune) |

## 四、影子仓库布局

### 4.1 路径

```
<stateDir>/snapshots/
  odb/<key>/          # 一个影子 GIT_DIR
  meta/<sessionId>.json
```

**第一版:`key = sessionId`**(每 session 独占 odb)。实现最简单、无跨 session 锁语义;磁盘上多份 alternates 指针 + 各自 index,对象经 alternates 仍共享源 ODB,额外 blob 只来自各 session 未提交改动,可接受。

后续若要省 index/元数据,可改为 `key = hash(realpath(worktree)+scope)` 共享 odb + 按 gitdir 锁;**meta 始终 per-session**,与 odb 是否共享无关。

### 4.2 初始化(首次 capture)

```
git --git-dir <odb> init
config: core.autocrlf=false, core.longpaths=true, core.symlinks=true,
        core.fsmonitor=false, feature.manyFiles=true,
        index.version=4, index.threads=true, core.untrackedCache=true
```

**Seed / alternates**(性能关键):

```
源: git -C <cwd> rev-parse --path-format=absolute --git-common-dir
写: <odb>/objects/info/alternates  ← <commonDir>/objects
    (递归展开源仓库已有 alternates,跳过不存在的)
拷: 源 index → <odb>/index   (best-effort,失败则全量 add)
```

大仓库(chromium 级)避免首次 `add` 重 hash 数分钟。

### 4.3 Scope 与 ignore

- `scope = path.relative(worktree, session.cwd)` 规范化;空 → `"."`。
- 所有 pathspec 用 `:(top,literal)` + NUL 分隔,防 pathspec magic / 空格文件名。
- **ignore 以源仓库为准**:`git --git-dir <源.git> check-ignore --no-index --stdin -z`。
- **大文件**:untracked 且 size > `MAX_UNTRACKED_SNAPSHOT_BYTES`(默认 **2 MiB**,可配置)写入 odb 的 `info/exclude`,不进 ODB。
- 被 ignore 或超限的路径从影子 index `rm --cached` 掉,避免脏 index 残留。

### 4.4 并发

- 按 **odb 路径** 的互斥锁(进程内 `Map<path, Promise>` 串行链即可,与 `PromptUuidStore.writing` 同模式;不必上跨进程文件锁)。
- capture / diff / restore 互斥;**REST dry-run 与泵 capture 可并发进锁队列**。

### 4.5 非 git / 不可用

| 条件 | 行为 |
|---|---|
| `isGitAvailable()` false | 不 capture;rewind API 返回 400 `git unavailable` |
| cwd 不在 git worktree | 不 capture;`GET` 能力位 `available:false` |
| session 从未 capture 过 | dry-run `canRewind:false, error:'no snapshot'` |

## 五、数据模型

### 5.1 snapshots sidecar

`<stateDir>/snapshots/meta/<sessionId>.json`:

```ts
interface SessionSnapshots {
  version: 1
  /** 影子 odb 的绝对路径(解析用;迁移/调试) */
  gitDir: string
  /** worktree 绝对路径(realpath) */
  worktree: string
  /** session cwd 相对 worktree 的 scope */
  scope: string
  /** user 消息:发出前的全量树(rewind 主锚点) */
  byMessage: Record<string, { start: string }>
  /** assistant 轮次 patch(opencode 语义;本期供 rewind 合并与 Review) */
  patches: Array<{
    messageId: string      // assistant 消息 uuid(或 step 归属的 assistant uuid)
    hash: string           // 该 step 开始前的 TreeID
    files: string[]        // 绝对路径
  }>
  /** 最近一次成功 capture 的树(便于调试/连续 rewind 基准) */
  last?: { tree: string; at: number }
}
```

**权威规则**

- rewind 查询 **只读 sidecar**,不读 ring。
- `byMessage` 键 = **server-minted user uuid `U`**(与现有右键菜单 `messageId` 一致)。resume 后若 JSONL 是 SDK uuid,用 `promptUuids` 的 `V→U` 反查对齐。
- patches 在 fork 时按 cut 点截断(见 8.2)。

### 5.2 ring 帧冗余(非权威)

泵在写入 user / assistant 相关帧时,可附加:

```ts
snapshot?: { start: string; end?: string }
```

供 live UI 立即启用 Rewind 项。客户端**不得**把它当持久化源;菜单 enable 条件改为服务端能力查询或 sidecar 随 `session-update` 下发的摘要。

### 5.3 与 `promptUuids` 关系

- 不合并进 `sessions.json`(同样避免每次 send 重写、不进前端)。
- 不与 `promptUuids` 同文件:职责不同(uuid 映射 vs 树锚点);但生命周期钩子完全一致。

## 六、拍摄时机(C+)

### 6.1 User 发送前

`SessionManager.send` / `sendContent` 在 `dispatchUserMessage` / 入队**之前**:

```
tree = await snapshots.capture(sessionId)   // 失败:log.warn,不阻断发送
sidecar.byMessage[userMsg.uuid] = { start: tree }
```

- **必须在工具跑起来之前**——与 opencode `processor.create` 预拍同一理由。
- capture 失败(非 git、git 挂了)**不阻断对话**;该消息无锚点,菜单禁用。

### 6.2 Step-finish

泵处理 `result` 或等价轮次结束信号时(对齐现有 `resultFrameStore.append` 钩子附近):

```
endTree = capture()
prevStart = 本轮 ctx 在 user-前 或上一 step 记下的 start
files = diff --name-only prevStart..endTree   (经 ignore 过滤)
if files.length:
  patches.push({ messageId: assistantUuid, hash: prevStart, files })
  下一 step 的 start = endTree   // 链式,便于以后 tool 级
```

- **interrupt / 异常**:cleanup 路径同样跑一次「补 patch」,保证中断轮次也有「改了哪些文件」。
- **无 mutating 工具的纯文本轮**:`files` 为空,不写 patch,但仍可更新 `last`。

### 6.3 与 mutating tool 广播的关系

`git-broadcast` 仍按 tool_result debounce 推 `git-snapshot`(用户仓库 status)。**影子 capture 不挂在 mutating tool 上**,挂在 user-send / turn 边界——两者独立,避免「一次 Edit 多次 write-tree」。

## 七、API 设计

### 7.1 能力查询(新增)

```
GET /api/sessions/:id/file-snapshots
→ 200 {
    available: boolean,          // git + worktree + 有 odb
    reason?: string,             // 'not-git' | 'git-unavailable' | ...
    anchors: Array<{
      messageId: string,         // user uuid U
      at?: number                // 可选时间戳
    }>                           // 可倒序、可截断(如最新 200)
  }
```

客户端右键菜单 enable 条件:phase 无关(**不要求 idle**),仅要求 `available && anchors 含该 messageId`。

### 7.2 Rewind(重写现有)

```
POST /api/sessions/:id/rewind-files
body: { messageId: string, dryRun?: boolean }
```

**语义变更**

| | 旧(SDK) | 新(影子树) |
|---|---|---|
| phase | working 409 / dormant 412 / terminated 410 | **无 phase 限制**(不要求 live 子进程) |
| 文件集 | tracked only | tracked + untracked;**start 树中不存在的路径 → 删除文件** |
| 会话截断 | 无 | 仍无 |
| live 要求 | `requireLive` + capability | 只需 sidecar + odb 存在 |

**响应**(兼容现有 `RewindFilesResult` 形状,减少客户端改动):

```ts
{
  canRewind: boolean,
  error?: string,
  filesChanged?: string[],
  insertions?: number,
  deletions?: number,
  // 新增(可选):结构化,供 Review/高级 UI
  diffs?: Array<{
    file: string
    status: 'added' | 'deleted' | 'modified'
    additions: number
    deletions: number
    patch?: string
  }>
}
```

`dryRun: true` → `git diff` 预演,不写工作树。  
真回滚成功后 → `broadcastGitStatusChanged(id)`(现有)。

**回滚算法**(user 锚点 = `byMessage[messageId].start`):

```
1. 解析 messageId → sidecar 记录;无 → 400
2. files = union(
     diff(name-only, start, currentCapture),   // 自 user 前以来工作树变化
     ∪ patches[].files where patch 属于该 user 之后
   )
   // 第一版可简化为:只用 start vs 当前 capture 的 name-only,
   // 已能覆盖 tracked 修改 + untracked 新建 + 删除。
3. dryRun: 输出 diff(start, current)
4. real:
   for file in files:
     if start 树含该路径: git checkout <start> -- <relpath>
     else: rm file (若是本轮新建)
5. 清理:该 user 之后的 patches 可标记 retired(或保留供 audit);
   byMessage 保留(允许再次 rewind 到同一点)
```

**简化说明**:第一版**不**强制走 opencode 的「多 patch start 树逐文件映射」,因为 rewind 锚点是 user 消息,`start` 一张全量树已语义完整。`patches[]` 仍写入,供后续 tool 级与 Review;user 锚点路径用 `start vs current` 即可。

### 7.3 结构化 diff(Review 供数,新增)

```
GET /api/sessions/:id/snapshot-diff?from=<messageId>&to=current|<messageId>
```

- `from` = user messageId → 取 `byMessage[from].start`
- `to=current` → 先 capture 当前,再树间 diff
- 返回 `FileDiff[]`(与 7.2 的 `diffs` 同型)

本期客户端可不建 Review 面板;API 先行,便于测试与后续 UI。

### 7.4 退役面

- `provider.rewindFiles` / `supportsRewindFiles`:从 `ProviderSessionHandle` 与 claude provider 删除。
- spawn:去掉 `enableFileCheckpointing` 透传(或保留字段但忽略;**推荐直接删**以免误解)。
- `shared/rewind.ts` 的 `coerceRewindResult` 改为本地实现的响应收窄(不再收 SDK unknown)。
- 路由路径 `/rewind-files` **保留**(客户端少改),实现替换。

## 八、生命周期集成

### 8.1 Resume / 重启

- 无需 live 子进程即可读 sidecar + odb。
- resume 后 `byMessage` 仍用 `U`;若 seed 经 `rewriteSeedPromptUuids` 已是 `U`,直接可用。
- dormant session 的 rewind:manager 不 `requireLive` 活 Query;若 session 仅存 meta,用 **meta.cwd / 存盘的 worktree** 解析 odb。**spawn 时把 cwd 写入 SessionMeta(已有)**,sidecar 再冗余一份 scope/worktree,防 cwd 配置变更后错位。

### 8.2 Fork / Discard

对齐 `turnAnchorStore` / `resultFrameStore`:

```
fork(X → Y, cut = fromAssistantUuid):
  metaY = load(X) 深拷
  保留 byMessage 中 cut 及之前的 user 锚点
  保留 patches 中 cut 及之前的项
  save(Y); 不删 X(除非 deleteOriginal)
deleteOriginal:
  remove(X 的 meta); odb 对象留给 gc(多 session 可能共享)
clear(/clear 新 session):
  新 id 无 sidecar;旧 sidecar 随 delete/expire
```

### 8.3 Delete session

`remove(<id>.json)` 与现有三个 sidecar 同点调用(`session-manager` delete / unload 路径 ~5000 行处)。

### 8.4 并发与锁

- capture 与 rewind 真回滚互斥(同一 odb 锁)。
- working 中允许 capture(泵边界);**working 中允许 dry-run**;真回滚若检测 `pendingTurns>0` 可 **409**(与旧 UX 一致的保守选项,避免与在跑工具互写)——写入实现约束:**真回滚要求 idle 或 dormant/terminated,不要求 live 子进程**。

## 九、错误处理

| 场景 | 行为 |
|---|---|
| git 不可用 / 非 git | 不 capture;能力 `available:false`;rewind 400 |
| capture 中途失败 | log.warn;该边界无锚点;不抛给用户对话流 |
| sidecar 损坏 | load 失败当空;不 crash 服务 |
| odb 被用户删 | capture 重建;旧 TreeID 失效 → dry-run `canRewind:false` |
| JSONL compact 后 uuid 对不上 | 锚点查不到 → 禁用该条 Rewind,不 500 |
| Windows 路径 | realpath + 统一 `/` 相对路径;execFile 无 shell(沿用 `git.ts` 双围栏) |
| 符号链接/hardlink | 第一版不做 SDK 级 skippedLinks 精细计数;checkout/rm 跟 git 默认;文档注明 |

## 十、配置

`config.json` / 设置面板(可选,均有默认):

| 字段 | 默认 | 说明 |
|---|---|---|
| `fileSnapshots` | `true` | 总开关;false 完全停用 capture 与 rewind |
| `fileSnapshotsMaxUntrackedBytes` | `2097152` | 大文件 exclude 阈值 |

## 十一、客户端变更

1. **右键菜单**:标题可改为 “Rewind files to this message”;enable 条件从 `phase==='idle'` 改为 `snapshots.available && anchor 存在`。
2. **ConfirmDialog**:沿用;dry-run 成功后展示 `filesChanged` + +/- ;若有 `diffs` 可后续增强。
3. **文案**:去掉 “Tracked files will be restored…” → “Files will be restored to their state when this message was sent. Files created after this message will be deleted. The conversation itself is not truncated.”
4. **不再依赖** dormant 时的 “resume it before rewinding” 提示。
5. GitPanel 不变;真回滚后仍有 `git-snapshot` 推送。

## 十二、实现草图(模块)

```
server/snapshot/
  shadow-git.ts       # init/seed/add/write-tree/diff/checkout/rm 封装
                      # 复用 git.ts 的 execFile 双围栏风格,可抽公共 runGit
  snapshot-service.ts # capture / dryRun / restore / diffFiles
  snapshot-store.ts   # sidecar 读写(writeAtomic + writing 链)
  paths.ts            # key / gitDir / meta 路径

server/session-manager.ts
  - send/sendContent: 预 capture
  - rewindFiles: 重写
  - fork/discard/delete: sidecar 生命周期
  - 构造注入 SnapshotService

server/session-pump.ts
  - result/step 边界: capture + patches.append
  - interrupt cleanup: 补 patch

server/routes/sessions.ts
  - GET file-snapshots / snapshot-diff
  - POST rewind-files 实现替换

server/providers/claude/*
  - 删 rewindFiles / supportsRewindFiles / enableFileCheckpointing

shared/rewind.ts
  - 类型保留;coerce 改本地
```

**测试**

- `shadow-git`:临时目录 init 仓库 + capture/diff/restore/untracked 删除;alternates 存在性;大文件 exclude。
- `snapshot-store`:load/save/corrupt/fork 截断。
- manager:send 预拍;rewind dry/real;非 git 400;dormant 无 live 可 rewind(核心回归)。
- 泵:interrupt 补 patch;无文件轮次不写 patch。

## 十三、预期收益

| 维度 | 之前 | 之后 |
|---|---|---|
| dormant/terminated/重启 rewind | 不可用(412/410) | **可用**(sidecar + odb) |
| working 中 dry-run | 409 | **可用** |
| working 中真回滚 | 409 | 仍 409(防与工具互写) |
| untracked / 新建文件 | 不回滚 | **回滚/删除** |
| tracked 修改 | SDK checkpoint | 影子树 checkout(同等) |
| 非 git | N/A | 明确禁用,不假装可用 |
| provider 绑定 | 仅 claude + capability | **host 能力**,与 SDK checkpoint 解耦 |
| Review 数据 | 仅 dry-run 计数 | `diffs[]` 结构化 patch(后续 UI) |
| 内存 | — | ring cap 不变;sidecar KB～低 MB 级 |
| 大仓库首拍 | N/A | alternates + index seed,避免分钟级 rehash |

**风险与缓解**

| 风险 | 缓解 |
|---|---|
| 与用户手工 git 操作竞态 | 真回滚仅 idle;文档说明 rewind 改工作树 |
| 共享 odb 多 session | 按 odb 锁;meta 不共享 |
| odb 体积 | 大文件 exclude;`gc --prune` 周期任务 |
| 存量 session 无 sidecar | 菜单自然禁用;新 send 起开始积累 |
| 退役 SDK 后行为差 | dry-run 强制先看;文案写明 untracked 删除 |

## 十四、落地顺序(实现计划输入)

1. `shadow-git` + 单元测试(无 session)。
2. `snapshot-store` + 生命周期钩子。
3. send 预拍 + 泵 step-finish/patches。
4. 重写 `rewindFiles` + 能力/diff 路由。
5. 退役 provider SDK rewind 面。
6. 客户端菜单/文案/条件。
7. 集成测试 + 文档(CONFIG/CLAUDE.md 摘要)。

## 十五、已拍板的实现默认(原开放项)

1. anchors 第一版走 **REST**,菜单打开时拉一次;不进 WS `session-update`。
2. odb **per-session**(`key = sessionId`);共享 odb 列为后续优化。
3. patches **第一版就写入** sidecar(成本低,避免以后迁移格式)。

---

**决策记录**:2026-09-20 与用户逐项确认:主目标 1+2(+5);退役 SDK rewind(A);cwd scope(A);C+ 拍摄点;非 git 禁用(A);Tier 2 存储;JSONL 只作身份骨架不承载 TreeID。
