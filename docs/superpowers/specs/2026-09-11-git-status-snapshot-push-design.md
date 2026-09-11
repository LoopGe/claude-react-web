# 2026-09-11 · Git 快照推送(按 repoRoot 扇出的状态内联广播)

> **承接**:现有 `git-status-changed` 哑信号 + 客户端按需 refetch 机制。本 spec 把 git 状态(status / branches / stashes)从"信号 + N 个客户端各自拉"重构为"服务端算一次快照、按 repoRoot 扇出、客户端零 fetch 的 sink"。同二进制交付,无跨版本兼容负担。

## 一、背景与动机

调研确认的现状:

- **读数据是 cwd 维度**:`/api/git/status?cwd=…`、`getStatusCached(cwd)`(500ms TTL 合并羊群)、`listBranches(cwd)` / `listStashes(cwd)`——服务端数据层设计正确。
- **失效广播是 session 维度**:`broadcastGitStatusChanged(id)`(`session-broadcaster.ts:188-204`)只推给触发 session 自己的 `gitStatusSubscribers`。
- **客户端是 per-hook-instance**:`ChatPanel.tsx:477` 每个面板各自 `useGitStatus(session.cwd, session.id)`,各自 `useState` + fetch + WS 订阅;`useGitBranches` / `useGitStashes` 同理(且挂在 `/sessions/:id/git/branches|stashes` 下,纯 cwd 读却走 session 路由)。

由此产生的问题:

1. **跨 session 不失效(正确性 bug)**:session A 的 Claude 改了文件 → 广播只到 A → 同 cwd 的 session B 的 chip / GitPanel 永久 stale,直到手动刷新。用户在 B 的 panel commit,A 同样看不到。
2. **重复 fetch + 短暂不一致**:同 cwd 两个面板各自发 HTTP,刷新时机漂移,可能一边新一边旧;`git-status-changed` 是哑信号(不分动了什么),客户端收到就全量重拉三样(status/branches/stashes),开着 panel 时每次文件编辑都白跑 `git branch -a` + `git stash list`。
3. **信号丢失 = 永久 stale**:git 通道 pushable `maxDepth=20` 溢出丢帧、或断线重连无 replay,客户端没有任何自愈机制。

**核心洞察**:git 状态是**工作目录的属性**,不是 session 的属性;status / branches / stashes 三者都是小(KB 级)、幂等、watching 就一定想要的全量态——不该发"请来取",该直接把快照塞进 frame 推出去。信号 + refetch + 500ms 羊群缓存三层机制互相补偿的正是这一个设计选择;换成快照内联后三层全部消失。

## 二、目标 / 非目标

**目标**

- `git-status-changed` 哑信号升级为 `git-snapshot` 快照帧,内联携带 `{status, branches, stashes}` 完整快照。
- 扇出范围从"触发 session 的订阅者"扩为"所有同 repoRoot(回退 cwd)session 的订阅者"——修跨 session 失效。
- 新 WS 订阅者立即 seed 最近一帧快照(照抄 `subscribeTasks` 模式),首屏不用等 HTTP。
- 客户端 status / branches / stashes 三个 hook 全部 sink 化:收到帧直接替换 state,零 refetch。
- branches / stashes 读路由从 `/sessions/:id/git/*` 迁到 `/api/git/branches?cwd=` / `/api/git/stashes?cwd=`,与 status 对齐。
- 退役 `getStatusCached` / `invalidateStatusCache`(羊群问题不复存在)。

**非目标(YAGNI,明确不做)**

- **FS watcher**:应用外编辑(IDE 改文件、外部终端 commit)的实时感知。触发源仍是 mutating tool_result + 用户写路由;这是独立的演进方向,不与本次混合。
- **per-cwd WebSocket 通道**:语义更纯但要动协议 / 订阅引用计数 / 通道管理;服务端扇出拿到 95% 收益,协议改动接近零。
- **快照差量推送**:全量 frame 足够(KB 级)。
- **按触发源差异化推送内容**(如 Edit 只推 status):维护触发源→列表映射表的收益不抵漏判风险;经确认选全量内联。
- diff / log / range-diff:贵且按需(展开行才 fetch),保持现状。
- "This session" 区(session-files / session-diff / gitStartSha):真 session 维度,不动。
- GitPanel UI 本地态(filter / commit 草稿 / 选中行):per-panel 保持。
- 写路由路径(`/sessions/:id/git/*`):仍挂 session(审计 + 触发广播),响应体仍带新鲜列表(发起方直通快捷通道保留)。

## 三、架构与数据流

**现状**:

```
tool_result / 写路由 → debounce(500ms, per-session) → 哑信号 {kind, sessionId}
  → 只推触发 session 的订阅者
  → 客户端各自 refetch status/branches/stashes(N 个客户端 N×3 次 HTTP)
  → getStatusCached 500ms TTL 合并羊群
```

**目标**:

```
tool_result / 写路由 → debounce(500ms, per-repoRoot key) → 服务端算一次
    { status: getStatus(cwd), branches: listBranches(cwd), stashes: listStashes(cwd) }
  → frame 携带完整快照
  → 存入 seed 缓存
  → 扇出给所有同 key session 的订阅者
  → 新订阅者 subscribe 时立即 seed 最近一帧
  → 客户器收到帧直接替换 state,零 fetch
```

**随之消失的机制**:

- `getStatusCached` 500ms TTL 羊群缓存——问题不存在,退役(`getStatus` 保留给 mount 初始 fetch 与写路由的 freshStatus)。
- 客户器"收信号 → 发 HTTP"路径——status / branches / stashes 三个 hook 全变纯 sink。
- 丢帧永久 stale——快照幂等可丢,下一帧自愈;maxDepth 还可以从 20 降到 5(见协议节)。

**客户端为何不需要共享 store**:服务端把同一帧推到每个同组 session 的通道,两个面板的 hook 独立收到内容相同的帧、各自 setState——天然一致,无需跨实例缓存协调。

## 四、协议变更

`shared/ws-protocol.ts`:`git-status-changed` 帧**直接替换**为 `git-snapshot`(不保留旧帧;同二进制交付):

```ts
interface WsGitSnapshot {
  kind: 'git-snapshot'
  sessionId: string        // 触发方,仅审计/日志;客户端不按它路由
  cwd: string              // 触发 session 的工作目录
  repoRoot: string         // 分组键;repoRoot 捕获失败时回退为 cwd
  status: GitStatusResponse
  branches: GitBranch[]
  stashes: GitStashEntry[]
}
```

- git 通道 pushable `maxDepth` 从 20 降为 **5**:快照是 fat frame 且幂等可丢,浅队列省内存、丢帧自愈。
- `src/ws-types.ts` 绑定同步更新;全仓 grep 确认 `git-status-changed` 字面量无残留(CLAUDE.md / AGENTS.md 的协议清单同步改写)。

## 五、服务端改造

### 5.1 repoRoot 捕获

- spawn 时与 `tryCaptureGitHead` 同一时机多跑一次 `git rev-parse --show-toplevel`,存入 `SessionMeta.repoRoot?: string`(`persistence.ts` coerce 同步加字段,沿用 gitStartSha 的软校验:非 string 丢弃)。
- 捕获失败(非 repo / git 报错)→ `undefined`。**分组键回退为 cwd 字符串**:两个 session 必须 cwd 完全相等才共享。
- 升级前落盘的旧 session 无 repoRoot:重 spawn 自然补齐;过渡期新旧 key 不匹配导致不共享,可接受(下次 respawn 自愈)。
- worktree session 的 cwd / repoRoot 都是 worktree 自己的路径,自成一组,天然隔离。

### 5.2 broadcastGitStatusChanged 重写(`session-broadcaster.ts`)

```
broadcastGitStatusChanged(id: string, opts?: { snapshot?: GitSnapshotPayload }): void
```

1. 取触发 session `s`;解析分组键 `key = s.repoRoot ?? s.cwd`。
2. **debounce 按 key 计时**(不再按 sessionId):同 repo 两 session 的编辑突发合并为一次计算、一帧扇出。`git-broadcast.ts` 的 timers map 改为 key 维度;`cancelGitBroadcast(sessionId)` 只在定时器的触发源就是该 session 时才取消(A unload 不误杀 B 的 pending 广播)。DEBOUNCE_MS 保持 500。
3. 计算快照:写路由路径经 `opts.snapshot` 传入现成的 fresh status/branches/stashes(避免二次 git spawn);pump 自动检测路径不传,由广播函数现算 `{status: getStatus(cwd), branches: listBranches(cwd), stashes: listStashes(cwd)}`。
4. 存入 seed 缓存 `Map<groupKey, GitSnapshotPayload>`;最后一个 session 离开该组时删除该 entry(session remove 路径挂钩)。
5. 遍历 `this.sessions`,把帧推给所有 `(session.repoRoot ?? session.cwd) === key` 的 session 的 `gitStatusSubscribers`。
6. 计算失败:`log.warn`,不推帧、不抛;客户端保持上次已知状态,下个事件自然重试。

### 5.3 seed(`subscribeGitStatus`)

返回值加 `snapshot?: GitSnapshotPayload` 字段(照抄 `subscribeTasks` 的 snapshot 模式):`server/ws.ts` 给新订阅者先把最近一帧灌进 pushable 再进 live 流——刚打开的 tab 即时有数据。seed 缓存为空(server 重启后首挂)则无 seed,客户端靠 mount fetch。

### 5.4 读路由迁移(`server/git-routes.ts`)

- 新增 `GET /api/git/branches?cwd=` 与 `GET /api/git/stashes?cwd=`(沿用 git-routes 现有 requireCwd 校验模式)。
- 删除 `GET /sessions/:id/git/branches` / `GET /sessions/:id/git/stashes`(`routes/git-write.ts` 中仅这两条 GET;所有 POST 写路由不动)。

### 5.5 退役

- `getStatusCached` / `invalidateStatusCache` / `STATUS_CACHE_TTL_MS` / `statusCache`(`server/git.ts`)整体删除;调用点改为 `getStatus`。`getStatus` / `getStatusInRepo` 保留。
- 广播路径中的 `invalidateStatusCache(s.cwd)` 调用随重写移除。

## 六、客户端改造

### 6.1 `useGitStatus`(sink 化)

- mount 仍 fetch 一次 `GET /api/git/status?cwd=`(ground truth,兜住应用外编辑 + server 重启后 seed 为空的场景)。
- 收到 `git-snapshot` 帧**直接替换** state(status / branches / stashes 三份一起),不 bump tick、不发 HTTP。
- **帧应用守卫**(防串数据,核心场景是 WorktreeChanges:hook 的 cwd 是 worktree 路径,却订阅在主 repo session 的通道上):
  - 已有 repo 权威数据(`data.isRepo === true && data.repoRoot` 存在,来自 mount fetch):仅当 `frame.repoRoot === data.repoRoot` 才应用——同 repo 不同子目录 cwd 的 session 也能正确匹配;
  - 其它情况(首帧前 / `isRepo:false`):`frame.cwd === cwd || frame.repoRoot === cwd` 才应用,否则丢弃、继续等 mount fetch。子目录 session 在 mount fetch 返回前可能丢弃匹配帧,可接受(HTTP 已覆盖)。
- 手动 refresh(⟳)保留,仍走 HTTP tick。
- 首帧前 loading 语义不变;有数据后帧替换**不**闪 loading(快照是完整态)。

### 6.2 `useGitBranches` / `useGitStashes`(签名变更 + sink 化)

- 入参从 `(sessionId, enabled)` 改为 `(cwd, sessionId, enabled)`:cwd 管 fetch,sessionId 只管 WS 订阅。
- mount fetch 走新路由 `GET /api/git/branches|stashes?cwd=`。
- 收到 `git-snapshot` 帧直接替换列表,无需 useGitStatus 的 cwd/repoRoot 守卫:守卫只为 WorktreeChanges 的 cwd 错位场景存在,而 branches/stashes 只在 GitPanel 内使用(cwd 恒为 session.cwd);服务端扇出已保证同通道帧必属本组。

### 6.3 `useGitWsRefresh` 重写

从"收到信号 → bump tick"改为"收到帧 → 回调携带整帧"(`(frame: WsGitSnapshot) => void`);三个 hook 各自回调做字段级应用。

### 6.4 不变部分

- `useGitDiff` / `useGitLog` / `useGitRangeDiff` / `useGitRangeDiffFile`:按需 fetch + 手动 refresh,一行不动。
- `useGitWrite`:写路由响应体带新鲜列表的发起方直通通道保留;写完后扇出帧让其它 panel 更新。
- 组装方式:status 仍在 ChatPanel 提升、props 下传 GitPanel 与 chip;branches / stashes 仍在 GitPanel 内部 hook。
- 去重:发起方会同时收到响应体直通与扇出帧,内容相同幂等;不做特殊去重。

## 七、边界情况

| 场景 | 行为 |
| --- | --- |
| Worktree session | cwd / repoRoot 自成一组;主 repo 的帧被守卫拦掉,WorktreeChanges 不串数据 |
| 非 repo cwd | repoRoot 捕获失败 → key 回退 cwd;快照是 `{isRepo:false}` + 空列表,照推,客户端已有空态 |
| Server 重启 | seed 缓存清零;客户端 mount fetch 是唯一数据源;首个 mutation 广播后 seed 重建 |
| cwd 切换 / EnterWorktree 落地瞬间 | hook effect 依赖 cwd,重置 state + 重订阅;旧帧被守卫拦或随退订消失;最多一次多余 mount fetch |
| 广播计算慢 | debounce 重置合并,不并发计算;极端慢 repo 只是广播延迟,不堆积 |
| 丢帧(maxDepth=5 溢出) | 快照幂等,下一帧自愈;比现状哑信号丢帧(永久 stale)严格更优 |
| 同 repoRoot 不同子目录 cwd 的两 session | 共享快照(status 路径本就相对 repoRoot,内容一致) |

## 八、测试策略

**服务端单测**:

- 扇出:同 repoRoot 两 session 都收到帧;repoRoot 不同不收;无 repoRoot 的旧 meta 按 cwd 回退分组正确。
- debounce 按 key:同 repo 两 session 连续触发 → 只算一次、只推一帧;`cancelGitBroadcast` 只杀触发源自身的定时器。
- 快照内容:三字段齐全;写路由传 snapshot 时不重复调 git 函数(spy 断言)。
- seed:新订阅者立即收到最近一帧;最后一个 session 离开组后 seed entry 删除。
- 计算失败:不推帧、不抛、warn 落日志。

**客户端 hook 测试(jsdom)**:

- 收帧直接替换 state,fetch spy 断言零 HTTP 调用。
- 守卫:已有 repo 数据时 repoRoot 不匹配的帧丢弃;无数据时按 cwd 匹配、子目录 pre-fetch 丢帧可接受。
- mount fetch 仍恰好一次;手动 refresh 仍走 HTTP;enabled=false / 无 cwd 时收帧不应用。

**回归**:

- 现有 `git-broadcast.test.ts` / `git.test.ts` 中涉及 `invalidateStatusCache` / `getStatusCached` 的用例随退役删除或改写。
- 全仓 grep `git-status-changed` 无代码残留(文档清单同步更新)。
- `npm run typecheck`(双 tsconfig)+ `npm run test` + `npm run lint` 全绿。

## 九、实施影响面

| 区域 | 文件 | 改动性质 |
| --- | --- | --- |
| 协议 | `shared/ws-protocol.ts`, `src/ws-types.ts`, `server/ws-protocol.ts` | 帧替换 |
| 广播 | `server/session-broadcaster.ts`, `server/git-broadcast.ts`, `server/session-types.ts`, `server/session-manager.ts` | 重写扇出 + debounce key + seed |
| SessionMeta | `server/session-types.ts`, `server/persistence.ts`, spawn 路径(`session-manager.ts`) | 加 repoRoot |
| 读路由 | `server/git-routes.ts`, `server/routes/git-write.ts` | 加 2 条 GET,删 2 条 GET |
| git 层 | `server/git.ts` | 退役 cached 变体;加 repoRoot 捕获 helper(或扩展 tryCaptureGitHead) |
| 客户端 hooks | `src/hooks/useGitStatus.ts` | sink 化 + 签名变更 |
| WS 接线 | `server/ws.ts` | seed 接线 + 帧类型 |
| 文档 | `CLAUDE.md`, `AGENTS.md` 协议清单 | 同步改写 |
| 测试 | 上述模块对应 test 文件 | 见第八节 |
