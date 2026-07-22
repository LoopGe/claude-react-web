// Helpers behind the inline question card.
//
// AskUserQuestion is a special tool: the model thinks it's "asking the user
// directly," but the UI handles the answer flow out-of-band via a
// permission-channel overlay (QuestionDialog). The tool_result fed back to
// the model is the JSON-encoded answers payload built by
// `formatQuestionAnswers` in server/permission-helpers.ts.
//
// This module is the client-side counterpart: pure functions that pull
// the structured answers back out of the tool_result so the inline
// QuestionCard in transcript scrollback can show "asked X, answered Y"
// instead of the raw JSON dump.
//
// Pure / no React imports so it can be unit-tested in isolation.

import type { Block, SdkMessage } from '../types'

/** Canonical tool name — kept here so reducer + card stay in sync
 *  without taking a dependency on the broader toolNames module. */
export const QUESTION_TOOL_NAME = 'AskUserQuestion'

/** Per-question entry in the parsed answers payload:
 *   - string   : single-select answer
 *   - string[] : multi-select answer
 *   - null     : the user skipped this question */
export type QuestionAnswerValue = string | string[] | null

export interface QuestionAnswerEntry {
  question: string
  answer: QuestionAnswerValue
  clarified?: boolean
}

/** Scan an assistant message for AskUserQuestion tool_use ids. */
export function getQuestionToolUseIds(msg: SdkMessage): string[] {
  if (msg.type !== 'assistant') return []
  const ids: string[] = []
  for (const block of blocksOf(msg)) {
    if (block.type !== 'tool_use' || block.name !== QUESTION_TOOL_NAME) continue
    const id =
      typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : typeof block.id === 'string'
          ? block.id
          : undefined
    if (id) ids.push(id)
  }
  return ids
}

/** Parse JSON-encoded answers from any tool_result whose tool_use_id is
 *  known to be an AskUserQuestion call. Returns one entry per matched
 *  tool_result; entries with malformed payloads are silently dropped
 *  (e.g. when the SDK aborted the call and the deny message isn't our
 *  JSON shape — leaving the existing "pending" entry untouched). */
export function extractQuestionAnswers(
  msg: SdkMessage,
  knownIds: ReadonlySet<string>,
): Array<{ toolUseId: string; answers: QuestionAnswerEntry[] }> {
  if (msg.type !== 'user') return []
  const out: Array<{ toolUseId: string; answers: QuestionAnswerEntry[] }> = []
  for (const block of blocksOf(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    if (!knownIds.has(block.tool_use_id)) continue
    const raw = textOfContent(block.content)
    if (!raw) continue
    const parsed = parseAnswersJson(raw)
    if (parsed.length > 0) out.push({ toolUseId: block.tool_use_id, answers: parsed })
  }
  return out
}

/** Parse the JSON-encoded answers payload built by
 *  `server/permission-helpers.ts:formatQuestionAnswers`. Returns the
 *  parsed entries, or an empty array on any malformed input — same
 *  contract as the internal parseAnswersJson helper, exposed so the
 *  PERMISSION_RESOLVED reducer can decode the resolution `message`
 *  field directly (see reducer comment for why we can't only rely on
 *  the tool_result echo path). */
export function parseQuestionAnswersMessage(raw: string): QuestionAnswerEntry[] {
  return parseAnswersJson(raw)
}

function parseAnswersJson(raw: string): QuestionAnswerEntry[] {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return []
  }
  if (!obj || typeof obj !== 'object') return []
  const answers = (obj as { answers?: unknown }).answers
  if (!Array.isArray(answers)) return []
  const out: QuestionAnswerEntry[] = []
  for (const item of answers) {
    if (!item || typeof item !== 'object') continue
    const e = item as { question?: unknown; answer?: unknown }
    if (typeof e.question !== 'string') continue
    const answer = e.answer
    if (
      answer === null ||
      typeof answer === 'string' ||
      (Array.isArray(answer) && answer.every((a) => typeof a === 'string'))
    ) {
      out.push({ question: e.question, answer: answer as QuestionAnswerValue })
    }
  }
  return out
}

function blocksOf(m: SdkMessage): Block[] {
  const content = m.message?.content
  if (Array.isArray(content)) return content as Block[]
  return []
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}
