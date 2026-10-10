# TaskList 服务端派生快照 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端从全量转录派生 TaskCreate/TaskUpdate 折叠快照,经 WS 播种帧 + REST 供给客户端,消除长会话里 TaskList 显示 `Task #N` 占位标题的问题。

**Architecture:** 转录即持久化——折叠纯函数移到 `shared/task-list.ts` 两端共用;服务端 `deriveTaskList` 经 `jsonl-cache`(已有全量解析缓存)派生,pump 在 Task* tool_result 落地与真用户消息落地时触发广播,`SessionEventBroadcaster` 仿 git-snapshot 提供播种订阅;客户端 `useTaskList` sink + `mergeTaskList`(窗口折叠逐 id 胜出)喂 `TodoChecklist` 与 `TaskInfoProvider`。

**Tech Stack:** TypeScript(严格)、React 19、Hono、vitest(forks 池)、shared/ 双端模块约定。

**Spec:** `docs/superpowers/specs/2026-10-10-tasklist-server-derived-snapshot-design.md`(本计划从 spec 论证,执行者须同时读两份)

## Global Constraints

- 日志一律 `createLogger(scope)`,禁止裸 `console.*` 做诊断(模块顶部声明一个 logger)。
- metrics 标签只用有限枚举,禁止 sessionId/uuid 入标签。
- 类型检查必须两个 tsconfig 都过:`npm run typecheck`(tsconfig.json + tsconfig.node.json)。
- 测试:`npm run test`;服务端/shared 纯逻辑跑 node 环境(vitest.config.ts 的 include 已含 `shared/**/*.test.ts`,默认 node);React 挂载测试默认 happy-dom。`globals: false`——**不要**新增 per-file `afterEach(cleanup)`(`src/test-setup.ts` 已注册)。
- CSS 不涉及本计划(零样式改动)。
- git 调用不涉及本计划(零 git 命令)。
- 每个任务结束即 commit;全部完成后、宣称完成前必须跑 code-review(CLAUDE.md:未审查的代码不得提交/收工)。
- 提交信息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

## Review Focus

spec 隐含但任务测试未直接覆盖、最容易咬到使用者的五类输入(每行已钉进对应任务的测试步骤):

1. **CLI 正在追加的残缺末行**(torn final line)——`readAll` 必须只服务完整行,残缺行等下次增量解析(钉在 Task 2 的 readAll 测试)。
2. **合成 user 帧**(task-notification 注入 / tool_result 载体 / sidechain 子帧)不得移动 stale 边界(钉在 Task 2 的 derive 测试:三种帧各一例)。
3. **WS 乱序帧**(rev 回退)不得回滚客户端状态(钉在 Task 6 的 hook 测试)。
4. **无转录文件的 session**(未 spawn / 被 GC)——派生返回 `{rev:0,tasks:[]}`,REST 对已知 session 返回 200 而非 500(钉在 Task 2 + Task 5 测试)。
5. **删除任务的瞬时复活**——`TaskUpdate(deleted)` 的 tool_result 落地必须触发 `onTaskListChanged`,否则快照滞留已删任务(钉在 Task 3 的 pump 测试)。

---

### Task 1: `shared/task-list.ts` — 折叠纯函数移位 + mergeTaskList + 快照类型

**Files:**
- Create: `shared/task-list.ts`
- Create: `shared/task-list.test.ts`(由 `git mv src/utils/task-events.test.ts` 而来)
- Modify: `src/utils/task-events.ts`(删去移走的部分,改 re-export)

**Interfaces:**
- Consumes: `shared/user-frames.js` 的 `userMessageHasToolResult` / `isTaskNotificationUserMessage` / `UserFrameShape`(已存在)。
- Produces(后续任务依赖,签名逐字):`TaskState { id: string; subject: string; status: 'pending'|'in_progress'|'completed'|'cancelled'; activeForm?: string; lastTouched: number; provisional?: boolean; stale?: boolean }`;`buildTaskStateMap(messages: readonly unknown[]): Map<string, TaskState> | null`;`buildTaskStateMapFromItems(items: readonly { msg: unknown }[]): Map<string, TaskState> | null`;`parseTaskId(text: string): string | null`;`resultText(content: unknown): string`;`normalizeStatus(s: string | undefined): 'pending'|'in_progress'|'completed'|'cancelled'|undefined`;`str(v: unknown): string | undefined`;`TASK_CREATE`/`TASK_UPDATE`(常量 `'TaskCreate'`/`'TaskUpdate'`);`countTaskEvents(messages: readonly unknown[]): number`;`isGenuineUserInputFrame(msg: UserFrameShape): boolean`;`TasklistSnapshotTask { id: string; subject: string; status: ...同上四态; activeForm?: string; stale: boolean }`;`TasklistSnapshotPayload { rev: number; tasks: TasklistSnapshotTask[] }`;`mergeTaskList(snapshot: TasklistSnapshotPayload | null | undefined, windowFold: Map<string, TaskState> | null): Map<string, TaskState>`。

- [ ] **Step 1: 迁移测试文件并改导入(先跑确认仍绿)**

```bash
git mv src/utils/task-events.test.ts shared/task-list.test.ts
```

编辑 `shared/task-list.test.ts`:把 `import { buildTaskStateMap, buildTaskStateMapFromItems } from './task-events'` 改为 `from './task-list'`;删除 `import type { SdkMessage } from '../types'`,把两个 helper 的返回类型与断言基座改为宽松形状(断言本身一行不动):

```ts
type Loose = Record<string, unknown>
function assistant(blocks: unknown[]): Loose {
  return { type: 'assistant', message: { content: blocks } }
}
function toolResult(toolUseId: string, text: string): Loose {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } }
}
```

文件内所有 `SdkMessage` 类型标注改 `Loose`,传参处若 TS 报窄化错误则 `as unknown as Loose`。此时导入目标还不存在——**故意让编译失败**(TDD 红灯的一种)。

- [ ] **Step 2: 验证测试因模块缺失而失败**

Run: `npx vitest run shared/task-list.test.ts`
Expected: FAIL(`Cannot find module './task-list'` 或等价解析错误)

- [ ] **Step 3: 写 `shared/task-list.ts`(完整内容)**

从 `src/utils/task-events.ts` **原样搬运**(`foldTaskEvents`/`hasTaskEvents`/`buildTaskStateMap`/`buildTaskStateMapFromItems`/`resultText`/`parseTaskId`/`str`/`normalizeStatus`/`TASK_CREATE`/`TASK_UPDATE`/`TaskState`,一行逻辑不改),仅做三处机械适配:`SdkMessage` 参数类型放宽为 `readonly unknown[]` / `readonly { msg: unknown }[]`(内部经 `as FoldableMessage` 收窄);`TaskState` 增加 `stale?: boolean`;注释里的 `src/utils/task-events.ts` 路径引用改成本文件。文件骨架:

```ts
// TaskCreate/TaskUpdate event-stream fold — SHARED between the browser
// (TodoChecklist / TaskMutationView via src/utils/task-events.ts re-exports)
// and the server (tasklist-state.ts deriving the snapshot from the full
// transcript). ONE implementation, not mirrors: the client folds the
// in-memory window, the server folds the whole transcript; both feed
// mergeTaskList. Moved verbatim from src/utils/task-events.ts — see that
// file's header comment for the two tool-family background.
//
// The claude CLI exposes task management through ONE of two mutually-
// exclusive tool families (toggled by CLAUDE_CODE_ENABLE_TASKS):
//   1. TodoWrite (legacy) — whole-list snapshots, NOT handled here.
//   2. TaskCreate/TaskUpdate (claude-code 2.x default) — incremental:
//      the server-assigned `#N` appears only in the create's tool_result
//      text; TaskUpdate mutates by that id, status 'deleted' removes.

import {
  userMessageHasToolResult,
  isTaskNotificationUserMessage,
  type UserFrameShape,
} from './user-frames.js'

export interface TaskState {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  activeForm?: string
  lastTouched: number
  provisional?: boolean
  /** Server-precomputed staleness — snapshot entries only (TasklistState).
   *  undefined on window-folded entries: the client then applies its own
   *  window-relative rule (lastTouched vs lastUserInputIndex). */
  stale?: boolean
}

export const TASK_CREATE = 'TaskCreate'
export const TASK_UPDATE = 'TaskUpdate'

/** Minimal structural slice the fold reads off a transcript frame. The
 *  server's normalized wire objects and the client's SdkMessage both
 *  satisfy it; callers pass `readonly unknown[]` and we narrow here. */
interface FoldableMessage {
  type?: unknown
  message?: unknown
  parent_tool_use_id?: unknown
}

// --- hasTaskEvents / foldTaskEvents / buildTaskStateMap /
//     buildTaskStateMapFromItems / resultText / parseTaskId / str /
//     normalizeStatus: moved VERBATIM from src/utils/task-events.ts, with
//     `SdkMessage` swapped for FoldableMessage narrowing:
//       const msg = messages[i] as FoldableMessage
//     and content access via:
//       const content = (msg.message as { content?: unknown } | undefined)?.content
//     (body omitted here — copy from the source file; zero logic changes)
```

(上面省略段执行时从 `src/utils/task-events.ts:67-234` 与 `253-289` 逐行复制,保持原有注释。)

文件尾部追加**新代码**(fold 外的三个纯函数 + 快照类型):

```ts
// --- snapshot payload types ---------------------------------------------

export interface TasklistSnapshotTask {
  /** Server-assigned numeric id (the `#N`), same shape as TaskUpdate's
   *  `taskId` input — the stable identity across snapshot and window fold. */
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  activeForm?: string
  /** Server-precomputed staleness (resolved AND last touched before the
   *  last genuine user input). The client executes this flag as-is for
   *  snapshot-only entries; window entries win the merge and keep their
   *  own rule. */
  stale: boolean
}

export interface TasklistSnapshotPayload {
  /** Count of Task* tool_use events folded. Monotone under append-only
   *  transcript growth; the client drops frames whose rev regresses. */
  rev: number
  tasks: TasklistSnapshotTask[]
}

/** Count TaskCreate/TaskUpdate tool_use blocks. Monotone under append-only
 *  growth (per session; /clear respawns to a new id). */
export function countTaskEvents(messages: readonly unknown[]): number {
  let n = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as FoldableMessage
    if (msg.type !== 'assistant') continue
    const content = (msg.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_use') continue
      if (block.name === TASK_CREATE || block.name === TASK_UPDATE) n++
    }
  }
  return n
}

/** Server-side stale-boundary criterion over transcript lines: a genuine
 *  top-level human input frame. Same discriminator as the pump's echo
 *  drop-filter (server/session-pump.ts:876-881): null-parent user frame
 *  with no tool_result block and no <task-notification> injection — so
 *  background-subagent result injections and tool_result carriers never
 *  move the "user has moved on" boundary. (The client's window cleanup
 *  uses the richer isHumanUserMessage; snapshot entries carry the server's
 *  precomputed flag instead, so the two never compare across coordinate
 *  systems.) */
export function isGenuineUserInputFrame(msg: UserFrameShape): boolean {
  if (msg.type !== 'user') return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  if (isTaskNotificationUserMessage(msg)) return false
  return true
}

/** Merge the server snapshot (full-history base) under the client's window
 *  fold (freshest event order). Window entries WIN per id; the snapshot
 *  fills ids the window can't see (creates beyond the ring/memory cap).
 *  Snapshot entries flagged `stale && resolved` are dropped here — the
 *  client's window-relative staleness rule cannot see them.
 *  Pure; returns a fresh Map. */
export function mergeTaskList(
  snapshot: TasklistSnapshotPayload | null | undefined,
  windowFold: Map<string, TaskState> | null,
): Map<string, TaskState> {
  const merged = new Map<string, TaskState>()
  if (windowFold) {
    for (const [id, t] of windowFold) merged.set(id, t)
  }
  if (snapshot) {
    for (const t of snapshot.tasks) {
      if (merged.has(t.id)) continue
      if (t.stale && (t.status === 'completed' || t.status === 'cancelled')) continue
      merged.set(t.id, {
        id: t.id,
        subject: t.subject,
        status: t.status,
        ...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
        // Server line-index coordinate — meaningless client-side; the
        // stale flag supersedes it for snapshot-only entries.
        lastTouched: -1,
        stale: t.stale,
      })
    }
  }
  return merged
}
```

- [ ] **Step 4: 改写 `src/utils/task-events.ts` 为 re-export + 客户端专属 helper**

删去已搬走的部分,文件保留(客户端专属、依赖 `src/session-store/normalize` 的)两个函数 + re-export:

```ts
// Client-side surface of the shared Task* fold (shared/task-list.ts):
// re-exports the pure fold for existing import sites (TodoChecklist,
// TaskMutationView, useTaskInfo) and keeps the two window-relative helpers
// that depend on the client's richer isHumanUserMessage classification.

export {
  buildTaskStateMap,
  buildTaskStateMapFromItems,
  countTaskEvents,
  isGenuineUserInputFrame,
  mergeTaskList,
  normalizeStatus,
  parseTaskId,
  resultText,
  str,
  TASK_CREATE,
  TASK_UPDATE,
} from '../../shared/task-list'
export type { TaskState, TasklistSnapshotPayload, TasklistSnapshotTask } from '../../shared/task-list'

// lastUserInputIndex / isUserInputMessage — keep VERBATIM from the current
// file (they import isHumanUserMessage from '../session-store/normalize',
// which is client-only).
```

(两个 helper 原文在 `src/utils/task-events.ts:229-249`,原样保留,不改一行。)

- [ ] **Step 5: 在 `shared/task-list.test.ts` 追加新测试(mergeTaskList + isGenuineUserInputFrame + countTaskEvents)**

```ts
import {
  buildTaskStateMap,
  countTaskEvents,
  isGenuineUserInputFrame,
  mergeTaskList,
  type TaskState,
  type TasklistSnapshotPayload,
} from './task-list'

describe('countTaskEvents', () => {
  it('counts Task* tool_use blocks only', () => {
    const lines = [
      assistant([create('c1', 'a'), { type: 'tool_use', id: 'x', name: 'Bash', input: {} }]),
      assistant([update('1', { status: 'in_progress' })]),
    ]
    expect(countTaskEvents(lines)).toBe(2)
  })
  it('is 0 for a transcript without Task* events', () => {
    expect(countTaskEvents([assistant([{ type: 'text', text: 'hi' }])])).toBe(0)
  })
})

describe('isGenuineUserInputFrame', () => {
  it('true for a null-parent text-only user frame', () => {
    expect(isGenuineUserInputFrame({ type: 'user', message: { content: [{ type: 'text', text: 'go' }] } })).toBe(true)
  })
  it('false for tool_result carriers (main-thread results are null-parent too)', () => {
    expect(isGenuineUserInputFrame(toolResult('t1', 'ok'))).toBe(false)
  })
  it('false for sidechain frames (parent_tool_use_id set)', () => {
    expect(isGenuineUserInputFrame({ type: 'user', parent_tool_use_id: 'p1', message: { content: [{ type: 'text', text: 'go' }] } })).toBe(false)
  })
  it('false for <task-notification> injections (closing tag required by the regex)', () => {
    expect(isGenuineUserInputFrame({
      type: 'user',
      message: { content: [{ type: 'text', text: '<task-notification>done</task-notification>' }] },
    })).toBe(false)
  })
  it('false for non-user frames', () => {
    expect(isGenuineUserInputFrame({ type: 'assistant', message: { content: [] } })).toBe(false)
  })
})

describe('mergeTaskList', () => {
  const snap = (tasks: TasklistSnapshotPayload['tasks']): TasklistSnapshotPayload => ({ rev: 1, tasks })

  it('window entries win per id (freshest event order)', () => {
    const window = buildTaskStateMap([
      assistant([create('c1', 'fresh subject')]),
      toolResult('c1', 'Task #1 created successfully: fresh subject'),
      assistant([update('1', { status: 'in_progress' })]),
    ])!
    const merged = mergeTaskList(snap([{ id: '1', subject: 'stale snapshot subject', status: 'completed', stale: false }]), window)
    expect(merged.get('1')!.subject).toBe('fresh subject')
    expect(merged.get('1')!.status).toBe('in_progress')
  })

  it('snapshot fills ids the window cannot see', () => {
    const window = buildTaskStateMap([assistant([update('9', { status: 'in_progress' })])])!
    expect(window.get('9')!.subject).toBe('Task #9') // stub — create out of window
    const merged = mergeTaskList(snap([{ id: '9', subject: 'real subject', status: 'in_progress', stale: false }]), window)
    // window wins the id, so the stub subject stays — see the next test for
    // the composition that actually heals it (window WITHOUT the id).
    expect(merged.get('9')!.subject).toBe('Task #9')
  })

  it('snapshot-only entries keep server-precomputed subjects and carry stale', () => {
    const merged = mergeTaskList(
      snap([
        { id: '3', subject: 'old done task', status: 'completed', stale: true },
        { id: '4', subject: 'old live task', status: 'in_progress', stale: false },
      ]),
      null,
    )
    expect(merged.has('3')).toBe(false) // stale+resolved dropped at merge
    expect(merged.get('4')!.subject).toBe('old live task')
    expect(merged.get('4')!.stale).toBe(false)
    expect(merged.get('4')!.lastTouched).toBe(-1)
  })

  it('stale pending snapshot entries are kept (only resolved ones drop)', () => {
    const merged = mergeTaskList(snap([{ id: '5', subject: 'pending old', status: 'pending', stale: true }]), null)
    expect(merged.get('5')!.subject).toBe('pending old')
  })

  it('returns an empty map for null snapshot + null window', () => {
    expect(mergeTaskList(null, null).size).toBe(0)
  })
})
```

注意第二个用例刻意钉住一个真实语义:**窗口里已有 stub 时快照不覆盖它**(窗口胜出)——真正的治愈路径是窗口里连 update 都看不到、快照唯一持有该 id;这条由 Task 7 的 TodoChecklist 集成测试覆盖。

- [ ] **Step 6: 跑测试确认全绿**

Run: `npx vitest run shared/task-list.test.ts src/utils/task-events.test.ts`
Expected: PASS(后者已 `git mv`,此路径应报"文件不存在"——改跑 `npx vitest run shared/task-list.test.ts`);再跑 `npx vitest run src/components/TodoChecklist.test.tsx src/utils` 确认 re-export 未破坏既有消费方。
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add shared/task-list.ts shared/task-list.test.ts src/utils/task-events.ts
git commit -m "refactor: move Task* fold to shared/task-list.ts, add snapshot types + mergeTaskList"
```

---

### Task 2: `readAll` 读取口 + `server/tasklist-state.ts` 派生(含 metrics)

**Files:**
- Modify: `server/jsonl-cache.ts:66-75`(类型)与 `:206`(实现)
- Create: `server/tasklist-state.ts`
- Create: `server/tasklist-state.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `buildTaskStateMap`/`countTaskEvents`/`isGenuineUserInputFrame`/`TasklistSnapshotPayload`;`jsonlPageCache`(已有单例)。
- Produces:`JsonlPageCache.readAll(sessionId: string): Promise<unknown[]>`(全量行,error 吞掉返回 `[]`);`deriveTaskListFromLines(lines: readonly unknown[]): TasklistSnapshotPayload`(纯);`deriveTaskListForSession(sessionId: string): Promise<TasklistSnapshotPayload>`(带 `tasklist_derive_ms` 直方图)。

- [ ] **Step 1: 写失败测试 `server/tasklist-state.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlPageCache } from './jsonl-cache.js'
import { deriveTaskListFromLines } from './tasklist-state.js'

function assistant(blocks: unknown[]): Record<string, unknown> {
  return { type: 'assistant', message: { content: blocks } }
}
function toolResult(toolUseId: string, text: string): Record<string, unknown> {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } }
}
function humanInput(text: string): Record<string, unknown> {
  return { type: 'user', message: { content: [{ type: 'text', text }] } }
}
const create = (id: string, subject: string) => ({ type: 'tool_use', id, name: 'TaskCreate', input: { subject } })
const update = (taskId: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `u-${taskId}`, name: 'TaskUpdate', input: { taskId, ...input } })

describe('deriveTaskListFromLines (pure)', () => {
  it('derives subjects + rev from a create→result→update chain', () => {
    const lines = [
      humanInput('do it'),
      assistant([create('c1', 'Deploy service')]),
      toolResult('c1', 'Task #3 created successfully: Deploy service'),
      assistant([update('3', { status: 'in_progress' })]),
    ]
    const snap = deriveTaskListFromLines(lines)
    expect(snap.rev).toBe(2)
    expect(snap.tasks).toEqual([
      { id: '3', subject: 'Deploy service', status: 'in_progress', stale: false },
    ])
  })

  it('flags resolved tasks last touched BEFORE the last genuine user input as stale', () => {
    const lines = [
      humanInput('first request'),
      assistant([create('c1', 'old task')]),
      toolResult('c1', 'Task #1 created successfully: old task'),
      assistant([update('1', { status: 'completed' })]),
      humanInput('second request'), // boundary — after the completion
    ]
    const snap = deriveTaskListFromLines(lines)
    expect(snap.tasks[0]!.stale).toBe(true)
  })

  it('a task touched in the current turn (at/after the boundary) is NOT stale', () => {
    const lines = [
      humanInput('request'),
      assistant([create('c1', 'current')]),
      toolResult('c1', 'Task #1 created successfully: current'),
      assistant([update('1', { status: 'completed' })]),
    ]
    expect(deriveTaskListFromLines(lines).tasks[0]!.stale).toBe(false)
  })

  it('synthetic user frames do NOT move the boundary (task-notification / tool_result / sidechain)', () => {
    const notification = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<task-notification>bg done</task-notification>' }] },
    }
    const lines = [
      humanInput('request'),
      assistant([create('c1', 't')]),
      toolResult('c1', 'Task #1 created successfully: t'),
      assistant([update('1', { status: 'completed' })]),
      notification, // would move the boundary → stale:false if misjudged
      toolResult('zzz', 'late tool result'),
      { type: 'user', parent_tool_use_id: 'side', message: { content: [{ type: 'text', text: 'sidechain' }] } },
    ]
    expect(deriveTaskListFromLines(lines).tasks[0]!.stale).toBe(true)
  })

  it('update-only transcript yields the server-side stub subject (create genuinely absent)', () => {
    const lines = [assistant([update('9', { status: 'in_progress' })])]
    const snap = deriveTaskListFromLines(lines)
    expect(snap.rev).toBe(1)
    expect(snap.tasks[0]).toEqual({ id: '9', subject: 'Task #9', status: 'in_progress', stale: false })
  })

  it('deleted tasks are absent; provisional creates (no result yet) are absent', () => {
    const lines = [
      assistant([create('c1', 'gone')]),
      toolResult('c1', 'Task #2 created successfully: gone'),
      assistant([update('2', { status: 'deleted' })]),
      assistant([create('c2', 'inflight')]), // result never lands
    ]
    expect(deriveTaskListFromLines(lines)).toEqual({ rev: 3, tasks: [] })
  })

  it('empty / eventless transcript → { rev: 0, tasks: [] }', () => {
    expect(deriveTaskListFromLines([])).toEqual({ rev: 0, tasks: [] })
    expect(deriveTaskListFromLines([assistant([{ type: 'text', text: 'hi' }])])).toEqual({ rev: 0, tasks: [] })
  })
})

describe('readAll via createJsonlPageCache (fixture files)', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tasklist-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const linesToText = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

  function makeCache(path: string) {
    return createJsonlPageCache({
      locate: async (sid) => sid === 's1' ? { path, stat: { mtimeMs: 1, size: (await import('node:fs/promises')).statSync(path).size } } : null,
      readFile: async (p) => readFile(p, 'utf8'),
    })
  }

  it('serves every complete line; a torn final line is excluded until complete', async () => {
    const lines = [assistant([create('c1', 'a')]), toolResult('c1', 'Task #1 created successfully: a')]
    const p = join(dir, 's1.jsonl')
    await writeFile(p, linesToText(lines) + '{"type":"user","message":{"content":[{"type":"te')
    const cache = makeCache(p)
    expect(await cache.readAll('s1')).toHaveLength(2) // torn line dropped
    await writeFile(p, linesToText(lines) + linesToText([humanInput('next')]))
    expect((await cache.readAll('s1')).length).toBe(3) // completed → included
  })

  it('returns [] when the transcript file does not exist', async () => {
    const cache = createJsonlPageCache({ locate: async () => null, readFile: async () => '' })
    expect(await cache.readAll('nope')).toEqual([])
  })
})
```

(`readFile` 从 `node:fs/promises` 导入,补进文件头;`statSync` 同理改用 `await stat()` 更佳——按项目惯例用 promise 版:`locate` 改 `async` 内 `const st = await stat(path)`。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/tasklist-state.test.ts`
Expected: FAIL(`./tasklist-state` 不存在;`readAll` 不是函数)

- [ ] **Step 3: 实现 `jsonl-cache.ts` 的 `readAll`**

类型(`server/jsonl-cache.ts:66-75` 的 `JsonlPageCache`)加:

```ts
  /** Full renderable transcript (normalized frames) for whole-file folds
   *  (tasklist derive). Same freshness machinery as readPage; same
   *  error-swallowing contract — [] on any failure, never throws. */
  readAll(sessionId: string): Promise<unknown[]>
```

实现(返回对象内,`readPage` 之后):

```ts
    async readAll(sessionId) {
      let entry: CacheEntry | null
      try {
        entry = await resolveEntry(sessionId)
      } catch (err) {
        log.warn(`[${sessionId}] jsonl-cache readAll failed: ${(err as Error).message}`)
        return []
      }
      return entry ? entry.lines : []
    },
```

- [ ] **Step 4: 实现 `server/tasklist-state.ts`**

```ts
// Server-side derivation of the TaskCreate/TaskUpdate checklist state from
// the FULL transcript (the durable CLI JSONL via jsonl-cache). The client
// folds only its in-memory window, so creates beyond the ring/memory cap
// degrade to `Task #N` stubs — this module is the authoritative base layer
// the client merges under its window fold (shared/task-list.ts#mergeTaskList).
//
// No new persistence: the transcript IS the persistence. Every call re-folds
// the cached parsed lines (O(lines) over already-parsed JS objects — ms at
// multi-thousand-line scale), so state is always a pure function of the
// transcript: no write path, no crash-recovery divergence.

import { performance } from 'node:perf_hooks'
import { jsonlPageCache } from './jsonl-cache.js'
import { metrics } from './metrics.js'
import { createLogger } from './log.js'
import {
  buildTaskStateMap,
  countTaskEvents,
  isGenuineUserInputFrame,
  type TasklistSnapshotPayload,
  type TasklistSnapshotTask,
} from '../shared/task-list.js'

const log = createLogger('tasklist')

/** Pure fold over transcript lines. `boundary` is the line index of the
 *  last genuine human input; a resolved task last touched strictly before
 *  it is flagged stale (the "user has moved on" cleanup, computed with
 *  full-transcript coordinates the client window cannot see). */
export function deriveTaskListFromLines(lines: readonly unknown[]): TasklistSnapshotPayload {
  let boundary = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isGenuineUserInputFrame(lines[i] as Parameters<typeof isGenuineUserInputFrame>[0])) {
      boundary = i
      break
    }
  }
  const tasks = buildTaskStateMap(lines)
  const rev = countTaskEvents(lines)
  if (!tasks) return { rev: 0, tasks: [] }
  const out: TasklistSnapshotTask[] = []
  for (const t of tasks.values()) {
    // In-flight creates (result not yet on disk) never enter the snapshot —
    // the client's window fold owns them via its pending:<toolUseId> key.
    if (t.provisional) continue
    const resolved = t.status === 'completed' || t.status === 'cancelled'
    out.push({
      id: t.id,
      subject: t.subject,
      status: t.status,
      ...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
      stale: resolved && t.lastTouched < boundary,
    })
  }
  return { rev, tasks: out }
}

/** Derive the snapshot for one session. [] payload on any failure — the
 *  client degrades to its window fold (today's behavior). */
export async function deriveTaskListForSession(sessionId: string): Promise<TasklistSnapshotPayload> {
  const t0 = performance.now()
  let payload: TasklistSnapshotPayload
  try {
    payload = deriveTaskListFromLines(await jsonlPageCache.readAll(sessionId))
  } catch (err) {
    log.warn(`[${sessionId}] tasklist derive failed: ${err instanceof Error ? err.message : String(err)}`)
    return { rev: 0, tasks: [] }
  }
  metrics.observe('tasklist_derive_ms', performance.now() - t0)
  return payload
}
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `npx vitest run server/tasklist-state.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/jsonl-cache.ts server/tasklist-state.ts server/tasklist-state.test.ts
git commit -m "feat: derive TaskList snapshot from full transcript (jsonl-cache readAll + tasklist_derive_ms)"
```

---

### Task 3: pump 钩子 — Task* tool_result 落地 + 真用户消息落地 → `onTaskListChanged`

**Files:**
- Create: `shared/task-list.ts` 内追加 `taskToolUseId`(见 Step 3)
- Modify: `server/session-pump.ts`(`PumpDeps` 约 `:566`,助手声明约 `:766`,assistant 扫描约 `:915-922`,user 帧扫描约 `:942-948`,echo-drop 分支约 `:876-893`)
- Modify: `server/session-types.ts:584` 附近(Session 字段 `tasklistSubscribers`)、`:762-763`(endAndClear)
- Modify: `server/session-manager.ts:2613` 附近(Session 工厂字段初始化)
- Test: `server/session-pump.test.ts`(追加用例)

**Interfaces:**
- Produces:`taskToolUseId(block: unknown): string | null`(TaskCreate/TaskUpdate 的 tool_use id,否则 null);`PumpDeps.onTaskListChanged?: (sessionId: string) => void`;`Session.tasklistSubscribers: Set<Pushable<unknown>>`。

- [ ] **Step 1: 写失败测试(session-pump.test.ts 追加;镜像该文件现有 pump 装置——参考 `:1391`/`:1938` 的 session mock 形状,给 mock session 加 `tasklistSubscribers: new Set()`)**

```ts
it('fires onTaskListChanged when a Task* tool_result lands', async () => {
  const onTaskListChanged = vi.fn()
  // …用现有装置驱动 pump,注入:
  //   assistant 帧: assistant([create('c1', 'x')])
  //   user 帧:      toolResult('c1', 'Task #1 created successfully: x')
  expect(onTaskListChanged).toHaveBeenCalledWith(session.id)   // TaskCreate 结果落地
})

it('fires onTaskListChanged when a TaskUpdate(deleted) result lands (tombstone broadcast)', async () => {
  const onTaskListChanged = vi.fn()
  //   assistant: update('1', { status: 'deleted' })
  //   user:      toolResult('u-1', 'Task #1 deleted')
  expect(onTaskListChanged).toHaveBeenCalledWith(session.id)
})

it('fires onTaskListChanged when a genuine user echo lands (stale-boundary refresh)', async () => {
  const onTaskListChanged = vi.fn()
  //   user 帧: { type:'user', parent_tool_use_id:null,
  //              message:{ content:[{type:'text',text:'hello'}] } }  ← echo-drop 分支
  expect(onTaskListChanged).toHaveBeenCalledWith(session.id)
})

it('does NOT fire for a tool_result-carrying user frame alone', async () => {
  const onTaskListChanged = vi.fn()
  //   user 帧: toolResult('t1','ok')(无前置 Task* tool_use)
  expect(onTaskListChanged).not.toHaveBeenCalled()
})
```

(执行者按该文件既有的 pump 驱动辅助函数补全 `// …` 部分——四个用例共用一套装置,只有帧序列不同;`onTaskListChanged` 作为 PumpDeps 的 spy 传入。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-pump.test.ts -t "onTaskListChanged"`
Expected: FAIL( spy 未被调用 / PumpDeps 无该字段)

- [ ] **Step 3: 实现**

`shared/task-list.ts` 追加(export 列表同步进 Task 1 的 re-export?不需要——pump 直接从 shared 导入):

```ts
/** The tool_use id when `block` is a TaskCreate/TaskUpdate call, else null.
 *  Pump-side twin of git-broadcast's mutatingToolUseId: the pump remembers
 *  these ids off assistant frames and fires the tasklist broadcast when the
 *  matching tool_result lands. */
export function taskToolUseId(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null
  const b = block as { type?: unknown; name?: unknown; id?: unknown }
  if (b.type !== 'tool_use') return null
  if (b.name !== TASK_CREATE && b.name !== TASK_UPDATE) return null
  return typeof b.id === 'string' ? b.id : null
}
```

`server/session-pump.ts` 四处:

1. `:766` 旁新增 `const pendingTaskToolUses = new Set<string>()`;
2. assistant 扫描循环(`:919` 旁)追加:

```ts
            const taskToolId = taskToolUseId(block)
            if (taskToolId) pendingTaskToolUses.add(taskToolId)
```

3. user 帧 `toolResultIds` 循环(`:943-947`)内追加:

```ts
            if (pendingTaskToolUses.has(id)) {
              pendingTaskToolUses.delete(id)
              deps.onTaskListChanged?.(session.id)
            }
```

4. echo-drop 分支(`:890` 旁,`deps.onPromptEcho?.(...)` 之后、`log.debug` 之前)追加:

```ts
          // A genuine top-level user message just landed — the stale
          // boundary moved, so the snapshot's precomputed flags refresh.
          deps.onTaskListChanged?.(session.id)
```

`PumpDeps`(`:667` 旁,与 `onBackgroundSubagentLaunched` 同风格):

```ts
  /** Task* tool_result landed / genuine user message landed — rederive and
   *  broadcast the tasklist snapshot. Optional so test fixtures can omit it. */
  onTaskListChanged?: (sessionId: string) => void
```

导入:`import { taskToolUseId } from '../shared/task-list.js'`。

`server/session-types.ts`:`gitStatusSubscribers`(`:589`)旁加字段:

```ts
  /** Per-subscriber pushables for `tasklist-snapshot` frames (full derived
   *  TaskCreate/TaskUpdate fold). Mirrors gitStatusSubscribers. */
  tasklistSubscribers: Set<Pushable<unknown>>
```

`:763` 旁的 `endAndClear` 区加 `endAndClear(s.tasklistSubscribers)`。`server/session-manager.ts:2613` 旁加 `tasklistSubscribers: new Set(),`。

- [ ] **Step 4: 跑 pump 测试确认全绿(含既有用例——新字段是可选的,现有装置不应破坏)**

Run: `npx vitest run server/session-pump.test.ts server/permission-broker.test.ts server/subagent-watcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/task-list.ts server/session-pump.ts server/session-types.ts server/session-manager.ts server/session-pump.test.ts
git commit -m "feat: pump fires onTaskListChanged on Task* tool_result and genuine user input"
```

---

### Task 4: WS 通道 — `tasklist-snapshot` 帧 + broadcaster 播种 + frame-bridge 接线

**Files:**
- Modify: `shared/ws-protocol.ts:308` 附近(新接口)、`:553`(帧联合)
- Modify: `server/ws-protocol.ts:44`(re-export 列表)
- Modify: `server/session-broadcaster.ts`(仿 git 三件套)
- Modify: `server/frame-bridge.ts`(订阅 + 迭代 + 分发,六处)
- Modify: `server/session-types.ts:932` 附近(`SessionBroadcaster` 接口两方法)
- Modify: `server/session-manager.ts:5646` 附近(代理方法)、PumpDeps 构造处(接 `onTaskListChanged`)
- Modify: `server/frame-bridge.test.ts:243`(fixture 补方法)
- Test: `server/session-broadcaster.test.ts`(新 describe)

**Interfaces:**
- Consumes: Task 2 的 `deriveTaskListForSession`;Task 3 的 `Session.tasklistSubscribers`。
- Produces:`WsTasklistSnapshot { kind: 'tasklist-snapshot'; sessionId: string; rev: number; tasks: TasklistSnapshotTask[] }`;`SessionEventBroadcaster.subscribeTaskList(id)` / `broadcastTaskListChanged(id)`;`SessionManager` 代理同名 + `tasklistSnapshot(id): Promise<TasklistSnapshotPayload>`(Task 5 用)。

- [ ] **Step 1: 写失败测试(session-broadcaster.test.ts 追加;mock derive)**

```ts
vi.mock('./tasklist-state.js', () => ({
  deriveTaskListForSession: vi.fn(async () => ({ rev: 2, tasks: [{ id: '1', subject: 'S', status: 'in_progress', stale: false }] })),
}))
import { deriveTaskListForSession } from './tasklist-state.js'

describe('SessionEventBroadcaster tasklist-snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('broadcast derives once and pushes the frame to the session subscribers', async () => {
    const s = makeSession('a', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', s]]))
    // makeSession 需补 tasklistSubscribers: new Set()(本 describe 内扩展本地工厂)
    const sub = bc.subscribeTaskList('a')!
    const p = sub.iterable[Symbol.asyncIterator]().next()
    bc.broadcastTaskListChanged('a')
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalledWith('a'))
    const frame = (await Promise.race([p, timeout(500)])) as { value: { kind: string; rev: number } }
    expect(frame.value.kind).toBe('tasklist-snapshot')
    expect(frame.value.rev).toBe(2)
  })

  it('seeds a fresh subscriber with the last frame (subscribe-after-broadcast)', async () => {
    const s = makeSession('a', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', s]]))
    bc.broadcastTaskListChanged('a')
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalled())
    const sub = bc.subscribeTaskList('a')!
    const first = await sub.iterable[Symbol.asyncIterator]().next()
    expect((first.value as { kind: string }).kind).toBe('tasklist-snapshot')
  })

  it('returns null for an unknown session', () => {
    const bc = new SessionEventBroadcaster(new Map())
    expect(bc.subscribeTaskList('nope')).toBeNull()
  })

  it('prunes the seed map when the session is removed', async () => {
    const s = makeSession('a', '/repo')
    const sessions = new Map([['a', s]])
    const bc = new SessionEventBroadcaster(sessions)
    bc.broadcastTaskListChanged('a')
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalled())
    sessions.delete('a')
    bc.broadcastTaskListChanged('a') // prune runs inside emit
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalledTimes(2))
    // 无断言崩溃即通过(内部 Map 已剪枝;类型上私有,行为由下一用例钉)
  })

  it('re-seeding after prune derives fresh (no stale resurrection)', async () => {
    // 同上装置;删除 session 后重新加入,subscribe 的种子来自**新的** derive 而非旧帧
    // (执行:重新 put 新 session → broadcast → subscribe → 断言 rev 来自当前 mock)
  })
})
```

(`makeSession` 工厂在本文件 `:18`;为 tasklist 用例本地扩展一个带 `tasklistSubscribers` 的变体,或直接给原工厂加字段——加字段更省,existing 用例不受影响。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-broadcaster.test.ts -t "tasklist"`
Expected: FAIL(`subscribeTaskList` 不存在)

- [ ] **Step 3: 实现**

`shared/ws-protocol.ts`(`WsGitSnapshot` 之后):

```ts
/** Full derived TaskCreate/TaskUpdate checklist snapshot for one session,
 *  pushed when a Task* tool_result lands or a genuine user message moves
 *  the stale boundary. The payload IS the state (transcript-derived) —
 *  idempotent and droppable; a lost frame self-heals on the next trigger.
 *  `rev` counts folded Task* events (monotone per session); clients drop
 *  regressing frames. Seeded to fresh subscribers. */
export interface WsTasklistSnapshot {
  kind: 'tasklist-snapshot'
  sessionId: string
  rev: number
  tasks: import('./task-list.js').TasklistSnapshotTask[]
}
```

帧联合(`:553` 的 `| WsGitSnapshot` 之后)加 `| WsTasklistSnapshot`。`server/ws-protocol.ts:44` 的 re-export 列表加 `WsTasklistSnapshot`。

`server/session-broadcaster.ts`(git 三件套逐镜像,import 加 `deriveTaskListForSession`、`WsTasklistSnapshot` 与 `metrics`;log scope 沿用本文件已有的 `'git-snapshot'`?**不**——git 块的 logger 是模块级 `const log = createLogger('git-snapshot')`;新增自己的 `const tlog = createLogger('tasklist')` 放在类外):

```ts
  // --- tasklist snapshot channel (mirrors git-snapshot) ----------------

  /** Most recent pushed snapshot per session id — seeds fresh subscribers.
   *  Keyed by session id (no group fan-out: the fold is per-transcript).
   *  Pruned like gitSnapshots. */
  private tasklistSnapshots = new Map<string, WsTasklistSnapshot>()

  subscribeTaskList(id: string): { iterable: AsyncIterable<WsTasklistSnapshot>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const cached = this.tasklistSnapshots.get(id)
    return this.subscribePushableSet<WsTasklistSnapshot>(
      s, s.tasklistSubscribers as Set<Pushable<WsTasklistSnapshot>>, 'tasklist', 5,
      () => (cached ? [cached] : []),
    )
  }

  /** Fire-and-forget: derive from the transcript and push. Deliberately NO
   *  rev-equality skip — a genuine user message moves the stale boundary
   *  WITHOUT adding Task* events (equal rev, different flags). */
  broadcastTaskListChanged(id: string): void {
    void this.emitTasklistSnapshot(id).catch((err: unknown) => {
      tlog.warn(`tasklist snapshot derive failed session=${id}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private async emitTasklistSnapshot(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    const payload = await deriveTaskListForSession(id)
    metrics.count('tasklist_broadcast_total')
    const frame: WsTasklistSnapshot = { kind: 'tasklist-snapshot', sessionId: id, rev: payload.rev, tasks: payload.tasks }
    this.tasklistSnapshots.set(id, frame)
    this.pruneTasklistSnapshots()
    for (const sub of s.tasklistSubscribers) {
      try { sub.push(frame) } catch { /* subscriber dead — skip */ }
    }
  }

  private pruneTasklistSnapshots(): void {
    if (this.tasklistSnapshots.size === 0) return
    for (const k of this.tasklistSnapshots.keys()) {
      if (!this.sessions.has(k)) this.tasklistSnapshots.delete(k)
    }
  }
```

`server/session-types.ts` `SessionBroadcaster` 接口(`:932` 的 subscribeGitStatus 之后):

```ts
  subscribeTaskList(sessionId: string): { iterable: AsyncIterable<import('./ws-protocol.js').WsTasklistSnapshot>; unsubscribe: () => void } | null
  /** Derive + push the tasklist snapshot (pump trigger + future call sites). */
  broadcastTaskListChanged(sessionId: string): void
```

`server/session-manager.ts` 代理(`:5647` 之后):

```ts
  subscribeTaskList(id: string): { iterable: AsyncIterable<import('./ws-protocol.js').WsTasklistSnapshot>; unsubscribe: () => void } | null {
    return this.broadcaster.subscribeTaskList(id)
  }

  broadcastTaskListChanged(id: string): void {
    this.broadcaster.broadcastTaskListChanged(id)
  }
```

PumpDeps 构造处(搜 `onBackgroundSubagentLaunched:` 的实参对象)加:

```ts
      onTaskListChanged: (id) => this.broadcaster.broadcastTaskListChanged(id),
```

`server/frame-bridge.ts` 六处(逐镜像 taskSub):

1. `:547` 旁:`let tasklistIter: AsyncIterator<unknown> | null = null`(及其 sub 变量 `tasklistSub`);
2. `:635` 之后订阅:
```ts
      step = 'subscribeTaskList'
      tasklistSub = this.sm.subscribeTaskList(sessionId)
      tasklistIter = tasklistSub?.iterable[Symbol.asyncIterator]() ?? null
```
3. `:699` cleanup 数组加 `tasklistIter`、`:704` unsubscribe 数组加 `tasklistSub`;
4. `:727` Tagged 联合加 `| { kind: 'tasklist'; result: IteratorResult<unknown> }`;
5. `:751` channels 加 `...(tasklistIter ? [{ kind: 'tasklist' as const, iter: tasklistIter, promise: tag('tasklist', tasklistIter) }] : [])`;
6. `:866` `case 'task':` 之后:
```ts
              case 'tasklist':
                // Complete frame from the broadcaster (seed frames ride the
                // same path). Forward verbatim.
                this.sink.send(winner.result.value as WsTasklistSnapshot)
                break
```
(import 加 `WsTasklistSnapshot`。)

`server/frame-bridge.test.ts:243` 的 fixture 对象补 `subscribeTaskList() { return null }`。

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run server/session-broadcaster.test.ts server/frame-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-protocol.ts server/session-broadcaster.ts server/frame-bridge.ts server/frame-bridge.test.ts server/session-types.ts server/session-manager.ts server/session-broadcaster.test.ts
git commit -m "feat: tasklist-snapshot WS channel (derive on trigger, seed on subscribe)"
```

---

### Task 5: REST — `GET /sessions/:id/tasklist`

**Files:**
- Modify: `server/session-manager.ts`(代理方法区,`subscribeTaskList` 旁)
- Modify: `server/routes/sessions.ts`(`:917` file-snapshots 路由之后)
- Test: `server/routes/sessions-tasklist.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `deriveTaskListForSession`;`sm.get(id)`(HttpError 404 语义,已存在)。
- Produces:REST `GET /sessions/:id/tasklist` → `TasklistSnapshotPayload`。

- [ ] **Step 1: 写失败测试(镜像 `server/routes/sessions-snapshot.test.ts` 的 makeApp 装置)**

```ts
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildSessionRouter } from './sessions.js'
import { HttpError, createErrorHandler } from '../errors.js'
import type { SessionManager } from '../session-manager.js'

function makeApp(overrides: { tasklistSnapshot?: (id: string) => unknown } = {}) {
  const sm = {
    tasklistSnapshot: vi.fn(async (id: string) => {
      if (overrides.tasklistSnapshot) return overrides.tasklistSnapshot(id)
      return { rev: 1, tasks: [] }
    }),
  }
  const app = new Hono()
  app.onError(createErrorHandler('[sessions-tasklist-test]'))
  app.route('/', buildSessionRouter(sm as unknown as SessionManager))
  return { app, sm }
}

describe('GET /sessions/:id/tasklist', () => {
  it('returns the derived payload', async () => {
    const { app, sm } = makeApp({ tasklistSnapshot: () => ({ rev: 2, tasks: [{ id: '1', subject: 'S', status: 'pending', stale: false }] }) })
    const res = await app.request('/sessions/s1/tasklist')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rev: 2, tasks: [{ id: '1', subject: 'S', status: 'pending', stale: false }] })
    expect(sm.tasklistSnapshot).toHaveBeenCalledWith('s1')
  })

  it('404 for an unknown session (sm.get throws)', async () => {
    const { app } = makeApp({ tasklistSnapshot: () => { throw new HttpError(404, 'session X not found') } })
    const res = await app.request('/sessions/X/tasklist')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/routes/sessions-tasklist.test.ts`
Expected: FAIL(路由 404 不存在 / sm.tasklistSnapshot 未被调)

- [ ] **Step 3: 实现**

manager 代理方法(`subscribeTaskList` 之后;顶部 import `deriveTaskListForSession`):

```ts
  /** REST derive of the tasklist snapshot. 404 for unknown sessions
   *  (get throws); derive itself never throws (empty payload on failure). */
  async tasklistSnapshot(id: string): Promise<import('../shared/task-list.js').TasklistSnapshotPayload> {
    this.get(id)
    return deriveTaskListForSession(id)
  }
```

route(`server/routes/sessions.ts:917` 之后):

```ts
  // Derived TaskCreate/TaskUpdate checklist state from the full transcript.
  // Does NOT require a live Query — reads the (cached) transcript like
  // file-snapshots does. Payload = TasklistSnapshotPayload (shared).
  app.get('/sessions/:id/tasklist', async (c) => {
    return c.json(await sm.tasklistSnapshot(c.req.param('id')))
  })
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run server/routes/sessions-tasklist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/session-manager.ts server/routes/sessions.ts server/routes/sessions-tasklist.test.ts
git commit -m "feat: GET /sessions/:id/tasklist REST derive"
```

---

### Task 6: 客户端 `useTaskList` hook( sink 模式)+ ws-types 别名

**Files:**
- Modify: `src/ws-types.ts:40`(re-export 列表加 `WsTasklistSnapshot`)
- Create: `src/hooks/useTaskList.ts`
- Test: `src/hooks/useTaskList.test.ts`(jsdom,经 `src/**` 默认 happy-dom)

**Interfaces:**
- Consumes: `useWsHub`(subscribe/addSessionListener,同 `useGitStatus.ts:45-66` 的用法)、`api.get`。
- Produces:`useTaskList(sessionId: string | undefined): TasklistSnapshotPayload | null`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { TasklistSnapshotPayload } from '../../shared/task-list'

const listeners = new Map<string, (frame: { kind: string }) => void>()
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({
    subscribe: vi.fn(() => () => {}),
    addSessionListener: vi.fn((sid: string, fn: (frame: { kind: string }) => void) => {
      listeners.set(sid, fn)
      return () => listeners.delete(sid)
    }),
  }),
}))
const getMock = vi.fn()
vi.mock('./useApi', () => ({ api: { get: (...a: unknown[]) => getMock(...a) } }))

import { useTaskList } from './useTaskList'

const payload = (rev: number): TasklistSnapshotPayload => ({
  rev,
  tasks: [{ id: '1', subject: 'S', status: 'in_progress', stale: false }],
})

beforeEach(() => { listeners.clear(); getMock.mockReset() })

it('fetches once on mount and exposes the payload', async () => {
  getMock.mockResolvedValue(payload(1))
  const { result } = renderHook(() => useTaskList('s1'))
  await waitFor(() => expect(result.current?.rev).toBe(1))
})

it('replaces state from WS frames; drops rev regressions', async () => {
  getMock.mockResolvedValue(payload(3))
  const { result } = renderHook(() => useTaskList('s1'))
  await waitFor(() => expect(result.current?.rev).toBe(3))
  const fn = listeners.get('s1')!
  await act(async () => { fn({ kind: 'tasklist-snapshot', sessionId: 's1', rev: 2, tasks: [] }) })
  expect(result.current?.rev).toBe(3) // regression dropped
  await act(async () => { fn({ kind: 'tasklist-snapshot', sessionId: 's1', rev: 4, tasks: [] }) })
  expect(result.current?.rev).toBe(4)
  await act(async () => { fn({ kind: 'git-snapshot' }) })
  expect(result.current?.rev).toBe(4) // other frame kinds ignored
})

it('degrades to null when the fetch fails (window-only fold downstream)', async () => {
  getMock.mockRejectedValue(new Error('500'))
  const { result } = renderHook(() => useTaskList('s1'))
  await waitFor(() => expect(getMock).toHaveBeenCalled())
  expect(result.current).toBeNull()
})

it('no-op when sessionId is undefined', () => {
  renderHook(() => useTaskList(undefined))
  expect(getMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/hooks/useTaskList.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `src/hooks/useTaskList.ts`**

```ts
// Tasklist-snapshot sink — the client half of the server-derived TaskCreate/
// TaskUpdate fold. Mirrors useGitStatus: fetch once on mount for ground
// truth, then apply `tasklist-snapshot` WS frames directly (zero refetch).
// Consumers merge the payload UNDER their window fold via
// shared/task-list.ts#mergeTaskList; a null result (fetch failed / no
// session) degrades to today's window-only behavior.

import { useEffect, useState } from 'react'
import { api } from './useApi'
import { useWsHub } from './useWsHub'
import type { TasklistSnapshotPayload } from '../../shared/task-list'

export function useTaskList(sessionId: string | undefined): TasklistSnapshotPayload | null {
  const hub = useWsHub()
  const [data, setData] = useState<TasklistSnapshotPayload | null>(null)

  useEffect(() => {
    if (!sessionId) return
    const ctrl = new AbortController()
    api
      .get<TasklistSnapshotPayload>(`/sessions/${sessionId}/tasklist`, { signal: ctrl.signal })
      .then((res) => { if (!ctrl.signal.aborted) setData(res) })
      .catch(() => { /* degrade to window-only fold; the WS channel may still deliver */ })
    return () => ctrl.abort()
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    const offSub = hub.subscribe(sessionId)
    const offListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind !== 'tasklist-snapshot') return
      const f = frame as { kind: 'tasklist-snapshot'; rev: number; tasks: TasklistSnapshotPayload['tasks'] }
      setData((prev) => {
        if (prev && f.rev < prev.rev) return prev // stale frame — drop
        return { rev: f.rev, tasks: f.tasks }
      })
    })
    return () => { offSub(); offListener() }
  }, [sessionId, hub])

  return data
}
```

`src/ws-types.ts:40` 的 re-export 列表加 `WsTasklistSnapshot`。

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run src/hooks/useTaskList.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTaskList.ts src/hooks/useTaskList.test.ts src/ws-types.ts
git commit -m "feat: useTaskList sink hook (mount fetch + WS replace, rev regression guard)"
```

---

### Task 7: 消费接线 — Chat → MessageList 合并 + TodoChecklist

**Files:**
- Modify: `src/components/Chat.tsx`(hook 调用 + 两处 props,`:1919` TodoChecklist、`:2180` MessageList)
- Modify: `src/components/MessageList.tsx:1279-1292`(合并 map)+ props 接口
- Modify: `src/components/TodoChecklist.tsx`(props + `extractTodos`/`extractFromTaskEvents` + 清理规则)
- Test: `src/components/TodoChecklist.test.tsx`(追加)、`src/components/MessageList.test.tsx`(追加)

**Interfaces:**
- Consumes: Task 6 的 `useTaskList`;Task 1 的 `mergeTaskList`。
- Produces:`MessageList` 新 prop `tasklist?: TasklistSnapshotPayload | null`;`TodoChecklist` 新 prop `serverTasks?: TasklistSnapshotPayload | null`。

- [ ] **Step 1: 写失败测试(TodoChecklist.test.tsx 追加;复用该文件现有 render 装置与消息构造 helper)**

```ts
it('shows real subjects for stub-window tasks via serverTasks (the bug fix)', async () => {
  // 窗口里只有 TaskUpdate(create 在窗口外)→ 现状渲染 stub
  const messages = [
    assistant([update('9', { status: 'in_progress' })]),
  ]
  const serverTasks = {
    rev: 2,
    tasks: [{ id: '9', subject: '真实标题', status: 'in_progress', stale: false }],
  }
  render(<TodoChecklist messages={messages as never} serverTasks={serverTasks} sessionId="s1" />)
  expect(screen.getByText('真实标题')).toBeTruthy()
  expect(screen.queryByText('Task #9')).toBeNull()
})

it('window fold wins over serverTasks for ids present in the window', () => {
  const messages = [
    assistant([create('c1', '窗口内标题')]),
    toolResultMsg('c1', 'Task #1 created successfully: 窗口内标题'),
  ]
  const serverTasks = { rev: 1, tasks: [{ id: '1', subject: '快照标题', status: 'pending', stale: false }] }
  render(<TodoChecklist messages={messages as never} serverTasks={serverTasks} sessionId="s1" />)
  expect(screen.getByText('窗口内标题')).toBeTruthy()
})

it('drops stale+resolved snapshot-only entries (server-precomputed)', () => {
  const messages: unknown[] = []
  const serverTasks = { rev: 3, tasks: [
    { id: '2', subject: '上一轮已完成', status: 'completed', stale: true },
    { id: '3', subject: '上一轮进行中', status: 'in_progress', stale: false },
  ] }
  render(<TodoChecklist messages={messages as never} serverTasks={serverTasks} sessionId="s1" />)
  expect(screen.queryByText('上一轮已完成')).toBeNull()
  expect(screen.getByText('上一轮进行中')).toBeTruthy()
})
```

(helper 名以现有测试文件为准——它已有等价的 assistant/toolResult 构造器与 render 包装;沿用,勿新造。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/TodoChecklist.test.tsx`
Expected: FAIL(新 prop 未消费,stub 标题仍渲染)

- [ ] **Step 3: 实现 TodoChecklist**

props(`:50` 的 `Props`):

```ts
  /** Server-derived full-transcript fold (useTaskList). Base layer merged
   *  UNDER the window fold — window entries win per id. null/undefined =
   *  degrade to window-only (pre-snapshot behavior). */
  serverTasks?: TasklistSnapshotPayload | null
```

`extractTodos`(`:375`)签名加参并改 task 分支:

```ts
function extractTodos(messages: SdkMessage[], working: boolean, serverTasks: TasklistSnapshotPayload | null | undefined): ExtractResult | null {
  const tw = extractLatestTodos(messages, working)
  const tkTodos = extractFromTaskEvents(messages, serverTasks)
  if (tw && tw.todos.length > 0 && (!tkTodos || tw.lastIndex > lastTaskEventIndex(messages))) {
    return { todos: tw.todos, source: 'todowrite' }
  }
  if (tkTodos && tkTodos.length > 0) return { todos: tkTodos, source: 'task' }
  return null
}
```

`extractFromTaskEvents`(`:483`)改为合并 + 双规则清理:

```ts
function extractFromTaskEvents(messages: SdkMessage[], serverTasks: TasklistSnapshotPayload | null | undefined): Todo[] | null {
  const windowTasks = buildTaskStateMap(messages)
  const merged = mergeTaskList(serverTasks, windowTasks)
  if (merged.size === 0) return null

  const lastUserInputIdx = lastUserInputIndex(messages)
  const out: Todo[] = []
  for (const t of merged.values()) {
    const resolved = t.status === 'completed' || t.status === 'cancelled'
    // Snapshot entries carry the server's precomputed flag (their
    // lastTouched is a server-side line index — meaningless here);
    // window entries use the window-relative rule as before.
    const stale = t.stale ?? (t.lastTouched < lastUserInputIdx)
    if (resolved && stale) continue
    if (t.provisional && stale) continue
    out.push({
      key: t.id,
      content: t.subject,
      status: t.status === 'cancelled' ? 'completed' : t.status,
      activeForm: t.activeForm,
    })
  }
  return out
}
```

组件内 `useMemo`(`:91`)改:

```ts
  const result = useMemo(() => extractTodos(messages, !!working, serverTasks), [messages, working, serverTasks])
```

imports 改:`buildTaskStateMap` → 从 `'../utils/task-events'`(re-export,不变);加 `mergeTaskList` 同源;`import type { TasklistSnapshotPayload } from '../../shared/task-list'`。

- [ ] **Step 4: 实现 MessageList 合并**

props 接口加 `tasklist?: TasklistSnapshotPayload | null`(注释:server-derived base layer);`MessageList.tsx:1279-1282` 改:

```ts
  // Window fold ⊕ server snapshot: the snapshot supplies creates the window
  // cannot see (beyond the ring/memory cap); window entries win per id.
  // Referential stability via useMemo keyed on both inputs.
  const taskInfoMap = useMemo(
    () => mergeTaskList(tasklist, buildTaskStateMapFromItems(items)),
    [items, tasklist],
  )
```

(删除原 `?? EMPTY_TASK_MAP` 与其哨兵常量若仅此处使用——mergeTaskList 永不返回 null;若 `EMPTY_TASK_MAP` 另有消费处则保留。import 加 `mergeTaskList`。)

- [ ] **Step 5: Chat 接线**

组件体内(`session` 可用处):`const taskList = useTaskList(session.id)`。`:1919` 的 TodoChecklist 加 `serverTasks={taskList}`、`:1933` 的 useMemo deps 数组加 `taskList`。`:2180` 的 MessageList 加 `tasklist={taskList}`。

- [ ] **Step 6: MessageList 集成测试(MessageList.test.tsx 追加,复用现有渲染装置)**

```ts
it('TaskMutationView resolves the subject from the server snapshot while the create is out of window', () => {
  // items 只含一条 TaskUpdate tool_use;tasklist prop 提供 create 时标题
  // 断言:卡片标题渲染快照 subject,而非 `Task #N`
  // (执行者按该文件现有 items 构造 helper 补全;断言 heading 文本)
})
```

- [ ] **Step 7: 跑全部相关测试确认全绿**

Run: `npx vitest run src/components/TodoChecklist.test.tsx src/components/MessageList.test.tsx src/hooks/useTaskList.test.ts src/components/MessageList.test.tsx`
Expected: PASS(既有用例不回归)

- [ ] **Step 8: Commit**

```bash
git add src/components/Chat.tsx src/components/MessageList.tsx src/components/TodoChecklist.tsx src/components/TodoChecklist.test.tsx src/components/MessageList.test.tsx
git commit -m "feat: consume tasklist snapshot in TodoChecklist + TaskInfoProvider (window wins per id)"
```

---

### Task 8: 全量验证 + code-review

**Files:** 无新改动(验证 + 修复轮)

- [ ] **Step 1: 全量类型检查**

Run: `npm run typecheck`
Expected: 两个 tsconfig 均 0 错误

- [ ] **Step 2: 全量测试**

Run: `npm run test`
Expected: 全绿(既有 318+ 文件不回归)

- [ ] **Step 3: lint**

Run: `npm run lint`
Expected: 0 错误

- [ ] **Step 4: code-review(CLAUDE.md 强制:未审查不得收工)**

对整个分支 diff 运行 `code-review` skill;逐条核实 findings;确认的问题修复后**重跑受影响测试**并对修复 diff 再跑一轮 review(修复本身也是未审查变更)。

- [ ] **Step 5: 手工验证(可选但推荐)**

`npm run dev` → 打开本 session(39f6ab75)→ TaskList 应显示真实标题而非 `Task #9/#10`;刷新页面复验(replay 窗口浅,快照应兜底)。

- [ ] **Step 6: 最终提交(若有修复)**

```bash
git add -A
git commit -m "fix: address code-review findings on tasklist snapshot"
```
