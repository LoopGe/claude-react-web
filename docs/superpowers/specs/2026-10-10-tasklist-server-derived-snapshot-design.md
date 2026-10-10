# 2026-10-10 · TaskList 服务端派生快照(转录即持久化)

> **承接**:TaskList 底部卡片(`TodoChecklist`)与内联 `TaskMutationView` 在长会话里显示 `Task #N` 占位标题的 bug。本 spec 把 TaskCreate/TaskUpdate 折叠状态的权威来源从"客户端消息窗口"上移为"服务端从全量转录派生的快照",客户端窗口折叠退化为增量层。同二进制交付,无跨版本兼容负担。

## 一、背景与根因(已实测证实)

Task 管理工具有两个互斥家族(由 CLI 的 `CLAUDE_CODE_ENABLE_TASKS` 开关决定):

1. **TodoWrite(legacy)**——单帧全量快照,无窗口问题;
2. **TaskCreate / TaskUpdate(2.x 默认)**——增量事件流:真实标题只在 `TaskCreate` 的 tool_use input 里,服务器分配的编号 `#N` 只在其 tool_result 文本里;后续 `TaskUpdate` 只带 `taskId` 不带 subject。

客户端折叠器(`src/utils/task-events.ts` 的 `foldTaskEvents`)扫描**内存消息窗口**:看到 `TaskUpdate` 但看不到对应 `TaskCreate` 时,物化占位 stub:

```ts
// src/utils/task-events.ts:188
subject: str(input?.subject) ?? `Task #${id}`,
```

**实测证据**(session `39f6ab75`,782 条消息):

- 磁盘转录完整:`TaskCreate #6–#10` 存在且带真实标题,位于服务端分页历史的第 275–283 位(距尾部约 700+ 条);
- 服务端 history ring 上限 500(`HISTORY_CAP`),重连/刷新后 WS replay 只回放最近 ~500 帧,更早内容靠滚动 `loadOlder`(200 条/页)拉回;
- 对服务端分页历史在不同窗口深度重放同一折叠逻辑:窗口 300 条 → 全部 `Task #N` 占位(= 用户截图症状);窗口 ≥500 条 → 真实标题全部恢复。

**约束(探索证实)**:

- SDK **不为**清单任务发 `task_*` 系统帧(实测该 transcript 0 条)——服务端现有 `session.tasks`(后台任务 TaskRecordUi)完全覆盖不到,必须从 tool_use/tool_result 帧自行折叠;
- `jsonl-cache` 已把每个 session 的全量可渲染转录解析缓存(LRU 4 session,增量追加解析)——服务端派生的读成本是毫秒级;
- pump 已有同构钩子(mutating tool_result 落地 → git-snapshot 广播),Task* 完全可复用该模式;
- `/clear`(及 compact)在本应用里 respawn 到**新 session id**——新 id 有全新转录,派生折叠天然干净,无需 clear 锚点;
- 受影响消费者两个:`TodoChecklist`(底部卡片)与 `TaskMutationView`(内联卡 subject 解析,经 `useTaskInfo` context 读 `MessageList.tsx:1280` 构建的窗口折叠 map)。

## 二、目标 / 非目标

**目标**

- 服务端拥有全量 Task* 折叠状态:从转录派生,经 WS 快照帧(新订阅者播种)+ REST 双通道供给客户端(仿 git-snapshot 模式);
- 长会话刷新/重连后 TaskList 直接显示真实标题,历史遗留 session(转录里已有 Task* 事件)也能恢复;
- **两个消费者都覆盖**:`TodoChecklist` 与 `TaskMutationView` 共用合并后的 map(`TaskMutationView` 自身零改动);
- 折叠逻辑一份实现两端共用:从 `src/utils/task-events.ts` 移纯函数到 `shared/`;
- 性能打点:`tasklist_derive_ms` 直方图 + `tasklist_broadcast_total` 计数器。

**非目标(YAGNI,明确不做)**

- **不新增独立持久化文件**:转录文件本身就是持久层(方案 A 曾评估,独立 store 的崩溃恢复兜底仍是"从转录重派生",代码量翻倍、用户可见收益为零);
- TodoWrite 家族服务端化:它是快照语义,无窗口问题;
- tombstone 机制:删除语义由即时广播 + 窗口胜出收敛(见 §五),毫秒级瞬时复活可接受;实测可见再加;
- session-store reducer 改动:快照不入 store,走 git 同款 hook 直连模式;
- 快照差量推送:任务清单是 KB 以下全量态,幂等可丢,下一帧自愈;
- 广播防抖:Task* 事件稀少(每回合几次),即时推送;metrics 实测需要再留防抖。

## 三、架构与数据流

```
CLI 转录 JSONL(持久层,唯一事实源)
   │ jsonl-cache(已有:全量解析缓存,增量追加解析)
   ▼
server/tasklist-state.ts  deriveTaskList(sessionId)
   │  折叠全部 Task* 事件 → { tasks:[{id,subject,status,activeForm,stale}], rev }
   ▼
SessionEventBroadcaster ── WS `tasklist-snapshot`(新订阅者播种最近一帧)
   │                    ── GET /sessions/:id/tasklist(挂载时拉一次)
   ▼
useTaskList hook(仿 useGitStatus:HTTP 一次 + WS 替换,JSON 串比较防级联渲染)
   ▼
mergeTaskList(snapshot, windowFold)  ← 窗口实时折叠逐 id 覆盖快照
   ▼
TodoChecklist(底部卡片)+ TaskInfoProvider → TaskMutationView(内联卡,零改动)
```

**触发点**(`server/session-pump.ts`,与 git 的 mutating-tool 检测同构):

- assistant 帧扫描时检测 `TaskCreate`/`TaskUpdate` tool_use id(仿 `mutatingToolUseId` 加 `taskToolUseId`);
- 其 tool_result 落地(user 帧)→ `onTaskListChanged(sessionId)`,**不防抖**;
- **真用户消息落地** → 同钩子(驱动 stale 边界刷新,见 §五)。

**组件清单**:

| 组件 | 动作 | 职责 |
|---|---|---|
| `shared/task-list.ts` | 新 | fold 纯函数移入(`foldTaskEvents` 核心、`parseTaskId`、`resultText`、`normalizeStatus`、`str`、`TaskState`)+ `mergeTaskList` 纯函数(§五)+ 快照载荷类型;客户端 `task-events.ts` re-export,两端一份实现 |
| `server/tasklist-state.ts` | 新 | `deriveTaskList`:经 jsonl-cache 读全量转录(为它加一个全量读取口)→ 折叠 → 快照 + stale 预计算 + `rev` |
| `server/session-pump.ts` | 改 | `taskToolUseId` 检测 + 两类落地事件 → `onTaskListChanged` |
| `server/session-broadcaster.ts` | 改 | 仿 git:`tasklistSnapshots` Map(卸载清理)+ `subscribeTaskList`(播种)+ `broadcastTaskListChanged` |
| `shared/ws-protocol.ts` + `server/ws-protocol.ts` + `src/ws-types.ts` | 改 | 新帧 `tasklist-snapshot`(generic 定义 + 两侧别名) |
| `server/routes/sessions.ts` | 改 | `GET /sessions/:id/tasklist`(未知 session 404,仿 file-snapshots) |
| `src/hooks/useTaskList.ts` | 新 | HTTP 一次 + WS 替换;`rev` 回退帧丢弃 |
| `src/components/MessageList.tsx` | 改 | `windowFold` ⊕ 快照合并成一个 map 喂 `TaskInfoProvider` |
| `src/components/TodoChecklist.tsx` | 改 | task 分支数据源换成合并结果;`extractTodos` 双源择新(TodoWrite vs Task)保留 |
| `server/metrics.ts` 使用点 | 改 | `tasklist_derive_ms` 直方图、`tasklist_broadcast_total` 计数器 |

**明确不改**:TodoChecklist 的冻结(`/clear` 淡出)/collapse/hide-set 逻辑、TodoWrite 路径、session-store、TaskMutationView 组件本体。

## 四、协议变更

`shared/ws-protocol.ts` 新帧(不替换任何旧帧):

```ts
interface WsTasklistSnapshot {
  kind: 'tasklist-snapshot'
  sessionId: string
  rev: number   // 已折叠 Task* 事件计数,append-only 单调;客户端丢弃 rev 回退帧
  tasks: Array<{
    id: string        // '#N' 的 N,与 TaskUpdate.taskId 同形
    subject: string
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
    activeForm?: string
    stale: boolean    // 服务端预计算,客户端只执行
  }>
}
```

- 无任务时也广播空快照(`tasks: []`,rev 照走),客户端据此清空面板;
- **provisional 条目不进快照**:在途 create(结果未落)由客户端窗口折叠的 `pending:toolUseId` 键覆盖,两套键空间不相交;
- REST:`GET /sessions/:id/tasklist` 返回同 payload(derive-on-read,总是最新)。

## 五、合并与 stale 规则(最微妙处)

### stale:服务端算,客户端只执行

"已完成且过期"(resolved 且最后触碰早于最后一条真用户消息)今天由 TodoChecklist 用**窗口内坐标**算(`lastTouched < lastUserInputIndex`)。合并后跨坐标系比较会错,故:

- **服务端**用全量转录坐标算同一谓词:边界 = 最后一条真用户消息的行位置(判据与 pump 现有"无 tool_result 的 user 帧"一致);`resolved && lastTouched < boundary` → `stale: true`;
- 边界随新用户消息移动 → 真用户消息落地也重广播,快照永远新鲜;
- 客户端对快照条目只执行:`stale && resolved → 不渲染`;窗口条目维持现有客户端规则不动。

### 合并(`mergeTaskList`,纯函数)

```
merged = windowFold(逐 id 胜出) ∪ snapshot.tasks 中 id ∉ windowFold 的条目(应用 stale 过滤)
```

- **窗口胜出**:窗口内折叠有最新事件序(刚落地的状态翻转、在途 create);快照职责只是补全**窗口外**深历史;
- **删除语义**:`TaskUpdate(deleted)` 落地 → pump 即时重派生广播 → 快照已无该 id;广播到达前的毫秒级窗口内可能瞬时复活,下一帧自愈——不加 tombstone;
- hide-set 键仍是 `#N`(快照与窗口同键,长按隐藏跨刷新一致)。

### 降级路径

REST 500 / WS 不可用 → 合并退化为纯窗口折叠,UI 与今天完全一致,不会更坏。

## 六、错误处理

| 场景 | 行为 |
|---|---|
| 转录文件不存在(新 session / 未 spawn) | 派生返回空快照 `rev: 0`,不是错误 |
| derive 抛错(IO/解析) | 广播路径:`log.warn` + 跳过本帧,下次触发自然重试;REST 路径:500(HttpError 惯例) |
| 乱序帧(rev 回退) | 客户端丢弃,以最大 rev 为准 |
| LRU 驱逐导致重解析 | 有界(~5–20ms @1500 行),`tasklist_derive_ms` 直方图暴露 |
| 广播风暴 | 按设计不防抖;metrics 实测需要再加(逃生口) |

### 性能预算(实测数据支撑)

- derive 单次 < 1ms @ 1100 帧(折叠 O(帧数) 扫已解析对象;最大头是 tool_result 索引的 `resultText` 拼接,normalize 已 trim 大结果);
- 触发频率:每回合几次、亚毫秒级,Node 服务进程,不占浏览器主线程;
- pump 热路径:每 tool_use 块多两次字符串比较(与 `mutatingToolUseId` 同构),纳秒级;
- 客户端:现状每个流式 flush 就对窗口跑一遍折叠(每秒多次);方案等于把更重的全量折叠移到服务端,客户端只多一次几十条目的 map 合并——**净开销大概率低于现状**。

**Metrics**(遵守"标签只用有限枚举,不带 sessionId"):`tasklist_derive_ms` 直方图(p50/p95/p99)、`tasklist_broadcast_total` 计数器;SettingsPanel Performance tab 已渲染 `GET /api/metrics`,零额外工作即可见。

## 七、测试

| 层 | 测试 |
|---|---|
| shared fold | 现有 `task-events.test.ts` 随代码迁到 shared,断言不变(含 fold/probe 平价测试) |
| `deriveTaskList` | 单测:临时 fixture JSONL → 派生断言 tasks/rev/stale;增量追加后 rev 增长;无文件 → 空快照 |
| pump 钩子 | Task* tool_result 落地 / 真用户消息落地 → `onTaskListChanged` 被调(仿现有 git 广播 pump 测试) |
| broadcaster | 订阅播种(先播后订/先订后播)、卸载清理(仿 git 快照通道测试) |
| `mergeTaskList` | 纯函数:窗口胜出 / 快照补全 / stale 过滤 / 删除瞬时复活 |
| `useTaskList` | jsdom:mount 拉取 + WS 替换 + rev 回退忽略 |
| TodoChecklist 集成 | 现有测试全过 + 新增:stub 窗口 + 快照 → 渲染真实标题 |

## 八、已知边界

- **fork**:新 session 的转录含 fork 点之前的 Task* 事件 → 快照会显示 fork 前的任务。CLI 侧 fork 后的任务清单行为未逐一验证,但"显示"不比"丢失"差;若需对齐 CLI 行为,后续在 fork 路径传截断点即可(独立演进)。
- **jsonl-cache LRU = 4**:同时活跃且用任务工具的 session 超过 4 个时,广播可能互相驱逐缓存 → 每次退化为重解析(有界,直方图可见)。这是既有 LRU 容量问题,不是本方案引入。
- **broadcast 即时性依赖 tool_result 落地检测**:与 git 广播同一检测路径,检测漏判(如未来 CLI 改工具名)时快照滞后、但客户端窗口折叠仍兜底当前回合。
