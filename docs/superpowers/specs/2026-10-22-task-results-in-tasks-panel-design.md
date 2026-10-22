# Spec:后台任务输出移出 transcript、改由 Tasks 面板承载(含 sidecar 持久化)

- 状态:draft(等待用户评审)
- 日期:2026-10-22;锚点以符号名/函数名为准(行号会漂移)
- 来源:代码实测(2026-10-22)——三组 vitest 探针分别验证「notification 行被 `isResultConsumed` 丢弃」「被丢弃时 `<result>` 正文无渲染入口」「XML 解析器的硬约束与 task-id 无关」,测试为一次性验证、已删除
- 前置裁决(用户已批准):范围 B(**所有** `<task-notification>` 卡片一律不进 transcript,含子代理);方案 1(`PerSessionSidecar` 全量持久化);正文全量存不截断(后续按实际情况优化)

## 1. 问题与被违反的不变式

目标不变式:**一个后台任务的完成输出在 UI 上应当有一个稳定的、可预测的落点;同一份数据不因时间点不同而可见性翻转。**

三条实测/复核发现违反或威胁该不变式:

1. **可见性随窗口翻转(用户最初报的症状)**。`src/components/message-list/rendering.ts` `willRenderEmpty` 对 task-notification 有专门分支:`isResultConsumed(parsed.toolUseId)` 为真即整行丢弃。而 `isResultConsumed` 读的是 `toolResults` / `subagentResultIds` 等 map,这些 map 是**窗口相对**的——运行时源 frame 尚在窗口内,id 已被合并进卡,于是 notification 行被丢;服务端重启后客户端只拉 `?limit=200` tail 页,源 frame 已推出窗口,map 里没这个 id,行便渲染出来。同一份数据,只因时间点不同而可见性翻转。`MEMORY_ITEM_CAP`(1000)的 `trimFront` + `pruneMapToLive` 会触发同样效果。
2. **被丢弃的行,其正文没有任何渲染入口**。探针实测:当 `toolResults` 里只有 launch ack(`Shell N started`)时,notification 行被丢,而 `<result>THE-REAL-OUTPUT</result>` **不在** `toolResults` 里。即 shell/monitor 任务的真实完成输出在 UI 上完全看不到——数据在内存/磁盘里,但没有渲染入口。注释声称"result 已合并进卡",对子代理成立(reducer 写 `ActiveSubagent.result` → SubagentCard),对 shell/monitor 不成立(`toolResults` 只存了 ack)。
3. **`session.tasks` 重启即空,Tasks 面板不是可靠落点**。`server/session-manager.ts` 会话创建处 `tasks: new Map()`;`applyTaskEvent` 仅由 pump 实时帧与 watcher 合成帧调用,**无任何路径把历史 seed 重放进该 map**。seed 的四处遍历分别取 model 名、合并 result 帧、回填 subagent 完成信号——都不碰 `session.tasks`。今天用户能在 transcript 看到那 10 条,正是因为 transcript 卡片是从磁盘 JSONL 回放的,那个 bug 意外充当了唯一的持久化通道。

附带事实(影响设计边界,见 §4):XML 形态的 notification **今天根本进不了 `session.tasks`**——`applyTaskEvent` 首行 `if (msg.type !== 'system') return`,而 `<task-notification>` 是 `type:'user'`。pump 对 `isTaskNotificationUserMessage` 的唯一使用是 `stampUnaccountedTurn`。即用户截图那 10 条(XML 路径)当前不在 Tasks 面板里;Tasks 面板只能看到 `system/task_notification` 帧驱动的任务。

## 2. 范围

**In**:
- `shared/tasks.ts`:`TaskRecordUi` 增 `result?: string`。
- `server/task-result-store.ts`(新建):`PerSessionSidecar` 全量持久化 `TaskRecordUi[]`,落盘 `<stateDir>/task-results/<sessionId>.json`。
- `server/session-pump.ts`:新增 XML notification → `session.tasks` 折叠路径(今天缺失),`result` 从 `<result>` 内联提取;折叠后写穿 sidecar。
- `server/session-manager.ts`:resume 时 load sidecar → seed `session.tasks` → `pushTasksSnapshot`。
- `src/session-store/normalize.ts`:`shouldHideByDefault` 对 `isTaskNotificationUserMessage` 返回 true。
- 死代码清理(§3.4)。
- `src/components/TasksPanel.tsx` + `tasks-panel.css`:终态行可展开查看 `result`,按需渲染。
- 上述全部测试(§5)。

**Out(显式不做,避免范围蔓延)**:
- `output_file` 正文读取。`system/task_notification` 帧的正文在该文件路径里而非帧内;读它需处理路径安全、文件已清理、大文件 IO。本版 `result` 对该路径留空,`progressSummary` 摘要仍显示。**下一版再做。**
- `tasks-snapshot` 正文按需拉取。用户已裁决快照照带全量正文(§3.2),真撑爆了再优化。
- 搜索命中任务输出。`hiddenByDefault` 会让搜索跳过这些行,用户已确认接受。
- `TaskRecordUi` 之外的新增字段(如 `resultTruncated`)。用户裁决全量存不截断。
- sidecar 写失败重试队列。fire-and-forget + `log.warn` 即可(§3.5)。

## 3. 设计

### 3.1 数据模型与持久化

`shared/tasks.ts` `TaskRecordUi` 新增:

```ts
/** 任务完成时的完整输出正文。XML `<result>` 内联提取;`system/task_notification`
 *  帧路径暂缺(正文在 output_file,见 spec §2 Out)。 */
result?: string
```

`server/task-result-store.ts` 新建,照抄 `server/result-frame-store.ts` 的 `PerSessionSidecar` 范式:

| 方面 | 决定 |
|---|---|
| 落盘 | `<stateDir>/task-results/<sessionId>.json` |
| 写入时机 | `applyTaskEvent` / 新的 XML 折叠每次改 `session.tasks` 后 fire-and-forget 写穿 |
| 写入语义 | 按 `taskId` **upsert**(非 append),原子 tmp+rename,写入串行化 |
| 截断 | 沿用 `MAX_TERMINAL_TASKS = 50`:终态记录保留最近 50 条,超出连 sidecar 一起删 |
| 权威性 | 内存 `session.tasks` 是运行时权威,sidecar 是它的持久镜像。**不做双向同步** |

store 的 load/append 需处理损坏 JSON(容错为 null/空,不抛),与 `ResultFrameStore` 行为一致。

### 3.2 数据来源与折叠路径

两种线形态能力不对等,这是本设计的核心不对称:

| | 正文 | 进 `session.tasks` |
|---|---|---|
| `system/task_notification` | `output_file`(内容不在帧里) | ✅ 已有(`applyTaskEvent`) |
| `<task-notification>` XML | `<result>` 内联 | ❌ 缺失 —— 本设计补上 |

**新增 XML 折叠点**:`server/session-pump.ts` 在 `isTaskNotificationUserMessage(msg)` 为真时,解析 `taskId` / `toolUseId` / `status` / `summary` / `result`,按 §3.6 的键规则 upsert 进 `session.tasks`,然后照常走原有 ring+broadcast。折叠函数独立导出(对齐 `applyTaskEvent` 的可测性),命名 `applyTaskNotificationInjection`。

`result` 填充优先级:XML `<result>` 内联(首选)→ 无则留空(不回退到 summary;`progressSummary` 已经有 summary,重复无意义)。

**`output_file` 暂不读**(见 §2 Out)。

### 3.3 transcript 过滤

过滤点选 `src/session-store/normalize.ts` `shouldHideByDefault`:`isTaskNotificationUserMessage(msg)` 为真即返回 true。与现有 `isLocalCommandLogUserMessage` 同级谓词,语义一致("这条不是 transcript 内容"),且 `pushRow` 已跳过 `hiddenByDefault` 行,无需另开分支。

**行为影响(用户已确认)**:
1. **failed / stopped 也一起消失**。此前 `failed`/`stopped` 刻意单独成卡且显眼("the failure 突出 half of the noise reducer")。此后后台任务失败**在 transcript 上无任何信号**,只能开 Tasks 面板看红色错误图标。
2. **搜索也搜不到**。`hiddenByDefault` 使搜索跳过这些行(`Chat.tsx` 的 `if (!item || item.hiddenByDefault) continue`)。正文改由 Tasks 承载后,transcript 搜不到任务输出。

**保留不动**:
- 磁盘 JSONL 该行 —— `session-manager.ts` `backfillSubagentCompletions` 靠扫描 seed 里的 XML 帧判断"完成信号是否已有"(`taskNotificationToolUseId`),transcript 磁盘行是它唯一判断依据。**磁盘保留,只是前端不渲染。**
- reducer 的 `activeSubagents` 合并(SubagentCard 不变)。探针已验证 `toTranscriptItem` 产出的 item 无论 `hiddenByDefault` 真假都进 store,`hiddenByDefault` 只 gate 渲染,不影响 `updateIndexesMirror`。
- `shared/user-frames.ts` 的分类谓词(server 与 MonitorBar 仍在用)。

### 3.4 死代码清理

按 YAGNI 与仓库"不留防御性代码"规矩删除:

| 删除 | 位置 |
|---|---|
| `willRenderEmpty` 的 task-notification 分支 | `src/components/message-list/rendering.ts` |
| `isTaskNotificationEligible` + `foldTaskNotificationRows` | `src/components/message-list/transcript-rows.ts` |
| `TaskNotificationGroupRow`(折叠行,即用户截图那个) | `src/components/message-list/views/frame-views.tsx` |
| `TaskNotificationCard` | 同上 |
| 以上对应的测试 | 各 test 文件 |

`buildTranscriptRows` 中对 `foldTaskNotificationRows` 的调用一并移除,`TranscriptRow.taskNotifGroup` 字段与 `MessageList` 的对应分支(`item.taskNotifGroup` 三元、`expandedNotifGroups`/`toggleNotifGroup`)同步删除。

### 3.5 错误处理

`TaskResultStore` 走 fire-and-forget(对齐 `ResultFrameStore.append`)。写失败**不影响运行时**(`session.tasks` 是权威),只 `log.warn`。下次同一 taskId 的 upsert 会重写该条。不加重试队列(§2 Out)。

### 3.6 边界:`<task-id>` 缺失

探针实测 `parseTaskNotification` 的真实约束:

| XML 形态 | 结果 |
|---|---|
| 有 `tool-use-id` + `task-id` | 解析成功 |
| 有 `tool-use-id`、无 `task-id` | **解析成功**(缺 task-id 是常态) |
| 有 `task-id`、无 `tool-use-id` | **返回 null**,整条丢弃 |

而 `session.tasks` 主键是 `taskId`,`applyTaskEvent` 对 system 帧直接 `raw.task_id` 必填。

**方案**:`taskId = task-id ?? tool-use-id`。`TaskRecordUi.toolUseId` 本就存在且被 SubagentCard join 用,反向兜底是同一坐标系,不产生两套 id。TaskRow 的 `description` 空时已有 `|| task.taskId` 兜底显示,无需额外处理。

### 3.7 `status` 缺失默认落 `failed`

探针实测:`<status>` 缺失时 `normalizeTaskStatus` 返回 `failed`(防误标绿勾,合理)。副作用:一条 `<status>` 写漏的 notification 会**在 transcript 上完全无影无踪**(§3.3 已确认 failed 也消失),只在 Tasks 面板留一行红色 failed。**这是可接受的**(真实失败同表现),显式钉下来避免日后当 bug 报。

### 3.8 TasksPanel 渲染

正文全量 stdout 可能到 MB 级,**按需渲染,不默认展开**:

| 方面 | 决定 |
|---|---|
| 出现时机 | **仅终态任务**且 `result` 非空时,行尾出现展开按钮 |
| 展开前 | DOM 里没有正文 —— 点开才渲染 |
| 展开后 | 行下方 `<pre>`,等宽字体、`max-height` + `overflow: auto` |
| 收起 | 再点一次卸掉正文节点 |
| `result` 为空 | 不出现按钮(`output_file` 路径的任务自然没有) |

**不复用 `FoldableBody`** —— 它是为 transcript 行设计的(高度测量 + 高度 tween + fold key 提升到 MessageList),在 overlay 面板里那套 scroll 联动没意义,且会把依赖拖进来。局部 `useState` 折叠即可。

布局:`result` 块跟在 `progressSummary` / `resourceLinks` 之后,同在 `tasks-row-main` 内。展开按钮放行尾,与现有 `.tasks-row-view`(磁盘 transcript)并排,两者同为"看更多"语义。子代理任务既有 `.tasks-row-view` **保留不动**(看过程),新增按钮是看 result;shell/monitor 只有展开按钮。

样式:新规则进 `tasks-panel.css`,颜色全走 theme 变量(`var(--fg-muted)` / `var(--bg)` 等),dark / light 两套都定义。

## 4. 设计取舍记录

- **快照照带全量正文**:用户裁决。`tasks-snapshot` 现为 `Array.from(s.tasks.values())` 全量下发,加 `result` 后完整 stdout 跟每次快照走 WS。已知风险,真撑大了再按需拉取(§2 Out)。
- **全量存不截断**:用户裁决。sidecar 可能膨胀,后续按情况优化。
- **`output_file` 留空**:本版不动。`system/task_notification` 路径的任务在 Tasks 里只有摘要无正文。**这是已知的能力缺口**,不是 bug。
- **过滤含 failed/stopped**:用户裁决 B 的直接后果,已二次确认。
- **搜索不可见**:用户已确认接受。

## 5. 测试

| 层 | 覆盖 |
|---|---|
| `TaskResultStore` | upsert 去重、cap 截断 50、原子写、损坏文件容错(null/空、不抛) |
| pump XML 折叠 | XML → `session.tasks` 填充;缺 `task-id` 时 `toolUseId` 兜底(§3.6);`result` 内联提取;`status` 缺失默认 `failed`(§3.7);折叠后写穿 sidecar |
| resume | sidecar load → `session.tasks` 恢复 → `tasks-snapshot` 下发含 `result` |
| transcript 过滤 | `shouldHideByDefault` 对 notification 为 true;item 仍进 store(reducer 依赖);§3.4 死代码已删且不复活 |
| TasksPanel | 终态行展开/收起;`result` 空不出现按钮;展开前 DOM 无正文(按需渲染);缺 `task-id` 兜底键的行能正常显示 |
| 回归 | SubagentCard 合并不受影响;MonitorBar 的 settled 判定不受影响;`backfillSubagentCompletions` 仍能扫到磁盘 XML 帧 |
