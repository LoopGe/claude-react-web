# SessionCatalog 抽取与竞态修复设计

**日期：** 2026-11-03  
**状态：** 待确认  
**前置调研：** `docs/async-lifecycle-dedup-research.md`

## 1. 意图

将 `Chat.tsx` 中 commands 与 agents 两段高度相似的目录获取逻辑抽成 `useSessionCatalog`，同时修复：

- initial fetch、manual refresh 与 commands-changed 乱序落地；
- session 或 running 切换后旧响应写回当前 state/cache；
- refresh 只更新可见 state、却可能让旧响应污染后续缓存的问题。

两个资源保持独立：commands 独有 WS 更新，agents 不伪造 live 语义；plugin reload 分别刷新两者，skill reload 只刷新 commands。

## 2. 已确认的行为语义

### session 切换

- 立即显示新 session 的 hook-local 缓存；无缓存则为 `[]`。
- 旧 session 的 initial/refresh/WS 事件不得修改新 session 的可见列表或缓存。
- cache 仍是 hook 实例生命周期内的 per-session Map，不提升为模块级/global cache。

### running 切换

- `true → false`：保留当前可见列表，不发起新请求；当前 running 时代发起的迟到响应不得再提交 state/cache。
- `false → true`：命中缓存则立即采用，否则重新请求。
- 非 running 时调用 refresh：只使当前 session 缓存失效，不清当前可见列表、不发请求；以后 running 翻正时重新获取。

### 资源独立乱序防护

- commands 与 agents 各自拥有独立 operation token。
- 新 initial/refresh 操作淘汰同资源旧请求；新 refresh 淘汰更早 initial/refresh。
- commands-changed 是全量替换事件，淘汰更早的 initial/refresh；其 state/cache 提交不依赖 running。
- 只有当前 session、running（仅 REST）和 token 都匹配的响应才能提交。
- commands 与 agents 的请求和 token 互不影响。

## 3. 目标

- 新增 `useSessionCatalog(sessionId, running)`，返回 `{ commands, agents, refreshCommands, refreshAgents }`。
- Chat 删除两段本地 state/cache/effect/refresh 实现，只保留 `LOCAL_COMMANDS` 的 `mergedCommands` 派生逻辑。
- 保持 running gate、静默失败、失败保留旧列表、空数组缓存命中、独立 refresh 和公开数据形状。
- 保持 Composer 使用 merged commands、Settings 使用原始 commands/agents。
- 增加直接 hook 测试，覆盖缓存、WS、刷新、乱序和 session/running 隔离。

## 4. 非目标

- 不新增 REST/WS 接口，不改 server、SDK control request 或协议。
- 不新增 agents-changed，不让 agents 获得 WS live 更新。
- 不新增 loading/error 公共字段，不改变当前 `[]` 同时表示未加载/空/失败的 UI 语义。
- 不引入跨 Chat unmount 的缓存、全局 Map、staleTime 或请求去重。
- 不把 `LOCAL_COMMANDS` 合并结果写进 commands 缓存。

## 5. 当前 seam

当前实现内联在 `src/components/Chat.tsx:720-832`：

- commands：`state + Map + initial effect + commands-changed listener + refresh`；
- agents：`state + Map + initial effect + refresh`，无 WS；
- 两个 initial effect 有 cancelled guard，manual refresh 没有；旧 REST 响应可晚于 commands frame 或新 refresh 落地。

`useSessionCommands` 是 transcript actions，与本目录无关；`useAgentDefinitions` 是全局自定义 agent CRUD，也与 `/sessions/:id/agents` 不同。

## 6. 公开接口与内部资源

```ts
interface SessionCatalog {
  commands: SlashCommand[]
  agents: AgentInfo[]
  refreshCommands: () => void
  refreshAgents: () => void
}

export function useSessionCatalog(sessionId: string, running: boolean): SessionCatalog
```

内部使用两个 `useCatalogResource<T>` 实例，配置仅为：

```ts
{
  sessionId: string
  running: boolean
  path: string // 'commands' | 'agents'
  select: (response: unknown) => T[]
}
```

`select` 使用首 render ref 或等价稳定策略，避免内联 closure 导致重复请求。`useSessionCatalog` 自身只组合两个资源，并在 commands 资源上接 `hub.addSessionListener`；agents 不接 WS。

## 7. 纯状态模型与 operation token

每个资源使用一个 session-tagged React state：

```ts
{
  sessionId: string
  running: boolean
  token: symbol
  cache: ReadonlyMap<string, T[]>
  items: T[]
}
```

`cache` 与 `items` 必须分开：非 running refresh 清 cache 但保留 items 的现有行为无法由单一 Map 派生表达。

### session/running render-time adjustment

当 props 与 state 的 sessionId/running 不同，使用 React render-time state adjustment：

- 写入新 sessionId/running 和新的唯一 token；
- sessionId 改变时，`items = cache.get(newSessionId) ?? []`；
- 仅 running 改变时保留 items；
- cache 本身不因切换而清空。

React 重试 render 后提交，避免“新 props + 旧 session state”的一帧，也使旧响应在下一次 state update 时因 token/session/running 不匹配而 no-op。

### REST 操作

initial 与 refresh 都创建/捕获唯一 token，并在同一个纯 functional state update 中检查：

```ts
prev.sessionId === capturedSession
prev.running === true
prev.token === capturedToken
```

匹配时才同时更新 cache 与 items；不匹配时返回 prev，cache 不可能被单独污染。不得在 setState updater 外先写 cacheRef，也不得在 updater 内产生其他副作用。

- initial：running 且 cache miss 时请求；cache hit 采用缓存，不发 HTTP。
- refresh：生成新 token并删除当前 session cache；running 时发请求，非 running 只失效。
- 失败保持静默，不清 items；refresh 后的 cache miss 保留，后续 running 翻正可重试。

用于 initial effect 的最新 state 可在 effect 内通过 stateRef 获取，stateRef 自身也只在 effect 中同步，避免 render-time ref 访问。Effect 不依赖每次操作 token，否则 refresh/WS 会触发额外 initial 请求。

### commands-changed

listener 捕获其 sessionId，每次收到全量 commands：

- 创建新 token；
- functional update 只检查 prev.sessionId；
- 同时更新 cache 与 items，保留当前 running 值；
- 不检查 running，使非 running 时的权威全量事件仍可更新。

旧 session listener 的事件因 session 不匹配而 no-op。

## 8. 保持的调用方契约

- `mergedCommands` 继续由 Chat 以 `LOCAL_COMMANDS` 优先、SDK 同名项过滤的方式派生（`src/components/Chat.tsx:757-776`）。
- Composer 继续接收 mergedCommands；SettingsPanel 接收原始 commands/agents。
- `onPluginsReloaded` 仍分别调用 `refreshCommands(); refreshAgents()`；`onSkillsReloaded` 只调用 `refreshCommands()`（`src/components/Chat.tsx:2710-2711`）。
- 两个 refresh 保持 `useCallback`，其 identity 只随 sessionId/running 或资源路径变化，不因 items/cache/token 每次更新而变化。

## 9. 关键竞态不变式

1. initial A 未完成时 refresh B 发起，A 后落地不得覆盖 B，也不得写 cache。
2. initial/refresh 未完成时 commands-changed 落地，旧 REST 不得覆盖 WS 新列表。
3. 连续两次 refresh 在同一 tick 发起也使用不同 token，只有最后一次能提交。
4. session A→B 后立即显示 B cache/[]；A 的 REST/WS 迟到事件均 no-op。
5. running true→false 后迟到 REST no-op，items 保留；false→true 命中 cache 不重复请求，miss 重新请求。
6. 非 running refresh 清 cache 但保留 items，不 GET；running 翻正后重新 GET。
7. commands 的 refresh/WS 不改变 agents，agents 的 refresh 不改变 commands。
8. 空数组响应写入 cache，后续 running 翻转可命中，不重复 GET。
9. 请求失败不污染 cache、不清 items，后续 refresh 仍可重试。
10. Chat unmount 后迟到响应不产生警告；全局/模块级 cache 不存在。

## 10. 测试策略

新增 `src/hooks/useSessionCatalog.test.ts`，以 deferred Promise 和 mock hub listener 覆盖：

- running mount 分别请求 commands/agents；非 running 零请求。
- 空数组缓存、running 翻转、session cache 隔离与 hook remount 后无全局缓存。
- initial vs refresh、连续 refresh、initial/refresh vs commands-changed 的乱序。
- session 切换后的 REST/WS 旧事件、running 切换后的 REST 旧响应。
- 非 running refresh 的 cache/items/HTTP 语义。
- 两个资源独立性、失败保留与重试、unmount。
- refresh identity 不因 items/cache/token 更新而变化。
- Chat 层保留 merged commands、Settings 原始列表及 plugin/skill reload 调用差异。

实施时先让乱序/切换测试在当前内联实现可对应的公开行为上失败，再抽 core；不能仅给新实现写“永远为绿”的测试。

## 11. 实施边界

- 先建立泛型 resource + 两个 adapters 的 hook，再迁移 Chat；不改 Settings/Composer。
- 可以用一个公开 `useSessionCatalog` 文件承载内部 resource，避免为两个小 wrapper 增加无意义文件。
- 不在同一改动中引入 loading/error、全局缓存或 agents WS。
- 具体请求 helper 可由 builder 选择，但必须保持 token + state/cache 原子纯提交及 effect 不重复请求。
