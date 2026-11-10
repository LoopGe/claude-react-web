// Provider-neutral mid-run steering vocabulary. The wrapper and the delivery
// outcome types are shared by the claude hook path (server/providers/claude/
// steering.ts re-exports them) and the native provider's per-round injection,
// so both providers put the same text in front of the model and report
// delivery the same way.
export type SteerBoundary = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop'
export type SupplementOutcome = { ok: true; boundary: SteerBoundary } | { ok: false; reason: 'aborted' }

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