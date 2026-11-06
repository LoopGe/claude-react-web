# Pending request channel 去重与竞态修复设计

**日期：** 2026-11-02  
**状态：** 待确认  
**前置调研：** `docs/async-lifecycle-dedup-research.md`

## 1. 意图

将 permission / elicitation / user dialog 三份高度同构的客户端 channel 实现合并为一个内部 `usePendingRequestChannel`，同时修复两类已确认的异步竞态：

1. session A 切到 B 后，A 的 seed、POST 失败和 recovery 仍可能写回同一 hook 实例；
2. 同 session 内，迟到的 recovery 可能重新插入已经被新 request/resolved 改变状态的请求。

这次既做实现去重，也做明确的状态语义修复；两者必须在同一设计下保持一致，但测试要分别钉住。

## 2. 目标

- 保留 `usePermissionChannel`、`useElicitationChannel`、`useUserDialogChannel` 的名称、参数、公开返回类型和 import 路径。
- 三个 wrapper 各自调用一次内部 core，仍有三个独立的 pending/error 状态实例。
- 共用 REST seed、保序 merge、request/resolved、optimistic POST、recovery、reset 和 clearError。
- sessionId 改变时，当前 render 就不再暴露旧 session 的 pending/error。
- 旧 session 的 seed、事件、POST catch、recovery 成功或失败均不得修改新 session 状态。
- 同 session 内，新的 request/resolved 或更新的 submit 会使该 id 的旧 recovery 失效。
- 保持 optimistic UI：submit 时先移除 pending；失败时设置领域 error，并尽可能恢复服务端仍 pending 的请求。

## 3. 非目标与反目标

- 不改 `SessionSynchronizer`、WS 协议、REST 路由、组件渲染优先级或 transcript reducer。
- 不让 core 自行订阅 Hub；现有 request/resolved 仍由 synchronizer 转发。
- 不合并成跨领域统一 FIFO，不让 Side Chat 新增 elicitation/dialog 请求。
- 不统一三类 error 的 UI 展示，不修改 minimized/reopen、question draft 或 dialog edit-prompt 行为。
- 不引入全局缓存、跨 session 缓存或统一 loading 状态。
- 不借本次修改 reconnect re-broadcast 的 merge 语义；它仍不是权威全量替换。

## 4. 当前 seam

三个 hook 都只是状态/HTTP channel，不拥有 WS 生命周期（`src/hooks/usePermissionChannel.ts:1-8`，`src/hooks/useElicitationChannel.ts:1-11`，`src/hooks/useUserDialogChannel.ts:1-11`）。`SessionSynchronizer` 统一拥有 subscribe/listener/stop（`src/session-sync/session-synchronizer.ts:137-201`）。

三者重复的核心实现见：

- seed：`usePermissionChannel.ts:60-82`，`useElicitationChannel.ts:42-60`，`useUserDialogChannel.ts:42-60`；
- optimistic POST/recovery：`usePermissionChannel.ts:94-117`，另外两文件 `:72-95`；
- 保序 merge：`usePermissionChannel.ts:149-165`，另外两文件 `:110-127`。

主 Chat 目前通过 `key={session.id}` remount 避免大部分串 session 问题，但 Side Chat 直接使用 `usePermissionChannel(effectiveSideChatId)`，所以 core 必须自己保证 session 隔离，不能继续依赖 keyed remount（`src/components/ChatPanel.tsx:557-578,1369-1372`）。

## 5. 内部接口

新增私有模块 `src/hooks/usePendingRequestChannel.ts`：

```ts
type PendingResource = 'permissions' | 'elicitations' | 'dialogs'
type PendingAction = 'decide' | 'answer-question' | 'clarify-question'

interface PendingRequestChannel<Req extends { id: string }, Res extends { id: string }> {
  pending: Req[]
  error: string | null
  onRequest: (req: Req) => void
  onResolved: (res: Res) => void
  reset: () => void
  clearError: () => void
  submit: (
    id: string,
    action: PendingAction,
    body: unknown,
    errorPrefix: string,
  ) => Promise<void>
}

function usePendingRequestChannel<Req extends { id: string }, Res extends { id: string }>(
  sessionId: string,
  resource: PendingResource,
): PendingRequestChannel<Req, Res>
```

`resource` 和 `action` 是 primitive union，core 不接收每次 render 新建的配置对象。URL 仅由 core 根据 session/resource/id/action 生成。

三个原文件保留全部领域类型和 wrapper：

- permission：`decide`、`answerQuestion`、`clarifyQuestion` 分别包装 action、body 和 errorPrefix；
- elicitation/dialog：保留各自强类型 `decide`；
- wrapper 显式列出原公开字段，不 spread core，因而不暴露 `submit`。

## 6. 状态模型

core 内部使用一个按 session 标记的状态对象，至少包含：

```ts
{
  sessionId: string
  pending: Req[]
  error: string | null
  recoveryTokens: ReadonlyMap<string, symbol>
}
```

`recoveryTokens` 是实现细节，不进入公开返回值。它只记录仍有 recovery/submit 生命周期的 id，完成后删除；session reset 会整体清空，因此不会按历史请求无限增长。

sessionId 变化采用 React 的 render-time state adjustment：发现 state.sessionId 与当前 sessionId 不同，就以新 session 的空状态替换。React 重试该 render 后再提交，因此调用方不会看到“新 sessionId + 旧 pending/error”的一帧。

所有异步状态提交都使用 functional update，并在同一个 update 内检查 sessionId 和相应 token；检查与修改不可拆成“先读 ref、再 setState”，避免检查后又发生新事件。

保留 `mergePending` 原语义：空 incoming 返回原引用；同 id 原位替换；新 id 追加；既有顺序不变。

## 7. 异步不变式

### 7.1 Initial seed

- 空 sessionId 不请求。
- seed 使用 `/sessions/:id/<resource>` 的当前 GET 响应。
- `.then` 只在 state.sessionId 仍等于捕获的 sessionId 时 merge。
- effect cleanup 继续阻止卸载后的提交。
- 失败保持静默，不设置 error。
- seed 与 live request 仍 merge，不做全量 replace。

### 7.2 request / resolved

- `onRequest/onResolved` 捕获其创建时的 sessionId；若当前 state 已属于其他 session，直接 no-op。
- 对某 id 应用 live request/resolved 时，同时删除该 id 的 recovery token，使尚未落地的旧 recovery 失效。
- request 仍 merge，resolved 仍按 id filter；空 id 仍忽略。

### 7.3 submit 与 recovery

submit 按以下顺序执行：

1. 从当前 pendingRef 捕获被移除项；pendingRef 的作用与现有一致。
2. 为该 id 创建新 token，并在一个状态更新中注册 token + 乐观移除 pending。相同 id 的新 submit 自然覆盖旧 token。
3. POST 成功：仅清理仍等于当前值的 token，不清 error、不额外改 pending。
4. POST 失败：只有 sessionId 仍匹配时才设置 `${errorPrefix}: ${message}`。
5. recovery GET 成功：只读取响应中目标 id 的项，不再 merge 整个 pending 列表；只有 session 和该 id token 都仍匹配时才 merge 该项。响应没有目标 id 时不复活捕获项。
6. recovery GET 失败：只有 session 和 token 都仍匹配时，才重新插入第 1 步捕获的项。
7. 每条结束路径只清理自己的当前 token；若 token 已被新事件替换/删除，整个 recovery 状态提交为 no-op。

只 reconciliation 目标 id 是有意收窄：recovery 的职责是恢复本次 optimistic 移除，而不是用一份迟到的全量响应覆盖其他请求的最新状态。

### 7.4 reset / clearError

- `reset()` 清当前 session 的 pending/error，并清 recovery tokens，使所有旧 recovery 失效。
- `clearError()` 只清 error，不影响 pending 或 recovery。
- session 切换等价于对新 session 的全新状态，不继承旧 error。

## 8. 保持不变的外部行为

- `SessionSynchronizer` 继续负责 permission 的 transcript dispatch、dialog eviction/edit-prompt 及所有 WS 转发顺序（`src/session-sync/session-synchronizer.ts:448-521`）。
- Chat 仍按 permission/question → elicitation → dialog 选择可见 UI（`src/components/Chat.tsx:2593-2679`）。
- reconnect 时普通 request frame 的幂等重发仍走 merge（`shared/ws-protocol.ts:17-24`）。
- 三个公开 Promise 的现有错误处理风格不变：POST/recovery 失败由 channel 内部处理，不新抛给组件。
- Side Chat 仍只实例化 permission channel。

## 9. 测试策略

### 9.1 先证明旧竞态

在现有公开 hook 测试上用 deferred Promise 增加回归用例，并在修改实现前确认相关用例失败：

- A→B 后立即暴露空 pending/error；A 的迟到 seed 不得写入 B。
- A 的 POST 在切到 B 后失败，不得设置 B error、GET 后写 pending 或恢复捕获项。
- recovery 进行中收到同 id 新 request，旧 GET 成功/失败都不得覆盖或复活旧版本。
- recovery 进行中收到同 id resolved，旧 GET 成功/失败都不得复活该项。
- 同 id 第二次 submit 后，第一次 recovery 不得提交。
- 无关 id 的 live 事件不得阻塞目标 id 的有效 recovery。

### 9.2 core 与 adapter 覆盖

- core 持有上述通用竞态矩阵，以及 merge 顺序、reset token 失效、空 session、URL 生成。
- 三个现有公开测试文件继续作为兼容测试，验证 wrapper 不泄漏 `submit`、原操作和返回类型不变。
- permission 特有 planTargetMode、answer、clarify 测试保持不变。
- synchronizer 现有 frame 转发、dialog eviction/edit-prompt 和订阅生命周期测试保持不变。

### 9.3 验证命令

```bash
npm test -- src/hooks/usePermissionChannel.test.ts src/hooks/useElicitationChannel.test.ts src/hooks/useUserDialogChannel.test.ts src/hooks/usePendingRequestChannel.test.ts src/session-sync/session-synchronizer.test.ts
npm run typecheck
npm run lint
npm test
```

## 10. 实施边界与留给 builder 的决定

- 可以先迁移 elicitation/dialog，再迁移 permission；每一步都必须保持公开测试通过。
- reducer、嵌套 functional setState 或等价的单一状态更新实现可由 builder 选择，但必须满足“session/token 检查与提交原子化”，不能退回不受保护的 ref 检查。
- 可同步修正 elicitation/dialog 顶部过时的 replay/replay-done 注释；不改协议文档或运行时协议。
- 不顺手修改其他已知问题，例如 reconnect 空 re-broadcast 不清 stale pending、Chat error banner 不包含 elicitation/dialog error。
