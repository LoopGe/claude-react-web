# Subagent async/sync 判定改为 server task 状态权威 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 subagent 的 `isAsync`(async/sync 徽标真值)完全由 server 的 `TaskRecordUi.isBackgrounded` 经 `TASKS_SNAPSHOT` 权威写入;`task_notification` 降级为纯完成信号;修掉「纯前台 sync 被 task_notification 误标 async」的实测 bug。

**Architecture:** server 在 `task_started` 折叠 `is_backgrounded`(true/false)进任务记录并推 snapshot;client 的 `TASKS_SNAPSHOT` join 成为 `isAsync` 唯一写入点(双向、含 terminal);reducer 移除三处用帧猜测 async 的逻辑(seed 种 isAsync / ack 翻状态 / child-after-result 翻 isAsync / task_notification 盖戳),ack 仅保留纯正则防误结算守卫,D2=B 配套 turn-end sweep 保险。

**Tech Stack:** TypeScript, vitest, Hono/WS(reducer + session-pump)。无新依赖、无协议改动。

**Spec:** `docs/superpowers/specs/2026-09-07-subagent-async-server-authority-design.md`

## Global Constraints

- D1=删:`getSubagentStarts` 不再读 `run_in_background` 种 `isAsync`;记录初始 `isAsync: undefined`。
- D2=B:ack 命中 launch-ack 签名**只跳过合并**,不翻 `background`、不设 `isAsync`;`background` 状态只由 TASKS_SNAPSHOT 置位。
- `isAsync` 唯一权威写入点 = TASKS_SNAPSHOT join(双向:true 与 false 都写;live 与 terminal 都写)。
- `task_notification` 分支删除 `isAsync: true`;保留完成 status + endedAt + result-overwrite 护栏。
- turn-end sweep:`running` 记录若 `mirror.tasks` 有非 terminal `isBackgrounded:true` 任务 → `pending`;否则 `interrupted`。
- 工作区当前含探针临时日志(Task 8 移除),改动时不要误删周边逻辑。
- 每任务结束 `npm run typecheck` 通过;reducer/pump 相关测试绿。

## File Structure

- `server/session-pump.ts` — `applyTaskEvent` `task_started` 分支折 `is_backgrounded`。
- `server/session-pump.test.ts` — 新增 2 条 fold 测试。
- `src/session-store/normalize.ts` — `getSubagentStarts` 删 `isAsync` 种子。
- `src/session-store/reducer.ts` — TASKS_SNAPSHOT case、`updateIndexesMirror`(seed/result-merge/child-after/task_notification)、`sweepAtTurnEnd`。
- `src/session-store/types.ts` — `ActiveSubagent.isAsync` 注释。
- `src/session-store/reducer.test.ts` — 新增回归/快照测试;改写受影响用例。
- `src/session-store/debug.ts` — 移除临时 `subagentDebug`(Task 8)。
- `CLAUDE.md` — 任务/子代理 async 判定描述同步(Task 8)。

---

### Task 1: Server 折 `task_started.is_backgrounded`

**Files:**
- Modify: `server/session-pump.ts` — `applyTaskEvent` 的 `task_started` 分支
- Test: `server/session-pump.test.ts` — `describe('applyTaskEvent')`

**Interfaces:**
- Consumes: 已有 `makeTaskSession()`(test 内)、`sysFrame('task_started', {…})`、`applyTaskEvent(session, msg)`。
- Produces: `session.tasks.get(taskId).isBackgrounded === boolean|undefined`(task_started 后即为 true/false)。

- [ ] **Step 1: 写失败测试**

在 `server/session-pump.test.ts` 的 `describe('applyTaskEvent')` 内追加:

```ts
it('task_started folds is_backgrounded (true for async, false for foreground)', () => {
  const { session } = makeTaskSession()
  applyTaskEvent(session, sysFrame('task_started', {
    task_id: 't-bg', tool_use_id: 'tu-bg', description: 'bg agent',
    task_type: 'local_agent', is_backgrounded: true, receivedAt: 1,
  }))
  expect(session.tasks.get('t-bg')).toMatchObject({ taskId: 't-bg', isBackgrounded: true })

  applyTaskEvent(session, sysFrame('task_started', {
    task_id: 't-fg', tool_use_id: 'tu-fg', description: 'fg agent',
    task_type: 'local_agent', is_backgrounded: false, receivedAt: 2,
  }))
  expect(session.tasks.get('t-fg')).toMatchObject({ taskId: 't-fg', isBackgrounded: false })
})

it('task_started leaves isBackgrounded undefined when the frame omits it (older CLIs)', () => {
  const { session } = makeTaskSession()
  applyTaskEvent(session, sysFrame('task_started', {
    task_id: 't-x', description: 'plain', receivedAt: 3,
  }))
  expect(session.tasks.get('t-x')?.isBackgrounded).toBeUndefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-pump.test.ts -t "task_started"`
Expected: FAIL(`isBackgrounded` 断言不满足——当前分支不折该字段)。

- [ ] **Step 3: 实现**

在 `server/session-pump.ts` `applyTaskEvent` 的 `task_started` 分支对象里(`status: 'running',` 之后)插入:

```ts
isBackgrounded: typeof raw.is_backgrounded === 'boolean'
  ? raw.is_backgrounded
  : existing?.isBackgrounded,
```

`raw` 已声明 `is_backgrounded?: unknown`(探针日志曾读取)。upsert 语义由 `...existing` spread 保留旧值。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/session-pump.test.ts -t "task_started"`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/session-pump.ts server/session-pump.test.ts
git commit -m "fix(pump): fold task_started.is_backgrounded so snapshots carry the authoritative async flag"
```

---

### Task 2: Client `TASKS_SNAPSHOT` join 成为 `isAsync` 唯一权威

**Files:**
- Modify: `src/session-store/reducer.ts` — `reduceSessionState` 的 `case 'TASKS_SNAPSHOT'`
- Test: `src/session-store/reducer.test.ts`

**Interfaces:**
- Consumes: `TaskRecordUi` 上 `isBackgrounded?: boolean`;`activeSubagents` 记录含 `isAsync?: boolean`、`status: SubagentStatus`。
- Produces: 每条带 `toolUseId` 的任务记录 → join 写 `isAsync = task.isBackgrounded`(当为布尔);live 非 terminal `isBackgrounded:true` 翻 `running→background`,并把被 detach 文本误结算的 `done` 救回 `background`。

- [ ] **Step 1: 写失败测试**(新 describe,自带 helper)

在 `src/session-store/reducer.test.ts` 追加一个独立 describe(自带 `agentToolUse`/`task`,避免依赖其它 describe 作用域):

```ts
describe('reducer: TASKS_SNAPSHOT is the single authority for isAsync (D1/D2)', () => {
  const agentToolUse = (id: string, uuid: string, input: Record<string, unknown> = {}): SdkMessage => ({
    type: 'assistant', uuid, receivedAt: 0,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'do work', ...input } }] },
  }) as unknown as SdkMessage
  const task = (overrides: Partial<TaskRecordUi> = {}): TaskRecordUi => ({
    taskId: 't-1', description: 'work', status: 'running', updatedAt: 0, ...overrides,
  })
  const snap = (state: SessionState, tasks: TaskRecordUi[]) => reduceSessionState(state, { type: 'TASKS_SNAPSHOT', tasks })

  it('writes isAsync=false from a foreground task record (overrides an existing wrong true)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1', { run_in_background: true }) })
    // 旧值先被 snapshot(后台)置 true……
    state = snap(state, [task({ toolUseId: 'tu_a', isBackgrounded: true })])
    expect(state.mirror.activeSubagents.get('tu_a')?.isAsync).toBe(true)
    // ……再被 server 权威的 false 覆盖(前台)
    state = snap(state, [task({ toolUseId: 'tu_a', isBackgrounded: false })])
    expect(state.mirror.activeSubagents.get('tu_a')?.isAsync).toBe(false)
    expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('background') // 已被翻过的状态不因 false 而回退
  })

  it('writes isAsync from a TERMINAL task record (replay recovery replaces the notification stamp)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1') })
    state = snap(state, [task({ toolUseId: 'tu_a', status: 'completed', isBackgrounded: true })])
    expect(state.mirror.activeSubagents.get('tu_a')).toMatchObject({ status: 'running', isAsync: true })
  })

  it('does NOT flip to background for a foreground (isBackgrounded:false) live record', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1') })
    state = snap(state, [task({ toolUseId: 'tu_a', isBackgrounded: false, status: 'running' })])
    expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('running')
    expect(state.mirror.activeSubagents.get('tu_a')?.isAsync).toBe(false)
  })

  it('writes isAsync=false from a TERMINAL foreground record (no-flag sync, replay)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1') })
    state = snap(state, [task({ toolUseId: 'tu_a', status: 'completed', isBackgrounded: false })])
    expect(state.mirror.activeSubagents.get('tu_a')?.isAsync).toBe(false)
  })
})
```

需要在文件顶部已 import 的类型中确认 `SessionState`/`TaskRecordUi` 可用(同文件其它 describe 已用,直接沿用)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session-store/reducer.test.ts -t "single authority"`
Expected: FAIL——现 join 只在 `isBackgrounded && !isTerminal` 且翻状态时才写 isAsync,且不写 false、不写 terminal。

- [ ] **Step 3: 实现**

在 `reducer.ts` `case 'TASKS_SNAPSHOT'` 内,把 per-task 处理改为(替换原 `const isTerminal…` 至 `activeSubagents.set(...)` 段):

```ts
const isTerminal =
  task.status === 'completed' || task.status === 'failed' ||
  task.status === 'killed' || task.status === 'stopped'
// ★ 权威写入:server 给了布尔就覆盖(双向;live 与 terminal 都写)。
const nextIsAsync = typeof task.isBackgrounded === 'boolean'
  ? task.isBackgrounded
  : record.isAsync
// rescue:Ctrl+B detach ack(非 launch 签名)把记录误结算成 done/带假 result。
const rescueSettled =
  task.isBackgrounded === true && !isTerminal &&
  (record.status === 'done' || record.status === 'interrupted')
const flipToBackground =
  task.isBackgrounded === true && !isTerminal &&
  (record.status === 'running' || rescueSettled)
activeSubagents.set(task.toolUseId, {
  ...record,
  taskId: task.taskId,
  progressSummary: isTerminal ? undefined : task.progressSummary ?? record.progressSummary,
  lastToolName: isTerminal ? undefined : task.lastToolName ?? record.lastToolName,
  isAsync: nextIsAsync,
  ...(flipToBackground
    ? rescueSettled
      ? { status: 'background' as const, endedAt: undefined, result: undefined }
      : { status: 'background' as const }
    : {}),
})
```

外层「无任何匹配则返回原引用」的 identity 逻辑保持现状不动(现有实现即「匹配即 clone + set」;同值重复 set 的既有行为不回退,不在本任务优化)。

- [ ] **Step 4: 跑新测试 + 既有 TASKS_SNAPSHOT 测试**

Run: `npx vitest run src/session-store/reducer.test.ts -t "TASKS_SNAPSHOT"`
Expected: 新测试 + 既有 `reducer: TASKS_SNAPSHOT` describe 全绿(既有用例断言 `isAsync===true` 在翻 background 时仍成立,因为 `nextIsAsync=true`)。

- [ ] **Step 5: Commit**

```bash
git add src/session-store/reducer.ts src/session-store/reducer.test.ts
git commit -m "fix(reducer): TASKS_SNAPSHOT join is the single authority for subagent isAsync"
```

---

### Task 3: `task_notification` 只做完成信号(删 `isAsync:true`)+ 核心回归

**Files:**
- Modify: `src/session-store/reducer.ts` — `updateIndexesMirror` 的 task_notification 完成分支
- Test: `src/session-store/reducer.test.ts`

**Interfaces:**
- Consumes: `parseTaskNotification(message)`;`activeSubagents` 记录;`mirror`。
- Produces: 通知到达后记录 `status: done|interrupted`、`endedAt`、按护栏补 `result`;`isAsync` **不再被改动**。

- [ ] **Step 1: 写核心 bug 回归测试**

追加(可用 Task 2 同款 helper,放在同一 describe 或新建):

```ts
describe('reducer: a pure foreground (sync) subagent that also gets a task_notification stays sync (D1/D2 regression)', () => {
  const agentToolUse = (id: string, uuid: string, input: Record<string, unknown> = {}): SdkMessage => ({
    type: 'assistant', uuid, receivedAt: 0,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'sync work', ...input } }] },
  }) as unknown as SdkMessage
  const task = (overrides: Partial<TaskRecordUi> = {}): TaskRecordUi => ({
    taskId: 't-1', description: 'work', status: 'running', updatedAt: 0, ...overrides,
  })
  const notification = (toolUseId: string, at: number): SdkMessage => ({
    type: 'system', subtype: 'task_notification', uuid: `n-${toolUseId}`, task_id: 't-1',
    tool_use_id: toolUseId, status: 'completed', summary: 'SYNCPROBE_DONE', output_file: '/tmp/x', receivedAt: at,
  }) as unknown as SdkMessage

  it('keeps isAsync=false when a foreground sync subagent receives its completion notification', () => {
    let state = createInitialSessionState('s1')
    // 实测帧序列:tool_use(run_in_background:false)→ snapshot(isBackgrounded:false)→ 真实输出 tool_result → task_notification
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_sync', 'a1', { run_in_background: false }) })
    state = reduceSessionState(state, { type: 'TASKS_SNAPSHOT', tasks: [task({ toolUseId: 'tu_sync', isBackgrounded: false })] })
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: { type: 'user', uuid: 'u1', receivedAt: 10, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_sync', content: 'SYNCPROBE_DONE', is_error: false }] } } as unknown as SdkMessage,
    })
    expect(state.mirror.activeSubagents.get('tu_sync')).toMatchObject({ status: 'done', isAsync: false })
    // task_notification 只应完成,不应把 sync 改成 async
    state = reduceSessionState(state, { type: 'MESSAGE', message: notification('tu_sync', 20) })
    expect(state.mirror.activeSubagents.get('tu_sync')).toMatchObject({ status: 'done', isAsync: false })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session-store/reducer.test.ts -t "stays sync"`
Expected: FAIL——现分支无条件盖 `isAsync:true`,通知后 `isAsync` 变 true。

- [ ] **Step 3: 实现**

在 `updateIndexesMirror` 的 task_notification 完成分支 `activeSubagents.set(...)` 对象里:**删除 `isAsync: true,` 一行**(连同其上的「stamp isAsync definitively」注释)。分支上方的大段注释改为:通知是所有 task(含前台)的完成信号,async 真值由 TASKS_SNAPSHOT 写入。

- [ ] **Step 4: 修既有受影响的用例**

Run: `npx vitest run src/session-store/reducer.test.ts`
Expected: 下列用例 FAIL。逐一改为「先喂一张 `isBackgrounded:true` 的 snapshot 再断言」:

- `flips a background subagent to done via the SDK system/task_notification frame`(~:421)——在通知前(或断言前)插入 `TASKS_SNAPSHOT [task({ toolUseId, isBackgrounded: true })]`,使记录成为 `background` 且 `isAsync:true`,通知后断言 `done` + `isAsync:true`。
- `a late task_notification flips a pending (swept) background subagent to done`(~:590)——同理:建立 `background`(经 snapshot)并 `sweep` 成 `pending` 后,通知 → `done`,喂 terminal snapshot 使 `isAsync:true`。
- 其它在通知后断言 `isAsync:true` 的用例(`reducer: a task_notification for ONE async agent…`、`does NOT sweep a background subagent that already completed via task_notification`、`replay ordering — backgrounded subagent survives refresh` 等)——replay-ordering 那条已有 terminal snapshot(Task 2 后靠它写 true),无需改。

- [ ] **Step 5: 跑全部 reducer 测试 + typecheck**

Run: `npx vitest run src/session-store/reducer.test.ts && npm run typecheck`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/session-store/reducer.ts src/session-store/reducer.test.ts
git commit -m "fix(reducer): task_notification completes only — stop stamping sync subagents async"
```

---

### Task 4: ack 守卫 D2=B(只跳过合并)

**Files:**
- Modify: `src/session-store/reducer.ts` — `updateIndexesMirror` 的 result-merge 分支
- Test: `src/session-store/reducer.test.ts`

**Interfaces:**
- Consumes: tool_result 块(`content` 文本);`activeSubagents` 记录。
- Produces: 命中 launch-ack 签名的 tool_result **不改写记录**(保持 `running`);未命中按原逻辑结算 done/interrupted。

- [ ] **Step 1: 写失败测试**

```ts
it('launch-ack tool_result is skipped entirely (D2-B): record stays running, no isAsync, no result', () => {
  let state = createInitialSessionState('s1')
  state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1') })
  expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('running')
  state = reduceSessionState(state, {
    type: 'MESSAGE',
    message: { type: 'user', uuid: 'u1', receivedAt: 5, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'Async agent launched successfully. (internal metadata.)\nagentId: ace1f1c484c82bcdf', is_error: false }] } } as unknown as SdkMessage,
  })
  expect(state.mirror.activeSubagents.get('tu_a')).toMatchObject({ status: 'running', isAsync: undefined })
  expect(state.mirror.activeSubagents.get('tu_a')?.result).toBeUndefined()
  // 随后 snapshot 才把 async 记录翻 background
  state = reduceSessionState(state, { type: 'TASKS_SNAPSHOT', tasks: [task({ toolUseId: 'tu_a', isBackgrounded: true })] })
  expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('background')
  expect(state.mirror.activeSubagents.get('tu_a')?.isAsync).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session-store/reducer.test.ts -t "D2-B"`
Expected: FAIL——现 ack 命中翻 `background`,不是保持 `running`。

- [ ] **Step 3: 实现**

result-merge 循环改为命中 ack 时 `continue`(把克隆动作移到 ack 判定之后,避免无谓克隆):

```ts
for (const { toolUseId, content, isError } of subagentResultEntries) {
  const existing = activeSubagents.get(toolUseId)
  if (!existing || existing.status !== 'running') continue
  const ackText = typeof content === 'string' ? content : resultContentToText(content)
  // D2-B launch-ack 守卫(纯正则,D1 后无 seed 免疫):ack 不是真实输出,
  // 不结算、不存 result;状态保持 running,由 TASKS_SNAPSHOT 翻 background。
  const isAck = !isError && typeof ackText === 'string' &&
    /^async agent launched successfully/i.test(ackText)
  if (isAck) continue
  if (!touched) {
    if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
    touched = true
  }
  activeSubagents.set(toolUseId, {
    ...existing,
    status: isError ? 'interrupted' : 'done',
    endedAt: stamp,
    result: { content, isError },
  })
}
```

- [ ] **Step 4: 修既有受影响的用例**

Run: `npx vitest run src/session-store/reducer.test.ts`
Expected: 原依赖「ack→background」的用例 FAIL。逐一改为:ack 后先喂 `TASKS_SNAPSHOT [task({ toolUseId, isBackgrounded: true })]` 再断言 `background`。涉及:Task 3 中改过但 setup 用 ack 建立 background 的用例(如 `flips a background subagent to done via…`)、`does NOT sweep a background subagent that already completed via task_notification`、`reducer: a task_notification for ONE async agent…`、rescue 相关(Task 2 describe 内 `marks a rescued record isAsync:true too` 用的 detach 文本 `'running in the background'` **不是** launch 签名,不受影响)。

- [ ] **Step 5: 跑全部 reducer 测试 + typecheck**

Run: `npx vitest run src/session-store/reducer.test.ts && npm run typecheck`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/session-store/reducer.ts src/session-store/reducer.test.ts
git commit -m "fix(reducer): launch-ack tool_result is skipped, not settled (D2-B)"
```

---

### Task 5: child-after-result 删 `isAsync` 翻转

**Files:**
- Modify: `src/session-store/reducer.ts` — `updateIndexesMirror` 的 child-after-result 分支
- Test: `src/session-store/reducer.test.ts`

**Interfaces:**
- Consumes: 子帧(`message.parent_tool_use_id`)。
- Produces: 对 live(`running|background|pending`)记录推进 `endedAt`;**不再写 `isAsync`**。

- [ ] **Step 1: 写失败测试**

```ts
it('child frames after an ack no longer flip isAsync (only TASKS_SNAPSHOT does)', () => {
  let state = createInitialSessionState('s1')
  state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1') })
  // 经 snapshot 确认 async(background)后,子帧只推进 endedAt
  state = reduceSessionState(state, { type: 'TASKS_SNAPSHOT', tasks: [task({ toolUseId: 'tu_a', isBackgrounded: true })] })
  state = reduceSessionState(state, {
    type: 'MESSAGE',
    message: { type: 'assistant', uuid: 'c1', parent_tool_use_id: 'tu_a', receivedAt: 100, message: { role: 'assistant', content: [{ type: 'text', text: 'working…' }] } } as unknown as SdkMessage,
  })
  expect(state.mirror.activeSubagents.get('tu_a')).toMatchObject({ status: 'background', isAsync: true, endedAt: 100 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session-store/reducer.test.ts -t "no longer flip isAsync"`
Expected: 该用例当前应已通过(snapshot 已置 true)…… 真正要断言的失败场景是**无 snapshot、纯靠子帧**时不得置 true。改成下面这个失败版(替代上面 Step 1 的用例):

```ts
it('child frames alone (no TASKS_SNAPSHOT) do NOT set isAsync', () => {
  let state = createInitialSessionState('s1')
  state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1') })
  state = reduceSessionState(state, {
    type: 'MESSAGE',
    message: { type: 'user', uuid: 'u1', receivedAt: 5, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'Async agent launched successfully.\nagentId: xyz', is_error: false }] } } as unknown as SdkMessage,
  })
  // D2-B:ack 被跳过,记录仍是 running
  expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('running')
  state = reduceSessionState(state, {
    type: 'MESSAGE',
    message: { type: 'assistant', uuid: 'c1', parent_tool_use_id: 'tu_a', receivedAt: 100, message: { role: 'assistant', content: [{ type: 'text', text: 'working…' }] } } as unknown as SdkMessage,
  })
  // 没有 snapshot → isAsync 仍 undefined(子帧不翻)
  expect(state.mirror.activeSubagents.get('tu_a')?.isAsync).toBeUndefined()
})
```

- [ ] **Step 3: 实现**

child-after-result 分支(在 `updateIndexesMirror` 内、`parentId` 查找之后)把:

```ts
const nowAsync = existing.isAsync === true ? true
  : existing.status === 'background' || existing.status === 'pending'
const endedAtChanged = existing.endedAt == null || stamp > existing.endedAt
const asyncChanged = existing.isAsync !== nowAsync && nowAsync
if (asyncChanged && subagentDebugEnabled()) {
  subagentDebug('child-frame → async (child after result/ack)', { parentId, status: existing.status, prevIsAsync: existing.isAsync })
}
if (endedAtChanged || asyncChanged) {
  if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
  activeSubagents.set(parentId, {
    ...existing,
    ...(endedAtChanged ? { endedAt: stamp } : {}),
    ...(asyncChanged ? { isAsync: true } : {}),
  })
  changed = true
}
```

替换为:

```ts
if (existing.endedAt == null || stamp > existing.endedAt) {
  if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
  activeSubagents.set(parentId, { ...existing, endedAt: stamp })
  changed = true
}
```

同步删掉上方大段注释里「isAsync 由子帧确认/翻转」的说法(改为:子帧只推进计时与捕获,async 真值看 TASKS_SNAPSHOT)。

- [ ] **Step 4: 修既有受影响的用例**

Run: `npx vitest run src/session-store/reducer.test.ts`
Expected: 依赖 child-after-result 置 `isAsync:true` 的用例 FAIL(reducer.test.ts 约 :1377-1423 段的 `child-after-result…isAsync flips to true` 等)。改为:先喂 `TASKS_SNAPSHOT [task({ toolUseId, isBackgrounded: true })]` 再断言 `isAsync:true`,并保留 endedAt 推进断言。

- [ ] **Step 5: 跑全部 reducer 测试 + typecheck**

Run: `npx vitest run src/session-store/reducer.test.ts && npm run typecheck`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/session-store/reducer.ts src/session-store/reducer.test.ts
git commit -m "fix(reducer): child frames no longer infer isAsync — snapshot is the only source"
```

---

### Task 6: seed 不再种 `isAsync`(D1)

**Files:**
- Modify: `src/session-store/normalize.ts` — `getSubagentStarts`
- Test: `src/session-store/reducer.test.ts`(既有 seed 用例)

**Interfaces:**
- Consumes: `ActiveSubagent`(isAsync 现仅由 snapshot 写入)。
- Produces: `getSubagentStarts` 返回对象**不含** `isAsync`(初始 undefined)。

- [ ] **Step 1: 改实现**

`normalize.ts` `getSubagentStarts` 中删除:

```ts
const prompt = typeof input?.prompt === 'string' ? input.prompt : undefined
// Seed sync/async from the explicit flag if the SDK sent one. Frame
// timing in the reducer confirms/overrides this once messages flow.
const isAsync =
  input?.run_in_background === true ? true
  : input?.run_in_background === false ? false
  : undefined
out.push({ toolUseId: id, label, prompt, isAsync, status: 'running', toolCount: 0 })
```

改为:

```ts
const prompt = typeof input?.prompt === 'string' ? input.prompt : undefined
// D1:isAsync 不再由 input flag 种;它是 async/sync 徽标真值,唯一来源是
// server 的 TASKS_SNAPSHOT isBackgrounded(Task 2)。此处留 undefined。
out.push({ toolUseId: id, label, prompt, status: 'running', toolCount: 0 })
```

- [ ] **Step 2: 修既有受影响的用例**

Run: `npx vitest run src/session-store/reducer.test.ts`
Expected: 断言「seed 把 run_in_background 种成 isAsync」的用例 FAIL(reducer.test.ts 约 :1300-1345 `Seeded false from the explicit run_in_background: false flag`、约 :1085-1121 的 `run_in_background:false` orphan 用例等)。处理:
- 若用例目的是「input 带 false 的 sync 记录该标 sync」→ 改为先喂 `TASKS_SNAPSHOT [task({ toolUseId, isBackgrounded: false })]` 再断言 `isAsync:false`。
- 若用例断言「seed 后 isAsync===undefined/false 的中间态」→ 删掉该断言或改在 snapshot 后断言。

- [ ] **Step 3: 跑全部 reducer 测试 + typecheck**

Run: `npx vitest run src/session-store/reducer.test.ts src/session-store/store.test.ts && npm run typecheck`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add src/session-store/normalize.ts src/session-store/reducer.test.ts
git commit -m "fix(normalize): drop run_in_background seeding of isAsync (D1)"
```

---

### Task 7: turn-end sweep 保险(D2=B)

**Files:**
- Modify: `src/session-store/reducer.ts` — `sweepAtTurnEnd`
- Test: `src/session-store/reducer.test.ts`

**Interfaces:**
- Consumes: `mirror.tasks: TaskRecordUi[]`。
- Produces: sweep 时 `running` 记录若命中 `mirror.tasks` 非 terminal `isBackgrounded:true` → `pending`;否则 `interrupted`。

- [ ] **Step 1: 写失败测试**(describe 内自带 helper,复用文件已有的 result 帧形状)

```ts
const result = (uuid: string): SdkMessage =>
  ({ type: 'result', subtype: 'success', uuid, receivedAt: 2_000 }) as unknown as SdkMessage

it('sweep keeps a running record pending when the server tracks it as a live background task', () => {
  let state = createInitialSessionState('s1')
  // snapshot 先到(mirror.tasks 有任务),seed 后到(记录 running)
  state = reduceSessionState(state, { type: 'TASKS_SNAPSHOT', tasks: [task({ toolUseId: 'tu_a', isBackgrounded: true, status: 'running' })] })
  state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1') })
  expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('running')
  // result 帧 → turn-end sweep
  state = reduceSessionState(state, { type: 'MESSAGE', message: result('r1') })
  expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('pending')
})

it('sweep still interrupts a running record with no live background task', () => {
  let state = createInitialSessionState('s1')
  state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1') })
  state = reduceSessionState(state, { type: 'MESSAGE', message: result('r1') })
  expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('interrupted')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session-store/reducer.test.ts -t "sweep keeps a running record pending"`
Expected: FAIL——sweep 现把 `running` 一律 interrupt。

- [ ] **Step 3: 实现**

`sweepAtTurnEnd` 的 subagent 循环前,构建 live 后台 toolUseId 集合:

```ts
// D2-B 保险:ack 不再翻 background,a snapshot 先到/seed 后到的 live 后台
// 任务记录仍可能是 'running';turn-end 不得把它当 sync 孤儿 interrupt。
const liveBgToolUseIds = new Set<string>()
for (const t of mirror.tasks) {
  if (!t.toolUseId) continue
  const term = t.status === 'completed' || t.status === 'failed' ||
    t.status === 'killed' || t.status === 'stopped'
  if (!term && t.isBackgrounded === true) liveBgToolUseIds.add(t.toolUseId)
}
```

循环改为:

```ts
for (const [id, sub] of activeSubagents) {
  if (sub.status === 'running') {
    if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
    const next = liveBgToolUseIds.has(id)
      ? { ...sub, status: 'pending' as const, endedAt: sub.endedAt ?? sub.startedAt }
      : { ...sub, status: 'interrupted' as const, endedAt: sub.endedAt ?? sub.startedAt }
    activeSubagents.set(id, next)
  } else if (sub.status === 'background') {
    if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
    activeSubagents.set(id, { ...sub, status: 'pending', endedAt: sub.endedAt ?? sub.startedAt })
  }
}
```

- [ ] **Step 4: 跑全部 reducer 测试 + typecheck**

Run: `npx vitest run src/session-store/reducer.test.ts && npm run typecheck`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/session-store/reducer.ts src/session-store/reducer.test.ts
git commit -m "fix(reducer): turn-end sweep defers live background tasks to pending (D2-B)"
```

---

### Task 8: 清理临时日志 + 注释/文档对账 + 全量验证

**Files:**
- Modify: `server/session-pump.ts`(删 TEMP DEBUG 日志,保留 Task 1 的 fold)
- Modify: `src/session-store/debug.ts`(删 `subagentDebug`/`subagentDebugEnabled`/SUBAGENT_FLAG_KEY)
- Modify: `src/session-store/reducer.ts`(删 `subagentDebug` import 与全部调用;同步注释)
- Modify: `src/session-store/types.ts`(`ActiveSubagent.isAsync` 注释)
- Modify: `CLAUDE.md`

- [ ] **Step 1: 删 server 临时日志**

`server/session-pump.ts` 删除:Task 1 之前加的 `task_frame` 日志块(`applyTaskEvent` 内 `if (raw.subtype === 'task_progress')…else…` 整段)、`applyBackgroundTasksChanged` 内的 `background_tasks_changed count=…` 日志、pump 主循环的 `async launch ack detected…` 日志。`raw` 类型里的 `is_backgrounded?: unknown` 保留(Task 1 fold 需要)。

- [ ] **Step 2: 删 client 临时日志**

`src/session-store/debug.ts` 删除 `SUBAGENT_FLAG_KEY` 起的 `subagentDebugEnabled`/`subagentDebug` 段。`src/session-store/reducer.ts` 删除 `subagentDebug, subagentDebugEnabled` import,以及各分支里的 `// TEMP DEBUG (subagent async/sync)` 调用块(Task 2-7 的目标代码已不含这些调用,若 Task 2-7 的替换保留了残留,一并删净)。

- [ ] **Step 3: 注释对账**

- `types.ts` `ActiveSubagent.isAsync` docblock → 改为:由 `TASKS_SNAPSHOT` 的 `TaskRecordUi.isBackgrounded` 权威写入;不再由输入 `run_in_background` 或帧时序推断;undefined = snapshot 未送达或任务记录已淘汰。
- `reducer.ts` task_notification 分支上方注释 → 改为准确表述(见 Task 3 Step 3)。
- `normalize.ts` `getSubagentStarts` 注释已由 Task 6 改。
- `CLAUDE.md`「任务/子代理 async 判定」相关段落同步:isAsync 唯一来源是 server task 状态;task_notification 是所有 task 的完成信号。

- [ ] **Step 4: 全量验证**

Run: `npm run typecheck && npm run test`
Expected: 全绿(含 store、组件测试)。

- [ ] **Step 5: Commit**

```bash
git add server/session-pump.ts src/session-store/debug.ts src/session-store/reducer.ts src/session-store/types.ts CLAUDE.md
git commit -m "chore: remove probe logging; sync async/sync comments and docs (server authority)"
```
