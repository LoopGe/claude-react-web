# Session Worktree 隔离设计

日期:2026-10-14
状态:已评审(设计对话逐节确认)

## 背景与问题

claude-react-web 允许多个 session 挂同一个仓库,但所有 session 共享同一个工作目录:两个 session 同时 Edit/Write 会互相踩踏,一个 session 的中间状态(未提交改动、临时文件)对另一个 session 的 agent 完全可见。

参考 multica 的 per-task worktree 机制(`server/internal/daemon/execenv/local_worktree.go`、`gitroot_lock.go`),为本项目引入 **per-session git worktree 隔离**:勾选后,session 在独立 worktree 中运行,agent 的所有文件操作只影响该 worktree,主仓工作区不受影响。

## 已确认的产品决策

1. **触发方式**:手动 opt-in(新建 session 对话框勾选),默认关。与 multica 的资源绑定模式同构。
2. **生命周期**:删除 session 时移除 worktree 目录,**保留分支**(改动需已提交才安全,删除确认对话框兜底)。
3. **回合策略**:v1 不做 merge-back。用户在 GitPanel 看 diff、在 worktree 里 commit(现有 commit 功能可用),然后自行在主仓 merge 分支。

## 核心架构决策:创建即替换(方案 A)

worktree 路径直接作为 session 的 `cwd`(`SessionMeta.cwd` 写 worktree 路径),另加 `worktree` 元数据字段做生命周期管理。所有现成的 cwd 消费者(SDK `Options.cwd`、git 路由、shadow 快照、GitPanel、subagent-watcher 的 `encodeCwd`)零改动自然工作。

选此方案的理由(经代码探索验证):

- **shadow 快照已 worktree-aware**:`server/snapshot/shadow-git.ts` 显式区分 per-worktree `gitDir` 与共享 `commonDir`,alternates 指向主仓 object store,不依赖 `<cwd>/.git` 字面路径——rewind 在 worktree 下天然可用。
- **git-snapshot 广播天然分组**:`gitGroupKey`(`server/session-broadcaster.ts`)用 `repoRoot`(`rev-parse --show-toplevel`),不同 worktree 的 toplevel 不同,自动隔离,无需改 git-broadcast。
- `tryCaptureGitHead` / `getGitDir`(`rev-parse --git-dir`)、`runGit` 全部以 cwd 为子进程目录,无 `.git` 字面路径假设。

否决的方案:

- **虚拟 cwd 翻译**(meta.cwd 保持主仓,消费点逐一翻译):消费点遍布 session-manager、routes、snapshot、subagent-watcher,漏一处即"改了主仓"事故。
- **per-turn worktree**(multica 全套):为无人值守批量任务设计(lease、finalize、snapshot index),交互式对话场景下 per-session 粒度已足够。

## 数据模型

`server/session-types.ts` 的 `SessionMeta` 新增可选字段:

```ts
worktree?: {
  mainRepoPath: string   // 用户主仓路径(UI 展示、fork 回退、recreate 来源)
  branch: string         // 随建分支名,crw/<sessionId 前 8 位>
  baseSha: string        // 创建时主仓 HEAD,recreate 兜底
}
```

`meta.cwd` = worktree 路径(方案 A 核心)。sessionId 全局唯一,分支名不撞;删除留分支后,同仓反复建 session 各有独立分支名。

## 创建流程

1. `POST /api/sessions` body 新增 `isolateWorktree?: boolean`。
2. `sm.create()` 在 spawn 前:
   - 确认 cwd 是 git 仓库且 HEAD 存在(记录 `baseSha`);
   - 在进程内 mutex 保护下执行 `git worktree add -b crw/<id8> <stateDir>/worktrees/<sessionId> HEAD`;
   - `meta.cwd` = worktree 路径,记 `worktree` 元数据。
3. 后续照旧:spawn 时 `tryCaptureGitHead` 对 worktree 捕获(与创建时主仓 HEAD 相同 commit);shadow 快照首次 capture 自动记录 worktree gitDir。

worktree 存放位置:`<stateDir>/worktrees/<sessionId>`。理由:stateDir 已是 sidecar 之家;不污染用户项目;路径确定性是重建的前提。

## 删除流程

现有 delete 流程追加:若 `meta.worktree` 存在 → `git worktree remove --force`(best-effort,失败仅 log warn 不阻塞)+ `worktree prune`;**分支保留**。前端删除确认前查 dirty(`GET /sessions/:id/worktree-status`),dirty 时确认文案追加丢失警告。

## Fork

fork 隔离 session 时**回到主仓**:cwd = `worktree.mainRepoPath`,清 `worktree` 字段。理由:两 session 共享一个 worktree 是事故源;fork 再建 worktree 超出 v1;用户可在 fork 后再勾隔离。注意现状:fork 副本定位(`copySubagentTranscripts`)按 `encodeCwd(cwd)` 寻址,回退主仓后该寻址语义仍一致。

## Resume(worktree 重建链)

worktree 可重建:路径确定 + 分支保留。resume 时:

1. worktree 路径存在 → 直接用;
2. 分支存在 → `worktree add` 同路径同名分支重建(含已提交状态;未提交改动已随删除确认告知);
3. 分支没了但 `baseSha` commit 存在 → 从 baseSha 重建同名分支;
4. 都不行 → cwd 回退 `mainRepoPath`,清 `worktree` 字段(session-update 广播刷新 UI);
5. 主仓也没了 → 落入现有 `cwdMissing` 400 流程(PATCH cwd 恢复路径不变)。

这取代了现状"worktree 目录没了 → resume 400"的体验。

## setCwd

PATCH cwd 改隔离 session 的目录:清 `worktree` 字段,并**失效该 session 的 snapshot store**(顺路修复现存坑:`server/snapshot/snapshot-service.ts` 的 `resolveRepo` 命中持久化 meta 即复用、不校验 cwd;`setCwd` 此前只清 git 锚点不清快照)。

## git.ts 新增原语

遵循"git 一律走 `runGit()`"约定:

- `createWorktree(mainRepoCwd, worktreePath, branch, baseRef)` — `worktree add -b`;
- `removeWorktree(mainRepoCwd, worktreePath)` — `remove --force` + `prune`(分支不动);
- `worktreeIsDirty(cwd)` — `status --porcelain` 判空,删除确认用。

## 并发保护

单进程 Node,进程内 promise 链 mutex 即可(multica 用文件锁是因多进程 daemon)。mutex key = `rev-parse --git-common-dir` 解析结果——`worktree add/remove/prune` 竞争的是主仓共享的 `worktrees/`、`packed-refs.lock`(multica `gitroot_lock.go` 的洞见),必须按 common dir 加锁,同一主仓的并发创建/删除串行化。

## UI

- **NewSessionDialog**:cwd 旁勾选框"隔离到独立 worktree",hint:"改动进独立分支(`crw/…`),不影响主仓工作区;worktree 从 HEAD 干净检出,不含 gitignore 文件(如 `.env`、`node_modules`)". 服务端 400 时内联展示错误。不做客户端 git 预判(两端同版本,multica 的 `server_outdated` 守卫不适用)。
- **ChatPanel header**:cwd chip 加 "worktree" badge,tooltip 显示主仓路径、分支名、worktree 路径。数据来自现有 `session.meta`,零新请求。
- **删除确认**:dirty 时追加"⚠ worktree 有未提交改动,删除后丢失(分支保留)"。
- **GitPanel**:零改动(cwd 即 worktree,全部语义正确)。

## 已知限制(明示,不做缓解)

- **untracked/ignored 文件不跟随**:`worktree add` 只检出已跟踪文件,`.env`、`node_modules`、`dist` 不在 worktree 中,agent 首次运行可能需自行安装依赖。v1 不复制(拷 node_modules 又慢又脏),仅 UI hint 说明。
- per-session 独立 worktree 天然规避了 multica 需要处理的"主仓 untracked 文件遮蔽"问题,无需对应机制。

## 错误处理汇总

| 场景 | 处理 |
|---|---|
| cwd 非 git 仓库 | 400,内联文案 |
| unborn HEAD(无 commit) | 400:"worktree 隔离需要至少一个 commit" |
| 分支名撞车 | 理论不可能;保底时间戳后缀重试一次 |
| `worktree add` 失败 | 400 返回 git stderr,session 不创建(已确认:provisionWorktree 将 runGit 的 HttpError(500) 转为 400) |
| `worktree remove` 失败 | best-effort log,删除继续;残留被同路径重建覆盖 |
| resume 时 worktree 没了 | 重建链(见上) |
| 主仓没了 | 现有 `cwdMissing` 400 流程 |
| 隔离与主仓 session 并存 | git-snapshot 按 toplevel 天然分组,零改动 |

## 附带修复(本设计触及的现存缺陷)

1. `server/git.ts` `linkedWorktrees` 探测(`join(repoRoot, '.git', 'worktrees')`)在 worktree cwd 下 `.git` 是文件、恒为空——改用 `--git-common-dir` 解析。修复后隔离 session 内 ChatPanel 的 agent worktree chip 也正常。
2. `setCwd` 不失效 snapshot store(与 `resolveRepo` 的 meta 复用叠加,cwd 迁移后快照指向旧目录)——setCwd 时失效。

## 明确不做(YAGNI)

merge-back 按钮、复制 untracked/ignored 文件、per-turn worktree、worktree 列表管理页、fork 出独立 worktree、客户端 git 预判。

## 已知偏差(实现相对本设计的偏差)

- NewSessionDialog 的 400 错误走既有全局 toast 通道,而非设计中的"内联展示错误"(与对话框其余错误处理保持一致)。
- discard 语义 = fork 回主仓 + 清理源 session 的 worktree(遵循 fork ruling:两个 session 共享一个 worktree 是 clobber 隐患);设计原文未涵盖 discard 路径。

## 测试策略

- **单元测试**(vitest node 环境,临时目录建真 git 仓库,不碰 agent CLI——符合仓库测试规约):`createWorktree` / `removeWorktree` / `worktreeIsDirty` / mutex 串行化 / `linkedWorktrees` 在 worktree cwd 下的回归。
- **session-manager 集成测试**:创建即替换 cwd、删除留分支、resume 重建链三分支(路径在/分支在/全没)、fork 回主仓、setCwd 清字段 + 快照失效。
- **UI 测试**:NewSessionDialog 勾选与 400 错误透传。
- **E2E**(playwright,可选):隔离创建 → badge 显示 → 删除清理 happy path。
