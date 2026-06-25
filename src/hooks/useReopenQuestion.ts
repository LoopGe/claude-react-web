// Context + hook for re-opening a minimized AskUserQuestion / plan / tool-permission dialog.
//
// Mirrors the pattern of useQuestionAnswers.ts — Chat owns the set of
// minimized tool_use_ids plus an `onReopen*` callback for each kind, and
// provides them through this context so the deeply nested inline cards
// (rendered inside per-message memoised MessageView trees) can read whether
// they're currently minimized and ask Chat to re-open them — without
// prop-drilling through MessageList.
//
// The provider is a renderless React component constructed via createElement
// to keep this file in the hooks/ directory (the project's eslint
// react-refresh rule treats files in hooks/ as non-component).

import { createContext, createElement, useContext, type ReactNode } from 'react'

export interface ReopenQuestionValue {
  /** tool_use_ids of pending questions whose dialog the user has minimized. */
  minimizedToolUseIds: ReadonlySet<string>
  /** tool_use_ids of pending plan requests whose dialog the user has minimized. */
  minimizedPlanToolUseIds: ReadonlySet<string>
  /** tool_use_ids of pending regular tool-permission requests whose dialog the user has minimized. */
  minimizedPermissionToolUseIds: ReadonlySet<string>
  /** Re-open the dialog for a minimized question, keyed by its tool_use_id. */
  onReopen: (toolUseId: string) => void
  /** Re-open the dialog for a minimized plan, keyed by its tool_use_id. */
  onReopenPlan: (toolUseId: string) => void
  /** Re-open the dialog for a minimized regular tool permission, keyed by its tool_use_id. */
  onReopenPermission: (toolUseId: string) => void
}

const Ctx = createContext<ReopenQuestionValue>({
  minimizedToolUseIds: new Set(),
  minimizedPlanToolUseIds: new Set(),
  minimizedPermissionToolUseIds: new Set(),
  onReopen: () => {},
  onReopenPlan: () => {},
  onReopenPermission: () => {},
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

/** Read the minimized state and the re-open callbacks. */
export function useReopenQuestion(): ReopenQuestionValue {
  return useContext(Ctx)
}
