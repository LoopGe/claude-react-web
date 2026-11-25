# Native Provider Prompt Suggestions 设计

> 2026-11-25。状态：待审批。
> 调研基础：`docs/research/2026-11-25-prompt-suggestions.md`（CLI 2.1.311 逐字节恢复 + Mify 网关实测）。
> 本文档是该调研的实现设计；CLI 机制事实一律引用调研笔记章节号，不重复论证。

## 1. 意图与背景

native provider（直连 Anthropic 兼容 API）目前没有 prompt 预测：每轮回复结束后 composer 不会出现
"预测的下一条用户输入"。claude provider 有（SDK `promptSuggestions` 默认开），消费侧全链路
（pump 早续 → psug 通道 → Composer placeholder + Tab）已就绪且 provider 无关。本设计让 native 会话
获得与 claude 会话一致的体验，机制照 CLI 配方复刻，参数按第三方网关实测精化。

**为什么现在**：用户日常主力会话跑在 Mify 网关的 reasoning 模型上（native 与 claude provider 皆然），
缺失的预测是每轮都能感知的体验差。成本立场已确认：**每轮多花一点可接受，但 cache 冷时不生成**。

## 2. 目标 / 非目标 / 反目标

**目标**
- native 主会话每轮（主 turn）结束后，至多一条建议，经现有 psug 通道到达 composer（placeholder + Tab）。
- 中文建议质量是核心：CLI 的多语言归一化 + 过滤规则**整套**移植（CJK/日/韩，调研 §3.5）。
- 成本保护：cache 冷 / 尾部过大 / 首轮 / 错误轮等场景静默不生成（§5 判定链）。
- 跨网关兼容：Anthropic 直连、Mify、其他 Anthropic 兼容网关均可用；不支持 cache 的网关上功能
  静默关闭（证据门恒冷），不产生全价重读成本。
- 中性纪律不破：core 新模块只 import 中性词汇 + 同级；SDK 投影只在 host adapter；结构 pin 全绿。

**非目标（v1 明确不做）**
- 接受/忽略遥测（CLI 的 accepted/ignored 相似度统计）。
- `set_prompt_suggestions_paused` 等价（composer 不在屏暂停）——keep-alive 面板下有价值，留待后续。
- CLI-only 机制：unused-streak backoff、终端 focus 门槛、幽灵文本状态机、swarm teammate 抑制、
  GrowthBook 旗标分支（调研 §3.6/§3.7/§3.8）。
- 多候选、建议持久化、建议进 transcript / v3 log。
- 子代理（sidechain runner）生成建议——只有主会话主 turn 生成。
- 新的客户端 UI / 设置开关——消费侧零改动，选项走已有的 `ProviderSessionOptions.promptSuggestions`。

**反目标（技术上能跑也算失败）**
- 建议请求阻塞或延迟主 turn、下一条用户消息的发送。
- 建议污染模型 history、v3 log、session usage / context-usage 统计、read-state。
- 建议请求执行任何工具。
- cache 冷时仍发请求（成本保护失效）。
- 中文建议被英文规则误杀（如词数 < 2 杀掉"跑测试"）。
- 为修建议问题在 neutral core 引入 SDK / host 依赖。

## 3. 已确认的产品决策（用户拍板）

| 决策 | 结论 | 出处 |
|---|---|---|
| 成本立场 | 每轮多花一点可接受；cache 冷不生成 | 对话确认 |
| 默认开关 | **默认开**，与 claude provider 对齐 | 对话确认 |
| thinking | 建议请求**禁用 thinking** | 对话确认 |
| 参数跨网关 | 实验参数必须兼容其他网关，不写死 Mify  quirks | 对话确认 |
| cache-冷判定 | 需设计清楚；采纳"实证 cacheRead 证据门 + 时间门 + 尾部门 + 身份门" | 对话确认 |

## 4. 生成请求配方（我的 call，含实测依据）

**Mify 实测**（throwaway 探针，2026-11-25，tongyi/deepseek-v4.1-flash）：
- `thinking:{type:'disabled'}` 被网关承认：纯 text 输出，3 token（对照组不发 thinking → thinking+text，50 token）。
- 网关默认思考：省略 thinking 字段 ≠ 禁用（generateTitle 事故同源，commit f79dee9b）。
- disabled 生效时 max_tokens=64 也够；但忽略 disabled 的网关需要防御预算。
- Mify 隐式缓存真实存在：native 会话 32/32 轮 cacheRead 48K–59K、cacheWrite 恒 0；
  claude provider 同网关 151/151 轮 read+write 非零（会话日志 usage 实测）。

**请求参数**：

| 维度 | 取值 | 理由 |
|---|---|---|
| 模型 | 会话**当前主模型** | CLI 事实（调研 §3.3）；不用小模型 |
| system / tools / messages 前缀 | 取**快照**（末次主请求的 wire 形状，§5），与父请求逐字节一致；**不用 live 状态** | cache piggyback 的前提；免疫 idle 期 MCP/skill/persona 漂移（builder-check #2） |
| 追加消息 | 快照前缀之后依次 append：**本轮最终 assistant 消息（wire 形状，无断点）** + 一条普通 user 消息 = SUGGESTION MODE 提示词（调研 §3.3 全文逐字复用，无断点） | CLI 用 post-turn 完整消息重存快照（调研 §3.4）——预测必须看得到刚结束的回复；最终 assistant 是 uncached 尾部，由 §5 尾部门约束（builder-check #1） |
| thinking | `supportsThinkingForModel(model)` 为 true 才发 `{type:'disabled'}`，否则**省略字段** | 与主请求同一门控（anthropic-stream.ts:126）；非 thinking 模型/网关不收意外字段 |
| max_tokens | **1024，无条件** | 上限不预留成本（实测 3 token）；忽略 disabled 的网关防思考吃光（generateTitle 教训） |
| temperature | **省略** | native 主请求本就不发；避免网关对 reasoning 模型 temperature 的拒绝风险 |
| cache 断点 | 断点留在**父请求位置**（system + 末 tool + 快照末消息末块）；最终 assistant 与建议消息**均无 cache_control** | skipCacheWrite 等价。实现 = `StreamRequest` 增加 `appendMessages?: unknown[]`，`buildRequestBody` 在快照前缀（末消息断点）之后原样 push 追加消息、不打断点——喂给请求的是快照前缀而非 post-turn 全量 history（builder-check #1 裁决；传输层内部构建 body，故用 append 字段而非外部 push） |
| 工具执行 | **不执行**：单轮 API 调用，只收集 text；响应含 tool_use 而无 text → 归一化后为空 → 静默跳过 | CLI deny-all 的等价（native 无 canUseTool 回路，单轮即止） |
| 轮数 | 单轮（不进 runTurn 循环） | 同上 |
| 落盘 | 不 append history、不写 v3 log、不动 read-state、usage 不计入 session 统计 | skipTranscript 等价；反目标约束 |

**提示词与产出处理**：SUGGESTION MODE 常量 + 归一化 `W`（剥包裹标签/行首标签，含 CJK 标签表）+
过滤 `q`（调研 §3.5 全表：empty/done/meta_text/meta_wrapped/error_message/prefixed_label/
too_few_words（CJK 按字符 ≥2 + 单词白名单豁免）/too_many_words/too_long/multiple_sentences/
has_formatting/evaluative/claude_voice，CJK/日/韩分支整套）。过滤命中 → 静默跳过 + reason 日志。

## 5. cache-冷与逐轮抑制判定链

turn 结束（terminal result 之后）按序检查，任一命中即静默跳过（debug 日志记 reason，
metrics 计数见 §8）。reason 命名对齐 CLI 遥测便于对照：

| # | 门 | 判定 | reason | 依据 |
|---|---|---|---|---|
| 1 | 选项 | `promptSuggestions !== true` | `disabled` | CLI afterResult |
| 2 | 首轮 | history 中 assistant 消息数 < 2 | `early_conversation` | CLI ico（§3.2） |
| 3 | 错误轮 | 本 turn `TurnResult.isError`（含 API 错误/限流耗尽） | `last_response_error` | CLI ico |
| 4 | plan mode | 会话当前 permissionMode === 'plan' | `plan_mode` | CLI L |
| 5 | 身份证据 | 无主请求快照（shouldQuery=false 命令轮等） | `no_snapshot` | CLI sdk_no_params |
| 6 | 身份 | 当前模型 ≠ 快照模型 | `model_switched` | CLI tO 模型比对 |
| 7 | **证据门（核心）** | 末轮主请求 usage `cacheReadTokens === 0` | `cache_cold` | **本设计精化**：前缀此刻在缓存里的直接证据。不支持 cache 的网关恒冷 → 功能静默关；compact 重写轮通常 read=0 → 自动抑制（省掉 CLI cache_write 分支） |
| 8 | 时间门 | `now − 快照.at ≥ 270_000`（5m TTL × 0.9；native 发裸 ephemeral = 5m） | `cache_cold`（附 `cacheColdBy: 'prefix_expired'`） | CLI zln |
| 9 | 尾部门 | 末轮 usage `input + output > 10_000` | `uncached` | CLI O（P=1e4） |
| 10 | 在飞互斥 | 已有在飞建议 → abort 旧的再评估 | — | CLI 每轮至多一条 |

**与 CLI 的显式偏差**（均为 native 语境下的合理简化，记录在案）：
- 证据门（#7）是新增：CLI 只有时间推断；native 用实测 usage 证据，更严格也更省。
- 无 account 限流门（CLI L 的 rate_limit/usage_credits）：native 无 plan 账户状态
  （accountInfo 返回 undefined）；限流后果已由 #3 isError 覆盖。
- 无 pending-permission / elicitation 门：主 turn 结束时其权限必已 resolve；core 不可见
  host broker 的跨 turn 挂起（六端口纪律），且 turn-end 时机使该门基本冗余。
- 无 GrowthBook 豁免分支（`tengu_chomp_*` 默认值即关闭那些分支）。

**快照状态**（per-session，neutral core 持有；builder-check #2 精化）：
`{ at: number, model: string, system: string, tools: unknown[], messages: unknown[]（wire 前缀，浅拷贝数组）, lastRoundUsage: TokenUsage }`
—— 在 session 的 **stream dep 包装**里、每次主请求**构建时**捕获（单写者；loop 调 stream 前已完成
wire 投影，LoopDeps.stream 收到的就是 wire 形状，无需进 anthropic-stream 内部加捕获 machinery）。
`lastRoundUsage` 取自该 turn 最后一个 AssistantFrame 的 usage（不是 turn 累计），turn 结束时补入。
fork **只读快照**的 system/tools/messages，不读 live 状态——idle 期 MCP 变更 / skill reload /
persona 切换重建了 live system/tools 也不影响 fork 的 cache 命中（下一个主请求自然建立新 cache）。
compact / clear / resume / fork 重置快照；模型切换由身份门抑制。
**实现裁决（Task 6/7 审查确认）**：显式 reset 由构造满足而非单独代码——每次生成必跟随一次新的主请求捕获
（runTurn 每轮必调 stream）；错误/中断轮在判定链 #3 先抑制（turnResult=null）；命令轮不触发编排；
fork/resume 构建全新对象（字段初始 null）；clear 后 assistantCount<2 抑制。无 stale-snapshot 生成路径。

## 6. 架构落点

```
NativeSession（core，编排者）
  ├─ 主 turn 结束（runTurn resolve，terminal result 已发）→ maybeSuggestPrompt()
  │    fire-and-forget，持 AbortController；新输入 / interrupt / destroy 时 abort
  ├─ 判定链（§5）读：history / TurnResult / permissionMode / 快照
  ├─ fork 请求：快照.messages + 最终 assistant wire + 建议 user 消息
  │    → StreamRequest{…快照, appendMessages:[最终assistant, 建议]} → buildRequestBody（断点留父位置）
  │    → streamAnthropicMessages（独立 signal，retry 静默，usage 不进 session 统计）
  ├─ 归一化 W + 过滤 q（纯函数模块）
  └─ 通过 → emit 中性帧
vocabulary/live-frame.ts
  └─ OperationalFrame 新成员：{ type: 'prompt/suggestion'; suggestion: string } & OperationalEnvelope
     （live-only，永不持久化，R6；parentToolUseId 恒 null）
native-host-frame-adapter.ts
  └─ 投影：neutral → SDK { type:'prompt_suggestion', suggestion, uuid, session_id }
     更新 R6 scope 注释（prompt_suggestion 不再是 claude-only）
消费侧（零改动）
  └─ pump 早续 → session.lastPromptSuggestion → psug 通道 → mirror.promptSuggestion
     → Composer placeholder + Tab（发送/清 transcript 时清除，已有 reducer）
```

**新模块**（core，只 import 中性词汇 + 同级）：
- `server/providers/native/prompt-suggestion.ts`：SUGGESTION MODE 常量、判定链、fork 编排。
- `server/providers/native/prompt-suggestion-filter.ts`：归一化 W + 过滤 q（纯函数，可单测）。

**为什么编排者是 NativeSession 而不是 loop**：loop 是纯 turn 引擎（LoopDeps 无跨 turn 状态、
无 session 选项/模型/权限模式视野）；建议需要跨 turn 快照 + 会话级 abort 生命周期 + 选项，
与 generateTitle 同层。nested runner（emitResult=false）不触发。CLI 的发射器同样在会话循环外。

**结构 pin 影响**：
- `live-frame.test.ts` 钉死 OperationalFrame "六种" 与 NativeCoreFrame 组成 → 更新为七种。
- `neutrality.test.ts` / `host-free.test.ts`：新模块过禁 import 扫描（只词汇 + 同级 + Node builtins）。
- adapter 是 SDK 投影唯一边界（新帧投影加在 adapter，core 不识 SDK 形状）。

## 7. 生命周期与失败合同

- **触发**：仅主会话主 turn 的 terminal result 之后；`shouldQuery=false` 轮无快照自然抑制。
- **在飞互斥**：新 turn 启动 / 新用户输入入队 → abort 在飞生成（CLI onCommand 等价）。
- **interrupt / destroy / sleep**：abort；destroy 时 settle 等待上限 **30s**（CLI cH 等价）再 abort。
- **失败**：API 错误 / 超时 / 空产出 / 过滤命中 → 静默跳过，`createLogger('native')` debug 记 reason；
  **不重试、不发错误帧、不影响主 turn**（CLI 合同，调研 §3.6）。
- **帧投递**：至多一条，在 terminal result 之后；无建议的轮次不发帧。
- **客户端清除**：发送新消息 / 清 transcript 时清除（已有 reducer，零改动）。

## 8. 可观测性（我的 call）

- 日志：`createLogger('native')`，debug 级记每次抑制 reason + 生成成功（textLen、elapsed、cacheRead）。
- metrics：`native_prompt_suggestion_total` counter，label `outcome=generated|suppressed|failed` +
  `reason=<§5 有限枚举>`（遵守"系列标签只用有限枚举"约定，不含 session id）。
- 不做接受/忽略遥测（非目标）。

## 9. 测试计划

- **词汇 pin**：live-frame.test.ts 七种 OperationalFrame + 组成更新；新帧 live-only（不进 SessionEventMap）。
- **过滤纯函数**：调研 §3.5 全表逐条用例，**CJK 分支重点**（"跑测试" 过、"谢谢" 杀、"完了" 杀、
  全角包裹杀、中文多句杀、字符数豁免）；归一化 W 的包裹/标签剥离（含 CJK 标签）。
- **判定链**：每道门一个抑制用例 + 全通过用例；证据门 cacheRead=0 抑制；模型切换；尾部 >10K；
  时间门过期；compact 轮抑制。
- **fork 请求形状**：快照前缀与父请求逐字节一致；**含最终 assistant 消息**且它与建议消息均无
  cache_control（断点留在父位置）；thinking 按模型门控（thinking 模型发 disabled、非 thinking
  模型省略）；maxTokens=1024；无 temperature/effort/fastMode；不 append history / 不写 log /
  usage 不进 session 统计；**live system/tools 漂移后 fork 仍用快照**（免疫用例）。
- **adapter 投影**：neutral 帧 → SDK 形状（uuid 新生成、session_id、无 parent）。
- **会话集成**：turn 结束发帧（result 之后）；新输入 abort 在飞；interrupt 丢弃；destroy settle；
  子代理 turn 不发；选项关闭不发。
- **结构 pin**：neutrality / host-free 全绿。
- **浏览器 E2E**（app-config fixture harness）：native 会话跑一轮 → composer placeholder 出现 →
  Tab 填充 → 发送清除。复用现有 psug 消费断言模式。

## 10. 留给实现者的

- 最终 assistant 消息的**单条 wire 投影**方式（复用 wire-projection 对单消息切片，保证与主请求
  投影逐字节同形）——契约见 §4，选最复用现有路径的一处。
- `maybeSuggestPrompt` 在 NativeSession 的具体接线点（runTurn resolve 后的 catch/finally 语义，
  保证错误轮也走判定链 #3 而非抛出）。
- fork 流式读取的超时取值（建议请求短输出，可用比主请求更紧的 idle cap；自定并记录）。
- 过滤模块的 CJK 正则细节按调研 §3.5 表实现，逐条对拍。
- E2E fixture 的网关 mock（app-config harness 现有模式）需返回带 cacheRead 的 usage 以过证据门。

## 10.1 Builder-check 裁决记录（我的 call）

新鲜 builder 审查核实了架构声明（消费侧零改动、permissionMode core 可见、attachment 重投影
字节稳定、命令轮无快照自然抑制），提出两个实质问题，均按已批准的"CLI 配方 + 成本保护"裁决：

1. **fork 前缀构造**（§4/§6 原矛盾）：采纳 post-turn 构造——快照前缀 + 最终 assistant（无断点）
   + 建议消息（无断点）。依据：CLI 用 post-turn 消息重存快照（调研 §3.4）；uncached 尾部由
   已批准的 10K 尾部门约束。`buildRequestBody` 零改动成立（喂快照前缀而非全量 history）。
2. **快照形状**（三字段 → 全请求身份）：快照捕获 system/tools/messages，fork 只读快照。
   依据：CLI cacheSafeParams 快照实际请求参数；成本保护反目标要求免疫 live 漂移。

审查中可自决项一并定为 call：fork **省略 effort/fastMode**（预测不需要，避免网关 speed 路由
差异）；fork 的 retry 帧天然不进 session 通道（fork 内部消费流，不经 emit）；选项 plumbing 从
CreateSessionOptions 进 NativeSession opts，`?? true` 默认与 claude-provider.ts:482 同形。

## 11. 风险与开放点

- **忽略 disabled 的网关**：1024 防御预算兜底；若思考超 1024 → 空产出静默跳过（不追加预算分支，
  与 generateTitle 修复同策）。
- **隐式缓存网关的 read 语义**：Mify deepseek 路由 cacheWrite 恒 0、首轮即有 read——证据门通过；
  若某网关 read 字段语义不同（如恒 0 但实际有缓存），功能静默关（保守方向，成本安全）。
- **前缀漂移**：fork 只读快照（§5），idle 期 MCP/skill/persona 重建 live system/tools **不影响**
  fork 命中；compact/模型切换由证据门/身份门抑制；fork 发出后 history 再变不影响在飞请求
  （请求体已快照），新输入 abort 兜底。
- **Anthropic 直连的尾部成本**：最终 assistant 回复对 fork 是 uncached 输入（父请求未缓存它），
  每次建议全价读这段尾部——这正是 10K 尾部门约束的对象（CLI 同形）；fork 不打新断点，尾部
  不会被写入 cache（skipCacheWrite 等价）。
- **常开思考模型（Anthropic 直连，已知局限）**：当前 always-on-thinking 的 Anthropic 模型
  （如 Opus 5.5 / Sonnet 5.5 / Fable 5）在任意 effort 档位下对 `thinking:{type:'disabled'}`
  一律返回 400；关键词分类器 `supportsThinkingForModel` 对这些 ID 返回 true，于是 fork 照发
  disabled，在此类模型的 Anthropic 直连上静默失败（无建议）。由静默失败合同（§7）兜底：
  无成本失控、不影响主 turn；主力 Mify 网关场景不受影响（非 Claude ID → 分类器返回 false →
  省略 thinking 字段）。thinking-mode-aware 的门控已排期为后续跟进（触及 shared 模型能力
  分类与用户已拍板的 thinking 决策，需单独设计，不在本修复波次内改动）。