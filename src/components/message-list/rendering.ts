import type { SdkMessage, Block } from '../../types'
import type { PlanStatus, ToolResultEntry } from '../../session-store/types'
import type { QuestionAnswerEntry } from '../../utils/question-answers'
import { getBlocks, isTaskNotificationUserMessage, parseTaskNotification } from '../../session-store/normalize'

export function extractUserText(msg: SdkMessage): string | null {
  const content = msg.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = (content as Block[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
    return text || null
  }
  return null
}

/** Predicate: has this tool_use_id's result already been consumed by a card
 *  or a stateless marker, so its standalone orphan bubble must be suppressed?
 *  Sources include generic tool cards, plan/question cards, EnterPlanMode
 *  markers, completed subagent cards, and completed workflow cards. */
export function makeResultConsumed(
  toolResults: ReadonlyMap<string, ToolResultEntry>,
  planStatus: ReadonlyMap<string, PlanStatus>,
  questionAnswers: ReadonlyMap<string, QuestionAnswerEntry[]>,
  enterPlanIds: ReadonlySet<string>,
  subagentResultIds: ReadonlySet<string>,
  workflowResultIds: ReadonlySet<string>,
): (id: string) => boolean {
  return (id) =>
    toolResults.has(id) ||
    planStatus.has(id) ||
    questionAnswers.has(id) ||
    enterPlanIds.has(id) ||
    subagentResultIds.has(id) ||
    workflowResultIds.has(id)
}

/** Would MessageView render nothing for this message? Mirrors the merged
 *  tool-result/subagent-heartbeat and empty assistant branches so callers can
 *  drop empty messages before they become Virtuoso rows. */
export function willRenderEmpty(
  msg: SdkMessage,
  isCompactSummary: boolean | undefined,
  isResultConsumed: (id: string) => boolean,
): boolean {
  const type = msg.type
  // Only user / assistant frames ever render empty; everything else always
  // paints something. Skip block parsing.
  if (type !== 'user' && type !== 'assistant') return false

  const blocks = getBlocks(msg)

  if (type === 'user') {
    // Compact summary always renders a CompactSummary card.
    if (isCompactSummary) return false
    const userContent = extractUserText(msg)
    const allToolBlocks = blocks.filter((b) => b.type === 'tool_result')
    const toolBlocks = allToolBlocks.filter(
      (b) => typeof b.tool_use_id !== 'string' || !isResultConsumed(b.tool_use_id),
    )
    const isSubagent = msg.parent_tool_use_id != null
    const isToolResult = allToolBlocks.length > 0
    const hasOrphanResults = toolBlocks.length > 0
    if (isToolResult || isSubagent) {
      // Mirror of MessageView's user-branch null check: empty iff there is
      // neither an orphan result to draw nor any stray user text.
      return !hasOrphanResults && !userContent
    }
    // A <task-notification> whose result merged into a SubagentCard is
    // suppressed in MessageView's user branch — drop it here too so it
    // doesn't leave a blank Virtuoso row. An unmatched notification (no
    // merged record to dedup against) still renders its standalone card.
    if (isTaskNotificationUserMessage(msg)) {
      const parsed = parseTaskNotification(msg)
      return !!(parsed && isResultConsumed(parsed.toolUseId))
    }
    // Real user message: always rendered.
    return false
  }

  // Assistant: mirror MessageView's hasVisibleContent check.
  const hasVisibleContent =
    Boolean(msg.error) ||
    blocks.some((b) => {
      if (b.type === 'tool_use' || b.type === 'image') return true
      if (b.type === 'text') return typeof b.text === 'string' && b.text.trim().length > 0
      if (b.type === 'thinking') return typeof b.thinking === 'string' && b.thinking.trim().length > 0
      return true
    })
  return !hasVisibleContent
}
