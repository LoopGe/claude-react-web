# 四组重复异步生命周期合并方案调研

**日期：** 2026-11-02  
**范围：** 只读源码调研；不修改产品代码、不修改协议、不执行运行时验证。下文区分“源码事实”和“建议”，接口均为设计草案。

## 结论摘要

四组方案都成立，但应作为四个独立、行为保持的小重构，不应进一步合成一个跨领域的通用异步大 hook。

| 方案 | 结论 | 相对风险 | 必须守住的 seam |
| --- | --- | --- | --- |
| 九个 Git 查询 hook → 内部 `useGitQuery<T>` | **go** | 中 | 九个公开领域 hook 不变；请求 key、lazy/eager 时机、snapshot sink、repo guard、commit cache 和引用比较不变 |
| permission / elicitation / dialog → 内部 `usePendingRequestChannel` | **go** | 中低 | 三个独立状态实例和公开 wrapper；不拥有 WS 订阅，不合并统一 FIFO，不接管 transcript 副作用 |
| commands / agents → `useSessionCatalog` | **go** | 中低 | 从 `Chat.tsx` 抽取两个独立资源；commands 独有 WS，两个 refresh 独立，缓存范围不扩大 |
| recent CWD / models → 同步持久化 primitive + MRU hook | **go，但必须保留双写入模式** | 中 | 复用现有 `useLocalStorage`；普通 functional update 与 New Session 的同步 `rememberNow` 并存 |

“go”都以窄抽象为前提。如果实现开始把差异收进大量策略回调，或顺手统一缓存、错误、加载和跨会话语义，应停止扩大，而不是在同一个去重提交里改产品行为。

---

## 方案 1：九个 Git 查询 hook 共用内部 `useGitQuery<T>`

### 源码事实：九个的计数准确，但只指基础只读查询

九个公开查询 hook 是：

1. `useGitStatus`（`src/hooks/useGitStatus.ts:98`）
2. `useGitDiff`（`src/hooks/useGitStatus.ts:206`）
3. `useGitRangeDiff`（`src/hooks/useGitStatus.ts:265`）
4. `useGitRangeDiffFile`（`src/hooks/useGitStatus.ts:338`）
5. `useGitLog`（`src/hooks/useGitStatus.ts:399`）
6. `useGitCommitFiles`（`src/hooks/useGitStatus.ts:456`）
7. `useGitCommitDiffFile`（`src/hooks/useGitStatus.ts:526`）
8. `useGitBranches`（`src/hooks/useGitStatus.ts:628`）
9. `useGitStashes`（`src/hooks/useGitStatus.ts:687`）

不包含内部 WS helper `useGitSnapshotListener`、commit 缓存包装 `useCachedCommitFiles` 和 mutation hook `useGitWrite`（`src/hooks/useGitStatus.ts:46,583`，`src/hooks/useGitWrite.ts:74`）。因此方案名称应明确为“九个查询 hook”，不是“所有 Git hooks”。

### 真正重复的生命周期

九个 hook 都维护 `data/loading/error/tick`，在 enabled 和必填参数满足时 GET，请求时保留旧 data，成功或失败后更新状态，以 `AbortController` 阻止旧响应落地，并通过稳定 `refresh()` 增加 tick。公开返回均为 `{ data, loading, error, refresh }`。以 status 为典型实现见 `src/hooks/useGitStatus.ts:104-156`，其余八个位于同文件对应区段。

适合进入共享内核的只有：

- 查询状态与状态迁移；
- enabled/required-input 的 inert 分支；
- abort、cleanup 和 stale response 防护；
- 标量查询 key 与手动 refresh；
- 响应解包之后的 `T` 状态，不认识具体 REST DTO。

### 不能统一掉的差异

| 差异 | 当前契约 |
| --- | --- |
| URL 与响应适配 | log/branches/stashes 解包数组，其余返回完整响应；`staged`、`mergeBase`、`limit` 都必须进入查询 key（`src/hooks/useGitStatus.ts:187-199,291-293,323-334,422-427,513-522,651-656,710-715`） |
| snapshot sink | 只有 status/branches/stashes 直接应用 `git-snapshot`，其余六个没有 WS（`src/hooks/useGitStatus.ts:165-176,671-678,730-737`） |
| status repo guard | WorktreeChanges 会订阅主 session 通道而读取 worktree cwd，必须按 repoRoot/cwd 拒绝错帧（`src/hooks/useGitStatus.ts:158-175`，`src/components/WorktreeChanges.tsx:103-108`） |
| 引用比较 | status 的 HTTP 与 WS 都比较；branches/stashes 只在 WS 路径比较；其余六个不比较（`src/hooks/useGitStatus.ts:138,169-172,653-655,672-675`） |
| disabled loading | range、range-file、commit-files、commit-diff-file 清 loading；status、diff、log、branches、stashes 当前不清（`src/hooks/useGitStatus.ts:110-121,218-223,278-284,352-358,410-415,467-473,538-544,639-644,698-703`） |
| commit cache | `useCachedCommitFiles` 的调用方 Map、cache-hit 短路和按响应 hash 归因是独立领域缓存（`src/hooks/useGitStatus.ts:583-613`） |
| lazy/eager 时机 | diff 由展开 latch 触发，branches/stashes 由 section open 触发；log 当前实际随 GitPanel 挂载 eager fetch，因为 section 退出不卸载（`src/components/GitPanel.tsx:643-656,777-788,1118-1121,1278-1280,1381-1393`，`src/components/AnimatedCollapse.tsx:679-684`） |

`git-snapshot` 的 payload 本身就是新状态，协议明确要求直接应用、零 refetch；`sessionId` 只是触发者，不能用于路由（`shared/ws-protocol.ts:292-309`）。共享内核若把 snapshot 变成 invalidate/refetch，属于架构倒退。

### 建议：共享请求内核，WS 留在适配器

保留 `src/hooks/useGitStatus.ts` 为九个公开 hook 的兼容出口，新增私有 core。概念接口如下，重点不是字段名字，而是职责分配：

```ts
function useGitQuery<T>(opts: {
  enabled: boolean
  queryKey: string
  load: (signal: AbortSignal) => Promise<T>
  clearLoadingWhenDisabled: boolean
  equalOnLoad?: (previous: T | null, next: T) => boolean
}): {
  data: T | null
  loading: boolean
  error: string | null
  refresh: () => void
  // 仅供内部领域适配器应用 snapshot；九个公开返回类型不暴露它。
  applyExternal: (next?: T, equal?: (previous: T | null, next: T) => boolean) => void
}
```

- 三个 snapshot sink 继续使用现有 `useGitSnapshotListener`；status 自己执行 repo guard，branches/stashes 保持直接应用。这样不会给六个纯 HTTP hook 增加订阅，也不改变 holder 生命周期。
- `load` 和比较回调通过 ref 读取最新值，不能把适配器内联 closure 的 identity 放进请求 effect，否则每次 render 都会 abort + refetch。现有 WS listener 已采用同类防 churn 处理（`src/hooks/useGitStatus.ts:41-66`）。
- `queryKey` 必须包含全部标量依赖；不要传未序列化的数组字面量后直接作为 React dependency。
- 保持 key A→B 加载期间保留旧 data；只在 disabled/missing input 时清空。`clearLoadingWhenDisabled` 首轮用于忠实保留现状，若想统一修复，另开行为变更。
- 不给 core 加跨实例缓存、staleTime、请求去重、自动 WS invalidation 或全局 snapshot store。
- 保留 `gitDiffQuery`、`gitRangeDiffFileQuery`、`gitCommitDiffFileQuery` 纯函数，full-diff 调用点绕过 hook 复用它们。

### 回归测试

现有 `useGitStatus.test.ts` 已覆盖 status/branches/stashes、commit-files/commit-diff-file 和 cached wrapper（`src/hooks/useGitStatus.test.ts:55-235`），但 diff、range-diff、range-diff-file、log 缺少直接测试。迁移前应补齐这四类的 URL、key、refresh、disable 与 abort 表征测试。

必须保留：snapshot 零 HTTP、status guard 与各路径引用比较、commit cache 命中零请求、diff 折叠后重开重新请求、branches/stashes open 行为，以及 log 当前 eager 行为。GitPanel 与 GitCommitRows 现有集成测试继续通过原公开 mock 出口运行（`src/components/GitPanel.test.tsx:23-34,175-188`，`src/components/GitCommitRows.test.tsx:169-196`）。

---

## 方案 2：permission / elicitation / dialog 共用 `usePendingRequestChannel`

### 源码事实：三者是高度同构的状态/HTTP channel

三个公开 hook 是 `usePermissionChannel`、`useElicitationChannel`、`useUserDialogChannel`。它们都不自行订阅 WS；调用方把 request/resolved frame 传入 `onRequest/onResolved`（`src/hooks/usePermissionChannel.ts:1-8`，`src/hooks/useElicitationChannel.ts:1-11`，`src/hooks/useUserDialogChannel.ts:1-11`）。

WS 生命周期由 `SessionSynchronizer` 统一拥有：先注册 listener 再 subscribe，stop 时统一清理，React adapter 在 mount/session/running 变化时 start/stop（`src/session-sync/session-synchronizer.ts:137-201`，`src/session-sync/useSessionSynchronizer.ts:52-118`）。新内核不应再订阅 Hub。

三者共同拥有：

- 非空 session 的一次 REST seed，失败静默，卸载后结果不落地（`src/hooks/usePermissionChannel.ts:60-82`，`src/hooks/useElicitationChannel.ts:42-60`，`src/hooks/useUserDialogChannel.ts:42-60`）。
- 按 id 保序 merge：已有项原位更新、新项追加、空 incoming 保留原数组引用（`src/hooks/usePermissionChannel.ts:149-165`，另外两文件同为 `:110-127`）。
- optimistic POST：先移除 pending；失败后设置领域 error，GET 恢复；GET 也失败则重新插入捕获项（`src/hooks/usePermissionChannel.ts:94-117`，另外两文件同为 `:72-95`）。
- `reset` 与 `clearError`，以及公开数组状态而非 Map。

Reconnect 时服务端把仍 pending 的请求作为普通 request frame 幂等重发，而不是权威全量 snapshot（`shared/ws-protocol.ts:17-24`，`server/frame-bridge.ts:374-432,579-583`）。因此 seed 和重发必须 merge，不能改成 replace。elicitation/dialog 文件中关于 replay/replay-done 携带 pending 的注释是旧描述，可在实现时修正注释，不改协议。

### 必须保留的领域差异

- Permission 有 `decide/answerQuestion/clarifyQuestion` 三个强类型操作；另外两者只有各自 `decide`（`src/hooks/usePermissionChannel.ts:119-134`，`src/hooks/useElicitationChannel.ts:72-95`，`src/hooks/useUserDialogChannel.ts:72-95`）。
- Permission resolution 还会 dispatch transcript action；dialog resolution 还会 eviction/edit-prompt；elicitation 没有这些副作用（`src/session-sync/session-synchronizer.ts:456-521`）。共享 `onResolved` 只能删除 pending。
- UI 优先级是 permission/question → elicitation → dialog，不是跨领域到达时间 FIFO（`src/components/Chat.tsx:2593-2679`）。Side Chat 只创建 permission channel，不应新增另外两类 REST 请求（`src/components/ChatPanel.tsx:557-578`）。
- 三类 error 当前独立；Chat banner 只组合 permission error（`src/components/Chat.tsx:1568-1577`）。不要在抽取时统一 error 展示。
- 主 Chat 依靠 `key={session.id}` remount 隔离 session（`src/components/ChatPanel.tsx:1369-1372`）。现有 hook 对“不 remount 直接换 sessionId”及旧 recovery 写回没有完整 epoch 防护；这应单独立项，不与去重混合。

### 建议接口

```ts
function usePendingRequestChannel<
  Req extends { id: string },
  Res extends { id: string },
>(
  sessionId: string,
  resource: 'permissions' | 'elicitations' | 'dialogs',
): {
  pending: Req[]
  error: string | null
  onRequest: (req: Req) => void
  onResolved: (res: Res) => void
  reset: () => void
  clearError: () => void
  submit: (
    id: string,
    action: 'decide' | 'answer-question' | 'clarify-question',
    body: unknown,
    errorPrefix: string,
  ) => Promise<void>
}
```

`resource` 使用 primitive union，避免每次 render 新建配置对象。三个原 hook 变成薄 wrapper，显式列出原返回字段，保留原类型导出和 import 路径；不要 spread 内部结果而泄漏 `submit`。每个 wrapper 各调用一次 core，因而不是一个统一 pending 队列。

### 回归测试

三份现有测试已覆盖 seed、request/resolved、乐观失败恢复、reset 和顺序，可作为黑盒兼容网（`src/hooks/usePermissionChannel.test.ts:48-319`，`src/hooks/useElicitationChannel.test.ts:48-199`，`src/hooks/useUserDialogChannel.test.ts:51-203`）。SessionSynchronizer 测试继续钉住 frame 转发、dialog eviction/edit-prompt 与订阅生命周期（`src/session-sync/session-synchronizer.test.ts:218-377,727-746,794-825`）。

可先迁移 elicitation/dialog，再迁移 permission；不改组件、协议或 synchronizer。另补 sessionId rerender、旧 session deferred seed/recovery、recovery 与 request/resolved 竞态，但这些测试若暴露旧 bug，修复应独立提交。

---

## 方案 3：commands / agents 抽取 `useSessionCatalog`

### 源码事实：当前不是两个独立 hooks

两段逻辑都内联在 `Chat.tsx`。已有 `useSessionCommands` 是 transcript 乐观命令 action，不是 slash-command catalog（`src/hooks/useSessionCommands.ts:1-27`）；`useAgentDefinitions` 管理全局自定义 agent CRUD，也不是 `/sessions/:id/agents`（`src/hooks/useAgentDefinitions.ts:14-33`）。

Commands 与 agents 当前都具有：组件内 `Map<sessionId, T[]>`、`session.running` gate、mount fetch、空数组可命中、失败静默、非 running 不主动清空、独立 refresh（`src/components/Chat.tsx:719-745,777-831`）。

差异是：

- Commands 监听 `commands-changed`，frame 携带完整替换列表；agents 没有对应 WS 协议（`src/components/Chat.tsx:748-755`，`shared/ws-protocol.ts:416-423,574-602`）。
- Composer 使用 `LOCAL_COMMANDS` 合并后的 `mergedCommands`，Settings 使用原始 commands/agents；合并结果不能回写缓存（`src/components/Chat.tsx:756-775,2525,2697-2705`）。
- Plugin reload 刷新两者，skill reload 只刷新 commands（`src/components/SettingsPanel.tsx:840-862`）。不能只留下统一 `reload()`。
- 两个 REST 都是 live SDK control read，running gate 必须保留（`server/routes/sessions.ts:1175-1195`，`server/session-manager.ts:5562-5581`）。

当前 cache ref 只在同一个 mounted Chat 内有效；Chat 以 session id key remount，所以注释中的“切换回来不重新请求”并不跨 unmount 成立（`src/components/ChatPanel.tsx:1369-1372`）。hook-local cache 是行为等价抽取；模块级/global Map 是新的缓存策略，不应混入。

### 建议接口

```ts
function useSessionCatalog(sessionId: string, running: boolean): {
  commands: SlashCommand[]
  agents: AgentInfo[]
  refreshCommands: () => void
  refreshAgents: () => void
}
```

内部可用一个泛型 resource helper 共享 cache/running/fetch/cancel/refresh，但 commands 与 agents 必须有独立状态、缓存和 refresh。Commands 独有 WS adapter；agents 不伪造 live 更新。首轮不新增 loading/error、全局缓存或 REST/WS 协议。

当前 initial fetch 有 cancelled guard，而手动 refresh 没有；早期 REST 也可能晚于 commands frame 落地（`src/components/Chat.tsx:725-755,805-831`）。统一 request generation 是合理后续修复，但“严格行为保持抽取”和“竞态修复”应分开，避免无法定位行为差。

### 回归测试

新增 `useSessionCatalog.test.ts`，覆盖 running gate、空数组缓存、running 翻转、session 隔离、commands frame 同时更新可见值/cache、agents 无 live 假设、两个 refresh 独立、失败保留旧值和 unmount。保留一项 Chat 层测试，确认 Composer 得到 merged commands、Settings 得到原始 commands/agents，以及 plugin/skill reload 的调用差异。现有真实 Chat 测试只 mock 两个 endpoint，并未覆盖这些契约（`src/components/streaming-render-isolation.test.tsx:126-131`）。

---

## 方案 4：recent CWD / models 共用同步持久化 primitive 与 MRU hook

### 源码事实：底座已经存在，不需要再发明 localStorage hook

现有 `useLocalStorage` 已提供同步 lazy 初始化、JSON 编解码、validator、functional setter、同标签 listener 和跨标签 storage 同步（`src/hooks/useLocalStorage.ts:58-187`）。key、cap key 和默认 cap 已集中在 `src/constants/recentKeys.ts:1-6`，通用 `isStringArray` 在 `shared/type-guards.ts:11-14`。

CWD 在 NewSessionDialog、ChatPanel relocation、GlobalSettingsModal/Skills 中写入；models 的实际写入集中在 NewSessionDialog（`src/components/session-list/NewSessionDialog.tsx:216-274,490-494`，`src/components/ChatPanel.tsx:386-406`，`src/components/GlobalSettingsModal.tsx:1020-1062,1282-1292`）。`useModelOptions` 的 models 只读路径每次 render 调 `readRecentModels()`（`src/hooks/useModelOptions.ts:116-121`，`src/utils/recent-models.ts:6-14`）。

两者共同 MRU 规则是：trim、空白 no-op、精确大小写去重、新值置顶、按独立 cap 截断；cap 经 round 后 clamp 3–50，仅在 remember 时截断（`src/components/session-list/NewSessionDialog.tsx:216-220,237-274`，`src/components/ChatPanel.tsx:388-396`）。

### 最高风险：New Session 的同步写盘不能退化成普通 state updater

NewSessionDialog 提交会在同 tick 卸载。现有代码明确记录：不能依赖 `useLocalStorage` 的 effect flush，也不能把副作用放进 React 19 state updater；第二个 remember 曾因此丢写。当前修复是“重新读最新 disk → 同步计算 next → 立即 setItem → 再调用 setter 更新仍挂载的 UI”（`src/components/session-list/NewSessionDialog.tsx:222-262`）。

因此必须保留两个入口：

1. 普通界面操作：functional state update，由 `useLocalStorage` 持久化并同步其他实例。
2. New Session 提交：`rememberNow` 同步读盘和写盘，再更新 React state。

只抽一个 `remember(prev => ...)` 或只用 effect 持久化，会重新引入已修复的数据丢失。

### 其他不能抹平的差异

- 初始化使用 all-or-nothing `isStringArray`；New Session 同步 reader 与 `readRecentModels` 对混合数组逐项过滤。统一校验会改变坏数据恢复行为（`src/components/session-list/NewSessionDialog.tsx:28-32,245-251`，`src/utils/recent-models.ts:6-14`）。
- `useLocalStorage` 写失败会 warn 并保留内存更新；同步写失败当前静默（`src/hooks/useLocalStorage.ts:142-167`，`src/components/session-list/NewSessionDialog.tsx:256-261`）。
- 直接 setItem 不触发同标签 storage event，所以 `rememberNow` 后仍必须调用 setter/既有 listener 机制。
- 跨标签删除事件当前被忽略，旧列表初始化也不会主动 dedupe/trim 到 cap；不要借抽象改变（`src/hooks/useLocalStorage.ts:107-127`）。
- `useRecentColors` 有固定 cap=6、hex 校验、小写/case-insensitive 去重和 preset 排除，不能直接复用同一组 policies（`src/hooks/useRecentColors.ts:22-53`）。第一阶段不迁移 colors。

### 建议结构

1. 提取纯 MRU 计算 helper。
2. 提取 New Session 当前“lenient 读最新 disk → 同步写 → 返回 next”的私有 primitive，保留异常策略。
3. 新增 `useRecentItems`，内部复用 `useLocalStorage`，公开 `recents / remember / rememberNow / forget`；`rememberNow` 只给提交路径使用。
4. CWD/models 用薄 wrapper 固定 key、cap key 和 exact-match policy。
5. 暂时保留 `readRecentModels` 只读适配器，不强行把其 lenient reader 改成 all-or-nothing。

### 回归测试

现有 `useLocalStorage` 测试覆盖初始化、functional update、坏数据、同标签与跨标签同步（`src/hooks/useLocalStorage.test.ts:9-206`）；NewSession 与 Skills 测试覆盖部分展示、forget 和成功/失败写入（`src/components/session-list/NewSessionDialog.test.tsx:310-329,785-827`，`src/components/GlobalSettingsModal.skills-add.test.tsx:473-510,731-764,869-877`）。

必须新增的最高优先级用例：Create 后立即卸载时 model 与 CWD 两个 key 都已同步落盘；React state 陈旧时 `rememberNow` 从最新 disk 合并；同标签双实例在 remember/forget/rememberNow 后一致。另补 trim、精确大小写、cap 3/50、混合坏数组两种 reader 语义、写失败、Node/no-window，以及 appearance reset 只清列表 key、不清 cap key 的兼容性（reset 现状见 `src/hooks/useResetConfig.ts:13-25`）。

---

## 推荐实施顺序与提交拆分

1. **Pending channel**：三份实现最同构、现有黑盒测试最完整，先建立“内部 core + 原公开 wrapper”的模式。
2. **MRU**：收益直接，但先补同步提交卸载测试，再迁移；不得只保留普通 updater。
3. **SessionCatalog**：从 Chat 抽离两个资源，先钉住独立 refresh、WS 和缓存范围。
4. **Git query**：最后做。适配器最多，且请求时机、WS、引用比较和 disabled 差异最广。

四项独立提交，不共享一个“大而全”的 async 配置模块。每项都遵循：

- 公开 hook 名称、参数、返回形状和调用点优先不变；
- 先运行/补齐表征测试，再替换实现；
- 共性测试放在内部 core，领域测试留在公开 adapter，避免同一行为双层重复断言；
- 发现旧 bug 可记录并另修，不在去重提交里顺手统一；
- 若 core 需要大量领域回调才能模拟旧行为，缩小 core，而不是继续加配置。

## 针对性验证命令（实施时）

```bash
npm test -- src/hooks/usePermissionChannel.test.ts src/hooks/useElicitationChannel.test.ts src/hooks/useUserDialogChannel.test.ts src/session-sync/session-synchronizer.test.ts
npm test -- src/hooks/useLocalStorage.test.ts src/components/session-list/NewSessionDialog.test.tsx src/components/GlobalSettingsModal.skills-add.test.tsx src/hooks/useModelOptions.test.ts
npm test -- src/hooks/useSessionCatalog.test.ts src/components/streaming-render-isolation.test.tsx
npm test -- src/hooks/useGitStatus.test.ts src/components/GitPanel.test.tsx src/components/GitCommitRows.test.tsx
npm run typecheck
npm run lint
npm test
```

其中 `useSessionCatalog.test.ts` 是建议新增文件。此次调研只写入本报告，未运行上述测试，也未修改任何产品实现。
