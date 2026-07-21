// Utility functions for permission request handling.
// Extracted from session-manager.ts for modularity and testability.

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type {
  PendingPermission,
  PermissionRequestSnapshot,
  QuestionAnswer,
  QuestionSpec,
} from './session-types.js'

/** Strip the non-serializable fields (resolve/signal) before JSON. */
export function toSnapshot(p: PendingPermission): PermissionRequestSnapshot {
  if (p.kind === 'question') {
    return {
      kind: 'question',
      id: p.id,
      toolName: p.toolName,
      questions: p.questions,
      toolUseID: p.toolUseID,
      createdAt: p.createdAt,
    }
  }
  return {
    kind: 'permission',
    id: p.id,
    toolName: p.toolName,
    input: p.input,
    title: p.title,
    displayName: p.displayName,
    description: p.description,
    suggestions: p.suggestions,
    toolUseID: p.toolUseID,
    createdAt: p.createdAt,
  }
}

/** Defensive parse of AskUserQuestion's `input.questions` array. Drops
 *  malformed entries rather than throwing — we'd rather forward a
 *  slimmed-down list than abort the tool call. */
export function sanitizeQuestions(input: Record<string, unknown>): QuestionSpec[] {
  const raw = input?.questions
  if (!Array.isArray(raw)) return []
  const out: QuestionSpec[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const obj = q as Record<string, unknown>
    if (typeof obj.question !== 'string') continue
    if (!Array.isArray(obj.options)) continue
    const options: QuestionSpec['options'] = []
    for (const opt of obj.options) {
      if (!opt || typeof opt !== 'object') continue
      const o = opt as Record<string, unknown>
      if (typeof o.label !== 'string') continue
      options.push({
        label: o.label,
        description: typeof o.description === 'string' ? o.description : undefined,
        preview: typeof o.preview === 'string' ? o.preview : undefined,
      })
    }
    if (options.length === 0) continue
    out.push({
      question: obj.question,
      header: typeof obj.header === 'string' ? obj.header : undefined,
      multiSelect: obj.multiSelect === true,
      options,
    })
  }
  return out
}

/** Build the tool_result payload the model will see. We use JSON because
 *  it's unambiguous and the model parses it reliably; plain text also
 *  works but is ambiguous when answers contain commas or colons.
 *
 *  Null entries in `answers` mean the user skipped that question — we
 *  encode that as `answer: null` with a note, so the model can decide
 *  how to proceed (often: continue with a default).
 */
export function formatQuestionAnswers(questions: QuestionSpec[], answers: QuestionAnswer[]): string {
  const payload = {
    note: 'User answers from AskUserQuestion (single-select is a string, multi-select is an array, null means skipped).',
    answers: questions.map((q, i) => ({
      question: q.question,
      answer: answers[i] ?? null,
    })),
  }
  return JSON.stringify(payload)
}

/** Build the tool_result payload for the "Chat about this" path: instead of
 *  answering the questions, the user typed a free-form clarification. Like
 *  `formatQuestionAnswers`, this string lands in the model's tool_result via
 *  the canUseTool deny+message channel, so the model reads it and keeps
 *  working in the same turn (interrupt: false) — typically reformulating
 *  the questions or answering the user's clarification.
 *
 *  The original questions are echoed back so the model has the exact text it
 *  asked alongside the user's redirect. */
export function formatQuestionClarification(questions: QuestionSpec[], feedback: string): string {
  const questionList = questions.length
    ? questions.map((q) => `- "${q.question}"`).join('\n')
    : '(no questions)'
  return [
    'The user chose to clarify rather than answer the AskUserQuestion directly.',
    'They may have additional context, a question of their own, or a redirect for you.',
    'Take their message into account and reformulate your questions if appropriate.',
    '',
    'The user said:',
    feedback.trim(),
    '',
    'Original questions asked:',
    questionList,
  ].join('\n')
}

/**
 * Rewrite SDK-provided suggestions to target the current session scope.
 *
 * The SDK hands us `suggestions: PermissionUpdate[]` with whatever destination
 * it picked (often 'userSettings' or 'projectSettings'). For session-scope
 * allow-always, we force every addRules/setMode/addDirectories update to
 * `destination: 'session'`, so the change only lives as long as this Query.
 */
export function promoteToSession(
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] | undefined {
  if (!suggestions?.length) return undefined
  return suggestions.map((s) => ({ ...s, destination: 'session' as const }))
}
