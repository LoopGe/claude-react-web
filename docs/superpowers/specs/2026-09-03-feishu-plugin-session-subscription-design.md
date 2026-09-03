# Feishu/Lark Integration —— 优先打通插件的会话出站流订阅能力

Date: 2026-09-03

## Problem

claude-react-web 的 App Plugin 框架目前只能**入站**驱动原生会话：`sessions.send`（往会话塞一条纯文本）、`interrupt`、`compact`、`read`（粗元数据）、`list`、`contextUsage`。**没有任何"读会话输出 / 订阅消息流"的能力**——`sessions.send` 单向，插件发了消息后看不到 Claude 的回话，也拿不到 transcript。

这堵墙堵死了想用飞书/Lark 做"Claude Code 远程聊天界面"的桥接插件：**"飞书→Claude"能通（send），"Claude→飞书"断头**。

本任务是**最小交付时先打通这条框架能力**（插件会话出站流订阅），再在其上落一个飞书插件作为第一个消费者。框架能力先行，是因为它是桥接成立的前提，也是最侵入宿主的自持部分——改 `session-manager` / `session-pump` / `host-api`，涉及权限、订阅生命周期、跨进程推送。

## Goal / non-goals

### 宿主框架能力（第一优先级，本 spec 的核心交付）

- **Goal:** 新增 `sessions.subscribe(sessionId)` —— 插件经 Host API 订阅一个原生会话的**增量事件流**（复用 `session-pump` 已有的消息 fan-out 路径），宿主经 RPC `peer.notify('sessions.event', …)` 把增量事件推到插件子进程。
- **Goal:** 订阅生命周期管理：宿主持有 `sessionId → RpcPeer[]` 订阅注册表；插件进程退出 / 卸载 / 会话删除时自动清理对应订阅，无泄漏。
- **Goal:** 权限模型延续既有信任模型——`sessions.subscribe` 需要 `sessions.read` 权限；只开放"增量事件订阅"，**不开放 transcript 拉取 / 会话控制 / 权限裁决**，宿主不被击穿。
- **Goal:** 增量事件载荷**只透出** pump 已有的 `message` 帧裁剪载荷（对齐 `server/history-utils.ts` 的 `BROADCAST_SYSTEM_SUBTYPES` 与基础帧），不新增一种专有的消息抽象。

### 飞书插件（第二优先级，框架能力的消费方）

- **Goal:** `plugins/feishu/` 后台服务 + 清单，提供一个**最小但完整**的飞书桥接闭环：飞书文本消息 → 桥接到指定的原生会话 → 会话增量（Claude 回话）/ 进度 → 飞书侧渲染并回发。
- **Goal:** v1 只做**双向纯文本 + 文本回话**；映射粒度 = **一飞书聊天 ⇔ 一原生会话**（映射表）。
- **Non-goal (v1 显式排除，见 v2 section):** 飞书消息触发的工具权限审批（Bash/写文件）；图片 / 文件资源收发（resource download）；进度预览卡片；斜杠命令；群聊多用户 @ 与身份区分；webhook 私有化部署模式；自定义 iframe UI 面板（宿主框架后续能力，非本插件）。

## Architecture

三层，其中宿主改造是让整个链路成立的前提：

```
飞书/Lark ──长连接──▶ FeishuBot（插件子进程）
                 │  onMessage: 聊天→查映射表
                 │  出站: 聚合成可读文本回发
                 ▼
        Bridge ──sessions.send────▶ 原生会话（映射表 chat_id↔sessionId）
                 ▲                   │ SDK Query 跑 →
        StreamRouter ◀──RPC notify 'sessions.event'──┘ pump fan-out
                 └ 订阅: sessions.subscribe
```

**数据流（单轮往返）**
1. 飞书用户发消息 → `FeishuBot.onMessage` 解析（过滤自己消息、`allow_chat` / `groupOnly`）。
2. `Bridge` 查映射表 `chat_id → sessionId`。
3. 插件调 `sessions.send(sessionId, text)`。
4. 宿主 Queue 接收 → SDK Query 子进程跑 → `session-pump` fan-out 到所有订阅者（现有 WS 订阅 + 新增的插件订阅）。
5. 宿主 `peer.notify('sessions.event', { sessionId, event: <裁剪后的 message 帧> })` → `StreamRouter` 订阅回调。
6. `StreamRouter` 聚合增量（文本块、段落、end 信号）为一条可读文本 → `FeishuBot` 回发。

> 说明：v1 不渲染飞书交互卡片，只回**纯文本/富文本消息**。`card.go` 式的进度卡片、审批卡片留 v2。

## Design — 宿主框架能力（第一优先级）

### 1. 出站事件载荷：复用 `message` 帧裁剪，不新造抽象

增量事件直接透出已有 `ServerMessage` 帧（`server/ws-protocol.ts` 绑定的、`BROADCAST_SYSTEM_SUBTYPES` 允许的那些），外加 `replay-done` / `message-consumed` 这类让插件判断"轮到我了 / 这轮还没开始"的信号。框架能力不与浏览器对齐一套专有类型，避免双轨。

载体（`shared/app-plugins/` 新增，避免 `shared/ws-protocol.ts` 膨出插件耦合）：

```ts
// shared/app-plugins/session-events.ts
export type SessionEventOutFrame =
  | { kind: 'message'; message: /* ServerMessage 裁剪结构 */ }
  | { kind: 'replay-done' }
  | { kind: 'message-consumed' }
  | { kind: 'session-cleared' }
  | { kind: 'subscription-ended'; reason: 'session-gone' | 'plugin-disabled' | 'peer-closed' }
```

### 2. `SessionAdapter.subscribe` + 订阅注册表

`server/app-plugins/host/session-adapter.ts` 增加（权限 `sessions.read`）：

- `subscribe(sessionId, emit): { unsubscribe }` —— 校验会话存在；向一个宿主侧注册表登记 `sessionId → { emit, peer }`；**立即回放缓冲**（见 §3）保证插件一进来就能看到当前进度；返回 `unsubscribe`。
- 复用现有 `session-pump` 的 fan-out：pump 已有 `session.subscribeGlobal` / 消息广播机制（WS 层就是靠它）。新增一个"插件背板"订阅者，把处理后的帧转发给注册表里的 `emit`（`emit` 内部调 `peer.notify('sessions.event', …)`）。

新增 `server/app-plugins/host/session-subscription-registry.ts`（单一所有权）：

```ts
export class SessionSubscriptionRegistry {
  subscribe(sessionId: string, peer: RpcPeer): UnsubFn
  // 由 pump fan-out 调用：把裁剪后的帧发给所有订阅该 session 的 peer
  dispatch(sessionId: string, frame: SessionEventOutFrame): void
  // 清理一个 peer 的全部订阅（plugin-process 退出 / 卸载时调用）
  dropPeer(peer: RpcPeer): void
  // 清理一个会话的全部订阅（会话删除时调用）
  dropSession(sessionId: string): void
}
```

`registerHostApi` 里 `sessions.subscribe` 处理器：从 `peer` 建立一条会被跟踪的订阅（`config` / `storage` / `secrets` 之外的握手除外），把"该 peer"和"该 session"建立关联。

### 3. 订阅生命周期与清理

- **宿主持有 peer 引用**：不能只靠 `registerHandler` 拿 peer——需要能把 peer 传给注册表做 `notify` + 之后按 peer 清理。改造 `registerHostApi`/`app-plugin-manager` 的握手，让 session 订阅注册表能拿到它需要的 peer。
- **即时回放缓冲**：插件常是 `onStartup` 常驻，可能错过会话中断期间产生的帧。subscribe 时若会话活跃，把 pump 当前未落盘的增量（或磁盘上最近一小段）回放给新订阅者（对齐现有 `replay`/`replay-done` 语义）。回放策略默认**从当前状态开始，不回溯历史 transcript**（保持"外围工具"边界）。
- **清理路径**：`dropPeer`（插件进程 exit / disable / uninstall）；`dropSession`（会话删除，`session-manager` 删除会话时调用注册表）；订阅内事件游标失效（session-cleared）自然断链。

### 4. `plugin-runtime.ts` 子进程端

子进程端注册 `sessions.event` notification handler，把帧派发给插件注册的回调（插件 SDK 侧暴露一个 `sessions.onEvent` / connection 事件的订阅面）。与现有 `app.event`（插件→宿主）方向互补：这是**宿主→插件**的第二条数据通路，需在 RPC 协议文档标注。

### 5. 测试（宿主侧）

- `SessionAdapter.subscribe` 单测：只透出裁剪后的帧；未知 session 报错；无 `sessions.read` 权限被拒。
- 注册表单测（沿用 `session-pump` 现有测试基建和 `createAsyncSubscription` 工具）：多 peer 订阅同一 session 各自独立收到；`dropPeer` / `dropSession` / 卸载清理无泄漏；即时回放缓冲正确。

## Design — 飞书插件（第二优先级）

> 以下为框架能力打通后的第一个消费者。宿主能力未完成前，插件开发可与宿主 stub（本地注入假 `sessions.event`）并行。

### 6. `plugins/feishu/` 结构与清单

| 文件 | 职责 |
|---|---|
| `crw-plugin.json` | 清单：config properties（appId / appSecret / encryptKey / webhookPort / allowChats / groupOnly）+ 命令（start / stop / status）+ widget 状态指示 |
| `src/bot/feishu-client.ts` | 飞书长连接封装（`@larksuiteoapi/node-sdk`）：收消息、回文本。WS 为主；v1 不做 webhook。凭证读插件 secrets |
| `src/bridge.ts` | 映射表（chat_id↔sessionId，存插件 storage）；收到飞书消息 → `sessions.send`；`allow_chat` / `groupOnly` / 群聊 @ 触发过滤 |
| `src/stream.ts` | `sessions.subscribe` 订阅 + 增量聚合成可读文本（对齐文本块 / end）→ 回发 |
| `src/main.ts` | 插件入口：`onStartup` 常驻；`config` / `command` / `shutdown` 生命周期挂接 |

### 7. 安全与健壮性

- 飞书 appSecret / token 存 **插件 secrets service**（写需授权）；日志经 `sanitizingLogger` 脱敏。
- `allow_chat` 过滤 fail-closed（群聊无 @ 机器人则不触发）。
- 会话不存在 / terminated / 无映射 → 飞书侧回明确错误信息，不静默。
- 消息超长裁剪；SDK 断线重连 + token 续期。

### 8. 测试（插件侧）

- `bridge` 映射单测：未知聊天 `allow_chat` 拒绝 / groupOnly / 无映射回错误。
- `stream` 聚合渲染单测：文本块拼接、end 触发回发；空流不空发。
- 飞书 SDK 用 fixture 桩（沿 `fixtures/app-plugins/` 范式），不真实连外网。

## 交付顺序（框架能力优先）

1. **Phase 0 — 框架能力**（宿主改造，先落地并测试）：
   `shared/app-plugins/session-events.ts` → 注册表 → `SessionAdapter.subscribe` → `host-api` 处理器 → `plugin-runtime` 子进程 handler → 生命周期清理 → 测试。
2. **Phase 1 — 插件骨架**：`plugins/feishu/` manifest + 入口 + config 读写 + 命令骨架，对宿主能力用 stub 联调。
3. **Phase 2 — 飞书机器人**：`bot/feishu-client` 长连接 + 收发 + 消息过滤，本地 fixture 联调。
4. **Phase 3 — 闭环**：`bridge` + `stream` 接上真实 `sessions.subscribe`，一个端到端"飞书消息 → Claude 回话 → 回发飞书"demo。
5. **Phase 4 — 打磨**：状态指示 widget、错误回话细分、重连健壮性、文档（宿主能力 + 插件 README）。

## v2（显式不做）

飞书交互卡片审批（需二次宿主扩展——权限裁决入站通道）、图片/文件收发、进度预览卡片、斜杠命令、群聊多用户 @ 与身份区分、webhook 私有化部署模式、自定义 iframe UI 面板。本 spec 将 v2 边界写死，避免 scope 膨胀。

## Risks / open questions

- **peer 可达性**：`registerHostApi` 目前不把 peer 传给后续服务的构造；需确认 `RpcPeer` 引用在宿主侧可需要时安全持有（`notify` 已存在，确认在 `peer.closed` 后调用是 no-op，已由 `notify` 实现保证）。
- **回放范围**：v1 默认"从当前状态开始、不回溯 transcript"。若飞书桥接需要会话恢复上下文，再评估是否回溯磁盘历史——但那是被"外围工具"边界主动排除的，避免宿主能力滑向完整 transcript API。
- **多插件并发**：多个插件订阅同一会话时各自独立收流，pump fan-out 需与现有 WS 订阅并行、互不阻塞（现有 pump 已是多订阅者架构，风险低）。