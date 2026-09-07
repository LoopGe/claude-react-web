# Spec:Subagent async/sync 判定改为 server task 状态权威(纯 server 权威 + task_notification 降级为完成信号)

- 状态:draft(等待用户评审)
- 日期:2026-09-07;锚点以符号名/函数名为准(行号会漂移)
- 来源:探针实测(2026-09-07 server log)——对当前 CLI 各发一个 sync(`run_in_background:false`)与 async(`run_in_background:true`)Agent 探针,抓到完整 SDK task 帧序列
- 前置裁决(用户已批准):更大重构;纯 server 权威(Q2);方案 B(ack 嗅探仅作防误结算守卫)。文末 §7 决策记录含 D1/D2 两个待评审确认点。

## 1. 问题与被违反的不变式

目标不变式:**`isAsync`(卡片 async/sync 徽标的真值)应由 server 侧权威来源决定,客户端不得用帧时序/文本猜测;`task_notification` 是完成信号,不是 async 指示器。**

三条实测/复核发现违反或威胁该不变式:

1. **Server 漏折官方判据字段**。`server/session-pump.ts` `applyTaskEvent` 的 `task_started` 分支只折 `toolUseId/description/subagentType/taskType/skipTranscript/ambient/startedAt`,**没有折 `raw.is_backgrounded`**;唯一折点是 `task_updated.patch.is_backgrounded`(session-pump.ts `task_updated` 分支)。实测两次探针的 `task_updated` patch **都只有 `{status, end_time}`,从不带 `is_backgrounded`** → 该折点实际是死路。async 探针能标上 `isBackgrounded` 纯靠 `background_tasks_changed` **恰好先于** `task_started` 到达(`session.tasks` 先被 seed 成 background,upsert spread 保留)——而 SDK 文档明说 bookend 与 level 帧的相对顺序 unspecified。换个顺序,`task_started` 后 push 的 snapshot 就不带 `isBackgrounded`,client 只剩 ack/时序推断可用。
2. **`task_notification ⇒ async` 前提被证伪**。`src/session-store/reducer.ts` task_notification 完成分支**无条件盖 `isAsync: true`**,注释依据是「A task-notification only ever targets an async subagent」/「A synchronous subagent never receives a task-notification」。实测:**纯前台 sync(`run_in_background:false`)在真实输出 tool_result 落地之后,同样收到 `task_notification`(status=completed)**。该分支接受 `running/done/background/pending/interrupted` 五种状态 → sync 卡先被真实 tool_result 结算成 `done`(isAsync 仍 false),随后 task_notification 到达 → 被无条件改成 `isAsync: true` → **sync 误标 async**。现有测试只覆盖「sync 发起→Ctrl+B 后台化→replay」(此时 input 无 flag,seed=undefined),未覆盖纯前台 sync 收到完成通知这一路径。
3. **客户端为补偿 server 缺权威而叠加的三层猜测各有漏洞**:ack 文本嗅探(仅识别 launch-ack,对 Ctrl+B detach 文本不免疫)、child-after-result 翻 isAsync、task_notification 盖戳。三者都应在 server 把官方字段送下来后降级/删除,只留最小防御。

附带事实(影响设计边界,见 §4):`background_tasks_changed` 只列**存活后台**任务,前台任务永不出现;frame-less 后台 dispatch(CLI 不发 task 帧)已有 watcher seed(`server/session-manager.ts` `startBackgroundSubagentWatcher`,seed `isBackgrounded:true` 并**立即 push snapshot**)。

## 2. 范围

**In**:
- Server:`task_started` 分支折叠 `raw.is_backgrounded`(true/false 都折)。
- Client:`TASKS_SNAPSHOT` join 成为 `isAsync` **唯一权威**(§3.2,双向写、含 terminal 记录)。
- Client:task_notification 分支删除 `isAsync:true`(§3.5)。
- Client:child-after-result 分支删除 `isAsync` 翻转,保留 `endedAt` 推进与子帧文本/工具计数捕获(§3.4)。
- Client:ack 守卫按 D2 定稿(§3.3)。
- Client:seed 按 D1 定稿(§3.6)。
- 上述全部回归测试(§5)、注释/CLAUDE.md 对账。

**Out**:
- Server 持久化解析出的 `isAsync`(sidecar / 消息形状 / TaskRecordUi 加字段)。`TaskRecordUi.isBackgrounded` 已存在,不加新字段。
- 超过 terminal cap(50)被淘汰的旧已完成卡,刷新后徽标丢失——**用户已接受**。
- `subagent-watcher` 结构改造(其 seed + 合成通知机制原样保留,是 frame-less 场景下「server 权威」得以成立的支撑)。
- 客户端 ack 文本作为 async **真值**的任何用途(彻底移除以满足「纯 server」)。
- 改动 WorkingBubble/Chat 消费契约(`status`/`isAsync` 语义不变,只是赋值来源变了)。

## 3. 设计

### 3.1 Server:task_started 折叠 `is_backgrounded`

`server/session-pump.ts` `applyTaskEvent` → `task_started` 分支(现有 `...existing` upsert spread 之后)新增:

```ts
isBackgrounded: typeof raw.is_backgrounded === 'boolean'
  ? raw.is_backgrounded
  : existing?.isBackgrounded,
```

- `raw` 类型已含 `is_backgrounded?: unknown`(探针日志加的是同一字段的读取,一并保留/收编)。
- 效果:sync 注册瞬间即带 `false`,async 带 `true`;每次 fold 后 `pushTasksSnapshot` 推的 snapshot 立刻携带权威值;terminal 记录经 spread 保留该值。
- frame-less 后台 dispatch 不需改(3.1 之外已有 watcher seed + 立即 push)。前台 frame-less dispatch(若有 CLI 不发 `task_started`)→ 无任务记录,`isAsync` 保持 undefined(§4 记录,接受)。

### 3.2 Client:`TASKS_SNAPSHOT` join = `isAsync` 唯一权威

`src/session-store/reducer.ts` `TASKS_SNAPSHOT` case。现状只做:非 terminal + `isBackgrounded` 时翻 `running→background`(及 rescueSettled)。扩展为 **join 同时解析 `isAsync`**,规则:

```ts
for (const task of action.tasks) {
  if (!task.toolUseId) continue
  const record = activeSubagents.get(task.toolUseId)
  if (!record) continue
  const isTerminal = isTerminalTaskStatus(task.status)

  // ★ 权威写入:server 给了布尔就覆盖(双向;live 与 terminal 都写)
  const nextIsAsync = typeof task.isBackgrounded === 'boolean'
    ? task.isBackgrounded
    : record.isAsync

  // rescue:Ctrl+B detach ack(非 launch 签名)把记录误结算成 done/带假 result,
  // server 说该任务仍 live 且是 background → 救回(清掉假 endedAt/result)
  const rescue = task.isBackgrounded === true && !isTerminal &&
    (record.status === 'done' || record.status === 'interrupted')
  const flipToBackground = task.isBackgrounded === true && !isTerminal &&
    (record.status === 'running' || rescue)

  activeSubagents.set(task.toolUseId, {
    ...record,
    taskId: task.taskId,
    progressSummary: isTerminal ? undefined : task.progressSummary ?? record.progressSummary,
    lastToolName: isTerminal ? undefined : task.lastToolName ?? record.lastToolName,
    isAsync: nextIsAsync,
    ...(flipToBackground
      ? rescue
        ? { status: 'background' as const, endedAt: undefined, result: undefined }
        : { status: 'background' as const }
      : {}),
  })
}
```

要点:
- **`false` 也写**:sync 卡即使 input 没带 `run_in_background` 也能标 sync;纠正任何旧值。
- **terminal 也写**:刷新后靠 server 保留的 terminal 记录恢复徽标(§4 cap 限制)。
- **rescue 从「ack 误结算」收敛为「server 说它是 live 后台任务但记录被 detach 文本误结算」**;launch-ack 不再由文本翻 `background`(见 §3.3/§3.6 后状态机)。

### 3.3 Client:ack 守卫(D2 = 推荐 a:仅翻 `background` 状态,不设 `isAsync`)

`result-merge` 分支现状(`updateIndexesMirror`)命中 launch-ack 时:翻 `background`、不设 `endedAt/result`、**也不设 `isAsync`**(已核实当前 ack 分支只有 `{ ...existing, status: 'background' }`)。因此 **D2-a 下本分支几乎零改动**:

- 保留 `isAck` 判定作为**防误结算守卫**:命中「`/^async agent launched successfully/i`」→ 跳过把 ack 当真实结果合并。
- 命中即翻 `status: 'background'`(纯状态动作,证明调用已 detach):让 WorkingBubble chip 立即正确,且 parent turn 结束时 sweep 走 `background→pending` 而非误杀刚启动的 async。
- `isAsync` **不在此处设**,交给 §3.2 的 snapshot join。
- D2-b(不翻状态)被否:会引入「parent turn 在 snapshot 前结束 → sweep 把刚启动的 async 当 sync 孤儿 interrupt」竞态,需额外 sweep 保险;D2-a 无此负担。

注:D2-a 下 ack 文本仍会翻 `background` 状态,但**不再决定 async 真值**(徽标)。「纯 server 权威」落在 `isAsync` 字段上;`background` 是生命周期状态,由 ack 文本即时置位、由 snapshot 权威确认(两者在真实 launch-ack 下必然一致)。

### 3.4 Client:child-after-result 只保留计时/捕获,删 `isAsync` 翻转

现状(async-detector)对 `background/pending` 记录做两件事:(i) 推进 `endedAt`(计时)+ 子帧文本/工具计数捕获进 `result`;(ii) 顺带 `asyncChanged ? { isAsync: true }`。

改为**只保留 (i),删除 (ii)**。由于 `background` 状态现在只由 §3.2(snapshot)或 §3.3(ack 守卫,D2-a)置位,该分支语义自洽:
- ack 已翻 `background`、snapshot 尚未到时,子帧不翻 `isAsync`(等 snapshot);
- snapshot 已翻 `background` 后,子帧照常推进计时与捕获输出。
- 对 sync 记录是 no-op(其 tool_result 最后落地,`stamp ≤ endedAt`),行为与现状一致,只是不再有「第二个子帧误标 async」的隐患路径。

### 3.5 Client:task_notification 只做完成信号

`task_notification` 完成分支删除无条件 `isAsync: true`。保留:
- 完成 status:`background/pending/running → done`,失败 → `interrupted`(接受集不变);
- `endedAt`;
- 用通知的真实输出补 `result`:现有 `overwriteResult = existing.status === 'done' || !existing.result` 护栏保留。

因为 server 在 fold `task_notification` 时**也会 push 一张含 terminal 记录的 snapshot**,async 的 `isAsync` 由 §3.2 join 写入——无论通知与 snapshot 谁先到,`isAsync` 都收敛到 server 值(snapshot 在通知后到时:join 在 `done` 上仍写 true;先到时:通知前已是 true)。

修复效果(实测 bug):纯前台 sync 的完成通知到达时,记录 `status='done'`、`isAsync` 仍为 seed/snapshot 给的 `false` → **不再误标 async**。通知对 sync 卡是幂等完成(sync 真实输出已由 tool_result 合并,通知 summary 覆盖为同内容,无害)。

### 3.6 Client:seed(D1 = 推荐:删 `run_in_background` 种 `isAsync`;isAsync 初始为 undefined)

现状 `src/session-store/normalize.ts` `getSubagentStarts` 读 `input.run_in_background` 种 `isAsync`。**D1(纯 server)**:改为**不种 `isAsync`**(记录初始 `isAsync: undefined`),async/sync 完全交给 §3.2。

- ack 守卫随之简化为纯正则:删 `existing.isAsync !== false` 与 `existing.isAsync === true` 两子句,`isAck = !isError && /^async agent launched successfully/i.test(ackText)`。理由:无 seed 后 `isAsync===false` 的「显式 sync 免疫」保护不再可得,但其唯一价值是防「sync 真实输出恰好以 ack 短语开头」——该病态情形即使误判,后续 task_notification(接受 `background`)会以真实 summary 覆盖,自愈。
- 代价:运行中的 async 卡在首张 snapshot 到达前(ms 级)无徽标;cap 淘汰的旧卡重放后无徽标(已接受)。
- 备选(D1-alt,见 §7):保留 seed 作为「provisional、snapshot 严格覆盖」的即时提示,UX 更好但非纯 server。**待评审定稿**。

### 3.7 注释 / 文档对账

- `reducer.ts` task_notification 分支的「only ever targets an async subagent / never receives a task-notification」注释改为准确表述:通知是所有 task(含前台)的完成信号,async 判定看 snapshot。
- `src/session-store/types.ts` `ActiveSubagent.isAsync` 注释更新:由 `TASKS_SNAPSHOT` 的 `isBackgrounded` 权威写入,不再由输入 flag / 帧时序推断。
- CLAUDE.md 对应段落(任务/子代理 async 判定描述)同步。
- 探针临时日志(`server/session-pump.ts` task_frame / background_tasks_changed / async launch ack 检测,`src/session-store/debug.ts` subagentDebug 与 reducer 内调用)在实现落地后移除。

## 4. 兼容性与数据形状

- **WS 协议 / 帧形状:零改动**。`TaskRecordUi` 不加字段(`isBackgrounded` 已存在,只是现在 task_started 会写 true/false)。
- `TaskRecordUi.isBackgrounded` 语义微扩:从「task_updated/background_tasks_changed 置位」扩为「task_started 也置位」,仍为 `boolean | undefined`(undefined=未知)。对已订阅的旧客户端无影响(server 先行)。
- **snapshot 不进 ring**:刷新重放时 `isAsync` 只靠 server 现存记录(§3.2,terminal cap 50)恢复;cap 淘汰或 CLI 不发 task 帧的前台 dispatch → `isAsync` 保持 undefined(徽标缺失,已接受)。
- frame-less 后台 dispatch:依赖既有 watcher seed(session-manager)+ 立即 push,server 权威在此场景依然成立。
- `background_tasks_changed` 只列存活后台:前台任务永不出现;其角色只是「后台集合快照」,不变。

## 5. 测试计划(vitest)

**服务端(`server/session-pump.test.ts`)**
1. `task_started` 带 `is_backgrounded:true` → 记录 `isBackgrounded === true`;带 `false` → `false`;缺省 → 保留 existing / undefined。
2. `task_updated.patch.is_backgrounded` 与 `background_tasks_changed` 既有行为不回退(回归)。

**客户端(`src/session-store/reducer.test.ts`)** —— 主战场
3. **新回归(核心 bug)**:纯前台 sync——Agent tool_use(`run_in_background:false`)→ snapshot(`isBackgrounded:false`,模拟 task_started 折叠)→ 真实输出 tool_result → `task_notification(completed)` → 断言 `status==='done'` 且 **`isAsync===false`**(喂实测帧序列;D1 下 `false` 来自 snapshot,不是 seed)。
4. **新**:sync 无 flag 卡,收到 `task_notification` 前先来一张 terminal snapshot(`isBackgrounded:false`)→ `isAsync===false`。
5. `TASKS_SNAPSHOT` 权威覆盖:记录初始 `isAsync` 为 undefined(或已被错误置位)时来一张 `isBackgrounded:true` 的 snapshot → `isAsync===true` 且 `running→background`;`false` → `isAsync===false` 且不翻状态。
6. terminal snapshot `isBackgrounded:true` + 记录已 `done` → `isAsync===true`(重放恢复,替代原「通知盖戳」路径)。
7. rescueSettled 保留:非 terminal `isBackgrounded:true` + 记录被 detach 文本误结算成 `done` → 救回 `background`、清假 result、`isAsync===true`。
8. child-after-result:async(`background`)子帧仍推进 `endedAt`/捕获 result,**不再**依赖它翻 `isAsync`(给 snapshot 断言)。
9. ack 守卫:launch-ack tool_result → 状态 `background`、不设 result/endedAt、`isAsync` 不被文本置位。
10. 改既有:凡断言 ack / child-after-result / task_notification 设 `isAsync` 的用例,改为「先喂一张带 `isBackgrounded` 的 snapshot 再断言」(如 `flips a background subagent to done via…task_notification`、replay-ordering 测试靠其 terminal snapshot 继续通过)。
11. **删既有(D1)**:凡断言「seed 把 `run_in_background` 种成 `isAsync`」的用例(reducer.test.ts 约 :1300-1345 段的 `Seeded false from the explicit run_in_background: false flag` 等)删除或改写为 snapshot 驱动。
11. sweep:parent turn 结束时 `background→pending`、`running→interrupted` 不回退。

**探针清理**:移除 §3.7 所列临时日志后,`debug.ts` 恢复原状。

## 6. 风险与回滚

- **帧顺序 unspecified**:snapshot / ack / notification 相对顺序不保证。设计不依赖具体顺序:任何顺序下 `isAsync` 都收敛到 server 值(§3.2 双向写 + §3.5 通知只完成)。残余瞬态:async 卡在 ack 与首张 snapshot 间无徽标(ms 级)。若实测发现可感知闪烁,可上 D1-alt(seed 即时提示)缓解。
- **cap 淘汰丢徽标**:超过 50 条 terminal 记录的旧卡刷新后 `isAsync` 缺失。已接受;若后续在意,另行做 server 持久化(Out)。
- **frame-less 前台 dispatch**:CLI 若对前台 Agent 不发 `task_started`,则该卡永无 `isAsync`。当前探针 CLI 会发;若旧 CLI 不发,属已知接受范围(徽标缺失,不误标)。
- **回归面**:`TASKS_SNAPSHOT`/`sweep`/result-merge 是 reducer 热路径;改后全量跑 reducer/store 测试。实现按 §5 测试先行(TDD)。
- **回滚**:改动集中于 3 个文件(pump + reducer + normalize)+ 测试,git revert 即可;不引入数据形状/协议变化,无迁移负担。

## 7. 决策记录(用户批准:除 D1/D2 外按设计全收)

- **D0 纯 server 权威**:`isAsync` 由 `TASKS_SNAPSHOT` 的 `isBackgrounded` 权威写入;task_notification 降级为完成信号;ack 文本不再决定 async 真值。(批准)
- **D1 seed 是否保留**:推荐删(纯 server,`isAsync` 初始 undefined,ack 守卫纯正则);备选 D1-alt 保留 seed 为 provisional 即时提示。**待评审定稿**。
- **D2 ack 命中是否翻 `background`**:推荐 a(翻状态,不设 isAsync,零竞态);否 b(不翻,需 sweep 保险)。**待评审定稿**。
- **cap 50 淘汰后徽标丢失**:接受。(批准)
- **frame-less 依赖 watcher seed**:既有机制,不动。(批准)
