# Session Worktree 隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 session 可勾选"隔离到独立 git worktree":session 的 cwd 即 per-session worktree,agent 文件操作不影响主仓;删除 session 清 worktree 留分支;resume 自动重建 worktree。

**Architecture:** 方案 A"创建即替换"——worktree 路径直接作为 `SessionMeta.cwd`,另加 `worktree` 元数据 `{ mainRepoPath, branch, baseSha }` 做生命周期管理。所有 cwd 消费者(SDK、git 路由、shadow 快照、GitPanel)零改动。新模块 `server/session-worktree.ts` 承载创建/重建/清理与进程内 per-common-dir mutex;`server/git.ts` 新增 worktree 原语。

**Tech Stack:** TypeScript / Node 22 / vitest(服务端测试,Node 环境)/ Hono 路由 / React 19。

**Spec:** `docs/superpowers/specs/2026-10-14-session-worktree-isolation-design.md`(先读 spec 再动工)

## Global Constraints

- 所有 git 调用必须走 `server/git.ts` 的 `runGit()`(execFile 固定 argv,绝不 shell 拼接)——CLAUDE.md 硬规则。
- 服务端诊断日志一律 `createLogger(scope)`,禁止裸 `console.*`。
- 测试环境:服务端测试跑在 Node;DOM-free 测试文件首行加 `// @vitest-environment node`。默认测试不得解析/执行真实 agent CLI(本计划不涉及,只碰真 git 二进制)。
- CSS 一律主题变量(`var(--…)`,禁止 hex);新增颜色在 `:root` 与 `[data-theme="light"]` 双块定义。
- 不要加规格之外的防御性代码;失败要抛 `HttpError` 而非静默兜底(本计划唯一的 try/catch 吞异常点是 spec 明确的"删除 worktree best-effort")。
- 每个任务收尾跑 `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.node.json --noEmit`(两个 tsconfig 都要过)。
- 全部任务完成后、commit 前,对全量 diff 跑 `code-review` 技能(CLAUDE.md 流程要求)。

---

### Task 1: git.ts worktree 原语 + linkedWorktrees 探测修复

**Files:**
- Modify: `server/git.ts`(在 `tryCaptureRepoRoot` 附近新增原语;`getStatusInRepo` 内 ~492-495 行的 `hasLinkedWorktrees` 探测)
- Test: `server/git.worktree.test.ts`(新建)

**Interfaces:**
- Produces(后续任务依赖,签名固定):
  - `getGitCommonDir(cwd: string): Promise<string>` — 绝对路径
  - `branchExists(cwd: string, branch: string): Promise<boolean>`
  - `commitExists(cwd: string, sha: string): Promise<boolean>`
  - `createWorktree(mainRepoCwd: string, worktreePath: string, branch: string, baseRef: string, newBranch: boolean): Promise<void>`
  - `removeWorktreeDir(mainRepoCwd: string, worktreePath: string): Promise<void>`
  - `worktreeIsDirty(cwd: string): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

`server/git.worktree.test.ts` 首行 `// @vitest-environment node`。用 `node:fs/promises` + `node:os` 建临时目录,`runGit` 同款方式直接 `execFile('git', …)` 建仓(测试内 init 主仓是 fixture 准备,不是被测对象;为减少重复写一个 `initRepoWithCommit(dir)` helper:git init → commit 一个文件。参考 `server/snapshot/shadow-git.test.ts` 已有的临时 git 仓 fixture 风格——先读它,复用其 helper 若存在):

```ts
// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { branchExists, commitExists, createWorktree, getGitCommonDir, listWorktrees, removeWorktreeDir, worktreeIsDirty } from './git.js'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
const execFile = promisify(execFileCb)

let dirs: string[] = []
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crw-wt-'))
  dirs.push(dir)
  await execFile('git', ['-C', dir, 'init', '-b', 'main'])
  await execFile('git', ['-C', dir, 'config', 'user.email', 't@t'], { cwd: dir })
  await execFile('git', ['-C', dir, 'config', 'user.name', 't'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'hello\n')
  await execFile('git', ['-C', dir, 'add', '.'], { cwd: dir })
  await execFile('git', ['-C', dir, 'commit', '-m', 'init'], { cwd: dir })
  return dir
}
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

describe('worktree primitives', () => {
  it('creates a linked worktree on a new branch and reports it', async () => {
    const repo = await makeRepo()
    const wt = join(repo, '..', 'wt-a') // 放在主仓外,避免嵌套仓库
    await createWorktree(repo, wt, 'crw/test1', 'HEAD', true)
    expect(await branchExists(repo, 'crw/test1')).toBe(true)
    const listed = await listWorktrees(repo)
    expect(listed.some((w) => w.path === wt)).toBe(true)
  })

  it('recreates a worktree on an existing branch (newBranch=false)', async () => {
    const repo = await makeRepo()
    const wt = join(repo, '..', 'wt-b')
    await createWorktree(repo, wt, 'crw/test2', 'HEAD', true)
    await removeWorktreeDir(repo, wt)
    expect(await branchExists(repo, 'crw/test2')).toBe(true) // 分支保留
    await createWorktree(repo, wt, 'crw/test2', '', false)   // baseRef 未用,走分支名
    expect(await branchExists(repo, 'crw/test2')).toBe(true)
  })

  it('worktreeIsDirty reflects uncommitted changes', async () => {
    const repo = await makeRepo()
    const wt = join(repo, '..', 'wt-c')
    await createWorktree(repo, wt, 'crw/test3', 'HEAD', true)
    expect(await worktreeIsDirty(wt)).toBe(false)
    await writeFile(join(wt, 'b.txt'), 'x\n')
    expect(await worktreeIsDirty(wt)).toBe(true)
  })

  it('getGitCommonDir resolves to the shared object store', async () => {
    const repo = await makeRepo()
    const wt = join(repo, '..', 'wt-d')
    await createWorktree(repo, wt, 'crw/test4', 'HEAD', true)
    const common = await getGitCommonDir(wt)
    const repoCommon = await getGitCommonDir(repo)
    expect(common).toBe(repoCommon)
  })

  it('commitExists verifies sha and rejects junk', async () => {
    const repo = await makeRepo()
    const head = (await execFile('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()
    expect(await commitExists(repo, head)).toBe(true)
    expect(await commitExists(repo, '0'.repeat(40))).toBe(false)
  })

  it('listWorktrees sees worktrees when queried FROM a linked worktree cwd (regression)', async () => {
    const repo = await makeRepo()
    const wt = join(repo, '..', 'wt-e')
    await createWorktree(repo, wt, 'crw/test5', 'HEAD', true)
    // 修复前:从 worktree cwd 探测 <toplevel>/.git/worktrees(.git 是文件)恒为空
    const listed = await listWorktrees(wt)
    expect(listed.length).toBeGreaterThanOrEqual(1)
  })
})
```

注:`listWorktrees` 的返回元素字段名以 `GitLinkedWorktree` 类型为准(`server/git.ts` 内已定义),断言按实际字段调整;`newBranch=false` 时 `baseRef` 参数不进 argv,传 `''` 即可(实现里判断)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/git.worktree.test.ts`
Expected: FAIL,导入的原语不存在(`SyntaxError` 或 `undefined is not a function`)。

- [ ] **Step 3: 实现 git.ts 原语**

在 `server/git.ts` 新增(位置放在 `listWorktrees` 之后的 worktree 区域;`join`/`isAbsolute` 若未导入则从 `node:path` 补):

```ts
/** Absolute path of the shared git dir (common dir) for the repo that `cwd`
 *  lives in — for a linked worktree this is the MAIN repo's .git, which is
 *  where `worktrees/`, refs and packed-refs.lock live. Concurrency on
 *  worktree add/remove/prune must be keyed on THIS, not on the worktree
 *  path. Older git prints a relative path — resolve against cwd. */
export async function getGitCommonDir(cwd: string): Promise<string> {
  const r = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (r.code !== 0) throw new Error(trimGitErrorOutput(r.stderr))
  const p = r.stdout.trim()
  return isAbsolute(p) ? p : join(cwd, p)
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  validateRef(branch)
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return r.code === 0
}

export async function commitExists(cwd: string, sha: string): Promise<boolean> {
  const r = await runGit(cwd, ['cat-file', '-e', `${sha}^{commit}`])
  return r.code === 0
}

/** Create a linked worktree. `newBranch=true` → `worktree add -b <branch> <path> <baseRef>`;
 *  `false` → check out the EXISTING branch (`worktree add <path> <branch>`, baseRef ignored). */
export async function createWorktree(
  mainRepoCwd: string, worktreePath: string, branch: string, baseRef: string, newBranch: boolean,
): Promise<void> {
  validateRef(branch)
  const args = newBranch
    ? ['worktree', 'add', '-b', branch, worktreePath, baseRef]
    : ['worktree', 'add', worktreePath, branch]
  const r = await runGit(mainRepoCwd, args)
  if (r.code !== 0) throw new Error(trimGitErrorOutput(r.stderr))
}

/** Remove a linked worktree (force — the delete-session flow has already
 *  confirmed the loss of uncommitted changes). Branch is NOT touched. */
export async function removeWorktreeDir(mainRepoCwd: string, worktreePath: string): Promise<void> {
  const r = await runGit(mainRepoCwd, ['worktree', 'remove', '--force', worktreePath])
  if (r.code !== 0) throw new Error(trimGitErrorOutput(r.stderr))
}

export async function worktreeIsDirty(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ['status', '--porcelain'])
  return r.code === 0 && r.stdout.trim().length > 0
}
```

- [ ] **Step 4: 修 linkedWorktrees 探测**

`getStatusInRepo` 内(~492-495)现为:

```ts
const hasLinkedWorktrees = await fsPromises.access(join(repoRoot, '.git', 'worktrees'))
```

改为先解析 common dir 再探测(cwd 在 linked worktree 内时 `.git` 是文件,`join(repoRoot, '.git', 'worktrees')` 恒失败):

```ts
let hasLinkedWorktrees = false
try {
  const commonDir = await getGitCommonDir(cwd)
  await fsPromises.access(join(commonDir, 'worktrees'))
  hasLinkedWorktrees = true
} catch { /* not a repo with linked worktrees */ }
```

(此处 try/catch 是"探测"语义本身,非新增防御。若该探测在 `listWorktrees` 里也有一份,同法修复。)

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run server/git.worktree.test.ts && npx vitest run server/git`
Expected: 全部 PASS(原有 git 测试不回归)。

- [ ] **Step 6: Commit**

```bash
git add server/git.ts server/git.worktree.test.ts
git commit -m "feat(git): worktree primitives + common-dir linkedWorktrees probe"
```

---

### Task 2: WorktreeInfo 共享类型 + 三层字段打通

**Files:**
- Modify: `shared/session-info.ts`(`SessionInfoBase` 附近新增类型 + 字段)
- Modify: `server/session-types.ts`(`Session` 接口,`repoRoot` 字段后)
- Modify: `server/persistence.ts`(`SessionMeta` 接口 ~97-99 行附近 + `coerceMeta` ~266 行附近)
- Modify: `server/session-manager.ts`(`projectSharedSessionFields` ~6653 起的参数与返回;`snapshotMeta` ~1346;spawn 内 Session 字面量 ~2720;`writeStore` 的字段拷贝)

**Interfaces:**
- Produces:`WorktreeInfo`(shared,server/client 共用):

```ts
/** Worktree isolation metadata. Present (and `cwd` = the worktree path)
 *  when the session runs in its own linked git worktree. */
export interface WorktreeInfo {
  /** The user's MAIN repo checkout — what fork falls back to and what
   *  recreate reads branches from. */
  mainRepoPath: string
  /** Branch created for this session (`crw/<sessionId8>`). Kept after
   *  session deletion. */
  branch: string
  /** Main-repo HEAD at creation time — recreate fallback when the branch
   *  was deleted externally. */
  baseSha: string
}
```

`Session` / `SessionMeta` / `SessionInfoBase` 各加 `worktree?: WorktreeInfo`。

- [ ] **Step 1: shared 类型 + SessionInfoBase 字段**

`shared/session-info.ts`:按上文定义 `WorktreeInfo` 并导出;`SessionInfoBase` 的 `gitStartSha` 字段后加:

```ts
/** Worktree isolation metadata. Undefined = the session runs in the user's
 *  own checkout. Persisted; survives resume/restart. */
worktree?: WorktreeInfo
```

- [ ] **Step 2: server 侧三处类型 + 投影**

1. `server/persistence.ts`:`SessionMeta` 加 `worktree?: WorktreeInfo`(import 自 `../shared/session-info.js`);`coerceMeta` 加:

```ts
worktree: coerceWorktree(r.worktree),
```

```ts
function coerceWorktree(raw: unknown): WorktreeInfo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const w = raw as Record<string, unknown>
  if (typeof w.mainRepoPath !== 'string' || typeof w.branch !== 'string' || typeof w.baseSha !== 'string') return undefined
  return { mainRepoPath: w.mainRepoPath, branch: w.branch, baseSha: w.baseSha }
}
```

2. `server/session-types.ts`:`Session` 接口 `repoRoot` 后加 `worktree?: WorktreeInfo`(import 类型)。
3. `server/session-manager.ts`:
   - `snapshotMeta` 的返回类型注解与返回对象各加 `worktree?: WorktreeInfo` / `worktree: (opts as { worktree?: WorktreeInfo }).worktree,`
   - spawn 内 Session 字面量(~2720,`cwd: existingMeta?.cwd ?? metaSnapshot.cwd` 旁)加:`worktree: existingMeta?.worktree ?? metaSnapshot.worktree,`
   - `projectSharedSessionFields`:参数类型加 `worktree?: WorktreeInfo`,返回对象加 `worktree: x.worktree,`
   - `writeStore`(grep `private writeStore`):在拷贝 `gitStartSha`/`repoRoot` 的同一处加 `worktree: s.worktree,`

- [ ] **Step 3: typecheck + 现有测试**

Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.node.json --noEmit && npx vitest run server/session-manager.test.ts server/persistence` 
(第二个路径按实际 persistence 测试文件名调整,grep `server/*.test.ts` 里含 `coerceMeta` 的)
Expected: 0 errors,测试全绿(新字段 optional,老数据 coerce 出 undefined)。

- [ ] **Step 4: Commit**

```bash
git add shared/session-info.ts server/session-types.ts server/persistence.ts server/session-manager.ts
git commit -m "feat(session): thread worktree isolation metadata through Session/Meta/Info"
```

---

### Task 3: session-worktree.ts 模块(创建/重建/清理 + per-repo mutex)

**Files:**
- Create: `server/session-worktree.ts`
- Test: `server/session-worktree.test.ts`(新建)

**Interfaces:**
- Consumes: Task 1 的全部原语;`HttpError`(`server/errors.js`)。
- Produces(后续任务依赖):

```ts
export function worktreePathFor(stateDir: string, sessionId: string): string  // <stateDir>/worktrees/<sessionId>
export function branchFor(sessionId: string): string                          // crw/<sessionId 前 8 位>
export interface ProvisionedWorktree { worktreePath: string; branch: string; baseSha: string }
export async function provisionWorktree(stateDir: string, sessionId: string, mainRepoCwd: string): Promise<ProvisionedWorktree>
export async function ensureWorktreeForResume(stateDir: string, sessionId: string, wt: WorktreeInfo): Promise<{ cwd: string; worktree?: WorktreeInfo }>
export async function removeWorktreeForSession(stateDir: string, sessionId: string, wt: WorktreeInfo, log: { warn(msg: string): void }): Promise<void>
```

- [ ] **Step 1: 写失败测试**

`server/session-worktree.test.ts`,首行 `// @vitest-environment node`,复用 Task 1 的 `makeRepo` helper 模式(可把 helper 抽到 `server/test-git-fixtures.ts` 共享,若 shadow-git.test.ts 已有等价 helper 则直接 import)。状态目录用 `mkdtemp`。用例:

1. `provisionWorktree` 返回路径/分支/baseSha,目录存在,`branchExists` 为 true,baseSha 等于主仓 HEAD。
2. 主仓非 git 目录 → 抛 `HttpError` 400(消息含 "git")。
3. 空仓库(unborn HEAD,init 后不 commit)→ 抛 400(消息含 "commit")。
4. `ensureWorktreeForResume`:worktree 目录在 → 原样返回;目录删了分支在 → 重建后目录在且 `cwd` 回 worktree 路径;目录删了分支也删了但 baseSha commit 在 → 以 baseSha 重建同名分支;主仓也没了/分支 baseSha 全没了 → 返回 `{ cwd: mainRepoPath, worktree: undefined }`。
5. `removeWorktreeForSession`:目录被移除,分支保留;主仓已不存在时不抛(走 log.warn)。
6. mutex:同一主仓并发调 `provisionWorktree` × 3(不同 sessionId),全部成功且互不交错(用计数器记录进入/离开配对,或简单断言三次都成功——git 层竞争是间歇性故障,重点断言 API 完成即可,配一条 `withRepoLock` 导出直接测串行:进锁计数 +1、出锁 -1、终值 0)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-worktree.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现模块**

```ts
// server/session-worktree.ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from './errors.js'
import { branchExists, commitExists, createWorktree, getGitCommonDir, removeWorktreeDir, tryCaptureGitHead } from './git.js'
import type { WorktreeInfo } from '../shared/session-info.js'

/** worktree add/remove/prune race on the COMMON dir's lockfiles
 *  (worktrees/, packed-refs.lock) — serialize per common dir, in-process. */
const repoLocks = new Map<string, Promise<void>>()

export async function withRepoLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(commonDir) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const next = prev.then(() => gate)
  repoLocks.set(commonDir, next)
  try {
    await prev
    return await fn()
  } finally {
    release()
    if (repoLocks.get(commonDir) === next) repoLocks.delete(commonDir)
  }
}

export function worktreePathFor(stateDir: string, sessionId: string): string {
  return join(stateDir, 'worktrees', sessionId)
}

export function branchFor(sessionId: string): string {
  return `crw/${sessionId.slice(0, 8)}`
}

/** Branch-name collision backstop (spec: 时间戳后缀重试). The 8-hex id
 *  prefix can collide across sessions, and deleted sessions KEEP their
 *  branches — so a live collision is possible, not theoretical. */
async function branchForUnique(mainRepoCwd: string, sessionId: string): Promise<string> {
  const base = branchFor(sessionId)
  if (!(await branchExists(mainRepoCwd, base))) return base
  return `${base}-${Date.now()}`
}

/** Create a per-session linked worktree off `mainRepoCwd`'s HEAD.
 *  Throws HttpError(400) for non-repo / unborn HEAD / git failure. */
export async function provisionWorktree(
  stateDir: string, sessionId: string, mainRepoCwd: string,
): Promise<ProvisionedWorktree> {
  const baseSha = await tryCaptureGitHead(mainRepoCwd)
  if (!baseSha) {
    throw new HttpError(400, `worktree isolation needs a git repo with at least one commit: ${mainRepoCwd}`)
  }
  const worktreePath = worktreePathFor(stateDir, sessionId)
  const branch = await branchForUnique(mainRepoCwd, sessionId)
  const commonDir = await getGitCommonDir(mainRepoCwd)
  await withRepoLock(commonDir, () => createWorktree(mainRepoCwd, worktreePath, branch, baseSha, true))
  return { worktreePath, branch, baseSha }
}

/** Recreate chain for resume: existing dir → existing branch → baseSha →
 *  fall back to the main repo (clearing the worktree metadata). */
export async function ensureWorktreeForResume(
  stateDir: string, sessionId: string, wt: WorktreeInfo,
): Promise<{ cwd: string; worktree?: WorktreeInfo }> {
  const worktreePath = worktreePathFor(stateDir, sessionId)
  if (existsSync(worktreePath)) return { cwd: worktreePath, worktree: wt }
  if (!existsSync(wt.mainRepoPath)) return { cwd: wt.mainRepoPath, worktree: undefined }
  const commonDir = await getGitCommonDir(wt.mainRepoPath)
  if (await branchExists(wt.mainRepoPath, wt.branch)) {
    await withRepoLock(commonDir, () => createWorktree(wt.mainRepoPath, worktreePath, wt.branch, '', false))
    return { cwd: worktreePath, worktree: wt }
  }
  if (await commitExists(wt.mainRepoPath, wt.baseSha)) {
    await withRepoLock(commonDir, () => createWorktree(wt.mainRepoPath, worktreePath, wt.branch, wt.baseSha, true))
    return { cwd: worktreePath, worktree: wt }
  }
  return { cwd: wt.mainRepoPath, worktree: undefined }
}

/** Delete-session cleanup: remove the worktree dir, keep the branch.
 *  Best-effort per spec — a failure logs and does NOT block deletion. */
export async function removeWorktreeForSession(
  stateDir: string, sessionId: string, wt: WorktreeInfo, log: { warn(msg: string): void },
): Promise<void> {
  const worktreePath = worktreePathFor(stateDir, sessionId)
  if (!existsSync(worktreePath)) return
  try {
    const commonDir = await getGitCommonDir(wt.mainRepoPath)
    await withRepoLock(commonDir, () => removeWorktreeDir(wt.mainRepoPath, worktreePath))
  } catch (err) {
    log.warn(`[${sessionId}] worktree cleanup failed (branch ${wt.branch} kept): ${err instanceof Error ? err.message : String(err)}`)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/session-worktree.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/session-worktree.ts server/session-worktree.test.ts server/test-git-fixtures.ts
git commit -m "feat(session): session-worktree provisioning module with per-repo mutex"
```

---

### Task 4: create() 集成 + 路由透传

**Files:**
- Modify: `server/session-manager.ts`(`create()` ~1427-1512:签名改 async;`snapshotMeta` 已在 Task 2 捕获 worktree)
- Modify: `server/routes/sessions.ts`(`CREATE_BODY_FIELDS` 白名单 + `narrowCreateBody` 布尔校验;`POST /sessions` ~356 行 `await`)
- Test: `server/session-manager.test.ts`(追加用例)

**Interfaces:**
- Consumes: Task 3 `provisionWorktree`;Task 2 类型。
- Produces:`sm.create()` 返回 `Promise<SessionInfo>`;create body 新字段 `isolateWorktree?: boolean`。

- [ ] **Step 1: 写失败测试**

`server/session-manager.test.ts` 追加(复用该文件既有的临时 store/git fixture 风格;真实 git 仓用 Task 3 的 fixture helper)。用例:

1. `await sm.create({ cwd: <临时真仓>, model: 'test-model', isolateWorktree: true })`(sm 构造时传 `store`,其 stateDir 指向临时目录)→ 返回 info 的 `cwd` === `<stateDir>/worktrees/<info.id>`,`info.worktree` 等于 `{ mainRepoPath: <临时真仓>, branch: 'crw/' + info.id.slice(0,8), baseSha: <主仓 HEAD> }`;磁盘上 store 里 `sm.get(id).worktree` 同值。
2. `isolateWorktree: 'yes'`(非布尔)→ 抛 400。
3. `isolateWorktree: true` + cwd 非 git 目录 → 抛 400。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-manager.test.ts`
Expected: 新用例 FAIL(create 不认识 isolateWorktree,worktree 字段 undefined)。

- [ ] **Step 3: 实现 create() 改造**

`create()` 签名:`async create(...): Promise<SessionInfo>`;结尾改为:

```ts
    // Worktree isolation (方案 A"创建即替换"): provision BEFORE spawn so
    // opts.cwd / opts.worktree are final when snapshotMeta captures them.
    const isolate = (opts as { isolateWorktree?: unknown }).isolateWorktree
    if (isolate !== undefined && typeof isolate !== 'boolean') {
      throw new HttpError(400, 'isolateWorktree must be a boolean')
    }
    if (isolate === true) {
      const id = randomUUID()
      if (!this.store) throw new HttpError(400, 'worktree isolation requires a state dir')
      const mainRepo = withDefault.cwd
      if (!mainRepo) throw new HttpError(400, 'worktree isolation requires a cwd')
      const prov = await provisionWorktree(this.store.getDir(), id, mainRepo)
      withDefault.cwd = prov.worktreePath
      ;(withDefault as Options & { worktree?: WorktreeInfo }).worktree = {
        mainRepoPath: mainRepo, branch: prov.branch, baseSha: prov.baseSha,
      }
      return this.spawn(id, withDefault, customEnv, undefined, undefined, createPrefs, joinGroupOf, evictingSource)
    }
    return this.spawn(randomUUID(), withDefault, customEnv, undefined, undefined, createPrefs, joinGroupOf, evictingSource)
```

(import `provisionWorktree`、`WorktreeInfo`。`spawn` 返回 `SessionInfo` 非 Promise,但 async 函数里 return 它没问题。)

`server/routes/sessions.ts`:
1. `CREATE_BODY_FIELDS` 集合加 `'isolateWorktree'`(grep 定位该 Set 定义)。
2. `narrowCreateBody` 布尔校验循环加 `'isolateWorktree'`:

```ts
for (const name of ['includePartialMessages', 'includeHookEvents', 'isolateWorktree']) {
```

3. `POST /sessions`:`const info = await sm.create(...)`(约 356 行)。同文件其余 `sm.create` 调用者(无)不需要动;`server/routes/scheduled-sends.ts` 的 `manager.create` 是 ScheduledSendManager 的另一个方法,无关。

- [ ] **Step 4: 修既有测试的 await**

`npx tsc -p tsconfig.node.json --noEmit` 会把所有 `sm.create(...)` 未 await 的测试标红(Promise 上的属性访问)。逐个补 `await`(grep `sm.create(` 于 `server/session-manager.test.ts`)。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run server/session-manager.test.ts server/session-worktree.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/session-manager.ts server/session-manager.test.ts server/routes/sessions.ts
git commit -m "feat(session): opt-in per-session worktree isolation at create"
```

---

### Task 5: resume 重建链

**Files:**
- Modify: `server/session-manager.ts`(`doResume` 内 `cwdMissing` 探针 ~1604-1607 之前;resumeOpts 构建 ~1694 `cwd: meta.cwd` 处)
- Test: `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 3 `ensureWorktreeForResume`。

- [ ] **Step 1: 写失败测试**

用例(真 git 仓 + 临时 store):
1. 构造 meta:`{ id, cwd: <worktreePath>, worktree: { mainRepoPath, branch, baseSha } }`,worktree 目录**不存在**、分支存在 → `await sm.resume(id)` 成功,且目录被重建(`existsSync(worktreePath)`),session cwd 仍是 worktreePath。
2. 分支也删掉、baseSha commit 在 → resume 成功,目录以 baseSha 重建。
3. 分支删掉且 baseSha 指向的 commit 被清(用 `git reflog expire --expire=now --all && git gc --prune=now` 制造,或直接用假 sha)→ resume 成功但 session cwd 回落为主仓路径,`sm.get(id).worktree` 为 undefined。

(注:resume 会真起 SDK Query——用该测试文件既有的 provider mock / `claudeBinary` 缺失跳过手段,参照文件内已有 resume 用例的做法;若既有用例 mock 了 spawn,复用同款 mock,只断言 ensure 后传入 spawn 的 opts.cwd。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-manager.test.ts`
Expected: 新用例 FAIL(worktree 目录缺失时 resume 抛 `cwdMissing` 400)。

- [ ] **Step 3: 实现**

`doResume` 内,`if (cwdMissing(meta.cwd))` 探针**之前**插入:

```ts
    // Worktree recreate chain (spec: 路径在 → 分支在 → baseSha → 回退主仓).
    // Runs BEFORE the cwdMissing probe: a GC'd worktree dir must reconstruct,
    // not 400. Mutates the local meta copy and persists the fallback so the
    // next resume doesn't re-walk the chain.
    if (meta.worktree && meta.cwd && !existsSync(meta.cwd)) {
      const ensured = await ensureWorktreeForResume(this.store!.getDir(), id, meta.worktree)
      if (ensured.cwd !== meta.cwd || ensured.worktree !== meta.worktree) {
        meta = { ...meta, cwd: ensured.cwd, worktree: ensured.worktree }
        this.store?.upsert(meta)
      }
    }
```

(`meta` 若被声明为 const 则改 let;`existsSync` 从 `node:fs` import——该文件大概率已有。)

resumeOpts 构建处(`cwd: meta.cwd` 同级)加 `worktree: meta.worktree,`,使 re-spawn 的 snapshotMeta 捕获它。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(session): recreate isolated worktree on resume (branch → baseSha → main repo)"
```

---

### Task 6: delete 清理 + setCwd 清字段 + 快照失效

**Files:**
- Modify: `server/session-manager.ts`(`delete()` ~6026;`setCwd()` ~4253-4263)
- Test: `server/session-manager.test.ts`

- [ ] **Step 1: 写失败测试**

1. create(isolateWorktree: true) 后 `await sm.delete(id)` → worktree 目录不存在,`branchExists(mainRepo, branch)` 仍为 true,`<stateDir>/worktrees/<id>` 不留残余。
2. create(isolateWorktree: true) 后 `sm.setCwd(id, <另一临时目录>)` → `sm.get(id).worktree` 为 undefined;再对该 session 的 snapshot store 有失效行为(用例:先往 snapshot store 塞一条 meta——直接用 `SnapshotStore.upsert`/内部 API,参照 `server/snapshot/snapshot-store.test.ts` 的用法——断言 setCwd 后 `load(id)` 为 null)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-manager.test.ts`
Expected: FAIL(worktree 目录删除后仍在 / worktree 字段未清)。

- [ ] **Step 3: 实现**

`delete()` 开头(store 读取必须在 `store.remove` 之前):

```ts
  async delete(id: string): Promise<void> {
    const meta = this.store?.get(id)
    await this.unload(id, { terminated: true, reason: 'deleted' })
    if (meta?.worktree && this.store) {
      await removeWorktreeForSession(this.store.getDir(), id, meta.worktree, this.log)
    }
    this.store?.remove(id)
    // ……其余不动
```

(`this.log` 为 SessionManager 已有 logger 字段,名字以文件内既有为准,grep `createLogger`。)

`setCwd()` 的 `nextMeta` 加一个字段,并在 upsert 后加快照失效:

```ts
    const nextMeta: SessionMeta = {
      ...meta,
      cwd,
      // The user re-pointed the session by hand — worktree isolation no
      // longer applies (and the recreate chain must not resurrect a worktree
      // at the new cwd's expense).
      worktree: undefined,
      lastActivityAt: Date.now(),
      repoRoot: undefined,
      gitStartSha: undefined,
      ...(cleared ? { terminated: false, terminatedReason: undefined, error: undefined } : {}),
    }
    this.store.upsert(nextMeta)
    // Stale shadow-repo meta points at the OLD cwd (resolveRepo reuses it
    // blindly) — drop it so the next capture re-resolves against the new dir.
    void this.snapshotStore.remove(id)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/session-manager.test.ts server/snapshot`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(session): clean up worktree on delete; setCwd clears isolation + snapshot meta"
```

---

### Task 7: fork 回主仓

**Files:**
- Modify: `server/session-manager.ts`(`fork()` 内 forkOpts 构建 ~2031 `cwd: meta.cwd`)
- Test: `server/session-manager.test.ts`

- [ ] **Step 1: 写失败测试**

create(isolateWorktree: true) 并完成一轮(参照文件内既有 fork 用例如何满足 `lastTurnAt` 前置——通常直接改 session/meta 状态或 mock),然后 `await sm.fork(id)` → fork 出的 session `cwd` === `worktree.mainRepoPath` 且 `worktree` 为 undefined。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-manager.test.ts`
Expected: FAIL(fork cwd 是 worktree 路径)。

- [ ] **Step 3: 实现**

forkOpts 处改为:

```ts
      // An isolated source forks back to the user's main repo: two sessions
      // sharing one worktree is a clobber hazard, and forking INTO a second
      // worktree is out of scope for v1. The user can re-check isolation on
      // the fork's own create path.
      cwd: meta.worktree?.mainRepoPath ?? meta.cwd,
```

(worktree 字段本就不在 forkOpts 的显式拷贝清单里,不会随 fork 传播——无需额外清除,测试断言兜底。)

- [ ] **Step 4: 跑测试确认通过 + Commit**

Run: `npx vitest run server/session-manager.test.ts`

```bash
git add server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(session): fork of an isolated session falls back to the main repo"
```

---

### Task 8: worktree-status 路由(删除确认用)

**Files:**
- Modify: `server/routes/sessions.ts`(`DELETE /sessions/:id` 附近新增 GET)
- Test: `server/routes/sessions.test.ts`(若该文件不存在,grep `server/routes/*.test.ts` 找既有路由测试挂载方式,跟随之)

**Interfaces:**
- Produces:`GET /sessions/:id/worktree-status` → `{ available: boolean; dirty?: boolean; branch?: string; mainRepoPath?: string }`

- [ ] **Step 1: 写失败测试**

用例:1) 无 worktree 的 session → `{ available: false }`;2) 有 worktree 且干净 → `{ available: true, dirty: false, branch, mainRepoPath }`;3) worktree 目录里写个未跟踪文件 → `dirty: true`。需要真实 git 仓 fixture + 伪造 SessionMeta(用既有路由测试的 sm/store 搭建方式)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/routes`(按实际文件)
Expected: FAIL(404)。

- [ ] **Step 3: 实现**

```ts
  // Dirty-check for the delete confirmation: does this session run in an
  // isolated worktree, and does that worktree hold uncommitted changes?
  app.get('/sessions/:id/worktree-status', async (c) => {
    const id = c.req.param('id')
    const wt = sm.get(id).worktree
    if (!wt) return c.json({ available: false })
    const worktreePath = worktreePathFor(stateDir, id)
    if (!existsSync(worktreePath)) return c.json({ available: false })
    const dirty = await worktreeIsDirty(worktreePath)
    return c.json({ available: true, dirty, branch: wt.branch, mainRepoPath: wt.mainRepoPath })
  })
```

(`stateDir` 在 buildApiRouter 作用域内如何取,跟随同文件其它路由的既有取法;若无处可取,在 buildApiRouter 增加参数并在 `server/app.ts` 传入——跟随既有注入风格。)

- [ ] **Step 4: 跑测试确认通过 + Commit**

Run: `npx vitest run server/routes`

```bash
git add server/routes/sessions.ts server/routes/sessions.test.ts
git commit -m "feat(api): GET /sessions/:id/worktree-status for delete confirmation"
```

---

### Task 9: 客户端 —— 类型 + NewSessionDialog 勾选 + App 透传

**Files:**
- Modify: `src/types.ts`(`NewSessionForm` ~97-137)
- Modify: `src/components/session-list/NewSessionDialog.tsx`(cwd 输入框 ~595 附近;submit ~455)
- Modify: `src/App.tsx`(`handleCreate` ~1791,form → POST body 映射)
- Test: 既有 NewSessionDialog 测试文件(grep `NewSessionDialog.test`),无则跟随仓库内其它 dialog 测试的位置约定

**Interfaces:**
- Consumes: Task 4 的 create body 字段 `isolateWorktree`。
- Produces:`NewSessionForm.isolateWorktree?: boolean` → POST body `isolateWorktree`。

- [ ] **Step 1: 类型 + 表单状态 + 提交**

`src/types.ts` 的 `NewSessionForm` 加:

```ts
  /** Opt-in: run this session in its own git worktree (server provisions
   *  <stateDir>/worktrees/<sessionId> off the repo HEAD). */
  isolateWorktree?: boolean
```

`NewSessionDialog.tsx`:新增 state `const [isolate, setIsolate] = useState(false)`;cwd 输入框下方渲染:

```tsx
<label className="flex items-start gap-2 text-xs">
  <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />
  <span>
    隔离到独立 worktree
    <span className="block text-[--text-muted]">
      改动进独立分支(crw/…),不影响主仓工作区;worktree 从 HEAD 干净检出,不含 gitignore 文件(如 .env、node_modules)
    </span>
  </span>
</label>
```

(样式类名跟随该文件既有 tailwind 约定与 `packages/ui` token,`--text-muted` 以仓库实际 muted 色变量名为准,grep `styles/tokens.css`;勿用 hex。)

`submit()` 的 `onSubmit({...})` 加 `isolateWorktree: isolate || undefined,`。

`App.tsx` `handleCreate`:POST body 映射处加 `isolateWorktree: form.isolateWorktree,`。

- [ ] **Step 2: 测试**

跟随既有 dialog 测试风格(先 grep 该文件是否已有测试):渲染 dialog → 勾选 → submit → 断言 `onSubmit` 收到 `isolateWorktree: true`;默认不勾 → 字段 undefined。400 错误透传依赖既有 create 错误展示路径(找到 handleCreate 的 catch/错误 state,确认 worktree 400 的 message 会进同一展示;若无断言点,在现有错误展示测试旁加一条:mock 400 响应 `{ error: 'worktree isolation needs a git repo…' }`,断言错误文案出现)。

- [ ] **Step 3: 跑客户端测试 + typecheck + Commit**

Run: `npx vitest run src/components/session-list` (按实际) `&& npx tsc -p tsconfig.json --noEmit`

```bash
git add src/types.ts src/components/session-list/NewSessionDialog.tsx src/App.tsx
git commit -m "feat(ui): worktree isolation checkbox in new-session dialog"
```

---

### Task 10: 客户端 —— ChatPanel badge + 删除确认警告

**Files:**
- Modify: `src/components/ChatPanel.tsx`(cwd chip ~1191-1204;title tooltip ~819-824 的 tooltip 机制可参考)
- Modify: 删除确认触发点(grep `DELETE /sessions/` 或 `deleteSession` 于 `src/`,定位 ConfirmDialog 调用处)

**Interfaces:**
- Consumes: `SessionInfo.worktree`(Task 2 已投影到客户端 session 对象);Task 8 路由。

- [ ] **Step 1: ChatPanel badge**

cwd chip 处(`{shortenPath(session.cwd)}` 旁)加:

```tsx
{session.worktree && (
  <span
    className="..."
    title={`隔离 worktree\n主仓:${session.worktree.mainRepoPath}\n分支:${session.worktree.branch}`}
  >
    worktree
  </span>
)}
```

(样式跟随 cwd chip 现有 badge/chip 类;若该处已用统一 Tooltip 组件,则改用之——跟随文件内既有 tooltip 用法,不引入新依赖。)

- [ ] **Step 2: 删除确认警告**

删除触发点:打开确认框前先查状态(仅当 `session.worktree` 存在时):

```ts
const st = await api.get<{ available: boolean; dirty?: boolean }>(`/sessions/${id}/worktree-status`)
```

`dirty === true` 时确认文案追加一行:

```
⚠ 该 session 的 worktree 有未提交改动,删除后丢失(分支 {branch} 保留)
```

(api 封装以 `src/hooks/useApi.ts` 实际签名为准;ConfirmDialog 的 message/children 用现有组件能力渲染多行。)

- [ ] **Step 3: 测试 + typecheck + Commit**

跟随既有组件测试风格补两条:badge 条件渲染(worktree 有/无);删除确认在 dirty 时文案含警告(可 mock api)。跑 `npx tsc -p tsconfig.json --noEmit`。

```bash
git add src/components/ChatPanel.tsx <删除确认文件> <测试文件>
git commit -m "feat(ui): worktree badge + dirty warning in delete confirmation"
```

---

### Task 11: 全量验证 + 评审

- [ ] **Step 1: 全量检查**

```bash
npm run typecheck   # 两个 tsconfig
npm run lint
npm run test
```

Expected: 全绿。若有失败,修复后重跑(修复本身也要过 lint/typecheck)。

- [ ] **Step 2: 手工冒烟(可选但推荐)**

`npm run dev`,真仓上:勾选创建 → 看 ChatPanel badge/cwd → 在 session 里让 agent 建个文件 → GitPanel 确认 diff 只在 worktree → 删除 session → 确认目录消失、`git branch --list 'crw/*'` 分支仍在。

- [ ] **Step 3: code-review**

对全量 diff(本计划所有 commit)运行 `code-review` 技能(CLAUDE.md:未评审代码不得提交到 main;本步骤在 push/收尾前完成)。确认的 findings 修复后,非平凡修复重跑评审。

- [ ] **Step 4: 最终提交**

```bash
git log --oneline   # 确认 11 个原子 commit
```
