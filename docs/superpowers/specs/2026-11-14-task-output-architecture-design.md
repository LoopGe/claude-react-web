# 任务输出流架构设计

- 状态：proposed（实时输出等待上游完整 workflow 实时事件；终态 roster 分离已先行）
- 日期：2026-11-15
- 当前实现：终态结果使用有界 roster 投影与分页读取；WS 与 desktop IPC 写队列上限 64M 仅作最后保护；实时输出改造与数据迁移仍未启动

## 1. 背景与证据

`tasks-snapshot` 当前携带完整 `TaskRecordUi.result`。真实会话 `08fad444-a973-4cda-b752-5824e5680757` 的两条后台 vitest 输出分别包含 3,220,008 和 3,198,860 个原始字符，50 条任务记录组成的单帧达到 8,018,020 字符。独立 WS 订阅复现了服务端在发送该帧时以 `1011 write queue overflow` 关闭连接；客户端重连后再次读取同一快照，形成无限重连。

提交 `74aeca3e` 已把 `MAX_QUEUE_CHARS` 从 8M 临时提高到 16M。随后会话 `3a2f5b6b-d36b-4db2-a096-6e01f02b6e46` 的 51 条任务结果形成 **18,241,480 字符**快照，独立 WS 复验再次在 `tasks-snapshot` 发送时关闭连接；其中结果正文合计 15,178,970 字符，四条最大结果各约 3.5M。这证明任何固定上限都只是延迟故障。

为解除这一不依赖实时数据的故障，终态结果先行从 roster 分离：任务 fan-out 与初始订阅统一使用有界投影，小结果保持内联，大结果仅携带明确 partial 元数据而省略正文，避免旧客户端把截断尾部误当 canonical；完整 canonical 字符串仍由 live map/sidecar 持有，终态结果通过 UTF-16 分页 API 按需读取，live 缺失不得回退旧 sidecar，dormant/slept 读取不得 resume。客户端以 `resultRef` 保留 stopped-with-output 等生命周期证据，partial 预览不得覆盖 richer canonical 结果。WS 上限随后调整为 64M，但仍只作最后保护。

既有 [TasksPanel 任务结果设计](./2026-10-22-task-results-in-tasks-panel-design.md) 接受了快照携带完整正文和持久化全量输出。本提案取代这两项目标约束；终态 roster 投影与分页读取已先行落地，实时输出和存储迁移仍等待上游前置条件。

## 2. 目标

采用 DSH 的任务输出模型，覆盖运行中的实时输出和完成后的持久化读取：

- 任务清单只传生命周期和输出元数据，不传输出正文；
- 每个任务运行使用统一、绝对的原始字节 offset 和有界 OutputRing；
- 输出观察使用独立游标，具有明确的 gap、loss、reset 语义；
- 按需建立输出流，使用 ACK 背压和断点续传；
- 完成输出每个运行在 app-owned task-output 存储中最多持久化 64 MiB，历史高水位和淘汰通过 `earliest` 与 loss 标记表达；
- 客户端有界渲染，隐藏面板和非活动资源页释放观察；
- shell、Monitor、subagent、forked Skill、workflow 均有真实实时数据源，不以终态 artifact 冒充实时输出。

## 3. 实时输出仍等待上游完整能力

SDK 0.3.311 / CLI 2.1.311 存在以下数据缺口：

- CLI 从实时 SDK workflow progress 中过滤 `workflow_log`，`log/console` 不在实时事件内；
- workflow resume journal 只保存 agent 调用的 memoization 记录，无法恢复实时日志；
- 工具 stdout 通常只在完成后的 `tool_result` 出现，`tool_progress` 不含 stdout；
- 普通终态 artifact 可能包含日志，但失败或进程终止路径不保证存在；
- shell/Monitor 的 `getTaskOutput` 只返回最后 8 KiB，高吞吐任务在两次轮询之间可能产生无法补回的缺口；
- 解码文本长度不能可靠映射非 UTF-8 原始字节坐标。

因此，实时输出代码、OutputRing/journal 和旧 sidecar 存储格式迁移仍未启动，第 9 节的上游探针全部通过后才进入详细 TDD 实施规划。终态 roster 投影与分页读取是独立的先行修复，不改变原始 transcript/provider artifact，也不宣称提供实时流、原始字节游标或 64 MiB journal 保留模型。

## 4. 统一数据模型

### 4.1 输出与语义结果是两类对象

**原始输出**保存进程或 workflow 的原始字节，坐标只描述该原始流：

- `(sessionId, taskId, runId, revision)` 是输出坐标的基本身份；
- `total` 是已知高水位原始字节 offset，source gap 也推进 `total`；
- `earliest` 是当前最早可读取 offset；
- 每个 chunk 包含 `at`、`channel`、`byteLength` 和原始 payload；
- stdout/stderr 的 source offset 仅供适配器内部映射，线上只使用统一 run 级 `at`；
- `readFrom(from)` 非消费式读取，ring 未保留但 journal 可读的区间回源 journal，`from < journal.earliest` 返回 `lossy: true`，`from > publishedTotal` 返回 `cursor-ahead` 并要求重新 anchor，不得从未来位置等待而造成静默缺口；
- `unknownTail` 表示无法测量缺失长度，只使用 `totalKnown` 和 `incomplete`，不伪造精确高水位；发生 unknownTail 后必须封存当前坐标，后续字节只有显式 reset/新 revision 才能继续，不能在同一 offset 空间猜测追加。

**规范化语义结果**保存 assistant/subagent/Skill/Workflow 的报告及结构化 supplemental blocks，使用独立的 `normalized-utf8` 坐标：

- 不复用原始输出 offset，不把 decoded/CappedOutput 字符串追加到 raw journal；
- 保存 run/revision、内容代际 `resultVersion`、原始长度、规范化长度、缺口信息和全文摘要；
- 多 text block 分隔、trim、图片及其他 supplemental blocks 使用与现有 suppression 相同的规范化语义；
- 全文摘要在裁剪发生前计算，图片二进制使用带引用计数的 attachment/resource 引用，不内联到语义响应；
- `semanticIdentityOf()` 是语义身份唯一生成点，live、migration、disk replay、registry 和 fork 都调用同一函数。

### 4.2 有界资源

设计默认值：

| 资源 | 默认值 |
| --- | ---: |
| 运行中 OutputRing | 256 KiB 原始字节 / 运行 |
| 终态内存 OutputRing | 128 KiB 原始字节 / 运行 |
| 持久化 raw + semantic | 64 MiB / 运行（含必要元数据预留） |
| 输出 WS 帧软预算 | 64 KiB 原始字节 |
| 客户端渲染尾部 | 128 KiB UTF-16 code units |
| 默认 tail 观察滞后 | 256 KiB / channel |
| 单连接活跃输出观察 | 32 |
| 单连接输出订阅创建 | 120 次/分钟 |

原始输出、语义副本、supplemental blobs、临时 spool、索引和元数据均计入会话与进程 admission。这里的 64 MiB/run 与 256 MiB/session 是 **app-owned task-output 存储**预算；provider 已有 transcript JSONL、CLI output_file 等 canonical 原始 artifact 仍归 provider 所有，迁移不得改写或假装删除它们，也不承诺把这些既有文件计入后可减少 provider 总磁盘占用。app 副本最多受上述预算约束，原始 JSONL 只经流式 projection 读取，不能因保留 canonical 原件而再次整文件物化到大 roster。pin lease 有明确截止时间：默认 tail 到期释放；显式 `from:0` 的 full reader 在 lease 内不淘汰未读区间，但也不得让 raw+semantic+reserve 超过 64 MiB/运行；只有下一次 append 将超过上限且无法释放其他空间时才关闭该 full observation 并返回 `storage_exceeded`，恰好达到上限的已完成输出仍可 finalize、读取和 ACK。lease 到期后只允许显式 lossy 恢复，不能同时宣称无跳过。

小 chunk 在进入 source 队列前先合并；ring、wire、chunk 数量和序列化 JSON 尺寸均有上限。只淘汰已持久化内容，未持久化 source 内容只能背压，不能静默丢弃。

## 5. Roster 与生命周期

`TaskRecordUi` 不再携带 `result`，改为 `TaskOutputRef`：runId/runGeneration/revision、输出/语义结果可用性、格式、实时能力和持久化状态。`total/earliest` 仅是当次 roster anchor，实时值由输出 `opened/status` 返回。

- 输出追加不触发 roster snapshot、roster 持久化或任务 `updatedAt`；
- roster 在生命周期、run/reset、`resultVersion`、实时能力、持久化状态及 `progressSummary/lastToolName` 变化时更新；
- roster 使用 latest-only 的有界全量替换快照，按连接以 100ms 合并，未获发送机会时只保留最新完整集合；部分 baseline 在 complete 前保持不可变，后续 progress 只能进入下一 baseline，不能抢先失效或替换正在组装的 chunks；若必须分块，使用 `{baselineId, chunk, totalChunks, complete}`，客户端只有收齐同一 baseline 的全部 chunks 且其 taskEpoch 严格大于 `lastAppliedTaskEpoch` 后才原子替换 roster，迟到的旧 baseline 即使后收齐也必须丢弃，不能在 complete 前应用部分基线或让旧基线回滚新状态；
- 单帧默认不超过 256 KiB，`resourceLinks` 数量、URI/title 长度、自由文本、活跃任务数和历史元数据都有 admission 上限；roster 只内联预算内的 resource links，超额或单链接超限部分写入该 run 的 semantic supplemental blocks，并携带 `resourceLinkOverflow: {count, semanticRef}`，客户端通过第 6.2 节新增的最多 100 block/页的有界 supplemental 读取获取完整集合，不能直接裁掉 artifact。每 run 的 64 MiB 总预算先预留足够容纳上述链接数量/长度上限及必要 tombstone 的 metadata reserve，raw journal 只能使用剩余额度，不能在写满 raw 后才为必需 artifact 申请超额空间；
- 活跃任务数超过 admission 时以 `activeOverflow: true, overflowCount` 表示，并附全量计算的紧凑 `activitySummary: {active, nonAmbientActive, backgroundActive}` 与 active baselineId；计数不依赖已加载分页。并提供 `GET /sessions/:id/tasks/active?baselineId=&cursor=` 的有界 active-list 分页与既有 Stop 路径。首响应对 roster baseline 建立短期一致视图，keyset cursor 携带 baselineId、稳定 sortKey 与 taskId/run/revision，后续页面读取同一 baseline 而不是会移动的 offset；baseline 过期或客户端混用 baseline 时返回 409 resync。超额任务仍可查看和停止，不能只有计数没有控制入口。新客户端调用 `POST /sessions/:id/tasks/:taskId/stop` 时必须携带所显示行的 `expectedRunId/expectedRevision/expectedRunGeneration`；run-less legacy 行必须显式发送三个 null 并附 `expectedToolUseId/expectedRecordKey`，服务端只允许停止仍无 run 且记录身份匹配的当前执行，若它已取得 run 则返回 409，不能把缺字段当成 legacy 放行。服务端通过 provider 的原子 `stopTaskExpected({taskId, expectedRun...})` 在同一 run fence 内比较并停止，禁止 manager 先检查后调用 taskId-only `stopTask` 形成 TOCTOU；provider 不支持 expected-run stop 时，新客户端的 Stop 控件必须显示 unavailable，不能退回可能停止新 run 的操作。mismatch 返回 409 `stale-run` 和当前元数据且不得停止新 run；只有未实现 expected-run 协议的 legacy 客户端保留 taskId-only 停止当前 run 的旧语义。服务端另提供同 baseline 的批量 liveness 查询，按客户端现有候选 toolUseId/taskId/run 返回活跃身份集合；turn-end controller 必须在 dispatch sweep 前 prefetch 该查询，纯 `sweepAtTurnEnd` 只消费 reducer 输入中的已解析 liveness。liveness 尚未返回或查询失败时，overflow 候选保持原 running/background/pending 状态并标记 `livenessUnknown`，不得结算其自身或 children；响应到达后由独立 action 重新执行 sweep，禁止在纯 reducer 内发异步请求。`useSessionTaskCounts` 与 WorkingBubble 直接读取 activitySummary，TasksPanel 是否打开不影响这些生命周期消费者。
- 支持 roster ACK 的连接按 `{baselineId, chunk}` 释放 transport credit，迟到的 ACK 不释放新 credit；chunk ACK 只确认传输，不代表应用。客户端收齐同一 baseline 并原子提交 roster、sidechain enrichment 和 `lastAppliedTaskEpoch` 后，另发 `{baselineId, taskEpoch}` 的 `baseline-applied`；服务端只有收到该 applied ACK 才能清除对应 unacked-delta overlay，崩溃前只 ACK chunks 不会丢终态。重订阅 hello 携带 `lastAppliedTaskEpoch/baselineId`；若服务端重发相同 epoch，客户端不重复提交状态但必须幂等重发 applied ACK，服务端也接受该 baseline 的重复 applied ACK，不能因 ACK 本身丢失而反复要求 resync。超时、NACK、重订阅和 desktop fatal recovery 都使旧快照失效并恢复最新版本；失效 baseline 还必须从 transport 队列中移除所有已排队 chunks，不能只替换 scheduler 侧状态。未被客户端完整应用的 terminal tombstone、`resultVersion/semanticRef` invalidation 及 `persisted/retention/hasOutput/hasResult/live` 状态变化同时保存在该连接的 unacked-delta overlay，后续 baseline 必须继续携带，不能因全局终态 cap 淘汰而消失；overlay 有硬上限，超限关闭 channel 并要求带最后已应用 `taskEpoch` 的 resync。resync 从持久化 metadata delta log 补放该 epoch 之后的终态与语义 invalidation；若 epoch 太旧或服务端无法证明完整补放，先发送 `roster-reset-required`；客户端先以自己有未决 sidechain 的 taskId/toolUseId/run 集合分批查询同一 active baseline，结合 inline roster 建立有界 `resetActiveSet`，再只把 resetActiveSet 之外的未决 task-owned 记录按 `unknown-expired` 归一为 interrupted/estimated。这样 activeOverflow 中未内联的 Workflow、forked Skill 和 subagent 也不会被误终止；最后应用最新 roster，仍为非终态的精确 run/revision 匹配记录在同一 resetEpoch 中恢复为 running/background/pending 并清除 endedAt/estimated。reset 还必须失效所有已缓存 semantic body/resultVersion（包括已 done/interrupted 且已离开 roster 的记录），保留历史身份并标记 `semanticStale`，可见卡片按 historicalRef/semanticRef 重新读取最新目录，不能让 missed richer canonical v2 永远停留在 v1。
- legacy 不启用 roster credit，也不发送 baseline chunks 或 activeOverflow 部分 roster；只有完整旧式单帧不超过 256 KiB 且没有 active overflow 时才继续发送。安全范围内使用 latest-only 合并，终态 tombstone 在实际写入 transport 前保留在独立 pending-terminal overlay；overlay 的清除不删除持久化 metadata delta log。每次 legacy 重连都必须把持久化 lifecycle delta log 中的终态合并进同一个完整旧式 roster 后一次发送，因此已写入但连接中断的终态也不会依赖已淘汰 roster 记录；不能用单任务“增量快照”破坏旧客户端的全量替换语义。若恢复后的完整 roster 超过预算、需要分块或存在 active overflow，服务端在发送任何部分状态前改用旧客户端已能解析的 `legacyUpgradeSnapshot()`：一个稳定 synthetic failed TaskRecordUi（固定 taskId、短 description、`reason: 'upgrade-required'`、无 Stop 控制），每次订阅都重发这个小快照而不是原始大 roster，进入该模式时持久化 legacy-degraded 标记并清空此连接的 pending-terminal overlay，后续重连只依赖持久化 delta log，overlay 不得无限增长；让旧 UI 明确显示升级状态且不会形成 overflow reconnect；不得发送旧客户端会误解的分块/部分快照、未定义的新 frame，也不得宣称 legacy 在超出安全包络后仍有完整生命周期保证；
- 任何 run 的终态都写入 lifecycle tombstone，包含 toolUseId、runId/runGeneration/revision、终态、`isBackgrounded`、`hasOutput/hasResult`、`resultIsError`、`exitCode` 和时间；`TaskOutputRef` 同样保留 exitCode，确保无输出命令也能展开诊断。
- tombstone 属于同一 TASKS_SNAPSHOT 状态机，按持久化 `taskEpoch` 提交，不是第二套 isAsync 权威；每次 roster-visible mutation（start、progressSummary/lastToolName、run/reset、terminal、`resultVersion/semanticRef`、`persisted/retention/hasOutput/hasResult/live` 等）都递增 taskEpoch 并追加持久化 metadata delta log，纯输出字节追加仍不递增，重启恢复磁盘高水位，使断线客户端除终态外也能补放 richer canonical invalidation。单一 task metadata writer 必须先提交 delta log/manifest，再发布内存 roster 与广播；append 失败时保留有序 pending 队列并有界重试，不得先广播未持久化终态。持续失败标记 `metadataDurable: error`，并立即通过 provider task/control channel 停止该 session 的新 turn 与所有 task 执行，不能只停止 app 侧 admission 而让 CLI 继续生产无法持久化的生命周期；无法可靠 fence 时必须 interrupt/terminate owning provider session 并拒绝后续 turn，恢复日志不可得时显式报告 metadata loss，不能声称 current-run snapshot 能重建已经消失且未持久化的终态。恢复时结合磁盘日志与 provider current-run snapshot reconciliation，不能静默丢弃或重排终态；
- 对 taskOutputV1 连接，终态帧不得因 admission 被吞掉，必须预留容量或发送 overflow tombstone；legacy 超出上述安全包络时走显式 upgrade-required，而不是伪装完整交付。detach acknowledgement 始终携带 `isBackgrounded`、taskId 和可用的 runId/runGeneration/revision，供模型后续显式读取旧 run，不能只给 task_id 让旧输出无法寻址。
- tombstone 采用“持久化终态基线 + 增量”的压缩模型，并按 toolUseId 与 taskId 反查；只有 runGeneration/revision 匹配或无更新 run 冲突时才在 record 创建前应用，无法确定归属时保持 pending；
- `runGeneration` 取代现有 `isStaleRun()` 与 `applyBackgroundTasksChanged()` 的 runId 字典序判断。pump、background reconciliation、tombstone、roster 和客户端共享同一 run-order comparator：先比较 provider 的 runGeneration，再比较同 run 的 revision；只有双方都没有 generation 的 legacy 记录才保留字典序规则。已知 generation 的旧 run 不得因 runId 字符串较大而覆盖新 run。普通 provider 帧一侧有 generation、另一侧没有时 comparator 返回 `indeterminate`，不得猜测新旧或直接覆盖：单一 task writer 标记 `identity-insufficient` 并按 taskId/toolUseId 拉取 provider 当前 run snapshot 完成 reconciliation，解析前保持已确认状态并继续有界重试；snapshot 暂时 timeout 本身不得把仍可能活跃的任务写成 stopped/unknown-expired，只有 provider 权威证明执行已不存在或 owning session 已终止且无法恢复身份时才进入 unknown-expired。watcher 在 seed 时捕获当前 taskId/toolUseId/run/revision 与独立 watcherLeaseId，新 run/reset 立即作废旧 lease；其 legacy 合成终态只有 lease 仍对应当前记录且 taskId/toolUseId 精确匹配时才被 comparator 接受，不能把“无 generation 的 watcher 帧”作为普遍绕过规则；
- 元数据到期转为 `unknown-expired` 只适用于尚未确认身份或生命周期的记录；已完成/失败等已知终态必须保留原状态，不能因过期被改成 stopped。对未决记录，存储时同时写入 `status: 'stopped'` 与 `terminalCause: 'unknown-expired'`，客户端依据 terminalCause 映射为 `interrupted` 且 `endedAtEstimated=true`，不能退化成普通 stopped/hasResult 规则或绕过终态 cap。

## 6. 输出观察协议

新增独立于主会话 `startSession` 的协议：

```text
task-output-subscribe / unsubscribe / pause / resume
task-output-opened / output / display-reset / status / reset / error
task-output-ack / task-output-display-ack
```

### 6.1 身份与初始读取

普通与历史订阅都包含 `sessionId` 和客户端生成的 `observerKey`；当前 run 使用 `taskId/runId/revision` 寻址，roster 已淘汰的 raw 或 semantic 结果都可使用 `historicalRef`，语义结果另允许 `semanticRef`。每个浏览器 tab 在首次连接时生成随机 `clientInstanceId` 并在 WS 重连间保持，observerKey 必须包含该 id 与 registry key；恢复 manifest 以 `(sessionId, clientInstanceId, observerKey)` 唯一索引，不同 tab 永不共享游标；只有同一活跃 connectionGeneration 内的重复 key 才拒绝，断线后的新 connectionGeneration 使用相同 key 时使旧连接失效并恢复既有 manifest/streamId 与游标，不得当作重复订阅拒绝。引用订阅由服务端解析为不可变的 run/revision/channel 身份，解析失败或引用已删除时显式返回 `not-found`，不得退回该 task 的最新 run。客户端不要求预先持有 streamId，服务端在 `opened` 首次签发全局 streamId，后续 ACK/恢复复用该 id。连接初始 `hello/capabilities` 握手在任何 roster/projection 前完成 `taskOutputV1` 协商；未发送 hello 的旧连接按 legacy 处理，继续提供小结果或升级提示，不得因等待能力声明而完全不发送 roster。后续订阅必须匹配该版本，未声明能力的客户端只能走 legacy 小结果或升级提示，不能靠首次 output-subscribe 才发现不兼容。`streamId` 由服务端全局签发，恢复 manifest 以稳定 `observerKey` 关联，connectionGeneration/streamId 仅作代际别名。

App Plugin 不经过 WS hello，因此在 `sessions.subscribe` 参数中显式声明 `capabilities: ['taskOutputV1']`；宿主 registry 以 `(pluginPeer, sessionId)` 保存完整 capability set，同一集合的重复调用保持幂等，不同集合返回 `capability-conflict` 且不改变现有订阅，不能由先调用者悄悄决定另一 feature 的事件形状。升级不得先 unsubscribe 留缺口；调用方显式使用 `sessions.subscribe {replace: true, previousGeneration, sinceEventCursor}` 原子替换该 peer/session 的 capability set，服务端先 fence 旧 generation、安装新 projection，再从旧订阅游标重放 message ring 与 task metadata delta log，最后解除 fence。每个 `sessions.event` 携带单调 eventCursor/subscriptionGeneration，无法完整重放时返回显式 `resync-required`，不能静默丢失替换期间的终态。声明后 `sessions.event` 只携带 outputRef/语义引用，插件通过新的 `sessions.readTaskOutput` Host API 使用同一 run/ref、cursor、有界页面、timeout 和背压契约读取，权限仍要求 `sessions.read`。未声明能力的 legacy 插件继续获得预算内小结果；大结果只收到有界兼容摘要、`resultTruncated: true` 与 upgrade-required 元数据，不能发送完整大 JSON-RPC notification，也不能静默删除结果可用性。框架验收必须扩展 `fixture.session-subscription` 覆盖两种协商和分页读取。

每个 observer 只订阅一个 channel，与客户端 registry key 一一对应；合并视图由客户端组合多个单 channel 观察。registry key 同时包含 channel、anchor（tail/full）和内容代际。

首次 raw 观察未提供 `from` 时，沿该 channel 的 source-to-global 映射向前回溯最多 128 KiB 的该 channel 原始字节作为 tail anchor。文本投影必须由 provider 编码元数据对应的 boundary scanner 选择可初始化解码器的安全锚点并给出初始 decoder state；例如 UTF-8 可在 journal 中向前补读至完整 leading byte，不能让新 decoder 从 continuation byte 开始。无法验证边界或初始状态时保持 raw/hex-only 并显式标记 leadingPartial，不得制造 replacement character。`from:0` 表示 full 分页读取，registry 不保留完整输出；早于 `journal.earliest` 时返回 `lossy: true` 和实际 earliest，不能当成完整输出。

semantic tail 使用独立锚点：按 UTF-8 codepoint 安全边界回溯最多 128 KiB normalized 文本得到 `semanticCursor`，supplemental block 必须带 semantic text anchor/ordinal，`opened` 同时返回覆盖可见尾部引用的 `supplementalEarliest/supplementalHighWater`；更早 block 不随 tail 全量重放，full semantic reader 才从两个坐标的零点读取完整目录。

### 6.2 帧、ACK 与背压

观察顺序：

1. 先安装事件监听，再读取 anchor，避免首次读取与等待之间丢失追加；
2. `opened` 返回当前元数据和实际起点；
3. `output` 携带单 channel 的原始字节 chunks、`next` 和可选 `lossy`；
4. 一个读取拆成多帧时，每帧 `next` 是该帧最后一个 chunk 的末尾；尾部已知 gap 使用空 chunks、单 channel 和 `next: channelPublishedTotal`，`channelPublishedTotal` 是该 channel 映射后的全局高水位。语义结果使用独立 `semanticCursor`：normalized-utf8 文本 offset 用于文本重放，supplemental blocks 以带 ref/digest 的元数据帧和独立有界资源读取表示，不能复用 raw channel offset，也不能把图片当成 raw chunk。
5. 每个观察合计最多一个未 ACK 帧，raw 与 display 二选一；同一连接设置公平调度的总输出窗口（默认最多 2 帧且合计不超过 128 KiB），按 observer 轮转并记录 aging；
6. provider 最终读取、journal finalize，以及覆盖最终 fence 的原始字节 ACK、display replacement ACK 全部完成后，才发送终态 `status`；只有当前存在活跃 semantic observer 时，才额外等待对应 `semanticCursor/resultVersion` 与最终 `supplementalHighWater`/digest 清单的确认，collapsed 或非订阅语义预览不阻塞终态；终态不等待尚未开始的 lazy blob 下载，但 final manifest 必须保留这些 digest 引用，observer 关闭不等于删除 blob，后续 semanticRef/historicalRef range read 仍可解析，配额逐出必须显式记录 loss，已开始的读取由 lease 保护。`unknownTail` 在已知边界 ACK 后发送 `incomplete`；
7. ACK 超时只结束当前观察并发送 `incomplete`，不关闭主会话或全局连接；客户端从最后 ACK 的游标重开。desktop IPC fatal recovery 即使在同一 MessagePort 上重订阅，也必须先发送 transport reset，使服务端递增 connectionGeneration、作旧全部 outstanding frame 并丢弃其 transport 副本；随后复用 observerKey 按新 generation 恢复 manifest，不能在同一 generation 内把恢复订阅当作重复 key 或继续等待已丢帧 ACK。

ACK 必须匹配 `connectionGeneration + streamId + runId + revision + channel + frameId + next`，语义结果额外匹配 `resultVersion + semanticCursor`，旧结果代际不能确认新内容；迟到、重复或超前 ACK 不得前进、回退或释放窗口。reset/timeout 除释放 credit 外，还必须让 transport 按 stream/frame 丢弃尚未发送的旧 frame。

语义正文与 supplemental 元数据通过同一观察协议分页：每个 semantic frame 的文本最多 48 KiB UTF-8，block 描述最多 16 KiB 或 100 个（以先达到者为准），序列化帧总量仍受 64 KiB 软预算与连接窗口约束；单个超大描述只发送有界 resource ref，不突破帧预算。`semanticCursor + supplementalHighWater` 共同定位下一帧。reducer/card 的非订阅预览使用 `GET /sessions/:id/task-output/semantic?semanticRef=&cursor=&limit=`，其文本响应最多 128 KiB，block 分页遵守同一数量/字节上限；图片等大 blob 先通过 `POST /sessions/:id/task-output/resource-leases` `{semanticRef,digest}` 打开读取，服务端校验引用并返回 `{resourceLeaseId,size,expiresAt}`。后续 `GET /sessions/:id/task-output/resources/:digest?resourceLeaseId=&offset=&length=` 默认每响应最多 64 KiB，每次读取续租，显式 close 或 idle 到期才释放，崩溃后的过期 lease 不阻止回收；所有 range 必须属于同一 lease/digest，不能一次返回完整图片或由客户端传任意存储路径。

输出通知只存在于服务端内部，使用 dirty-flag waiter 和 25–50ms 合并窗口；不得复用会丢弃旧消息的 `Pushable` 传输输出 delta。observer 数量、创建速率、待写队列、raw payload、序列化尺寸和 manifest 数量都有上限，超过时显式拒绝，不能靠内存溢出保护。

### 6.3 display replacement

编码分类变化使用 `display-reset`，只重置对应 channel 的文本投影，不修改原始游标和 registry key。replacement 复用普通 `task-output-output` 的 `mode: 'replacement'` 与 `displayRevision`，复用同一帧结构、ACK、offset 去重和 pin 规则。

- `replayFrom` 是 journal 可读的较早 anchor，`displayCursor` 与 `replayFence` 都使用原始字节 offset；
- display reset 只建立本次 projection 的 replay 区间和独立 `replacementCursor = replayFrom`，不提前推进 raw consumed cursor；replacement 的绝对 offset 去重只对照该 displayRevision 的 replacementCursor，不能与此前已消费的 raw cursor 比较。full 模式保留独立的原始 full cursor 和完整分页，replacement 不得跳过其未读原始字节；
- `task-output-display-ack` 携带 displayRevision，旧 displayRevision 的帧和 ACK 都丢弃；
- 当前最新 displayRevision 的 replay 完成后才满足终态条件，被取代的 replay 明确取消；
- display replay 期间暂停对应 channel 的新原始帧，完成后仅对默认 tail 设置 `rawSuppressUntil = replayFence`，不重复播放已覆盖区间；full 模式不使用 rawSuppressUntil，其完整原始流继续按 full cursor 读取；
- observer 的投影 span 随 ACK 移动并持有 pin，reset 时更新 replacement 覆盖范围；
- 单次 replay 覆盖被替换投影的完整原始字节跨度，不能把 128 KiB 原始字节误当成等长 UTF-16 文本；
- display revision 按 channel 至少 1 秒去抖，持续编码抖动时停止新 replay、标记 `displayUnavailable` 并保留原始字节读取。

未声明编码时不运行实时自动解码和 display reset，只有 provider 显式声明的编码变化或用户主动改变编码选择才触发。原始字节/十六进制视图，或已经具有明确编码的终态解码结果与既有 `normalized-utf8` 语义文本，是其 fallback；未知编码的原始字节在终态后也不得猜测解码。

### 6.4 Pause/resume

`task-output-pause/resume` 以稳定 observerKey 保留 cursor、manifest 及每 channel 的解码器状态与未决字节，恢复时不能从 continuation byte 新建解码器；pause 先释放 outstanding frame 并让 transport 丢弃未发送副本，恢复后重新调度，pause 期间不计 ACK timeout。

任何显式 pause 最长 60 秒，超时由服务端关闭 observation 并释放输出窗口与 pin，不能只暂停 ACK timeout 而让终态和存储永久等待。`panelVisible=false` 的 keep-alive pause 与显式 unsubscribe 不同：pause 保留 manifest，但超过 60 秒不可见时关闭 observation 并释放输出窗口；manifest 的 dormant 保留期默认 24 小时，超时删除并在下次打开时全量重建。

默认 tail 在 pause 超 lag/pin 预算时按最新 anchor reset；显式 `from:0` full reader 不跳最新 anchor，但 pause 到期同样必须释放 pin，恢复时按保存的 full cursor 重新建立 lease，若该 cursor 已低于 `journal.earliest` 则返回 `lossy: true` 和实际 earliest，不能承诺无跳过。

## 7. Provider 数据源

- **Claude shell / Monitor**：现有 `Query.getTaskOutput` 只能作为能力探测，不能单独承担完整输出源。正式方案需要有序 `task_output_chunk` 或任务开始时暴露可增量读取的输出路径，返回 byte-preserving payload、绝对起始 offset 和每 channel 编码元数据。覆盖后台启动、Ctrl+B 和终态最终读取；Ctrl+B 时必须提供从执行开始累计的完整输出或可重放历史。
- **Native shell**：工具执行开始时就由 `NativeTaskManager` 建立输出 run 并转发真实 stdout/stderr chunks，不能等 Ctrl+B 的 `task_started` 才建流；detach 只把既有 run 暴露到 roster，必须保留 detach 前输出；未 detach 完成且 canonical 已可寻址时立即回收 speculative journal，只保留 transcript 引用；speculative run 在未 detach 前不写 lifecycle tombstone，不能让普通前台完成挤占任务元数据。speculative run 使用进程配额内的 active-execution reserve，不与 retained 输出、fork 或 full-reader pin 争用历史保留空间；reserve 不足只禁用本次 pre-detach replay 并标记输出能力不可用，不得背压或失败普通前台工具。此时 detach 必须在 acknowledgement 前返回 `storage_exceeded`；允许 detach 前必须先取得 retained admission/lease，不能 ack 后再丢失 pre-detach 输出。模型侧 `CappedOutput` 行为保持不变。原始 stdout/stderr 与 decoded/CappedOutput 结果使用不同 lane。
- **Native Agent**：与 native shell 一样在 Agent 启动时建立 speculative run，使用同一 active-execution reserve 和 detach admission 规则，记录 sidechain frames，detach 后按既有 run 继续，不能把 pre-detach 输出留给不存在的 transcript tail。
- **Subagent**：使用结构化 transcript，而不是 shell 输出 API。Claude 侧从 `server/subagent-watcher.ts:289` 的 `TranscriptTail` 提取共享的原始字节 file-tail primitive，复用 offset、序列化读取、shrink 检测和 partial-line 处理，并把 `ClaudeSubagentTranscriptHub` 的 inode/replacement 检查一并纳入；同 inode 重写使用 writer generation 或全前缀 digest 作为最终判定，增量 hash checkpoint 仅用于降低 I/O；无法验证完整性时必须标记 `identity-insufficient` 并 reset，不能凭有限窗口拼接不同代际。原始字节发布不等待换行，JSONL 语义 parser 的 partial-line 状态与 raw 发布分离并受独立预算约束，不能让未终止的大记录阻塞 raw 输出或藏在 source queue 外。
- **Forked Skill**：以 Skill toolUseId 作为 sidechain 根建立输出 run，直接消费宿主 SDK 的 normalized-utf8 事件流，不要求存在 subagent transcript 文件；该源只进入 semantic lane，按实际 UTF-8 bytes 计算 `semanticCursor/byteLength` 和 supplemental ordinal，不得虚构“应用事件 offset”充当 raw `at`。没有 byte-preserving 原始源时不建立 raw OutputRing，raw 能力明确为 unavailable，语义报告仍可按独立坐标分页；非 forked Skill 仍只加载上下文，不创建任务输出。
- **Workflow**：使用第 9 节要求的上游事件。`task_started.tool_use_id` 与 Workflow 侧链根关联，父子关系使用 `parent_tool_use_id`；不得依赖可能缺失的 `parent_task_id`。task run ID 与 workflow resume ID 分开建模。
- **Orphan notification**：无 `<tool-use-id>` 但携带非空白 `<result>`、monitor `<event>`，或携带经上游签名/结构化字段明确声明原始 payload presence/kind 的 outputRef 时才建立 synthetic orphan outputRef；`classifyTaskNotificationInjection()` 的 `hasPayload` 必须来自原始非空 payload 或该可信 ref 元数据，不能因为剥离后只剩 ref 就改判为 status-only，也不能把没有 payload 证据的普通 status-only ref 当作有正文。仅空白 payload 的 status-only 通知继续隐藏。Monitor 事件必须以 transcript occurrence 作为身份，同一 task-id 的不同事件不得共享或覆盖；只有确实唯一的 subagent completion 才可复用稳定 task/agent 身份。预算内小结果继续内联，大结果只通过 ref 读取，不能因正文剥离而隐藏行或保留原始大帧。
- **模型侧 `TaskOutput`**：`server/providers/native/tools/task-output.ts` 与 `createTaskOutputTool.run` 必须同步扩展 schema 和转发，支持 `cursor/runId/revision/historicalRef/outputMode/channel/wait/timeout`，其中 raw `channel` 为 `merged | stdout | stderr`，默认 merged；merged 使用统一 run 级 `at` 游标且每个 chunk 保留 channel，单 channel 读取也使用全局 `at` 过滤后的 next，不得另造拼接文本长度游标。model cursor identity 必须包含 channel，host bridge 原样转发，不能只改概念。Claude 的 CLI-owned 工具不得直接猜测 app 文件布局，必须通过版本化 SDK host bridge（`task_output_read` control request）把 consumer identity、run/ref、cursor、outputMode、channel、wait 和 timeout 委托给 app catalog/输出服务；bridge 响应使用同一有界页面和错误语义，CLI 不另建一套本地 historicalRef 解析。native shell 读取当前运行原始输出的独立 model cursor；model consumer identity 取现有 `historyKey`，main 与 nested Agent 使用不同 consumer key，不能按 task 共享分页位置或 outputMode。native Agent/Subagent 读取独立的语义报告，不能把内部 JSONL frame traffic 当成最终报告返回。`TaskOutput` 调用先按 task_id 在 historical metadata index 解析；存在多个 run 时使用第 5 节同一 run-order comparator 选择当前 run，legacy 无 generation 时也按该规则处理 runId，旧 run 必须显式提供 runId/revision，不能默认返回任意历史结果。无 cursor 的 legacy 调用在运行中继续返回现有 running 提示，终态小结果继续返回现有 `terminalOutcome`，大结果只返回有界兼容页、明确截断标记和 `outputMode: 'pages'` 的续读提示，禁止把完整历史正文重新物化为单个 tool_result；`block: true` 继续等待终态。一旦创建 pages model cursor，该 consumer 后续省略 outputMode 时沿用 pages 模式，不得退回 legacy running 文案或重置输出；`wait: 'next-page'` 等待下一页或终态/incomplete/reset，最后一页之后的终态必须立即唤醒并返回不含输出正文的 pages `terminalOutcome`（终态、exitCode、finalCursor、loss/hasMore），不能把已分页的大结果重新拼回 tool_result。`block: true` 与 `wait: 'next-page'` 共用现有 `timeout` 参数，默认 30,000ms、最大 600,000ms；超时返回 running/当前 cursor 与已读元数据而不是无限等待或重置分页，调用方 abort 同样不得破坏已持久化 cursor。模型输出只在 provider 显式提供编码元数据，或应用/用户明确配置默认编码时发布实时或终态原始字节文本页；未提供编码信息且未配置默认值时，原始字节只能使用 raw/hex 读取，实时与终态都不得猜测解码，既有 `normalized-utf8` 语义结果不受此限制。`block: true` 与 `wait: 'next-page'` 互斥，组合输入抛出 `ToolInputError`。

provider 输出文件不得再使用无界 `readFile(path, 'utf8')`。raw text、JSONL、JSON、空文件和缺失文件按任务类型处理；终态 reconciliation 使用有界增量读取并验证重叠区域；无明确 source reset 证据时表示不一致统一标记 `durable: corruption` 并停止写入，不能擅自增加 revision 或拼接冲突内容。

## 8. 持久化、迁移与客户端

### 8.1 Journal 与恢复

现有 `task-results/<sessionId>.json` 逐步改为仅保存任务元数据。新增 app 所有的 `task-outputs/<sessionId>/...`，使用分段二进制 journal 和原子 manifest，记录任务/run/revision、格式、全局 `total`、`earliest`、持久化状态，以及每个 channel 的 source 高水位和 source-to-global 映射。

- manifest 使用分段索引、追加式历史和定期 compaction，不能逐次原子重写全部历史；
- 恢复按会话首次读取或写入时懒执行，不在服务启动时扫描全部历史 journal；native respawn 对磁盘已知 active 但当前 NativeTaskManager 不拥有的执行，沿用现有 `stopped + reason: 'worker_restart'` 终态 reconciliation：先持久化 tombstone/taskEpoch，再 finalize 输出为 incomplete、唤醒 block/next-page readers 并标记 endedAtEstimated，不能把已知 active 错交给 unknown-expired 或永久等待 provider final read；
- segment append 与 manifest 高水位持久化后才发布到 ring/observer，ACK 不得越过 durable `publishedTotal`；
- 每会话统一 commit scheduler 按 25–50ms 或 64 KiB 聚合高水位更新，source 使用有界待写队列和 pause/resume 背压；
- 头部淘汰先记录该 generation 的连续 `pruneHighWater`，再删除旧 segment；manifest 引用的头部缺失时保留 `total` 并显式推进 `earliest`/gap；
- segment 完整性检查只能采纳到较早已知边界时，保留已发布高水位，将可测量缺失区间记录为显式 gap，新写入只能在该坐标之后继续；缺失长度未知或重叠字节冲突时按 `unknownTail` 封存或 `durable: corruption` 停止，禁止猜测 offset 追加。
- journal append/finalize 失败时，短暂错误按有界退避重试并暂停对应 source；每个 source chunk 以 `(runId, revision, channel, sourceOffset, byteLength, digest)` 生成确定性 appendId，segment record 同时记录目标全局 at。重试先检查 segment tail 与重叠区：相同 appendId/digest 的已写记录只补交 manifest/usage，不再次 append，未提交的孤立 tail 可验证后采纳；重叠字节不同则 `durable: corruption`，不得推进 offset。持续错误把运行标记为 `durable: error`，解除 source await、drain/discard 或以错误终态结束 observer，不能永久楔住子进程或 finalizer；
- 进程级配额使用持久化 global usage ledger + 有界 usage WAL，不声称跨 segment/ledger 文件具有天然原子性：先在 WAL 同步写入带 appendId、session/run/segment、bytes 与 op 的 intent，再写 segment，随后提交 usage ledger，最后标记 intent done；崩溃启动只重放紧凑 WAL/deletion journal 并对 intent 引用的 segment 做定点校验，不扫描全部历史 journal。未 done intent 按实际 segment/ledger 状态幂等补齐或回滚账面，WAL 定期在 ledger 高水位提交后 compaction，因此 lazy session recovery 不会让全局配额短暂失真。删除同样先记录 deletion intent，崩溃后续清理，避免磁盘已删空间与账面扣减不一致。活跃执行占满配额且无可淘汰 generation 时先施加 source backpressure，持续无法写入时优先结束超限 observer 并返回 `storage_exceeded`，不能只结束慢读者却拖垮整个任务 source；只有没有 observer 可释放时才按 `durable: error` drain/discard，新增运行返回 `storage_exceeded`。
- 语义存储与原始 journal 合计每运行 64 MiB，另设每会话 256 MiB、进程 1 GiB、副本数量与元数据字节 admission，live 写入与 legacy 迁移共用同一单运行上限；pin 防止对应区间被回收，但不能豁免第 4.2 节的存储上限。配额持续不足时可结束超限 observer 并返回 `storage_exceeded`，不得中断底层 source、静默跳过读取或让已保留数据无界增长；
- 语义副本、supplemental blobs、spool 和临时文件均计入对应配额，blob digest 在 catalog 中只计费一次。

- fork 请求先在每个 source queue 插入有序 barrier，捕获请求前最后的 source sequence/event fence；barrier 后产生的字节标记为 post-fork。source 必须继续提交到 barrier 为止，fork 等待这些 pre-fork pending bytes 全部 durable 后才建立 `forkFence = publishedTotal`，不能只读取请求时尚未追上 source 的旧高水位。同一屏障还捕获 `{resultVersion, semanticCursor, supplementalHighWater}` 作为 semantic fork fence；fork 的 semanticRef 是该版本的不可变前缀视图，后续同版本追加越过 semanticCursor 的内容和更高 resultVersion 都不进入 fork。fork manifest 只暴露各 fence 前的字节与语义内容。raw journal 的 sealed segment 与 active segment 中已 durable 的 `[offset, forkFence)` 范围都建立引用计数/lease；active segment 后续 append 不进入 fork 视图，后台 compaction 可把被引用范围复制为 sealed segment 后再释放源 segment。fork 的 TaskOutputRef 解析到 fork 自己 manifest 或共享 byte range/blob，fork 后继续执行必须创建新 run/revision；source 永久删除只减少 source 引用，不能让 fork 的 pre-fork raw 输出失效或混入 post-fork 字节。
- 每个 session 首次创建时分配并持久化 `sessionStorageGeneration`，普通进程重启、resume 和 respawn 保留同一 generation，因此跨重启输出仍属同一所有者；只有已删除 session 的同 id create/revive 才分配新 generation。task-output manifest、catalog owner、fork lease 与 deletion journal 都携带 `(sessionId, sessionStorageGeneration)`，物理路径可使用该 generation 分区。delete tombstone fence 并清理该 session 当前及历史持有的全部 storage generation；同 id revive 的新 generation 不被旧 deletion journal fence 或清理，正常 resume 不得无故换 generation 制造孤儿。普通从列表删除也按引用清理这些 task-outputs 与语义存储；删除先写 delete tombstone 并取消/等待在途 commit，后续迁移和 manifest/segment 写入必须被对应 generation fence，不能在清理后重建文件；deletion journal 必须支持崩溃后的续清理，未删除会话不需要启动扫描，但崩溃时已删除 generation 的残留可由该 journal 发现和回收。`historicalRef` 不是永久所有权：catalog 为每个引用记录 ownerSessionId 与 transcript occurrence，fork 取得独立引用，活跃读取只持有有截止时间的 lease。删除 owner 时移除对应引用，只有其他仍存在的 session/fork 引用或未到期读取 lease 才暂时保留 blob；lease 到期后回收，最后一个引用随 TaskResultStore 删除，不能让删除会话长期遗留无主输出。

### 8.2 迁移

旧 sidecar 迁移必须幂等、流式读取并持久化每个来源的 generation、record key、截断前 `sourceDigest`、实际保留 blob 的 `contentDigest` 和读取位置；sourceDigest 只用于来源去重与完整性 provenance，contentDigest 才是 retained blob 的寻址和读回校验摘要，截断时二者不得混用。checkpoint 不得只记录可被全量替换文件失效的字节 offset，重启时先校验来源 generation，不匹配则从对应 record key 重新读取而不是 seek 到旧 offset：

1. 先合并当前 live roster 内存状态，再合并 sidecar、app transcript JSONL 与仍存在的 provider 输出文件；live roster 是尚未落盘结果的权威来源。`flush` 或已排队 save 的任何失败必须中止迁移并保留原结果，不能按日志中的“完成”继续剥离。迁移前除读取 persistence error 外，还必须按 live roster 与来源内容验证 save 完整性；日志缺失、日志轮转或无法证明旧写入成功时只允许 legacy-only 迁移，禁止剥离原结果。
2. 同一结果的更丰富 canonical tool_result 优先，supplemental blocks 按稳定身份合并去重；app transcript JSONL 同样使用流式记录解析和字段提取，不能因单条大通知而整行物化；provider 文件只能有界增量读取，不能整文件载入。sidecar 不是唯一迁移来源，已被 50 条 cap 淘汰的旧通知以及 text+image 等结构化结果都要尽可能恢复 canonical 内容和 supplemental blocks，不能在 disk projection 删除原正文后丢失。
3. 将合并后的结果写入确定性的 legacy journal，并先持久化所有 manifest。所有迁移结果同时建立 historicalRef，使其在离开 roster 后仍可按 transcript/历史任务身份寻址，不能立即落入 roster-only GC。会话 256 MiB 或进程配额不足时，先为迁移清单中的 `migrationPreserve` 记录预留完整正文空间，本次事故会话的两条约 3.2 MiB 结果属于该集合；随后按“最旧、已终态、未 pin 且不在 migrationPreserve 的历史代际优先”执行确定性逐出，保留 historicalRef、sourceDigest、total/earliest、`retention: 'evicted'` 与 loss 元数据。若 required-preservation 集合本身无法取得配额，迁移返回 `storage_exceeded` 并保留原始 sidecar，不得逐出这些验收要求完整保留的结果。被逐出正文读取返回明确的 `evicted`，不能因单个结果低于 64 MiB 就让迁移永久无法完成，也不能继续保留大 roster。活跃 run、fork/reader pin 和必要元数据不作为逐出候选。legacy decoded subagent 结果只写一份 `normalized-utf8` content-addressed blob，raw 兼容视图与 semanticRef 共享该 blob，catalog 按 digest 只计费一次，不得为同一文本制造 raw/semantic 双副本；provider 原始字节仍存在时才另建 raw journal，派生语义副本与 raw 合计受 64 MiB 上限约束，超出时优先保留 raw，语义侧保留有界尾部和全文摘要并记录 loss。subagent 必须调用 `semanticIdentityOf()` 建立语义身份，不能只写原始任务 journal。
4. 验证所有恢复来源都已达到持久化高水位，且每个结果都有 durable blob 或 durable eviction/loss 记录后，才原子重写不含 `result` 的 roster；`writeAtomic` 除 delete tombstone 外还必须携带 expected roster generation，并由单一 roster writer 串行提交内存与磁盘版本。
5. 崩溃后从最近 checkpoint 增量合并新来源与既有 generation，不重复全量读取；若内容从 summary 升级为 richer canonical，则写入新的不可变内容代际并以 `supersedes` 指针切换，不原地替换已共享 blob。代际切换先取得 raw+semantic 与进程配额 admission，并优先回收未被 pin 的旧代际；仍被 fork/reader pin 的旧代际不得删除，若因此无法容纳新代际则保留当前 resultVersion、标记 `semanticUpgradePending/storage_exceeded` 并在引用释放后有界重试，不得超配额或让旧引用失效。切换成功后仍有引用的旧代际及已有 fork 引用保持可读；每次成功切换还增加 `resultVersion`，并在同一事务中递增 taskEpoch、追加 metadata delta log 与触发 roster/semantic invalidation。
6. 两条约 3.2 MiB 的历史结果必须完整保留；超过 64 MiB 的单一 decoded legacy 结果按上限保留 `normalized-utf8` 尾部，offset/contentDigest 只描述该规范化保留内容，截断前全文仅记录独立 sourceDigest、原始长度与 loss；raw 与派生语义同时存在时按上一步的合计预算裁剪，不能把“原始结果小于 64 MiB”误当成双副本也不超限。截断仅通过 loss 元数据和兼容展示字符串中的标记表达，不向 journal 注入合成 marker，保证 offset 与 contentDigest 不再冒充原进程字节。
7. 迁移中止时允许 `hydrateTasks` 以同样的流式只读路径恢复 legacy sidecar，不能因为禁止整文件 `TaskResultStore.load` 就让完整历史不可见。
8. fork 继承任务结果前必须调用同一 `ensureTaskOutputMigration`/reference 流程，禁止 `SessionManager.fork` 直接 `TaskResultStore.load` 后复制完整 sidecar。迁移因配额或持久化错误未完成时 fork 返回明确错误且不创建 fork 副本，源 session 保持不变；成功后 fork 只继承第 8.1 节的 fenced refs，不能绕过 checkpoint、quota 和 historicalRef 创建另一个大 roster。

legacy decoded strings 只能作为 `normalized-utf8` 应用文本保存，offset/contentDigest 描述该规范化保留内容而非原进程原始字节；原始文件已存在的 replacement characters、CappedOutput elision marker 等必须作为 loss 元数据保留，不能把有损重建宣称为原流。

### 8.3 客户端与语义恢复

新增 framework-free 输出模型、使用 tagged union key 的引用计数 registry、`useTaskOutput` 和共享输出视图：

- `opened` 安装 anchor，重连时保留已接受文本；
- `output` 追加并推进 ACK 游标，重复或重叠帧按绝对 offset 处理；
- `reset` 清理旧 run/revision 状态；
- 文本超过 128 KiB 时按 UTF-16 surrogate 安全截断并显示缺口；
- Tasks overlay 隐藏、行折叠、资源页切走或最后一个 observer 释放时退订；`Chat.tsx` 必须把 `panelVisible` 传入 TasksPanel，`panelVisible=false` 时即使 keep-alive 组件仍挂载且 `tasksPanelOpen=true` 也必须暂停观察，恢复可见后按 cursor 重开；
- 大 orphan notification 的 neutral-card 分支必须识别可信 outputRef，并以 occurrence/historicalRef 调用 `useTaskOutput` 和共享输出视图；正文被剥离后不得继续渲染 reference XML 或当成 status-only，Monitor event/result 可从该卡打开完整有界内容；
- shell 输出按纯文本渲染，保留 escape sequences，不当作 Markdown；stdout/stderr 使用独立 channel 投影，合并视图按 `at` 做有序插入；
- 语义预览另设每会话 4 MiB、renderer 共享 16 MiB 的保留 LRU，reducer/card 只保存引用，折叠或翻页离开可释放正文；完整输出由 server journal 提供，registry 只保存游标、当前窗口和渲染尾部；
- 当 roster 返回 `activeOverflow: true` 时，TasksPanel 关闭期间不请求分页；打开 overflow 区域后按 baselineId/keyset cursor 按需加载当前页，页面缓存和渲染行数有硬上限，用户翻页才能读取后续任务，禁止每个 tab 自动下载并保存完整 active 集合。inline 与已加载 page 条目写入同一 canonical task metadata store；把 `applyTasksSnapshot` 的 per-task enrichment 提取为共享 `joinTaskRecord()`，快照与 active page 都调用它更新 `activeSubagents`，资源页也读取同一 store，未加载条目按 task/run/ref 精确 fetch。`applyTasksSnapshot` 只替换快照内联部分并保留有界 page cache，不得把未出现在部分 roster 中的 overflow active 记录误判为已终止；TasksPanel 为当前页所有行复用既有 Stop 路径，lifecycle baseline 变化和 Stop 完成后刷新对应 baseline，不能只在服务端提供无人调用的分页端点；
- TaskRow 的展开入口由 `output.hasOutput || output.hasResult || semanticRef != null || output.live === 'available' || exitCode != null || reason != null` 决定，运行中也必须能打开；React key 必须包含 taskId 和 runId/revision，run-less legacy 记录使用 toolUseId/historicalRef/持久化 recordKey 补足唯一身份，不能只使用可能跨 task 重复或整体缺失的 runId/revision，避免不同 task 或同 task 多 run 共用展开状态和 observer；无 stdout/stderr 时以元数据视图展示退出诊断；
- `shared/resource-address.ts` 的 task/subagent 地址类型、serializer 与 parser 必须同步扩展 run/revision/historicalRef；旧两段地址只解析当前 run，带历史身份的地址必须精确解析，序列化后再 parse 不得丢字段。`ResourceTaskBody` 与 `ResourceSubagentBody` 都必须先按资源地址中的 run/revision 或 historicalRef 精确查找，带历史身份的 subagent 地址不得只按 toolUseId 选择当前 ActiveSubagent；本地 canonical store 未加载该记录时，通过 `GET /sessions/:id/task-metadata?taskId=&runId=&revision=&historicalRef=` 从 historical metadata index 读取单条有界 TaskRecordUi（description/taskType/lifecycle/timestamps/exitCode/refs，不含输出正文），已 roster eviction 但仍有历史身份的元数据也必须可解析；`TasksPanel.tsx`、`ResourceTaskBody.tsx` 的 Open agent、`SubagentOverlay.tsx` 的 Open in resource preview 与 `ResourceSubagentBody.tsx` 生成 task/subagent 地址时都必须传入这些身份，`subagentResource` 接受并携带 run/revision/historicalRef，不能只改查找端或让 task→subagent 导航跳回新 run。
- `SubagentTranscriptBody` 不得继续通过 `taskAsSubagent()` 直接读取 `TaskRecordUi.result` 或独立映射终态；它使用同一精确 task metadata、共享 `joinTaskRecord()` 真值表与 semantic preview/supplemental 读取恢复尾部结果，stopped resultless、stopped-with-output、错误结果和文本/supplemental 去重都与 live card 一致；
- `applyTasksSnapshot` 对 activeSubagents 的 join 比较 run/revision/resultVersion，但尚无这些字段的记录可在 toolUseId 一致且无更新 run 冲突时采用并结算；
- `WorkflowCard` / `activeWorkflows` 的最终 summary 与 inline result 以及 forked `Skill` 的 `activeSkills` 生命周期和报告，都走同一历史元数据与语义恢复路径；background Workflow/Skill 不得因无关 main turn end 被无条件 interrupted/settle children，必须等待上述已解析 liveness。三类 sidechain 共用 `canMergeCanonicalResult()`：晚到 canonical `tool_result` 可写入 running/background/pending 以及由 tombstone/estimated stop 形成的 interrupted/done metadata 记录，并按结果错误位校正终态，不能保留 running-only gate 丢掉真实报告；
- `task_notification` 的 run/revision 身份还必须贯穿原始终端帧、history-reader `normalize()`、transcript 持久化和客户端 `parseTaskNotification` / sidechain 合并；`run_id`、`source_revision`、`run_generation`、`terminalCause/terminal_cause`、`resultIsError/result_is_error`、`exitCode/exit_code`、`TaskOutputRef`、`semanticRef`、`resultVersion` 及可信 outputRef 的 `payloadPresence/payloadKind/occurrenceId` 都不得被顶层白名单剥掉；`jsonl-cache`、`readHistoryPage`、`readHistoryEntries`、`readTurnAnchorsFromDisk`、tasklist `readAll` 与全局搜索也必须先以流式记录和字段解析产生 projection，不能在 normalize 前先 `readFile + JSON.parse` 整个大通知。
- 全局 session search 必须同时查询 transcript projection 与 task-output catalog/journal：输出命中返回 sessionId、task/run/revision/historicalRef、绝对 offset 和有界 snippet，通过资源卡打开，支持分页游标且有每请求字节/时间预算，不能整文件读入内存；这样正文外部化后原有按输出内容定位 owning session 的能力不消失；
- 语义读取用于 reducer/card 时最多返回 128 KiB 的 UTF-8 安全尾部并显式标记截断，完整结果仍走输出观察协议，不能用单次大响应绕过背压。每会话语义预览读取最多 4 个并发且总 in-flight 不超过 2 MiB，进程级另限 16 个并发且总 in-flight 不超过 8 MiB，supplemental 元数据按最多 100 个 block 分页；
- `applyTasksSnapshot` 的替代真值表必须逐项覆盖旧逻辑：`dismissed` 记录不得被终态快照结算或捕获结果；早于已有非估计 `endedAt` 的 stale terminal 同样不得结算或覆盖结果。异步、background、pending 记录按终态 tombstone 结算；任何 `resultIsError: true` 都优先映射为 interrupted，包括 `completed + hasResult` 的矛盾组合；非错误同步 foreground subagent 在 `completed + hasResult` 时仍可结算为 done，即使正文随后才恢复；resultless `completed` 可把已 interrupted 的同步记录恢复为 done，但不得把仍在 running 的同步记录提前结束，它继续等待 canonical `tool_result`。任何非 `completed` 的终态（包括 failed、killed、stopped）都可结束同步 running 记录；晚到的 canonical `tool_result` 仍必须能按现有 merge 规则写入该 interrupted/done 记录并校正状态，tombstone 不得把 canonical 结果入口封死；其中 `stopped + hasResult` 只有在结果不标记 `resultIsError` 时才映射为 done，其余非 completed 终态默认映射为 interrupted，`stopped + resultIsError` 也必须为 interrupted，结果可用性本身不能覆盖错误优先级。`unknown-expired` 优先于 `hasResult`，只能映射为 `interrupted` 且 `endedAtEstimated=true`，不能因为存在非错误结果就升级为 done。截断结果不得替换同版本已有的完整或更丰富结果；但更高 `resultVersion` 的 richer canonical 即使预览被截断，也必须替代低版本旧摘要，并展示截断状态。

## 9. 上游前置事件与探针

### 9.1 事件与字节契约

CLI/provider 需提供版本化实时事件，建议形态：

```text
system/workflow_event {
  task_id,
  run_id,
  run_generation,
  tool_use_id,
  source_revision,
  channel,
  event_seq,
  event: workflow_log | workflow_phase | workflow_agent | workflow_output_chunk,
  offset,
  byteLength,
  payload
}
```

必须满足：

1. `workflow_log/console` 在运行中实际发出，不再被过滤；
2. 每个任务运行的 `event_seq` 从已知初始值开始连续递增，或提供带显式 gap/loss 的跳号；所有 output-bearing 事件都携带绝对 `offset` 和 `byteLength`，非输出事件携带按 channel 分别记录的输出高水位表；
3. 在 `task_notification` 或其他任何 terminal frame 前 flush 所有待发送事件；
4. 明确 local、remote、nested agent 和各 forwarding 配置下的覆盖范围；
5. 保留 hidden/redacted workflow 的脱敏语义；
6. 字节级实时 stdout 需要 `workflow_output_chunk`，完成时 tool result 不算实时源；
7. 提供可定位的终态 snapshot 供最终 reconciliation，但 snapshot 不能替代实时事件；
8. shell/Monitor 必须提供有序原始字节 chunk 流，或在任务开始时暴露可持续增量读取的输出路径，使高吞吐输出在 64 MiB 限额内保持连续；读取必须返回 byte-preserving payload 及绝对起始 offset。仅提供最后 8 KiB 的轮询接口不满足该条件；
9. `task_notification` 及其他终态帧必须携带 source revision 或可比较的 event fence，使应用能识别同一 provider run 内迟到的旧 revision；没有 run ID 的 watcher 需要独立的 legacy 兼容语义；
10. 需要支持 rerun/replay 的 provider 必须提供稳定 run ID 和可比较的跨 run `run_generation`/event fence；帧 UUID 只用于去重，per-run event_seq 也不能证明哪个 run 更旧；
11. 上游生产通道必须支持 credit、pause/resume 或保证有界的 async-iterator 拉取，使应用暂停读取时不会在上游继续形成无界缓冲；输出背压必须有独立的 channel/credit，不能暂停共享 SDK 流上的 assistant、permission 或其他控制帧；
12. 单个上游事件和 base64 payload 必须有硬上限（默认 64 KiB 原始字节），更大的输出由 producer 分块，不能让适配器在应用预算前物化数百 MiB 单事件；
13. 提供每 channel 的编码元数据或明确 raw/hex-only 能力；没有元数据时必须使用配置默认编码或原始字节视图，不能让实现自行猜测；
14. 所有大型 task-notification 与 canonical tool_result（包括带 tool-use-id 的 routable 结果）都必须提供 output_file/reference 或保留身份的有界重组协议，不能只限制 unroutable 通知；reference 必须携带稳定 occurrence/toolUseId、原始 payload presence/kind 和 complete-injection 证据，使正文外部化后仍能区分 result、monitor event 与 status-only。拆包不得破坏 complete-injection 分类或 tool_result 配对。
15. Claude 的 CLI-owned `TaskOutput` schema、执行路径和 detach acknowledgement 必须同步支持 `cursor/runId/revision/historicalRef/outputMode/channel/wait/timeout`，使模型能按第 5、7 节读取指定旧 run；仅扩展 native 工具不算满足。CLI 必须通过版本化 SDK host bridge 将读取委托给 app catalog/输出服务，bridge 请求/响应携带 consumer identity、有界 cursor/page、terminal/loss/error 与背压语义，不能在 CLI 内另建无法解析 app historicalRef 的本地实现。acknowledgement 必须返回与实际输出 run 一致的 `isBackgrounded/taskId/runId/runGeneration/revision`，旧 schema 不得静默丢弃这些参数后退回最新 run。
16. provider 必须支持按 taskId/toolUseId 按需读取权威 current-run snapshot，返回当前 runId/runGeneration/revision、非终态/终态和 event fence，供 mixed-generation `indeterminate` reconciliation 使用；没有该 API 时不能让应用通过猜测 ordering 或超时停止仍活跃任务来解除冻结。
17. provider stop control 必须提供原子 `stopTaskExpected`：在同一 run fence 内比较 expected run/revision/generation（或 run-less record identity）并停止匹配执行，mismatch 不停止任何 run；仅提供 taskId-only stop 不足以支持新客户端的安全分页 Stop。
18. 所有 terminal frame/tombstone 必须显式携带 `resultIsError` 与 `exitCode`（无可用值时为 null，缺失字段与 null 不得混同），即使没有 stdout/stderr、terminal artifact 或 inline result； stopped/killed/failed/worker_restart 的成功错误语义与无输出 exit 诊断必须能由这些字段确定。

### 9.2 恢复实施的强制验收探针

使用 bundled CLI 和 loopback fake Anthropic Messages server，不依赖外部模型。事件缺口、revision fence 和 credit/backpressure 探针使用独立的上游模拟器与测试专用可变速率通道，不要求提前实现生产 OutputRing、journal scheduler 或 observer；只有上游能力本身通过后，才解除实现冻结：

1. 脚本包含 `phase`、`log`、`console`、workflow agent 和 nested agent；
2. 在终态通知前收到真实 `workflow_log/console`；
3. 验证 Workflow 根与侧链 join，不依赖 `parent_task_id`；
4. 验证 `event_seq` 顺序、跨 run `run_generation` 新旧关系、重连/resume/reset、所有 terminal frame 前的 flush 和迟到旧 run 隔离；这些身份字段必须同时在真实 CLI 输出中验证，模拟器通过不算生产证明；
5. 覆盖 `forwardSubagentText: true/false`、nested forwarding、remote 和 redacted 场景；
6. 验证失败、中断、进程退出和缺失终态 artifact 时，已产生的实时日志仍可读取；
7. 在 workflow 内执行产生 stdout 的命令，断言运行中收到对应 `workflow_output_chunk`，并覆盖非 ASCII 内容和跨 chunk 字符边界；
8. 对 shell/Monitor 输入非 UTF-8 字节及多字节字符跨界，验证 byte-preserving payload、起始 offset 和重连后的连续性；以远高于 8 KiB/轮询窗口的速率产生输出，验证不存在未标记的内部缺口；
9. 在同一 task run 内制造 source revision reset，随后注入旧 source_revision 的实时 chunk 和终态帧，验证上游能提供区分并隔离它们所需的 fence 证据；此处不要求提前实现应用侧隔离逻辑。同时在真实 CLI 输出中确认 source_revision 或等价、可比较的 event fence 确实存在，不能只验证模拟器；
10. 人为降低测试通道提交速率并暂停应用读取，验证上游 credit/pause 或有界拉取生效，缓冲区不越过约定预算，恢复后输出连续且无未标记缺口；暂停输出期间必须继续注入并按时收到 assistant、permission 与 interrupt/control 响应，证明上游没有通过暂停共享 SDK iterator 阻塞控制面；随后在真实 CLI/SDK 高吞吐运行中重复该过程，直接观测实际 async iterator/进程缓冲，不能用模拟器结果替代生产通道证明；
11. 让前台命令先产生超过 1 MiB 输出再执行 Ctrl+B，验证 detach 后能从执行开始重放，pre-detach 内容不缺失；
12. 让上游尝试发送超过单事件上限的 payload，除观察线上小帧外，还必须在真实 CLI/provider 进程内验证分配发生在分块之后；可用上游插桩、分配计数或内存剖析证明 producer 未先物化大 payload，不能只靠黑盒帧大小推断；
13. 在普通完成、gap、字节冲突和缺失 snapshot 场景下验证上游能否提供可定位 snapshot、一致 offset 和冲突/缺失证据；应用侧的 `durable: corruption` 与 incomplete 处理在后续实施阶段验证，不作为提前解除冻结的前置实现；
14. 分别对 routable/unroutable 大型 task-notification 和大型 canonical tool_result 验证 output_file/reference 或有界重组，occurrence/toolUseId 身份稳定，不交付完整大 XML 或 tool_result 单帧；每类都制造超过单事件上限的真实 payload，证明 producer 在应用解析前已经分块或外部化。此处只验证上游可提供引用与有界字节，任务卡/neutral card 的打开行为留到实施后的应用验收，不作为解除冻结的前置条件。
15. 在 Claude 同 task 的两次 run 完成后，让模型先读取最新 run，再用 detach acknowledgement 返回的 runId/revision 或 historicalRef 读取旧 run；historicalRef 由测试专用 app host-catalog fixture 持有，必须证明真实 CLI 通过 SDK host bridge 请求 app 并读回对应旧 run，而不是只访问 CLI-local 输出。验证 CLI-owned `TaskOutput` 实际接受并执行这些参数，旧输出与最新输出不串线，省略身份时才按共享 comparator 选择当前 run，并覆盖无 generation 的 legacy runId 顺序。另在运行中验证 `outputMode: 'pages'` 创建独立 model cursor、后续省略 outputMode 仍保持 pages；分别写入不同 stdout/stderr 内容，验证默认 merged 按全局 at 返回两个 channel、单 channel 过滤不遗漏另一 channel 的 next 高水位，且不同 channel 的 model cursor 互不串位；`wait: 'next-page'` 在下一页到达后返回，或在最后一页后的终态/incomplete/reset 时立即返回不含正文的 pages outcome；验证 `block: true` 的终态等待及其与 `wait: 'next-page'` 组合时的明确输入错误，不能静默退回 legacy running/terminal 文案。两种等待都验证默认 30 秒、调用方 timeout 与 600 秒上限，超时返回 running/当前 cursor 且不重置分页。对大结果的无 cursor legacy 终态调用必须返回有界兼容页而非完整正文；未知编码的原始字节在实时和终态调用中都只能返回 raw/hex，不得猜测解码。
16. 对同一 task 分别注入 untagged current record 与 generation-bearing late frame，调用真实 provider 的 current-run snapshot API，断言返回的 runId/runGeneration/revision/event fence 足以确定唯一当前 run；再覆盖 current record 已 tagged、普通帧 untagged 的反方向，不能仅验证模拟 comparator 或用 unknown-expired 掩盖缺失 API。
17. 在上游模拟器中故意丢弃一个 output-bearing event，再发送后续 phase/agent 非输出事件；后者必须携带每 channel 输出高水位表，使接收方能计算缺失 offset/byteLength 并发出显式 gap。再覆盖高水位缺失或回退场景，必须产生可检测的协议错误，不能让连续 event_seq 冒充字节连续性。
18. 在 expected-run Stop 与 task rerun 之间制造竞争，验证 provider 的 compare-and-stop fence：run A 已切换到 run B 时，针对 A 的请求返回 stale-run 且 B 继续运行；针对当前 B 的请求才停止 B。run-less legacy record 在取得 run 后同样必须拒绝旧身份 Stop。
19. 分别制造无输出 exit 0、无输出非零 exit、stopped + error-valued result 和 stopped + 非错误结果，验证真实 CLI terminal frame 的 resultIsError/exitCode 与 null 语义；字段缺失、错误位与状态矛盾时必须产生可检测协议错误，不能由客户端猜测 done/interrupted 或无输出诊断。

探针全部通过后，才重新进入详细 TDD 实施规划。

## 10. 实施顺序与最终验收

上游就绪后：

1. 以 TDD 实现 OutputRing、wake、分帧和分段 journal；
2. 接入各 provider 实时源，并先让所有旧结果入口具备 journal-first 写入与兼容投影能力；
3. 实现独立观察协议和 ACK 背压，确保完整输出读取路径先于正文剥离上线；
4. 在实时写入已全部拦截且观察路径可用后，完成旧 sidecar 幂等迁移、pump 全量结果替换及 restart/fork/delete 生命周期；
5. 完成客户端模型、语义结果恢复和 UI 切换后，删除兼容字段 `TaskRecordUi.result`；legacy 小结果仍可由独立 `legacyResultOf()` 在旧 wire 上提供，该兼容读取不恢复 `TaskRecordUi.result` 到共享 roster 或新客户端状态；
6. 以真实大输出和断线场景验证，不以单元 fixture 代替 provider 能力证明。

每一阶段先写失败测试，再实现最小通过代码。阶段 2–3 保留旧结果原值。partial 投影只能在新协议/feature gate 后使用；旧客户端不理解 `projection: 'partial'` 时不得收到该字符串，否则它会覆盖更丰富结果。若必须兼容旧客户端，中间阶段只能保留原值或不上线该阶段，不能发送 head+tail 让它误当完整正文。新客户端的兼容投影必须带 `projection: 'partial'` 和直接写入字符串的省略标记，且不得覆盖已有的完整或更丰富结果。

最终验收：

- 输出大小不再影响任务快照大小，8,018,020 字符的历史场景不会产生大 roster 帧或重连循环；
- 运行中可观察真实输出，完成输出每个运行最多保留 64 MiB，缺口和 reset 可见；
- 慢客户端只阻塞对应观察，重连从最后 ACK 的游标继续，终态不越过未确认输出；
- 两条历史大结果完整迁移，restart/fork/delete 行为保持独立和可恢复；routable/unroutable 大通知与 canonical tool_result 都能从对应任务卡或 neutral card 按稳定身份打开；
- 客户端渲染有界，隐藏视图退订，支持 `taskOutputV1` 的客户端 subagent 语义结果和生命周期无回归；legacy 仅接受文档明确的升级降级，不承诺完整 stopped/completed 兼容语义；
- `npm run typecheck`、`npm test`、浏览器与 desktop 集成测试及真实 provider 探针通过。
