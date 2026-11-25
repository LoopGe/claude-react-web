# Native Provider Prompt Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** native 会话每轮主 turn 结束后生成一条预测的下一条用户输入，经现有 psug 通道到达 composer（placeholder + Tab），与 claude 会话体验一致。

**Architecture:** 编排者放 `NativeSession`（loop 保持纯净）：主请求构建时捕获快照（wire 前缀 + system/tools/model），turn 结束后过判定链（实证 cacheRead 证据门 + 时间门 + 尾部门 + 身份门），fork 请求 = 快照前缀 + 最终 assistant + SUGGESTION MODE 提示词（主模型、thinking 禁用、1024 上限、无新 cache 断点），产出过 CJK 全套过滤后发中性 `prompt/suggestion` OperationalFrame，host adapter 投影成 SDK `prompt_suggestion`。消费侧（pump/psug/Composer）零改动。

**Tech Stack:** TypeScript (Node 20, ESM)、vitest（server 测试 Node 环境）、现有 neutral vocabulary / wire-projection / anthropic-stream / Pushable 设施、Playwright app-config fixture harness（E2E）。

**Spec:** `docs/superpowers/specs/2026-11-25-native-prompt-suggestions-design.md`（已批准；机制事实引用 `docs/research/2026-11-25-prompt-suggestions.md`，下称"调研"）

## Global Constraints

- 中性纪律：core 新模块只 import `vocabulary/*` + 同级 native 模块 + `shared/*` + Node builtins；SDK 投影只在 `native-host-frame-adapter.ts`（`neutrality.test.ts` / `host-free.test.ts` 必须全绿）。
- `OperationalFrame` 是 CLOSED union：新成员与所有 `assertNever` / discriminant switch / 类型 pin 同步更新。
- fork 参数：`maxTokens: 1024` 无条件；`thinking: {type:'disabled'}` 仅当 `supportsThinkingForModel(model) === true`，否则省略字段；**省略** temperature / effort / fastMode / thinkingDisplay。
- fork **不执行工具、不 append history、不写 v3 log、usage 不进 session 统计**（lastUsage / context-usage / per-model totals）。
- 每轮至多一条建议，帧在 terminal result 之后；抑制/空/过滤/失败一律静默（`createLogger('native')` debug + metrics），不重试、不发错误帧。
- 判定链阈值（verbatim）：证据门 `lastRoundUsage.cacheReadTokens > 0`；时间门 `now − snapshot.at < 300_000 × 0.9`（270s）；尾部门 `inputTokens + outputTokens > 10_000` 抑制；首轮 `assistantCount < 2` 抑制。
- 快照 `{at, model, system, tools, messages}` 只在主 turn 的 stream dep 捕获（单写者）；fork 只读快照，不读 live system/tools。
- 默认开：仅 `promptSuggestions === false` 抑制（undefined = 开）；provider plumbing `opts.promptSuggestions ?? true`。
- metrics 系列标签只用有限枚举（`native_prompt_suggestion_total{outcome, reason}`），不含 session id。
- destroy 时在飞建议 settle 等待上限 **30_000ms** 再 abort。
- CJK 过滤规则整套移植（调研 §3.5 全表），中文建议质量是核心。
- 提示词常量逐字复用调研 §3.3 恢复的 SUGGESTION MODE 全文（含安全条款与 "2-12 words" 格式行）。

## Review Focus

 spec 暗示但常规路径不覆盖的五类输入/失败模式（测试已加入 owning task）：

1. **网关忽略 thinking:disabled** → fork 响应 thinking-only（generateTitle 事故同源）：必须静默跳过，无帧无错误（Task 7）。
2. **fork 响应是 tool_use 而非 text**：不执行任何工具，静默跳过（Task 7）。
3. **污染检查**：happy path 后 history 长度 / v3 log 事件 / session lastUsage 与无建议时完全一致（Task 7）。
4. **destroy 撞上在飞 fork**：≤30s settle，不挂起，关闭后无帧（Task 7）。
5. **第二条消息在飞时到达**：旧 fork 被 abort，每轮至多一条帧，新 turn 不受阻（Task 7）。

---

### Task 1: 中性帧词汇 `prompt/suggestion` + pin 更新

**Files:**
- Modify: `server/providers/native/vocabulary/live-frame.ts:56-87`（OperationalFrame union）
- Test: `server/providers/native/vocabulary/live-frame.test.ts:137-146`

**Interfaces:**
- Produces: `OperationalFrame` 新成员 `{ type: 'prompt/suggestion'; suggestion: string } & OperationalEnvelope`（`sessionId/uuid/parentToolUseId`，后者恒 null）。Task 2/6/7 都消费这个形状。

- [ ] **Step 1: 更新失败测试**

`live-frame.test.ts` 的 "OperationalFrame covers the six native live-only kinds" 改为 seven：新增
```ts
const suggestion: OperationalFrame = { type: 'prompt/suggestion', sessionId: 's', uuid: 'u', parentToolUseId: null, suggestion: '跑测试' }
```
加入 `kinds` 数组末尾，期望数组追加 `'prompt/suggestion'`；测试名 six→seven。另加一个 runtime 断言：`suggestion.suggestion` 是 string、`parentToolUseId` 为 null。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native/vocabulary/live-frame.test.ts`
Expected: FAIL（类型错误：'prompt/suggestion' 不在 union）

- [ ] **Step 3: 加 union 成员**

`live-frame.ts` OperationalFrame 追加（带一行注释：live-only 预测帧，R6 永不持久化；parent 恒 null，只有主 turn 生成）：
```ts
| ({ type: 'prompt/suggestion'; suggestion: string } & OperationalEnvelope)
```
NativeCoreFrame 组成不变（OperationalFrame 内部生长），"is exactly …" 类型 pin 无需改。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/providers/native/vocabulary/live-frame.test.ts`
Expected: PASS（含 purity pin）

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/vocabulary/live-frame.ts server/providers/native/vocabulary/live-frame.test.ts
git commit -m "feat(native): neutral prompt/suggestion live frame"
```

---

### Task 2: adapter 投影 + discriminant 同步

**Files:**
- Modify: `server/providers/native-host-frame-adapter.ts:39-42`（R6 注释）, `:240-312`（projectNativeEventToSdk switch）, `:450-463`（isOperationalFrame）
- Modify: `server/providers/native/native-session.ts:1146-1154`（isOperationalFrame）
- Test: `server/providers/native-host-frame-adapter.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OperationalFrame` 成员。
- Produces: SDK 投影 `{ type: 'prompt_suggestion', suggestion, uuid, session_id }`（**无 subtype、无 parent_tool_use_id**——SDK 类型如此，不走 operationalEnvelope helper）。pump 凭 `type === 'prompt_suggestion'` 早续（零改动）。

- [ ] **Step 1: 写失败测试**

`native-host-frame-adapter.test.ts` 新增用例：中性帧 `{type:'prompt/suggestion', sessionId:'s1', uuid:'u1', parentToolUseId:null, suggestion:'跑测试'}` 经 `projectNativeEventToSdk` 返回
```ts
{ type: 'prompt_suggestion', suggestion: '跑测试', uuid: 'u1', session_id: 's1' }
```
断言**不含** `subtype` / `parent_tool_use_id` 键。再经 `projectCoreFrame` 路径（wrapNativeCore 的 messages 流或现有等价测试入口）断言同形状。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native-host-frame-adapter.test.ts`
Expected: FAIL（assertNever 抛错 / 类型不匹配）

- [ ] **Step 3: 实现投影 + discriminant**

- adapter `projectNativeEventToSdk`：`case 'prompt/suggestion': return { type: 'prompt_suggestion', suggestion: event.suggestion, uuid: event.uuid, session_id: event.sessionId } as AgentMessage`（直接构造，不用 operationalEnvelope）。
- adapter 与 native-session 两处 `isOperationalFrame` switch 各加 `case 'prompt/suggestion':`。
- R6 注释（adapter:39-42）：把 `prompt_suggestion` 从 "claude-only、无投影" 列表移除，注明 native 现经中性帧投影。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/providers/native-host-frame-adapter.test.ts server/providers/native/vocabulary/live-frame.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/providers/native-host-frame-adapter.ts server/providers/native-host-frame-adapter.test.ts server/providers/native/native-session.ts
git commit -m "feat(native): project prompt/suggestion to SDK prompt_suggestion"
```

---

### Task 3: 归一化 + 多语言过滤（纯函数，CJK 核心）

**Files:**
- Create: `server/providers/native/prompt-suggestion-filter.ts`
- Test: `server/providers/native/prompt-suggestion-filter.test.ts`

**Interfaces:**
- Produces:
  - `normalizeSuggestion(raw: string): string | null` —— 调研 §3.3 的 W：trim；剥整段 `<suggestion>/<response>/<output>/<answer>/<result>` 包裹；剥行首标签（英文 suggested response/reply/input/prompt、suggestion/response/reply/answer/output/result + CJK 提案/回答/返信/応答/出力/結果/建議/回復/答案/輸出/結果 + 韩文 제안/답변/응답/출력/결과，后跟 `:` 或 `：`）；空 → null。
  - `type SuggestionScreenReason = 'empty' | 'done' | 'meta_text' | 'meta_wrapped' | 'error_message' | 'prefixed_label' | 'too_few_words' | 'too_many_words' | 'too_long' | 'multiple_sentences' | 'has_formatting' | 'evaluative' | 'claude_voice'`
  - `screenSuggestion(text: string): { ok: true; text: string } | { ok: false; reason: SuggestionScreenReason }` —— 调研 §3.5 的 q 全表，按表中顺序检查。
- 只 import Node builtins（无 vocabulary 依赖亦可——纯字符串函数）。Task 7 消费。

- [ ] **Step 1: 写失败测试（规则表逐条，CJK 重点）**

测试名即规则；每条给命中/豁免两侧断言。必含（值 verbatim）：
- normalize：`'<suggestion>跑测试</suggestion>'` → `'跑测试'`；`'建议：跑测试'` → `'跑测试'`；`'提案なし'` 经 normalize 不变、screen 杀（meta_text）；`'  run the tests  '` → trim。
- done：`'done'` / `'完成了'` / `'完了しました'` / `'완료'` 杀。
- meta_text：`'nothing to suggest'` / `'没有建议'` / `'提案はありません'` / `'해당 없음'` 杀。
- meta_wrapped：`'(跑测试)'` / `'【跑测试】'` 杀。
- prefixed_label：`'suggestion: run tests'` 杀（`/^\w+:\s/`）。
- too_few_words：`'run'` 杀；**`'跑测试'` 过**（CJK 字符数 ≥2）；`'yes'`/`'commit'`/`'push'` 过（白名单）；`'/compact'` 过（slash 豁免）。
- too_many_words：13 个英文词杀；too_long：100 字符杀（99 过）。
- multiple_sentences：`'Run tests. Then commit.'` 杀；`'跑测试。然后提交。'` 杀（CJK 句读）。
- has_formatting：`'run **tests**'` / 含换行杀。
- evaluative：`'looks good'` / `'谢谢'` / `'太好了'` / `'ありがとう'` / `'감사합니다'` 杀。
- claude_voice：`'Let me run the tests'` / `'我来跑测试'` 杀；`'让我们跑测试'` **过**（让我(?!们) 负前瞻）。
- error_message：`'API Error: 500'` 杀。
- 正常建议：`'run the tests'` / `'跑测试'` / `'提交这个'` ok。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native/prompt-suggestion-filter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

按调研 §3.5 表逐条实现正则；CJK 字符计数用 `/\p{Script=Han}/u` 等 Unicode property escapes（ repo lib ES2022 支持）。词数 = 空白 split 非空段；CJK 豁免走字符数。导出签名见 Interfaces。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/providers/native/prompt-suggestion-filter.test.ts`
Expected: PASS（全部规则用例）

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/prompt-suggestion-filter.ts server/providers/native/prompt-suggestion-filter.test.ts
git commit -m "feat(native): suggestion normalization + multilingual screen (CJK core)"
```

---

### Task 4: 判定链（纯函数）+ 提示词常量

**Files:**
- Create: `server/providers/native/prompt-suggestion.ts`
- Test: `server/providers/native/prompt-suggestion.test.ts`

**Interfaces:**
- Consumes: `TokenUsage`（`vocabulary/types.js`）。
- Produces:
  - `SUGGESTION_PROMPT: string`（调研 §3.3 全文逐字，含安全条款）
  - `SUGGESTION_MAX_TOKENS = 1024`、`SUGGESTION_CACHE_TTL_MS = 300_000`、`SUGGESTION_WARM_RATIO = 0.9`、`SUGGESTION_TAIL_LIMIT = 10_000`
  - `interface SuggestionSnapshot { at: number; model: string; system: string; tools: unknown[]; messages: unknown[] }`
  - `interface SuggestionGateInput { enabled: boolean; assistantCount: number; turnIsError: boolean; permissionMode: string; currentModel: string; snapshot: SuggestionSnapshot | null; lastRoundUsage: TokenUsage | null; now: number }`
  - `suggestionSuppressionReason(input: SuggestionGateInput): string | null` —— 按 spec §5 顺序：`disabled`（enabled===false）→ `early_conversation`（assistantCount<2）→ `last_response_error`（turnIsError）→ `plan_mode`（permissionMode==='plan'）→ `no_snapshot`（snapshot===null）→ `model_switched`（currentModel!==snapshot.model）→ `cache_cold`（lastRoundUsage===null 或 cacheReadTokens===0 或 now−at ≥ TTL×RATIO）→ `uncached`（inputTokens+outputTokens > TAIL_LIMIT）。通过 → null。
- Task 6/7 消费。

- [ ] **Step 1: 写失败测试**

每道门一个抑制用例（构造恰好命中该门的 input，断言 reason 字符串）+ 全通过用例（snapshot 新鲜、cacheReadTokens: 48896、input+output 小、assistantCount 2、model 一致、enabled、非 plan、非 error → null）。边界：`now−at === 270_000` 抑制、`269_999` 通过；`input+output === 10_000` 通过、`10_001` 抑制；`cacheReadTokens: 0` 抑制（证据门）；lastRoundUsage null 抑制。另断言 `SUGGESTION_PROMPT` 以 `'[SUGGESTION MODE:'` 开头、含 `'2-12 words'` 与安全条款行。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native/prompt-suggestion.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

常量 + 纯函数，签名见 Interfaces；提示词从调研 §3.3 代码块逐字复制（模板字符串）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/providers/native/prompt-suggestion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/prompt-suggestion.ts server/providers/native/prompt-suggestion.test.ts
git commit -m "feat(native): suggestion suppression chain + SUGGESTION MODE prompt"
```

---

### Task 5: `StreamRequest.appendMessages`（无断点追加）

**Files:**
- Modify: `server/providers/native/anthropic-stream.ts:31-51`（StreamRequest）, `:151-165`（buildRequestBody messages 分支）
- Test: `server/providers/native/anthropic-stream.test.ts`（现有；若无则创建）

**Interfaces:**
- Produces: `StreamRequest.appendMessages?: unknown[]` —— buildRequestBody 在**快照前缀末消息打完断点后**原样 push 追加消息，追加消息**不带 cache_control**。Task 7 的 fork 请求用它携带最终 assistant + 建议消息。

- [ ] **Step 1: 写失败测试**

```ts
const body = buildRequestBody({ …baseReq, messages: [userMsg], appendMessages: [assistantWire, suggestionWire] })
```
断言：`body.messages` 长度 3；**第 1 条**（前缀末消息）末块含 `cache_control: {type:'ephemeral'}`；第 2、3 条任何块**不含** `cache_control`；内容与传入逐字一致（不 mutate 传入数组——`appendMessages` 与 `messages` 原数组长度不变）。无 appendMessages 时行为与现状完全一致（回归用例）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native/anthropic-stream.test.ts`
Expected: FAIL（appendMessages 不存在 / 被忽略）

- [ ] **Step 3: 实现**

StreamRequest 加字段（注释：fork 追加消息，永不打断点——skipCacheWrite 等价）；buildRequestBody 在 messages 分支末尾 `if (req.appendMessages?.length) body.messages = [...(body.messages as unknown[]), ...req.appendMessages]`（注意 body.messages 可能已被 cachedContent 分支替换；无 messages 时 appendMessages 直接成为 body.messages）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/providers/native/anthropic-stream.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/anthropic-stream.ts server/providers/native/anthropic-stream.test.ts
git commit -m "feat(native): StreamRequest.appendMessages — breakpoint-free fork tail"
```

---

### Task 6: 快照捕获 + 选项 plumbing

**Files:**
- Modify: `server/providers/native/native-session.ts`（NativeSessionOptions ~275、字段区 ~385、主 turn stream lambda :1503、persistFrame assistant 分支 :1189-1207）
- Modify: `server/providers/native/native-provider.ts:293-297`（createSession opts 传递）
- Test: `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: Task 4 `SuggestionSnapshot`。
- Produces:
  - `NativeSessionOptions.promptSuggestions?: boolean`（undefined = 开）。
  - private `suggestionSnapshot: SuggestionSnapshot | null`（初始 null）——主 turn stream lambda 每轮捕获 `{at: Date.now(), model: req.model, system: req.system, tools: req.tools, messages: req.messages}`（最后一条主请求胜出；nested runner 不经此 lambda，天然不捕获）。
  - private `lastRoundUsage: TokenUsage | null`——persistFrame 的 assistant-frame 分支记 `frame.usage`（每轮覆盖）。
  - provider plumbing：`promptSuggestions: opts.promptSuggestions ?? true`。
- Task 7 读这两个字段。

- [ ] **Step 1: 写失败测试**

用 capturing seam（`provider._testStream = (req) => { captured.push(req); return scriptedStream }`，脚本用现有 `textTurn`/`pricedTurn` helper）：
- 两轮 turn 后 `coreOf(handle)` 的 `suggestionSnapshot`（测试经 nativeCoreOf 读 private——现有 coreOf helper 同模式）非 null，`model/system/tools/messages` 与**第二轮** captured req 一致，`at` 接近 Date.now()。
- 多轮 turn（toolTurn + textTurn 脚本）后快照 = **最后一轮** req。
- `lastRoundUsage` 等于末轮 assistant frame 的 usage（用带 cache_read_input_tokens 的 message_start 脚本断言 cacheReadTokens 透传）。
- 选项：createSession `{promptSuggestions: false}` → core opts 为 false；缺省 → true（provider ?? true）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "suggestion snapshot"`
Expected: FAIL

- [ ] **Step 3: 实现**

字段 + lambda 捕获 + persistFrame 记录 + opts 字段 + provider plumbing（签名见 Interfaces）。捕获 lambda 保持返回 `this.streamFor(req, { effortLevel: () => turnEffortLevel })` 不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "suggestion"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-provider.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): capture suggestion request snapshot + promptSuggestions option"
```

---

### Task 7: 编排 + 生命周期 + 集成测试

**Files:**
- Modify: `server/providers/native/native-session.ts`（turn/end 块后 ~1605、enqueue :1613、interrupt :1880、destroy :2259、新 private 方法区）
- Test: `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: Task 3 `normalizeSuggestion`/`screenSuggestion`、Task 4 全部、Task 5 `appendMessages`、Task 6 快照/lastRoundUsage/opts、`projectNativeHistoryToWire(history, {attachmentPort, preparedPdfs}, signal)`（async）、`streamAnthropicMessages(req, onRetry)`、`supportsThinkingForModel`（effort-capability）、`metrics.count(name, labels)`。
- Produces: private `maybeSuggestPrompt(turnResult: TurnResult | null): Promise<void>`；private `suggestionAbort: AbortController | null`、`suggestionInFlight: Promise<void> | null`；private `runSuggestionFork(req: StreamRequest): AsyncIterable<CanonicalEvent>`。

- [ ] **Step 1: 写失败集成测试（capturing seam，脚本区分主/fork）**

seam 模式：`provider._testStream = (req) => { requests.push(req); const isFork = JSON.stringify(req.messages).includes('[SUGGESTION MODE:'); return (async function*(){ yield* (isFork ? forkScript.shift() : mainScript.shift()) ?? [] })() }`。主脚本 helper 新增 `cachedTurn(text, {input, output, cacheRead})`（message_start usage 带 `cache_read_input_tokens`）。**注意首轮抑制（assistantCount<2）：happy path 需两条用户消息**，脚本 `[cachedTurn('回复1'), cachedTurn('回复2'), textTurn('跑测试')]`。

用例（断言帧序列经 handle.messages 收集）：
- **happy**：两轮后出现 `{type:'prompt_suggestion', suggestion:'跑测试'}`，位于第二个 result 之后；fork req 的 messages = [user1, assistant1, user2, assistant2, suggestionUser]（suggestionUser content 含 SUGGESTION_PROMPT），system/tools 与主 req 逐字一致。
- **污染检查（Review Focus 3）**：happy 后 history 长度 4（2 user + 2 assistant）、v3 log 无 suggestion 事件、`lastUsage` 等于第二轮主 usage（不含 fork）。
- **证据门**：主脚本 cacheRead=0 → requests.length===2（无 fork），无帧。
- **thinking-only fork（Review Focus 1）**：fork 脚本只含 reasoning delta → 无帧、无错误帧。
- **tool_use-only fork（Review Focus 2）**：fork 脚本 toolTurn → 无帧，且无工具执行（permission 回调零调用）。
- **过滤**：fork 返回 '谢谢' → 无帧。
- **在飞 abort（Review Focus 5）**：fork seam 返回 deferred iterable；第二条消息 enqueue 后 resolve → 无帧，新 turn 正常完成。**变体**：第二条消息在 fork 启动前已入队（drain 路径）→ turn 启动即 abort，同样无帧。
- **interrupt**：在飞 fork 时 interrupt() → 无帧。
- **destroy settle（Review Focus 4）**：在飞 fork 时 destroy() → 30s 内 resolve（测试用短 deferred + 立即 abort 路径），关闭后无帧。
- **选项关**：promptSuggestions:false → 无 fork。
- **模型切换**：两轮间 setModel → 第二轮无 fork（model_switched）。
- **尾部**：末轮 input+output > 10K → 无 fork。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "prompt suggestion"`
Expected: FAIL

- [ ] **Step 3: 实现编排**

`maybeSuggestPrompt(turnResult)`：
1. `suggestionSuppressionReason({enabled: this.opts.promptSuggestions !== false, assistantCount: this.history.filter(m => m.role === 'assistant').length, turnIsError: turnResult === null || turnResult.isError, permissionMode: this.permissionMode, currentModel: this.model, snapshot: this.suggestionSnapshot, lastRoundUsage: this.lastRoundUsage, now: Date.now()})` → reason 非 null：log.debug + `metrics.count('native_prompt_suggestion_total', {outcome:'suppressed', reason})` + return。
2. abort 上一个 suggestionAbort；新建（sessionAbort 已 aborted → return）；`suggestionInFlight = this.runSuggestion(...)` fire-and-forget（void + catch）。
3. `runSuggestion`：取 `this.history` 末条（role 非 assistant → debug log + return）；`finalWire = await projectNativeHistoryToWire([last], {attachmentPort: this.opts.uploadStore ? this.opts.ports.attachment : undefined, preparedPdfs: this.preparedPdfs}, signal)`；fork StreamRequest = `{...this.opts.credentials(), model: snap.model, system: snap.system, tools: snap.tools, messages: snap.messages, appendMessages: [...finalWire, {role:'user', content:[{type:'text', text: SUGGESTION_PROMPT}]}], maxTokens: SUGGESTION_MAX_TOKENS, thinking: supportsThinkingForModel(snap.model) === true ? {type:'disabled'} : undefined, signal}`（**无** effort/fastMode/thinkingDisplay）。
4. `runSuggestionFork(req)`：test seam 存在 → 调 seam，req 展平为 `{model, system, tools, messages: [...req.messages, ...(req.appendMessages ?? [])], signal}`；否则 `streamAnthropicMessages(req, async () => {})`（retry 静默）。
5. 消费 CanonicalEvent：按 block index 累积 text（block_start type 'text' 的 index；block_delta delta.type 'text'），忽略 reasoning/tool delta；结束后按 index 顺序取第一个 `normalizeSuggestion` 非 null 候选 → `screenSuggestion` → ok：`this.output.push({type:'prompt/suggestion', suggestion, sessionId: this.opts.id, uuid: this.ctx.uuid(), parentToolUseId: null})` + metrics generated；否则 metrics suppressed（reason: empty 或 screen reason）。
6. catch：abort → 静默；其它 → log.debug + metrics `{outcome:'failed', reason:'error'}`。finally：清理当前 suggestionAbort/inFlight。

接线：turn/end 块后（~1605）`void this.maybeSuggestPrompt(turnResult)`（turnResult 成功路径 = res，catch 路径 null——在 try 外声明 `let turnResult: TurnResult | null = null`，成功赋值）。`enqueue`/`interrupt` 开头 `this.suggestionAbort?.abort()`；**pumpLoop 启动下一个 turn 时（runTurn 之前）同样 abort**——覆盖"输入早在 turn 中入队、turn 结束后直接 drain"的路径（该路径不经新 enqueue）。`destroy`：abort + `await Promise.race([this.suggestionInFlight ?? Promise.resolve(), 30s timeout])`（timeout unref，race 后清理）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "prompt suggestion"`
Expected: PASS（全部用例）

- [ ] **Step 5: 全量回归 + 结构 pin**

Run: `npx vitest run server/providers/native/ && npm run typecheck`
Expected: 全绿（neutrality / host-free / live-frame pin 含在内）

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): turn-end prompt suggestion orchestration with cache-cold suppression"
```

---

### Task 8: 浏览器 E2E（真实 native core → composer）

**Files:**
- Create: `tests/browser/fixtures/native-suggestion-server.mjs`（复制 `app-panel-state-server.mjs` 骨架）
- Create: `tests/browser/native-prompt-suggestion.spec.ts`
- Modify: `playwright.app.config.ts`（testMatch + webServer 指向新 fixture，或新独立 config——选对现有 harness 侵入最小的一种）

**Interfaces:**
- Consumes: 真实 `NativeProvider`（`server/providers/native/native-provider.ts`）+ `makeNativePorts`、`_testStream` seam、Task 7 全链路。
- Produces: 端到端证据——native 会话 placeholder 出现、Tab 填充、发送清除。

- [ ] **Step 1: fixture server**

骨架同 app-panel-state-server（真实 Hono REST/WS + SessionManager + bootstrap），registry 注册**真实 NativeProvider**（temp stateDir + makeNativePorts），`_testStream` 脚本：主 turn 带 `cache_read_input_tokens: 48896` 的 textTurn，fork（messages 含 '[SUGGESTION MODE:'）返回 textTurn('跑测试')。会话 create body `provider: 'native'`。

- [ ] **Step 2: 写 spec（先跑确认失败/红）**

`native-prompt-suggestion.spec.ts`：创建 native 会话 → 发第一条消息（首轮抑制，无 placeholder）→ 发第二条 → 断言 composer placeholder 含 '跑测试' → 按 Tab → 断言输入框值 '跑测试' → 发送 → 断言 placeholder 清除。零 uncaught page error。

- [ ] **Step 3: 跑 E2E 确认通过**

Run: `npx playwright test --config playwright.app.config.ts native-prompt-suggestion`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/browser/fixtures/native-suggestion-server.mjs tests/browser/native-prompt-suggestion.spec.ts playwright.app.config.ts
git commit -m "test(native): browser E2E for prompt suggestion placeholder + Tab"
```

---

### Task 9: 终验 + code review

**Files:** 无新改动（验证 + 审查修复）。

- [ ] **Step 1: 全量验证**

Run: `npm run typecheck && npm run lint && npx vitest run server/providers/native/ server/providers/native-host-frame-adapter.test.ts`
Expected: 全绿。

- [ ] **Step 2: code review（repo 约定：未审查代码不得落地）**

对完整 diff（`git diff <base>..HEAD`，base = Task 1 前的 commit）跑 code-review skill；逐条核实发现并修复；非平凡修复重跑审查。

- [ ] **Step 3: 修复后重验 + 收尾 commit（如有修复）**

Run: 受影响测试 + typecheck。修复单独 commit。

---

## Self-Review 记录

- **Spec 覆盖**：§4 配方 → Task 4/5/7；§5 判定链 + 快照 → Task 4/6/7；§6 架构落点 → Task 1/2/6/7；§7 生命周期 → Task 7；§8 可观测 → Task 7；§9 测试计划 → 各 Task + 8；§10 留给实现者（单条 wire 投影、接线点、超时、CJK 正则、E2E mock）→ Task 7 step 3 / Task 8 已定具体方案。无缺口。
- **类型一致**：`SuggestionSnapshot`/`SuggestionGateInput`/`suggestionSuppressionReason`/`normalizeSuggestion`/`screenSuggestion`/`appendMessages`/`prompt/suggestion`/`prompt_suggestion` 跨 Task 引用一致；`metrics.count(name, labels)` 参数序与源码一致。
- **Review Focus** 五条均已落入 Task 7 测试步骤。
- **比例**：测试块只给断言与脚本形状，实现块只给签名 + 算法要点，无函数体转录。
