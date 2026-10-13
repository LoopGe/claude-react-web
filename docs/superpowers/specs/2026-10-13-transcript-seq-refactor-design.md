# Transcript Seq 重构设计：服务端权威 + 全局连续 seq + 客户端窗口视图

日期：2026-10-13
状态：已与用户逐节确认（三节均确认），待实施计划

## 0. 背景与根因

用户报告：长会话（如 `89b7ae30`，磁盘 715 条可渲染消息）在恢复（重开/刷新）后只显示尾部约 700 条，且向上滚动无法补齐更早的历史。

调查确认的根因链：

1. 服务端正常：磁盘 transcript 715 条可渲染；WS replay 下发内存 ring 的 502 条（`historyCap=500`）；`/history` 分页正确。
2. 客户端恢复路径 = replay(502) + IDB 冷加载(~213)，合计 ~713 条；更早的消息依赖滚动触发 `loadOlder`。
3. `loadOlder` 的唯一触发点是 react-virtuoso 的 `startReached`。实测（fetch 包装器 + sessionStorage 探针跨 reload 存活）确认 `startReached` **从不触发**。
4. react-virtuoso 4.18.6 实际接线的 `startReached` 发射器要求 `items[0].index === 0`（偏移空间 = `originalIndex + firstItemIndex`）。commit `7692251`（2026-09-09）为 prepend 锚定引入 `firstItemIndex = INITIAL_FIRST_ITEM_INDEX = 1_000_000`（只递减、永不归零），自此条件恒假，**lazy-load 整体成为死代码**，且 UI 仍渲染 "Scroll up for earlier messages" 提示。

结构性问题：消息有三个来源（ring replay、`/history` 磁盘页、IDB 冷加载），无统一序号，只能靠 uuid 去重合并；渲染下标空间与消息顺序是两套坐标，靠换算对齐。所有对齐启发式（`restoredFromDisk`/`consumedAt`/`isReplay`、seq 水位、contiguity 补洞、burst 避让）都是这个结构缺陷的补丁。

## 1. 目标与非目标

### 目标

- transcript 的真相源唯一（服务端），消息有全局稳定序号（seq），任何读取路径返回的同一 seq 永远是同一消息。
- 打开会话、滚动加载、断线补洞共用同一条分页代码路径。
- 删除客户端持久化层与全部双源合并启发式。
- 渲染下标空间与 seq 空间合一，`startReached` 恢复正确语义。

### 非目标

- 不改变消息的渲染行为（subagent 配对、task 折叠、plan 卡、权限状态机等 UI 逻辑原样保留）。
- 不引入多设备/离线优先级（本机单用户部署）。
- 不改 SDK 的 JSONL 写入（它仍是原始真相）。

## 2. seq 体系（服务端）

- pump 每收一条**可渲染**消息（沿用 `BROADCAST_SYSTEM_SUBTYPES` + `tool_use_summary` 判定）分配 `seq`，会话内从 0 单调递增。
- seq 一经分配永不改变、永不复用。驱逐/撤回不回收 seq，只追加墓碑。
- 世代（generation）：`/clear` 删 transcript 重启会话时 +1，seq 从 0 重新计。完整游标 = `(sessionId, generation, seq)`。世代号进会话快照帧与 `/messages` 响应；客户端世代不匹配时整窗作废重拉。
- 存储：`<stateDir>/transcripts/<sessionId>.ndjson`，追加行：
  - `{ seq, uuid, type, subtype, msg }`（msg = 现有 `normalize()` 输出）；
  - `{ seq, evicted: true }`（墓碑）。
  追加式设计崩溃安全。会话加载时若 sidecar 缺失/落后（按 `(size, mtime)` 或末行 seq 对账），用 jsonl-cache 的增量解析补齐。**SDK JSONL 是原始真相，sidecar 是 seq 权威。**
- 服务端内存 ring 降级为纯缓存（加速尾页读取），不再承担真相源职责。

## 3. 读取协议（唯一入口）

```
GET /sessions/:id/messages?before=<seq>&limit=200
  → { generation, totalCount, startIndex, hasMore,
      messages: [{ seq, ...normalize输出 }] }
```

- `before` 省略 = 最新一页。`totalCount` 含墓碑计数（仅用于滚动比例），messages 不含墓碑。
- 现有 `/history` 保留一个版本期，内部转发新端点，随后删除。
- `replay-plan.ts` / `replay-bursts.ts` 整体退役。

## 4. WS 通道变更

- per-session `message` 帧携带 `{ seq, generation }`；驱逐以 `messages-evicted` 帧（seq 集合）广播，替代 uuid 侧信（uuid 字段保留一版供旧客户端）。
- `replay` / `replay-done` / `subscribe-result` 重发语义简化为 attach 成功回一帧 `attached { generation, headSeq }`，**不再重放历史**；补洞全走 REST。
- 保留不动：权限/对话框/elicitation/context-usage/tasks/git-snapshot 等 non-message 通道，`message-consumed` / `messages-withdrawn` 输入队列语义。

## 5. 客户端窗口视图

### 5.1 Store

```
state = {
  generation, headSeq,
  window: Map<seq, SdkMessage>,
  oldestSeq, newestSeq,
  hasOlder, hasNewer,
  ...live 状态（permissions/tasks/contextUsage 等原样保留）
}
```

写入只有三种，全部以 seq 定位，无 uuid 合并：

1. REST 页追加（前/后）；
2. live `message` 帧（seq ≥ newestSeq 尾追加；乱序帧暂存 `pendingSeqs`，出现空洞时拉 `(newestSeq, 帧seq)` 区间补齐——唯一需要缓冲的场景）；
3. `messages-evicted` 墓碑（从 window 删除对应行）。

删除：IDB 层（`idb.ts`、`loadOlderFromIdb`、seq 水位、contiguity）、localStorage transcript 缓存（`project.ts`、hydrate/cold-load 时序）、`restoredFromDisk`/`consumedAt`/`isReplay` 启发式字段。

打开会话 = `GET /messages` 尾页 + 订阅；不做客户端持久化，骨架占位替代秒开（本机往返 ~几 ms）。

### 5.2 渲染对齐

- `MessageList` 的行携带 `seq`，`firstItemIndex = oldestSeq`；prepend 一页 `[s-200, s)` 时同一渲染提交 `firstItemIndex = s-200`（`advanceRowAnchor` 机制保留，锚值语义变为真实下标）。
- virtuoso `startReached`（`items[0].index === 0`）恢复正确语义：只在用户真正滚到 seq 0 时触发。
- 中途向上加载由 `rangeChanged` 驱动：`range.startIndex - firstItemIndex <= 阈值` → 取前一页（`hasOlder === false` 不拉）。
- 驱逐渲染行为与现状一致（`EVICT_MESSAGES` 改为消费 `messages-evicted` 的 seq 集合）。

### 5.3 loadOlder 形状

```ts
async function loadOlder() {
  if (!hasOlder || inFlight) return
  const page = await api.get(`/sessions/${id}/messages?before=${oldestSeq}&limit=200`)
  dispatch({ type: 'PREPEND_PAGE', generation: page.generation, messages: page.messages,
             startIndex: page.startIndex, hasMore: page.hasMore })
}
```

无 cursorRef 双轨、无 beforeUuid 兜底、无 burst 避让 gate。拉页期间窗口顶部显示加载占位行，不阻塞滚动。

## 6. 边界语义

- **重连**：hub 重新 attach 拿 `attached { generation, headSeq }`。`newestSeq >= headSeq` → 无事；落后 → 按 seq 分页补齐；generation 变化 → 整窗作废走初始路径。补洞与滚动加载共用代码。
- **/clear**：世代 +1，所有 tab 经快照帧感知新 generation 并整窗重置。`clearedRef` 类守卫删除（旧世代页永远拉不到，预 clear 回滚问题不复存在）。
- **会话删除**：pending 语义不变；transcript sidecar 与 JSONL 一并删除。
- **多标签**：每 tab 独立窗口，live 帧按 seq 各自尾追加，天然收敛。

## 7. 迁移阶段（每阶段独立可发布）

| 阶段 | 内容 | 说明 |
|---|---|---|
| P0 止血 | `MessageList` 用 `rangeChanged` 触发 `loadOlder`（用现成 `firstItemIndexValRef` 换算），删除对 `startReached` 的依赖 | 立即恢复历史加载 |
| P1 服务端 | transcript sidecar（追加式 + 墓碑）、`GET /messages`、live 帧带 seq/generation、`attached` 帧 | 纯增量，新旧并存 |
| P2 客户端 | store 重写为 seq 窗口；打开走尾页+订阅；删 IDB/localStorage 层；渲染锚定切 seq | 依赖 P1；`/history` 转 shim |
| P3 退役 | 删 replay/burst/sinceUuid/`replay-plan`/`replay-bursts`/旧 `/history`/uuid 驱逐侧信 | 破坏性，前后端同版发布 |

## 8. 测试策略

- **seq 核心（纯函数）**：seq 分配、墓碑折叠、世代切换、sidecar 对账（缺失/落后）。
- **窗口 store**：PREPEND_PAGE / live 追加 / 乱序补洞 / 驱逐 / generation 重置（reducer 级测试）；乱序与断线用假 hub 定时帧驱动。
- **渲染对齐**：jsdom 断言 `firstItemIndex === oldestSeq`、prepend 同帧提交；回归测试锁住"到 seq 0 才触发 startReached"。
- **服务端分页**：`before` 边界、墓碑过滤、generation 不匹配 409。
- **迁移护栏**：P1 落地后用现有会话做双读对比（replay 输出 vs seq 窗口逐条相等）作为验收门。

## 9. 删除清单（P3 结束时）

`idb.ts`、`loadOlderFromIdb`/seq 水位/contiguity、`project.ts`、replay 组装器与 burst 缓冲、`replay-plan.ts`、`replay-bursts.ts`、`sinceUuid`/`hasCachedTranscript`/`replayMode` 协议字段、`restoredFromDisk`/`consumedAt`/`isReplay` 字段、`clearedRef` 及相关 gate、uuid→seq 兼容换算层。估计净删 ~1500–2000 行。

## 10. 关键取舍记录

1. **sidecar 用追加式 ndjson + 墓碑行，不用 SQLite**：与 JSONL 哲学一致，崩溃安全，无需引入新依赖；读取路径已有 jsonl-cache 可复用。
2. **WS 不再重放历史，补洞全走 REST**：消除 replay 组装/burst 状态机；重连补洞与滚动加载共用分页。
3. **客户端零持久化**：本机部署下 IDB 只省一次 ~几 ms 往返，代价是双读取路径与缓存失效面（本次调查中 713 vs 1142 谜题、contiguity、冷加载时序均为其贡献）。曾评估"seq 键控 IDB 纯缓存"混合方案，因上述成本/收益不成比例而否决。
4. **seq 追加稳定 + 墓碑驱逐**（而非"可渲染下标"）：本项目存在事后驱逐（`model_refusal_fallback` retract、`messages-withdrawn`、EVICT_MESSAGES），下标方案会导致 seq 平移与游标失效。
