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

/** Reverse server/exec.ts `escapeXml`. The `!` bash-mode synthetic message
 *  XML-escapes the command + stdout + stderr before embedding them in
 *  `<bash-input>` / `<bash-stdout>` / `<bash-stderr>` tags (so a stdout body
 *  containing `</bash-stdout>` can't break the tag slicing). `extractTag`
 *  pulls the escaped text back out verbatim; without un-escaping here, a `>`
 *  in command output would render as the literal `&gt;` (React sets it via
 *  textContent, which does NOT re-parse entities).
 *
 *  This MUST mirror `escapeXml` exactly — it only ever produces `&amp;`,
 *  `&lt;`, `&gt;`, so we only decode those three. Decoding other entities
 *  (`&quot;`, `&apos;`, …) would corrupt output that legitimately contains
 *  those literal strings. Order matters: `&amp;` is decoded LAST so
 *  `&amp;lt;` round-trips to `&lt;` (literal), not to `<` — mirroring how
 *  `escapeXml` encodes `&` first. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Extract the inner text of the first `<tag>...</tag>` in `s`, or null.
 *  Used to parse the <bash-*> tags the server injects for `!` mode. The
 *  returned text is run through `unescapeXml` so it matches what the
 *  server originally captured (see `escapeXml` in server/exec.ts). */
export function extractTag(s: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = s.indexOf(open)
  if (start < 0) return null
  const end = s.indexOf(close, start + open.length)
  if (end < 0) return null
  return unescapeXml(s.slice(start + open.length, end))
}
