// Context + hook for re-opening a minimized AskUserQuestion dialog.
//
// Mirrors the pattern of useQuestionAnswers.ts — Chat owns the set of
// minimized question tool_use_ids plus an `onReopen` callback, and provides
// them through this context so the deeply nested inline QuestionCard
// (rendered inside per-message memoised MessageView trees) can read whether
// it's currently minimized and ask Chat to re-open it — without prop-drilling
// through MessageList.
//
// The provider is a renderless React component constructed via createElement
// to keep this file in the hooks/ directory (the project's eslint
// react-refresh rule treats files in hooks/ as non-component).

import { createContext, createElement, useContext, type ReactNode } from 'react'

export interface ReopenQuestionValue {
  /** tool_use_ids of pending questions whose dialog the user has minimized. */
  minimizedToolUseIds: ReadonlySet<string>
  /** Re-open the dialog for a minimized question, keyed by its tool_use_id. */
  onReopen: (toolUseId: string) => void
}

const Ctx = createContext<ReopenQuestionValue>({
  minimizedToolUseIds: new Set(),
  onReopen: () => {},
})

export function ReopenQuestionProvider({
  value,
  children,
}: {
  value: ReopenQuestionValue
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

/** Read the minimized-question state and the re-open callback. */
export function useReopenQuestion(): ReopenQuestionValue {
  return useContext(Ctx)
}
