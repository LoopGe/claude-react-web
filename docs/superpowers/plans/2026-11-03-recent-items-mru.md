# Recent Items MRU Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 共用 recent CWD/models 的 MRU 与同步持久化实现，统一坏数据过滤，并让跨标签及当前标签删除立即、可靠地同步到所有挂载实例。

**Architecture:** 在现有 `useLocalStorage` 上增加可选 normalize 和 external-reset 支持，以按 key 共享的持久化抑制防止删除复活。一个私有 MRU core 加两个领域 adapter 提供普通 remember、同步 rememberNow 和 forget；各调用方逐步迁移，UI 与 server 行为不变。

**Tech Stack:** React 19、TypeScript、浏览器 localStorage/StorageEvent、Vitest、@testing-library/react。

**Spec:** `docs/superpowers/specs/2026-11-02-recent-items-mru-design.md`

## Global Constraints

- 坏 JSON、非数组和读取异常返回 `[]`；混合数组逐项过滤非字符串，保留有效项顺序。
- 初始化不主动 dedupe/cap；仅 remember 时 trim、精确大小写去重、置顶和截断，cap round 后 clamp 3–50。
- New Session 的 `rememberNow` 必须“读最新 disk → 同步 setItem → 调 setter”，Create 同 tick 卸载时 models + CWD 都不得丢写。
- 同标签 echo 不重新 normalize，避免新数组引用造成 `setValue → notify → setValue` 循环。
- 外部 delete/坏 JSON/validator reset 使用按 key 共享的 `suppressPersistenceByKey`；effect 可跳过 setItem但不得清除抑制，只有有效外部写入或真实用户 update 才解除。
- 当前标签 appearance reset 仅对 CWD/models list key 使用 `removeLocalStorageKey`；cap key、colors 和其他 appearance keys 不变。
- 其他 `useLocalStorage` 消费者的默认跨标签 delete/invalid 行为保持忽略。
- 不迁移 `useRecentColors`，不修改 picker props/UI、REST 或 server。
- 只 stage 每个任务列出的文件；主工作树中的其他改动不得混入提交。

## Review Focus

- **多实例删除 echo：** 多个同 key 实例收到 delete 后必须全为空且 key 不得复活；由 Task 1 的 multi-instance reset 测试覆盖。
- **Object.is 不触发 effect：** reset 时若某实例未运行 effect，后续真实 update 仍必须正常写盘；由 Task 1 的 post-reset update 测试覆盖。
- **同标签 reset 后 remember：** appearance reset 后不得携带旧列表复活；由 Task 5 的 mounted-reset 集成测试覆盖。
- **normalize echo 循环：** 同 key 双实例同步数组时不得无限通知；由 Task 1/2 的双实例测试覆盖。
- **提交卸载与最新 disk：** 连续两次 rememberNow 及 Create 卸载都不能丢第一项或覆盖其他实例的新值；由 Task 2/3 的同步写盘测试覆盖。

---

### Task 1: 扩展 `useLocalStorage` 的 normalize 与 external reset

**Files:**
- Modify: `src/hooks/useLocalStorage.ts`
- Modify: `src/hooks/useLocalStorage.test.ts`

**Interfaces:**
- Produces:

```ts
interface Options<T> {
  validate?: (value: unknown) => value is T
  normalize?: (value: unknown) => T
  externalFailure?: 'ignore' | 'reset' // default 'ignore'
}

export function removeLocalStorageKey(key: string): void
```

- [ ] **Step 1: 写 normalize、delete reset 与多实例失败测试**

在 `useLocalStorage.test.ts` 增加测试专用 `normalizeStrings(value: unknown): string[]`，并覆盖：

```ts
it('normalizes initial reads, local updates, and cross-tab writes', () => {
  // 三种边界输入 ['keep', 42, 'also-keep'] 都得到 ['keep', 'also-keep']。
})

it('keeps the current value on delete by default', () => {
  // 不传 externalFailure；delete storage event 后旧值不变。
})

it('resets every instance on delete without re-persisting through echo', () => {
  // 同 key 两个 reset 实例；mount 后清空 setItem spy。
  // delete 后两者=[]，getItem(key)=null，setItem spy 零调用。
})

it('resets on corrupt external JSON without overwriting the corrupt key', () => {
  // reset 模式，外部 newValue='{bad json'；state=[]，不发生 setItem。
})

it('persists a real update after an external reset even if an instance bailed out', () => {
  // reset 后马上 update(['fresh'])；必须解除抑制并写入 ['fresh']。
})

it('removeLocalStorageKey resets opted-in mounted instances immediately', () => {
  // 当前标签无 StorageEvent；两个 reset 实例立即=[]，key 保持 null。
  // 随后 update(['after-reset']) 只写新值。
})

it('synchronizes normalized arrays between same-tab instances without a notification loop', () => {
  // 双实例 update 后值一致；测试在有限 render 内完成，无 maximum-depth 错误。
})
```

保留现有 `keeps a good local value when another tab writes garbage`，证明默认 ignore 不变。

- [ ] **Step 2: 运行测试并确认新行为缺失**

Run:

```bash
npm test -- src/hooks/useLocalStorage.test.ts
```

Expected: 新增 normalize/reset/remove 测试 FAIL；现有默认行为测试继续 PASS。

- [ ] **Step 3: 实现 normalize、deletion sentinel 与按 key 抑制**

在 `useLocalStorage.ts`：

- 按“初始读取 / 跨标签写入 / 本地 update”三个边界执行 `normalize → validate`；同标签普通 echo 不 normalize。
- 增加模块级 `suppressPersistenceByKey: Set<string>`。外部 reset 加 key；有效外部写入和 `update` 删 key；effect 遇抑制只跳过 setItem、仍 notify，绝不清除。
- listener 值通道增加私有 deletion sentinel；`removeLocalStorageKey` 执行“加抑制 → removeItem → 当前标签 deletion 通知”。reset 实例采用各自 initial，默认实例忽略 sentinel。
- `newValue === null`、坏 JSON 和 validator 外部失败按 `externalFailure` 分流；默认路径保持现有行为。
- normalize/externalFailure 与 validate 一样采用首 render ref 语义，避免每 render 重订阅。

- [ ] **Step 4: 运行 storage 全测试**

Run:

```bash
npm test -- src/hooks/useLocalStorage.test.ts
```

Expected: 全部 PASS，无 act/maximum-depth/unhandled 错误。

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useLocalStorage.ts src/hooks/useLocalStorage.test.ts
git commit -m "fix: support normalized external storage resets" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 建立 MRU primitive 与 CWD/models adapters

**Files:**
- Create: `src/utils/mru.ts`
- Create: `src/utils/mru.test.ts`
- Create: `src/hooks/useRecentItems.ts`
- Create: `src/hooks/useRecentItems.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `normalize` 和 `externalFailure: 'reset'`。
- Produces:

```ts
export interface RecentItems {
  recents: string[]
  remember: (raw: string) => void
  rememberNow: (raw: string) => void
  forget: (value: string) => void
}

export function useRecentCwds(): RecentItems
export function useRecentModels(): RecentItems
```

内部工具签名固定为：

```ts
normalizeStringArray(value: unknown): string[]
nextMru(previous: unknown, raw: string, cap: number): string[] | null
readStringList(key: string): string[]
rememberStringListNow(key: string, raw: string, cap: number): string[] | null
```

- [ ] **Step 1: 写纯 MRU 与同步 storage 失败测试**

`src/utils/mru.test.ts` 覆盖：

- normalize：坏类型返回 `[]`，混合数组保留有效项顺序，不去重、不截断。
- nextMru：空白/null no-op、trim、置顶、精确大小写、cap；旧列表只在本次 remember 整理。
- Node/no-window：`readStringList` 返回 `[]`，`rememberStringListNow` 不向调用者抛出。

`src/hooks/useRecentItems.test.ts` 先测 adapter 公开行为：

```ts
it('rememberNow reads the latest disk and writes synchronously', () => {
  // render 后外部 disk 改为 ['external']，React state 保持旧值；
  // rememberNow('new') 返回前 disk 已是 ['new','external']。
})

it('two consecutive rememberNow calls preserve both writes', () => {
  // 同一 adapter 连续 rememberNow('first')、rememberNow('second')；
  // 第二次必须读到第一次的 disk，最终为 ['second','first']。
})

it('normalizes corrupt and mixed stored lists consistently', () => {
  // 初始坏 JSON/非数组=[]；混合数组过滤；后续 remember 使用同一语义。
})

it('synchronizes remember, rememberNow, forget, and external deletion between instances', () => {
  // 同 adapter 双实例所有操作一致；delete 后均=[]，无通知循环。
})

it('clamps cap to 3 and 50 and only truncates on remember', () => {
  // cap key 分别给 0 和 999；初始旧列表不截断，remember 后长度分别 ≤3/50。
})
```

- [ ] **Step 2: 运行测试并确认模块不存在**

Run:

```bash
npm test -- src/utils/mru.test.ts src/hooks/useRecentItems.test.ts
```

Expected: FAIL，原因是 `mru` / `useRecentItems` 尚不存在。

- [ ] **Step 3: 实现纯工具与两个 adapter**

`src/utils/mru.ts` 只拥有字符串列表、MRU 和同步 storage primitive。`readStringList` 显式处理 `typeof window === 'undefined'` 并返回 `[]`；`rememberStringListNow` 在无 window 时仍返回 next 但不写盘。空白返回 null；否则从最新 disk 计算 next，同步 setItem（读写异常静默）并返回 next。

`src/hooks/useRecentItems.ts` 内部 `useRecentItems(key, capKey)`：

- list：`useLocalStorage(key, [], { normalize: normalizeStringArray, externalFailure: 'reset' })`；
- cap：现有 cap key/default，round 后 clamp 3–50；
- remember：空白不 update，否则 functional update + nextMru；
- rememberNow：先同步 primitive，再以返回 next 调 setter；
- forget：精确匹配过滤；全部 callback 使用 `useCallback`，返回使用 `useMemo`。
- `useRecentCwds/useRecentModels` 只固定 `RECENT_*_KEY` 与 `RECENT_*_CAP_KEY`。

- [ ] **Step 4: 运行 primitive、adapter 与 storage 回归**

Run:

```bash
npm test -- src/utils/mru.test.ts src/hooks/useRecentItems.test.ts src/hooks/useLocalStorage.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/utils/mru.ts src/utils/mru.test.ts src/hooks/useRecentItems.ts src/hooks/useRecentItems.test.ts
git commit -m "refactor: add shared recent items MRU" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 迁移 New Session 的同步 model + CWD 写入

**Files:**
- Modify: `src/components/session-list/NewSessionDialog.tsx`
- Modify: `src/components/session-list/NewSessionDialog.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `useRecentCwds/useRecentModels` 及 `rememberNow/forget`。
- Produces: 原表单、recents 展示和 submit 行为；无公开组件接口变化。

- [ ] **Step 1: 写 Create 同 tick 卸载的同步双写回归测试**

复用现有合法表单 helper，加入 model 与 cwd 后点击 Create，并在同一 `act` 中让 dialog 卸载。立即断言：

```ts
expect(JSON.parse(localStorage.getItem('claude-react-web:recent-models')!)).toEqual([
  'new-model',
  'existing-model',
])
expect(JSON.parse(localStorage.getItem('claude-react-web:recent-cwds')!)).toEqual([
  '/new/project',
  '/existing/project',
])
```

预置相应 existing 项，证明两次写入都基于最新 disk 且第二次不丢第一项。保留现有 recents 展示和 forget 测试。

- [ ] **Step 2: 运行测试并确认旧抽象下的测试基线**

Run:

```bash
npm test -- src/components/session-list/NewSessionDialog.test.tsx
```

Expected: 现有实现若已满足同步双写，则新测试是 characterization PASS；不得为了让测试变红而破坏旧代码。其作用是迁移后的防回归门禁。

- [ ] **Step 3: 用 adapters 替换本地 rememberIn/cap/storage 代码**

在 `NewSessionDialog.tsx`：

- models 解构 `recents: recentModels, rememberNow: rememberModel, forget: forgetModel`；
- CWD 解构 `recents: recentCwds, rememberNow: rememberCwd, forget: forgetCwd`；
- submit 顺序保持先 model 后 CWD；picker/forget 调用不变；
- 删除本地 `rememberIn`、两个 cap raw/compute、重复 strict reader 和不再使用的 imports。

- [ ] **Step 4: 运行 New Session 与 MRU 回归**

Run:

```bash
npm test -- src/components/session-list/NewSessionDialog.test.tsx src/hooks/useRecentItems.test.ts src/hooks/useLocalStorage.test.ts
```

Expected: 全部 PASS，Create 卸载后的两个 key 均同步正确。

- [ ] **Step 5: Commit**

```bash
git add src/components/session-list/NewSessionDialog.tsx src/components/session-list/NewSessionDialog.test.tsx
git commit -m "refactor: use shared MRU in new session" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 迁移 CWD 的 ChatPanel 与 Skills 调用方

**Files:**
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/components/GlobalSettingsModal.tsx`
- Test: `src/components/SessionErrorCard.test.tsx`
- Test: `src/components/GlobalSettingsModal.skills-add.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `useRecentCwds().recents/remember/forget`。
- Produces: 原 relocation、Skills 安装和目录浏览写入时机；无 props 变化。

- [ ] **Step 1: 运行现有 CWD 行为测试作为基线**

Run:

```bash
npm test -- src/components/GlobalSettingsModal.skills-add.test.tsx src/components/SessionErrorCard.test.tsx
```

Expected: 现有 relocation 与 Skills 相关测试 PASS。

- [ ] **Step 2: 替换两个调用方的本地 MRU**

- ChatPanel：解构 `recents: recentCwds, remember: rememberCwd, forget: forgetCwd`；仍只在 relocation PATCH 成功后 remember。
- GlobalSettingsModal：同样替换；安装成功、目录选择和 forget 时机不变。
- 删除不再使用的 `useLocalStorage` list/cap imports 与 clamp；不要改 ProjectPicker/AddSkillCard props。

- [ ] **Step 3: 运行 CWD 调用方与 adapter 回归**

Run:

```bash
npm test -- src/components/GlobalSettingsModal.skills-add.test.tsx src/components/SessionErrorCard.test.tsx src/hooks/useRecentItems.test.ts
```

Expected: 全部 PASS；成功才写、失败不写、forget 和目录选择行为不变。

- [ ] **Step 4: Commit**

```bash
git add src/components/ChatPanel.tsx src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.skills-add.test.tsx
git commit -m "refactor: share recent cwd state" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 让 models picker 与 appearance reset 响应删除

**Files:**
- Modify: `src/hooks/useModelOptions.ts`
- Modify: `src/hooks/useModelOptions.test.ts`
- Modify: `src/hooks/useResetConfig.ts`
- Modify: `src/hooks/useResetConfig.test.ts`
- Delete: `src/utils/recent-models.ts`

**Interfaces:**
- Consumes: Task 1 的 `removeLocalStorageKey` 和 Task 2 的 `useRecentModels`。
- Produces: 原 `ModelOptions` 返回形状和 appearance reset key 清单；无新增字段。

- [ ] **Step 1: 写 mounted models 与当前标签 reset 失败测试**

`useModelOptions.test.ts`：

```ts
it('updates mounted recents on external writes and deletion', async () => {
  // 保持 enabled/server fetch mock 不变。
  // 外部写 ['model-x'] 时 recents 更新；delete 时同一 mounted hook recents=[]。
})
```

`useResetConfig.test.ts` 通过真实 `useResetConfig().reset({ browser:['appearance'], server:[] })`：

- 预置 CWD/models list + cap keys，并挂载对应 recent adapter；
- reset 后 list keys 为 null、cap keys 保留、挂载 recents 立即 `[]`；
- 随后 `remember('fresh')` 只写 `['fresh']`，不得带 reset 前旧值。

- [ ] **Step 2: 运行测试并确认旧行为失败**

Run:

```bash
npm test -- src/hooks/useModelOptions.test.ts src/hooks/useResetConfig.test.ts
```

Expected: mounted deletion/reset 用例 FAIL；现有 fetch/key-list 行为继续 PASS。

- [ ] **Step 3: 迁移 read path 与 reset 调用**

- `useModelOptions` 用 `const { recents } = useRecentModels()` 替换 `readRecentModels()`，保留全部 server model store 逻辑。
- `useResetConfig` 仅对 `RECENT_MODELS_KEY` 和 `RECENT_CWDS_KEY` 调 `removeLocalStorageKey`，其他 `APPEARANCE_KEYS` 仍 removeItem。
- 删除已无消费者的 `src/utils/recent-models.ts`，不得保留第二份 lenient reader。

- [ ] **Step 4: 运行 deletion、models 与全部 MRU 回归**

Run:

```bash
npm test -- src/hooks/useModelOptions.test.ts src/hooks/useResetConfig.test.ts src/hooks/useRecentItems.test.ts src/hooks/useLocalStorage.test.ts src/components/session-list/NewSessionDialog.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useModelOptions.ts src/hooks/useModelOptions.test.ts src/hooks/useResetConfig.ts src/hooks/useResetConfig.test.ts src/utils/recent-models.ts
git commit -m "fix: synchronize recent item resets" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 全量验证与完整 diff review

**Files:**
- Review only: Task 1–5 的全部文件
- Modify only for confirmed findings: 对应实现或测试文件

**Interfaces:**
- Consumes: 完整 storage/MRU/调用方实现与测试矩阵。
- Produces: 可交付 diff，不改变已确认接口。

- [ ] **Step 1: 运行全部针对性测试**

Run:

```bash
npm test -- src/hooks/useLocalStorage.test.ts src/utils/mru.test.ts src/hooks/useRecentItems.test.ts src/hooks/useModelOptions.test.ts src/hooks/useResetConfig.test.ts src/components/session-list/NewSessionDialog.test.tsx src/components/GlobalSettingsModal.skills-add.test.tsx src/components/SessionErrorCard.test.tsx
```

Expected: 全部 PASS，无 maximum-depth、act warning、unhandled rejection 或测试后异步写入。

- [ ] **Step 2: 运行项目静态检查与完整测试**

Run:

```bash
npm run typecheck
npm run lint
npm test
```

Expected: 全部 exit 0。若出现预存失败，保留完整失败文件/断言并与本次 diff 对照，不得猜归因。

- [ ] **Step 3: 对完整变更执行 code review**

从实施前 base SHA 到当前 HEAD 运行 `code-review` skill，重点检查：

- 多实例 delete/坏 JSON 后无 key 复活；
- 抑制不会被 effect 清除，真实 update 必定解除；
- 同标签 echo 不 normalize、不循环；
- Create 同 tick 双写与最新 disk 合并；
- models picker 响应式、当前标签 reset、cap keys/colors 不变；
- 默认 `useLocalStorage` 消费者行为不变；
- 没有第二份 MRU/reader 残留或无关文件混入。

确认 finding 先补失败测试再修复；非平凡修复后重跑本任务 Step 1–3。

- [ ] **Step 4: 汇总交付**

报告实际改动、坏数据/删除/同步写盘的测试证据、静态检查与全量测试结果，以及 review findings。不得把未运行的验证写成通过。
