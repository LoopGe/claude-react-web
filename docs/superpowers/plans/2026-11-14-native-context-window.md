# Native 模型上下文窗口实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 native ContextUsage 和 auto-compact 按精确 profile/model 路由使用可靠上下文容量，无法确认时回退到 200K。

**Architecture:** profile 配置提供精确覆盖；`NativeProvider` 共享的 resolver 负责协议发现、缓存和 last-good；`NativeSession` 只消费容量并计算 threshold；`SessionManager` 在 idle dispatch 前用原始压力执行 compact。当前仅实现 Anthropic Messages-compatible discovery，容量类型和覆盖规则保持 provider-neutral。

**Tech Stack:** TypeScript ESM、Node 20、Vitest、现有 `fetch`/`Response`；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-14-native-context-window-design.md`

## Global Constraints

- 在 main 上执行，不创建 worktree；保留其他会话的未提交改动，禁止 amend/rebase/`git add -A`，只 stage 每个任务明确列出的文件。
- 不实现 DeepSeek、OpenAI、Codex 或其他请求 wire protocol；不猜其他协议的容量字段，不实现 Structured Output、provider readFile、插件或 sandbox。
- 固定值：未知容量 `200_000`，native 输出预留 `DEFAULT_MAX_TOKENS = 16_384`，发现超时 5 秒、响应上限 64 KiB、成功 TTL 5 分钟、所有失败冷却 30 秒。
- `autoCompactThreshold: 0` 表示“已确认无可行 proactive threshold”，只有 `undefined` 才允许 manager 使用旧 ratio 兼容路径。
- 不新增依赖，不读取真实开发机凭证，不在测试中访问真实模型端点；所有 discovery/fetch 均注入或使用 fake。
- 不将容量写入 native v1/v2 日志，不记录 authToken、请求头或发现响应正文。
- 每个任务提交前自审完整 diff 并由 controller 安排 task review；commit message 末尾添加 `Co-Authored-By: Kimi <noreply@moonshot.cn>`。
- 最终全量验证和 whole-branch review 后才声明完成；pull/push 需要用户另行明确授权。

## Review Focus

1. 大模型切到小模型后 `totalTokens > maxTokens`：UI 可拒绝该读数，但 dispatch 前 compact 必须收到原始压力。由 Task 4 的 down-switch 单测和 E2E 固定。
2. `autoCompactThreshold: 0` 与缺失字段混淆：0 必须跳过 compact，不能回退 ratio，也不能被 last-good carry 覆盖。由 Task 4 的 parser/manager/UI 测试固定。
3. 脚本化 `_testStream` 或故障端点：测试不得发出真实请求，发送最多等待一次 5 秒发现且发现失败不丢用户消息。由 Task 3/4 固定。
4. web-import 改变 modelList/baseUrl：source 没有容量映射时必须清除 target 旧映射，不能套用到新路由。由 Task 1 固定。
5. 模型或 profile 在 await 期间改变：旧发现不能提交成新 effective model 的事实，profile 新对象不能复用旧缓存。由 Task 2/3 固定。

---

### Task 1: profile 容量覆盖、配置迁移与 web-import

**Files:**

- Modify: `server/config.ts`
- Modify: `server/profiles.ts`
- Modify: `server/routes/config-routes.ts`
- Modify: `src/types/config.ts`
- Modify: `server/web-import.ts`
- Modify: `server/routes/web-import.ts`
- Test: `server/profiles.test.ts`
- Test: `server/config.test.ts`
- Test: `server/routes/config-routes.test.ts`
- Test: `server/routes/profiles.test.ts`
- Test: `server/web-import.test.ts`
- Test: `server/routes/web-import.test.ts`

**Interfaces:**

- Produces: `ProviderProfile.modelContextWindows?: Readonly<Record<string, number>>`，key 是完整请求 model id，value 是正安全整数。
- Produces: `LegacyProfileFields.modelContextWindows?: Record<string, number>` 和 `coerceModelContextWindows(raw: unknown): Record<string, number> | undefined`。
- Produces: `SourceCredentials.modelContextWindows: Record<string, number> | undefined` 与 `PresentFields.modelContextWindows: boolean`。
- 不从其他 profile 继承覆盖；旧式顶层字段只迁入 `profiles[0]`，并加入 `LEGACY_PROFILE_KEYS` 的删除集合。

- [ ] **Step 1: 写配置和导入失败测试**

覆盖以下精确断言：

- 有效 `{ 'vendor/a': 1_000_000, 'vendor/b': 128_000 }` 保留；字符串、0、负数、小数、`NaN`、非安全整数和空 model key 被忽略；一个 profile 的覆盖不出现在另一个 profile。
- legacy 顶层 `modelContextWindows` 迁移到 `profiles[0]`，顶层键被删除；GET full config 返回映射，profile 更新未编辑该字段时仍保留。
- source 映射存在时 `present.modelContextWindows === true` 且导入整体替换 target；source 无映射但导入 modelList 或 baseUrl 时删除 target 旧映射；source 未导入任何路由字段时 target 映射不变；全非法 source 映射不算 usable 字段。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/profiles.test.ts server/config.test.ts server/routes/config-routes.test.ts server/routes/profiles.test.ts server/web-import.test.ts server/routes/web-import.test.ts`

Expected: 新断言因字段不存在、未迁移或导入规则未实现而 RED；不得放宽既有 profile/web-import 断言。

- [ ] **Step 3: 实现统一 coercion 和配置保留**

在 `profiles.ts` 实现唯一的 `coerceModelContextWindows`：仅接受非数组对象，逐项检查非空 key 和正安全整数，返回新对象；没有任何有效项时返回 `undefined`。在 profile coercion、legacy migration、GET 响应和 client wire type 中接入，冻结 profile 持有的映射，并在 SourceCredentials/公开响应处返回副本，避免调用方共享修改。

- [ ] **Step 4: 实现 web-import 替换/清除规则**

读取 source 时使用同一 coercion 和 raw index 规则设置 `present`。写入时：source 有映射则整体替换；source 无映射但 `present.modelList || present.baseUrl` 为真则删除 target 字段；其他情况不触碰。`hasUsableProfileFields` 纳入该字段，不合并两个映射。

- [ ] **Step 5: 验证、审查并提交**

Run: 重跑 Step 2 测试及 `npm run typecheck`。

Expected: 全部通过。审查本任务完整 diff 后只 stage 上述文件并提交：`feat(native): add model context overrides`。

### Task 2: 精确路由 resolver、Anthropic discovery 与缓存

**Files:**

- Create: `server/providers/native/model-context.ts`
- Create: `server/providers/native/model-discovery.ts`
- Test: `server/providers/native/model-context.test.ts`
- Test: `server/providers/native/model-discovery.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `ProviderProfile.modelContextWindows`。
- Produces:

```ts
interface NativeModelRoute {
  profile: ProviderProfile
  providerId: string
  baseUrl: string
  model: string
  api: 'anthropic-messages'
  credentials: () => { baseUrl: string; authToken: string }
}

interface NativeModelContext {
  contextWindow: number
  source: 'override' | 'endpoint' | 'fallback'
}

interface NativeModelDiscovery {
  retrieve(route: NativeModelRoute): Promise<number | undefined>
}

class NativeModelContextResolver {
  constructor(opts?: { discovery?: NativeModelDiscovery; now?: () => number })
  resolve(route: NativeModelRoute): Promise<NativeModelContext>
}

class AnthropicModelDiscovery implements NativeModelDiscovery {
  constructor(opts?: { fetchFn?: typeof fetch })
}
```

- Export `DEFAULT_CONTEXT_WINDOW = 200_000`。`credentials` 延迟到 discovery 才调用，覆盖和纯 fallback 不要求 token。

- [ ] **Step 1: 写 resolver 失败测试**

用可变 `now` 和 deferred fake discovery 固定：

- 覆盖 1M/128K 时不调用 discovery 或 credentials；无策略返回 200K 时也不调用 credentials。
- 可靠 endpoint 值按原值返回；同 key 并发只有一次调用；同 model 不同 profile/baseUrl 不共享。
- 5 分钟内使用成功缓存；过期 last-good 立即返回且后台只刷新一次；失败刷新保留 last-good，并冷却 30 秒。
- 无 last-good 的失败返回 200K 并冷却 30 秒，冷却后才重试；新 profile 对象不复用旧代际。
- 非正整数、非安全整数和 discovery throw 都按未确认处理；旧 profile 的迟到完成只写旧 WeakMap 分支，不能污染同 id 的新 profile 对象。

- [ ] **Step 2: 写 discovery 失败测试**

用注入 `fetchFn` 和内存 `Response`/stream 固定：

- URL 为 `<baseUrl>/v1/models/<encodeURIComponent(model)>`，使用 lazy profile token 与 `anthropic-version: 2023-06-01`，`redirect: 'error'`。
- 采用有效 `max_input_tokens`；响应 `id` 存在但不匹配、只有 `max_tokens`、字段缺失/零/负数/小数/字符串均返回 undefined。
- 非 2xx、无效 JSON、超过 64 KiB、重定向和 5 秒 abort 都拒绝；日志/错误不包含 token 或响应正文。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run server/providers/native/model-context.test.ts server/providers/native/model-discovery.test.ts`

Expected: 模块不存在而 RED。

- [ ] **Step 4: 实现 resolver 和单 flight 缓存**

在 `model-context.ts` 实现 override → discovery → fallback。用 `WeakMap<ProviderProfile, Map<string, CacheEntry>>` 隔离 profile 代际，key 包含 baseUrl/model；entry 保存 lastGood、expiresAt、nextRetryAt 和当前 in-flight。过期 last-good 后台刷新，无缓存时等待当前查询；所有失败统一设置 30 秒冷却，完成时只提交当前 Promise。

- [ ] **Step 5: 实现有界 Anthropic retrieve**

在 `model-discovery.ts` 实现 5 秒 timeout、64 KiB 实际读取上限、严格 JSON 字段窄化和去敏错误。只查询当前 route，不遍历列表，不读取其他厂商扩展字段，不跟随重定向。

- [ ] **Step 6: 验证、审查并提交**

Run: 重跑 Step 3 测试及 `npx tsc -p tsconfig.node.json --noEmit`。

Expected: 全部通过。审查后只 stage 这四个文件并提交：`feat(native): resolve route context windows`。

### Task 3: NativeSession 动态 usage、模型代际与 provider 接线

**Files:**

- Modify: `server/providers/native/native-provider.ts`
- Modify: `server/providers/native/native-session.ts`
- Test: `server/providers/native/native-session.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `NativeModelContextResolver`、`NativeModelRoute`、`DEFAULT_CONTEXT_WINDOW`。
- Produces: `NativeProvider` constructor opts 和 `NativeSessionOptions` 均增加可选 `modelContext?: NativeModelContextResolver`。
- Produces: `getContextUsage()` 返回现有 `totalTokens/maxTokens/model`，并增加 `autoCompactThreshold: number`；threshold 为 `min(floor(window × config.nativeAutoCompactRatio), window - DEFAULT_MAX_TOKENS)`，无可行值时为 0。

- [ ] **Step 1: 写动态窗口和代际失败测试**

在现有 fixture 中注入 fake discovery/resolver：

- model-a=1M 时 `maxTokens=1_000_000`、`autoCompactThreshold=800_000`；200K 仍为 160K；128K 为 102_400；16K 时 threshold=0。
- deferred A 查询期间 `setModel(B)`，B 先完成而 A 后完成，最终只能返回 B 的 model/window；A→B→A 不重用错误 model/threshold。
- resume/fork 调用 `getContextUsage()` 前后 native event 数组不变，恢复路由重新解析；turn 已捕获 model 不因 setModel 改变。
- `_testStream` 已启用时 discovery spy 调用数为 0，包括 createSession 后才安装脚本流的场景。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/native-session.test.ts`

Expected: 新动态 threshold、代际和 discovery guard 断言 RED；既有 200K 测试可更新为同时断言 160K，但不得删除原有 token 汇总断言。

- [ ] **Step 3: 接线 provider 并保持测试网络关闭**

`NativeProvider` 默认持有一个 resolver 和一个 `AnthropicModelDiscovery`，允许 constructor 注入。传给 discovery 的包装在每次 retrieve 时检查 `this._testStream`：脚本流存在则返回 undefined，否则委托真实 discovery；不得仅在 constructor/createSession 时检查。将该 resolver 传给每个 NativeSession。

- [ ] **Step 4: 实现 session 路由和 threshold**

缺少 opts.profile 时使用当前 active profile 或 `DEFAULT_PROFILE`，并在 session 内保持稳定对象。`modelGeneration` 仅在 effective model 实际变化时递增；`getContextUsage()` 捕获 generation/model，await 后若代际改变则用最新 model 重试。保留 `DEFAULT_MAX_TOKENS` 的请求用途和现有 usage 汇总，移除固定 `CONTEXT_WINDOW`。

- [ ] **Step 5: 验证、审查并提交**

Run: `npx vitest run server/providers/native/native-session.test.ts server/providers/native/model-context.test.ts server/providers/native/model-discovery.test.ts` 和 `npx tsc -p tsconfig.node.json --noEmit`。

Expected: 全部通过且无真实网络。审查后只 stage 这三个文件并提交：`feat(native): use model context in sessions`。

### Task 4: dispatch 前 compact、threshold 三态、E2E 与文档

**Files:**

- Modify: `server/session-manager.ts`
- Modify: `server/session-pump.ts`
- Modify: `CONFIG.md`
- Modify: `CLAUDE.md`
- Move: `.agents/notes/proposed/architecture/2026-11-14-native-model-context-resolution.md` → `.agents/notes/implemented/architecture/2026-11-14-native-model-context-resolution.md`
- Test: `server/session-manager.test.ts`
- Test: `server/session-pump.test.ts`
- Create: `server/providers/native/e2e-context-window.test.ts`
- Create: `src/utils/context-usage.test.ts`

**Interfaces:**

- Consumes: Task 3 的 raw `{ totalTokens, maxTokens, model, autoCompactThreshold }`。
- Produces: `maybeAutoCompact(s, pressure?)` 的可选 pressure 允许 `totalTokens > maxTokens`；未传时仍读 cached lite usage。
- Produces: idle native `send()`/`sendContent()` 在 dispatch 前获取 raw usage 并调用同一 compact；显式 `autoCompactWindow` → threshold（包括 0）→ undefined 时的 ratio fallback。

- [ ] **Step 1: 写 parser、threshold 和 UI 失败测试**

- raw/lite/parser/facts fold 均保留 `autoCompactThreshold: 0`，同 model 的旧正数不得覆盖它；`contextUsageStats` 对 0 不生成 threshold marker。
- `maybeAutoCompact` 在 threshold=0 时直接返回；正 threshold 优先于 ratio；显式 `autoCompactWindow` 优先于 provider threshold；undefined 才走 ratio。

- [ ] **Step 2: 写 dispatch 与 down-switch 失败测试**

- native idle send 获取 raw `{ totalTokens: 300_000, maxTokens: 200_000, model: 'small', autoCompactThreshold: 160_000 }`，即使 cached UI usage 仍是旧大模型，也先 compact 再 enqueue。
- raw 超窗不被 pressure 窄化拒绝；working/queued 不启动 precheck；摘要失败记录并继续 send，用户消息仍 enqueue。
- E2E 用真实 NativeProvider + fake discovery：首轮 usage 300K/窗口 1M 不 compact，setModel 到 200K 后第二次 send 在新 stream 前 compact，replacement history 和日志包含既有 compact boundary/summary，且没有容量事件。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run server/session-pump.test.ts server/session-manager.test.ts src/utils/context-usage.test.ts server/providers/native/e2e-context-window.test.ts`

Expected: 0 被丢弃、raw 超窗未用于 compact、dispatch 前未检查等新断言 RED。

- [ ] **Step 4: 实现统一 pressure 与 dispatch precheck**

`maybeAutoCompact` 使用传入 pressure 或 cached usage，threshold<=0 直接返回。新增 native-only idle precheck：`phaseOf(s) === 'idle'` 时通过 `await this.contextUsage(s.id)` 获取 raw，再窄化为 pressure；raw 只要求有限非负 total、正 max、非空 model 和可选非负 threshold，不要求 total<=max。usage 控制调用本身的错误照常抛出；只有 compact/摘要阶段包在 fail-open catch 中，记录后继续发送。

在 `send()`/`sendContent()` 的 opLock 内、附件 lease/解析前执行 precheck，await 后再次 `assertSendCurrent`；working/queued 直接跳过。保持现有 post-turn 调用、显式窗口、compact 清理和附件 lease 语义。

- [ ] **Step 5: 保留 threshold=0 并更新文档**

调整 raw/lite/SDK-facts 的 threshold 校验与 carry，使 0 不被当作缺失。`CONFIG.md` 记录 `modelContextWindows` 精确匹配、优先级和 web-import 规则；`CLAUDE.md` 增加简短所有权说明。将 Agent Note 移到 implemented，改成 Problem/Decision/Alternatives/Consequences 的已交付事实，不写未来计划。

- [ ] **Step 6: 全量验证、审查并提交**

Run: 重跑 Step 3，再运行 `npx vitest run server/providers/native/native-session.test.ts server/providers/native/e2e-persistence.test.ts`、`npm run typecheck`、`npm run lint`、`npm test`、`npm run verify:agent-notes` 和 `git diff --check`。

Expected: 全部通过；如遇已知环境/时序失败，保留日志并隔离复跑归因，不添加 workaround。审查完整 diff 后只 stage 上述文件并提交：`fix(native): compact against current model window`。

- [ ] **Step 7: whole-branch review**

派 fresh reviewer 检查四个任务的完整提交范围，重点核对 Review Focus、真实网络隔离、profile/模型代际、web-import 清除规则、0 threshold 和 down-switch compact。修复 confirmed findings 并 scoped re-review；不得在未通过 review 时声明完成或 push。
