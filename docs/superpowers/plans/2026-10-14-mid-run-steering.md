# Mid-run Steering 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 工作期间发送的纯文本消息在下一个工具钩子边界注入当前轮（SDK hooks `additionalContext` + Stop `decision:'block'`），turn 结束未投递则零丢失转排队。

**Architecture:** multica 式切分（B'）——机制下沉 provider（`steering.ts` 状态机 + hook 合并 + admission），策略留在 manager（路由/广播/排除逻辑/撤回/回放拼接）。接口契约 4 成员：`enqueueSupplement` / `drainSupplements` / `onSupplementDelivered` / `supportsSteering`。

**Tech Stack:** TypeScript、`@anthropic-ai/claude-agent-sdk@0.3.296`（CLI 2.1.296）、vitest、Hono、React 19。

**Spec:** `docs/superpowers/specs/2026-10-14-mid-run-steering-design.md`（本计划从 spec 立论，执行者需同时读两份）

## Global Constraints

- CLI 版本门控：`supportsSteering` 仅在 CLI ≥ 2.1.110 时为 true（`cachedClaudeHealth()` 探测，模式同 `claude-provider.ts` 的 `cliSupportsInitializePluginDelivery`）
- 仅纯文本可 steer：`additionalContext` 是 string；`content` 含非 text block（图片等）一律走原排队路径
- hooks 注册被子代理继承：`agent_id` 过滤**必须**在投递回调内做（`input.agent_id` 非空 → 返回 `{}` 且不动 pending）
- Stop hook **单回调合并**（并入现有 `buildStop`），绝不并列注册第二个 Stop matcher（同 matcher 多 hook 并行合并行为未定义）
- 测试永不 spawn 真 agent CLI、永不解析已安装 CLI（仓库规矩；真 CLI 验证只在 Task 1 探针，需人工跑）
- steered 消息三不：不进 SDK 输入队列（requeue 例外）、不进 `promptUuids`（requeue 补录例外）、不建 snapshot/rewind anchor
- splice 只含「有 `steeredAt` 且无 `requeuedAt`/`withdrawnAt`」的 sidecar 条目；插入位置索引为 0 时跳过（属于更新的内容）
- `message-steered` 帧挂现有 input-queue-status 通道；durable 半边是 ring 条目上的戳（同 `consumedAt` 模式）
- CSS 一律主题变量（`--*`），禁硬编码色值；新色值 `:root` 与 `[data-theme="light"]` 都要定义
- 每个 task 结束 atomic conventional commit（`feat(steering): …` / `test(steering): …`）；全 diff 过 code-review 才许进 main

## Review Focus

1. **子代理偷消息**：Agent/Task/forked-Skill 侧链触发继承的 hook 时不得消费主线程 steering → Task 2 测试 `handleBoundary ignores subagent-inherited hooks`（agent_id 非空 → `{}`，pending 保留）
2. **stop_hook_active 死循环**：block 续跑后下一次 Stop 无 pending 必须返回 `{}` 并关 admission → Task 2 测试 `empty Stop closes admission`；探针 2 实测二次触发
3. **requeue 双重回放**：requeued 消息已转正为真实 prompt（JSONL 拥有），splice 必须跳过 → Task 5 测试 `splice skips requeued and withdrawn entries`
4. **interrupt-投递竞态**：drain 必须先于 SDK interrupt 调用，drain 后并发 hook 见空队列 → Task 9 测试 `drains steer pending before invoking provider interrupt`
5. **多模态 mid-turn**：含图片的消息不得 steer（否则 additionalContext 丢内容）→ Task 6 测试 `routes multimodal content to the normal queue`

---

### Task 1: Phase 0 探针（throwaway，人工运行）

**Files:**
- Create: `.scratch/steering-probes/probe-1-pretool-additional-context.ts`
- Create: `.scratch/steering-probes/probe-2-stop-block-reloop.ts`
- Create: `.scratch/steering-probes/probe-3-merged-stop-callback.ts`
- Create: `.scratch/steering-probes/probe-4-subagent-inheritance.ts`
- Create: `.scratch/steering-probes/probe-5-jsonl-footprint.ts`
- Create: `.scratch/steering-probes/README.md`

**Interfaces:**
- Consumes: `query()` / `Options.hooks`（SDK 直接调用，不依赖任何本计划后续 task 的代码）
- Produces: `.scratch/steering-probes/RESULTS.md` 观察记录；对 Task 3/5 的分支决策

- [ ] **Step 1: 写 5 个探针脚本**。共同骨架（每个脚本替换 hook 逻辑与断言输出）：

```ts
// .scratch/steering-probes/probe-1-pretool-additional-context.ts
// THROWAWAY PROBE — 验证 PreToolUse additionalContext 到达模型（spec §11 探针 1）。
// 运行：npx tsx .scratch/steering-probes/probe-1-pretool-additional-context.ts
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { config } from '../../server/config.js'
import { randomUUID } from 'node:crypto'

const MARKER = `PROBE-MARKER-${randomUUID().slice(0, 8)}`
const opts: Options = {
  cwd: process.cwd(),
  permissionMode: 'bypassPermissions',
  env: { ...process.env, ANTHROPIC_AUTH_TOKEN: *******.*********, ANTHROPIC_BASE_URL: config.profiles[0]?.baseUrl } as NodeJS.ProcessEnv,
  hooks: {
    PreToolUse: [{
      hooks: [async (input) => {
        if ((input as { agent_id?: string }).agent_id) return undefined
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext:
          `[PROBE] When you finish, your final sentence must contain the token ${MARKER}.` } }
      }],
    }],
  },
}
const q = query({ prompt: 'List the files in the current directory, then stop.', options: opts })
for await (const msg of q) {
  if (msg.type === 'assistant') {
    for (const b of msg.message?.content ?? []) {
      if ((b as { type?: string }).type === 'text') console.log('[assistant]', (b as { text?: string }).text)
    }
  }
  if (msg.type === 'result') {
    const text = (msg as { result?: string }).result ?? ''
    console.log(text.includes(MARKER) ? 'PROBE 1 PASS: marker reached the model' : 'PROBE 1 FAIL: marker absent')
  }
}
```

- probe-2：Stop hook 返回 `{ decision: 'block', reason: 'Continue: reply with the word DONE now.' }`；记录第二次 Stop 的 `stop_hook_active` 值；第二次返回 `undefined` 让其结束。断言：block 后模型继续、二次 Stop `stop_hook_active === true`、无 pending 时正常终止
- probe-3：**单个** Stop 回调内先执行一段快照逻辑（console.log 时间戳），pending 数组非空时返回 `{decision:'block', reason:…}`，验证快照逻辑与 decision 同时生效（每轮都打印、block 生效）
- probe-4：`Options.agents` 定义一个用 `Agent` 工具的子任务，PreToolUse hook 记录每次 `agent_id`；断言子代理触发时 `agent_id` 非空、主线程为空
- probe-5：跑一个带 PreToolUse additionalContext 注入的 turn，结束后 `getSessionMessages(sessionId)` + 直接读 `~/.claude/projects/**/<session>.jsonl`，grep 注入文本，记录落盘形态（user 轮 / meta / 不落盘）

- [ ] **Step 2: 写 README**（运行方式、每探针的判定标准、RESULTS.md 模板）
- [ ] **Step 3: 人工运行全部探针**，结果记入 `RESULTS.md`
- [ ] **Step 4: 按结果做分支决策**（写入 RESULTS.md 末尾）：
  - 探针 1 失败 → **停止后续所有 task**，回 spec 重议
  - PostToolUseFailure 不支持 additionalContext（探针 1 附带验证）→ Task 3 的边界集去掉该事件
  - 探针 5 发现可识别落盘 → Task 5 的 splice 增加按时间窗去重（在 Task 5 执行时补充测试）
- [ ] **Step 5: 不提交**（`.scratch/` 本就 untracked；探针代码标注 throwaway）

---

### Task 2: steering 状态机（纯逻辑）

**Files:**
- Create: `server/providers/claude/steering.ts`
- Test: `server/providers/claude/steering.test.ts`

**Interfaces:**
- Consumes: 无（纯逻辑，零依赖）
- Produces（后续 task 依赖的精确签名）:

```ts
export type SteerBoundary = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop'
export type SupplementOutcome = { ok: true; boundary: SteerBoundary } | { ok: false; reason: 'aborted' }
export interface SteerEntryInput { uuid: string; text: string }
export function formatSupplementInstruction(text: string): string
export class SupplementSession {
  constructor(onDelivered: (uuid: string, outcome: SupplementOutcome) => void)
  notePromptConsumed(): void        // SDK 读走一条 prompt（onConsume）→ admission 开
  enqueue(entry: SteerEntryInput): boolean  // admission 关 → false
  handleBoundary(event: SteerBoundary, input: { agent_id?: string }): Record<string, unknown>
  drainUndelivered(): Array<{ uuid: string }>
  abort(): void                     // 未投递全部回调 {ok:false,reason:'aborted'} 并清空
}
```

- [ ] **Step 1: 写失败测试**

```ts
// server/providers/claude/steering.test.ts
import { describe, expect, it, vi } from 'vitest'
import { SupplementSession, formatSupplementInstruction } from './steering.js'

const open = (s: SupplementSession) => s.notePromptConsumed()

describe('SupplementSession admission', () => {
  it('rejects enqueue before any prompt is consumed and after an empty Stop', () => {
    const s = new SupplementSession(vi.fn())
    expect(s.enqueue({ uuid: 'a', text: 'x' })).toBe(false)   // 初始 closed
    open(s)
    expect(s.enqueue({ uuid: 'a', text: 'x' })).toBe(true)
    expect(s.handleBoundary('Stop', {})).toEqual({})           // 空 Stop
    expect(s.enqueue({ uuid: 'b', text: 'y' })).toBe(false)    // 已关
    open(s)                                                     // 下一轮 prompt 读取重开
    expect(s.enqueue({ uuid: 'b', text: 'y' })).toBe(true)
  })
  it('empty Stop closes admission but a Stop WITH pending keeps it open', () => {
    const s = new SupplementSession(vi.fn())
    open(s); s.enqueue({ uuid: 'a', text: 'x' })
    expect(s.handleBoundary('Stop', {})).toEqual({ decision: 'block', reason: expect.stringContaining('x') })
    expect(s.enqueue({ uuid: 'b', text: 'y' })).toBe(true)     // block 续跑 → 保持开
  })
})

describe('SupplementSession delivery', () => {
  it('PreToolUse drains all pending as one additionalContext and fires onDelivered', () => {
    const onDelivered = vi.fn()
    const s = new SupplementSession(onDelivered)
    open(s); s.enqueue({ uuid: 'a', text: 'one' }); s.enqueue({ uuid: 'b', text: 'two' })
    const out = s.handleBoundary('PreToolUse', {})
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('one\n\ntwo') },
    })
    expect(onDelivered).toHaveBeenCalledWith('a', { ok: true, boundary: 'PreToolUse' })
    expect(onDelivered).toHaveBeenCalledWith('b', { ok: true, boundary: 'PreToolUse' })
    expect(s.drainUndelivered()).toEqual([])                    // 已清空
  })
  it('ignores subagent-inherited hooks: agent_id set → {} and pending preserved', () => {
    const onDelivered = vi.fn()
    const s = new SupplementSession(onDelivered)
    open(s); s.enqueue({ uuid: 'a', text: 'one' })
    expect(s.handleBoundary('PreToolUse', { agent_id: 'agent-1' })).toEqual({})
    expect(onDelivered).not.toHaveBeenCalled()
    expect(s.drainUndelivered()).toEqual([{ uuid: 'a' }])       // pending 未动
  })
  it('drainUndelivered returns and clears; abort reports aborted outcome', () => {
    const onDelivered = vi.fn()
    const s = new SupplementSession(onDelivered)
    open(s); s.enqueue({ uuid: 'a', text: 'one' })
    expect(s.drainUndelivered()).toEqual([{ uuid: 'a' }])
    s.enqueue({ uuid: 'b', text: 'two' })
    s.abort()
    expect(onDelivered).toHaveBeenCalledWith('b', { ok: false, reason: 'aborted' })
  })
})

describe('formatSupplementInstruction', () => {
  it('wraps user text with the four guidance rules', () => {
    const out = formatSupplementInstruction('use python not bash')
    expect(out).toContain('[ADDITIONAL GUIDANCE]')
    expect(out).toContain('use python not bash')
    expect(out).toContain('Preserve and complete the original objective.')
    expect(out).toContain('Do not send a separate acknowledgement.')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run server/providers/claude/steering.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现 `server/providers/claude/steering.ts`**

```ts
// Mid-run steering 状态机（spec §5）。multica claudeSupplementSession 的进程内移植：
// 去掉阻塞语义（hook 回调即投递点），admission 以 onInputConsumed 开、Stop-空 关。
export type SteerBoundary = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop'
export type SupplementOutcome = { ok: true; boundary: SteerBoundary } | { ok: false; reason: 'aborted' }
export interface SteerEntryInput { uuid: string; text: string }

export function formatSupplementInstruction(text: string): string {
  return `[ADDITIONAL GUIDANCE] The user sent a message while you were working.

Treat this as additional guidance for the same active task, not as a replacement:
- Preserve and complete the original objective.
- Incorporate this guidance into the work and the turn's single final response.
- Do not send a separate acknowledgement.
- Replace or cancel the original objective only if the user explicitly asks.

User message:
${text}`
}

interface PendingEntry extends SteerEntryInput {}

export class SupplementSession {
  private admissionOpen = false
  private pending: PendingEntry[] = []
  constructor(private readonly onDelivered: (uuid: string, outcome: SupplementOutcome) => void) {}

  notePromptConsumed(): void { this.admissionOpen = true }

  enqueue(entry: SteerEntryInput): boolean {
    if (!this.admissionOpen) return false
    this.pending.push(entry)
    return true
  }

  handleBoundary(event: SteerBoundary, input: { agent_id?: string }): Record<string, unknown> {
    // hooks 注册被子代理继承：主线程消息绝不能被侧链消费（spec §5.2 规则 1）
    if (input.agent_id) return {}
    const delivering = this.pending
    this.pending = []
    if (event === 'Stop' && delivering.length === 0) {
      this.admissionOpen = false      // 空 Stop = turn 正在结束，准入关闭（spec §5.1）
      return {}
    }
    if (delivering.length === 0) return {}
    const wrapped = formatSupplementInstruction(delivering.map((e) => e.text).join('\n\n'))
    const outcome: SupplementOutcome = { ok: true, boundary: event }
    for (const e of delivering) this.onDelivered(e.uuid, outcome)
    if (event === 'Stop') return { decision: 'block', reason: wrapped }
    return { hookSpecificOutput: { hookEventName: event, additionalContext: wrapped } }
  }

  drainUndelivered(): Array<{ uuid: string }> {
    const out = this.pending.map((e) => ({ uuid: e.uuid }))
    this.pending = []
    return out
  }

  abort(): void {
    const leftovers = this.pending
    this.pending = []
    this.admissionOpen = false
    for (const e of leftovers) this.onDelivered(e.uuid, { ok: false, reason: 'aborted' })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**：`npx vitest run server/providers/claude/steering.test.ts` → PASS
- [ ] **Step 5: 提交**

```bash
git add server/providers/claude/steering.ts server/providers/claude/steering.test.ts
git commit -m "feat(steering): add SupplementSession state machine (admission, boundaries, subagent filter)"
```

---

### Task 3: inprocess-hooks 合并 steering

**Files:**
- Modify: `server/providers/claude/inprocess-hooks.ts`
- Test: `server/providers/claude/inprocess-hooks.test.ts`（已有则扩展；无则新建）

**Interfaces:**
- Consumes: `SupplementSession` / `SteerBoundary`（Task 2）
- Produces: `buildInProcessHooks(forward?, onTaskSnapshot?, onSubagentStop?, steering?)` — 第 4 参数；返回的 hooks 对象在 `steering` 存在时多出 `PreToolUse`/`PostToolUse`/`PostToolUseFailure` 三个 matcher，且 `Stop` matcher 的回调在 pending 非空时返回 `{decision:'block', reason}`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 server/providers/claude/inprocess-hooks.test.ts
import { SupplementSession } from './steering.js'

describe('buildInProcessHooks with steering', () => {
  const mkSteering = (): SupplementSession => {
    const s = new SupplementSession(vi.fn())
    s.notePromptConsumed()
    return s
  }
  it('registers Pre/PostToolUse(+Failure) matchers and merges Stop decision into the existing callback', () => {
    const steering = mkSteering()
    const forward = vi.fn()
    const hooks = buildInProcessHooks(forward, undefined, undefined, steering)
    expect(Object.keys(hooks)).toEqual(expect.arrayContaining(['Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']))
    const stopCb = hooks.Stop![0]!.hooks[0]!
    // 空 pending：返回 undefined（现状不变），且 run-log forward 照常触发
    void stopCb({ session_id: 's1' }, undefined, {})
    expect(forward).toHaveBeenCalledWith('s1', expect.objectContaining({ kind: 'completed' }))
    // 有 pending：返回 decision block，快照逻辑依然执行（forward 再次触发）
    steering.enqueue({ uuid: 'u1', text: 'pivot' })
    const out = stopCb({ session_id: 's1' }, undefined, {})
    expect(out).toEqual({ decision: 'block', reason: expect.stringContaining('pivot') })
    expect(forward).toHaveBeenCalledTimes(2)
  })
  it('PreToolUse matcher returns additionalContext when pending, undefined otherwise', async () => {
    const steering = mkSteering()
    const hooks = buildInProcessHooks(undefined, undefined, undefined, steering)
    const cb = hooks.PreToolUse![0]!.hooks[0]!
    expect(await cb({}, undefined, {})).toBeUndefined()
    steering.enqueue({ uuid: 'u1', text: 'go' })
    expect(await cb({}, undefined, {})).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('go') },
    })
  })
  it('subagent agent_id returns undefined and leaves pending intact', async () => {
    const steering = mkSteering()
    steering.enqueue({ uuid: 'u1', text: 'go' })
    const hooks = buildInProcessHooks(undefined, undefined, undefined, steering)
    const cb = hooks.PreToolUse![0]!.hooks[0]!
    expect(await cb({ agent_id: 'agent-9' }, undefined, {})).toBeUndefined()
    expect(steering.drainUndelivered()).toEqual([{ uuid: 'u1' }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run server/providers/claude/inprocess-hooks.test.ts`
- [ ] **Step 3: 实现**。`inprocess-hooks.ts` 改动：

```ts
import type { SupplementSession, SteerBoundary } from './steering.js'

/** steering 边界回调：透传 handleBoundary 的返回值（agent_id 已在状态机内过滤）。 */
function boundaryHook(event: SteerBoundary, steering: SupplementSession) {
  return async (input: unknown, _toolUseID?: string, deps?: { signal?: AbortSignal }): Promise<unknown> => {
    if (deps?.signal?.aborted) return undefined
    const agentId = (input as { agent_id?: string } | null | undefined)?.agent_id
    return steering.handleBoundary(event, { agent_id: agentId })
  }
}
```

`buildStop` 改造：接受 `steering?: SupplementSession`，回调末尾（快照/运行日志逻辑之后）加：

```ts
const steerOut = steering ? steering.handleBoundary('Stop', { agent_id: (input as { agent_id?: string }).agent_id }) : {}
return Object.keys(steerOut).length > 0 ? steerOut : undefined
```

（`defensiveHook` 包装的现有 Stop 回调返回 void——本 task 把 Stop 回调从 `defensiveHook(buildStop(...))` 改为显式 async 回调：快照逻辑放 try/catch（保持 defensiveHook 的吞异常语义），返回值透传 steering 输出。）

`buildInProcessHooks` 签名加第 4 参，返回值追加：

```ts
...(steering ? {
  PreToolUse: [{ hooks: [boundaryHook('PreToolUse', steering)] }],
  PostToolUse: [{ hooks: [boundaryHook('PostToolUse', steering)] }],
  PostToolUseFailure: [{ hooks: [boundaryHook('PostToolUseFailure', steering)] }],
} : {}),
```

- [ ] **Step 4: 跑全部 inprocess-hooks 测试**（含原有用例不回归）：`npx vitest run server/providers/claude/inprocess-hooks.test.ts` → PASS
- [ ] **Step 5: 提交**：`git add -u && git commit -m "feat(steering): merge steering drain into in-process Stop hook and add boundary matchers"`

---

### Task 4: Handle 成员 + 能力位 + spawn 接线

**Files:**
- Modify: `server/providers/types.ts`（CreateSessionOptions / ProviderSessionHandle / ProviderCapabilities）
- Modify: `server/providers/claude/claude-session.ts`
- Modify: `server/providers/claude/claude-provider.ts`
- Test: `server/providers/claude/claude-provider-steering.test.ts`

**Interfaces:**
- Consumes: `SupplementSession`（Task 2）、`buildInProcessHooks` 第 4 参（Task 3）
- Produces（Task 6/7/8/9 依赖）:

```ts
// providers/types.ts 新增：
// CreateSessionOptions:
onSupplementDelivered?: (uuid: string, outcome: SupplementOutcome) => void
// ProviderSessionHandle（可选成员）:
enqueueSupplement?(entry: { uuid: string; text: string }): boolean
drainSupplements?(): Array<{ uuid: string }>
// ProviderCapabilities:
supportsSteering: boolean
// claude-provider.ts 新增导出（纯函数，测试用）：
export function cliSupportsSteeringVersion(version: string | undefined): boolean  // ≥ 2.1.110
```

- [ ] **Step 1: 写失败测试**

```ts
// server/providers/claude/claude-provider-steering.test.ts
import { describe, expect, it } from 'vitest'
import { cliSupportsSteeringVersion } from './claude-provider.js'

describe('cliSupportsSteeringVersion', () => {
  it('accepts 2.1.110 and newer, rejects older/unparsable', () => {
    expect(cliSupportsSteeringVersion('2.1.110')).toBe(true)
    expect(cliSupportsSteeringVersion('2.1.296 (Claude Code)')).toBe(true)
    expect(cliSupportsSteeringVersion('2.2.0')).toBe(true)
    expect(cliSupportsSteeringVersion('2.1.109')).toBe(false)
    expect(cliSupportsSteeringVersion('1.0.0')).toBe(false)
    expect(cliSupportsSteeringVersion(undefined)).toBe(false)
    expect(cliSupportsSteeringVersion('garbage')).toBe(false)
  })
})
```

- [ ] **Step 2: 确认失败**：`npx vitest run server/providers/claude/claude-provider-steering.test.ts`
- [ ] **Step 3: 实现**

`claude-provider.ts`（模式照抄 `cliSupportsInitializePluginDelivery`，但为纯函数便于测试）：

```ts
export function cliSupportsSteeringVersion(version: string | undefined): boolean {
  if (!version) return false
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) return false
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return maj > 2 || (maj === 2 && (min > 1 || (min === 1 && pat >= 110)))
}
```

`capabilities` 对象加 `supportsSteering: true`（claude provider 静态声明；版本探测在 createSession 决定是否注册 hooks——能力位语义：本 provider 实现了该机制；旧 CLI 的退化由 hooks 不注册 + `enqueueSupplement` 恒 false 实现）。

`createSession` 内（`const input = createPushable<AgentUserMessage>(...)` 处改造）：

```ts
const steeringOn = cliSupportsSteeringVersion(cachedClaudeHealth()?.version)
const supplementSession = steeringOn
  ? new SupplementSession((uuid, outcome) => opts.onSupplementDelivered?.(uuid, outcome))
  : undefined
const input = createPushable<AgentUserMessage>(
  'input-' + opts.id.slice(0, 8),
  INPUT_QUEUE_MAX_DEPTH,
  (m) => {
    supplementSession?.notePromptConsumed()   // SDK 读走 prompt = 新 turn，admission 开
    opts.onUserMessageConsumed?.(m)
  },
)
```

hooks 组装处（现有 `if (opts.inProcessHookForward || ...)`）改为同时考虑 steering：

```ts
if (opts.inProcessHookForward || opts.inProcessTaskSnapshot || opts.inProcessSubagentStop || supplementSession) {
  sdkOptions.hooks = buildInProcessHooks(
    opts.inProcessHookForward, opts.inProcessTaskSnapshot, opts.inProcessSubagentStop,
    supplementSession ?? undefined,
  ) as Options['hooks']
}
```

`claude-session.ts`：构造函数加 `private readonly supplement?: SupplementSession`，实现成员：

```ts
enqueueSupplement(entry: { uuid: string; text: string }): boolean {
  return this.supplement?.enqueue(entry) ?? false
}
drainSupplements(): Array<{ uuid: string }> {
  return this.supplement?.drainUndelivered() ?? []
}
```

`destroy()` 内加 `this.supplement?.abort()`；`providers/types.ts` 按 Interfaces 块加三个声明（`SupplementOutcome` 类型从 steering.ts re-export 或在 types.ts 定义结构等价类型）。

- [ ] **Step 4: 确认通过 + 既有 provider 测试不回归**：`npx vitest run server/providers/claude/` → PASS
- [ ] **Step 5: 提交**：`git add -u server/providers && git commit -m "feat(steering): expose enqueueSupplement/drainSupplements on the claude handle with CLI version gate"`

---

### Task 5: SteeredStore sidecar + splice 纯函数

**Files:**
- Create: `server/steered-store.ts`
- Test: `server/steered-store.test.ts`

**Interfaces:**
- Consumes: `PerSessionSidecar`（`server/per-session-sidecar.ts`，构造 `{dir, label}`，`load/update/remove/revive`）
- Produces（Task 6/8/9/10 依赖）:

```ts
export interface SteeredEntry {
  u: string; text: string; steeredAt: number
  injectedAt?: number; requeuedAt?: number; withdrawnAt?: number
}
export class SteeredStore {
  constructor(stateDir: string | undefined, historyCap: number)
  record(sessionId: string, entry: SteeredEntry): Promise<void>
  markInjected(sessionId: string, u: string, at: number): Promise<void>
  markRequeued(sessionId: string, u: string, at: number): Promise<void>
  markWithdrawn(sessionId: string, u: string, at: number): Promise<void>
  load(sessionId: string): Promise<SteeredEntry[] | null>
  remove(sessionId: string): Promise<void>
  revive(sessionId: string): void
}
/** 把 sidecar 条目按时间戳拼进磁盘页（spec §8.2）。纯函数。 */
export function spliceSteeredIntoPage(page: HistoryPage, entries: SteeredEntry[]): HistoryPage
```

- [ ] **Step 1: 写失败测试**（store 部分镜像 `server/prompt-uuid-store` 的测试形态，用临时目录；splice 部分用假页）：

```ts
// server/steered-store.test.ts 核心用例（store 的读写/标记/容量照 prompt-uuid-store.test 模式，略写）
describe('spliceSteeredIntoPage', () => {
  const msg = (uuid: string, ts: string) => ({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: uuid } })
  const page = (messages: unknown[]): HistoryPage => ({ messages, totalCount: messages.length, startIndex: 0, hasMore: false })
  const E = (u: string, steeredAt: number, extra: Partial<SteeredEntry> = {}): SteeredEntry =>
    ({ u, text: `text-${u}`, steeredAt, ...extra })

  it('inserts an injected entry between disk messages by timestamp', () => {
    const p = page([msg('d1', '2026-10-14T10:00:00Z'), msg('d2', '2026-10-14T11:00:00Z')])
    const out = spliceSteeredIntoPage(p, [E('s1', Date.parse('2026-10-14T10:30:00Z'), { injectedAt: 1 })])
    expect(out.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['d1', 's1', 'd2'])
    expect(out.totalCount).toBe(3)
    const inserted = out.messages[1] as Record<string, unknown>
    expect(inserted).toMatchObject({ type: 'user', parent_tool_use_id: null, steeredAt: expect.any(Number), injectedAt: 1 })
  })
  it('skips requeued and withdrawn entries (JSONL owns requeued)', () => {
    const p = page([msg('d1', '2026-10-14T10:00:00Z')])
    const out = spliceSteeredIntoPage(p, [
      E('r1', Date.parse('2026-10-14T10:30:00Z'), { requeuedAt: 2 }),
      E('w1', Date.parse('2026-10-14T10:40:00Z'), { withdrawnAt: 3 }),
      E('s1', Date.parse('2026-10-14T10:50:00Z'), { injectedAt: 4 }),
    ])
    expect(out.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['d1', 's1'])
  })
  it('skips entries newer than the page start (insertion index 0)', () => {
    const p = page([msg('d1', '2026-10-14T10:00:00Z')])
    const out = spliceSteeredIntoPage(p, [E('s1', Date.parse('2026-10-14T10:30:00Z'))])
    expect(out.messages).toHaveLength(1)   // 比 d1 新 → 属于更新的内容（ring/新页）
  })
  it('appends entries older than every page message (closes the inter-page gap)', () => {
    const p = page([msg('d1', '2026-10-14T10:00:00Z')])
    const out = spliceSteeredIntoPage(p, [E('s0', Date.parse('2026-10-14T09:00:00Z'), { injectedAt: 1 })])
    expect(out.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['s0', 'd1'])
  })
  it('leaves the page untouched when no disk message carries a timestamp', () => {
    const p = page([{ type: 'user', uuid: 'd1', message: { role: 'user', content: 'x' } }])
    expect(spliceSteeredIntoPage(p, [E('s1', 1)])).toBe(p)
  })
})
```

- [ ] **Step 2: 确认失败**：`npx vitest run server/steered-store.test.ts`
- [ ] **Step 3: 实现**。Store 用 `PerSessionSidecar<SteeredEntry>`（dir=`<stateDir>/steered`，cap 逻辑：`update` 时保留最新 `historyCap` 条）。`spliceSteeredIntoPage` 规则（spec §8.2 + 上面测试）：

```ts
export function spliceSteeredIntoPage(page: HistoryPage, entries: SteeredEntry[]): HistoryPage {
  const tsOf = (m: unknown): number | null => {
    const t = (m as { timestamp?: unknown }).timestamp
    return typeof t === 'string' ? Date.parse(t) : typeof t === 'number' ? t : null
  }
  const stamps = page.messages.map(tsOf)
  if (!stamps.some((t) => t != null)) return page            // 无时间戳无法定序，整体跳过
  const usable = entries.filter((e) => e.requeuedAt == null && e.withdrawnAt == null)  // 去重规则（spec §8.2）
  if (usable.length === 0) return page
  const out = [...page.messages]
  let inserted = 0
  for (const e of usable) {
    let idx = out.length
    for (let i = 0; i < out.length; i++) {
      const t = tsOf(out[i]); if (t == null) continue
      if (t > e.steeredAt) { idx = i; break }
    }
    if (idx === 0) continue                                   // 比页首还新 → 属于更新的内容
    out.splice(idx, 0, synthesizeSteeredMessage(e))
    inserted++
  }
  if (inserted === 0) return page
  return { ...page, messages: out, totalCount: page.totalCount + inserted }
}

function synthesizeSteeredMessage(e: SteeredEntry): Record<string, unknown> {
  return {
    type: 'user', parent_tool_use_id: null, uuid: e.u,
    message: { role: 'user', content: e.text },
    receivedAt: e.steeredAt, steeredAt: e.steeredAt,
    ...(e.injectedAt != null ? { injectedAt: e.injectedAt } : {}),
  }
}
```

- [ ] **Step 4: 确认通过**：`npx vitest run server/steered-store.test.ts`
- [ ] **Step 5: 提交**：`git add server/steered-store.ts server/steered-store.test.ts && git commit -m "feat(steering): steered-message sidecar store and history-page splice"`

---

### Task 6: Manager 路由（dispatchUserMessage）

**Files:**
- Modify: `server/session-types.ts`（Session 加 `steeredInFlight`）
- Modify: `server/history-utils.ts`（加 `stampSteeredAt`）
- Modify: `server/session-manager.ts`（构造 Session 的两处初始化 + `dispatchUserMessage` 路由 + snapshot anchor 跳过）
- Test: `server/session-manager-steering.test.ts`

**Interfaces:**
- Consumes: handle 的 `enqueueSupplement?`（Task 4）、`SteeredStore.record`（Task 5）
- Produces: `trySteerMessage(s, userMsg): boolean`（私有）；`stampSteeredAt(msg): void`；`Session.steeredInFlight: Map<string, SDKUserMessage>`；`isSteerableUserText(msg): boolean`（导出纯函数供测试）

- [ ] **Step 1: 写失败测试**（用现有 session-manager 测试的 fixture 形态；`server/session-manager*.test.ts` 已有多套可参照——找最近的一个文件头 import 抄环境搭建）：

```ts
// 核心用例（isSteerableUserText 纯函数部分）
describe('isSteerableUserText', () => {
  it('accepts string content and text-only block arrays; rejects images', () => {
    expect(isSteerableUserText({ type: 'user', message: { role: 'user', content: 'hi' } })).toBe(true)
    expect(isSteerableUserText({ type: 'user', message: { role: 'user', content: [
      { type: 'text', text: 'a' }, { type: 'text', text: 'b' },
    ] } })).toBe(true)
    expect(isSteerableUserText({ type: 'user', message: { role: 'user', content: [
      { type: 'text', text: 'a' }, { type: 'image', source: {} },
    ] } })).toBe(false)
  })
})
// 路由矩阵部分：本 task 建立文件级 fixture helper `makeSteeringSession()`（mock handle，
// enqueueSupplement 可控返回 + steeredStore mock + msgstat 帧收集器）——Task 7/8/9 直接扩展它。
// 用例：mock handle（enqueueSupplement 返回 true/false）+ 手动置 pendingTurns/turnActive，
// 断言 steered 路径：steeredAt 已戳、history 含消息、handle.enqueueUserMessage 未被调、
// promptUuids 无该 uuid；非 steered 路径全部照旧。
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**

`history-utils.ts`（镜像 `stampConsumedAt`）：

```ts
/** 该用户消息走了 mid-turn steering 路径（注入当前轮而非排队）。
 *  与 consumedAt 互斥：steered 消息永远没有 consumedAt，除非 turn 结束后被 requeue。 */
export function stampSteeredAt(msg: unknown): number {
  const m = msg as { steeredAt?: number }
  if (m && typeof m === 'object' && m.steeredAt == null) m.steeredAt = Date.now()
  return m.steeredAt ?? Date.now()
}
```

`session-types.ts` Session 加字段（含 docblock：manager 侧 uuid→ring 消息映射，requeue 时取原文，不依赖 ring 查找——防 500 条环形驱逐）：

```ts
/** In-flight steered messages (uuid -> ring message object). Populated by
 *  trySteerMessage; cleared on injected / requeued / withdrawn. Kept as a
 *  Map (not a ring scan) so the turn-end fallback survives ring eviction. */
steeredInFlight: Map<string, SDKUserMessage>
```

两处 Session 构造（grep `withdrawnUuids: []` 定位）各加 `steeredInFlight: new Map()`。

`session-manager.ts` `dispatchUserMessage` 头部插入路由：

```ts
private dispatchUserMessage(s: Session, userMsg: SDKUserMessage): void {
  if (s.lastPromptSuggestion != null) s.lastPromptSuggestion = undefined
  if (this.trySteerMessage(s, userMsg)) return
  // …原路径不动…
}

private trySteerMessage(s: Session, userMsg: SDKUserMessage): boolean {
  if (defaultConfig.steering === false) return false
  const cap = this.providerCapabilities?.(s)   // 对齐现有能力查询先例（requireHandleMethod 的能力来源）
  if (!cap?.supportsSteering) return false
  if (!isSteerableUserText(userMsg)) return false
  if (!(s.pendingTurns > 0 || s.turnActive === true)) return false
  const handle = s.handle as ProviderSessionHandle
  if (!handle.enqueueSupplement) return false
  const text = userTextOf(userMsg)             // string 或拼接 text blocks
  if (!handle.enqueueSupplement({ uuid: userMsg.uuid, text })) return false
  const steeredAt = stampSteeredAt(userMsg)
  s.steeredInFlight.set(userMsg.uuid, userMsg)
  void this.steeredStore.record(s.id, { u: userMsg.uuid, text, steeredAt })
  this.pushToSession(s, userMsg)               // 广播 + ring；不 enqueueUserMessage、不 recordPromptUuid
  return true
}
```

（`providerCapabilities` 的具体调用形态对齐仓库现有能力查询写法——grep `requireHandleMethod` 的实现抄同一来源；`SteeredStore` 实例在 Session-manager 构造函数里随其他 store 一起建。）

snapshot anchor 跳过：定位 send/sendContent 的 anchor 记录辅助函数（session-manager.ts ~3194-3215），开头加 `if (typeof (userMsg as { steeredAt?: number }).steeredAt === 'number') return`——steered 消息不建 rewind anchor。

- [ ] **Step 4: 确认通过 + 既有 session-manager 测试不回归**：`npx vitest run server/session-manager` → PASS
- [ ] **Step 5: 提交**：`git add -u server && git commit -m "feat(steering): route mid-turn plain-text sends into the supplement queue"`

---

### Task 7: message-steered 帧 + 投递确认

**Files:**
- Modify: `shared/ws-protocol.ts`（`WsMessagesWithdrawn` 之后加 `WsMessageSteered`）
- Modify: `src/ws-types.ts`（绑定）
- Modify: `server/history-utils.ts`（`stampInjectedAt`）
- Modify: `server/session-manager.ts`（spawn 时传 `onSupplementDelivered`）
- Test: `server/session-manager-steering.test.ts`（追加）

**Interfaces:**
- Consumes: `CreateSessionOptions.onSupplementDelivered`（Task 4）、`pushMessageStatus`（现有）
- Produces: `WsMessageSteered { kind:'message-steered'; sessionId; uuid; state:'injected'|'requeued' }`

- [ ] **Step 1: 写失败测试**：steered 消息投递回调触发后——ring 条目带 `injectedAt`、`steeredInFlight` 清项、`message-steered` 帧推到 msgstat 订阅者、sidecar `markInjected` 被调（mock store 断言）
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**

`shared/ws-protocol.ts`：

```ts
/** 一条 steered 消息的投递状态迁移（spec §7）。'injecting' 不需要帧——初始
 *  广播上的 steeredAt 戳就是它；durable 半边是 ring 条目的 injectedAt/requeuedAt。 */
export interface WsMessageSteered {
  kind: 'message-steered'
  sessionId: string
  uuid: string
  state: 'injected' | 'requeued'
}
```

（并把新 interface 加进服务端帧联合——`server/ws-protocol.ts` 与 `src/ws-types.ts` 的实例化别名各补一处，模式照 `WsMessagesWithdrawn`。）

`history-utils.ts`：

```ts
export function stampInjectedAt(msg: unknown, at?: number): number {
  const m = msg as { injectedAt?: number }
  if (m && typeof m === 'object' && m.injectedAt == null) m.injectedAt = at ?? Date.now()
  return m.injectedAt ?? at ?? Date.now()
}
```

`session-manager.ts`：spawn 选项组装处（现有 `onUserMessageConsumed` 传递点，grep 定位）加：

```ts
onSupplementDelivered: (uuid, outcome) => {
  if (!outcome.ok) return                     // aborted：条目由 drain/abort 路径处理
  const s = this.sessions.get(id)
  if (!s) return
  const ringEntry = findHistoryEntryByUuid(s.history, uuid)   // 现有按 uuid 查 ring 的辅助（grep onInputConsumed 的扫描逻辑复用）
  if (ringEntry) stampInjectedAt(ringEntry)
  s.steeredInFlight.delete(uuid)
  void this.steeredStore.markInjected(s.id, uuid, Date.now())
  this.pushMessageStatus(id, { kind: 'message-steered', sessionId: id, uuid, state: 'injected' })
},
```

- [ ] **Step 4: 确认通过**；`npm run typecheck`（两个 tsconfig 都过——shared 改动会同时进两套）
- [ ] **Step 5: 提交**：`git add -u shared server src && git commit -m "feat(steering): message-steered frame and injected-delivery handler"`

---

### Task 8: Turn 结束 fallback（requeue + promptUuids 补录）

**Files:**
- Modify: `server/session-pump.ts`（result 处理器加 pump dep 回调）
- Modify: `server/session-manager.ts`（实现 `drainAndRequeueSteered` 并作为 dep 传入）
- Test: `server/session-manager-steering.test.ts`（追加）

**Interfaces:**
- Consumes: `drainSupplements`（Task 4）、`stampRequeuedAt`（本 task 加到 history-utils）
- Produces: pump dep `onTurnSettling?: (session: Session) => void`（result 处理器在 pendingTurns 归零分支**之前**调用）

- [ ] **Step 1: 写失败测试**（mock handle + 手动构造 in-flight 状态；fixture 形态抄本文件里 Task 6 已建立的测试环境）：

```ts
describe('turn-end steer fallback', () => {
  it('requeues undelivered supplements with prompt-uuid backfill and requeued frame', async () => {
    const { sm, s, handle, store, msgstat } = await makeSteeringSession()   // Task 6 的 fixture helper
    const userMsg = mkUserMsg('u1', 'pivot now')
    stampSteeredAt(userMsg)
    s.steeredInFlight.set('u1', userMsg)
    handle.drainSupplements.mockReturnValue([{ uuid: 'u1' }])
    handle.enqueueUserMessage.mockClear()

    sm['drainAndRequeueSteered'](s)                       // pump 的 onTurnSettling 最终调到这里

    expect(handle.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'u1' }))
    expect(userMsg.requeuedAt).toEqual(expect.any(Number))
    expect(s.promptUuids).toEqual([{ u: 'u1' }])          // 【补录】此刻才进 FIFO 配对
    expect(store.markRequeued).toHaveBeenCalledWith(s.id, 'u1', expect.any(Number))
    expect(msgstat.frames).toContainEqual({ kind: 'message-steered', sessionId: s.id, uuid: 'u1', state: 'requeued' })
    expect(s.steeredInFlight.size).toBe(0)
  })
  it('leaves delivered entries alone (drain returns empty → no-op)', async () => {
    const { sm, s, handle } = await makeSteeringSession()
    handle.drainSupplements.mockReturnValue([])
    sm['drainAndRequeueSteered'](s)
    expect(handle.enqueueUserMessage).not.toHaveBeenCalled()
  })
})
```

（`makeSteeringSession` / `seedSteeredPending` 是本测试文件的局部 fixture helper：Task 6/7 建立基础环境时引入 `makeSteeringSession`（mock handle + steeredStore + msgstat 帧收集器），本 task 不重复定义、直接扩展；`seedSteeredPending` 由本 task 引入。）
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**

`history-utils.ts`：

```ts
export function stampRequeuedAt(msg: unknown, at?: number): number {
  const m = msg as { requeuedAt?: number }
  if (m && typeof m === 'object' && m.requeuedAt == null) m.requeuedAt = at ?? Date.now()
  return m.requeuedAt ?? at ?? Date.now()
}
```

`session-pump.ts`：result 处理器定位（grep `msg.type === 'result'`，~1402-1470），在 pendingTurns 归零的分支前调用 `deps.onTurnSettling?.(session)`（deps 对象加可选字段；调用点在 `moreQueued` 检查之前，保证 requeue 后 queueDepth 检查能看到它们）。

`session-manager.ts`：

```ts
private drainAndRequeueSteered(s: Session): void {
  const handle = s.handle as ProviderSessionHandle
  if (!handle.drainSupplements) return
  const leftovers = handle.drainSupplements()
  for (const { uuid } of leftovers) {
    const userMsg = s.steeredInFlight.get(uuid)
    s.steeredInFlight.delete(uuid)
    if (!userMsg) continue
    const at = stampRequeuedAt(userMsg)
    handle.enqueueUserMessage({ ...userMsg })
    this.recordPromptUuid(s, userMsg)          // 【补录】requeue 后才会 echo
    void this.steeredStore.markRequeued(s.id, uuid, at)
    this.pushMessageStatus(s.id, { kind: 'message-steered', sessionId: s.id, uuid, state: 'requeued' })
  }
}
```

- [ ] **Step 4: 确认通过 + pump 既有测试不回归**：`npx vitest run server/session-pump` → PASS
- [ ] **Step 5: 提交**：`git add -u server && git commit -m "feat(steering): requeue undelivered supplements at turn end with prompt-uuid backfill"`

---

### Task 9: Interrupt 集成（先 drain，两态语义）

**Files:**
- Modify: `server/session-manager.ts`（`interrupt()`，~3394）
- Test: `server/session-manager-steering.test.ts`（追加）

**Interfaces:**
- Consumes: `drainSupplements`、`drainAndRequeueSteered`（Task 8）、现有 `withdrawHostQueue` / `removeFromHistory` / `withdrawnUuids` 机制
- Produces: 无新接口（行为扩展）

- [ ] **Step 1: 写失败测试**（两个用例；fixture 同 Task 8）：

```ts
describe('interrupt steer integration', () => {
  it('plain interrupt requeues steer pending (queued-message semantics)', async () => {
    const { sm, s, handle, msgstat } = await makeSteeringSession()
    seedSteeredPending(s, 'u1', 'pivot')                  // helper：steeredInFlight + drain mock 返回
    handle.enqueueUserMessage.mockClear()
    await sm.interrupt(s.id)                              // 无 cancelQueued
    expect(handle.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'u1' }))
    expect(msgstat.frames.filter((f) => f.kind === 'messages-withdrawn')).toHaveLength(0)
  })
  it('cancelQueued withdraws steer pending AFTER draining them, before the provider interrupt', async () => {
    const { sm, s, handle, msgstat, store } = await makeSteeringSession()
    seedSteeredPending(s, 'u1', 'pivot')
    const calls: string[] = []
    handle.drainSupplements.mockImplementation(() => { calls.push('drain'); return [{ uuid: 'u1' }] })
    handle.interrupt.mockImplementation(async () => { calls.push('provider-interrupt'); return undefined })
    await sm.interrupt(s.id, { cancelQueued: true })
    expect(calls).toEqual(['drain', 'provider-interrupt'])   // 顺序：先 drain（竞态对策）
    expect(msgstat.frames).toContainEqual({ kind: 'messages-withdrawn', sessionId: s.id, uuids: ['u1'] })
    expect(store.markWithdrawn).toHaveBeenCalledWith(s.id, 'u1', expect.any(Number))
    expect(s.steeredInFlight.size).toBe(0)
  })
})
```
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**。`interrupt()` 内、`withdrawHostQueue` 之前插入：

```ts
// Steer pending 先于一切：drain 清空后，interrupt 期间并发的 hook 边界只见空队列
// （multica writing-flag 串行化的进程内等价，spec §6.4）。
const steerLeftovers = (s.handle as ProviderSessionHandle).drainSupplements?.() ?? []
```

- plain 分支：`this.requeueSteeredLeftovers(s, steerLeftovers)`（从 Task 8 的 `drainAndRequeueSteered` 里抽出循环体为 `requeueSteeredLeftovers(s, leftovers)`，两处共用）
- cancelQueued 分支：steerLeftovers 的 uuid 并入现有 `uuids` 集合的构造（`for (const { uuid } of steerLeftovers) uuids.add(uuid)`——在 `stillUnpaired` 过滤**之外**直接加：steered 消息本就不在 promptUuids 里），并在集合非空后的现有块里补：

```ts
for (const { uuid } of steerLeftovers) {
  s.steeredInFlight.delete(uuid)
  void this.steeredStore.markWithdrawn(s.id, uuid, Date.now())
}
```

（ring 移除、withdrawnUuids、`messages-withdrawn` 广播复用现有 `uuids` 集合路径，无需另写。）

- [ ] **Step 4: 确认通过 + 既有 interrupt 测试不回归**：`npx vitest run server/session-manager` → PASS
- [ ] **Step 5: 提交**：`git add -u server && git commit -m "feat(steering): drain steer pending on interrupt — requeue on plain stop, withdraw on cancelQueued"`

---

### Task 10: History 页拼接集成

**Files:**
- Modify: `server/session-manager.ts`（`getHistoryPage`，~6455）
- Test: `server/session-manager-steering.test.ts`（追加）

**Interfaces:**
- Consumes: `SteeredStore.load`、`spliceSteeredIntoPage`（Task 5）
- Produces: 无新接口

- [ ] **Step 1: 写失败测试**：mock provider 返回带 timestamp 的磁盘页 + steeredStore 有 injected 条目 → `getHistoryPage` 返回的 messages 含合成条目且位置正确；requeued 条目不出现
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**。`getHistoryPage` 取得 page 后：

```ts
if (this.steeredStore) {
  const steered = await this.steeredStore.load(id)
  if (steered && steered.length > 0) page = spliceSteeredIntoPage(page, steered)
}
```

（session 删除路径同步 `steeredStore.remove(id)`——grep `promptUuidStore.remove` 的调用点，同处加一行；`revive` 同理。）

- [ ] **Step 4: 确认通过**；`npm run typecheck`
- [ ] **Step 5: 提交**：`git add -u server && git commit -m "feat(steering): splice steered sidecar entries into disk history pages"`

---

### Task 11: Config 开关 + steeringSupported 暴露

**Files:**
- Modify: `server/config.ts`（`ServerConfig.steering: boolean`，默认 true；merge 白名单）
- Modify: `server/routes/config-routes.ts`（GET/PUT 暴露）
- Modify: `shared/session-info.ts`（`SessionInfo.steeringSupported?: boolean`）
- Modify: `server/session-manager.ts`（快照填充；Task 6 的 `defaultConfig.steering === false` 判断改读运行时可变值）
- Test: `server/config.test.ts`（追加）、`server/routes/config-routes.test.ts`（追加，如有）

**Interfaces:**
- Consumes: Task 6 的路由判断
- Produces: `GET /api/config` 响应含 `steering`；`SessionInfo.steeringSupported`

- [ ] **Step 1: 写失败测试**：config 默认 true；PUT `{"steering": false}` 后 GET 返回 false 且路由判断关闭
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（全部照 `maxOutputTokens` 的声明/merge/白名单三处先例，config.ts ~195/718/792）；session 快照填充照 `thinkingSupported` 先例（grep 其赋值点，能力来源 `providerCapabilities`）
- [ ] **Step 4: 确认通过 + typecheck**
- [ ] **Step 5: 提交**：`git add -u server shared && git commit -m "feat(steering): global config toggle and per-session capability exposure"`

---

### Task 12: 客户端 store（reducer + delivery status）

**Files:**
- Modify: `src/session-store/types.ts:667` 附近（action 联合加 `MESSAGE_STEERED`）
- Modify: `src/session-store/reducer.ts`（case + `applyMessageSteered`，模式照 `applyMessageConsumed`:1436）
- Modify: `src/session-store/normalize.ts:240`（`deriveDeliveryStatus` steered 分支）
- Modify: `src/hooks/useChatStream.ts:676` 附近（帧 → dispatch）
- Test: `src/session-store/reducer.test.ts` / `src/session-store/normalize` 相关测试文件（追加）

**Interfaces:**
- Consumes: `WsMessageSteered`（Task 7 的 `src/ws-types.ts` 绑定）
- Produces: `deriveDeliveryStatus` 返回 `'queued' | 'consumed' | 'injecting' | 'injected' | undefined`

- [ ] **Step 1: 写失败测试**

```ts
// reducer：MESSAGE_STEERED injected → 对应消息带 injectedAt；requeued → 带 requeuedAt
// normalize（核心分支，加在 consumedAt 检查之前）：
//   requeuedAt 存在 → 落回 queued/consumed 逻辑（steered 历史不参与状态）
//   injectedAt 存在 → 'injected'
//   steeredAt 存在 → 'injecting'
// countQueuedUserTurns：'injecting' 计入（Stop+cancelQueued 同样撤回它们）
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**

`normalize.ts` `deriveDeliveryStatus`（在 `if (typeof msg.consumedAt === 'number') return 'consumed'` **之前**插入）：

```ts
if (typeof (msg as { requeuedAt?: number }).requeuedAt !== 'number') {
  if (typeof (msg as { injectedAt?: number }).injectedAt === 'number') return 'injected'
  if (typeof (msg as { steeredAt?: number }).steeredAt === 'number') return 'injecting'
}
```

`types.ts`：`| { type: 'MESSAGE_STEERED'; uuid: string; state: 'injected' | 'requeued' }`
`reducer.ts`：`case 'MESSAGE_STEERED': return applyMessageSteered(state, action.uuid, action.state)`（实现照 `applyMessageConsumed` 的查找-打戳-不可变更新模式，injected → `injectedAt: Date.now()`，requeued → `requeuedAt: Date.now()`）。
`useChatStream.ts`（676 行 `message-consumed` 分发旁）：

```ts
else if (frame.kind === 'message-steered') {
  store.dispatch({ type: 'MESSAGE_STEERED', uuid: frame.uuid, state: frame.state })
}
```

（实际分支形态对齐该文件现有 frame 分发的写法。）

- [ ] **Step 4: 确认通过 + typecheck**
- [ ] **Step 5: 提交**：`git add -u src && git commit -m "feat(steering): client store — MESSAGE_STEERED action and injecting/injected delivery states"`

---

### Task 13: 客户端 UI（badge / chip / 设置开关）

**Files:**
- Modify: `src/components/Composer.tsx`（working 时注入预告 badge）
- Modify: `src/components/message-list/MessageView.tsx:118` 附近（deliveryStatus chip 扩展）
- Modify: `src/components/SettingsPanel.tsx`（steering 开关，读 `GET /api/config`）
- Test: `src/components/Composer.test.tsx`（追加）

**Interfaces:**
- Consumes: `deriveDeliveryStatus` 新状态（Task 12）、`SessionInfo.steeringSupported`、config `steering`
- Produces: 无

- [ ] **Step 1: 写失败测试**（Composer）：session working ∧ steeringSupported ∧ config.steering ∧ 无图片 → 渲染「将注入当前运行」提示；粘贴图片后提示切换为排队语义；config.steering=false → 无提示
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
  - Composer：props 已有 working/session 状态（`countQueuedUserTurns` 的现有消费方式）；badge 用现有 chip 类 + 主题变量，文案 `⚡ 将注入当前运行` / 含图时 `将排队至下一轮`
  - MessageView：deliveryStatus 为 `'injecting'` → chip 文案「注入中」；`'injected'` → 「已注入当前轮」（对齐现有 queued/consumed chip 的 DOM 结构与样式）。**orphan 规则（spec §8.3）**：`'injecting'` 的 chip 仅在 session working 时渲染——非 working（崩溃遗留的非终态条目）不显示任何注入态，渲染为普通已发送消息
  - SettingsPanel：照现有开关字段（grep 一个布尔设置项的写法）加「会话中转向」开关，PUT `/api/config` `{steering}`
- [ ] **Step 4: 确认通过 + `npm run test` 全量 + `npm run typecheck` + `npm run lint`**
- [ ] **Step 5: 提交**：`git add -u src && git commit -m "feat(steering): composer steering badge, injected status chip, and settings toggle"`

---

## 收尾（执行完成后）

1. `npm run test` + `npm run typecheck` + `npm run lint` 全绿
2. 全 diff 跑 code-review skill（CLAUDE.md 规矩：未过审不进 main）
3. 手工冒烟：真 session 里 mid-turn 发消息 → 观察注入 chip → Stop 撤回 → 老 CLI 退化（可选）
