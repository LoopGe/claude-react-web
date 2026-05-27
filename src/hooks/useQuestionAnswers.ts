// Context + hook for AskUserQuestion answers lookup.
//
// Mirrors the pattern of usePlanStatus.ts — MessageList accepts a
// Map<tool_use_id, QuestionAnswerEntry[]> from the session store and
// provides it through this context so deeply nested ToolUseBlocks
// (rendered inside per-message memoised MessageView trees) can read
// their own answers without prop-drilling.
//
// The provider is a renderless React component constructed via
// createElement to keep this file in the hooks/ directory (the
// project's eslint react-refresh rule treats files in hooks/ as
// non-component).

import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { QuestionAnswerEntry } from '../utils/question-answers'

type AnswersMap = ReadonlyMap<string, QuestionAnswerEntry[]>

const Ctx = createContext<AnswersMap>(new Map())

export function QuestionAnswersProvider({
  value,
  children,
}: {
  value: AnswersMap
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

/** Returns the parsed answers list for a given AskUserQuestion tool_use_id.
 *
 *  Distinguishing the three states from the return value:
 *   - `undefined`        → not an AskUserQuestion call (or id missing)
 *   - `[]`               → tool_use seen, answer hasn't landed yet (pending)
 *   - non-empty array    → user answered; check each entry's `answer` for
 *                          null (skipped) vs string/string[] (selected). */
export function useQuestionAnswers(toolUseId: string | undefined): QuestionAnswerEntry[] | undefined {
  const map = useContext(Ctx)
  if (!toolUseId) return undefined
  return map.get(toolUseId)
}
