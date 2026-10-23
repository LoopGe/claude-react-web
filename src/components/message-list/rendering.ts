import type { SdkMessage, Block } from '../../types'
import type { PlanStatus, ToolResultEntry } from '../../session-store/types'
import type { QuestionAnswerEntry } from '../../utils/question-answers'
import { getBlocks } from '../../session-store/normalize'

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

/** A stable-by-value key that changes exactly when one of THIS message's
 *  `tool_result` blocks flips consumed-state — i.e. exactly when MessageView's
 *  orphan-bubble filter (MessageView.tsx, the `toolBlocks` filter) would
 *  produce different output.
 *
 *  This exists so MessageView's `memo` has a real signal for that change. The
 *  predicate itself is shared over an identity-stable context value (see
 *  MessageList's `resultConsumedCtx`) — a fresh function per source-Map change
 *  would churn the context and re-render every mounted MessageView, defeating
 *  `memo` (measured: 13 MessageView re-renders per tool_result). But once the
 *  context value is stable, a row that STAYS MOUNTED across a predicate flip
 *  would otherwise keep its stale filtered output.
 *
 *  "Stays mounted" is real, not hypothetical: `willRenderEmpty` deliberately
 *  keeps a frame that carries user text alongside its tool_results
 *  (`return !hasOrphanResults && !userContent`), so when the result is merged
 *  into its card the row survives and must drop just that bubble. A string
 *  (not an array/Set) so memo's `Object.is` comparison is precise and
 *  allocation-free on the compare path.
 *
 *  Only `tool_result` blocks are keyed: that is the entire surface the
 *  predicate changes about a row's render output (MessageView's other
 *  predicate reads — the `willRenderEmpty` guards — are decided by the same
 *  orphan count this key encodes). */
export function toolResultConsumedKey(
  msg: SdkMessage,
  isResultConsumed: (id: string) => boolean,
): string {
  // Only user frames can carry tool_result blocks — and only when content is
  // an array. `getBlocks` allocates a 1-element array for string content, and
  // `itemContent` calls this for every visible row on every rebuild, so the
  // common case (prose) must not touch the block path at all. Deliberately
  // unguarded inside the loop, matching the two sibling filters this must
  // stay in lockstep with (MessageView's `toolBlocks` filter and
  // `willRenderEmpty`'s) — a null block is a data bug and should throw there,
  // not be silently keyed as "not consumed" here.
  if (msg.type !== 'user' || typeof msg.message?.content === 'string') return ''
  const blocks = getBlocks(msg)
  let key = ''
  for (const b of blocks) {
    if (b.type !== 'tool_result') continue
    key += typeof b.tool_use_id === 'string' && isResultConsumed(b.tool_use_id) ? '1' : '0'
  }
  return key
}

/** Would MessageView render nothing for this message? Mirrors the merged
 *  tool-result/subagent-heartbeat and empty assistant branches so callers can
 *  drop empty messages before they become Virtuoso rows.
 *
 *  Per-message ONLY. Visibility is a two-level decision and this is just the
 *  first level: the second is `pushRow`'s orphan-`result` guard in
 *  transcript-rows.ts, which needs the row's neighbours (is there a visible
 *  turn for this footer to close?) and therefore cannot live here. Do not
 *  treat a `false` here as "this message will appear" — an orphan result is
 *  the counterexample. */
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
    // Real user message: always rendered.
    return false
  }

  // Assistant: mirror MessageView's hasVisibleContent check.
  const hasVisibleContent =
    Boolean(msg.error) ||
    // A structured /context or /usage twin renders its own card even when the
    // text body is empty — never drop the row on the blocks alone.
    Boolean(msg.context_usage || msg.usage_report) ||
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
  return extractTags(s, tag)[0] ?? null
}

/** Extract the inner text of EVERY `<tag>...</tag>` occurrence in `s`, in
 *  document order, each unescaped exactly like `extractTag`. For injections
 *  that legitimately repeat a tag — a `<task-notification>` may list several
 *  `<task-id>` children ("2 background shell command tasks didn't finish"). */
export function extractTags(s: string, tag: string): string[] {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const out: string[] = []
  let i = s.indexOf(open)
  while (i >= 0) {
    const end = s.indexOf(close, i + open.length)
    if (end < 0) break
    out.push(unescapeXml(s.slice(i + open.length, end)))
    i = s.indexOf(open, end + close.length)
  }
  return out
}
