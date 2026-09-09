# Spec:定时发送(Scheduled Send)功能

- 状态:draft(等待用户评审)
- 日期:2026-09-07
- 范围:新功能(非 bug 簇)。在 `claude-react-web` 增加「写好消息 → 指定未来时间 → 服务端到点自动发出」的定时发送能力。
- 前置裁决(用户已批准):① 语义=**定时发送**(非撤销窗口/节流);② 可靠性=**服务端调度、重启不保留**(进程内内存,不落盘);③ UI 形态=**发送框上方的待发胶囊条**(非对话流气泡、非全局面板)。

## 1. 背景与目标

用户撰写一条消息后,可为其指定一个未来时刻;到点由**服务端**把该消息以与手动发送完全相同的方式推入目标会话(`POST /messages` 同构),浏览器标签页/面板是否打开不影响触发(本地服务进程在跑即可)。服务重启后调度丢失(已接受的裁决)。

使用场景示例:到点自动向某会话发「总结昨日工作」、定点提醒型 prompt。

**非目标**(YAGNI):撤销发送窗口、慢速节流、跨重启持久化、全局调度收件箱、对话流内时钟气泡、附件**文件**随消息重放(见 §4.7 内容模型)。

## 2. 范围

**In**:共享类型、服务端调度管理器(内存 store + ticker)、三条 REST 路由、会话删除清理、客户端 hook + Composer 时钟按钮/时间选择器/待发胶囊条、上述全部测试、CLAUDE.md 对账。
**Out**:新增 WS 帧/channel(实时性用轮询,§4.5)、跨重启持久化、多会话全局调度面板、到点自动 resume 休眠会话、`/clear` 换新 id 后的旧会话调度抢救。

## 3. 现状锚点(实施时行号会漂移,以符号名为准)

- 手动发送链路:`src/components/Composer.tsx` `onSend` → `Chat.tsx` `send()`(乐观插入 → `POST /sessions/:id/messages`)。
- 服务端接收:`server/routes/sessions.ts` `POST /sessions/:id/messages` → `sm.send(id, text)` / `sm.sendContent(id, content)`;同一 handler 内的 body 校验(text 非空 / content 数组逐块校验,image 需 base64 source + `VALID_IMG_TYPES`,总 base64 上限 28MB)是**调度创建校验的直接复用源**。
- 发送前置守卫:`SessionManager.requireSendable`(`server/session-manager.ts:5216`)——`terminated`→410、非 `running`→409(dormant 拒收)、`recovering`→409、handle.closed→409。到点失败语义据此分派。
- 会话删除:`DELETE /sessions/:id` → `unload({terminated:true, removeFromStore:true})`;全局事件流 `sm.subscribeGlobal()` 会广播 `removed`。
- dormant 唤醒策略:仅显式 resume 可唤醒(见 `server/ws.ts` 对 "slept" 会话的注释)——定时触发**不**自动 resume。
- 排队机制:running 会话收到新消息时若 `pendingTurns>0` 会自然排到当前轮之后;到点发送撞上 busy 会话无需特殊处理。
- 路由装配:`server/routes/index.ts` `buildApiRouter(sm, …)` 由 `server/app.ts` `buildApp` 调用;`SessionManager` 在 `app.ts:139` 构造(或由 `cli.ts` 预构造注入)。

## 4. 设计

### 4.1 共享数据模型(`shared/scheduled-send.ts`)

```ts
export type ScheduledSendStatus = 'pending' | 'sent' | 'failed' | 'cancelled'

export interface ScheduledSend {
  id: string                    // 服务端 mint 的 uuid
  sessionId: string
  fireAt: number                // epoch ms,服务端时钟为准
  body:                        // 与 POST /messages 同构
    | { text: string }
    | { content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }> }
  status: ScheduledSendStatus
  createdAt: number
  error?: string                // failed 时的原因(如 "session X is terminated")
  sentUuid?: string             // sent 时 sm.send/sendContent 返回的消息 uuid(诊断/追踪用,非必需)
}
```

浏览器端**可**直接复用该类型(`src/types.ts` 不 import SDK,但本类型是自有的纯数据形状)。

### 4.2 服务端调度管理器(`server/scheduled-send-manager.ts`)

`class ScheduledSendManager`,依赖注入以便单测:

```ts
interface ScheduledSendDeps {
  send(sessionId: string, body: ScheduledSend['body']): { uuid: string } | Promise<{ uuid: string }>
  sessionExists(id: string): boolean        // create 时校验(路由层也可代做)
  now?(): number                            // 时钟注入,便于测试;默认 Date.now
  tickMs?: number                           // 默认 1000
}
```

- **存储**:内存两份,按 sessionId 索引,**不落盘**:
  1. 活跃集 `Map<sessionId, Map<scheduleId, ScheduledSend>>`——仅 `pending`;
  2. 终态环:每会话最近 `TERMINAL_KEEP = 10` 条终态(failed/cancelled/sent)记录,供 UI 展示(最旧淘汰)。仅 `failed` 需要 UI 展示;sent/cancelled 保留是为诊断一致性。
  `list()` 合并返回:活跃在前、终态在后。
- **create(sessionId, body, fireAt)**:
  1. 会话必须存在(否则 404);
  2. `fireAt` 必须 `> now + MIN_DELAY_MS`(5s),且为有限数,否则 400;
  3. body 校验与 `POST /messages` **同源**(抽公共校验函数或显式复用,含 28MB base64 上限);
  4. 该会话 pending 上限 20 条,超出 400;
  5. mint uuid,`status:'pending'`,存入,返回记录。
- **remove(sessionId, id)**(统一删除语义,供 REST DELETE 使用):
  - 记录在活跃集 → 置 `cancelled` 并移入终态环(用户取消);
  - 记录在终态环 → 直接移出(dismiss:清除 failed 展示,防止下次 list 还魂);
  - 均不存在 → 404(幂等容忍可放宽为 204,计划阶段定,默认 404)。
- **list(sessionId)** → 活跃在前、终态在后的合并列表。
- **tick()**:构造时启动 `setInterval(tickMs)`(`.unref()`,避免悬住进程);扫描到期 pending:
  1. 先把记录从 pending 摘除/标 `sending`(防重入);
  2. `await deps.send(sessionId, body)`;
  3. 成功 → `sent`(+`sentUuid`);抛错(`HttpError`/异常)→ `failed` + `error`(取 `message`),**不自动重试**。
- **cancelAll(sessionId)**:会话删除清理用——**直接丢弃**该会话的活跃集与终态环(会话已死,保留即不可达垃圾;与 `remove()` 的取消语义区分:这里是进程内清理,不是用户操作)。
- **shutdown()**:清 timer(单测/进程退出路径)。
- **删除清理**:构造方(见 §4.4)把 `sm.subscribeGlobal()` 的 `removed` 事件接到 `cancelAll(id)`——删除走全局事件,无需改动 `routes/sessions.ts` 的 DELETE handler。

### 4.3 REST 路由(`server/routes/scheduled-sends.ts`)

`buildScheduledSendRouter(sm, manager)`,挂载于 `buildApiRouter` 根下,路径复用 `/sessions/:id/...`:

- `POST /sessions/:id/schedules` body `{ fireAt: number, text?: string, content?: ContentBlock[] }` → 201 `{ schedule }`。`text`/`content` 二选一(与 messages 一致:有非空 content 数组走 content,否则 text 非空)。`fireAt` 必须为数字。
- `GET /sessions/:id/schedules` → `{ schedules: ScheduledSend[] }`。会话未知 404。
- `DELETE /sessions/:id/schedules/:scheduleId` → 204。语义 = §4.2 `remove()`:pending → 取消;终态(failed 等)→ 从终态环移除(dismiss)。客户端 `cancel` 与 `dismiss` 都走此路由,区别仅在本地意图。

路由直接复用 `sessions.ts` 中 messages handler 的 body 校验逻辑——抽到共享 helper(如 `server/routes/send-body.ts` 或 `shared`)供两处使用,避免双份漂移。

### 4.4 装配(`server/routes/index.ts` / `server/app.ts` / `server/cli.ts`)

`buildApiRouter(sm, …)` 内部构造 `ScheduledSendManager`(deps:`send` = `(id, body) => 'content' in body ? sm.sendContent(id, body.content) : sm.send(id, body.text)`;`sessionExists` = `sm.get(id)` 不抛即为真),并 `sm.subscribeGlobal()` 接 `removed` → `manager.cancelAll(id)`,随后 `app.route('/', buildScheduledSendRouter(sm, manager))`。

> 构造在 `buildApiRouter` 内、每进程一次即可。为单测可控,tick 用 `unref()` + 时钟注入;管理器本身的单测直接 new,不经过 buildApiRouter。若后续发现 `buildApiRouter` 被测试高频调用导致 timer 累积,改为由 `app.ts`/`cli.ts` 显式构造并注入(兼容可选参)。

### 4.5 实时性:轮询(不加 WS 频道)

定时状态变化稀疏(创建/取消/到点/失败),「到点发送成功」用户透过**既有消息流**看到(`sm.send` 会广播用户消息、进历史 ring、推给已订阅面板)。故:

- 客户端仅在该会话**有待发且面板打开**时,每 ~3s 轮询 `GET /sessions/:id/schedules` 对账(吸收跨面板创建/取消、服务端 sent/failed 转换)。
- 创建/取消本地乐观更新,即时反馈。
- **不做**新 WS 帧:不动 `shared/ws-protocol.ts`、`server/ws.ts` 的 channel 驱动矩阵、`SessionManager.subscribe*` 面。后续要跨面板实时一致再升级为 per-session WS channel(现有 task/recap 同款模式)。

### 4.6 客户端

#### hook `src/hooks/useScheduledSends.ts`

`useScheduledSends(sessionId)` 返回 `{ schedules, schedule(fireAtMs, body), cancel(id), dismiss(id) }`:

- 挂载/会话切换:`GET` 拉一次,本地 state。
- 每秒 tick 计算最近一条 pending 的剩余时间(驱动倒计时重渲染);`fireAt` 归零 → **立即 refetch** 拿权威状态(sent → 移除胶囊;failed → 红标展示;仍 pending → 保留)。
- `schedule(fireAtMs, body)`:POST,成功则乐观 push 并触发一次立即 refetch 对齐 server 记录;失败 toast。
- `cancel(id)`:对 pending 条 DELETE → 乐观移除。
- `dismiss(id)`:对 failed 条 DELETE → 乐观移除(服务端把终态记录从终态环移除,下次 list 不还魂)。两者同一路由,见 §4.3。

#### Composer 变更(`src/components/Composer.tsx`,保持纯 UI)

- props 新增 `schedules: ScheduledSendsApi`(由 `Chat.tsx` 经 hook 构造传入,模式同 `snippets`/`attachments`)与 `onSendScheduled?: (fireAtMs:number) => void`(实际 POST 与清空输入由 Chat 侧拥有,与 `send()` 对称——Composer 不直接发请求)。
- **时钟按钮**:action 行 send 旁加图标按钮;`disabled` 条件 = `disabled || !canSend`(有内容才可定)。点击弹出 `SchedulePicker`。
- **SchedulePicker**(组件):快捷项(10 分钟/30 分钟/1 小时/今晚 18:00/明早 9:00)+ 自定义 `datetime-local` + 确认/取消;确认后把选定时刻以 `fireAtMs` 传给 `onSendScheduled`。
- **待发胶囊条**:textarea 上方(现 attachments 条同一带区)。每条:`⏰ {HH:MM 或 "in Nm"}` + `[取消]`;failed 条目红底 + `error` 原因 + `[dismiss]`。

#### Chat 侧(`src/components/Chat.tsx`)

`const scheduled = useScheduledSends(session.id)`;`onSendScheduled(fireAtMs)` 与 `send()` 共享 body 构造(附件 preamble + text;有 pastedImages 则 content 数组),构造完 `scheduled.schedule(fireAtMs, body)` 成功后执行 `send()` 成功尾部同款清理:清 input/attachments/pastedImages、focus 回退。**不**做乐观用户气泡插入(定时消息到点才以真实消息出现,不污染对话流——胶囊条即待发呈现)。

### 4.7 内容模型(与手动发送一致)

调度捕获的 `body` 与 `send()` 实际 POST 的 body 完全同构:

- 有 pastedImages → `content` 数组:`[text?] + image blocks`(text 含附件 preamble);
- 否则 → `body.text = preamble + 用户文本`(附件以路径 preamble 文字捕获,到点时不再依赖原文件——与手动发送一致);
- 空文本但有附件/images → 按手动发送相同规则(允许纯附件/纯图)。

### 4.8 失败语义与边界

| 到点时刻会话状态 | 行为 |
|---|---|
| running/idle | 直接 `sm.send`,成功 → `sent`;撞上 busy → 自然排队(现有机制) |
| running + queue 满 | `sm.send` 抛 429 → `failed` |
| dormant(非 running) | `sm.send` 抛 409 → `failed`;**不自动 resume**(遵守显式唤醒策略) |
| terminated | 410 → `failed` |
| 已被删除 | 删除事件 → `cancelAll` 丢弃;竞态窗口(广播前已到点)内触发送 404 → `failed` |
| `/clear` 换新 id | 旧会话转 dormant,调度到点 `failed`(**v1 已知限制**,不抢救) |

失败仅记 `failed` + reason,不自动重试;failed 条目留在列表供 UI 红标,`dismiss` 后消失。浏览器/服务端时钟偏差影响绝对时刻(同机≈0;快捷相对项也按客户端 now 算,偏差同理可忽略)。

## 5. 兼容性

- **REST/WS**:纯增量。REST 新增 3 条路由;WS 帧零变化。
- **客户端**:Composer props 纯加性;消息 store/reducer/正常发送路径不改。
- **无迁移、无持久化**;服务重启即清空(已确认)。
- **`/clear`/`/clear`-换 id、dormant 自动 resume、全局面板**明确 Out,见 §2。

## 6. 测试计划(vitest)

1. **管理器单测**(`server/scheduled-send-manager.test.ts`,fake deps + fake 时钟):create 校验(过去时间/非法 body/会话不存在/上限)、tick 触发 `send` 并置 sent、`send` 抛错→failed+reason、cancel 幂等、cancelAll、shutdown 停表。
2. **路由测试**(`server/routes/scheduled-sends.test.ts`):三条路由 happy path + 400(过去时间/非法 body)/404(未知会话或未知 schedule);body 校验与 messages 同源(共享 helper 的用例)。
3. **装配/删除清理**:`buildApiRouter` 构造的管理器接 `removed` 事件后 `cancelAll`(或经 `sm` 删会话后 list 为空)。
4. **客户端 hook 测试**(jsdom):拉取/乐观 push/取消/countdown 归零触发 refetch 的权威转换(pending→sent 移除,pending→failed 红标)。
5. **Composer 组件测试**:canSend 门控时钟按钮;picker 快捷项与自定义确认回调;胶囊条渲染/取消回调;failed 展示 dismiss。
6. **端到端冒烟**(手动/Playwright):定时 10 分钟后发送 → 消息出现在会话、无幽灵胶囊。

## 7. 决策记录

- D1(用户):功能 = **定时发送**(排除撤销窗口/节流)。
- D2(用户):可靠性 = **服务端调度、重启不保留**。
- D3(用户):UI = **发送框上方待发胶囊条**(排除对话流时钟气泡 / 全局调度面板)。
- D4(设计):实时性用**轮询**,不加 WS 频道(§4.5)。
- D5(设计):body 与 `POST /messages` **同构同源校验**;到点直接复用 `sm.send/sendContent`(§4.2/§4.7)。
- D6(设计):到点失败只记 `failed`,**不自动 resume/不重试**(§4.8)。
- D7(设计):删除清理走 `subscribeGlobal` 的 `removed` 事件,不改 DELETE handler(§4.2/§4.4)。
