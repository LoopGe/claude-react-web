// Mid-run steering 状态机（spec §5）。multica claudeSupplementSession 的进程内移植：
// 去掉阻塞语义（hook 回调即投递点），admission 以 onInputConsumed 开、Stop-空 关。
//
// 归属（B' 切分）：本文件是 provider 机制——CLI 特有细节（agent_id 过滤、
// stop_hook_active、hook 输出形状）全部封在这里；manager 只认识
// enqueue/drain/delivered 三个动词（spec §4 接口契约）。
export type SteerBoundary = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop'
export type SupplementOutcome = { ok: true; boundary: SteerBoundary } | { ok: false; reason: 'aborted' }
export interface SteerEntryInput {
  uuid: string
  text: string
}

/** 注入指令包装（spec §5.4，multica 提示词工程移植）。四条规则防住三个模型
 *  行为陷阱：把补充当新任务、中断工作先回一句「收到」、擅自放弃原目标。 */
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

type PendingEntry = SteerEntryInput

export class SupplementSession {
  private admissionOpen = false
  private pending: PendingEntry[] = []

  constructor(private readonly onDelivered: (uuid: string, outcome: SupplementOutcome) => void) {}

  /** SDK 从输入队列读走一条 prompt（Pushable onConsume）= 新 turn 开始，
   *  admission 打开。初始 closed——spawn 后、首条 prompt 读取前的 enqueue
   *  被拒（等价 multica 的 "turn has not started"）。 */
  notePromptConsumed(): void {
    this.admissionOpen = true
  }

  /** 入队一条待注入消息。admission 关闭（turn 正在结束/尚未开始）时返回
   *  false，调用方（manager 路由）透明回退到普通排队路径。 */
  enqueue(entry: SteerEntryInput): boolean {
    if (!this.admissionOpen) return false
    this.pending.push(entry)
    return true
  }

  /** 主线程 hook 边界触发。返回 SDK hook 输出对象（空对象 = 无操作）。
   *  - `input.agent_id` 非空 = 子代理继承的 hook（Agent/Task/forked-Skill
   *    侧链）——绝不能消费主线程 steering（multica claudeSupplement.go:183
   *    的教训；探针 4 已实测确认继承行为）。
   *  - Stop 且无 pending：关闭 admission 并返回 {}（turn 正在结束）。
   *  - 有 pending：全部 drain、合并为一次注入、逐条回调 onDelivered。
   *    Stop 用 decision:block 续跑消化（探针 2 验证），其余边界用
   *    additionalContext（探针 1 验证）。 */
  handleBoundary(event: SteerBoundary, input: { agent_id?: string }): Record<string, unknown> {
    if (input.agent_id) return {}
    const delivering = this.pending
    this.pending = []
    if (event === 'Stop' && delivering.length === 0) {
      this.admissionOpen = false
      return {}
    }
    if (delivering.length === 0) return {}
    const wrapped = formatSupplementInstruction(delivering.map((e) => e.text).join('\n\n'))
    const outcome: SupplementOutcome = { ok: true, boundary: event }
    for (const e of delivering) this.onDelivered(e.uuid, outcome)
    if (event === 'Stop') {
      return { decision: 'block', reason: wrapped }
    }
    return { hookSpecificOutput: { hookEventName: event, additionalContext: wrapped } }
  }

  /** 取走全部未投递条目（turn-end fallback / interrupt 撤回用），
   *  对称于 ProviderSessionHandle.drainQueuedInput。 */
  drainUndelivered(): Array<{ uuid: string }> {
    const out = this.pending.map((e) => ({ uuid: e.uuid }))
    this.pending = []
    return out
  }

  /** handle 销毁：未投递条目全部回调 aborted 并清空。 */
  abort(): void {
    const leftovers = this.pending
    this.pending = []
    this.admissionOpen = false
    for (const e of leftovers) this.onDelivered(e.uuid, { ok: false, reason: 'aborted' })
  }
}
