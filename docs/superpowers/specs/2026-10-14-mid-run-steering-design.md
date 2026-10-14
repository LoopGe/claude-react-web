# Mid-run Steering 设计（SDK hooks 注入）

- 日期：2026-10-14
- 状态：对话中逐节评审通过，待 spec 审阅
- 来源：multica `claude_supplement.go` 模式移植 + 本仓库 SDK 0.3.296 能力验证

## 1. 背景与动机

现状：agent 工作期间用户发送的消息进入 Pushable 输入队列，等当前轮 `result` 落地后才作为下一轮 prompt 被 SDK 消费。用户无法在 agent 跑偏时即时纠偏——只能干等或 interrupt。

目标：mid-turn 的纯文本消息在下一个工具钩子边界注入当前轮（SDK hooks `additionalContext`）；turn 即将结束而仍有未投递消息时，以 Stop hook `decision: "block"` 续跑消化。已验证前提：

- SDK 0.3.296 捆绑 CLI 2.1.296，原生支持 `Options.hooks` 进程内回调（`HookCallback` 可返回 `additionalContext` 与 `decision: 'block'`）
- CLI 2.1.296 > multica 版本门控下限 2.1.110（该版修复 PreToolUse additionalContext 在工具失败时丢失）
- 本仓库已有 `inprocess-hooks.ts` 的 hook 注册管道（Stop/SubagentStop）与 probe-verified 行为记录

multica 在生产验证了该模式的全部边界（子代理继承、admission 关闭、取消竞态、版本门控、稳定失败码）。本设计将机制移植到 SDK 封装层：协议层由 SDK 吃掉，成本集中在集成语义（投递状态、磁盘回放、撤回）。

## 2. 已拍板的决策

| 决策点 | 选择 |
|---|---|
| mid-turn 默认路由 | **默认注入**（纯文本）；多模态自动 fallback 排队；composer 显示「将注入当前运行」 |
| v1 范围 | **完整集成**：投递状态 WS 帧、disk replay 一致性、interrupt 撤回、全局开关 |
| 架构 | **B'（multica 式切分）**：机制下沉 provider（steering 状态机、hook、admission），策略留在 manager（路由、广播、排除逻辑、撤回、回放拼接） |

## 3. 目标 / 非目标

**目标**

1. mid-turn 纯文本消息在下一个钩子边界被模型消化并影响当前轮行为
2. UI 如实呈现注入状态（注入中 → 已注入 / 已转为下一轮）
3. 不破坏现有语义：queued 消息流转、`promptUuids` FIFO 配对、rewind anchor、snapshot 捕获、disk replay、interrupt withdrawal
4. 零丢失：任何未被注入的消息最终要么转为下一轮 prompt，要么被用户显式撤回

**非目标（v1 明确不做）**

- 多模态注入（`additionalContext` 是 string；图片/混合内容一律排队）
- per-session steering 设置（只有全局 `config.json` 开关）
- `UserPromptSubmit` 安全网边界（turn-end fallback 覆盖同一竞态）
- 跨重启的 steer 恢复（崩溃遗留按「未送达」渲染）
- 已注入内容的撤回/编辑（注入即生效）

## 4. 架构总览

```
Client                    Manager (policy)                    Provider (mechanism)
──────                    ─────────────────                   ────────────────────
Composer ──POST /messages──┐
「将注入当前运行」badge     │ dispatchUserMessage:
                           │   开关 ∧ supportsSteering ∧ 纯文本 ∧ mid-turn
                           │        │ enqueueSupplement(entry)
                           │        ├──────────────────────────► steering.ts 状态机
                           │   pushToSession(广播+ring)             pending 缓冲 + admission
                           │   跳过: SDK输入队列 / promptUuids /      hook 回调（并入 buildStop）
                           │         rewind anchor / snapshot        agent_id 过滤
                           │        ▲                              block-on-Stop 投递
「注入中→已注入」chip       │ onSupplementDelivered(uuid, outcome)
◄──message-steered 帧──────┤   stamp injectedAt + 广播 + sidecar
```

**接口契约**（`ProviderSessionHandle` 新增成员；`ProviderCapabilities` 新增 `supportsSteering: boolean`）：

```ts
enqueueSupplement(entry: { uuid: string; text: string }): boolean
// false = 准入关闭（turn 正在结束/尚未开始），调用方透明回退排队路径

drainSupplements(): Array<{ uuid: string }>
// 取走全部未投递条目（turn-end fallback / interrupt 撤回用）；对称于现有 drainQueuedInput()

onSupplementDelivered?: (uuid: string, outcome: SupplementOutcome) => void
// manager 注入的事件回调（先例：createPushable 的 opts.onUserMessageConsumed）
// SupplementOutcome = { ok: true; boundary: 'PreToolUse'|'PostToolUse'|'PostToolUseFailure'|'Stop' }
//                  | { ok: false; reason: 'aborted' }
```

manager 对 hook 零感知——只认识 `enqueue` / `drain` / `delivered` 三个动词。CLI 特有细节（`agent_id` 过滤、`stop_hook_active`、hook 合并）全部封在 provider 内。

## 5. Provider 机制（`server/providers/claude/steering.ts`）

### 5.1 Admission 状态机

| 事件 | admission |
|---|---|
| handle 创建 | **closed** |
| `onInputConsumed`（SDK 从输入队列读走一条 prompt = 新 turn 开始） | **open** |
| Stop hook 且 pending 为空 | **close**（turn 正在结束；此窗口内 enqueue 返回 false，manager 回退排队——语义正确：turn 已经完了） |
| Stop hook 且 pending 非空 | 保持 open（`decision: 'block'` 续跑） |

> 设计修正记录：早先版本「任何非 Stop hook 事件都重开 admission」有一个漏洞——**不含工具调用的纯文本轮永远不重开**。改为以 `onInputConsumed`（prompt 被读取）为重开点，Stop-空为关闭点，两个方向都精确对应 turn 生命周期。

`enqueueSupplement` 在 closed 时返回 false。不阻塞、不等待——hook 回调本身就是投递点（这是对 multica 阻塞式 `Supplement()` 的进程内简化）。

### 5.2 投递边界与规则

注册事件：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `Stop`（不注册 `UserPromptSubmit`，见非目标）。

任何主线程边界触发时：

1. `input.agent_id` 非空 → 返回 `{}`。**hooks 注册会被子代理（Agent/Task/forked-Skill 侧链）继承**，主线程消息绝不能被侧链偷走（multica 行 183 的教训；SDK `BaseHookInput.agent_id`："Present only when the hook fires from within a subagent"）
2. pending 为空 → 返回 `{}`（Stop 同样——无 pending 不 block，turn 正常结束）
3. pending 非空 → drain 全部、`\n\n` 连接、套指令包装，逐条打 `deliveredAt` 并触发 `onSupplementDelivered`：
   - Pre/PostToolUse/PostToolUseFailure → `{ hookSpecificOutput: { hookEventName, additionalContext: 包装文本 } }`
   - Stop → `{ decision: 'block', reason: 包装文本 }`

### 5.3 与现有 Stop hook 的合并（关键）

同 matcher 多 hook 并行注册时 decision 输出的合并行为未定义（探针 3 一并验证）。因此**不并列注册第二个 Stop hook**，而是把 steering drain **并入现有 `buildStop`**：一个回调内先跑任务快照/运行日志逻辑（不变），再跑 steering drain，pending 非空时返回值从 `undefined` 变为 `{ decision: 'block', reason }`。`buildInProcessHooks` 增加一个 steering 参数，与现有三个参数同款模式。

### 5.4 指令包装（multica 提示词工程移植）

```
[ADDITIONAL GUIDANCE] The user sent a message while you were working.

Treat this as additional guidance for the same active task, not as a replacement:
- Preserve and complete the original objective.
- Incorporate this guidance into the work and the turn's single final response.
- Do not send a separate acknowledgement.
- Replace or cancel the original objective only if the user explicitly asks.

User message:
<text>
```

英文包装（模型读英文最稳），用户文本原样嵌入。四条规则防住三个模型行为陷阱：把补充当新任务、中断工作先回一句「收到」、擅自放弃原目标。

### 5.5 版本门控

`supportsSteering` 在 provider 层用 `cachedClaudeHealth()` 探测（同 `cliSupportsInitializePluginDelivery` 模式）：CLI ≥ 2.1.110 才为 true。能力位为 false 时不注册 steering hooks，`enqueueSupplement` 恒返回 false，feature 静默退化为纯排队，UI 不显示注入态。

## 6. Manager 策略

### 6.1 路由（`dispatchUserMessage` 开头）

```
steering 开(config) ∧ s.handle.supportsSteering ∧ 纯文本 ∧ mid-turn(s.pendingTurns > 0 ∨ s.turnActive)
  → enqueueSupplement({ uuid, text })
     接受：
       stampSteeredAt(userMsg)
       pushToSession(s, userMsg)              // 广播 + ring，客户端见「注入中」
       steeredInFlight.set(uuid, userMsg)     // manager 侧 uuid→消息映射（requeue 时取原文）
       steeredStore.record(...)               // sidecar 立即落盘
       【跳过】handle.enqueueUserMessage（不进 SDK 输入队列）
       【跳过】recordPromptUuid（永不 echo，进 FIFO 会永久卡配对）
       【跳过】snapshot anchor 捕获 / rewind（不改文件，无 anchor 语义）
     拒绝（admission closed）：落到原路径（排队）
  → 否则：原路径一字不改
```

「纯文本」定义：`message.content` 为 string，或为仅含 `{type:'text'}` block 的数组；含 image block → 不 steer。

### 6.2 投递确认

`onSupplementDelivered(uuid, {ok:true})` → ring 条目（按 uuid）打 `injectedAt` → 广播 `message-steered {uuid, state:'injected'}` → sidecar 更新 → `steeredInFlight.delete(uuid)`。

### 6.3 Turn 结束 fallback（零丢失的关键）

pump 的 result 处理器（`pendingTurns` 归零处）：

```
leftovers = s.handle.drainSupplements()
for each uuid:
  userMsg = steeredInFlight.get(uuid)
  handle.enqueueUserMessage({ ...userMsg })   // 原文转投 SDK 输入队列，下一轮正常消费
  ring 条目：steeredAt → requeuedAt           // 客户端回到正常 queued→consumed 流转
  广播 message-steered {uuid, state:'requeued'}
  recordPromptUuid(s, userMsg)                // 【易漏】现在才会 echo，必须补录进 FIFO 配对
  sidecar 更新（requeuedAt）
  steeredInFlight.delete(uuid)
```

### 6.4 Interrupt 语义（与现有按钮语义对齐）

| 操作 | steer pending 的命运 | 机制 |
|---|---|---|
| Stop（不带 cancelQueued） | **转排队**——与「queued 消息在 Stop 后存活」一致 | 先 drain，余量走 §6.3 requeue |
| Stop + cancelQueued | **撤回** | 先 drain → ring 移除 + `withdrawnUuids` + 合成帧 + 客户端 `EVICT_MESSAGES`（机制全复用）+ sidecar 标 withdrawn |

**竞态对策**：先 drain 再调 SDK interrupt——drain 清空 pending 后，interrupt 期间并发的 hook 触发只见空队列（multica `writing` 标志串行化的进程内等价物）。

## 7. Wire 协议

新帧 `message-steered`，挂现有 input-queue-status 通道（与 `message-consumed` / `messages-withdrawn` 同通道）：

```
{ kind: 'message-steered', sessionId, uuid, state: 'injected' | 'requeued' }
```

- `'injecting'` 不需要帧——初始广播消息上的 `steeredAt` 戳就是它
- durable 半边：ring 条目上的 `injectedAt` / `requeuedAt` 戳（重放正确性靠它，同 `consumedAt` 模式）；重连 tab 经 ring 重放即得终态，无需额外 seeding（对照 `withdrawnUuids` 的合成帧——撤回有 seeding 因为 ring 条目被移除了；steer 不移除条目）

## 8. 磁盘回放

### 8.1 Sidecar（`server/steered-store.ts`，镜像 prompt-uuid-store 形态）

每 session 一个文件，条目：

```ts
{ u: string; text: string; steeredAt: number; injectedAt?: number; requeuedAt?: number; withdrawnAt?: number }
```

- **steer 时刻即落盘**（server 崩溃也不丢记录），状态迁移时更新，容量对齐 historyCap
- `text` 必存：splice 合成消息体需要

### 8.2 History 拼接（route 层，jsonl-cache 页面组装之后）

CLI JSONL 不含 steered 消息的用户轮（`additionalContext` 的落盘形态由探针 5 确认；即便有也是 meta 形态不可回放）。`readHistoryPage` 在页面组装后按 `steeredAt` 时间戳把 sidecar 条目 splice 进页面（插在第一条时间戳大于 `steeredAt` 的磁盘条目之前），合成与 `HistoryEntry` 归一化形态一致的用户消息（带 steeredAt/injectedAt 戳）。

**去重规则（关键）**：splice 只包含「有 `steeredAt` 且无 `requeuedAt` / `withdrawnAt`」的条目（即 injected 或 orphan）。requeued 的消息已转正为真实 prompt，**CLI JSONL 拥有它**——splice 再插就是重复气泡；withdrawn 的消息两边都没有，正确。客户端 transcript store 按 uuid 去重（ring 回放与磁盘页边界重叠时的既有行为）。

### 8.3 崩溃遗留（orphan）规则

非终态条目（steeredAt 无终态戳）不做事后 settle；客户端渲染规则：「有 steeredAt、无终态、session 空闲 → 不显示注入 chip」。live session 极少产生 orphan（requeue fallback 兜底），仅 server 崩溃会出现。

## 9. 设置与能力暴露

- `config.json` 新增 `steering: boolean`，默认 `true`；走现有 config-routes 暴露给客户端；SettingsPanel 一个开关，关掉即回纯排队语义
- session 快照新增 `steeringSupported: boolean`（先例：`thinkingSupported`），客户端 badge 判定用

## 10. 客户端 UI

- **Composer badge**（发送前提示，气泡状态永远以广播戳为准——预测与实际不一致时自动纠正）：working ∧ 开关 ∧ `steeringSupported` ∧ 纯文本 → 「⚡ 将注入当前运行」；粘贴图片后 → 「📋 含图片，将排队至下一轮」
- **气泡状态 chip**（对齐现有 queued/sent 形态）：`steeredAt` → 「注入中」；`+injectedAt` → 「已注入当前轮」；`requeuedAt` → 「已转为下一轮」后回到正常 queued→consumed 流转
- **reducer**：`MESSAGE_STEERED` action（injected/requeued 两态）更新 transcript store 对应条目；`deriveDeliveryStatus` 扩展 steered 分支；撤回驱逐复用 `EVICT_MESSAGES`

## 11. Phase 0 探针（一次性脚本，标注 throwaway；每项对应一个设计假设）

| # | 验证内容 | 决定什么 |
|---|---|---|
| 1 | PreToolUse `additionalContext` 到达模型的时机/形态（CLI 2.1.296 实测） | 投递语义成立 |
| 2 | Stop `decision:'block'` 续跑 + `stop_hook_active` 二次触发行为 | 无限循环防线（block 后再 Stop 无 pending → 正常结束） |
| 3 | 合并后的单一 Stop 回调返回 decision 时，任务快照/运行日志逻辑照常 | §5.3 合并设计 |
| 4 | 子代理继承 + `agent_id` 过滤（Agent fan-out 实测） | 侧链不偷消息 |
| 5 | `additionalContext` 的 JSONL 落盘足迹 | §8.2 splice 是否需额外去重 CLI 侧 echo |

探针 1 附带确认 PostToolUseFailure 的 `additionalContext` 支持度；若不支持，从边界集中去掉（Pre/PostToolUse + Stop 仍够用）。

## 12. 错误处理矩阵

| 场景 | 行为 |
|---|---|
| enqueue 被拒（admission closed） | 透明回退排队路径 |
| turn 结束有余量 | requeue fallback（零丢失）+ promptUuids 补录 |
| interrupt（不带 cancelQueued） | pending 视同 turn 结束 → requeue |
| interrupt + cancelQueued | withdraw（ring 移除 + withdrawnUuids + 合成帧 + EVICT） |
| hook 投递与 interrupt 竞态 | 先 drain 再 interrupt；drain 后并发 hook 见空队列 |
| server 崩溃（mid-turn） | sidecar 已持久化 steeredAt；重放按 §8.3 orphan 规则渲染 |
| 多模态 mid-turn | 路由判定直接排队 |
| 自定义老 CLI（< 2.1.110） | `supportsSteering=false`，整体退化排队，UI 无注入态 |
| handle abort/destroy | pending 全部标 aborted，随 session 终结 |

## 13. 测试策略（全部 fake input，不起真 CLI——仓库规矩）

- **状态机单测**（steering.ts）：admission 矩阵（onInputConsumed/Stop-空/Stop-非空 × enqueue 时机）、投递矩阵（边界事件 × pending × agent_id）、包装格式、drain 语义
- **路由矩阵单测**（session-manager）：四条件组合 × enqueue 接受/拒绝
- **fallback 单测**：result 处理器 requeue + promptUuids 补录 + ring 戳迁移
- **withdrawal 单测**：interrupt(cancelQueued) 集成（drain 顺序、withdrawnUuids、sidecar 标记）
- **合并 Stop 回调单测**：pending 非空时返回 decision ∧ 任务快照逻辑照常执行
- **splice 单测**：sidecar 时间戳排序插入 + 去重规则（requeued/withdrawn 跳过）
- **客户端**：deriveDeliveryStatus steered 分支、MESSAGE_STEERED reducer、EVICT 复用、orphan 渲染规则

## 14. 实现阶段（粗粒度，writing-plans 细化）

1. **Phase 0**：五项探针（结果可能微调后续阶段的细节分支）
2. **Phase 1**：provider 机制（steering.ts 状态机 + inprocess-hooks 合并 + handle 成员 + 能力位）
3. **Phase 2**：manager 策略（路由、戳、事件、fallback、撤回、message-steered 帧）
4. **Phase 3**：sidecar + history splice
5. **Phase 4**：客户端（badge、chip、reducer、设置开关）+ config 暴露

## 15. 探针依赖的开放分支

- 探针 5 若发现 `additionalContext` 以可识别形态落盘：§8.2 增加按内容/时间窗去重，splice 仍是权威
- 探针 1 若发现 PostToolUseFailure 不支持 additionalContext：从边界集去掉该事件
- 探针 3 若发现合并回调仍有异常：退化为「steering 独立 matcher + 现有 Stop 移入同数组、串行语义验证」——需重新评估
