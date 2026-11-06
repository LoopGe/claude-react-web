# Recent CWD / Models MRU 共享与行为统一设计

**日期：** 2026-11-03  
**状态：** 待确认  
**前置调研：** `docs/async-lifecycle-dedup-research.md`

## 1. 意图

将 recent CWD 与 recent models 的重复 localStorage/MRU 实现合并为一个共享 hook 和同步持久化 primitive，同时统一两类已确认的行为差异：

1. 坏数据在初始化、同步写盘和只读路径中的过滤结果不一致；
2. 跨标签删除 storage key 后，已挂载列表仍保留旧值。

New Session 提交时的同步写盘是既有数据丢失修复，必须在抽象后完整保留。

## 2. 已确认的统一行为

### 坏数据

- 坏 JSON、非数组、读取异常：返回 `[]`。
- 混合数组：过滤非字符串，保留有效字符串及其相对顺序。
- 该规则统一应用于 CWD/models 的初始化、跨标签外部写入、同步 `rememberNow` 读取和 models 的 picker 读取。
- 不在初始化时额外 dedupe 或按 cap 截断；旧列表中的重复项和超 cap 项仍只在下一次 remember 时整理。

### 跨标签及当前标签删除与无效外部写入

- 对 MRU key 收到 `newValue === null` 的 storage event：所有已挂载实例同步为 `[]`。
- 当前标签 appearance reset 删除 CWD/models list key 时，也通过同一 listener 机制立即将所有已挂载实例同步为 `[]`；不能依赖浏览器 storage event，因为写入标签收不到该事件。
- 对 MRU key 收到坏 JSON：同样同步为 `[]`；混合数组则按上述规则过滤后采用。
- 删除/坏 JSON 导致的 reset 不得被 persistence effect 立即写回 storage；删除的 key 保持删除，坏 JSON 不被本次外部事件自动覆盖。
- 当前标签 reset 后的下一次真实 remember/update 必须正常持久化新值，不得携带 reset 前的旧列表。
- 其他 `useLocalStorage` 消费者的默认行为保持不变：跨标签删除和无效写入仍被忽略。

## 3. 目标

- 复用并扩展 `useLocalStorage`，不再新建第二套响应式 storage 机制。
- 一个共享 MRU hook 提供 `recents / remember / rememberNow / forget`。
- CWD/models 通过薄 adapter 固定各自 list key、cap key 和 exact-match policy。
- New Session 的 model + CWD 连续同步写入在提交同 tick 卸载后仍全部落盘。
- `rememberNow` 从最新 disk 值计算，而不是从可能陈旧的 React state 计算。
- `useModelOptions` 改为订阅共享 models MRU，使已挂载 picker 能响应跨标签删除和写入。
- 当前标签 appearance reset 通过共享删除通知清空已挂载 CWD/models，并防止后续 remember 复活旧列表。
- 保留普通 remember 的 functional state update、cap 3–50、trim、精确大小写去重和 forget 行为。

## 4. 非目标

- 不迁移 `useRecentColors`；其 hex、大小写和 preset policy 不在本次范围。
- 不修改 appearance reset 的 key 清单；list key 仍清除，cap key 仍保留。
- 不实现跨标签原子 MRU merge；并发写仍为 last-write-wins。
- 不改变 `useLocalStorage` 现有 validate 语义，也不要求其他 key 采用 external reset。
- 不引入全局 MRU store、后端持久化或新的 UI。

## 5. 当前实现与 seam

`useLocalStorage` 已拥有同步 lazy 初始化、JSON 编解码、validator、functional setter、同标签 listeners 和跨标签 storage 订阅（`src/hooks/useLocalStorage.ts:58-187`）。

New Session 当前用 `rememberIn` 同步执行“读最新 disk → 计算 next → 立即 setItem → 调 setter”，其注释明确记录 React 19 同 tick 卸载导致第二项写丢失的旧问题（`src/components/session-list/NewSessionDialog.tsx:222-262`）。

CWD 的普通 remember/forget 还分散在 ChatPanel 与 GlobalSettingsModal（`src/components/ChatPanel.tsx:386-406`，`src/components/GlobalSettingsModal.tsx:1020-1062`）。models 的只读路径 `useModelOptions` 目前每次 render 调 `readRecentModels()`，但自己不订阅 storage（`src/hooks/useModelOptions.ts:116-121`），因此也必须迁移到响应式 adapter。

## 6. `useLocalStorage` 扩展

在现有 `Options<T>` 上新增两个可选字段，默认值保持现状：

```ts
interface Options<T> {
  validate?: (value: unknown) => value is T
  normalize?: (value: unknown) => T
  externalFailure?: 'ignore' | 'reset' // default 'ignore'
}
```

### `normalize`

按以下顺序用于三个边界：

1. 初始读取：JSON parse → normalize → validate；
2. 跨标签写入：JSON parse → normalize → validate；
3. 本地 update：resolved value → normalize → validate。

MRU 使用 `normalizeStringArray`，不再传 strict `isStringArray`。其他调用方不传 normalize 时执行路径不变。

同标签 `notifyListeners` echo 不再 normalize：所有本地 update 已在写入前 normalize，echo 接收的是可信的同一引用。若在这里再次 filter 生成新数组，`setValue → effect → notify → setValue` 会形成通知循环。

### `externalFailure: 'reset'`

只改变外部 storage event 的失败处理：

- `newValue === null` 或 JSON parse 失败时采用 `initial`；
- 默认 `'ignore'` 仍保持现有忽略行为；
- validator 拒绝外部值时，reset 模式采用 `initial`，ignore 模式维持当前值和现有 warning。

外部 reset 需要抑制本次 persistence effect 的 setItem，但仍通知同标签 listeners。抑制状态必须是 **按 storage key 共享的模块级状态**，不能是每个 hook 实例独立、在自身 effect 中清除的标记：多个同 key 实例会依次 notify 彼此，如果先执行的实例清除标记，后执行的实例仍可能把已删除 key 写回。

设计采用 `suppressPersistenceByKey: Set<string>`：外部 delete/坏 JSON/validator reset 时加入 key；只有有效外部写入或真实用户 update 才删除 key。persistence effect 发现 key 被抑制时跳过 setItem、继续 notify，但不得自行清除抑制。这样即使 React 因 Object.is 不运行某个实例的 effect，或同标签 echo 使用不同的 `[]` 引用，也不会复活 key；下一次真实用户 update 会解除抑制并正常持久化。

### 当前标签删除通知

新增 `removeLocalStorageKey(key: string)` 内部公共 helper，供 appearance reset 调用。listener 值通道增加私有 deletion sentinel：

- helper 将 key 加入抑制集合、物理 removeItem，再向同标签 listeners 发送 deletion sentinel；
- `externalFailure: 'reset'` 的实例收到 sentinel 后采用各自 `initial`，默认实例保持现状；
- 正常值通知与 deletion sentinel 分离，不要求模块级 listener 知道各实例的 initial；
- 不手工派发浏览器 `StorageEvent`，避免把当前标签通知与真实跨标签事件混为一谈。

`useResetConfig` 仅对 `RECENT_MODELS_KEY` 和 `RECENT_CWDS_KEY` 改用该 helper；其他 appearance keys 仍走原来的 removeItem，key 清单不变。

## 7. MRU 与同步 storage primitive

新增私有工具，职责限定为字符串列表与 MRU 计算：

```ts
function normalizeStringArray(value: unknown): string[]
function nextMru(previous: unknown, raw: string, cap: number): string[] | null
function readStringList(key: string): string[]
function rememberStringListNow(key: string, raw: string, cap: number): string[] | null
```

契约：

- `normalizeStringArray`：数组逐项过滤非字符串；非数组返回 `[]`。
- `nextMru`：trim；空白返回 null/no-op 语义由 hook 保持；新值置顶、精确大小写去重、尾部截断。
- `readStringList`：无 window、坏 JSON、非数组、读取异常均返回 `[]`；混合数组逐项过滤。
- `rememberStringListNow`：空白返回 null；否则从最新 disk 计算 next，立即同步 setItem 并返回 next。同步读写异常保持 New Session 当前的静默策略；即使 setItem 失败也返回 next，让内存 state 尝试更新。

## 8. 共享 hook 与领域 adapter

新增 `src/hooks/useRecentItems.ts`：

```ts
interface RecentItems {
  recents: string[]
  remember: (raw: string) => void
  rememberNow: (raw: string) => void
  forget: (value: string) => void
}

export function useRecentCwds(): RecentItems
export function useRecentModels(): RecentItems
```

内部 `useRecentItems(key, capKey)`：

- list 使用 `useLocalStorage(key, [], { normalize: normalizeStringArray, externalFailure: 'reset' })`；
- cap 使用现有 cap key/default，`round` 后 clamp 3–50；
- `remember` 用 functional update + `nextMru`；
- `rememberNow` 调 `rememberStringListNow`，随后用返回的 next 调 setter；
- `forget` 用精确匹配过滤；
- 所有回调使用 `useCallback`，返回对象使用 `useMemo`。

### 调用方迁移

- NewSessionDialog：CWD/models 都改用 adapter；submit 路径调 `rememberNow`，删除本地 `rememberIn`、cap 计算和重复 reader。
- ChatPanel：CWD 改用 `remember/forget`，仍只在 relocation PATCH 成功后 remember。
- GlobalSettingsModal/Skills：CWD 改用 `remember/forget`，成功/失败写入时机不变。
- `useModelOptions`：用 `useRecentModels().recents` 替换每次 render 的 `readRecentModels()`。
- `useResetConfig`：仅 CWD/models list key 改用 `removeLocalStorageKey`，使当前标签已挂载实例同步清空；cap key 和其他 appearance keys 不变。
- 删除已无消费者的 `src/utils/recent-models.ts`；ProjectPicker、ModelPicker 和 AddSkillCard 的 props/UI 不变。

## 9. 关键不变式

1. Create 点击后即使 NewSession 同 tick 卸载，model 与 CWD 两个 list key 都已同步包含新值。
2. `rememberNow` 连续调用两次时，第二次读取包含第一次结果的最新 disk，不丢失第一项。
3. React state 陈旧时，`rememberNow` 仍合并 storage 中其他实例刚写入的值。
4. 直接 setItem 不触发同标签 storage event，因此 `rememberNow` 后必须继续调 setter，让当前和其他实例同步。
5. 普通 remember 不直接同步写盘，沿用 `useLocalStorage` 的 effect 持久化。
6. normalize 不应用于同标签 echo，避免新数组引用通知循环。
7. 外部 delete/坏 JSON reset 不得复活 key；后续真实用户 update 必须正常持久化。
8. 当前标签 appearance reset 立即清空已挂载 CWD/models，后续 remember 只写新值，不复活旧列表。
9. 旧列表仅在 remember 时 dedupe/截断；forget 只精确移除目标，不顺带 cap 或重排其他项。
10. cap key 不随 appearance reset 删除，cap 变化本身不主动修剪列表。

## 10. 测试策略

### `useLocalStorage`

- 默认消费者在 delete/坏 JSON 时仍保持当前值。
- normalize 在初始、跨标签和 update 三个边界逐项过滤混合数组。
- reset 模式在 delete/坏 JSON 时清空所有挂载实例，且在多实例同标签 echo 后仍不重新 setItem。
- 当前标签 `removeLocalStorageKey` 清空所有 reset 模式实例，默认实例行为不变；后续真实 update 正常写盘。
- reset 后紧接着的用户 update 正常 setItem，覆盖“state 未变化导致 effect 不运行”的情况。
- 同标签双实例在 normalize + remember/forget/rememberNow 后一致，无通知循环。

### MRU primitive/hook

- trim、空白 no-op、置顶、精确大小写、cap 3/50、forget。
- 坏 JSON、非数组、混合数组、读取异常在所有读取路径结果一致。
- 初始旧列表不主动 dedupe/截断；remember 才整理。
- 最新 disk 合并、连续 rememberNow、同步写失败仍更新内存。
- Node/no-window reader 返回 `[]`，同步 writer 不抛出。
- Create 后立即卸载时 models + CWD 均已同步落盘。

### 调用方回归

- NewSession recents 展示、forget、submit 同步写入。
- Chat relocation 成功才写、失败不写。
- Skills 安装成功/失败、目录选择与 forget 行为。
- `useModelOptions` 已挂载时响应 models 外部写入和删除，并保留原有 server model fetch 行为。
- appearance reset 仍只清 list key，不清 cap key；当前标签已挂载列表立即为空，后续 remember 不复活旧值。

## 11. 实施边界

- 先用失败测试证明 strict reader 与跨标签 delete 的旧行为差异，再扩展 `useLocalStorage`。
- 先建立 primitive + CWD/models adapters，再逐调用方迁移；不要在一次修改中顺手调整 UI。
- 不改 `useRecentColors`，不把它的 policy 注入本次抽象。
- 具体 helper 文件拆分可由 builder 按“纯计算 / 同步 storage / React hook”职责决定，但公开 adapter 名称和上述行为契约不变。
