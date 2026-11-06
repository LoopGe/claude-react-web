# Pending Request Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个内部 `usePendingRequestChannel` 合并 permission / elicitation / dialog 的重复实现，并修复 session 切换与异步 recovery 的陈旧状态写回。

**Architecture:** 新建一个私有泛型状态/HTTP core，三个原 hook 保留为强类型薄 wrapper。core 用 session-tagged state 与每个请求独立的 recovery token 原子提交状态；WS 订阅、transcript 副作用和 UI 优先级继续由现有调用方拥有。

**Tech Stack:** React 19、TypeScript、Vitest、@testing-library/react `renderHook`、现有 `api` REST wrapper。

**Spec:** `docs/superpowers/specs/2026-11-02-pending-request-channel-design.md`

## Global Constraints

- 三个公开 hook 的名称、参数、返回类型和 import 路径不变；不得向公开返回对象泄漏 `submit`。
- 不修改 `SessionSynchronizer`、WS 协议、REST 路由、组件或 transcript store。
- core 不自行订阅 Hub；request/resolved 仍由调用方转发。
- sessionId 改变时，当前 render 不得暴露旧 pending/error；旧 session 的任何异步结果不得写入新 session。
- session/token 检查必须与状态提交在同一个 functional update 中完成，不能使用“先读 ref、后 setState”的非原子守卫。
- recovery 只 reconciliation 目标 id，不再合并响应中的其他 pending 项。
- 保持 seed merge、保序、optimistic 移除、领域 error 文案和内部捕获错误的现有行为。
- 只 stage 每个任务列出的文件；工作树中的其他改动不得混入提交。

## Review Focus

- **旧 session 回调迟到：** A 的 seed、request/resolved、POST catch 和 recovery 在 A→B 后必须 no-op；由 Task 1 的 session isolation 测试覆盖。
- **同 id 有更新事件：** 新 request/resolved、第二次 submit 或 reset 必须使旧 recovery 失效；由 Task 1 的 token invalidation 矩阵覆盖。
- **无关 id 并发：** p2 的事件不得阻止 p1 的有效 recovery；由 Task 1 的 unrelated-id 测试覆盖。
- **全量 recovery 响应含其他项：** 只能恢复目标 id，不能覆盖其他请求；由 Task 1 的 target-only recovery 测试覆盖。
- **空输入与完成清理：** 空 session/id 不请求、不改状态，token 完成后删除且不无限增长；由 Task 1 的 empty-input 与 token cleanup 测试覆盖。

---

### Task 1: 建立泛型 core，并迁移 permission + 修复竞态

**Files:**
- Create: `src/hooks/usePendingRequestChannel.ts`
- Create: `src/hooks/usePendingRequestChannel.test.ts`
- Modify: `src/hooks/usePermissionChannel.ts`
- Modify: `src/hooks/usePermissionChannel.test.ts`

**Interfaces:**
- Consumes: `api.get<T>(path)`、`api.post(path, body)`，以及 `PermissionRequest` / `PermissionResolved`。
- Produces:

```ts
type PendingResource = 'permissions' | 'elicitations' | 'dialogs'
type PendingAction = 'decide' | 'answer-question' | 'clarify-question'

function usePendingRequestChannel<Req extends { id: string }, Res extends { id: string }>(
  sessionId: string,
  resource: PendingResource,
): {
  pending: Req[]
  error: string | null
  onRequest: (req: Req) => void
  onResolved: (res: Res) => void
  reset: () => void
  clearError: () => void
  submit: (id: string, action: PendingAction, body: unknown, errorPrefix: string) => Promise<void>
}
```

- [ ] **Step 1: 在公开 permission hook 上写四个竞态回归测试**

在 `usePermissionChannel.test.ts` 增加 deferred Promise helper及以下测试；保持现有 `makePermissionRequest` 工厂：

```ts
it('clears immediately and ignores a late seed after session change', async () => {
  // s1 seed 挂起；本地加入 p-local；rerender 到 s2。
  // rerender 后立刻断言 pending=[]、error=null。
  // 再 resolve s1 seed 为 [p-old]，flush 后仍断言 pending=[]。
})

it('ignores POST failure and recovery from the previous session', async () => {
  // s1 decide POST 挂起；切到 s2 后 reject POST。
  // await decide 后断言 error=null、pending=[]；不得恢复 s1 的 p1。
})

it('does not overwrite a newer request when stale recovery succeeds', async () => {
  // p1 POST 失败，recovery GET 挂起；注入带 toolName='Write' 的新 p1。
  // 旧 recovery 返回 toolName='Bash' 的 p1；最终必须保留 'Write'。
})

it('does not resurrect a resolved request when stale recovery fails', async () => {
  // p1 POST 失败，recovery GET 挂起；依次注入新 p1、resolved(p1)。
  // reject recovery；最终 pending=[]，不得重新插入捕获的旧 p1。
})
```

测试中的 deferred 必须显式 `resolve/reject`，并在结束前 `await` 原 decide Promise，避免未处理 rejection。

- [ ] **Step 2: 运行公开测试，确认新用例能抓住旧实现**

Run:

```bash
npm test -- src/hooks/usePermissionChannel.test.ts
```

Expected: 既有用例通过；Step 1 的四个新用例 FAIL，分别暴露旧 seed/POST 跨 session 写回和 recovery 覆盖/复活。若新测试在旧实现上通过，先修正测试时序，不要继续实现。

- [ ] **Step 3: 为 core 写完整的状态与 token 测试**

创建 `usePendingRequestChannel.test.ts`，使用：

```ts
type TestRequest = { id: string; value: string }
type TestResolution = { id: string }

renderHook(
  ({ sessionId }) => usePendingRequestChannel<TestRequest, TestResolution>(sessionId, 'permissions'),
  { initialProps: { sessionId: 's1' } },
)
```

覆盖以下命名场景及断言：

1. `does not fetch for an empty session`：`sessionId=''`，`mockGet` 零调用。
2. `ignores empty request and resolution ids`：pending 始终 `[]`。
3. `seeds and merges in stable order`：seed `[p1,p2]`，更新 p1 并添加 p3，最终 id 顺序 `[p1,p2,p3]`，p1 使用新 value。
4. `resets visible state immediately and ignores late seed/events from the old session`：A→B 后立即为空；旧 seed、旧 `onRequest`、旧 `onResolved` 均不得修改 B。
5. `ignores previous-session POST failure and both recovery outcomes`：分别让 recovery resolve/reject，B 的 pending/error 均不受 A 影响。
6. `restores only the target id from a successful recovery`：响应含 `[p1,p2]`，submit 目标是 p1，最终只能恢复 p1；p2 不得被这份响应插入或更新。
7. `re-inserts the removed target when current recovery fails`：session/token 未变化时恢复捕获项，并保留 `${errorPrefix}: ${message}`。
8. `ignores recovery success after a newer request for the same id`：保留新 request value。
9. `ignores recovery failure after a resolution for the same id`：pending 保持 `[]`。
10. `ignores the first recovery after a second submit for the same id`：只有第二次 submit 的 recovery 能提交。
11. `allows target recovery after activity for an unrelated id`：p2 request/resolved 不影响 p1 recovery 成功恢复。
12. `reset invalidates outstanding recovery`：reset 后 recovery resolve/reject 均不得恢复 pending。
13. `cleans up its token after success and after each recovery outcome`：完成后再发同 id request/resolved/submit 行为与无历史 token 时一致；测试通过公开行为验证，不断言私有 Map。
14. `does not expose implementation fields`：公开 core 测试可使用 `submit`，但 state 结果只有设计中的字段；wrapper 的 `submit` 隐藏由 Step 6 断言。

- [ ] **Step 4: 运行 core 测试，确认因模块尚不存在而失败**

Run:

```bash
npm test -- src/hooks/usePendingRequestChannel.test.ts
```

Expected: FAIL，原因是 `./usePendingRequestChannel` 尚不存在。

- [ ] **Step 5: 实现 session-tagged core**

在 `src/hooks/usePendingRequestChannel.ts` 实现 Step 3 接口，内部状态形状固定为：

```ts
{
  sessionId: string
  pending: Req[]
  error: string | null
  recoveryTokens: ReadonlyMap<string, symbol>
}
```

实现要求：

- sessionId 变化时使用 render-time state adjustment 换成该 session 的空状态。
- `pendingRef` 继续用于 submit 同步捕获 removed item。
- seed 使用 effect cancellation + functional session 检查；失败静默。
- `onRequest/onResolved` 捕获 sessionId，并在同一 update 中使该 id token 失效后 merge/filter。
- `submit` 注册新 symbol token 并乐观移除；POST/recovery URL 分别为 `/sessions/${sessionId}/${resource}/${id}/${action}` 和 `/sessions/${sessionId}/${resource}`。
- POST 失败只在同 session 设置 error；recovery 成功只取目标 id；recovery 失败只恢复捕获项。所有结果都同时检查 sessionId 与当前 token。
- 每条完成路径只清理自己的当前 token；`reset` 清 pending/error/tokens，`clearError` 只清 error。
- `mergePending` 泛型化但保持原引用、原位更新和追加顺序语义。

- [ ] **Step 6: 将 permission 公共 hook 改为薄 wrapper**

`usePermissionChannel.ts` 保留 `PermissionDecision`、`PlanTargetMode`、`QuestionAnswer`、`UsePermissionChannel` 的全部导出。函数体只调用 core 并创建：

```ts
decide(pid, decision)       => submit(pid, 'decide', decision, 'Permission decision failed')
answerQuestion(pid, answers)=> submit(pid, 'answer-question', { answers }, 'Answer submission failed')
clarifyQuestion(pid, text)  => submit(pid, 'clarify-question', { feedback: text }, 'Clarification submission failed')
```

返回对象显式列出原九字段，不 spread core；`decide/answerQuestion/clarifyQuestion` 继续用 `useCallback`，返回对象继续用 `useMemo`，保持现有 identity 语义。新增一条测试断言：

```ts
expect(result.current).not.toHaveProperty('submit')
```

- [ ] **Step 7: 运行 core、permission 与 synchronizer 回归**

Run:

```bash
npm test -- src/hooks/usePendingRequestChannel.test.ts src/hooks/usePermissionChannel.test.ts src/session-sync/session-synchronizer.test.ts
```

Expected: 全部 PASS；Step 1 的四个旧实现失败用例现在通过。

- [ ] **Step 8: Commit**

```bash
git add src/hooks/usePendingRequestChannel.ts src/hooks/usePendingRequestChannel.test.ts src/hooks/usePermissionChannel.ts src/hooks/usePermissionChannel.test.ts
git commit -m "refactor: share guarded permission request channel" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 迁移 elicitation wrapper

**Files:**
- Modify: `src/hooks/useElicitationChannel.ts`
- Test: `src/hooks/useElicitationChannel.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `usePendingRequestChannel<ElicitationRequestUi, ElicitationResolved>` 和 `submit`。
- Produces: 原 `UseElicitationChannel`，公开字段和 `decide(eid, decision)` 不变。

- [ ] **Step 1: 运行现有 elicitation 表征测试并记录基线**

Run:

```bash
npm test -- src/hooks/useElicitationChannel.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 2: 用 core 替换重复实现**

保留 `UseElicitationChannel` 导出和顶部“不拥有 WS 连接”的说明，删除本地 pending/error、pendingRef、seed、optimisticPost 和 mergePending。wrapper 调用：

```ts
submit(eid, 'decide', decision, 'Elicitation decision failed')
```

显式返回原七字段，不暴露 `submit`；`decide` 继续用 `useCallback`，返回对象继续用 `useMemo`。将过时的 replay/replay-done 注释改为：reconnect 时服务端以普通 request frame 重新广播仍 pending 的请求，本地按 id merge。

在现有测试文件补充：

```ts
expect(result.current).not.toHaveProperty('submit')
```

- [ ] **Step 3: 运行 wrapper、core 与 synchronizer 回归**

Run:

```bash
npm test -- src/hooks/useElicitationChannel.test.ts src/hooks/usePendingRequestChannel.test.ts src/session-sync/session-synchronizer.test.ts
```

Expected: 全部 PASS；REST 路径仍为 `/sessions/s1/elicitations...`，error 前缀仍为 `Elicitation decision failed`。

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useElicitationChannel.ts src/hooks/useElicitationChannel.test.ts
git commit -m "refactor: reuse pending channel for elicitations" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 迁移 user dialog wrapper

**Files:**
- Modify: `src/hooks/useUserDialogChannel.ts`
- Test: `src/hooks/useUserDialogChannel.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `usePendingRequestChannel<UserDialogRequestUi, DialogResolved>` 和 `submit`。
- Produces: 原 `UseUserDialogChannel`，公开字段和 `decide(did, decision)` 不变。

- [ ] **Step 1: 运行现有 dialog 表征测试并记录基线**

Run:

```bash
npm test -- src/hooks/useUserDialogChannel.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 2: 用 core 替换重复实现**

保留 `UseUserDialogChannel` 导出，删除本地重复状态与 merge。wrapper 调用：

```ts
submit(did, 'decide', decision, 'Dialog decision failed')
```

显式返回原七字段，不暴露 `submit`；`decide` 继续用 `useCallback`，返回对象继续用 `useMemo`。顶部 reconnect 注释改为普通 request frame re-broadcast + merge，不再声称 replay/replay-done 携带 dialogs。

在现有测试文件补充：

```ts
expect(result.current).not.toHaveProperty('submit')
```

- [ ] **Step 3: 运行 wrapper、core 与 synchronizer 回归**

Run:

```bash
npm test -- src/hooks/useUserDialogChannel.test.ts src/hooks/usePendingRequestChannel.test.ts src/session-sync/session-synchronizer.test.ts
```

Expected: 全部 PASS；dialog resolution 的 eviction/edit-prompt 测试不得修改。

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useUserDialogChannel.ts src/hooks/useUserDialogChannel.test.ts
git commit -m "refactor: reuse pending channel for user dialogs" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 全量验证与完整 diff review

**Files:**
- Review only: Task 1–3 的全部文件
- Modify only when a confirmed review finding requires it: 对应实现或测试文件

**Interfaces:**
- Consumes: 三个公开 wrapper、内部 core、完整测试矩阵。
- Produces: 可交付的完整 diff；不改变已确认接口。

- [ ] **Step 1: 运行全部针对性测试**

Run:

```bash
npm test -- src/hooks/usePendingRequestChannel.test.ts src/hooks/usePermissionChannel.test.ts src/hooks/useElicitationChannel.test.ts src/hooks/useUserDialogChannel.test.ts src/session-sync/session-synchronizer.test.ts
```

Expected: 全部 PASS，无 unhandled rejection、act warning 或测试结束后异步写入。

- [ ] **Step 2: 运行项目静态检查与完整测试**

Run:

```bash
npm run typecheck
npm run lint
npm test
```

Expected: 三条命令均 exit 0。

- [ ] **Step 3: 对完整变更执行 code review**

从实施前记录的 base SHA 到当前 HEAD 运行 `code-review` skill。重点逐项验证：

- 所有旧 session 异步路径都有 session 检查；
- token 检查与提交原子化，且每条路径清理 token；
- recovery 只处理目标 id；
- render-time reset 不造成无限 render 或旧状态闪现；
- 三个公开类型、REST 路径、error 文案和返回对象完全兼容；
- 没有修改 synchronizer、协议、组件或无关工作树文件。

对确认的 finding 先补失败测试再修复；非平凡修复后重新运行本任务 Step 1–3。

- [ ] **Step 4: 汇总交付结果**

报告实际净删/新增行数、四类竞态的测试证据、静态检查与完整测试结果，以及 review finding 的处理结果。不得把未运行的验证写成通过。
