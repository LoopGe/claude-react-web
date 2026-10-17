# Subagent 磁盘 transcript 查看器统一到 MessageList 设计

- 日期：2026-10-18
- 状态：对话中逐节评审通过，待 spec 审阅
- 来源：TasksPanel「view on-disk transcripts」弹窗渲染器与主消息列表统一的调研（spike 已完成，三条风险全部探明）

## 1. 背景与动机

TasksPanel 中已结束 subagent 行的「view on-disk transcripts」按钮当前打开 `SubagentTranscriptDialog`——一个**有意极简**的渲染器（纯 user/assistant 文本行，无工具卡）。它不复用主消息列表 `MessageList` 的原因（历史确认）：

1. 数据形状不同：路由返回 SDK standalone `getSubagentMessages` 的原始 `SessionMessage`，而 `MessageList` 消费 reducer 管线产出的 `TranscriptItem`；
2. `MessageList` 依赖 toolStatus/toolResults 等来自 live session store 的状态 map，而 background/async subagent 的帧从未到达主流，store 里没有数据；
3. 原实现刻意「Minimal renderer by design」。

Spike 调研（真实磁盘数据验证）表明这三条都不是本质障碍：

- **186 个真实 subagent 文件、~18k 行**：user/assistant 行与主 transcript **同构**（含 `uuid`/`timestamp`/完整 `message`，tool_use/tool_result/thinking 块齐全），工具卡有数据可渲染；
- reducer 的 `REPLAY_REPLACE` fresh-state 路径 + `isDiskReplay` sweep 原生支持磁盘帧灌入；
- registry 已有 refCount + TTL 回收，草稿 store 无泄漏机制；
- `system` 行为 0 条，噪声类型由渲染门 default-false 分支天然过滤。

统一后弹窗获得：虚拟滚动、工具分组卡、工具结果内联、与主 transcript 一致的视觉与交互。

## 2. 已拍板的决策

| 决策点 | 选择 |
|---|---|
| 更新机制 | **fs.watch 推送**（实时），非轮询；REST 仅作引导 |
| 嵌套 subagent drill-in | **本期不做**（当前数据 0 个嵌套实例；设计预留扩展点） |
| 旧极简渲染器 | **直接删除**（无降级共存） |
| 服务端读取方式 | **直读 JSONL + history-reader normalize 变体**（弃用 SDK standalone helper 作内容源；`listSubagents` 列表路由保留） |
| REST/WS 交接 | REST 全量引导 + WS 订阅时重推全量 `reset: true` 快照（幂等交接），之后增量 |

## 3. 目标 / 非目标

**目标**

- 弹窗正文换用 `MessageList`，工具卡、分组、虚拟滚动全部生效；
- 服务端把 subagent JSONL 解析为与 live 流同形的 wire 帧，客户端经草稿 SessionStore 灌入；
- 运行中的 background 任务打开弹窗后内容实时追加（fs.watch 推送）；
- dormant/terminated 会话可用（服务端纯磁盘读，不依赖 live Query）。

**非目标**

- 嵌套 subagent 的弹窗内 drill-in（Agent 工具卡照常渲染 tool_use，但无「查看 transcript」入口；扩展点见 §8）；
- 弹窗内发消息、interrupt 等任何交互能力（严格只读）；
- TasksPanel 之外的入口。

## 4. 架构与数据流

```
【一次性引导】REST  GET /sessions/:id/subagents/:agentId
        └─ 返回全量 wire 帧（normalize 变体处理）
              ↓
【草稿 store】sessionStoreRegistry 合成 id "<sessionId>::subagent::<agentId>"
        └─ REPLAY_REPLACE 灌入（reducer 的 isDiskReplay 分支原生支持）
              ↓
【渲染】MessageList —— SubagentOverlay 同款接线
        (toolStatus/toolResults/planStatus/questionAnswers 来自草稿 store；
         McpAppsProvider 用真实 sessionId)
              ↑ 持续追加
【实时推送】SubagentTranscriptHub（新，server 端）
        ├─ 首个订阅者到来 → fs.watch（subagents/ 目录，每目录一个句柄）
        ├─ 文件增长 → 字节偏移增量读 → 解析完整行 → normalize → 防抖 ~200ms 广播
        ├─ 订阅时先推一帧全量快照（reset: true）—— REST→WS 交接幂等
        └─ 最后一个订阅者离开 → 关闭句柄；registry TTL sweep 兜底回收 store
```

关键取舍：

- **REST 引导 + WS 快照交接**：弹窗打开先 REST 全量拉（干净的 loading/error 状态），随后 WS 订阅时 server 再推一帧全量 `reset: true` 快照，客户端整体替换（`REPLAY_REPLACE` 对重叠内容天然去重），之后只收增量。断线重连时订阅重建、快照重推——与 `git-snapshot` 播种、`already-live 重放 replay` 同一套哲学。
- **每目录一个 fs.watch 句柄**，不是每文件一个：多弹窗并发时句柄数恒定；hub 内按 `(sessionId, agentId)` 引用计数分发。
- transcript 体量小（实测百行级，`trimLargeToolResults` 已有单帧上限），全量快照帧不会触及 `WsWriteQueue.MAX_QUEUE_CHARS`，不需要分页。

## 5. 服务端设计

### 5.1 新模块 `server/subagent-transcripts.ts`

history-reader 的姊妹模块，三个导出：

1. `resolveSubagentFile(sessionId, agentId)`：`findTranscriptFile(sessionId)` 取主文件路径 → `path.join(dirname, 'subagents', \`agent-${path.basename(agentId)}.jsonl\`)`。照抄 `findTranscriptFile` 的 `path.basename()` 手法防路径穿越；文件不存在返回 null。
2. `isRenderableSubagentLine(line)`：`isRenderableSdkMessage` 的变体——**去掉 `isSidechain` 门**（实测 subagent 文件所有真实行都是 `isSidechain: true`，这是唯一必改），保留 `isMeta` 排除（与主 transcript 一致）；`attachment`/`api-request*` 等噪声类型由 default-false 分支天然过滤。
3. `readSubagentTranscript(sessionId, agentId)`：读文件 → 逐行 `JSON.parse` → 渲染门过滤 → `normalize(o, sessionId, true)` → 返回 wire 帧数组。normalize 主干零改动直接复用——磁盘行不携带 `parent_tool_use_id`（`history-reader.ts` 注释明确 + 全量扫描 0 行出现），normalize 为 user 行经 `toolResultParentId` 现算的父子链正是 reducer 配对所需；assistant 行置 null 与 reducer「按 tool_use_id 配对、忽略 parent」的行为匹配。

### 5.2 Hub `server/subagent-transcript-hub.ts`

- WS 新帧（`shared/ws-protocol.ts`，按仓库惯例同步补 `server/ws-protocol.ts` 与 `src/ws-types.ts` 两个实例化别名）：
  - client→server：`subagent-transcript-subscribe { sessionId, agentId }` / `subagent-transcript-unsubscribe { sessionId, agentId }`；
  - server→client：`subagent-transcript { sessionId, agentId, reset, frames }`。
- 订阅首次建立：推全量快照（`reset: true`）→ 挂 watch（目录级，refcount）。
- 文件增长：从上次字节偏移增量读，只解析**完整行**（尾行不完整则留在缓冲），normalize 后防抖 ~200ms 合并广播。
- 文件收缩（size 变小，异常/轮转）：重读全量推 `reset: true`。
- 最后一个订阅者离开：关闭句柄；`watcher.unref()`。
- watch 失败：`log.warn` + 停止推送（客户端保留已收快照，内容静止）——设计内降级，非投机 fallback。
- metrics：hub 订阅数 gauge、推送帧 counter（标签只用有限枚举，无 uuid/session id）。

### 5.3 路由变更

`GET /sessions/:id/subagents/:agentId` 改为经 `readSubagentTranscript` 返回 wire 帧（旧渲染器同时删除，无兼容负担；`limit`/`offset` 查询参数随之移除——增量职责完全归 WS）。`GET /sessions/:id/subagents` 列表路由不动。

## 6. 客户端设计

### 6.1 `useSubagentTranscriptStore`（演进自 `useSubagentTranscripts`）

- **草稿 store**：合成 id `"<sessionId>::subagent::<agentId>"` 进 `sessionStoreRegistry`；挂载 `retain`、卸载 `release`，5 分钟 TTL sweep 兜底销毁；同一 agent 重复打开弹窗复用同一 store。读取走现有 `useSessionSelector` 机制。
- **引导**：挂载时 REST 全量拉 → `REPLAY_REPLACE` 灌入。
- **实时**：经 `useWsHub` 按 agent 订阅（复用 ref-counted 订阅设施），收 `subagent-transcript` 帧——`reset: true` 再走一次 `REPLAY_REPLACE`（对重叠内容幂等），增量帧逐条走 `MESSAGE`（applyMessage 追加路径）。

### 6.2 弹窗改造（`SubagentTranscriptDialog`）

- 保留现有 Overlay modal + portal + escape stack + focus trap 骨架（均已解决）。
- 正文换 `MessageList`，接线照抄 `SubagentOverlay`：`items` / `toolStatus` / `toolResults` / `planStatus` / `questionAnswers` 全部来自草稿 store；`McpAppsProvider` 用**真实 sessionId**；`working` 不传（无 WorkingBubble）；`replayReady` 来自 store。
- 工具卡分组/消息头偏好：本期使用固定默认值（`toolGroupCards`/`autoExpandRunningGroups`/`showMessageHeaders` 均为 true），与 TasksPanel 场景无面板偏好上下文的事实一致；后续如需跟随主面板偏好再统一接入。
- 弹窗加宽到 ~860px（620px 塞不下工具卡）。
- **删除**：`TranscriptRow`、`subagentMessageText`（+测试）、`subagent-transcript-*` 文本行 CSS；TasksPanel 入口不动。

## 7. 边界与错误处理

| 场景 | 行为 |
|---|---|
| 文件缺失/空 | 现有 "No transcript on disk" 空态保留 |
| REST 失败 | 现有 error 态保留 |
| watch 失败 | `log.warn` + 停止推送，客户端保留已收快照（设计内降级） |
| 文件收缩 | 重读全量推 `reset: true` |
| 超大 tool_result | normalize `trim: true` 沿用，保护 `WsWriteQueue.MAX_QUEUE_CHARS` |
| dormant/terminated 会话 | 服务端纯磁盘读，天然可用；McpAppsProvider 拉取失败有 `MAX_FETCH_FAILURES` 上限，静默降级 |
| `isMeta` 行 | 排除，与主 transcript 一致 |
| 磁盘无 result 帧 | 无 WorkingBubble 场景；reducer 的 `isDiskReplay` sweep 收尾未闭合的同步 Agent tool_use |
| 并发同 agent 弹窗 | store 与 hub 订阅各自引用计数，共享底层实例 |

## 8. 嵌套扩展点（本期不实现）

嵌套 agent 会写**自己的** `agent-*.jsonl`（同目录，SDK `SessionMessage.parent_agent_id` 建模），磁盘行不携带 `parent_tool_use_id`、normalize 主干零改动即可。未来如需 drill-in：Agent 工具卡加「查看 transcript」入口，以嵌套 agentId 复用同一弹窗组件再开一层即可，无管线改动。

## 9. 测试

**服务端**

- `subagent-transcripts.test.ts`：路径解析（含 `basename` 穿越防护、文件缺失）、变体渲染门（sidechain 保留 / isMeta 排除 / 噪声过滤）、normalize 变体（raw parent 透传、时间戳、超限裁剪）；fixture 取真实文件行形状。
- hub 测试：tmpdir 追加行 → 防抖广播；文件收缩 → reset；退订关句柄；不完整尾行缓冲。
- 路由：3 行磁盘 passthrough（无 sm 依赖），由模块测试 + typecheck 覆盖，wire 形状行为由手动冒烟验证（spec 评审时从「路由测试」降级——独立路由测试需要真实 SessionManager，成本与价值不成比例）。

**客户端**

- reducer 灌入：fixture 帧 → `REPLAY_REPLACE` → `items` 有数据且 `toolStatus`/`toolResults` 填充（工具卡可渲染）。
- hook 测试（jsdom）：引导拉取、增量追加、reset 替换。
- 弹窗渲染：MessageList 挂载、工具卡显示结果、空态、错误态。

**删除清理**：旧渲染器及其测试、CSS；受影响的现有测试同步更新。

## 10. 工期

**3.5–4.5 人日**：服务端（模块 + normalize 变体 + hub/watcher + 路由）1–1.5；客户端（hook + 弹窗 + 删旧）1.5–2；测试 1；缓冲 0.5。
