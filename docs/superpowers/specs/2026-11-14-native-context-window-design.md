# Native 模型上下文窗口设计

## 目标

移除 `NativeSession.getContextUsage()` 固定返回 `200_000` 的行为，使 ContextBar 和 native auto-compact 使用当前精确模型路由的上下文容量。

已确认的取舍：**显式配置优先；端点返回可靠容量时采用该值，包括大于或小于 200K 的值；只有无法可靠确认时才回退到 200K。**

本设计借鉴 DSH 的精确路由模型，但不把容量解析写成 Anthropic 专用逻辑。当前 native 仍只实现 Anthropic Messages-compatible 请求传输；本阶段只让容量元数据保持 provider-neutral，不宣称已经支持 DeepSeek、OpenAI 或其他请求协议。

## 现状与参照

### 当前实现

- `native-session.ts` 用 `CONTEXT_WINDOW = 200_000` 填充每次 `getContextUsage()`。
- `SessionManager.maybeAutoCompact()` 在没有显式 `autoCompactWindow` 时使用 `maxTokens × nativeAutoCompactRatio`。
- 模型、profile、baseUrl 和凭证按会话解析，但容量没有使用这些路由事实。
- native 的单次响应输出上限仍是独立的 `DEFAULT_MAX_TOKENS = 16_384`，本阶段不把它改成动态输出能力发现。

结果是：大窗口模型过早 compact，小窗口模型可能过晚 compact，模型切换后分母仍不变。

### DSH 的做法

DSH 的 `LlmAdapter.resolveModel(provider, model)` 由路由所属 adapter 返回容量；`LlmRuntime` 校验正整数并返回脱离 adapter 内部对象的副本。容量解析独立于模型选择器列表，动态但未列出的模型也可有容量。

- DeepSeek adapter 支持精确模型 `contextWindow` 和 adapter 级默认值。
- pi-ai adapter 从实际请求所用的同一模型 descriptor 取容量。
- discovery 列表只是候选元数据，不是请求路由白名单。
- compaction 按精确 `{provider, model}` 解析策略，并考虑输出预留；模型切换会重新计算压力。

本项目应复制“路由拥有容量、消费者不维护第二份模型表”的所有权，不复制 Cordis、pi-ai 依赖或 DSH 的全部 compaction 策略。

### 方案比较

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 静态模型表 | 无网络请求，结果立即可用 | 模型和网关持续变化，同名模型在不同路由可能不同；容易再次过期 | 不采用 |
| 只读 Models API | 能反映端点实际能力 | 部分网关没有该端点或字段；不能覆盖所有厂商 | 作为可确认来源之一 |
| 只用配置覆盖 | 适用于任何网关和动态模型 | 每个模型都要手配，无法自动利用大窗口 | 作为最高优先级覆盖 |
| 精确路由 + 覆盖 + 协议发现 + 200K 回退 | 与 DSH 所有权一致，支持多路由和未知模型 | 需要缓存、失败和切换语义 | 采用 |

## 范围

### 本阶段包含

1. provider-neutral 的精确路由容量解析。
2. profile 级、模型级显式容量覆盖。
3. 当前 Anthropic Messages-compatible transport 的精确模型元数据查询。
4. 查询缓存、超时、失败回退和陈旧响应防护。
5. `getContextUsage()`、auto-compact 阈值、模型/profile 切换、resume/fork 的一致行为。
6. 配置、测试和必要的架构说明。

### 明确不包含

- DeepSeek、OpenAI、Codex 或其他请求 wire protocol 的实现。
- 用 OpenAI `/models` 形状猜测 Anthropic-compatible 端点，或反之。
- 把 `max_tokens`、输出上限、价格或模型名称关键字当作上下文窗口。
- 动态调整 `DEFAULT_MAX_TOKENS`，或实现 DSH 的完整 retention/headroom/overflow recovery。
- Structured Output、provider `readFile`、插件、forked Skill、background/memory/observer 和 sandbox。
- 为模型选择器增加网络列表，或要求模型必须出现在列表中才允许发送。

后续新增传输 adapter 时，应复用本设计的容量结果和覆盖规则，并为该协议增加自己的可靠发现策略；没有策略时使用覆盖或 200K，不解析未知响应。

## 精确路由与所有权

在 `NativeProvider` 层增加一个进程内 `NativeModelContextResolver`。`NativeSession` 不直接 fetch，也不各自实现模型表。

逻辑输入为：

```ts
interface NativeModelRoute {
  profile: ProviderProfile
  providerId: string
  baseUrl: string
  model: string
  api: 'anthropic-messages'
}
```

- `profile` 是当前会话实际使用的 profile 对象，不只是 active profile 的名称。
- `providerId` 是 profile 的稳定 id，用于诊断和精确路由语义。
- `baseUrl` 参与路由区分：相同 profile id 在重新配置到另一个端点后不能复用旧容量。
- `model` 是实际发送的完整模型 id，包括厂商前缀或网关别名；不做名称归一化。
- `api` 描述当前真实传输。当前唯一值是 `anthropic-messages`，不是厂商能力声明。

解析结果为：

```ts
interface NativeModelContext {
  contextWindow: number
  source: 'override' | 'endpoint' | 'fallback'
}
```

`source` 用于测试和去敏诊断；现有公开 `getContextUsage()` 形状不必暴露它。返回值必须是不可变副本，调用方不能修改缓存。

容量 resolver 归 provider 所有；`SessionManager` 继续拥有是否 compact、显式 `autoCompactWindow` 和摘要流程。未来其他 adapter 提供同一 `NativeModelContext`，compaction 不需要知道字段来自哪个厂商。

## 来源与优先级

### 1. 精确配置覆盖

每个 profile 增加可选 `modelContextWindows: Record<string, number>`：

```json
{
  "profiles": [{
    "id": "gateway-a",
    "name": "Gateway A",
    "baseUrl": "https://gateway.example",
    "authToken": "...",
    "modelList": ["vendor/model-x"],
    "modelContextWindows": {
      "vendor/model-x": 512000
    }
  }]
}
```

- key 必须与实际请求的完整 `model` 完全相等。
- value 必须是正的安全整数；不设置人为上限，因为本决策明确允许大于 200K 的可靠容量。
- 覆盖只作用于该 profile，不能泄漏到另一个 profile 的同名模型。
- 旧式顶层 `modelContextWindows` 只作为单 profile 迁移输入，首次迁移后归入 `profiles[0]`；运行时不再维护第二份全局映射。
- 配置读取和 profile 编辑必须保留该字段。现有 profile 更新采用保留未编辑字段的方式，不得在新一轮写入中丢弃它。
- web-import 将容量映射视为随 source modelList/baseUrl 一起迁移的路由配置：source 带有该字段时整体替换 target，不按模型合并；source 没有该字段但导入了 modelList 或 baseUrl 时清除 target 旧映射，避免旧路由容量套到新模型；source 未提供任何路由字段时保留 target。
- 非法条目按现有配置 coercion 规则去敏记录并忽略；不得把非法值当成确认结果，也不得让整个 profile 的其他模型失效。

不提供“本 profile 所有模型共用同一个自定义窗口”的默认值。未知模型共用值容易把错误容量扩散到动态 id；本阶段的统一默认只有最后的 200K 回退。

### 2. 当前协议的可靠发现

没有精确覆盖时，`anthropic-messages` 策略查询当前路由的精确模型对象：

- 请求：`GET <baseUrl>/v1/models/<encodeURIComponent(model)>`。
- 认证和 `anthropic-version` 复用该 native session 的实际请求语义及 profile 凭证，不能改用 active profile 或环境变量。
- 只接受响应对象中为正安全整数的 `max_input_tokens`。
- 响应的 `id` 若存在，必须与请求的完整模型 id 相等；不一致不能套用到当前路由。
- `max_tokens` 是输出上限，不能作为窗口；缺少 `max_input_tokens`、类型错误、非整数、非正数都视为未确认。
- 本策略不读取其他厂商的 `context_length`、`context_window` 等扩展字段。网关若只提供这些字段，应使用显式覆盖，或由未来明确支持该网关协议的 adapter 解析。

模型查询使用 retrieve，而不是遍历 `/v1/models` 列表。列表成员资格不决定路由是否可用，动态模型也不因未列出而被拒绝。端点返回 404、405、501 或无效 JSON 只表示无法确认容量，不表示模型不能生成。

### 3. 200K 回退

以下情况使用 `200_000`：

- 没有覆盖，且端点不支持查询；
- 未配置凭证、认证失败、网络失败或超时；
- 响应无效或没有可靠的 `max_input_tokens`；
- 当前协议没有发现策略。

回退不是模型事实，也不能写成持久化配置。恢复网络或重启后可以重新确认。已有成功发现值的路由在后续刷新失败时保留 last-good，而不是从已确认的大窗口突然降回 200K。

## 请求安全与失败行为

元数据查询不得让会话创建、模型切换或消息发送失败，也不得造成无界等待。idle dispatch 的压力检查在没有可用缓存时最多等待一次 5 秒查询；这是有界的容量确认，不是静默后台降级。

- 查询设置 5 秒超时，响应体上限 64 KiB；超限按未确认处理。
- 使用 `redirect: 'error'`，避免把 profile 凭证带往重定向目标。URL 只能由已配置 `baseUrl` 和编码后的模型 id 组成，模型 id 不能改变 origin。
- 日志只包含 providerId、baseUrl、model、source、状态码和去敏错误类别；不得记录 authToken、请求头或响应正文。
- 查询失败不向用户伪造“模型就是 200K”的能力声明；公开形状仍沿用现有数字字段，内部日志标记 `source=fallback`。
- 元数据查询失败不触发现有消息请求重试，也不新增一条对用户可见的 assistant 错误。

这里的 baseUrl 是用户已经授权用于模型请求的端点，不是模型提供的 URL；本功能不开放新的任意 URL 抓取入口。

## 缓存与并发

resolver 由 `NativeProvider` 持有，所有同 profile 的 native 会话共享：

- 以 profile 对象身份建立 `WeakMap`，其内以 `baseUrl + model` 为 key。profile 重新加载产生新对象后自然隔离旧凭证代际；authToken 不出现在 key 或日志中。
- 同 key 的并发查询共用一个 in-flight Promise，避免多个会话和 ContextBar probe 同时打端点。
- 成功发现缓存 5 分钟。新鲜值直接返回；过期 last-good 也立即返回，同时在后台 revalidate，发送不为已有容量事实等待刷新。
- 每次失败都设置 30 秒 `nextRetryAt`。有 last-good 时在冷却期继续返回 last-good；没有 last-good 时返回同样冷却 30 秒的 200K 回退。任何情况下 ContextBar 轮询都不能形成故障端点请求风暴。
- 没有 last-good 且不在失败冷却期时，调用方可等待当前查询，最长 5 秒后采用回退。精确覆盖无需网络，也不进入端点缓存。
- 单 flight 提交只允许该 key 当前 Promise 写入，关闭或新 profile 代际不能提交到旧 key。

`getContextUsage()` 捕获调用时的 effective model。await 期间若模型又发生变化，该结果不能标记成新模型的事实；它应丢弃捕获代际并针对最新 model 重新解析。复用缓存使常见的 A→B→A 切换不产生额外请求。

## ContextUsage 与 auto-compact

`NativeSession.getContextUsage()` 改为：

1. 捕获当前 effective model 和对应路由。
2. 通过 resolver 得到 `contextWindow`。
3. 保持现有 prompt token 计算：`input + cache_read + cache_creation`，不把 output 加入历史压力。
4. 返回捕获模型、解析后的 `maxTokens` 和 native 默认 auto-compact threshold。

native 默认 threshold 为：

```text
min(
  floor(contextWindow × nativeAutoCompactRatio),
  contextWindow - DEFAULT_MAX_TOKENS
)
```

- 200K 且 ratio=0.8 时仍为 160K，保持现有行为。
- 1M 时为 800K，不再提前到 160K。
- 小窗口不会留下连一次响应都放不下的比例阈值。
- `contextWindow <= DEFAULT_MAX_TOKENS` 时没有可行的 proactive threshold：native 显式返回 `autoCompactThreshold: 0`，auto-compact 不假装能解决请求配置本身无法容纳输出的问题；实际 API 错误照常暴露。`0` 是“已确认无可行阈值”，`undefined` 才是“旧快照没有该事实”；UI 继续只在 threshold > 0 时画标记。
- 会话显式 `autoCompactWindow` 始终优先于 provider 默认 threshold。

`SessionManager.maybeAutoCompact()` 的选择顺序改为：显式 `autoCompactWindow` → 当前 usage 自带的 `autoCompactThreshold` → 既有 ratio 计算。`0` 是有效值，不能用 truthiness 把它换成 ratio；使用 `??` 时必须保留 `0`，只有 `undefined` 才走最后一项兼容路径。这样 ContextBar 标记和真正触发点使用同一个值。server 的 raw/lite 解析和 SDK-facts fold 都要保留 `0`，不能在“正整数”校验或 last-good carry 中把它丢掉。

在 idle 的下一次用户消息 dispatch 前，native 先获取当前 context usage，并把**原始压力对象直接传给** `maybeAutoCompact(s, pressure)`；working/queued 状态沿用现有 idle guard。该 pressure 只要求非负 `totalTokens`、正 `maxTokens`、匹配 model 和可选 threshold，**不要求 `totalTokens <= maxTokens`**。从大模型切到小模型后，旧历史大于新窗口是有效的 compact 压力，不能因为 `liteContextUsageFromSdkUsage()` 为 UI 拒绝超窗读数而丢失。UI parser 保持现有防坏数据行为，pre-dispatch compaction 不依赖它的缓存。

这样从大窗口切到小窗口后，不必先向小模型发送一次必然超限的历史才更新阈值。预检查摘要失败保持现有自动 compact 的 fail-open 行为并记录日志，不吞掉用户输入；本阶段不新增 DSH 那种阻塞式模型切换 compact 或 overflow retry。

## 模型、profile、resume 和 fork

- **setModel / persona 切换：** effective model 改变后，下一次 usage 解析使用新路由；旧模型的 threshold 不得按模型名相同之外的任何条件继承。
- **setProfile：** 新 profile 的 id、baseUrl、model 和凭证共同决定路由。deferred profile 仍在 respawn 后生效，与现状一致。
- **进行中的 turn：** turn 已冻结的 model 不被 discovery 改写；usage 的控制面模型仍表示 next-turn effective model。迟到查询通过代际检查不能覆盖更新选择。
- **resume / fork：** 容量不是 durable session event，不写入 v1/v2 日志。恢复原 model 和 profile 后重新解析；重启时缓存自然清空。恢复期间无法查询则临时回退 200K，不改写日志或历史。
- **compact：** compact 不清空 resolver 的共享路由缓存；摘要和 replacement history 继续使用当前会话模型。
- **子代理：** 主 ContextBar 仍只表示 main thread。子代理可使用自己的 model 调用同一 resolver，但不能把子代理窗口或用量合并进主窗口。

容量是随配置和端点变化的派生事实，不是会话历史事实；这与附件 `modelForm` 必须持久化且不可改写的规则不同。

## 配置与兼容

- `ProviderProfile`、legacy profile coercion、配置 GET/PUT 和 profile 编辑需要保留 `modelContextWindows`；web-import 按“来源与优先级”的替换/清除规则处理它，不做逐模型合并。
- 不新增 UI 才能使用的必要条件；高级用户可先通过 config.json 配置。后续若在 profile 表单增加编辑器，应复用同一校验，不另建模型注册表。
- `CONFIG.md` 说明精确匹配、优先级、允许大于/小于 200K、失败回退和不支持协议时的配置方式。
- `CLAUDE.md` 只增加简短所有权说明：native 容量由精确路由 resolver 提供，auto-compact 使用当前 threshold；不复制整篇设计。
- 现有无 profile 的直接单元会话默认走 200K，除非测试显式注入路由或发现策略；不能为了测试而读取开发机真实凭证或网络。

## 验收测试

### Resolver

1. 精确覆盖返回大于和小于 200K 的值，且不发网络请求。
2. 同名模型在两个 profile、两个 baseUrl 下互不共享结果。
3. Anthropic 策略采用可靠 `max_input_tokens`；模型 id 不匹配、缺失、零、负数、小数、字符串和把 `max_tokens` 当窗口的响应全部回退。
4. 404/405/501、401/403、超时、网络错误、无效 JSON、超大响应和重定向均不使消息发送失败。
5. 并发同 key 只发一次请求；成功 TTL、过期 last-good 立即返回并后台刷新、所有失败 30 秒冷却和无 last-good 的有界等待符合上文。
6. profile 新对象不能复用旧代际结果，日志和公开 payload 不含 token 或响应正文。

### NativeSession 与切换

7. `getContextUsage()` 返回解析窗口而非固定 200K；模型切换 await 期间发生第二次切换时不能返回陈旧 model/window 组合。
8. resume/fork 不新增容量事件，恢复原路由后重新解析；发现失败不改变历史。
9. turn snapshot 的 model 不被后续 setModel 或查询结果改写。

### Auto-compact

10. 200K/0.8 的默认 threshold 仍为 160K；1M 为 800K；小窗口保留 `DEFAULT_MAX_TOKENS` 输出空间。
11. 显式 `autoCompactWindow` 优先；`autoCompactThreshold: 0` 禁止 ratio 回退并跳过 proactive compact，只有 `undefined` 的旧快照才使用 ratio 兼容路径。
12. idle 的下一次 dispatch 前使用当前模型窗口和原始压力检查；构造 `totalTokens > maxTokens` 的 down-switch，证明 UI parser 拒绝该读数时 compact 仍能收到它。working/queued 不错误 compact，compact 失败不丢失用户消息。
13. web-import 整体替换 source 提供的映射；source 未提供映射但改变 modelList/baseUrl 时清除 target 旧映射，未改变路由字段时保留 target。

## 建议实施拆分

1. **路由与配置：** profile 字段、迁移/保留、resolver 纯解析和覆盖测试。
2. **发现策略与缓存：** 当前 Anthropic-compatible 精确查询、安全边界、TTL/last-good、并发测试。
3. **NativeSession 集成：** 动态 usage、模型代际、resume/fork 和 threshold 测试。
4. **Manager 与文档：** idle dispatch 预检查、threshold 优先级、E2E、CONFIG/CLAUDE 更新和最终 review。

实现仍在 main 上按既定 Subagent-driven 流程进行，不新增依赖，不创建 worktree；提交前逐任务和全量 review。pull/push 需要另行明确授权。
