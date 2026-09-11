# Git 快照推送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 git 状态（status/branches/stashes）从"per-session 哑信号 + 客户端各自 refetch"重构为"服务端按 repoRoot 算一次快照、内联进 `git-snapshot` WS 帧扇出、客户端 hook 零 fetch 的 sink"。

**Architecture:** 服务端 `SessionEventBroadcaster.broadcastGitStatusChanged` 重写为：解析分组键（`repoRoot ?? cwd`）→ 计算（或复用写路由传入的）三合一快照 → 存 seed 缓存 → 扇出给所有同组 session 的订阅者。`git-broadcast.ts` 的 debounce 按分组键计时。客户端 `useGitStatus` / `useGitBranches` / `useGitStashes` 变成帧 sink：mount 时 HTTP fetch 一次 ground truth，之后收到帧直接替换 state。`getStatusCached` 羊群缓存退役。

**Tech Stack:** TypeScript, Hono, WebSocket（现有 useWsHub 多路复用）, Vitest（服务端 Node + 客户端 jsdom）

**Spec:** `docs/superpowers/specs/2026-09-11-git-status-snapshot-push-design.md`（本计划论证依据，执行者需同时阅读）

## Global Constraints

- 同二进制交付：server/client 一起发布，**无跨版本兼容负担**——旧帧 `git-status-changed` / 旧路由 `GET /sessions/:id/git/branches|stashes` 直接删除，不留兼容层。
- 日志一律走 `createLogger(scope)`（`server/log.ts`）；禁用裸 `console.*`。
- 禁止添加 fallback / default / workaround 代码；失败路径按 spec：广播计算失败 → `log.warn`、不推帧、不抛。
- 所有诊断值变化需先有日志/测试证明；本计划的测试即证明。
- 每个任务结束时 `npm run typecheck`（两个 tsconfig）与相关测试必须全绿后再 commit。
- commit message 用英文 conventional commits；不加 Co-Authored-By 之外的 trailer。
- CSS / 颜色：本计划不涉及 UI 样式，如实现中被迫触碰样式，颜色必须用 theme CSS 变量。

---

### Task 1: `tryCaptureRepoRoot` — git 层 repoRoot 捕获

**Files:**
- Modify: `server/git.ts`（`tryCaptureGitHead` 之后，约 1108 行处新增函数）
- Test: `server/git.test.ts`（`tryCaptureGitHead` describe 块之后新增 describe）

**Interfaces:**
- Consumes: 现有 `isInsideWorkTree(cwd)`、`runGit(cwd, args, opts)`（均在同一文件）
- Produces: `export async function tryCaptureRepoRoot(cwd: string): Promise<string | undefined>` —— 返回 work-tree top level 的绝对路径（`git rev-parse --show-toplevel` 输出，Windows 下为正斜杠形式，如 `D:/codes/repo`）；任何失败（非 repo / git 缺失 / 超时 / 空输出）返回 `undefined`，永不抛。Task 2 的 `captureGitHead` 消费它。

- [ ] **Step 1: 写失败测试**

在 `server/git.test.ts` 的 `tryCaptureGitHead` describe 块之后新增（沿用该文件已有的 `gitOk` / `initRepo` / 临时目录工具，先读该文件确认助手函数名与清理模式再落笔）：

```ts
describe('tryCaptureRepoRoot', () => {
  it.skipIf(!gitOk)('returns the work-tree top level inside a repo', async () => {
    const dir = await initRepo() // 沿用文件内已有的临时 repo 助手
    const root = await tryCaptureRepoRoot(dir)
    expect(root).toBe(normalize(dir)) // git 输出正斜杠；用与 tryCaptureGitHead 测试相同的路径规范化方式比较
  })

  it.skipIf(!gitOk)('resolves subdirectory cwd to the repo root', async () => {
    const dir = await initRepo()
    const sub = join(dir, 'packages', 'app')
    await mkdir(sub, { recursive: true })
    const root = await tryCaptureRepoRoot(sub)
    expect(root).toBe(normalize(dir))
  })

  it('returns undefined for a non-repo directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crw-norepo-'))
    try {
      expect(await tryCaptureRepoRoot(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for a nonexistent directory', async () => {
    expect(await tryCaptureRepoRoot(join(tmpdir(), 'crw-does-not-exist-' + Math.random()))).toBeUndefined()
  })
})
```

> 实现者注：`normalize` 指该测试文件里比较 `tryCaptureGitHead` 之外路径时已有的规范化手段（若无，用 `root.replace(/\\/g, '/')` 与 `dir` 的正斜杠形式比较）。`initRepo` 等助手名以文件实际为准——先读 `server/git.test.ts` 的 setup 区再写。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/git.test.ts -t tryCaptureRepoRoot`
Expected: FAIL（`tryCaptureRepoRoot is not a function` 或 import 失败）

- [ ] **Step 3: 最小实现**

在 `server/git.ts` 的 `tryCaptureGitHead` 函数之后新增：

```ts
/** Best-effort work-tree top-level capture — the absolute path git
 *  reports for the repository root (`git rev-parse --show-toplevel`).
 *  Used at session spawn as the git-snapshot fan-out group key: two
 *  sessions whose cwds sit in the same repo (including different
 *  subdirectories) share one snapshot. Windows output is forward-slashed
 *  (D:/codes/repo) — both sessions capture through this same command, so
 *  the keys are consistently normalized. Returns undefined for every
 *  failure (not a repo, git missing, timeout, empty output); callers
 *  fall back to cwd string equality. Never throws. */
export async function tryCaptureRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    if (!(await isInsideWorkTree(cwd))) return undefined
    const r = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 5_000 })
    if (r.exitCode !== 0) return undefined
    const root = r.stdout.trim()
    return root || undefined
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/git.test.ts -t tryCaptureRepoRoot`
Expected: PASS（全部 4 个；无 git 环境时 skipIf 跳过前两个）

- [ ] **Step 5: Commit**

```bash
git add server/git.ts server/git.test.ts
git commit -m "feat(git): add tryCaptureRepoRoot for spawn-time repo root capture"
```

---

### Task 2: `repoRoot` 进 Session / SessionMeta / 持久化 / spawn

**Files:**
- Modify: `server/session-types.ts`（`Session` 接口，`gitStartSha` 字段后约 362 行）
- Modify: `server/persistence.ts`（`SessionMeta` 接口约 96 行 + `coerceMeta` 约 258 行）
- Modify: `server/session-manager.ts`（`writeStore` 约 907 行；`captureGitHead` 约 1998 行；spawn 的 Session 字面量约 2200 行）
- Test: `server/persistence.test.ts`（沿用 gitStartSha 的测试模式，约 132-143 与 257-268 行处）

**Interfaces:**
- Consumes: Task 1 的 `tryCaptureRepoRoot(cwd)`
- Produces: `Session.repoRoot?: string` 与 `SessionMeta.repoRoot?: string` —— spawn 时 fire-and-forget 捕获并 `writeStore` 持久化；resume 从 meta 携带。Task 4 的 `gitGroupKey(s)` 读取 `s.repoRoot`。

- [ ] **Step 1: 写失败测试**

在 `server/persistence.test.ts` 中，紧挨现有 gitStartSha 的两个用例（`preserves gitStartSha across upsert + reload` 与 `drops non-string gitStartSha during coerce`）之后新增：

```ts
it('preserves repoRoot across upsert + reload', async () => {
  const store = await makeStore() // 沿用文件内已有的 store 工厂助手
  store.upsert(makeMeta('a', { repoRoot: 'D:/codes/repo' }))
  const loaded = store.list()
  expect(loaded.find((m) => m.id === 'a')?.repoRoot).toBe('D:/codes/repo')
})

it('drops non-string repoRoot during coerce', async () => {
  const store = await makeStore()
  store.upsert(makeMeta('b', { repoRoot: 42 as unknown as string }))
  const loaded = store.list()
  expect(loaded.find((m) => m.id === 'b')?.repoRoot).toBeUndefined()
})
```

> 实现者注：`makeStore` / `makeMeta` 是该测试文件已有的助手（先读文件顶部确认实际名字与签名；`makeMeta` 需支持传入部分字段覆盖）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/persistence.test.ts -t repoRoot`
Expected: FAIL（`repoRoot` 不在 SessionMeta 类型上 → TS 编译错，或 coerce 丢字段 → 断言失败）

- [ ] **Step 3: 最小实现**

3a. `server/session-types.ts` —— `Session` 接口 `gitStartSha?: string` 字段后新增：

```ts
  /** Work-tree top level captured at spawn (git rev-parse --show-toplevel).
   *  The git-snapshot fan-out group key: sessions sharing a repoRoot share
   *  one pushed git snapshot. Undefined for non-repo cwds (fallback key:
   * cwd) and for sessions spawned before this field existed (until their
   * next respawn). Persisted via SessionMeta. */
  repoRoot?: string
```

3b. `server/persistence.ts` —— `SessionMeta` 接口 `gitStartSha?: string` 后新增：

```ts
  /** Work-tree top level captured at spawn. See Session.repoRoot. */
  repoRoot?: string
```

并在 `coerceMeta` 的 `gitStartSha: typeof r.gitStartSha === 'string' ? r.gitStartSha : undefined,` 之后新增一行：

```ts
    repoRoot: typeof r.repoRoot === 'string' ? r.repoRoot : undefined,
```

3c. `server/session-manager.ts` —— 三处：

`writeStore` 的 `gitStartSha: s.gitStartSha,`（约 907 行）之后新增：

```ts
      repoRoot: s.repoRoot,
```

spawn 构造的 Session 字面量中 `gitStartSha: existingMeta?.gitStartSha,`（约 2200 行）之后新增：

```ts
      repoRoot: existingMeta?.repoRoot,
```

`captureGitHead` 方法（约 1998 行）整体替换为（保留原有 gitStartSha 逻辑，追加 repoRoot 捕获；注意守卫从 `if (!session.gitStartSha && session.cwd)` 放宽为先判 cwd，使 resume 时 meta 缺 repoRoot 也能补捕获）：

```ts
  /** Fire-and-forget capture of git anchors at session spawn: the
   *  worktree's HEAD SHA (gitStartSha, "This session" anchor) and the
   *  work-tree top level (repoRoot, git-snapshot fan-out group key).
   *  Extracted from spawn() for readability; gitStartSha is only captured
   *  once per session (autoResume restores it from meta), while repoRoot
   *  is re-captured whenever missing so sessions persisted before the
   *  field existed heal on their next spawn. */
  private captureGitHead(session: Session): void {
    if (!session.cwd) return
    if (!session.gitStartSha) {
      void tryCaptureGitHead(session.cwd).then((sha) => {
        if (!sha || session.terminated || !this.sessions.has(session.id)) return
        session.gitStartSha = sha
        this.writeStore(session)
        this.broadcastGlobal({ kind: 'update', session: this.info(session) })
      }).catch(() => {})
    }
    if (!session.repoRoot) {
      void tryCaptureRepoRoot(session.cwd).then((root) => {
        if (!root || session.terminated || !this.sessions.has(session.id)) return
        session.repoRoot = root
        this.writeStore(session)
      }).catch(() => {})
    }
  }
```

import 行（约 43 行）改为：

```ts
import { tryCaptureGitHead, tryCaptureRepoRoot } from './git.js'
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run server/persistence.test.ts && npm run typecheck`
Expected: PASS + typecheck 零错误

- [ ] **Step 5: Commit**

```bash
git add server/session-types.ts server/persistence.ts server/session-manager.ts server/persistence.test.ts
git commit -m "feat(session): capture and persist repoRoot as git-snapshot group key"
```

---

### Task 3: 协议 —— 新增 `WsGitSnapshot` 帧（旧帧暂留）

**Files:**
- Modify: `shared/ws-protocol.ts`（`WsGitStatusChanged` 定义处约 259-267 行 + 联合类型约 439 行）
- Modify: `server/ws-protocol.ts:43`（re-export）
- Modify: `src/ws-types.ts:39`（re-export）

**Interfaces:**
- Consumes: `shared/git-types.ts` 的 `GitStatusResponse` / `GitBranch` / `GitStashEntry`（已有导出；git-types 不依赖 ws-protocol，无循环 import）
- Produces: `export interface WsGitSnapshot { kind: 'git-snapshot'; sessionId: string; cwd: string; repoRoot: string; status: GitStatusResponse; branches: GitBranch[]; stashes: GitStashEntry[] }`，并加入 `WsServerFrame` 联合。Task 4 的 broadcaster 推送此帧；Task 8 的客户端消费。此任务**只做增量**，`WsGitStatusChanged` 保留（Task 8 删除）——保证每任务后编译绿。

- [ ] **Step 1: 实现（纯类型任务，typecheck 即测试）**

`shared/ws-protocol.ts` —— 文件顶部 import 区（现有无 git-types import；在文件头注释后新增）：

```ts
import type { GitStatusResponse, GitBranch, GitStashEntry } from './git-types.js'
```

在 `WsGitStatusChanged` 定义（约 259-267 行）之后新增：

```ts
/** Full git-state snapshot for one work tree, pushed after any
 *  filesystem-mutating event (Claude tool runs, user write routes).
 *  Replaces the old signal-only git-status-changed frame: the payload IS
 *  the fresh state, so clients apply it directly with zero refetch.
 *  `repoRoot` is the fan-out group key (spawn-captured work-tree top
 *  level, falling back to cwd for non-repo sessions); subscribers whose
 *  session shares that key receive the frame. `sessionId` is the
 *  trigger — clients must not route on it. Frames are idempotent and
 *  droppable: losing one self-heals on the next mutation. */
export interface WsGitSnapshot {
  kind: 'git-snapshot'
  sessionId: string
  cwd: string
  repoRoot: string
  status: GitStatusResponse
  branches: GitBranch[]
  stashes: GitStashEntry[]
}
```

`WsServerFrame` 联合（约 439 行）中 `| WsGitStatusChanged` 之后新增一行：

```ts
  | WsGitSnapshot
```

`server/ws-protocol.ts:43` 与 `src/ws-types.ts:39` 的 re-export 列表中，在 `WsGitStatusChanged` 旁追加 `WsGitSnapshot`：

```ts
export type { ..., WsGitStatusChanged, WsGitSnapshot, ... } from '...'
```

（保持各文件原有导出顺序风格，仅插入新名字。）

- [ ] **Step 2: typecheck 确认**

Run: `npm run typecheck`
Expected: 零错误（纯增量类型）

- [ ] **Step 3: Commit**

```bash
git add shared/ws-protocol.ts server/ws-protocol.ts src/ws-types.ts
git commit -m "feat(protocol): add WsGitSnapshot frame carrying status/branches/stashes inline"
```

---

### Task 4: broadcaster 重写 —— 快照计算、repoRoot 扇出、seed、maxDepth 5；ws.ts 推整帧

**Files:**
- Modify: `server/session-broadcaster.ts`（import 区、`subscribeGitStatus` 约 74-78 行、`broadcastGitStatusChanged` 约 188-204 行、新增私有成员与 helper）
- Modify: `server/session-types.ts`（`SessionBroadcaster` 接口：`broadcastGitStatusChanged` 签名约 777 行 + 新增两个方法）
- Modify: `server/session-manager.ts`（thin proxy：`subscribeGitStatus` 约 4410 行、`broadcastGitStatusChanged` 约 4471 行 + 新增两个 proxy）
- Modify: `server/ws.ts`（`case 'git'` 约 705 行）
- Test: 新建 `server/session-broadcaster.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Session.repoRoot`；Task 3 的 `WsGitSnapshot`；现有 `getStatus` / `listBranches` / `listStashes`（`server/git.ts`）；`createPushable` / `subscribePushableSet` 模式
- Produces:
  - `broadcastGitStatusChanged(id: string, opts?: { snapshot?: Partial<GitSnapshotPayload> }): void` —— fire-and-forget（内部 async，失败仅 warn）。`opts.snapshot` 为写路由已算好的字段（Partial：缺的字段广播内部补齐）。Task 6 的写路由传它；pump / rewind 不传。
  - `gitGroupKeyOf(sessionId: string): string | null`、`gitGroupLivePeer(sessionId: string): string | null` —— Task 5 的 git-broadcast 消费。
  - git 通道 pushable 携带完整 `WsGitSnapshot` 帧（含 kind）；`ws.ts case 'git'` 直接 enqueue 值。
  - `subscribeGitStatus` 返回 `{ iterable: AsyncIterable<WsGitSnapshot>; unsubscribe: () => void } | null`，新订阅者经 seed 回调收到缓存帧。
  - 定义 `GitSnapshotPayload = { status: GitStatusResponse; branches: GitBranch[]; stashes: GitStashEntry[] }`（broadcaster 文件内 type export，供 opts 使用）。

> **中间态说明：** 本任务完成后服务端只推 `git-snapshot`，客户端 hooks 仍监听旧 kind（运行时表现为 panel 暂不自动刷新），Task 8 立即接上。每个任务的单测/typecheck 仍全绿。

- [ ] **Step 1: 写失败测试**

新建 `server/session-broadcaster.test.ts`。先读 `server/permission-broker.test.ts` 约 50-80 行的 stub Session 构造方式（`as unknown as Session` 局部字段 stub），沿用同一模式。测试骨架（stub 字段以 `Session` 接口实际所需为准——broadcaster 只触碰 `id/cwd/repoRoot/gitStatusSubscribers/terminated`，其余字段可省）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionEventBroadcaster } from './session-broadcaster.js'
import type { Session } from './session-types.js'
import type { WsGitSnapshot } from './ws-protocol.js'

vi.mock('./git.js', () => ({
  getStatus: vi.fn(async () => ({ isRepo: true, repoRoot: '/r', branch: 'main', detached: false, ahead: 0, behind: 0, upstream: null, state: 'clean', linkedWorktrees: [], staged: [], unstaged: [], untracked: [] })),
  listBranches: vi.fn(async () => [{ name: 'main', current: true, upstream: null }]),
  listStashes: vi.fn(async () => []),
}))
import { getStatus, listBranches, listStashes } from './git.js'

function makeSession(id: string, cwd: string, repoRoot?: string): Session {
  return {
    id, cwd, repoRoot,
    gitStatusSubscribers: new Set(),
    terminated: false,
  } as unknown as Session
}

async function collect(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const f of iter) { out.push(f); if (out.length >= 1) break }
  return out
}

describe('SessionEventBroadcaster git-snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('computes status+branches+stashes once and fans out to all sessions sharing repoRoot', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const b = makeSession('b', '/repo/sub', '/repo') // 子目录 cwd，同 repoRoot
    const c = makeSession('c', '/other', '/other')    // 不同 repo — 不应收到
    const sessions = new Map([['a', a], ['b', b], ['c', c]])
    const bc = new SessionEventBroadcaster(sessions)
    const subA = bc.subscribeGitStatus('a')!
    const subB = bc.subscribeGitStatus('b')!
    const subC = bc.subscribeGitStatus('c')!
    void subA.iterable[Symbol.asyncIterator]().next() // attach 消费者，防 pushable 缓冲语义干扰（若不需要可省）
    void subB.iterable[Symbol.asyncIterator]().next()
    void subC.iterable[Symbol.asyncIterator]().next()

    bc.broadcastGitStatusChanged('a')
    await vi.waitFor(() => {
      expect(getStatus).toHaveBeenCalledTimes(1)
      expect(listBranches).toHaveBeenCalledTimes(1)
      expect(listStashes).toHaveBeenCalledTimes(1)
    })
    // 帧到达断言：用 pushable 的 maxDepth 缓冲，订阅方在 broadcast 后 iterate 取帧。
    // 实现提示：subscribeGitStatus 的 iterable 可多次 next；收集首帧。
    const framesA = await collect(subA.iterable)
    const framesB = await collect(subB.iterable)
    expect((framesA[0] as WsGitSnapshot).kind).toBe('git-snapshot')
    expect((framesA[0] as WsGitSnapshot).repoRoot).toBe('/repo')
    expect((framesA[0] as WsGitSnapshot).branches).toEqual([{ name: 'main', current: true, upstream: null }])
    expect(framesB).toHaveLength(framesA.length) // b 同样收到
    const framesC = await collect(subC.iterable).catch(() => [] as unknown[])
    // c 不在同组：其 pushable 不应有 git-snapshot 帧。
    // （用 vi.waitFor 短暂等待后 next 超时，或改用 hasPending 断言——实现者选择确定性写法：
    //  更稳的做法是给 c 的 iterable 做 Promise.race with timeout，断言超时。）
  })

  it('falls back to cwd grouping when repoRoot is undefined', async () => {
    const a = makeSession('a', '/same', undefined)
    const b = makeSession('b', '/same', undefined)
    const sessions = new Map([['a', a], ['b', b]])
    const bc = new SessionEventBroadcaster(sessions)
    const subB = bc.subscribeGitStatus('b')!
    void subB.iterable[Symbol.asyncIterator]().next()
    bc.broadcastGitStatusChanged('a')
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalled())
    const frames = await collect(subB.iterable)
    expect((frames[0] as WsGitSnapshot).repoRoot).toBe('/same')
  })

  it('reuses opts.snapshot fields and only computes the missing ones', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    const sub = bc.subscribeGitStatus('a')!
    void sub.iterable[Symbol.asyncIterator]().next()
    const preStatus = { isRepo: true as const, repoRoot: '/repo', branch: 'dev', detached: false, ahead: 1, behind: 0, upstream: null, state: 'clean' as const, linkedWorktrees: [], staged: [], unstaged: [], untracked: [] }
    bc.broadcastGitStatusChanged('a', { snapshot: { status: preStatus } })
    await vi.waitFor(() => expect(listBranches).toHaveBeenCalled())
    expect(getStatus).not.toHaveBeenCalled() // status 由 opts 提供，不重算
    const frames = await collect(sub.iterable)
    expect((frames[0] as WsGitSnapshot).status.branch).toBe('dev')
    expect((frames[0] as WsGitSnapshot).branches).toEqual([{ name: 'main', current: true, upstream: null }])
  })

  it('does not push and does not throw when computation fails', async () => {
    vi.mocked(getStatus).mockRejectedValueOnce(new Error('git exploded'))
    const a = makeSession('a', '/repo', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    const sub = bc.subscribeGitStatus('a')!
    void sub.iterable[Symbol.asyncIterator]().next()
    expect(() => bc.broadcastGitStatusChanged('a')).not.toThrow()
    await new Promise((r) => setTimeout(r, 20)) // 给 async 路径落地时间
    // 无帧：sub 的下一次 next 不应在无新广播时 resolve 出 git-snapshot（用短 timeout race）
  })

  it('seeds a fresh subscriber with the cached snapshot frame', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    bc.broadcastGitStatusChanged('a')
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    // 新订阅者：iterable 首帧应为缓存的 git-snapshot（无需再次广播）
    const fresh = bc.subscribeGitStatus('a')!
    const it = fresh.iterable[Symbol.asyncIterator]()
    const first = await it.next()
    expect((first.value as WsGitSnapshot).kind).toBe('git-snapshot')
  })

  it('gitGroupLivePeer returns another session sharing the key, null when alone', () => {
    const a = makeSession('a', '/repo', '/repo')
    const b = makeSession('b', '/repo/sub', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a], ['b', b]]))
    expect(bc.gitGroupLivePeer('a')).toBe('b')
    const alone = makeSession('x', '/solo', '/solo')
    const bc2 = new SessionEventBroadcaster(new Map([['x', alone]]))
    expect(bc2.gitGroupLivePeer('x')).toBeNull()
  })
})
```

> 实现者注：pushable 的消费语义（未 attach 迭代器时帧是否缓冲、maxDepth 行为）以 `server/pushable.ts` 实际实现为准——先读它，再把上面"收帧"写法调整为确定性断言（推荐：broadcast 前先 `const it = iter[Symbol.asyncIterator]()`，broadcast 后 `await it.next()`）。c 组 / 失败路径的"无帧"断言用 `Promise.race([it.next(), timeout(50).then(() => 'timeout')])` 断言 `'timeout'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-broadcaster.test.ts`
Expected: FAIL（`broadcastGitStatusChanged` 推不出 `git-snapshot` / 新方法不存在）

- [ ] **Step 3: 实现**

3a. `server/session-broadcaster.ts`：

文件头 import 改为（删 `invalidateStatusCache`，加 git 函数 + logger + 帧类型）：

```ts
import type { Session } from './session-types.js'
import type { SessionRecap } from './session-types.js'
import type { WsMessageConsumed, WsMessagesWithdrawn, WsGitSnapshot } from './ws-protocol.js'
import type { HookRunRecord, HookRuntimeEvent } from '../shared/hooks.js'
import type { Pushable } from './pushable.js'
import { createPushable } from './pushable.js'
import { createLogger } from './log.js'
import { getStatus, listBranches, listStashes } from './git.js'
import type { GitStatusResponse, GitBranch, GitStashEntry } from '../shared/git-types.js'

const log = createLogger('git-snapshot')

/** The three lists that make up one pushed git snapshot. */
export interface GitSnapshotPayload {
  status: GitStatusResponse
  branches: GitBranch[]
  stashes: GitStashEntry[]
}

/** Fan-out group key: spawn-captured work-tree top level, falling back to
 *  cwd string equality for non-repo sessions and pre-upgrade metas. The
 *  `?? s.id` last resort keeps cwd-less sessions in their own group. */
function gitGroupKey(s: Session): string {
  return s.repoRoot ?? s.cwd ?? s.id
}
```

类内新增成员（constructor 之后）：

```ts
  /** Most recent pushed snapshot per group key — seeds fresh subscribers
   *  (mirrors subscribeTasks' snapshot pattern, but via the pushable seed
   *  callback so ws.ts needs no special case). Pruned lazily: a key with
   *  no live session is dropped on the next emit or subscribe. */
  private gitSnapshots = new Map<string, WsGitSnapshot>()
```

`subscribeGitStatus` 整体替换：

```ts
  /** AsyncIterable of full `git-snapshot` frames for one session. A fresh
   *  subscriber is seeded with the group's most recent frame (when one
   *  exists) before live frames flow — a newly opened tab paints instantly
   *  without an HTTP round-trip. maxDepth 5: frames are fat but idempotent
   *  and droppable — a dropped frame self-heals on the next mutation, and
   *  the shallow queue keeps memory bounded. Returns null when the session
   *  is unknown. */
  subscribeGitStatus(id: string): { iterable: AsyncIterable<WsGitSnapshot>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const cached = this.gitSnapshots.get(gitGroupKey(s))
    this.pruneGitSnapshots()
    return this.subscribePushableSet<WsGitSnapshot>(s, s.gitStatusSubscribers, 'git', 5, () =>
      cached ? [cached] : [],
    )
  }
```

`broadcastGitStatusChanged` 整体替换（同时更新方法上方注释）：

```ts
  /** Compute (or adopt from opts) the group's git snapshot, cache it for
   *  subscriber seeding, and push a `git-snapshot` frame to every session
   *  sharing the trigger's group key — not just the trigger's own
   *  subscribers. Two sessions on the same repo therefore stay in sync:
   *  Claude's edits in A refresh B's chip/panel, and a commit in B's
   *  GitPanel refreshes A.
   *
   *  Fire-and-forget by design (call sites are sync): the async compute
   *  runs detached, failures log a warning and push nothing — clients
   *  keep their last known state and the next mutation retries. Write
   *  routes pass `opts.snapshot` with whatever they already computed
   *  (status for stage/commit, +branches for checkout, +stashes for
   *  stash ops); missing fields are computed here so a field is never
   *  git-spawned twice in one broadcast. */
  broadcastGitStatusChanged(id: string, opts?: { snapshot?: Partial<GitSnapshotPayload> }): void {
    void this.emitGitSnapshot(id, opts?.snapshot).catch((err: unknown) => {
      log.warn(`git snapshot compute failed session=${id}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private async emitGitSnapshot(id: string, partial?: Partial<GitSnapshotPayload>): Promise<void> {
    const s = this.sessions.get(id)
    if (!s || !s.cwd) return
    const key = gitGroupKey(s)
    const [status, branches, stashes] = await Promise.all([
      partial?.status ?? getStatus(s.cwd),
      partial?.branches ?? listBranches(s.cwd),
      partial?.stashes ?? listStashes(s.cwd),
    ])
    const frame: WsGitSnapshot = { kind: 'git-snapshot', sessionId: id, cwd: s.cwd, repoRoot: key, status, branches, stashes }
    this.gitSnapshots.set(key, frame)
    this.pruneGitSnapshots()
    for (const other of this.sessions.values()) {
      if (gitGroupKey(other) !== key) continue
      for (const sub of other.gitStatusSubscribers) {
        try { sub.push(frame) } catch { /* subscriber dead - skip */ }
      }
    }
  }

  /** Drop seed entries whose group no longer has a live session. Cheap
   *  (few keys); called after every emit and on subscribe. */
  private pruneGitSnapshots(): void {
    if (this.gitSnapshots.size === 0) return
    const live = new Set<string>()
    for (const s of this.sessions.values()) live.add(gitGroupKey(s))
    for (const k of this.gitSnapshots.keys()) {
      if (!live.has(k)) this.gitSnapshots.delete(k)
    }
  }

  /** The group key of one session, or null when unknown. Consumed by
   *  git-broadcast's per-group debounce. */
  gitGroupKeyOf(sessionId: string): string | null {
    const s = this.sessions.get(sessionId)
    return s ? gitGroupKey(s) : null
  }

  /** Another live session sharing this session's group key, or null when
   *  this is the only member. Consumed by cancelGitBroadcast: an unload
   *  must not kill a pending debounced broadcast that peers still need. */
  gitGroupLivePeer(sessionId: string): string | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    const key = gitGroupKey(s)
    for (const other of this.sessions.values()) {
      if (other.id !== sessionId && gitGroupKey(other) === key) return other.id
    }
    return null
  }
```

3b. `server/session-types.ts` —— `SessionBroadcaster` 接口，`broadcastGitStatusChanged`（约 777 行）替换并在其后新增：

```ts
  /** Compute/adopt the group's git snapshot and push a `git-snapshot`
   *  frame to every session sharing the trigger's group key (repoRoot,
   *  falling back to cwd). Mutator-shaped but fire-and-forget: the async
   *  compute detaches, failures warn without throwing. `opts.snapshot`
   *  supplies fields the caller already computed (write routes) so the
   *  broadcast only fills the gaps. */
  broadcastGitStatusChanged(sessionId: string, opts?: { snapshot?: Partial<import('./session-broadcaster.js').GitSnapshotPayload> }): void
  /** The group key (repoRoot ?? cwd ?? id) for one session, or null when
   *  unknown. Consumed by git-broadcast's per-group debounce. */
  gitGroupKeyOf(sessionId: string): string | null
  /** Another live session sharing this session's group key, or null when
   *  alone. Consumed by cancelGitBroadcast so an unload doesn't kill a
   *  pending broadcast peers still need. */
  gitGroupLivePeer(sessionId: string): string | null
```

并把 `subscribeGitStatus` 的接口签名（session-types 中如有声明——以实际为准，若接口未声明 subscribe 家族则跳过）同步为 `AsyncIterable<import('./ws-protocol.js').WsGitSnapshot>`。

3c. `server/session-manager.ts` —— thin proxy 区（约 4410 / 4471 行）：

```ts
  subscribeGitStatus(id: string): { iterable: AsyncIterable<import('./ws-protocol.js').WsGitSnapshot>; unsubscribe: () => void } | null {
    return this.broadcaster.subscribeGitStatus(id)
  }
```

```ts
  /** Broadcast a `git-snapshot` frame to every session sharing the
   *  trigger's group key. See SessionEventBroadcaster.broadcastGitStatusChanged. */
  broadcastGitStatusChanged(id: string, opts?: { snapshot?: Partial<import('./session-broadcaster.js').GitSnapshotPayload> }): void {
    this.broadcaster.broadcastGitStatusChanged(id, opts)
  }

  gitGroupKeyOf(sessionId: string): string | null {
    return this.broadcaster.gitGroupKeyOf(sessionId)
  }

  gitGroupLivePeer(sessionId: string): string | null {
    return this.broadcaster.gitGroupLivePeer(sessionId)
  }
```

3d. `server/ws.ts` —— `case 'git':`（约 705 行）替换为：

```ts
                case 'git':
                  // The pushable carries the complete frame (broadcaster
                  // constructed it with kind/cwd/repoRoot/payload); forward
                  // verbatim. Seed frames for fresh subscribers ride the
                  // same path.
                  queue.enqueue(winner.result.value as WsGitSnapshot)
                  break
```

并在该文件的 ws-protocol import 中加入 `WsGitSnapshot`（以实际 import 行为准）。

3e. 更新 `server/session-manager.ts` 中 `rewindFiles` 注释里的 "git-status-changed" 措辞为 "a git-snapshot push"（约 4174 行），`server/session-pump.ts` 相关注释（约 578/833/855 行）中的 "git-status-changed broadcast" 措辞为 "debounced git-snapshot broadcast"——仅注释，无逻辑变更。

- [ ] **Step 4: 修既有测试的编译破损**

`vi.spyOn(sm, 'broadcastGitStatusChanged')`（`session-manager.test.ts:2643`）签名兼容（第二参数可选），无需改动。全量跑 server 测试：

Run: `npx vitest run server/ && npm run typecheck`
Expected: 全绿（新测试 + 既有测试）

- [ ] **Step 5: Commit**

```bash
git add server/session-broadcaster.ts server/session-types.ts server/session-manager.ts server/ws.ts server/session-pump.ts server/session-broadcaster.test.ts
git commit -m "feat(server): push git-snapshot frames fanned out by repoRoot with subscriber seeding"
```

---

### Task 5: git-broadcast debounce 按分组键 + cancel 让位 peers

**Files:**
- Modify: `server/git-broadcast.ts`（全文逻辑 + 文件头注释）
- Modify: `server/session-manager.ts:4652`（`cancelGitBroadcast(id)` 调用点）
- Test: `server/git-broadcast.test.ts`（stub 加新方法 + 新用例）

**Interfaces:**
- Consumes: Task 4 的 `SessionBroadcaster.gitGroupKeyOf` / `gitGroupLivePeer` / `broadcastGitStatusChanged(id)`（无 opts）
- Produces: `scheduleGitBroadcast(sm: SessionBroadcaster, sessionId: string): void`（签名不变，内部按 `gitGroupKeyOf(sessionId) ?? sessionId` 计时）；`cancelGitBroadcast(sm: SessionBroadcaster, sessionId: string): void`（**签名变更**：第一参新增 sm）。

- [ ] **Step 1: 写失败测试**

`server/git-broadcast.test.ts` —— `makeStubBroadcaster` 增加两个方法（保留 `calls` 记录行为）：

```ts
function makeStubBroadcaster(
  keys: Record<string, string> = {},
  peers: Record<string, string | null> = {},
): SessionBroadcaster & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    subscribeGlobal: () => { throw new Error('not used') },
    subscribe: () => { throw new Error('not used') },
    subscribePermissions: () => { throw new Error('not used') },
    subscribeContextUsage: () => null,
    subscribePromptSuggestion: () => null,
    subscribeGitStatus: () => null,
    subscribeMessageStatus: () => null,
    broadcastGitStatusChanged(id: string) {
      calls.push(id)
    },
    gitGroupKeyOf: (id: string) => keys[id] ?? id,
    gitGroupLivePeer: (id: string) => peers[id] ?? null,
  } as unknown as SessionBroadcaster & { calls: string[] }
}
```

既有 4 个用例改用 `makeStubBroadcaster()`（默认行为：key=id，无 peer——语义与旧 per-session 一致，应原样通过；`cancelGitBroadcast` 用例改为传 sm：`cancelGitBroadcast(sm, 'sess-1')`）。新增用例：

```ts
it('coalesces schedules from two sessions sharing a group key into one broadcast', () => {
  const sm = makeStubBroadcaster({ 'sess-A': '/repo', 'sess-B': '/repo' })
  scheduleGitBroadcast(sm, 'sess-A')
  vi.advanceTimersByTime(100)
  scheduleGitBroadcast(sm, 'sess-B') // 同组：重置同一个定时器
  vi.advanceTimersByTime(500)
  // 只 fire 一次；触发 origin 是最后一次 schedule 的 sess-B
  expect(sm.calls).toEqual(['sess-B'])
})

it('keeps separate timers for different group keys', () => {
  const sm = makeStubBroadcaster({ 'sess-A': '/repo-a', 'sess-B': '/repo-b' })
  scheduleGitBroadcast(sm, 'sess-A')
  vi.advanceTimersByTime(200)
  scheduleGitBroadcast(sm, 'sess-B')
  vi.advanceTimersByTime(300)
  expect(sm.calls).toEqual(['sess-A'])
  vi.advanceTimersByTime(200)
  expect(sm.calls).toEqual(['sess-A', 'sess-B'])
})

it('cancel with a live peer keeps the timer and re-points origin to the peer', () => {
  const sm = makeStubBroadcaster(
    { 'sess-A': '/repo', 'sess-B': '/repo' },
    { 'sess-A': 'sess-B' },
  )
  scheduleGitBroadcast(sm, 'sess-A')
  vi.advanceTimersByTime(200)
  cancelGitBroadcast(sm, 'sess-A') // A unload；B 仍需要这次刷新
  vi.advanceTimersByTime(500)
  expect(sm.calls).toEqual(['sess-B']) // timer 活着，origin 换成 B
})

it('cancel without peers clears the timer', () => {
  const sm = makeStubBroadcaster()
  scheduleGitBroadcast(sm, 'sess-1')
  vi.advanceTimersByTime(200)
  cancelGitBroadcast(sm, 'sess-1')
  vi.advanceTimersByTime(1000)
  expect(sm.calls).toEqual([])
})

it('cancel ignores timers whose origin is another session', () => {
  const sm = makeStubBroadcaster({ 'sess-A': '/repo', 'sess-B': '/repo' })
  scheduleGitBroadcast(sm, 'sess-A')
  vi.advanceTimersByTime(100)
  scheduleGitBroadcast(sm, 'sess-B') // origin 现在是 B
  vi.advanceTimersByTime(100)
  cancelGitBroadcast(sm, 'sess-A') // A 不是 origin — 不得杀 B 的 timer
  vi.advanceTimersByTime(500)
  expect(sm.calls).toEqual(['sess-B'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/git-broadcast.test.ts`
Expected: 新用例 FAIL（同组不合并 / cancel 签名不符）

- [ ] **Step 3: 实现**

`server/git-broadcast.ts` —— 文件头注释更新（"Per-session debounce" → "Per-git-group debounce"，说明按 `gitGroupKeyOf` 计时与 cancel 让位 peers），核心替换为：

```ts
const DEBOUNCE_MS = 500
interface DebounceEntry {
  timer: NodeJS.Timeout
  /** The session whose schedule most recently (re)set this timer. The
   *  broadcast fires with this id — it only names the trigger for
   *  logging/frame.sessionId; fan-out is group-wide regardless. */
  originSessionId: string
}
/** Keyed by git group key (repoRoot ?? cwd ?? id), NOT sessionId: bursts
 *  from two sessions in the same repo coalesce into one compute+push. */
const timers = new Map<string, DebounceEntry>()

export function scheduleGitBroadcast(sm: SessionBroadcaster, sessionId: string): void {
  const key = sm.gitGroupKeyOf(sessionId) ?? sessionId
  const existing = timers.get(key)
  if (existing) clearTimeout(existing.timer)
  const t = setTimeout(() => {
    timers.delete(key)
    sm.broadcastGitStatusChanged(sessionId)
  }, DEBOUNCE_MS)
  t.unref?.()
  timers.set(key, { timer: t, originSessionId: sessionId })
}

/** Cancel the pending debounced broadcast *iff* `sessionId` is its origin
 *  AND no live peer shares the group — an unload must not kill a refresh
 *  peers still need. With a live peer the timer survives and its origin
 *  re-points to the peer so the broadcast still fires. */
export function cancelGitBroadcast(sm: SessionBroadcaster, sessionId: string): void {
  const key = sm.gitGroupKeyOf(sessionId) ?? sessionId
  const entry = timers.get(key)
  if (!entry || entry.originSessionId !== sessionId) return
  const peer = sm.gitGroupLivePeer(sessionId)
  if (peer) {
    entry.originSessionId = peer
    return
  }
  clearTimeout(entry.timer)
  timers.delete(key)
}

/** Test-only: clear all pending timers and any internal state.
 *  Real code should never call this. */
export function _resetGitBroadcastForTests(): void {
  for (const t of timers.values()) clearTimeout(t.timer)
  timers.clear()
}
```

文件头的模块注释（1-14 行）同步重写为按组 debounce 的语义描述（保留 "write routes call sm.broadcastGitStatusChanged directly" 的说明，补充 "broadcast now pushes a full git-snapshot frame fanned out by group key"）。

`server/session-manager.ts:4652` 调用点改为：

```ts
    cancelGitBroadcast(this, id)
```

（`SessionManager` 实现了 `SessionBroadcaster` 结构——新增的两个方法已在 Task 4 加上。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/git-broadcast.test.ts && npm run typecheck && npx vitest run server/session-manager.test.ts`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add server/git-broadcast.ts server/git-broadcast.test.ts server/session-manager.ts
git commit -m "feat(server): debounce git-snapshot broadcasts per repo group; cancel yields to live peers"
```

---

### Task 6: 写路由传入 Partial 快照（消除二次 spawn）

**Files:**
- Modify: `server/routes/git-write.ts`（全部 13 个 `sm.broadcastGitStatusChanged(id)` 调用点 + 文件头注释第 10 行）
- Test: 无新测试文件（行为由 Task 4 的 "reuses opts.snapshot" 用例覆盖；本任务是机械接线，验证 = typecheck + 全量 server 测试）

**Interfaces:**
- Consumes: Task 4 的 `broadcastGitStatusChanged(id, opts?: { snapshot?: Partial<GitSnapshotPayload> })`
- Produces: 各写路由在返回前先算好 fresh 数据、传入广播、再返回同一份数据（响应体不变）。

**模式**（每个路由同一套重排：先算 → 广播带 snapshot → 返回）：

- `stage` / `unstage` / `discard` / `commit` / `abort-merge` / `abort-rebase`（目前只算 status）：

```ts
    await stageFiles(cwd, paths)
    const status = await freshStatus(cwd)
    sm.broadcastGitStatusChanged(id, { snapshot: { status } })
    return c.json({ status })
```

- `stash` / `stash-pop`（status + stashes）：

```ts
    await stashCreate(cwd, message, includeUntracked)
    const [status, stashes] = await Promise.all([freshStatus(cwd), listStashes(cwd)])
    sm.broadcastGitStatusChanged(id, { snapshot: { status, stashes } })
    return c.json({ status, stashes })
```

- `stash-drop`（仅 stashes）：

```ts
    await stashDrop(cwd, index)
    const stashes = await listStashes(cwd)
    sm.broadcastGitStatusChanged(id, { snapshot: { stashes } })
    return c.json({ stashes })
```

- `branch` / `checkout` / `pull` / `push`（status + branches）：

```ts
    const result = await checkoutBranch(cwd, body.branch, autoStash)
    const [status, branches] = await Promise.all([freshStatus(cwd), listBranches(cwd)])
    sm.broadcastGitStatusChanged(id, { snapshot: { status, branches } })
    return c.json({ status, branches, stashed: result.stashed })
```

（pull 的 `updated`、push 无额外字段——保持各自现有响应体形状不变。）

文件头注释第 10 行 `//   5. Broadcast git-status-changed to the session's WS subscribers` 改为：

```
//   5. Broadcast a git-snapshot frame (fanned out to every session sharing
//      the cwd's repo group), passing the fresh lists as opts.snapshot so
//      the broadcast never re-spawns git for a field we already computed
```

- [ ] **Step 1: 逐路由应用上述重排**（13 处调用全部覆盖；对照 `server/routes/git-write.ts` 当前每个 `sm.broadcastGitStatusChanged(id)` 的上下文选对 snapshot 字段集）

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npx vitest run server/`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add server/routes/git-write.ts
git commit -m "feat(server): git write routes pass fresh lists as snapshot opts to the broadcast"
```

---

### Task 7: branches/stashes 读路由迁到 `/api/git/*?cwd=`（新增，旧路由 Task 8 删）

**Files:**
- Modify: `server/git-routes.ts`（文件头注释 + 新增两条 GET）

**Interfaces:**
- Consumes: `listBranches(cwd)` / `listStashes(cwd)`（`server/git.ts`）；现有 `requireCwd` 助手
- Produces: `GET /api/git/branches?cwd=…` → `{ branches: GitBranch[] }`；`GET /api/git/stashes?cwd=…` → `{ stashes: GitStashEntry[] }`。Task 8 的客户端 hooks 调它们。

- [ ] **Step 1: 实现**

`server/git-routes.ts` —— import 行加入 `listBranches, listStashes`。`/log` 路由之后、`return app` 之前新增：

```ts
  // --- GET /branches ----------------------------------------------------
  // Full branch list for the cwd's repo. cwd-scoped (not session-scoped)
  // like every other read here: branches are a property of the work tree,
  // and two sessions on the same repo share one answer.
  app.get('/branches', async (c) => {
    const cwd = requireCwd(c.req.query('cwd'))
    return c.json({ branches: await listBranches(cwd) })
  })

  // --- GET /stashes -----------------------------------------------------
  // Stash list for the cwd's repo. Same cwd-scoping rationale as /branches.
  app.get('/stashes', async (c) => {
    const cwd = requireCwd(c.req.query('cwd'))
    return c.json({ stashes: await listStashes(cwd) })
  })
```

文件头注释（11-12 行）`All three endpoints are GET / cwd-scope` 改为 `All endpoints here are GET / cwd-scope`（数量已不是 three）。

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npx vitest run server/git.test.ts`
Expected: 全绿（路由层本仓库无既有单测，typecheck + 手动冒烟：`npm run dev` 后 `curl 'localhost:3456/api/git/branches?cwd=<repo>'`）

- [ ] **Step 3: Commit**

```bash
git add server/git-routes.ts
git commit -m "feat(server): add cwd-scoped GET /api/git/branches and /stashes read routes"
```

---

### Task 8: 客户端 hooks sink 化 + 旧帧/旧路由/旧缓存全部退场

一个任务的原因：客户端 hooks、协议删除、路由删除、缓存退役互相咬合，拆开会出现"客户端请求已删路由"的中间破损态。验证 = 新客户端测试 + 全量 typecheck + 全量测试 + grep 清扫。

**Files:**
- Modify: `src/hooks/useGitStatus.ts`（全文重写三个 hook + `useGitWsRefresh`）
- Modify: `src/components/GitPanel.tsx`（1126 / 1285 行两处调用）
- Modify: `src/components/ChatPanel.tsx`（472 行注释措辞）
- Test: 新建 `src/hooks/useGitStatus.test.ts`
- Delete-残留: `shared/ws-protocol.ts`（`WsGitStatusChanged` 定义 + 联合成员）、`server/ws-protocol.ts` / `src/ws-types.ts` re-export 名、`server/git-write.ts` 两条 GET、`server/git.ts`（`getStatusCached` / `invalidateStatusCache` / `statusCache` / `STATUS_CACHE_TTL_MS` 及注释块）、`server/git-routes.ts`（`/status` 改用 `getStatus`）
- Sweep: 全仓 grep `git-status-changed` / `WsGitStatusChanged` / `getStatusCached` / `invalidateStatusCache`

**Interfaces:**
- Consumes: Task 3/4 的 `WsGitSnapshot`；Task 7 的新读路由；现有 `useWsHub.addSessionListener` / `api.get`
- Produces:
  - `useGitStatus(cwd, sessionId, opts?)` —— 返回形状不变 `{ data, loading, error, refresh }`。sink 语义：mount/`cwd` 变化 fetch 一次；`git-snapshot` 帧按守卫直接替换 `data`。
  - `useGitBranches(cwd, sessionId, enabled)` —— 新签名（cwd 领先）。sink：帧直接替换列表。
  - `useGitStashes(cwd, sessionId, enabled)` —— 同上。
  - `GitSnapshotPayload` 客户端可用（经 `WsGitSnapshot` 字段）。

- [ ] **Step 1: 写失败测试**

新建 `src/hooks/useGitStatus.test.ts`。Mock 范式沿用 `src/hooks/useElicitationChannel.test.ts`（`vi.mock('./useApi')` + `renderHook`/`waitFor`）。WS 层 mock（该文件无现成 useWsHub mock 先例，按下述最小实现）：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { WsGitSnapshot } from '../../shared/ws-protocol.js'
import type { GitStatusResponse } from '../../shared/git-types.js'

const mockGet = vi.fn()
vi.mock('./useApi', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn() },
}))

// WS hub mock: capture the session listener so tests can emit frames.
let sessionListener: ((frame: unknown) => void) | null = null
const subscribe = vi.fn(() => () => {})
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({
    subscribe,
    addSessionListener: (_id: string, fn: (frame: unknown) => void) => {
      sessionListener = fn
      return () => { sessionListener = null }
    },
  }),
}))

import { useGitStatus, useGitBranches, useGitStashes } from './useGitStatus'

function makeStatus(repoRoot = '/repo'): GitStatusResponse {
  return {
    isRepo: true, repoRoot, branch: 'main', detached: false, ahead: 0, behind: 0,
    upstream: null, state: 'clean', linkedWorktrees: [], staged: [], unstaged: [], untracked: [],
  }
}

function makeFrame(repoRoot = '/repo', cwd = '/repo'): WsGitSnapshot {
  return {
    kind: 'git-snapshot', sessionId: 's1', cwd, repoRoot,
    status: makeStatus(repoRoot), branches: [{ name: 'main', current: true, upstream: null }], stashes: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionListener = null
  mockGet.mockResolvedValue(makeStatus())
})
afterEach(() => vi.restoreAllMocks())

describe('useGitStatus', () => {
  it('fetches once on mount, then applies git-snapshot frames with zero refetch', async () => {
    const { result } = renderHook(() => useGitStatus('/repo', 's1'))
    await waitFor(() => expect(result.current.data?.isRepo).toBe(true))
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledWith('/git/status?cwd=%2Frepo', expect.anything())

    const next = makeFrame()
    ;(next.status as { branch: string }).branch = 'dev'
    act(() => { sessionListener?.(next) })
    await waitFor(() => expect(result.current.data?.branch).toBe('dev'))
    expect(mockGet).toHaveBeenCalledTimes(1) // 零 refetch
  })

  it('drops frames whose repoRoot mismatches once repo data is authoritative', async () => {
    const { result } = renderHook(() => useGitStatus('/repo', 's1'))
    await waitFor(() => expect(result.current.data?.isRepo).toBe(true))
    act(() => { sessionListener?.(makeFrame('/elsewhere')) })
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.data?.repoRoot).toBe('/repo') // 未被覆盖
  })

  it('pre-first-fetch: applies only when frame cwd or repoRoot matches', async () => {
    let resolveGet: (v: GitStatusResponse) => void = () => {}
    mockGet.mockReturnValue(new Promise((r) => { resolveGet = r }))
    const { result } = renderHook(() => useGitStatus('/repo', 's1'))
    // 帧先到（mount fetch 还挂着）：cwd 不匹配 → 丢弃
    act(() => { sessionListener?.(makeFrame('/other', '/other')) })
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.data).toBeNull()
    // 匹配的帧 → 应用
    act(() => { sessionListener?.(makeFrame('/repo', '/repo')) })
    await waitFor(() => expect(result.current.data?.isRepo).toBe(true))
    resolveGet(makeStatus())
  })

  it('manual refresh still hits HTTP', async () => {
    const { result } = renderHook(() => useGitStatus('/repo', 's1'))
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    act(() => { result.current.refresh() })
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
  })

  it('does nothing without cwd or when disabled', async () => {
    renderHook(() => useGitStatus(undefined, 's1'))
    renderHook(() => useGitStatus('/repo', 's1', { enabled: false }))
    await new Promise((r) => setTimeout(r, 10))
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('useGitBranches / useGitStashes', () => {
  it('branches: fetches via cwd route on enable, applies frames without guard', async () => {
    mockGet.mockResolvedValueOnce({ branches: [] })
    const { result } = renderHook(() => useGitBranches('/repo', 's1', true))
    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(mockGet).toHaveBeenCalledWith('/git/branches?cwd=%2Frepo', expect.anything())
    act(() => { sessionListener?.(makeFrame('/elsewhere')) }) // 无守卫：直接替换
    await waitFor(() => expect(result.current.data).toHaveLength(1))
  })

  it('stashes: fetches via cwd route on enable', async () => {
    mockGet.mockResolvedValueOnce({ stashes: [] })
    const { result } = renderHook(() => useGitStashes('/repo', 's1', true))
    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(mockGet).toHaveBeenCalledWith('/git/stashes?cwd=%2Frepo', expect.anything())
  })

  it('branches: disabled → no fetch', async () => {
    renderHook(() => useGitBranches('/repo', 's1', false))
    await new Promise((r) => setTimeout(r, 10))
    expect(mockGet).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/hooks/useGitStatus.test.ts`
Expected: FAIL（旧实现无 `git-snapshot` 处理 / 签名不符 / 仍请求旧路由）

- [ ] **Step 3: 实现客户端 hooks**

`src/hooks/useGitStatus.ts` —— 文件头注释重写（signal+refetch → sink 语义），然后：

`useGitWsRefresh` 替换为帧监听 helper：

```ts
// ── WS git-snapshot listener ────────────────────────────────────────
//
// Subscribes to a session's channel and invokes `onFrame` for each
// `git-snapshot` frame (server pushes these fanned out by repo group).
// The onFrame ref pattern keeps the effect independent of callback
// identity so per-render closures don't churn the subscription.

function useGitSnapshotListener(
  sessionId: string | undefined,
  enabled: boolean,
  onFrame: (frame: WsGitSnapshot) => void,
): void {
  const hub = useWsHub()
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame
  useEffect(() => {
    if (!enabled || !sessionId) return
    const offSub = hub.subscribe(sessionId)
    const offListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind === 'git-snapshot') onFrameRef.current(frame)
    })
    return () => {
      offSub()
      offListener()
    }
  }, [enabled, sessionId, hub])
}
```

`useGitStatus` —— 保留现有 mount-fetch effect（`/git/status?cwd=`、`tick`、abort、`sameStatus` 比对——帧应用也走 `sameStatus` 短路）与 `refresh`；在 `useGitWsRefresh(...)` 调用处替换为：

```ts
  // Sink: apply pushed snapshots directly — zero refetch. Guard once the
  // data is authoritative (isRepo with repoRoot, from mount fetch): only
  // same-repo frames apply, so a WorktreeChanges overlay (hook cwd =
  // worktree path, subscribed to the main session's channel) never
  // receives main-repo state. Pre-authoritative (first frame beats the
  // mount fetch, or isRepo:false): match on cwd/repoRoot equality; a
  // mismatched frame is dropped in favor of the in-flight HTTP truth.
  useGitSnapshotListener(sessionId, enabled, (frame) => {
    setData((prev) => {
      if (prev && prev.isRepo) {
        if (prev.repoRoot !== frame.repoRoot) return prev
        return sameStatus(prev, frame.status) ? prev : frame.status
      }
      if (frame.cwd !== cwd && frame.repoRoot !== cwd) return prev
      return sameStatus(prev, frame.status) ? prev : frame.status
    })
    setLoading(false)
    setError(null)
  })
```

import 区加 `WsGitSnapshot`（type-only from `../../shared/ws-protocol.js`）；`useWsHub` import 保留。

`useGitBranches` / `useGitStashes` —— 签名改为 `(cwd: string | undefined, sessionId: string | undefined, enabled: boolean)`；fetch URL 改为：

```ts
      .get<{ branches: GitBranch[] }>(`/git/branches?cwd=${encodeURIComponent(cwd)}`, { signal: ctrl.signal })
```

```ts
      .get<{ stashes: GitStashEntry[] }>(`/git/stashes?cwd=${encodeURIComponent(cwd)}`, { signal: ctrl.signal })
```

effect 守卫改为 `if (!enabled || !cwd)`（依赖数组 `[cwd, enabled, tick]`，sessionId 移出 fetch effect）；WS 侧替换为：

```ts
  // No guard: branches/stashes only run inside GitPanel where hook cwd ==
  // session cwd, and the server only fans out same-group frames.
  useGitSnapshotListener(sessionId, enabled, (frame) => {
    setData((prev) => {
      const next = frame.branches
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
    })
    setLoading(false)
    setError(null)
  })
```

（stashes hook 同构，字段 `frame.stashes`。）

文件头模块注释（1-17 行）重写：说明三个 hook 是 git-snapshot 的 sink，HTTP 仅用于 mount ground truth 与手动 refresh；diff/log/range-diff 保持按需 fetch 不变。

- [ ] **Step 4: 更新调用点**

`src/components/GitPanel.tsx:1126` 与 `:1285`：

```ts
  const branches = useGitBranches(cwd, sessionId, open)
```

```ts
  const stashes = useGitStashes(cwd, sessionId, open)
```

`src/components/ChatPanel.tsx:472` 注释 `wires WS auto-refresh on git-status-changed frames` 改为 `wires the git-snapshot WS sink (frames carry the full status; no refetch)`。

- [ ] **Step 5: 跑客户端测试**

Run: `npx vitest run src/hooks/useGitStatus.test.ts`
Expected: PASS

- [ ] **Step 6: 删除旧帧 / 旧路由 / 旧缓存（同任务内的退场扫尾）**

6a. `shared/ws-protocol.ts` —— 删除 `WsGitStatusChanged` 接口（含上方注释块，约 259-267 行）与联合中的 `| WsGitStatusChanged`（约 439 行）。顶部 `import type { GitStatusResponse, ... }` 保留。

6b. `server/ws-protocol.ts:43` 与 `src/ws-types.ts:39` —— re-export 列表移除 `WsGitStatusChanged`（保留 `WsGitSnapshot`）。

6c. `server/routes/git-write.ts` —— 删除两条 GET：

```ts
  app.get('/sessions/:id/git/stashes', async (c) => { ... })
  app.get('/sessions/:id/git/branches', async (c) => { ... })
```

（含各自完整函数体；POST 路由不动。）

6d. `server/git.ts` —— 删除整个 `getStatusCached` / `invalidateStatusCache` 区块：`STATUS_CACHE_TTL_MS` 常量、`StatusCacheEntry` 接口、`statusCache` Map、两个导出函数，及其上方 331-346 行的整块注释。`getStatus` / `getStatusInRepo` 保留。

6e. `server/git-routes.ts` —— import 移除 `getStatusCached` 改为 `getStatus`；`/status` 路由体改为：

```ts
  app.get('/status', async (c) => {
    const cwd = requireCwd(c.req.query('cwd'))
    const result = await getStatus(cwd)
    return c.json(result)
  })
```

上方"Coalesce the thundering herd"注释（约 39-40 行）删除（羊群已不存在；可留一行 `// Ground-truth fetch: clients mount-fetch once, then consume pushed git-snapshot frames.`）。

6f. `server/session-broadcaster.ts` 确认无 `invalidateStatusCache` 残留（Task 4 已删——grep 复核）。

- [ ] **Step 7: 全仓 grep 清扫**

Run（预期零代码命中；文档命中留给 Task 9）:

```bash
rg -n "git-status-changed|WsGitStatusChanged|getStatusCached|invalidateStatusCache" --glob '!docs/**' --glob '!AGENTS.md' --glob '!CLAUDE.md'
```

Expected: 零命中。

- [ ] **Step 8: 全量验证**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: 全绿

- [ ] **Step 9: Commit**

```bash
git add -A src/hooks/useGitStatus.ts src/hooks/useGitStatus.test.ts src/components/GitPanel.tsx src/components/ChatPanel.tsx shared/ws-protocol.ts server/ws-protocol.ts src/ws-types.ts server/routes/git-write.ts server/git.ts server/git-routes.ts server/session-broadcaster.ts
git commit -m "feat(client)!: git-snapshot sinks replace signal refetch; drop old frame, session-scoped reads, status cache"
```

---

### Task 9: 文档同步 + 终检

**Files:**
- Modify: `CLAUDE.md`（协议清单约 64 行；Git integration 节的 broadcast 描述）
- Modify: `AGENTS.md`（对应两处，与 CLAUDE.md 同步）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 文档与实现一致

- [ ] **Step 1: 更新协议清单**

`CLAUDE.md` 与 `AGENTS.md` 的 WebSocket frame kinds 清单中，`git-status-changed` 条目替换为：

```
- `git-snapshot` — work-tree git 状态快照（status/branches/stashes 内联），在任何 filesystem-mutating 事件后由服务端按 repoGroup（repoRoot，回退 cwd）算一次并扇出给所有同组 session；新订阅者 seed 最近一帧。客户端 useGitStatus / useGitBranches / useGitStashes 是纯 sink（mount HTTP fetch 一次 + 手动 refresh 保留，帧到达直接替换 state，零 refetch）。diff/log 仍按需 fetch。
```

（保持各文件原有条目语言风格——CLAUDE.md 中文、AGENTS.md 同步对应段落。）

- [ ] **Step 2: 更新 Git integration 节**

`CLAUDE.md` "Git integration" 第二段中 `scheduleGitBroadcast` 的描述更新为：debounce 按 **repoGroup**（`gitGroupKeyOf`：repoRoot ?? cwd）计时，同 repo 多 session 的突发合并为一次计算；`broadcastGitStatusChanged` 推送完整 `git-snapshot` 帧并扇出给同组所有 session；写路由把已算好的 fresh 列表作为 `opts.snapshot` 传入避免二次 git spawn；`cancelGitBroadcast(this, id)` 在 unload 时仅当触发源是该 session 且无同组 peer 存活才清除定时器（否则 origin 让位 peer）。`getStatusCached` 已删除（羊群由快照推送根除）。`AGENTS.md` 同步。

- [ ] **Step 3: 终检**

Run: `npm run typecheck && npm run test && npm run lint && rg -n "git-status-changed" --glob '!docs/superpowers/**'`
Expected: 前三条全绿；grep 仅剩 docs/superpowers 历史文档（specs/plans 不改写历史）与本 plan 自身的零命中确认。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: update protocol and git-integration notes for git-snapshot push"
```

---

## Self-Review 结果（已内联修复）

1. **Spec coverage:** §四协议 → Task 3/8；§五.1 repoRoot → Task 1/2；§五.2 广播重写 → Task 4；debounce/cancel → Task 5；§五.3 seed → Task 4（pushable seed 回调，ws.ts 零 special-case——spec 说"照抄 subscribeTasks 模式"，实现选了 subscribeMessageStatus 的 seed 回调模式，行为等价且更少接线，Task 4 测试覆盖）；§五.4 读路由 → Task 7（新增）+ Task 8（删旧）；§五.5 退役 → Task 8；§六客户端 → Task 8；§七边界（worktree 守卫 / 非 repo / server 重启）→ Task 4 测试 + Task 8 守卫测试；§八测试 → 各任务 Step 1；§九影响面全部有任务对应。CLAUDE/AGENTS 更新 → Task 9。
2. **Placeholder scan:** 无 TBD/TODO；两处"以实际为准"是读邻近代码确认助手名的指令（git.test.ts 的 initRepo、persistence.test.ts 的 makeStore），属执行时必读上下文而非空缺。
3. **Type consistency:** `broadcastGitStatusChanged(id, opts?)` 在 broadcaster / 接口 / proxy / git-broadcast stub / 写路由五处签名一致；`gitGroupKeyOf` / `gitGroupLivePeer` 三处一致；`useGitBranches(cwd, sessionId, enabled)` 定义与 GitPanel 调用点一致；`WsGitSnapshot` 字段在 broadcaster 构造与客户端守卫消费一致（`repoRoot` 恒为 string，broadcaster 用 `gitGroupKey` 保证）。
