# GitQuery 共享查询状态机设计

**日期：** 2026-11-03  
**状态：** 待确认  
**前置调研：** `docs/async-lifecycle-dedup-research.md`

## 1. 意图

将九个 Git 只读查询 hooks 的重复 HTTP 生命周期抽成内部 `useGitQuery<T>`，保留九个公开领域 adapters，同时统一修复：

- disabled/必填参数缺失时部分 hooks 的 loading 滞留；
- key/enable/refresh 切换时旧请求与状态迁移不一致；
- snapshot 被接受后，较早 HTTP 响应仍可能覆盖新快照；
- status 错 repo/cwd frame 虽被数据守卫丢弃，却仍清 loading/error 的半截 no-op。

不引入全局 query cache，不改变 GitPanel/WorktreeChanges 的请求时机。

## 2. 九个公开 adapters

1. `useGitStatus`
2. `useGitDiff`
3. `useGitRangeDiff`
4. `useGitRangeDiffFile`
5. `useGitLog`
6. `useGitCommitFiles`
7. `useGitCommitDiffFile`
8. `useGitBranches`
9. `useGitStashes`

不包含 `useGitSnapshotListener`、`useCachedCommitFiles` 或 mutation hook `useGitWrite`。九个公开 hook 的名称、参数和 `{ data, loading, error, refresh }` 返回形状不变。

## 3. 已确认的统一状态语义

### disabled / 必填参数缺失

统一为：

```ts
{ data: null, error: null, loading: false }
```

同时使当前 operation token 失效并 abort 当前 HTTP，迟到响应不得提交。

### 有效 key A→B / manual refresh

- 保留旧 data，`loading=true、error=null`。
- abort 较早请求并生成新 operation token；只有当前请求能落地。
- 成功写入新 data，`loading=false`。
- 失败统一 `data=null、error=err.message、loading=false`。
- refresh 在 disabled 时仍不发起请求，不改变上述 inert 状态。

### 被接受的 snapshot

- status/branches/stashes 的 snapshot 直接替换所选字段，`loading=false、error=null`。
- snapshot 获得新 operation token，使较早 HTTP 响应失效，并 abort 当前 HTTP。
- 不把 snapshot 变成 invalidate/refetch，不给其余六个纯 HTTP hooks 增加 WS。

### status 错 repo/cwd frame

accept guard 与数据提交在同一状态更新中执行：拒绝时整个事件 no-op，data/loading/error/token 都不变，也不再清 loading/error。

## 4. 保留的领域差异

- status 的 HTTP + WS 都使用 `sameStatus` 做引用保持；branches/stashes 只在 WS 路径做 JSON 引用比较；其余六个不新增 deep equality。
- status 保留已有 authoritative repoRoot guard 与 pre-authoritative cwd/repoRoot guard；branches/stashes 不新增 guard。
- diff 展开 latch、branches/stashes section open、log 当前随 GitPanel eager fetch 等时机不变。
- `useCachedCommitFiles` 的调用方 Map、cache-hit 短路和按响应 hash 归因不变。
- `gitDiffQuery`、`gitRangeDiffFileQuery`、`gitCommitDiffFileQuery` 继续供 full-diff 路径复用。
- status 的 enabled 可选且默认 true；其余八个公开参数形状不变。

## 5. 非目标

- 不引入跨实例缓存、staleTime、请求去重、全局 snapshot store 或自动 WS invalidation。
- 不统一 lazy/eager 行为，不把 log 改成 section 展开才请求。
- 不修改 GitPanel、GitCommitRows、WorktreeChanges 的组件接口或 UI。
- 不修改 server、REST/WS 协议、`useGitWrite` 或 Git 写路由。
- 不给所有 HTTP 成功路径统一 JSON stringify 比较，避免改变 render 次数。

## 6. 内部接口

新增 `src/hooks/useGitQuery.ts`：

```ts
interface GitQueryOptions<T> {
  enabled: boolean
  queryKey: string
  load: (signal: AbortSignal) => Promise<T>
  equalOnLoad?: (previous: T | null, next: T) => boolean
}

interface GitExternalUpdate<T> {
  accept?: (previous: T | null) => boolean
  equal?: (previous: T | null, next: T) => boolean
}

function useGitQuery<T>(options: GitQueryOptions<T>): {
  data: T | null
  loading: boolean
  error: string | null
  refresh: () => void
  applyExternal: (next: T, update?: GitExternalUpdate<T>) => void
}
```

- `queryKey` 由 adapter 从全部请求标量构造，必须包含 staged、mergeBase、limit、path/hash/from/to 等依赖。
- `load` 在 adapter 中用 `useCallback` 固定相同 key 的 identity；core 不把每次 render 新建的内联 closure 当稳定输入。
- `refresh` 用 tick 或等价机制重新执行当前 key，不改变公开返回。
- `applyExternal` 只供三个 snapshot adapters 使用，公开 adapters 不把它返回给组件。

## 7. Operation token 与 abort

core 内部状态至少包含：

```ts
{
  data: T | null
  loading: boolean
  error: string | null
  token: symbol
  tokenKind: 'http' | 'external'
}
```

### HTTP

- 新 key/refresh 创建新 token 和 AbortController；请求开始时保留 data、清 error、设 loading。
- effect cleanup abort 当前 controller。
- `.then/.catch` 同时检查 `ctrl.signal.aborted` 与当前 token；不匹配则 no-op。
- disabled/missing input 切换 external token，清全部状态并 abort。

### External snapshot

`applyExternal` 在一个纯 functional update 中：

1. 以当前 data 执行 accept；拒绝则返回原 state，loading/error/token 均不变。
2. 接受时生成 external token，按 equal 保留旧引用或采用 next，并清 loading/error。
3. 后续 effect 看到 external token 时 abort 当前 HTTP。

token 必须先于任何旧 HTTP 提交失效，因此即使旧响应在外部状态 commit 与 abort effect 之间落地，也无法覆盖 snapshot。不得在 setState updater 中执行 abort。

## 8. Adapter 映射

- `useGitStatus`：core HTTP + `useGitSnapshotListener`；HTTP 传 `equalOnLoad: sameStatus`，WS 传 accept + sameStatus。
- `useGitBranches/useGitStashes`：core HTTP + listener；WS 仅传现有 JSON equality，无 accept。
- `useGitLog`：load 解包 `res.commits`；branches/stashes 分别解包对应字段。
- 其余六个：仅 core HTTP，响应形状与 URL builder 保持。
- `useCachedCommitFiles` 继续包装 `useGitCommitFiles`，不并入 core。

原 `useGitStatus.ts` 保持为九个公开 adapters 的兼容出口；组件和现有 mocks 不改 import 路径。

## 9. 关键不变式

1. 请求中 disable/missing input 后 loading 必为 false，data/error 为 null，迟到响应 no-op。
2. key A→B 时旧 data 保留到新响应落地；A 不得覆盖 B。
3. refresh A→B 同 tick 或连续发生，只有当前 token 可提交。
4. 接受的 snapshot 后旧 HTTP 不得覆盖 snapshot 或 cache。
5. 错 repo/cwd status frame 不改变 data、loading、error 或 token。
6. snapshot 路径零 refetch；其余六个 hooks 不订阅 WS。
7. status HTTP/WS 相同内容保留引用；branches/stashes 仅 WS 比较；其他 HTTP 引用语义不变。
8. commit detail cache 命中仍零请求，响应按自身 hash 归因。
9. diff/branches/stashes 的重开请求和 log eager 请求次数不变。
10. 九个公开 hook 返回对象不含 `applyExternal`，query builders 可独立使用。

## 10. 测试策略

### 新 core

- disabled/missing input 全状态、abort 和迟到响应。
- key/refresh 保留旧 data、成功/失败状态、乱序响应。
- applyExternal accept/equal/token/abort，包含 snapshot 与 HTTP 交错。
- inline callback identity 不导致请求风暴，refresh identity 稳定。

### 领域 adapters

保留现有 `useGitStatus.test.ts`、GitPanel、GitCommitRows、WorktreeChanges 测试，并补齐目前缺失的 diff、range-diff、range-diff-file、log 直接测试：

- 每个 adapter 的 URL/query key、enabled、refresh、disable 请求次数。
- status repo/cwd guard 及拒绝 frame 不清 loading/error。
- branches/stashes 仅 WS equality、零 refetch。
- commit cache collapse/re-expand 与 hash 归因。
- log 当前 eager 行为、diff 重开和 branches/stashes open 行为。
- 公开返回不含 `applyExternal`。

实施时先补当前缺失的领域表征测试，再迁移 adapters；统一行为变化必须先有失败测试。

## 11. 实施边界

- 先建立 core，再按“纯 HTTP 六个 → snapshot 三个”或风险相当的小批次迁移，每个批次独立验证。
- 不顺手增加全局缓存、统一 loading UI 或修改 lazy/eager 产品行为。
- 具体 state 辅助函数可由 builder 选择，但 token + accept + 纯提交语义不得弱化。
